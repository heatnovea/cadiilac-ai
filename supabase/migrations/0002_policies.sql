-- Cadiilac AI — Row Level Security.
-- Default deny: every table below is only reachable through a policy that
-- matches auth.uid(). Anything that must bypass RLS (credit spend, share link
-- resolution, API key verification) runs in an Edge Function with the service
-- role key, which never reaches the browser.

alter table public.profiles       enable row level security;
alter table public.notes          enable row level security;
alter table public.note_versions  enable row level security;
alter table public.folders        enable row level security;
alter table public.files          enable row level security;
alter table public.share_links    enable row level security;
alter table public.conversations  enable row level security;
alter table public.ai_usage       enable row level security;
alter table public.study_sessions enable row level security;
alter table public.api_keys       enable row level security;
alter table public.backups        enable row level security;
alter table public.rate_limits    enable row level security;

-- profiles: a user may read and update their own row, but plan and credits are
-- server-controlled columns guarded by the trigger below.
drop policy if exists "profiles are self readable" on public.profiles;
create policy "profiles are self readable" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles are self writable" on public.profiles;
create policy "profiles are self writable" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "profiles are self insertable" on public.profiles;
create policy "profiles are self insertable" on public.profiles
  for insert with check (auth.uid() = id);

create or replace function public.protect_billing_columns()
returns trigger
language plpgsql
as $$
begin
  -- Only the service role (Edge Functions) may change paid-tier state.
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role'
     and auth.uid() is not null then
    new.plan := old.plan;
    new.credits := old.credits;
    new.credits_used_total := old.credits_used_total;
    new.credits_reset_at := old.credits_reset_at;
    new.subscription_status := old.subscription_status;
    new.subscription_renews_at := old.subscription_renews_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_protect_billing on public.profiles;
create trigger profiles_protect_billing
before update on public.profiles
for each row execute function public.protect_billing_columns();

-- Owner-only tables.
do $$
declare
  target text;
begin
  foreach target in array array[
    'notes', 'note_versions', 'folders', 'files', 'share_links',
    'conversations', 'ai_usage', 'study_sessions', 'api_keys', 'backups'
  ]
  loop
    execute format('drop policy if exists "owner can read %1$s" on public.%1$I', target);
    execute format(
      'create policy "owner can read %1$s" on public.%1$I for select using (auth.uid() = user_id)', target);

    execute format('drop policy if exists "owner can insert %1$s" on public.%1$I', target);
    execute format(
      'create policy "owner can insert %1$s" on public.%1$I for insert with check (auth.uid() = user_id)', target);

    execute format('drop policy if exists "owner can update %1$s" on public.%1$I', target);
    execute format(
      'create policy "owner can update %1$s" on public.%1$I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      target);

    execute format('drop policy if exists "owner can delete %1$s" on public.%1$I', target);
    execute format(
      'create policy "owner can delete %1$s" on public.%1$I for delete using (auth.uid() = user_id)', target);
  end loop;
end;
$$;

-- ai_usage is written by the Edge Functions with the service role; clients may
-- only read their own history.
drop policy if exists "owner can insert ai_usage" on public.ai_usage;
drop policy if exists "owner can update ai_usage" on public.ai_usage;
drop policy if exists "owner can delete ai_usage" on public.ai_usage;

-- API key hashes must never be updatable from the browser (revocation happens
-- through the cadiilac-api function).
drop policy if exists "owner can update api_keys" on public.api_keys;
drop policy if exists "owner can insert api_keys" on public.api_keys;

-- rate_limits is service-role only: no policies means no client access.

-- --------------------------------------------------------------- storage ----

drop policy if exists "drive read own" on storage.objects;
create policy "drive read own" on storage.objects
  for select using (bucket_id = 'drive' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "drive insert own" on storage.objects;
create policy "drive insert own" on storage.objects
  for insert with check (bucket_id = 'drive' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "drive update own" on storage.objects;
create policy "drive update own" on storage.objects
  for update using (bucket_id = 'drive' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "drive delete own" on storage.objects;
create policy "drive delete own" on storage.objects
  for delete using (bucket_id = 'drive' and auth.uid()::text = (storage.foldername(name))[1]);
