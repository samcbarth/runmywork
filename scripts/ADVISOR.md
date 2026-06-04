# RunMyWork — Local AI Advisor

The advisor reads each open project and suggests a **next action** plus a few
concrete **tasks**, using your own **Ollama** model. It runs on the machine that
hosts Ollama (so nothing leaves your network), writes suggestions back to
**Supabase**, and the app shows them on the next load.

```
 ┌──────────────┐   read / write      ┌──────────────┐
 │  Your phone  │ ◀─────────────────▶ │   Supabase   │
 │  / PWA       │   (PostgREST)       │  projects    │
 └──────────────┘                     └──────▲───────┘
        ▲  "Ask the advisor" sets a flag             │ read / patch
        │                                            │
        └────────────────────────────────────┌──────┴────────────┐
                                              │  Ollama machine    │
                                              │  ai-advisor.js  ───┼─▶ localhost:11434
                                              │  (Task Scheduler)  │   (llama3.1)
                                              └────────────────────┘
```

## Datastore: one-time Supabase setup

The app and these scripts use a Supabase project as the cross-device datastore.
Create a free project, then run this in the **SQL editor**:

```sql
create table public.projects (
  id uuid primary key,
  title text not null default 'Untitled Project',
  description text not null default '',
  status text not null default 'active',
  priority text not null default 'medium',
  tags text[] not null default '{}',
  blocked_reason text not null default '',
  total_minutes int not null default 0,
  snoozed_until bigint,
  ai_requested boolean not null default false,
  created_at bigint not null,
  updated_at bigint not null,
  status_history jsonb not null default '[]',
  sessions jsonb not null default '[]',
  links jsonb not null default '[]',
  tasks jsonb not null default '[]',
  ai_suggestion jsonb
);

create table public.settings (
  id int primary key default 1 check (id = 1),
  ntfy_topic text not null default '',
  thresholds jsonb not null default '{}'
);
insert into public.settings (id, ntfy_topic, thresholds)
values (1, 'rmw-sam-9k2x7p',
        '{"blockedDaysWarning":3,"idleDaysWarning":7,"dailyReminderTime":"09:00"}')
on conflict (id) do nothing;

alter table public.projects enable row level security;
alter table public.settings enable row level security;
create policy "anon all projects" on public.projects for all to anon using (true) with check (true);
create policy "anon all settings" on public.settings for all to anon using (true) with check (true);
```

Then, from **Settings → API**, copy your **Project URL** + **anon key** into
`js/store.js` (the `SUPABASE_URL` / `SUPABASE_ANON_KEY` constants in the `Sync`
module). The **service_role key** stays on this box only — never commit it.

> ⚠️ With no login, the anon key grants read/write to anyone who finds it.
> **Never store secrets (tokens, passwords, API keys) in these tables** — that
> rule extends to any future agent context/memory tables.

### Migrate existing data

If you have a legacy `data.json`, import it once:

```
SUPABASE_URL=https://xxxx.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/migrate-to-supabase.js
```

Verify the rows in the Supabase table editor, then delete `data.json`.

## What you need on the Ollama machine

1. **Ollama**, running, with a model pulled:
   ```
   ollama pull llama3.1
   ```
   (Any chat model works — set `OLLAMA_MODEL` to use a different one.)
2. **Node.js 18 or newer** — https://nodejs.org (the scripts use the built-in
   `fetch`, so there's nothing to `npm install`).
3. A clone of this repo (or just the `scripts/` files).
4. Your **Supabase URL + service_role key** (see above).

## One-time setup (Windows)

1. Copy `scripts/run-advisor.bat.example` → `scripts/run-advisor.bat`
   (the copy is gitignored so your keys stay private).
2. Open `run-advisor.bat` and fill in `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
3. Test it from a terminal:
   ```
   scripts\run-advisor.bat
   ```
   You should see it review your projects and write suggestions back.

## Schedule it (Windows Task Scheduler)

Run this once in an **Administrator PowerShell** (adjust the path to your clone):

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\path\to\runmywork\scripts\run-advisor.bat"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
             -RepetitionInterval (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "RunMyWork Advisor" `
  -Action $action -Trigger $trigger -Description "Reads projects, suggests next steps via Ollama"
```

That runs the advisor every 30 minutes. Change `-Minutes 30` to taste.

## Notifications (also on this box)

`scripts/notify-box.js` replaces the old hourly GitHub Action. It reads projects
from Supabase and pushes an ntfy alert for anything blocked/idle past its
threshold. Schedule it hourly the same way (point a second task at
`node scripts/notify-box.js` with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
set, and optionally `NTFY_TOPIC`).

## How the two triggers work

- **Scheduled (automatic):** every run, the advisor reviews any project that is
  new, has changed since its last suggestion, or has no suggestion yet. It skips
  unchanged projects so it doesn't burn compute.
- **On-demand:** tapping **"Ask the advisor"** on a project in the app sets a
  flag (`ai_requested`) in Supabase. The next scheduled run picks it up — or run
  `run-advisor.bat` manually for an immediate pass.

Set `ADVISOR_FORCE=1` to re-generate suggestions for **every** open project,
ignoring the "unchanged" skip.

## Config reference (environment variables)

| Variable                    | Default                  | Purpose                                       |
| --------------------------- | ------------------------ | --------------------------------------------- |
| `SUPABASE_URL`              | *(required)*             | Your Supabase project URL                     |
| `SUPABASE_SERVICE_ROLE_KEY` | *(required)*             | service_role key — stays on this box          |
| `OLLAMA_HOST`               | `http://127.0.0.1:11434` | Your local Ollama endpoint                    |
| `OLLAMA_MODEL`              | `llama3.1`               | Model the advisor uses                        |
| `ADVISOR_FORCE`             | *(off)*                  | `1` = review every open project               |
| `NTFY_TOPIC`                | `rmw-sam-9k2x7p`         | ntfy topic for `notify-box.js`                |
