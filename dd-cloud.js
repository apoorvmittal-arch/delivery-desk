/* Delivery Desk cloud adapter.
   Provides the same window.claude.use(...) services the app used on claude.ai,
   backed by Supabase (database, login, file storage) and /api/ai (AI drafting). */
(function(){
"use strict";
const $=s=>document.querySelector(s);
const esc=v=>String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let sb=null,cfg=null,uid=null,profile=null;
let readyResolve;const ready=new Promise(r=>{readyResolve=r;});

/* ---------- errors ---------- */
function mapErr(e){
  const x=new Error((e&&e.message)||"Request failed");
  const c=e&&e.code,m=(e&&e.message)||"";
  x.code=(c==="42501"||c==="P0002"||/row-level security|not allowed|Only the|only change/i.test(m))?"invalid_argument":(c==="PGRST301"||/JWT/i.test(m))?"session_expired":"unavailable";
  if(/Only the|only change/i.test(m))x.message=m;
  return x;
}
const rid=(n=20)=>{const a="abcdefghijklmnopqrstuvwxyz0123456789";let s="";const b=crypto.getRandomValues(new Uint8Array(n));for(const v of b)s+=a[v%a.length];return s;};
const hex32=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,"0")).join("");
const collOf=p=>p.slice(0,p.lastIndexOf("/"));
const isUuid=s=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s||"");

/* ---------- live updates ---------- */
const listeners=new Set();
function schedule(L){clearTimeout(L.t);L.t=setTimeout(L.run,150);}
function touch(path){for(const L of listeners){if(L.kind==="doc"?L.path===path:collOf(path)===L.coll)schedule(L);}}
let channel=null;
function ensureChannel(){
  if(channel)return;
  channel=sb.channel("dd-docs").on("postgres_changes",{event:"*",schema:"public",table:"docs"},p=>{
    const path=(p.new&&p.new.path)||(p.old&&p.old.path);if(path)touch(path);
  }).subscribe();
  setInterval(()=>{for(const L of listeners)schedule(L);},60000); // safety net if the live connection drops
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)for(const L of listeners)schedule(L);});
}
function listen(L,unsub){listeners.add(L);ensureChannel();L.run();return ()=>{clearTimeout(L.t);listeners.delete(L);};}

/* ---------- db ---------- */
function snapDoc(path,row){return {exists:!!row,id:path.split("/").pop(),data:()=>row?row.data:undefined};}
function docRef(path){
  const ref={id:path.split("/").pop(),path,
    async get(){const {data,error}=await sb.from("docs").select("path,data").eq("path",path).maybeSingle();if(error)throw mapErr(error);return snapDoc(path,data);},
    async set(d){const {error}=await sb.from("docs").upsert({path,coll:collOf(path),data:d},{onConflict:"path"});if(error)throw mapErr(error);touch(path);},
    async update(d){const {error}=await sb.rpc("dd_merge",{p_path:path,p_patch:d});if(error)throw mapErr(error);touch(path);},
    async delete(){const {data,error}=await sb.from("docs").delete().eq("path",path).select("path");if(error)throw mapErr(error);if(!data||!data.length){const e=new Error("Not allowed");e.code="invalid_argument";throw e;}touch(path);},
    onSnapshot(cb,eb){return listen({kind:"doc",path,run:async()=>{try{cb(await ref.get());}catch(e){eb&&eb(e);}}});}
  };
  return ref;
}
const OPS={"<":"lt","<=":"lte",">":"gt",">=":"gte","==":"eq","!=":"neq"};
function query(coll,q){
  const api={
    where(f,op,v){return query(coll,{...q,where:[...(q.where||[]),[f,op,v]]});},
    orderBy(f,dir){return query(coll,{...q,ord:[f,dir||"asc"]});},
    limit(n){return query(coll,{...q,lim:n});},
    doc(id){return docRef(coll+"/"+(id||rid()));},
    async add(d){const r=docRef(coll+"/"+rid());await r.set(d);return r;},
    async get(){
      let r=sb.from("docs").select("path,data").eq("coll",coll);
      for(const [f,op,v] of (q.where||[]))r=r.filter("data->>"+f,OPS[op]||"eq",v);
      if(q.ord)r=r.order("data->>"+q.ord[0],{ascending:q.ord[1]!=="desc"});
      r=r.limit(q.lim||1000);
      const {data,error}=await r;if(error)throw mapErr(error);
      const docs=(data||[]).map(row=>({id:row.path.split("/").pop(),data:()=>row.data}));
      return {docs,size:docs.length,empty:!docs.length};
    },
    onSnapshot(cb,eb){return listen({kind:"coll",coll,run:async()=>{try{cb(await api.get());}catch(e){eb&&eb(e);}}});}
  };
  return api;
}
const db={doc:docRef,collection:c=>query(c,{})};

/* ---------- people ---------- */
const prof=p=>({id:p.id,name:p.name||(p.email||"").split("@")[0],avatarUrl:p.avatar_url||"",color:"#7a8",email:p.email||null,isMe:p.id===uid,guest:false});
const user={
  async me(){return {...prof(profile),isOwner:!!profile.is_admin,canEdit:!!profile.is_admin};},
  async id(){return uid;},async canEdit(){return !!profile.is_admin;},async isOwner(){return !!profile.is_admin;},
  async can(p){return p==="data.write";},
  async profiles(ids){ids=(Array.isArray(ids)?ids:[ids]).filter(isUuid);const out={};if(!ids.length)return out;
    const {data}=await sb.from("profiles").select("id,name,email,avatar_url").in("id",ids);(data||[]).forEach(p=>{out[p.id]=prof(p);});return out;},
  async search(q){q=String(q||"").replace(/[,()%*\\]/g," ").trim();if(!q)return [];
    const {data}=await sb.from("profiles").select("id,name,email,avatar_url").or("name.ilike.%"+q+"%,email.ilike.%"+q+"%").limit(8);return (data||[]).map(prof);}
};

/* ---------- PRD files ---------- */
const assets={
  async upload(blob,opt){const id=hex32();const {error}=await sb.storage.from("prd").upload(id,blob,{contentType:(opt&&opt.type)||blob.type,upsert:false});
    if(error){const e=new Error(error.message);e.code=/size|large/i.test(error.message)?"too_large":/mime|type/i.test(error.message)?"unsupported_type":/policy|not allowed|unauthor/i.test(error.message)?"not_granted":"unavailable";throw e;}
    return {id,url:"/_blob/"+id,sizeBytes:blob.size};},
  async delete(id){await sb.storage.from("prd").remove([id]);}
};
const nativeFetch=window.fetch.bind(window);
window.fetch=async(u,o)=>{const s=typeof u==="string"?u:(u&&u.url)||"";
  if(s.startsWith("/_blob/")){await ready;const {data,error}=await sb.storage.from("prd").download(s.slice(7));if(error)return new Response("",{status:404});return new Response(data,{status:200,headers:{"content-type":data.type||"application/octet-stream"}});}
  return nativeFetch(u,o);};
document.addEventListener("click",async e=>{const a=e.target.closest&&e.target.closest('a[href^="/_blob/"]');if(!a)return;e.preventDefault();e.stopPropagation();
  const w=window.open("about:blank","_blank");const {data,error}=await sb.storage.from("prd").createSignedUrl(a.getAttribute("href").slice(7),600);
  if(error||!data){if(w)w.close();return;}if(w)w.location=data.signedUrl;else location.href=data.signedUrl;},true);

/* ---------- downloads & AI ---------- */
const downloads={async save(o){const blob=o.data instanceof Blob?o.data:new Blob([o.data],{type:/\.csv$/i.test(o.filename)?"text/csv;charset=utf-8":"application/octet-stream"});
  const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=o.filename||"download";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),4000);return {ok:true};}};
function makeSample(){const f=async()=>{throw Object.assign(new Error("Use json()"),{code:"unavailable"});};
  f.json=async(prompt)=>{const {data:{session}}=await sb.auth.getSession();
    const r=await nativeFetch("/api/ai",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+(session&&session.access_token)},body:JSON.stringify({prompt})});
    let j={};try{j=await r.json();}catch(e){}
    if(!r.ok){const e=new Error(j.error||"AI request failed");e.code=j.code||"unavailable";throw e;}return j.result;};
  return f;}

window.claude={async use(name){await ready;
  return ({db,user,assets,downloads,sample:cfg&&cfg.ai?makeSample():null})[name]||null;}};

/* ---------- sign-in ---------- */
function screen(html){const m=$("#main");if(m)m.innerHTML='<div class="auth-wrap">'+html+"</div>";}
function authForm(mode,msg,keepEmail){
  const signup=mode==="signup";
  screen('<h1>'+(signup?"Create your account":"Sign in")+'</h1><p class="sub">'+(signup?"Use your work email. Your PM adds you to a team space after you sign up.":"Delivery Desk, Pluckk tech delivery.")+'</p>'+
  (msg?'<div class="banner'+(msg.warn?" warn":"")+'" role="status">'+esc(msg.text)+"</div>":"")+
  '<form id="authForm" class="form auth-form" novalidate>'+
  (signup?'<div class="f full"><label for="au_name">Your name</label><input id="au_name" type="text" autocomplete="name" required maxlength="60"></div>':"")+
  '<div class="f full"><label for="au_email">Work email</label><input id="au_email" type="email" autocomplete="email" required value="'+esc(keepEmail||"")+'"></div>'+
  '<div class="f full"><label for="au_pw">Password</label><input id="au_pw" type="password" autocomplete="'+(signup?"new-password":"current-password")+'" minlength="8" required>'+(signup?'<div class="hint">At least 8 characters.</div>':"")+"</div>"+
  '<div class="full" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn primary" type="submit" id="au_go">'+(signup?"Create account":"Sign in")+'</button>'+
  '<button class="btn link" type="button" id="au_switch">'+(signup?"I already have an account":"Create an account")+"</button>"+
  (!signup&&cfg.emailLinks?'<button class="btn link" type="button" id="au_link">Email me a sign-in link</button>':"")+"</div></form>");
  const em=()=>($("#au_email")||{}).value||"";
  $("#au_switch").onclick=()=>authForm(signup?"signin":"signup",null,em());
  const ln=$("#au_link");if(ln)ln.onclick=async()=>{const email=$("#au_email").value.trim();if(!email){authForm("signin",{text:"Enter your email first.",warn:1});return;}
    const {error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin,shouldCreateUser:false}});
    authForm("signin",error?{text:/not authorized|rate limit/i.test(error.message)?"Email links aren’t set up for this workspace yet. Sign in with your password.":error.message,warn:1}:{text:"Check your inbox at "+email+" for the sign-in link."},email);};
  $("#authForm").onsubmit=async e=>{e.preventDefault();const btn=$("#au_go");btn.disabled=true;
    const email=$("#au_email").value.trim(),password=$("#au_pw").value;
    try{
      if(signup){const name=$("#au_name").value.trim();if(!name)throw new Error("Enter your name.");
        const {data,error}=await sb.auth.signUp({email,password,options:{data:{name}}});if(error)throw error;
        if(!data.session){authForm("signin",{text:"Account created. Confirm your email from the message we sent, then sign in."},email);return;}
      }else{const {error}=await sb.auth.signInWithPassword({email,password});if(error)throw error;}
    }catch(err){authForm(mode,{text:(err.message||"Sign-in failed").replace("Invalid login credentials","Wrong email or password."),warn:1},email);return;}
    finally{if(btn)btn.disabled=false;}
  };
  setTimeout(()=>{const f=$(signup?"#au_name":"#au_email");if(f)f.focus();},30);
}
async function afterSession(session){
  uid=session.user.id;
  if(/access_token=|error_description=/.test(location.hash))history.replaceState(null,"",location.pathname+location.search);
  let {data,error}=await sb.from("profiles").select("*").eq("id",uid).maybeSingle();
  if(error||!data){screen('<h1>Setup incomplete</h1><p class="sub">Your account exists but has no profile. Run schema.sql in the Supabase SQL editor, then sign out and sign in again.</p><button class="btn" id="ddOut2">Sign out</button>');$("#ddOut2").onclick=()=>sb.auth.signOut();return;}
  profile=data;
  if(!profile.name){
    screen('<h1>What’s your name?</h1><p class="sub">Your team sees this on tasks and updates.</p><form id="nmForm" class="form auth-form"><div class="f full"><label for="nm_in">Your name</label><input id="nm_in" type="text" maxlength="60" required></div><div class="full"><button class="btn primary" type="submit">Continue</button></div></form>');
    await new Promise(res=>{$("#nmForm").onsubmit=async e=>{e.preventDefault();const v=$("#nm_in").value.trim();if(!v)return;await sb.from("profiles").update({name:v}).eq("id",uid);profile.name=v;res();};});
  }
  const top=document.querySelector(".top-in");
  if(top&&!$("#ddOut")){const b=document.createElement("button");b.id="ddOut";b.type="button";b.className="signout";b.textContent="Sign out";b.onclick=()=>sb.auth.signOut();top.appendChild(b);}
  $("#main").innerHTML='<div class="loading">Loading…</div>';
  readyResolve();
}
async function boot(){
  try{cfg=await (await nativeFetch("/api/config",{cache:"no-store"})).json();}catch(e){cfg=null;}
  if(!cfg||!cfg.url||!cfg.anonKey){screen('<h1>Setup incomplete</h1><p class="sub">Add SUPABASE_URL and SUPABASE_ANON_KEY in Vercel → Settings → Environment Variables, then redeploy.</p>');return;}
  if(!window.supabase||!window.supabase.createClient){screen('<h1>Couldn’t load</h1><p class="sub">The sign-in library didn’t load. Check your connection and reload.</p>');return;}
  sb=window.supabase.createClient(cfg.url,cfg.anonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  let started=false;
  sb.auth.onAuthStateChange((ev,session)=>{
    if(ev==="SIGNED_OUT"){location.reload();return;}
    if(session&&!started){started=true;afterSession(session);}
  });
  const {data:{session}}=await sb.auth.getSession();
  if(session){if(!started){started=true;afterSession(session);}}
  else authForm("signin");
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();
