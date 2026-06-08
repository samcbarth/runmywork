#!/usr/bin/env node
'use strict';

/*
 * RunMyWork — agent runtime entrypoint.
 * -------------------------------------
 * Picks projects that need the agent, builds each one's memory from the worklog,
 * runs the tool loop to make real progress, and reports. Every state change it
 * wants is filed as a gated proposal for the app's approval inbox.
 *
 * Runs on the box that hosts Ollama (so models + keys stay local). Schedule it
 * like the advisor (Windows Task Scheduler) or run on demand.
 *
 * Usage:
 *   node scripts/agent/run.js                 # auto-pick (ai_requested / new / --force)
 *   node scripts/agent/run.js --plan          # board planner: pick focus across all projects
 *   node scripts/agent/run.js --all           # sweep every open project (capped)
 *   node scripts/agent/run.js --project <id>  # one specific project
 *   node scripts/agent/run.js --goal "..." --project <id>   # ad-hoc goal
 *   node scripts/agent/run.js --list          # show projects + ids, do nothing
 *
 * Env: see config.js / AGENT.md.
 */

const { loadConfig, validate } = require('./config');
const { makeSupabase } = require('./supabase');
const { makeOllama } = require('./ollama');
const { makeGroq, makeOpenRouter, makeOpenAI, makeChainedProvider } = require('./groq');
const { runLoop } = require('./loop');
const { getMode, isWrite, defaultStartMode } = require('./modes');

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--all') a.all = true;
    else if (t === '--plan') a.plan = true;
    else if (t === '--list') a.list = true;
    else if (t === '--force') a.force = true;
    else if (t === '--local') a.forceLocal = true;   // always use Ollama
    else if (t === '--cloud') a.forceCloud = true;   // always use best cloud provider
    else if (t === '--spec')  a.spec = true;         // force a spec-draft run
    else if (t === '--project') a.project = argv[++i];
    else if (t === '--goal') a.goal = argv[++i];
    else if (t === '--mode') a.mode = argv[++i];     // force a specific action mode
    else if (t === '--budget') a.budget = parseInt(argv[++i], 10);
    else a._.push(t);
  }
  return a;
}

function log(...args) { console.log('[agent]', ...args); }

// Does this goal require reliable code editing? Local qwen3:8b can't do those
// well, so those tasks go cloud-first. Routine work (research/proposals) stays local.
function goalNeedsCloud(goal) {
  if (!goal) return false;
  return /\b(edit|patch|fix|write|refactor|implement|commit|add a |add the |create.*file|modify|change.*code|wire up)\b/i.test(goal);
}

// Build a compact two-level file tree from the project root so the model
// knows exactly which paths exist before attempting any reads or writes.
function buildFileTree(root, maxDepth = 2) {
  const fs   = require('fs');
  const path = require('path');
  const SKIP = new Set(['.git', 'node_modules', 'work', '.next', 'dist', 'build', '__pycache__']);
  const lines = [`PROJECT FILE TREE (${root}):`];
  function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith('.') && e.name !== '.gitignore') continue;
      const indent = '  '.repeat(depth);
      if (e.isDirectory()) {
        lines.push(`${indent}${e.name}/`);
        if (depth < maxDepth) walk(path.join(dir, e.name), depth + 1);
      } else {
        lines.push(`${indent}${e.name}`);
      }
    }
  }
  walk(root, 0);
  return lines.join('\n');
}

// Normalise a criterion string for set-membership comparison. Met rows carry an
// "\n\nEvidence:" suffix and feedback rows an "\n\nFeedback:" suffix — strip both
// so a criterion matches across success_criteria / _met / _feedback rows.
function normCrit(s) { return String(s || '').split(/\n\n(?:Evidence|Feedback):/i)[0].trim().toLowerCase(); }

// Does this project still have work the agent should advance on the autonomous
// cadence? True when there are open tasks OR success criteria that aren't all
// met yet. This is what lets the 3h cron actually progress a project instead of
// picking nothing once it has a suggestion. When every criterion is met and no
// open tasks remain, the project drops out — so the cadence stops cleanly and
// never loops the mode chain forever.
async function projectHasLiveWork(sb, p) {
  const openTasks = (p.tasks || []).filter(t => !t.done).length;
  if (openTasks > 0) return true;
  try {
    const rows = await sb.pullContext(p.id, 80);
    const crit = new Set(rows.filter(r => r.kind === 'success_criteria').map(r => normCrit(r.content)));
    if (crit.size) {
      // Latest met / failed timestamp per criterion (rows are newest-first, so the
      // first one seen is the latest). A criterion is RESOLVED only if its newest
      // "met" sign-off is at least as recent as its newest failure feedback — so a
      // later pass clears an earlier fail and we don't loop on it forever.
      const metAt = new Map(), failAt = new Map();
      for (const r of rows) {
        const k = normCrit(r.content);
        if (r.kind === 'success_criteria_met' && !metAt.has(k)) metAt.set(k, r.created_at || 0);
        if (r.kind === 'success_criteria_feedback' && !failAt.has(k)) failAt.set(k, r.created_at || 0);
      }
      for (const c of crit) {
        const m = metAt.has(c) ? metAt.get(c) : -1;
        const f = failAt.has(c) ? failAt.get(c) : -1;
        const resolved = m >= 0 && m >= f;   // met, and not re-failed since
        if (!resolved) return true;
      }
    }
  } catch { /* best effort — fall through to "no live work" */ }
  return false;
}

// Autonomous-cadence selection. Fast-path the explicit signals (force /
// aiRequested / never-touched), then include any project that still has live
// work. Pulls context only for the projects that need the deeper check.
async function selectAutoTargets(sb, projects, force) {
  const open = projects.filter(p => p.status !== 'done' && p.status !== 'archived');
  const out = [];
  for (const p of open) {
    if (force || p.aiRequested || !p.aiSuggestion) { out.push(p); continue; }
    if (await projectHasLiveWork(sb, p)) out.push(p);
  }
  return out;
}

// project_context kinds that together form the project SPEC (the north star).
const SPEC_KINDS = new Set(['goal', 'requirement', 'success_criteria', 'constraint']);
// Review-state kinds: human sign-off (met) and human failure feedback. These are
// not part of the spec text but annotate each criterion's status.
const REVIEW_KINDS = new Set(['success_criteria_met', 'success_criteria_feedback']);

// Partition context rows (newest-first) into the structured spec + freeform background.
function partitionSpec(rows) {
  const byKind = { goal: [], requirement: [], success_criteria: [], constraint: [] };
  const background = [];
  // Latest met / failed timestamp (+ feedback text) per normalised criterion.
  // Rows are newest-first, so the first one seen for a criterion is the latest.
  const metAt = new Map();        // key → created_at
  const failAt = new Map();       // key → { at, feedback }
  for (const r of rows) {
    if (SPEC_KINDS.has(r.kind)) { byKind[r.kind].push(String(r.content || '').trim()); continue; }
    if (r.kind === 'success_criteria_met') {
      const key = normCrit(r.content);
      if (!metAt.has(key)) metAt.set(key, r.created_at || 0);
      continue;
    }
    if (r.kind === 'success_criteria_feedback') {
      // content shape: "<criterion>\n\nFeedback: <text>"
      const key = normCrit(r.content);
      if (!failAt.has(key)) {
        const fb = String(r.content || '').split(/\n\nFeedback:/i)[1];
        failAt.set(key, { at: r.created_at || 0, feedback: (fb || '').trim() });
      }
      continue;
    }
    if (r.kind === 'duplicate_task') continue;   // surfaced separately (see buildContext)
    background.push(`[${r.kind}] ${r.content}`);
  }
  // requirements/criteria/constraints: reverse to roughly authored order; dedupe.
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const requirements = uniq(byKind.requirement.slice().reverse());
  const criteria     = uniq(byKind.success_criteria.slice().reverse());
  const constraints  = uniq(byKind.constraint.slice().reverse());
  const goal         = byKind.goal[0] || '';   // newest goal wins

  // Per-criterion status by RECENCY: failed if the newest feedback is more recent
  // than the newest met sign-off; met if a sign-off is at least as recent as any
  // failure; otherwise not yet reviewed. This clears an old fail once it's re-passed.
  const status = criteria.map(c => {
    const key = normCrit(c);
    const m = metAt.has(key) ? metAt.get(key) : -1;
    const f = failAt.has(key) ? failAt.get(key) : null;
    if (f && f.at > m)  return { text: c, state: 'failed', feedback: f.feedback };
    if (m >= 0)         return { text: c, state: 'met' };
    return { text: c, state: 'open' };
  });
  const openWork = status.filter(s => s.state !== 'met');

  const mark = { met: '✓ met', failed: '✗ FAILED', open: '◦ not yet reviewed' };
  const specLines = [];
  if (goal)               specLines.push(`Goal: ${goal}`);
  if (requirements.length) specLines.push(`Requirements:\n${requirements.map(s => `  - ${s}`).join('\n')}`);
  if (status.length)       specLines.push(`Success criteria:\n${status.map((s, i) =>
                              `  ${i + 1}. [${mark[s.state]}] ${s.text}`).join('\n')}`);
  if (constraints.length)  specLines.push(`Constraints:\n${constraints.map(s => `  - ${s}`).join('\n')}`);

  // A focused block the revision/implementation modes act on: only the criteria
  // that still need work, with the user's failure feedback attached.
  let openWorkText = '';
  if (openWork.length) {
    openWorkText = 'OPEN CRITERIA NEEDING WORK (do these only — leave met criteria alone):\n' +
      openWork.map((s, i) => {
        const tag = s.state === 'failed' ? 'FAILED REVIEW' : 'not yet reviewed';
        const fb = s.feedback ? `\n     user feedback: ${s.feedback}` : '';
        return `  ${i + 1}. (${tag}) ${s.text}${fb}`;
      }).join('\n');
  }

  return {
    specText: specLines.join('\n'),
    hasGoal: Boolean(goal) || criteria.length > 0,
    criteria,
    status,          // [{text, state:'met'|'failed'|'open', feedback?}] — for focus selection
    openWorkText,
    background
  };
}

// Pick the SINGLE highest-priority unresolved item the run should focus on, so
// the agent finishes/repairs one thing before touching anything else. Priority:
// failed criterion (with feedback) > unmet criterion > first open task.
function pickFocus(spec, project) {
  const status = (spec && spec.status) || [];
  const failed = status.find(s => s.state === 'failed');
  if (failed) return `Failed success criterion — "${failed.text}"${failed.feedback ? `\n  User feedback: ${failed.feedback}` : ''}`;
  const open = status.find(s => s.state === 'open');
  if (open) return `Unmet success criterion — "${open.text}"`;
  const openTask = ((project && project.tasks) || []).find(t => !t.done);
  if (openTask) return `Open task — "${openTask.text}"`;
  return '';
}

// Build the ordered context fed to the loop: SPEC → WHERE YOU LEFT OFF → BACKGROUND →
// JOURNAL. Returns { text, spec } so the goal can be framed against the spec.
async function buildContext(sb, projectId) {
  let rows = [];
  try { rows = await sb.pullContext(projectId, 40); } catch { /* best effort */ }
  const spec = partitionSpec(rows);

  let progress = '';
  let journal = '';
  try {
    const entries = await sb.pullWorklog(projectId, 16);   // newest-first
    const prog = entries.find(e => e.kind === 'progress');
    if (prog) {
      const adv = prog.detail && prog.detail.criteriaAdvanced;
      progress = `${prog.summary}${adv ? `\nCriterion advanced: ${adv}` : ''}`;
    }
    const seen = new Set();
    journal = entries
      .filter(e => e.kind !== 'progress')
      .filter(e => { const k = (e.summary || '').slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 10).reverse()
      .map(e => `- [${e.kind}] ${e.summary}`.trim())
      .filter(l => l.length > 6)
      .join('\n');
  } catch { /* best effort */ }

  let background = '';
  if (spec.background.length) {
    const text = spec.background.slice().reverse().join('\n\n');
    background = text.length > 5000 ? '…' + text.slice(-5000) : text;
  }

  // Tasks the user has marked as duplicates / already-handled — never propose these again.
  const dupTasks = rows
    .filter(r => r.kind === 'duplicate_task')
    .map(r => String(r.content || '').split('\n\nDuplicates:')[0].trim())
    .filter(Boolean);
  const dupBlock = dupTasks.length
    ? `ALREADY HANDLED — DO NOT PROPOSE THESE TASKS AGAIN (the user marked them duplicates):\n${[...new Set(dupTasks)].map(t => `  - ${t}`).join('\n')}`
    : '';

  const blocks = [];
  if (spec.specText) blocks.push(`PROJECT SPEC (authoritative — all work must serve this):\n${spec.specText}`);
  if (spec.openWorkText) blocks.push(spec.openWorkText);
  if (dupBlock)      blocks.push(dupBlock);
  if (progress)      blocks.push(`WHERE YOU LEFT OFF (continue from here — do not repeat finished work):\n${progress}`);
  if (background)    blocks.push(`BACKGROUND (user-provided context):\n${background}`);
  if (journal)       blocks.push(`RECENT JOURNAL:\n${journal}`);

  return { text: blocks.join('\n\n'), spec };
}

// Choose the action mode for this run: explicit override → last run's recommended
// next_mode → default start mode for a fresh objective.
async function pickMode(sb, project, spec, override) {
  if (override && getMode(override)) return override;
  let last = null;
  try { last = await sb.latestRun(project.id); } catch { /* best effort */ }
  if (last && last.next_mode && getMode(last.next_mode)) return last.next_mode;
  return defaultStartMode(spec);
}

// Build the goal for a moded run: the mode's directive leads, then the spec /
// criteria / open tasks give it something concrete to work on.
function buildModeGoal(mode, spec, project, config) {
  const parts = [mode.goalFragment];
  // Task-level focus: name the ONE unresolved item this run should advance, so the
  // agent doesn't spread itself across everything open.
  const focus = pickFocus(spec, project);
  if (focus) parts.push(`FOCUS THIS RUN ON THIS ONE ITEM (finish or repair it before starting anything else):\n${focus}`);
  if (spec.criteria && spec.criteria.length) {
    parts.push('Success criteria:\n' + spec.criteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n'));
  }
  const openTasks = (project.tasks || []).filter(t => !t.done).map(t => t.text);
  if (openTasks.length) parts.push(`Open tasks: ${openTasks.slice(0, 6).join('; ')}`);
  if ((mode.id === 'planning' || mode.id === 'discovery') && !project.summary && !project.description) {
    parts.push('This project has no summary/description yet — propose update_description (summary + description) as part of the plan.');
  }
  return parts.join('\n\n');
}

async function runForProject(services, project, goalOverride, budgetOverride, modeOverride) {
  const { sb, config } = services;
  const { text: memoryText, spec } = await buildContext(sb, project.id);

  // Resolve the single action mode for this run. An explicit --goal bypasses the
  // mode system (legacy ad-hoc run); everything else runs inside one mode.
  let mode = null;
  if (!goalOverride) {
    const modeId = await pickMode(sb, project, spec, modeOverride);
    mode = getMode(modeId);
  }

  // Write gate: a write mode (implementation/revision/deployment) may only run
  // with a valid human authorization. Without it, record a short "paused" run so
  // the UI shows the wait, and bail before doing any work.
  if (mode && isWrite(mode.id)) {
    let auth = { authorized: false };
    try { auth = await sb.modeAuthorization(project.id); } catch { /* treat as unauthorized */ }
    if (!auth.authorized) {
      log(`▶ ${project.title} — ${mode.label} pending your approval; skipping.`);
      try {
        const run = await sb.createRun(project.id, mode.id);
        if (run) {
          await sb.updateRun(run.id, {
            status: 'done', stage: 'planning', percent: 0,
            summary: `${mode.label} is pending your approval. Approve the "${mode.label} phase" authorization in the inbox to start the write phase.`,
            ended_at: Date.now()
          });
          // Separate patch (see loop.js) so a missing next_mode column can't drop the above.
          try { await sb.updateRun(run.id, { next_mode: mode.id }); } catch { /* pre-migration */ }
        }
      } catch { /* tracker best-effort */ }
      try {
        const { sendPush } = require('./notify');
        sendPush({ title: '⏸ Agent needs your approval',
          body: `${project.title}: approve the ${mode.label} phase to let the agent start.`,
          projectId: project.id, tag: `rmw-approval-${project.id}` });
      } catch { /* best effort */ }
      return { skipped: true, reason: 'pending_approval', mode: mode.id };
    }
  }

  // Goal framing: explicit override, else mode-driven goal.
  const goal = goalOverride || buildModeGoal(mode, spec, project, config);
  const specMode = false;

  const contextText = memoryText;

  // Inject real file tree so the model never guesses paths.
  // Cloud free tiers have tight token/day limits — use a shallow (1-level) tree to save tokens.
  let fileTree = '';
  if (services.config.projectRoot) {
    const anyCloud = services.config.groqKey || services.config.openRouterKey || services.config.openAIKey;
    const depth = anyCloud ? 1 : 2;
    try { fileTree = buildFileTree(services.config.projectRoot, depth); } catch { /* best effort */ }
  }

  log(`▶ ${project.title}  [${project.status}]${mode ? `  mode: ${mode.label}` : ''}`);
  log(`   goal: ${goal.slice(0, 100)}`);

  const result = await runLoop({
    services, project, goal,
    mode,
    allowList: mode ? mode.allowList : undefined,
    contextText: fileTree ? `${contextText}\n\n${fileTree}`.trim() : contextText,
    budget: budgetOverride || services.config.budget
  });

  // Refresh the card headline + journal the run. Skip empty/placeholder summaries
  // so a budget-exhausted run never overwrites a good headline with "(no summary)".
  const headline = (result.summary || '').split('\n')[0].slice(0, 200).trim();
  if (headline && headline !== '(no summary)') {
    try {
      await sb.setSuggestion(project.id, { nextAction: headline, model: services.config.plannerModel, generatedAt: Date.now() }, project.updatedAt);
    } catch (e) { log(`   (could not update headline: ${e.message})`); }
  }

  // One factual PROGRESS entry per run — becomes the next run's "WHERE YOU LEFT OFF".
  const filesChanged = result.changedFiles || [];
  try {
    await sb.addWorklog({
      project_id: project.id, kind: 'progress', created_by: 'agent',
      summary: (result.summary || 'Run complete').split('\n')[0].slice(0, 200),
      detail: {
        summary: result.summary,
        proposals: result.proposals,
        artifacts: result.artifacts,
        changedFiles: filesChanged,
        committed: Boolean(result.committed),
        criteriaAdvanced: result.criteriaAdvanced || '',
        visualSummary: result.visualSummary || ''
      }
    });
  } catch { /* best effort */ }

  log(`   ✓ ${result.steps} steps · proposed: ${result.proposals.join(', ') || 'none'} · artifacts: ${result.artifacts.length}${filesChanged.length ? ` · changed: ${filesChanged.map(f => f.path).join(', ')}` : ''}`);
  log(`   ${result.summary.slice(0, 240)}`);
  return result;
}

// Phase 3: one loop that sees the whole board and decides where effort should go,
// filing per-project proposals (targeted by id) instead of working inside one.
function boardSnapshot(projects) {
  return projects.map(p => {
    const open = (p.tasks || []).filter(t => !t.done);
    const days = Math.floor((Date.now() - p.updatedAt) / 86400000);
    return [
      `• ${p.title}  (id: ${p.id})`,
      `  status: ${p.status}${p.status === 'blocked' && p.blockedReason ? ` — ${p.blockedReason}` : ''} · priority: ${p.priority} · ${days}d since update`,
      open.length ? `  open tasks (${open.length}): ${open.slice(0, 4).map(t => t.text).join('; ')}` : `  no open tasks`,
      p.aiSuggestion && p.aiSuggestion.nextAction ? `  last advice: ${p.aiSuggestion.nextAction}` : ''
    ].filter(Boolean).join('\n');
  }).join('\n');
}

async function runForBoard(services, projects) {
  const open = projects.filter(p => p.status !== 'done' && p.status !== 'archived');
  if (!open.length) { services.log('Board is empty — nothing to plan.'); return; }

  services.log(`▶ board planner over ${open.length} open project(s)`);
  const result = await runLoop({
    services,
    project: null,
    boardProjects: open,
    goal: 'Decide which projects deserve focus next and file the concrete moves as proposals (use project_id to target each).',
    contextText: `BOARD — ${open.length} open projects\n${boardSnapshot(open)}`,
    budget: services.config.budget,
    model: services.config.plannerModel
  });

  services.log(`   ✓ ${result.steps} steps · proposed: ${result.proposals.join(', ') || 'none'} · plan saved to work/_board/`);
  services.log(`   ${result.summary.slice(0, 240)}`);
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (args.force) config.force = true;
  if (args.forceLocal) config.forceLocal = true;
  if (args.forceCloud) config.forceCloud = true;
  if (args.spec) config.forceSpec = true;

  const missing = validate(config);
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(', ')}. Set them in run-agent.bat (see AGENT.md).`);
    process.exit(1);
  }

  const sb = makeSupabase(config);
  // Build the provider CHAIN. Order depends on the task — and the chain falls
  // over mid-run on any failure (rate limit / model down / OOM):
  //   • routine work (research, proposals, autonomous 3h runs) → LOCAL FIRST
  //     (free qwen3:8b is good enough), cloud only if local errors.
  //   • code edits (--goal contains edit/patch/fix/write/...)  → CLOUD FIRST
  //     (qwen3:8b can't do reliable code edits), local as last resort.
  //   • --local → Ollama only.   • --cloud → cloud first, then Ollama.
  const localLink  = { label: 'ollama', impl: makeOllama(config) };
  const cloudLinks = [];
  if (config.groqKey)       cloudLinks.push({ label: `groq:${config.groqModel}`,            impl: makeGroq(config) });
  if (config.openRouterKey) cloudLinks.push({ label: `openrouter:${config.openRouterModel}`, impl: makeOpenRouter(config) });
  if (config.openAIKey)     cloudLinks.push({ label: `openai:${config.openAIModel}`,         impl: makeOpenAI(config) });

  let chain;
  if (config.forceLocal) {
    chain = [localLink];
  } else if (config.forceCloud) {
    chain = [...cloudLinks, localLink];
  } else if (goalNeedsCloud(args.goal) || args.spec || args.mode === 'implementation' || args.mode === 'revision') {
    chain = [...cloudLinks, localLink];     // code task / spec draft / write mode → cloud first
  } else {
    chain = [localLink, ...cloudLinks];     // routine → local first
  }

  const ollama   = chain.length > 1 ? makeChainedProvider(chain, log) : chain[0].impl;
  const provider = chain.length > 1 ? chain.map(c => c.label).join(' → ') : null;
  const services = { sb, ollama, config, log, runLoop };

  // fail fast & clear if either dependency is down
  if (!(await sb.ping())) {
    console.error('Cannot reach Supabase (check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
    process.exit(1);
  }

  let projects;
  try { projects = await sb.pullProjects(); }
  catch (e) { console.error(`Failed to read projects: ${e.message}`); process.exit(1); }

  if (args.list) {
    projects.forEach(p => console.log(`${p.id}  [${p.status}]  ${p.title}`));
    return;
  }

  if (!(await ollama.reachable())) {
    console.error(`Cannot reach Ollama at ${ollama.host}. Is it running? (ollama serve)`);
    process.exit(1);
  }
  // soft warn if a configured model isn't pulled (loop would fail per-call otherwise)
  const installed = await ollama.listModels();
  const want = [...new Set([config.plannerModel, config.workerModel])];
  const absent = want.filter(m => installed.length && !installed.some(i => i === m || i === `${m}:latest` || i.startsWith(`${m}:`)));
  if (absent.length) log(`⚠ model(s) not found in 'ollama list': ${absent.join(', ')} — pull them or fix OLLAMA_*_MODEL.`);

  const split = config.plannerModel !== config.workerModel;
  const modelTag = provider || (split ? `planner=${config.plannerModel} worker=${config.workerModel}` : `model=${config.plannerModel}`);
  log(`${modelTag} host=${ollama.host} budget=${config.budget}` +
      `${config.allowShell ? ' +shell' : ''}${config.allowBuildTool ? ' +build_tool' : ''}`);

  if (args.plan) { await runForBoard(services, projects); return; }

  // selection
  let targets;
  if (args.project) {
    const p = projects.find(x => x.id === args.project);
    if (!p) { console.error(`No project with id ${args.project}.`); process.exit(1); }
    targets = [p];
  } else if (args.all) {
    targets = projects.filter(p => p.status !== 'done' && p.status !== 'archived');
  } else {
    targets = await selectAutoTargets(sb, projects, config.force);
  }

  targets = targets.slice(0, args.project ? 1 : config.maxProjects);

  if (!targets.length) {
    log('No projects need the agent right now. (Tap "Ask the advisor" on one, or use --all / --force.)');
    return;
  }
  log(`${targets.length} project(s) this run.`);

  // Collect runs that actually committed code so the workflow knows it must push
  // to main, wait for the GitHub Pages deploy, and verify the change is live
  // before flipping those tracker runs to complete (see deploy-verify.js).
  const handoff = { committed: false, runs: [], visualSummary: '', changedFiles: [], summary: '' };

  for (const project of targets) {
    try {
      const result = await runForProject(services, project, args.project ? args.goal : undefined, args.budget, args.mode);
      if (result && result.committed) {
        handoff.committed = true;
        // Per-run objects so deploy-verify can file a criterion-review proposal
        // against the right project once the change is confirmed live.
        if (result.runId) handoff.runs.push({
          runId: result.runId,
          projectId: project.id,
          criteriaAdvanced: result.criteriaAdvanced || ''
        });
        if (result.visualSummary && !handoff.visualSummary) handoff.visualSummary = result.visualSummary;
        if (Array.isArray(result.changedFiles)) handoff.changedFiles.push(...result.changedFiles);
        if (result.summary && !handoff.summary) handoff.summary = result.summary;
      }
    } catch (e) {
      log(`   ✗ ${project.title} failed: ${e.message}`);
    }
  }

  // Write the deploy handoff for the workflow. Always write it (even when empty)
  // so the workflow has a deterministic file to read.
  try {
    const fs = require('fs');
    const path = require('path');
    const outDir = path.join(__dirname, 'work');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'deploy-handoff.json'), JSON.stringify(handoff, null, 2));
    log(`Deploy handoff: committed=${handoff.committed} runs=${handoff.runs.length}`);
  } catch (e) {
    log(`   (could not write deploy handoff: ${e.message})`);
  }

  log('Done.');
}

main().catch(e => { console.error('Agent failed:', e.message); process.exit(1); });
