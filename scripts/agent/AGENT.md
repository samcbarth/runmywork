# RunMyWork — Agent Runtime

An autonomous, tool-using agent loop that works your projects — the Claude Code
solve loop, run by a **local** model on your own box. It reads each project, uses
tools to actually make progress (search, read, draft, write files, run commands,
delegate to sub-agents), and files every state change as a **gated proposal** you
approve in the app.

This is the engine for Roadmap **Phase 2 (memory)** and **Phase 3 (multi-step,
proactive)**. The simpler one-shot `scripts/ai-advisor.js` still works; this is the
heavier autonomous path. Both share the same Supabase tables and the same
approval-gated guardrail.

```
 projects ─▶ run.js picks targets ─▶ loop.js (ReAct)
                                       │  ask local model ──▶ tool_calls
                                       │  run tools ◀────────┘
                                       │  feed results back, repeat…
                                       ▼
              worklog (memory)  ·  files in work/<id>/  ·  approvals (gated) ─▶ app inbox ─▶ you approve
```

## The loop (what "agentic" means here)

Each run, for each selected project:

1. Build **memory** from the recent worklog (what it learned / proposed before).
2. Enter the loop: the model is given the project + memory + a goal and a set of
   tools. Each turn it either **calls a tool** or **finishes** (`done`).
3. Tool results are fed back in; it keeps going until `done` or the step **budget**
   is hit. This is exactly Claude Code's act → observe → repeat cycle.
4. Real output lands three ways: **worklog** notes (memory, visible in the app),
   **files** in the sandbox (deliverables), and **proposals** (gated changes).

## Autonomy boundary (the carved-in-stone rule)

The agent researches, drafts, writes files, and runs allowed commands **on its
own**. It **cannot** change a project's tracked state. The only path to that is the
`propose` tool, which files a `pending` row in `approvals`; you approve it in the
app's 📥 inbox and the app applies it via the normal Store path. This keeps the
Phase 1 guarantee: *the agent proposes, the human disposes.*

## Tools

| Tool           | Default | What it does |
| -------------- | ------- | ------------ |
| `web_search`   | on  | Keyless search (DuckDuckGo, or SearXNG via `AGENT_SEARXNG_URL`). |
| `fetch_url`    | on  | Fetch a page → readable text (capped). Content is untrusted data. |
| `files`        | on  | read / write / append / list, **jailed** to `work/<projectId>/`. |
| `note`         | on  | Save a finding to the worklog (durable memory). |
| `save_artifact`| on  | Write a deliverable to a file **and** log it (visible in the app). |
| `propose`      | on  | File a gated change: `add_tasks` / `set_status` / `set_priority` / `add_link`. |
| `delegate`     | on  | Spawn a sub-agent for a focused sub-goal (own budget/model, depth-capped). |
| `stage`        | on  | Announce workflow phase (look→think→do→review→revise→report) for the live tracker. |
| `done`         | on  | Finish with a summary. |
| `shell`        | **off** | Run one allowlisted binary, no shell chaining, jailed cwd. `AGENT_ALLOW_SHELL=1`. |
| `build_tool`   | **off** | Write & load a new tool. ⚠️ arbitrary code in-process. `AGENT_ALLOW_BUILD_TOOL=1`. |

**Adding a tool yourself:** drop a file in `tools/` exporting
`{ name, description, parameters, run(args, ctx) }`. It's picked up on the next run.
That's the same mechanism `build_tool` uses.

### Project context (memory) & the progress tracker

- **Project context.** Each project has a `project_context` knowledge store the user
  fills in the app (requirements, decisions, history, instructions). The runtime
  reads it (newest first, capped) and feeds it into the loop as authoritative
  background, so you don't re-brief the agent every run. Append-only, anon-readable —
  **no secrets**.
- **Progress tracker.** Each top-level project run creates an `agent_runs` row. The
  agent calls the `stage` tool to move through six phases — **look → think → do →
  review → revise → report** — and the runtime logs each tool step and finalises the
  run. The app shows a live Domino's-style tracker (polled every ~4s) so you can
  watch where the agent is. Delegated sub-agents log under the parent's stage; they
  don't create their own run.

Both tables are created by the SQL in `scripts/agent/schema.sql` (run once).

### Security notes (read before enabling power tools)

- An autonomous LLM + shell + web is a real attack surface: a fetched page can try
  to inject instructions. Defences: gated proposals, **jailed** fs/shell, command
  **allowlist**, **opt-in** power tools, **budget** cap, depth cap.
- `shell` spawns with `shell:false` — no `;`, `|`, `&&`, redirects. One binary from
  the allowlist, cwd jailed to the sandbox. It is *not* a strong enough sandbox to
  run hostile code; keep the allowlist tight.
- `build_tool` runs the new tool's `run()` as ordinary Node with full privileges —
  it escapes the file sandbox by design. Only enable on a machine you trust fully.
- **Phase 0 rule still holds:** no secrets in Supabase tables (worklog/approvals are
  anon-readable). The agent stores summaries and plans, never credentials.

## Setup

Prereqs: the same box that runs Ollama, **Node 18+**, a clone of this repo, and your
Supabase **service_role key** (Settings → API). Pull a tool-capable model:

```
ollama pull llama3.1        # supports tool-calling; any tool-capable chat model works
```

1. Copy `scripts/run-agent.bat.example` → `scripts/run-agent.bat` (gitignored).
2. Fill in `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. Optionally set `OLLAMA_MODEL`.
3. Test it:
   ```
   scripts\run-agent.bat --list           # prints your projects + ids
   scripts\run-agent.bat --project <id>   # work one project end-to-end
   ```

## Running it

```
node scripts/agent/run.js              # auto-pick: ai_requested / never-touched (capped)
node scripts/agent/run.js --plan       # board planner: choose focus across ALL projects
node scripts/agent/run.js --all        # sweep every open project (up to AGENT_MAX_PROJECTS)
node scripts/agent/run.js --project ID # one project
node scripts/agent/run.js --project ID --goal "Draft the launch checklist"
node scripts/agent/run.js --force      # ignore the "needs it" filter
```

### Board planner (`--plan`, Phase 3)

Instead of working inside one project, the planner loop sees the **whole board** (a
snapshot of every open project — status, priority, idle days, open tasks) and
decides where effort should go. It files **per-project** proposals (targeting each
by `project_id`: bump priority on what to focus, un-idle a stalled project, add the
obvious next task) and saves a ranked `focus-plan.md` to `work/_board/`. Still fully
gated — every move lands in your approval inbox. Run it daily; run the per-project
loop hourly.

### Model split (planner vs worker)

Set `OLLAMA_PLANNER_MODEL` and `OLLAMA_WORKER_MODEL` to use two models: the
**planner** drives the top loop and board planning (reasoning), the **worker** runs
`delegate`d sub-tasks (grunt work — fetch, parse, draft). Leave either unset and it
falls back to `OLLAMA_MODEL`, so the split is opt-in. Example: planner `llama3.1`,
worker `llama3.2` (smaller/faster).

**On-demand from the app:** tapping **"Ask the advisor"** sets `ai_requested`; the
next run picks that project up first.

## Schedule it (Windows Task Scheduler)

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\path\to\runmywork\scripts\run-agent.bat"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
             -RepetitionInterval (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "RunMyWork Agent" `
  -Action $action -Trigger $trigger -Description "Autonomous agent loop over projects"
```

Hourly is a sane default for the heavier loop (the 30-min advisor can stay too).
`AGENT_MAX_PROJECTS` bounds how much it does per run so compute stays predictable.

## Config (environment variables)

| Variable                     | Default                  | Purpose |
| ---------------------------- | ------------------------ | ------- |
| `SUPABASE_URL`               | *(required)*             | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY`  | *(required)*             | service_role key — box only, never committed |
| `OLLAMA_HOST`                | `http://127.0.0.1:11434` | Local Ollama endpoint |
| `OLLAMA_MODEL`               | `llama3.1`               | Base model (fallback for planner/worker; must support tools) |
| `OLLAMA_PLANNER_MODEL`       | *(= OLLAMA_MODEL)*       | Reasoning model: top loop + board planner |
| `OLLAMA_WORKER_MODEL`        | *(= OLLAMA_MODEL)*       | Worker model: delegated sub-tasks |
| `AGENT_BUDGET`               | `12`                     | Max tool steps per project |
| `AGENT_MAX_PROJECTS`         | `3`                      | Projects per scheduled run |
| `AGENT_MAX_DEPTH`            | `2`                      | Max delegation nesting |
| `AGENT_SEARXNG_URL`          | *(unset → DuckDuckGo)*   | Self-hosted SearXNG for better search |
| `AGENT_ALLOW_SHELL`          | *(off)*                  | `1` enables the `shell` tool |
| `AGENT_SHELL_ALLOW`          | *(built-in list)*        | CSV of allowed binaries |
| `AGENT_ALLOW_BUILD_TOOL`     | *(off)*                  | `1` enables `build_tool` (arbitrary code) |
| `AGENT_FORCE`                | *(off)*                  | `1` = work every open project |
