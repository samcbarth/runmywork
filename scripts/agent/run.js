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

function needsAgent(p, force) {
  if (p.status === 'done' || p.status === 'archived') return false;
  if (force) return true;
  if (p.aiRequested) return true;          // user tapped "Ask the advisor"
  if (!p.aiSuggestion) return true;        // never touched
  return false;
}

// project_context kinds that together form the project SPEC (the north star).
const SPEC_KINDS = new Set(['goal', 'requirement', 'success_criteria', 'constraint']);

// Partition context rows (newest-first) into the structured spec + freeform background.
function partitionSpec(rows) {
  const byKind = { goal: [], requirement: [], success_criteria: [], constraint: [] };
  const background = [];
  for (const r of rows) {
    if (SPEC_KINDS.has(r.kind)) byKind[r.kind].push(String(r.content || '').trim());
    else background.push(`[${r.kind}] ${r.content}`);
  }
  // requirements/criteria/constraints: reverse to roughly authored order; dedupe.
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const requirements = uniq(byKind.requirement.slice().reverse());
  const criteria     = uniq(byKind.success_criteria.slice().reverse());
  const constraints  = uniq(byKind.constraint.slice().reverse());
  const goal         = byKind.goal[0] || '';   // newest goal wins

  const specLines = [];
  if (goal)               specLines.push(`Goal: ${goal}`);
  if (requirements.length) specLines.push(`Requirements:\n${requirements.map(s => `  - ${s}`).join('\n')}`);
  if (criteria.length)     specLines.push(`Success criteria:\n${criteria.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`);
  if (constraints.length)  specLines.push(`Constraints:\n${constraints.map(s => `  - ${s}`).join('\n')}`);

  return {
    specText: specLines.join('\n'),
    hasGoal: Boolean(goal) || criteria.length > 0,
    criteria,
    background
  };
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

  const blocks = [];
  if (spec.specText) blocks.push(`PROJECT SPEC (authoritative — all work must serve this):\n${spec.specText}`);
  if (progress)      blocks.push(`WHERE YOU LEFT OFF (continue from here — do not repeat finished work):\n${progress}`);
  if (background)    blocks.push(`BACKGROUND (user-provided context):\n${background}`);
  if (journal)       blocks.push(`RECENT JOURNAL:\n${journal}`);

  return { text: blocks.join('\n\n'), spec };
}

async function runForProject(services, project, goalOverride, budgetOverride) {
  const { sb, config } = services;
  const { text: memoryText, spec } = await buildContext(sb, project.id);

  // Goal framing, in priority order (Component 3):
  //   1. explicit --goal override
  //   2. no spec yet (or --spec) → SPEC MODE: research + propose a set_spec
  //   3. spec with success criteria → advance the next unmet criterion
  //   4. spec/goal but no criteria → open-task fallback
  let goal;
  let specMode = false;
  if (goalOverride) {
    goal = goalOverride;
  } else if (config.forceSpec || !spec.hasGoal) {
    specMode = true;
    goal = `This project has no clear spec yet. Research it — read the project context, tasks, and any linked code or files — then call the propose tool with action "set_spec" to define: a one-sentence goal, the key requirements, and 3-6 measurable, checkable success criteria that mean the project is "done". Do this BEFORE any other work, and finish once the spec proposal is filed.`;
  } else if (spec.criteria.length) {
    const list = spec.criteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
    const descHint = (!project.summary && !project.description)
      ? '\nAlso: this project has no summary or description yet. After researching the project, use propose with action "update_description" to set a one-sentence summary (shown on the card) and a fuller description.'
      : '';
    goal = `Advance this project toward its success criteria. Pick the next UNMET criterion and do real, concrete work toward it — research, draft, build a deliverable, edit code, or propose the change. In your done summary, state which criterion you advanced and whether it is now met.${descHint}\nSuccess criteria:\n${list}`;
  } else {
    const openTasks = (project.tasks || []).filter(t => !t.done).map(t => t.text);
    const focus = openTasks.length ? ` Prioritise the open tasks: ${openTasks.slice(0, 5).join('; ')}.` : '';
    goal = `Make concrete, useful progress on "${project.title}".${focus} Produce something real — don't just plan. Do not re-investigate things already marked done.`;
  }

  const contextText = memoryText;

  // Inject real file tree so the model never guesses paths.
  // Cloud free tiers have tight token/day limits — use a shallow (1-level) tree to save tokens.
  let fileTree = '';
  if (services.config.projectRoot) {
    const anyCloud = services.config.groqKey || services.config.openRouterKey || services.config.openAIKey;
    const depth = anyCloud ? 1 : 2;
    try { fileTree = buildFileTree(services.config.projectRoot, depth); } catch { /* best effort */ }
  }

  log(`▶ ${project.title}  [${project.status}]${specMode ? '  (spec mode)' : ''}`);
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
        criteriaAdvanced: result.criteriaAdvanced || ''
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
  } else if (goalNeedsCloud(args.goal) || args.spec) {
    chain = [...cloudLinks, localLink];     // code task / spec draft → cloud first
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
