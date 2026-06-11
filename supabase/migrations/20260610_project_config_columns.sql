-- Phase 1: Project configuration as first-class schema.
-- Promotes target_repo / live_url / cadence and other per-project config from
-- ad-hoc `project_context` instruction rows into real columns on `projects`,
-- and adds a `project_runs_schedule` table so the dispatcher can pick eligible
-- projects with a single query instead of iterating + heuristics.
--
-- All additions are nullable / defaulted so existing rows and code paths keep
-- working. A one-time backfill copies the legacy instruction rows into columns.

-- ── 1. New columns on projects ──────────────────────────────────────────────

alter table projects add column if not exists target_repo     text;
alter table projects add column if not exists live_url        text;
alter table projects add column if not exists preview_url     text;
alter table projects add column if not exists cadence_minutes int     default 180;
alter table projects add column if not exists cadence_window  jsonb;
alter table projects add column if not exists rules_path      text    default '.runmywork/rules.md';
alter table projects add column if not exists roles_enabled   jsonb   default '{"pm":true,"shepherd":true,"senior_pm":true,"builder":true,"reviewer":true,"senior_dev_mgr":true}'::jsonb;
alter table projects add column if not exists auto_run_disabled boolean default false;
alter table projects add column if not exists archived_at     bigint;

-- target_repo gets indexed because the agent runtime reads it on every run.
create index if not exists projects_target_repo_idx on projects (lower(target_repo));
create index if not exists projects_archived_idx    on projects (archived_at);

-- ── 2. Per-project schedule table ───────────────────────────────────────────

create table if not exists project_runs_schedule (
  project_id   uuid primary key references projects(id) on delete cascade,
  next_run_at  bigint not null default 0,   -- 0 = "due now", picked on next tick
  last_run_at  bigint,
  paused_until bigint,                       -- > now() = skip until then
  updated_at   bigint not null default (extract(epoch from now()) * 1000)::bigint
);
alter table project_runs_schedule enable row level security;
do $$ begin
  create policy "schedule_all_anon" on project_runs_schedule for all to anon using (true) with check (true);
exception when duplicate_object then null; end $$;

create index if not exists project_runs_schedule_next_idx on project_runs_schedule (next_run_at);

-- Seed schedule rows for every existing project so the dispatcher has a row
-- to update for any project that was created before this migration.
insert into project_runs_schedule (project_id, next_run_at)
select id, 0 from projects
on conflict (project_id) do nothing;

-- ── 3. Backfill from legacy instruction context rows ───────────────────────
-- Old shape: project_context.kind='instruction', content='target_repo: owner/name'
-- New shape: projects.target_repo = 'owner/name'.

with latest_target_repo as (
  select distinct on (project_id)
         project_id,
         lower(trim(regexp_replace(content, '^[^:]*:\s*', ''))) as value
  from project_context
  where kind = 'instruction'
    and lower(trim(content)) like 'target_repo:%'
  order by project_id, created_at desc
)
update projects p
   set target_repo = ltr.value
  from latest_target_repo ltr
 where p.id = ltr.project_id
   and (p.target_repo is null or p.target_repo = '');

with latest_live_url as (
  select distinct on (project_id)
         project_id,
         trim(regexp_replace(content, '^[^:]*:\s*', '')) as value
  from project_context
  where kind = 'instruction'
    and lower(trim(content)) like 'live_url:%'
  order by project_id, created_at desc
)
update projects p
   set live_url = lur.value
  from latest_live_url lur
 where p.id = lur.project_id
   and (p.live_url is null or p.live_url = '');

with latest_preview_url as (
  select distinct on (project_id)
         project_id,
         trim(regexp_replace(content, '^[^:]*:\s*', '')) as value
  from project_context
  where kind = 'instruction'
    and lower(trim(content)) like 'preview_url:%'
  order by project_id, created_at desc
)
update projects p
   set preview_url = pur.value
  from latest_preview_url pur
 where p.id = pur.project_id
   and (p.preview_url is null or p.preview_url = '');
