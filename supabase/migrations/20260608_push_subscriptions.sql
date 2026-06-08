-- Web Push subscriptions — one row per installed PWA / browser that opted in.
-- The send-push edge function reads these (service role) and POSTs a VAPID-signed
-- push to each endpoint. Anon-all RLS like every other table (single-user app);
-- the rows hold only opaque push endpoints + keys, never a secret of yours.
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  endpoint   text unique not null,
  p256dh     text not null,
  auth       text not null,
  created_at bigint not null
);
create index if not exists push_subscriptions_endpoint_idx on public.push_subscriptions (endpoint);
alter table public.push_subscriptions enable row level security;
drop policy if exists "anon all push_subscriptions" on public.push_subscriptions;
create policy "anon all push_subscriptions" on public.push_subscriptions
  for all to anon using (true) with check (true);
