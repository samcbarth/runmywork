# RunMyWork — Roadmap

Where this project is going. The arc: a personal project tracker that grows into
an **approval-gated autonomous work agent** — it watches your projects, proposes
moves, and (only with your sign-off) acts.

Each phase builds on the one before. Status is honest: ✅ shipped, 🚧 in
progress, 🔜 planned, 💭 idea (not committed).

---

## ✅ Phase 0 — Real datastore (Supabase)

Replaced the GitHub-as-database hack with a hosted Postgres + PostgREST.

- Zero-setup cross-device sync via a committed anon key (RLS-governed).
- Advisor + notifier run on the home box with the `service_role` key (never committed).
- **Hard rule, permanent:** no secrets in any anon-readable table.

## ✅ Phase 1 — Agent rails (worklog + approvals)

The advisor stops silently suggesting and starts **proposing** concrete changes
that you approve or reject. The scaffolding an autonomous agent needs.

- `approvals` table: proposed `add_tasks` / `set_status` / `set_priority` /
  `add_link`, gated `pending → approved/rejected/applied`.
- `worklog` table: append-only agent journal (proposals, actions, notes) — the
  beginning of agent memory.
- Approvals inbox in the app; approve applies app-side + logs to worklog.
- Per-project sync push (no cross-project clobber).

---

## 🔜 Phase 2 — Agent memory / context

Make proposals *smarter* by giving the agent durable context per project, beyond
the raw status fields it reads today.

- A `project_context` store (or richer `worklog` reads): the agent summarizes
  what it has learned about a project and feeds that back into its own prompt on
  the next run — so advice compounds instead of restarting cold each time.
- Advisor reads recent worklog as context window. "What did I propose last time,
  what got rejected, why" → fewer repeat/duplicate proposals.
- **Constraint:** still no secrets in these tables (Phase 0 rule). Context is
  summaries and plans, never credentials.

## 🔜 Phase 3 — Proactive & multi-step agent

Move from one-shot per-project advice to an agent that plans across the whole
board.

- Daily/weekly planning pass: proposes *which projects to focus on*, not just
  next steps within one.
- Multi-step proposals (a small sequence gated as one approval).
- Smarter triggers: react to a project going blocked/idle, not just a 30-min cron.

## 💭 Phase 4 — External signal (integrations)

Pull real-world signal into projects so status reflects reality automatically.

- GitHub: PR merged → propose `set_status: done`; new issue → propose a task.
- Slack / email digest → propose links or tasks.
- All inbound, all still gated through the approvals inbox.

## 💭 Phase 5 — Trust & policies

Reduce approval fatigue once the loop is proven.

- Per-action-type auto-approve policies (e.g. auto-accept `add_tasks`, always
  gate `set_status`).
- Audit view over the worklog: what the agent did, when, on whose say-so.

---

## Guardrails (every phase)

- **Approval-gated by default.** The agent proposes; the human disposes. New
  autonomy is opt-in, never silent.
- **No secrets in anon-readable tables.** Carved in stone since Phase 0.
- **No-build PWA.** Plain `fetch` against PostgREST, no framework, no bundler —
  keep it dead simple to host on GitHub Pages.
- **The box owns the keys.** Anything needing the `service_role` key runs on the
  home machine, never in the repo or the browser.
