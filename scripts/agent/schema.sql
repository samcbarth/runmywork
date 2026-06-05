-- RunMyWork — agent runtime extra tables (Phase 2 memory + progress tracker).
-- Run this ONCE in the Supabase SQL editor. PostgREST can't issue DDL, so the
-- runtime cannot create these for you. Safe to re-run (IF NOT EXISTS guards).
-- Same rule as every other table: anon-readable, so NEVER store secrets here.

-- 1. Project context / knowledge — append-only, versioned background per project.
create table if not exists public.project_context (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  content    text not null,
  kind       text not null default 'note',   -- note|requirement|decision|history|instruction|goal|constraint
  created_by text not null default 'user',     -- user|agent
  created_at bigint not null
);
create index if not exists project_context_idx on public.project_context (project_id, created_at desc);
alter table public.project_context enable row level security;
drop policy if exists "anon all project_context" on public.project_context;
create policy "anon all project_context" on public.project_context
  for all to anon using (true) with check (true);

-- 2. Agent runs — the progress-tracker record the app polls (look→…→report).
create table if not exists public.agent_runs (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  status     text not null default 'running',  -- running|done|failed
  stage      text not null default 'look',     -- look|think|do|review|revise|report
  percent    int  not null default 0,
  stages     jsonb not null default '[]',       -- [{stage, enteredAt, note}]
  log        jsonb not null default '[]',       -- [{stage, t, line}]
  summary    text not null default '',
  started_at bigint not null,
  updated_at bigint not null,
  ended_at   bigint
);
create index if not exists agent_runs_project_idx on public.agent_runs (project_id, started_at desc);
alter table public.agent_runs enable row level security;
drop policy if exists "anon all agent_runs" on public.agent_runs;
create policy "anon all agent_runs" on public.agent_runs
  for all to anon using (true) with check (true);
