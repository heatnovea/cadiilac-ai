-- Cadiilac AI — core schema.
-- Every table is owned by a user and protected by Row Level Security so that a
-- leaked anon key can never read another account's data. Quotas that cost money
-- (AI credits, storage, note limits) are enforced in SQL or in Edge Functions,
-- never in the browser.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- profiles --

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  name text,
  plan text not null default 'free' check (plan in ('free', 'cloud')),
  settings jsonb not null default '{}'::jsonb,
  credits integer not null default 75,
  credits_used_total integer not null default 0,
  credits_reset_at timestamptz not null default now() + interval '24 hours',
  subscription_status text not null default 'active',
  subscription_renews_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Plan definitions live in SQL as well so functions and policies agree with the
-- values shipped in public/assets/js/config.js.
create or replace function public.plan_limits(p_plan text)
returns table (
  storage_bytes bigint,
  notes_per_week integer,
  credit_allowance integer,
  credit_window_hours integer,
  max_credits integer,
  has_backups boolean,
  has_personality boolean,
  has_api boolean
)
language sql
immutable
as $$
  select
    case when p_plan = 'cloud' then 21474836480::bigint else 5368709120::bigint end,
    case when p_plan = 'cloud' then 2147483647 else 15 end,
    case when p_plan = 'cloud' then 250 else 75 end,
    case when p_plan = 'cloud' then 12 else 24 end,
    case when p_plan = 'cloud' then 500 else 75 end,
    p_plan = 'cloud',
    p_plan = 'cloud',
    p_plan = 'cloud';
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------- notes --

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'Untitled note',
  content text not null default '',
  strokes jsonb not null default '[]'::jsonb,
  style jsonb not null default '{}'::jsonb,
  starred boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists notes_user_updated_idx on public.notes (user_id, updated_at desc);

create table if not exists public.note_versions (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  content text,
  strokes jsonb,
  created_at timestamptz not null default now()
);
create index if not exists note_versions_note_idx on public.note_versions (note_id, created_at desc);

-- Version history is a Cadiilac Cloud feature; the trigger checks the plan.
create or replace function public.snapshot_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  user_plan text;
  last_snapshot timestamptz;
begin
  select plan into user_plan from public.profiles where id = old.user_id;
  if user_plan is distinct from 'cloud' then
    return new;
  end if;

  select max(created_at) into last_snapshot from public.note_versions where note_id = old.id;
  if last_snapshot is null or last_snapshot < now() - interval '5 minutes' then
    insert into public.note_versions (note_id, user_id, title, content, strokes)
    values (old.id, old.user_id, old.title, old.content, old.strokes);
  end if;
  return new;
end;
$$;

drop trigger if exists notes_snapshot on public.notes;
create trigger notes_snapshot
before update on public.notes
for each row when (old.content is distinct from new.content)
execute function public.snapshot_note();

-- Server-side enforcement of the weekly note allowance.
create or replace function public.create_note(
  p_title text default 'Untitled note',
  p_content text default '',
  p_strokes jsonb default '[]'::jsonb,
  p_style jsonb default '{}'::jsonb
)
returns public.notes
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  user_plan text;
  weekly_limit integer;
  used integer;
  row public.notes;
begin
  if uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select plan into user_plan from public.profiles where id = uid;
  select notes_per_week into weekly_limit from public.plan_limits(coalesce(user_plan, 'free'));

  select count(*) into used
  from public.notes
  where user_id = uid and created_at >= date_trunc('week', now());

  if used >= weekly_limit then
    raise exception 'Weekly note limit reached for the % plan. Upgrade to Cadiilac Cloud for unlimited notes.', coalesce(user_plan, 'free')
      using errcode = 'P0001';
  end if;

  insert into public.notes (user_id, title, content, strokes, style)
  values (uid, coalesce(p_title, 'Untitled note'), coalesce(p_content, ''), coalesce(p_strokes, '[]'::jsonb), coalesce(p_style, '{}'::jsonb))
  returning * into row;

  return row;
end;
$$;

-- ------------------------------------------------------------------- drive --

create table if not exists public.folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  parent_id uuid references public.folders (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);
create index if not exists folders_user_idx on public.folders (user_id, name);

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  folder_id uuid references public.folders (id) on delete set null,
  name text not null,
  size bigint not null default 0,
  mime text not null default 'application/octet-stream',
  storage_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists files_user_idx on public.files (user_id, created_at desc);

create or replace function public.storage_used(p_user uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(size), 0)::bigint
  from public.files
  where user_id = p_user and p_user = auth.uid();
$$;

-- Reject uploads that would exceed the plan allowance even if the client skips
-- its own check.
create or replace function public.enforce_storage_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  user_plan text;
  allowance bigint;
  used bigint;
begin
  select plan into user_plan from public.profiles where id = new.user_id;
  select storage_bytes into allowance from public.plan_limits(coalesce(user_plan, 'free'));
  select coalesce(sum(size), 0) into used from public.files where user_id = new.user_id;

  if used + new.size > allowance then
    raise exception 'Storage limit reached. Free up space or upgrade to Cadiilac Cloud.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists files_storage_quota on public.files;
create trigger files_storage_quota
before insert on public.files
for each row execute function public.enforce_storage_quota();

create table if not exists public.share_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  file_id uuid not null references public.files (id) on delete cascade,
  token text not null unique,
  access text not null default 'private' check (access in ('private', 'link')),
  allow_download boolean not null default true,
  expires_at timestamptz,
  views integer not null default 0,
  created_at timestamptz not null default now(),
  unique (file_id)
);

-- --------------------------------------------------------------- assistant --

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'New conversation',
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists conversations_user_idx on public.conversations (user_id, updated_at desc);

create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  cost integer not null default 1,
  model text,
  tokens integer,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_user_idx on public.ai_usage (user_id, created_at desc);

create table if not exists public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  note_id uuid references public.notes (id) on delete set null,
  duration_seconds integer not null default 0,
  cards_reviewed integer not null default 0,
  quiz_correct integer not null default 0,
  quiz_total integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  prefix text not null,
  key_hash text not null,
  requests integer not null default 0,
  revoked boolean not null default false,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists api_keys_hash_idx on public.api_keys (key_hash);

create table if not exists public.backups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  notes integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Simple sliding-window rate limiting for the Edge Functions.
create table if not exists public.rate_limits (
  id bigserial primary key,
  subject text not null,
  route text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_limits_subject_idx on public.rate_limits (subject, route, created_at desc);

-- ---------------------------------------------------------------- storage ---

insert into storage.buckets (id, name, public)
values ('drive', 'drive', false)
on conflict (id) do nothing;
