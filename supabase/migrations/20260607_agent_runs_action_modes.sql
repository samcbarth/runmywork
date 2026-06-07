-- Agent action modes: per-run mode + recommended next mode.
-- Nullable + back-compatible; existing rows and any run without a mode behave as before.
alter table agent_runs add column if not exists mode text;
alter table agent_runs add column if not exists next_mode text;
