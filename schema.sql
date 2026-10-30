-- Delivery Desk: database setup for Supabase
-- Run once in Supabase > SQL Editor > New query > paste all > Run.

-- 1. People who have signed in ------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text,
  avatar_url text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- New sign-ups get a profile; the very first person becomes the admin.
create or replace function public.dd_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, is_admin)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', ''),
          not exists (select 1 from public.profiles where is_admin));
  return new;
end $$;
drop trigger if exists dd_on_auth_user on auth.users;
create trigger dd_on_auth_user after insert on auth.users
  for each row execute function public.dd_new_user();

-- Stop people making themselves admin.
create or replace function public.dd_guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.is_admin is distinct from old.is_admin
     and not exists (select 1 from public.profiles where id = auth.uid() and is_admin) then
    raise exception 'Only the admin can change admin rights' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists dd_profile_guard on public.profiles;
create trigger dd_profile_guard before update on public.profiles
  for each row execute function public.dd_guard_profile();

drop policy if exists "profiles readable by signed-in users" on public.profiles;
create policy "profiles readable by signed-in users" on public.profiles
  for select to authenticated using (true);
drop policy if exists "people edit their own profile" on public.profiles;
create policy "people edit their own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- 2. All app data, stored as documents ----------------------------------------
-- path examples: roles/<uid>, access/<uid>, spaces/<id>, spaces/<id>/tasks/T-001
create table if not exists public.docs (
  path text primary key,
  coll text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
create index if not exists docs_coll_idx on public.docs (coll);
create index if not exists docs_created_idx on public.docs (coll, (data->>'createdAt'));
create index if not exists docs_ts_idx on public.docs (coll, (data->>'ts'));
alter table public.docs enable row level security;
alter table public.docs replica identity full;

-- Role helpers (security definer so policies can read docs without recursion)
create or replace function public.dd_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and is_admin)
$$;
create or replace function public.dd_app_role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from profiles where id = auth.uid() and is_admin) then 'admin'
    else coalesce((select data->>'role' from docs where path = 'roles/' || auth.uid()::text), 'member')
  end
$$;
create or replace function public.dd_space_role(sid text) returns text
language sql stable security definer set search_path = public as $$
  select case
    when public.dd_is_admin() then 'admin'
    when exists (select 1 from docs where path = 'spaces/' || sid
                 and coalesce(data->'pms', '[]'::jsonb) ? auth.uid()::text) then 'pm'
    when exists (select 1 from docs d, jsonb_array_elements(coalesce(d.data->'members', '[]'::jsonb)) m
                 where d.path = 'spaces/' || sid and m->>'uid' = auth.uid()::text) then 'member'
    when public.dd_app_role() = 'business' then 'business'
    else null
  end
$$;
-- which kind of document a path is
create or replace function public.dd_kind(p text) returns text
language sql immutable as $$
  select case
    when p like 'roles/%' and array_length(string_to_array(p, '/'), 1) = 2 then 'role'
    when p like 'access/%' and array_length(string_to_array(p, '/'), 1) = 2 then 'access'
    when p like 'spaces/%' and array_length(string_to_array(p, '/'), 1) = 2 then 'space'
    when p like 'spaces/%' and array_length(string_to_array(p, '/'), 1) = 4 then split_part(p, '/', 3)
    else 'other'
  end
$$;
create or replace function public.dd_sid(p text) returns text
language sql immutable as $$ select split_part(p, '/', 2) $$;
create or replace function public.dd_last(p text) returns text
language sql immutable as $$ select (string_to_array(p, '/'))[array_length(string_to_array(p, '/'), 1)] $$;

-- READ
drop policy if exists "dd read" on public.docs;
create policy "dd read" on public.docs for select to authenticated using (
  case dd_kind(path)
    when 'role' then true
    when 'access' then true
    when 'space' then true
    when 'requests' then dd_last(path) = auth.uid()::text or dd_space_role(dd_sid(path)) in ('admin','pm')
    when 'tasks' then dd_space_role(dd_sid(path)) is not null
    when 'updates' then dd_space_role(dd_sid(path)) is not null
    when 'events' then dd_space_role(dd_sid(path)) is not null
    when 'comments' then dd_space_role(dd_sid(path)) is not null
    else dd_is_admin()
  end
);
-- CREATE
drop policy if exists "dd insert" on public.docs;
create policy "dd insert" on public.docs for insert to authenticated with check (
  case dd_kind(path)
    when 'role' then dd_is_admin()
    when 'access' then dd_last(path) = auth.uid()::text or dd_is_admin()
    when 'space' then dd_app_role() in ('admin','pm')
    when 'requests' then dd_last(path) = auth.uid()::text
    when 'tasks' then dd_space_role(dd_sid(path)) in ('admin','pm')
    when 'updates' then dd_space_role(dd_sid(path)) in ('admin','pm','member')
    when 'events' then dd_space_role(dd_sid(path)) in ('admin','pm','member')
    when 'comments' then dd_space_role(dd_sid(path)) in ('admin','pm','member') and data->>'by' = auth.uid()::text
    else false
  end
);
-- CHANGE (developer/QA limits on tasks are enforced by the trigger below)
drop policy if exists "dd update" on public.docs;
create policy "dd update" on public.docs for update to authenticated using (
  case dd_kind(path)
    when 'role' then dd_is_admin()
    when 'access' then dd_last(path) = auth.uid()::text or dd_is_admin()
    when 'space' then dd_space_role(dd_sid(path)) in ('admin','pm')
    when 'requests' then dd_last(path) = auth.uid()::text
    when 'tasks' then dd_space_role(dd_sid(path)) in ('admin','pm','member')
    else dd_is_admin()
  end
);
-- DELETE (history records can only be removed by the admin)
drop policy if exists "dd delete" on public.docs;
create policy "dd delete" on public.docs for delete to authenticated using (
  case dd_kind(path)
    when 'role' then dd_is_admin()
    when 'access' then dd_last(path) = auth.uid()::text or dd_is_admin()
    when 'space' then dd_is_admin()
    when 'requests' then dd_last(path) = auth.uid()::text or dd_space_role(dd_sid(path)) in ('admin','pm')
    when 'tasks' then dd_space_role(dd_sid(path)) in ('admin','pm')
    else dd_is_admin()
  end
);

-- Developers and QA may change only the working fields of tasks they're on.
create or replace function public.dd_guard_task() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r text; k text; me text := auth.uid()::text;
  allowed text[] := array['status','blocker','blockerOwner','blockerDetails','remaining','pct','pr',
    'latestUpdate','todayPlan','lastUpdated','currentEta','pmSupport','startDate','actualDate',
    'qaConfirmed','updatedBy'];
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if dd_kind(new.path) <> 'tasks' or auth.uid() is null then return new; end if;
  r := dd_space_role(dd_sid(new.path));
  if r in ('admin','pm') then return new; end if;
  if not (coalesce(old.data->'owners','[]'::jsonb) ? me or coalesce(old.data->'reviewers','[]'::jsonb) ? me) then
    raise exception 'You can only change tasks assigned to you' using errcode = '42501';
  end if;
  for k in select key from jsonb_each(new.data) union select key from jsonb_each(old.data) loop
    if (new.data->k) is distinct from (old.data->k) and not (k = any(allowed)) then
      raise exception 'Only the PM can change %', k using errcode = '42501';
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists dd_task_guard on public.docs;
create trigger dd_task_guard before update on public.docs
  for each row execute function public.dd_guard_task();

-- Shallow merge for partial updates (runs with the caller's permissions)
create or replace function public.dd_merge(p_path text, p_patch jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update docs set data = data || p_patch where path = p_path;
  if not found then
    raise exception 'Document not found or not allowed' using errcode = 'P0002';
  end if;
end $$;

-- Live updates
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.docs;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- 3. PRD file storage ----------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('prd', 'prd', false)
on conflict (id) do nothing;
drop policy if exists "dd prd read" on storage.objects;
create policy "dd prd read" on storage.objects for select to authenticated using (bucket_id = 'prd');
drop policy if exists "dd prd upload" on storage.objects;
create policy "dd prd upload" on storage.objects for insert to authenticated with check (bucket_id = 'prd');
drop policy if exists "dd prd delete" on storage.objects;
create policy "dd prd delete" on storage.objects for delete to authenticated using (bucket_id = 'prd' and owner = auth.uid());
