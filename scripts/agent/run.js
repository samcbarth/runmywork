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
const { makeGroq, makeOpenRouter, makeOpenAI } = require('./groq');
const { runLoop } = require('./loop');

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
    else if (t === '--project') a.project = argv[++i];
    else if (t === '--goal') a.goal = argv[++i];
    else if (t === '--budget') a.budget = parseInt(argv[++i], 10);
    else a._.push(t);
  }
  return a;
}

// Decide whether a goal requires cloud (code edits, git) or can run local (research, proposals).
function goalNeedsCloud(goal) {
  if (!goal) return false;
  return /edit|patch|write|fix|refactor|commit|implement|add.*feature|update.*file|change.*code/i.test(goal);
}

function log(...args) { console.log('[agent]', ...args); }

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

function needsAgent(p, force) {
  if (p.status === 'done' || p.status === 'archived') return false;
  if (force) return true;
  if (p.aiRequested) return true;          // user tapped "Ask the advisor"
  if (!p.aiSuggestion) return true;        // never touched
  return false;
}

// Recent worklog → compact memory text fed back into the loop (Phase 2).
async function buildMemory(sb, projectId) {
  // 1. User-authored knowledge (project_context) — durable background the user
  //    wrote so the agent doesn't need re-briefing. Treated as authoritative.
  let knowledge = '';
  try {
    const rows = await sb.pullContext(projectId, 30);
    if (rows.length) {
      const text = rows.slice().reverse().map(r => `[${r.kind}] ${r.content}`).join('\n\n');
      knowledge = text.length > 6000 ? '…' + text.slice(-6000) : text;   // keep newest, cap for small models
    }
  } catch { /* best effort */ }

  // 2. Recent agent journal (worklog) — what the agent did/learned last runs.
  let journal = '';
  try {
    const entries = await sb.pullWorklog(projectId, 14);
    journal = entries.slice().reverse()
      .map(e => `- [${e.kind}] ${e.summary}`.trim())
      .filter(l => l.length > 6)
      .join('\n');
  } catch { /* best effort */ }

  const parts = [];
  if (knowledge) parts.push(`PROJECT KNOWLEDGE (user-provided context — authoritative background):\n${knowledge}`);
  if (journal) parts.push(`RECENT AGENT JOURNAL:\n${journal}`);
  return parts.join('\n\n');
}

async function runForProject(services, project, goalOverride, budgetOverride) {
  const { sb } = services;
  // Goal is derived from the project's CURRENT open state — NOT the agent's own
  // last summary. Using the prior summary as the next goal made the agent fixate
  // on whatever it mentioned last (e.g. one task) run after run.
  const openTasks = (project.tasks || []).filter(t => !t.done).map(t => t.text);
  const focus = openTasks.length ? ` Prioritise the open tasks: ${openTasks.slice(0, 5).join('; ')}.` : '';
  const goal = goalOverride
    || `Make concrete, useful progress on "${project.title}".${focus} Research what's needed, draft or build a deliverable, save it, and propose the next tasks or a status change. Produce something — don't just plan. Do not re-investigate things already marked done.`;

  const contextText = await buildMemory(sb, project.id);

  // Inject real file tree so the model never guesses paths.
  // Groq free tier has a tight TPM limit — use a shallow (1-level) tree to save tokens.
  let fileTree = '';
  if (services.config.projectRoot) {
    const depth = services.config.groqKey ? 1 : 2;
    try { fileTree = buildFileTree(services.config.projectRoot, depth); } catch { /* best effort */ }
  }

  log(`▶ ${project.title}  [${project.status}]`);
  log(`   goal: ${goal.slice(0, 100)}`);

  const result = await runLoop({
    services, project, goal,
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

  const filesChanged = result.changedFiles || [];
  try {
    await sb.addWorklog({
      project_id: project.id, kind: 'action', created_by: 'agent',
      summary: `Agent run: ${result.steps} steps, ${result.proposals.length} proposal(s), ${result.artifacts.length} artifact(s)${filesChanged.length ? `, ${filesChanged.length} file(s) changed` : ''}`,
      detail: { summary: result.summary, proposals: result.proposals, artifacts: result.artifacts, changedFiles: filesChanged }
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

  const missing = validate(config);
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(', ')}. Set them in run-agent.bat (see AGENT.md).`);
    process.exit(1);
  }

  const sb = makeSupabase(config);
  // Provider selection:
  //   --local          → always Ollama (free, good for research/proposals)
  //   --cloud          → always best available cloud
  //   auto (default)   → cloud if goal involves code edits, otherwise Ollama
  //   no cloud keys    → always Ollama
  const hasCloud = config.openAIKey || config.groqKey || config.openRouterKey;
  const goalText = args.goal || '';
  const useCloud = !config.forceLocal && hasCloud &&
    (config.forceCloud || goalNeedsCloud(goalText) || !config.ollamaModel);

  let ollama, provider;
  if (useCloud && config.openAIKey) {
    ollama   = makeOpenAI(config);
    provider = `openai:${config.openAIModel}`;
    config.plannerModel = config.openAIModel;
    config.workerModel  = config.openAIModel;
  } else if (useCloud && config.groqKey) {
    ollama   = makeGroq(config);
    provider = `groq:${config.groqModel}`;
    config.plannerModel = config.groqModel;
    config.workerModel  = config.groqModel;
  } else if (useCloud && config.openRouterKey) {
    ollama   = makeOpenRouter(config);
    provider = `openrouter:${config.openRouterModel}`;
    config.plannerModel = config.openRouterModel;
    config.workerModel  = config.openRouterModel;
  } else {
    ollama   = makeOllama(config);
    provider = null;
  }
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
    targets = projects.filter(p => needsAgent(p, config.force));
  }

  targets = targets.slice(0, args.project ? 1 : config.maxProjects);

  if (!targets.length) {
    log('No projects need the agent right now. (Tap "Ask the advisor" on one, or use --all / --force.)');
    return;
  }
  log(`${targets.length} project(s) this run.`);

  for (const project of targets) {
    try {
      await runForProject(services, project, args.project ? args.goal : undefined, args.budget);
    } catch (e) {
      log(`   ✗ ${project.title} failed: ${e.message}`);
    }
  }
  log('Done.');
}

main().catch(e => { console.error('Agent failed:', e.message); process.exit(1); });
