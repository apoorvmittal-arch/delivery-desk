# Delivery Desk: hosted version (Vercel + Supabase)

Same app as on claude.ai, with its own sign-in, database and file storage.
Total setup time: about 45 minutes. No coding needed.

## What's in this folder

| File | What it is |
|---|---|
| `index.html` | The app |
| `dd-cloud.js` | Connects the app to Supabase (database, sign-in, files) |
| `api/config.js` | Gives the page your public Supabase settings |
| `api/ai.js` | AI drafting of scope and acceptance criteria (keeps your Anthropic key secret) |
| `schema.sql` | Creates the database tables and the access rules |

---

## Step 1. Supabase (database, sign-in, files)

1. Go to supabase.com, sign in, and click **New project**.
   - Name: `delivery-desk`
   - Region: **Mumbai** (closest to your team)
   - Database password: create a strong one and save it in your password manager.
2. Wait until the project finishes setting up (1–2 minutes).
3. Open **SQL Editor**, click **New query**, paste the whole of `schema.sql`, and click **Run**.
   You should see "Success. No rows returned". It's safe to run again later.
4. Turn off email confirmation, so people can sign up without an email being sent:
   **Authentication → Sign In / Providers → Email** → switch off **Confirm email** → Save.
   (Supabase's built-in email only reaches your Supabase team members and sends very few
   messages per hour, so leave this off unless you set up your own email sender; see "Optional" below.)
5. Copy two values from **Project Settings → API** (or **API Keys**):
   - **Project URL** (looks like `https://abcdxyz.supabase.co`)
   - **anon / public key** (the long key marked public or publishable)
   Do **not** copy the `service_role` / secret key anywhere.

## Step 2. GitHub (stores the code)

1. Go to github.com and create a **New repository** called `delivery-desk` (Private is fine).
2. Click **uploading an existing file**, drag in everything from this folder
   (keep the `api` folder as a folder), and click **Commit changes**.

## Step 3. Vercel (hosts the app)

1. Go to vercel.com, sign in with GitHub, click **Add New → Project**, and import `delivery-desk`.
2. Framework preset: **Other**. Leave build settings empty.
3. Open **Environment Variables** and add:

| Name | Value | Needed? |
|---|---|---|
| `SUPABASE_URL` | Project URL from Step 1 | Yes |
| `SUPABASE_ANON_KEY` | anon / public key from Step 1 | Yes |
| `ANTHROPIC_API_KEY` | Your key from console.anthropic.com | Only for AI drafting |
| `ANTHROPIC_MODEL` | e.g. `claude-sonnet-5-5` | Optional; that's the default |
| `EMAIL_LINKS` | `on` | Only if you set up your own email sender |

4. Click **Deploy**. You get a link like `https://delivery-desk.vercel.app`.
   If you change a variable later, use **Deployments → Redeploy** for it to take effect.

## Step 4. Tell Supabase your app's address

**Authentication → URL Configuration**:
- **Site URL**: your Vercel link, e.g. `https://delivery-desk.vercel.app`
- **Redirect URLs**: add the same link.

## Step 5. Sign up first (this makes you the admin)

Open your Vercel link and click **Create an account**. **The very first account becomes the admin**,
so do this before you share the link with anyone.

## Step 6. Bring in your team

1. Share the link. Everyone clicks **Create an account** with their work email.
2. As admin, open **People & roles**: make PMs (e.g. Prasad) and business viewers.
3. PMs create their spaces and add developers and QA in **Space settings**.
   People who haven't signed up yet can still be added by name and linked to their account later.
4. Your claude.ai version had no tasks yet, so recreate the two spaces (D2C and B2B) here.

---

## Day-to-day admin

- **Forgotten password.** Without your own email sender, Supabase can't send reset emails.
  In Supabase → **Authentication → Users**, find the person, open the menu, and set a new password
  for them (or set up an email sender, below).
- **Add another admin.** In SQL Editor run:
  `update public.profiles set is_admin = true where email = 'name@pluckk.in';`
- **Backups.** Export CSVs from Reports, Tasks and Update history. Supabase also keeps daily backups on paid plans.

## Optional

**Only allow company emails to sign up.** Run in SQL Editor (change the domain):

```sql
create or replace function public.dd_domain_check() returns trigger
language plpgsql security definer as $$
begin
  if new.email not ilike '%@pluckk.in' then
    raise exception 'Use your company email';
  end if;
  return new;
end $$;
drop trigger if exists dd_domain on auth.users;
create trigger dd_domain before insert on auth.users
  for each row execute function public.dd_domain_check();
```

**Email sign-in links, confirmations and password resets.** Create a free account with an email
sending service that offers SMTP (for example Brevo or Resend), then in Supabase go to
**Authentication → Emails → SMTP Settings**, turn on **custom SMTP** and enter its details.
Then set `EMAIL_LINKS` to `on` in Vercel and redeploy.

## Troubleshooting

| You see | Fix |
|---|---|
| "Setup incomplete: add SUPABASE_URL…" | Variables missing in Vercel, or you didn't redeploy after adding them |
| "Your account exists but has no profile" | `schema.sql` wasn't run (or failed). Run it, then sign out and in |
| "This change was refused" | That person's role doesn't allow it. Check People & roles or Space settings |
| AI fill says it isn't available | `ANTHROPIC_API_KEY` missing, or no credit on the Anthropic account |
| Changes from others take a few seconds | Normal. Live updates arrive within seconds; the page also refreshes every minute |
