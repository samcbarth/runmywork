# RunMyWork — Orchestration Roadmap

Extracted from the "Ultra Code" orchestration pattern (orchestrator + specialized
workers, depth vs width, planning-before-execution, isolated workspaces, human
gates) and mapped to what RunMyWork actually has.

## The one idea worth stealing
Stop treating the agent as a single assistant. Make it a **project manager that
delegates bounded work to specialists and synthesizes the result**, behind human
approval gates. RunMyWork already implements most of the supporting machinery.

## Scorecard vs. the "missing 10"
| # | Item | Status |
|---|---|---|
| 1 | Duplicate task detection | ✅ `duplicate_task` rows + per-task reject |
| 2 | Orchestrator / worker hierarchy | 🟡 board planner + `delegate.js` + NEW specialist assignment (sequential) |
| 3 | Parallel agent execution | ❌ one process per run (width = future) |
| 4 | Human approval checkpoints | ✅ `authorize_mode` + `review_criteria` |
| 5 | Deploy verification before complete | ✅ `deploy-verify.js` |
| 6 | Memory of failed attempts | ✅ error log + criteria feedback + rejects + dup memory |
| 7 | Task ownership locking | ✅ NEW — `isProjectLocked` (run + awaiting-review lock) |
| 8 | Progress tracker | ✅ `agent_runs` 7-stage |
| 9 | Error logs | ✅ `agent_error_log` |
| 10 | Success-criteria validation | ✅ validation mode + human per-criterion review |

Planning-before-execution = the whole mode chain (discovery→…→reporting) + the
discernment rubric.

## Architecture constraints
Runs in **GitHub Actions** (1 workflow run = 1 node process), **Supabase**,
single-user, `concurrency.group: "pages"` serializes deploys. True "width"
parallelism = concurrent workflow dispatches on isolated branches/worktrees +
a merge/synthesis step — high complexity for modest payoff at this scale.

## Done (this work)
- **Task locking** (`run.js isProjectLocked`): no second run on a project that's
  already running or awaiting human review.
- **Specialist assignment** (`modes.js WORKER_SPECIALTIES` + `classifyWorker`,
  injected in `run.js buildModeGoal`): orchestrator classifies the focus item
  (UI / backend / testing / docs / research) and the agent acts as that specialist.
- **Single-item focus** (`run.js pickFocus`): one highest-priority unresolved item
  per run (failed criterion > unmet criterion > first open task).
- **Visible-surface map** (`run.js buildVisibleSurface`): static scan of the
  project's HTML → "what the user sees and WHERE it lives" so user-facing edits
  land on the right element instead of a guess.
- **Repo guard** (`run.js projectTargetRepo` + `AGENT_EXPECTED_REPO`): a project
  declaring `target_repo: owner/name` is skipped when the run is on a different
  repo — stops a project's task from editing the wrong repo.

## Future (only if a real need appears)
- **Width execution:** orchestrator detects independent focus items → parallel
  workflow dispatches in isolated worktrees → merge/synthesis run. Needs the lock
  (done) + a conflict-resolution strategy.
- **Auto-routing external repos on the cadence** so `target_repo` projects advance
  without a manual trigger (currently they only run when dispatched with their repo).
