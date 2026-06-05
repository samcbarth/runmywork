'use strict';

/*
 * The agent loop (ReAct).
 * -----------------------
 * Same shape as Claude Code's solve loop: ask the model, run whatever tools it
 * calls, feed the results back, repeat until it calls `done` or the step budget
 * runs out. One loop works one goal (usually "advance this project").
 *
 * Autonomy boundary: the loop researches, fetches, drafts and writes files in
 * its sandbox freely. It CANNOT change the project's tracked state directly —
 * the only path to that is the `propose` tool, which files a gated approval the
 * human applies in the app. Enforced by which tools exist, not by trust.
 */

const fs = require('fs');
const path = require('path');
const { loadTools, toSchemas, dispatch } = require('./registry');

const WORK = path.join(__dirname, 'work');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function preview(args) {
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  } catch { return ''; }
}

function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// Human-readable "what the agent referenced" for the tracker log, so the user can
// see the actual query/URL/file behind each step — not just the tool name.
function describeCall(name, args) {
  const a = args || {};
  switch (name) {
    case 'web_search':   return `searched: ${trunc(a.query, 60)}`;
    case 'fetch_url':    return `read: ${trunc(a.url, 70)}`;
    case 'files':        return `file ${a.op || ''} ${trunc(a.path, 40)}`.trim();
    case 'save_artifact':return `saved: ${trunc(a.filename || a.summary, 50)}`;
    case 'propose':      return `proposed: ${a.action || ''}`.trim();
    case 'note':         return `noted: ${trunc(a.summary, 60)}`;
    case 'delegate':     return `delegated: ${trunc(a.goal, 55)}`;
    case 'done':         return 'finished';
    default:             return name;
  }
}

function boardSystemPrompt() {
  return `You are the planning agent inside RunMyWork, a personal project hub. You see
the WHOLE board — every open project — and your job is to decide where effort
should go next, not to do the work inside any one project.

How you work:
- Read the board snapshot you are given (status, priority, idle time, open tasks).
- Optionally web_search / fetch_url for context if a decision needs it.
- Pick the few projects that most need attention and say why.
- File concrete, gated proposals with "propose" — pass project_id to target a
  specific project: bump set_priority on what should be focused, set_status to
  un-idle a project that has a clear next step, add_tasks for the obvious next move.
- Save the ranked focus plan with "save_artifact" (filename "focus-plan.md") so it
  is kept.
- You may NOT apply anything directly — every proposal is approved by the human.
- Finish with "done" summarising the focus order and what you proposed.`;
}

function systemPrompt(project, config) {
  return `You are an autonomous work agent inside RunMyWork, a personal project hub.
You are given ONE project and a goal. Make real progress on it using your tools,
then stop.

How you work:
- Think in small steps. Each turn, either call a tool or finish.
- Use tools to actually do the work: search the web, read pages, draft documents,
  write files in your sandbox, run allowed commands. Don't just describe what could
  be done — do it.
- You may delegate a focused sub-task to a sub-agent with the "delegate" tool.
- Record useful findings with "note" so they persist as memory for next time.
- Save real deliverables (drafts, research, code) with "save_artifact".

Hard rule — you may NOT change the project's tracked state yourself. To add tasks,
change status/priority, or attach a link, you MUST call "propose". That files a
proposal the human approves in the app. Proposing is how your work lands; do it for
every concrete change you want made.

Show your progress — the user watches a live tracker. As you work, call the "stage"
tool to mark which phase you are in, moving forward through:
  look (gather info, read the project context) → think (analyze, plan) →
  do (produce the work / propose changes) → review (check your results) →
  revise (fix anything wrong) → report (summarise). Call "stage" each time you move on.

Finish by calling "done" with a short summary of what you accomplished and what you
proposed. Be concrete and honest — if you got blocked, say what blocked you.

You are working on project: "${project ? project.title : '(board-level)'}".`;
}

function buildUserPrompt(goal, project, contextText) {
  const lines = [];
  if (project) {
    lines.push(`PROJECT STATE`);
    lines.push(`Title: ${project.title}`);
    if (project.description) lines.push(`Description: ${project.description}`);
    lines.push(`Status: ${project.status}  Priority: ${project.priority}`);
    if (project.tags?.length) lines.push(`Tags: ${project.tags.join(', ')}`);
    if (project.status === 'blocked' && project.blockedReason) lines.push(`Blocked by: ${project.blockedReason}`);
    const open = (project.tasks || []).filter(t => !t.done).map(t => t.text);
    const done = (project.tasks || []).filter(t => t.done).map(t => t.text);
    if (open.length) lines.push(`Open tasks:\n- ${open.join('\n- ')}`);
    if (done.length) lines.push(`(${done.length} task(s) already completed — do not work on those.)`);
    if (project.links?.length) lines.push(`Links: ${project.links.map(l => l.url).join(', ')}`);
  }
  if (contextText) { lines.push('', 'CONTEXT & MEMORY', contextText); }
  lines.push('', `GOAL`, goal);
  return lines.join('\n');
}

async function runLoop(opts) {
  const { services } = opts;
  const { sb, ollama, config, log } = services;
  const project = opts.project || null;
  const depth = opts.depth || 0;
  const budget = opts.budget || config.budget;
  // top loop + board planning use the planner model; delegated children pass the
  // worker model explicitly (see tools/delegate.js).
  const model = opts.model || config.plannerModel;

  const tools = loadTools(config, opts.allowList);

  const ctx = {
    services, sb, ollama, config, log,
    project, depth,
    boardProjects: opts.boardProjects || null,   // set in board-planner mode so propose can target by id
    workDir: path.join(WORK, project ? project.id : '_board'),
    proposals: [],
    artifacts: [],
    findings: [],
    done: false,
    doneSummary: '',
    currentStage: 'look',
    run: null,        // agent_runs row (top-level project loops only)
    tools,
    runLoop          // delegate uses this to spawn sub-loops
  };
  ensureDir(ctx.workDir);

  // Only the top loop on a real project owns a tracker run. Best-effort: if the
  // table/insert fails, ctx.run stays null and the loop runs exactly as before.
  if (depth === 0 && project) {
    try { ctx.run = await sb.createRun(project.id); } catch { ctx.run = null; }
  }
  const runLog = [];
  async function pushRunLog(line) {
    if (!ctx.run) return;
    runLog.push({ stage: ctx.currentStage, t: Date.now(), line });
    if (runLog.length > 60) runLog.splice(0, runLog.length - 60);
    try { await sb.updateRun(ctx.run.id, { log: runLog.slice() }); } catch { /* best effort */ }
  }

  // build_tool can add files; expose a reload so the new tool is callable same run
  ctx.reloadTools = () => {
    const fresh = loadTools(config, opts.allowList);
    for (const [k, v] of fresh) ctx.tools.set(k, v);
    return toSchemas(ctx.tools);
  };

  const messages = [
    { role: 'system', content: project ? systemPrompt(project, config) : boardSystemPrompt() },
    { role: 'user', content: buildUserPrompt(opts.goal, project, opts.contextText) }
  ];

  let schemas = toSchemas(ctx.tools);
  let steps = 0;
  let modelErrored = false;

  while (steps < budget && !ctx.done) {
    steps++;
    let resp;
    try {
      resp = await ollama.chat(messages, schemas, { model });
    } catch (e) {
      log(`  ${'·'.repeat(depth + 1)} model error: ${e.message}`);
      modelErrored = true;
      break;
    }

    messages.push({ role: 'assistant', content: resp.content, tool_calls: resp.tool_calls });

    if (!resp.tool_calls.length) {
      // No tool call: model is talking, not acting. Nudge once, then accept as final.
      if (resp.content && !ctx.doneSummary) ctx.doneSummary = resp.content;
      if (steps < budget) {
        messages.push({ role: 'user', content: 'Continue with a tool call, or call "done" if finished.' });
        continue;
      }
      break;
    }

    for (const tc of resp.tool_calls) {
      const fn = tc.function || tc;
      const name = fn.name;
      let args = fn.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }

      log(`  ${'·'.repeat(depth + 1)} ${name}(${preview(args)})`);
      const result = await dispatch(ctx.tools, name, args, ctx);
      messages.push({ role: 'tool', content: result, tool_name: name });

      // feed the tracker (the `stage` tool updates stage/percent itself)
      if (name !== 'stage') {
        const errored = typeof result === 'string' && result.includes('"error"');
        await pushRunLog(`${describeCall(name, args)}${errored ? ' — error' : ''}`);
      }

      // build_tool may have grown the toolset
      if (name === 'build_tool') schemas = ctx.reloadTools();
      if (ctx.done) break;
    }
  }

  // finalize the tracker run
  if (ctx.run) {
    const finishedClean = ctx.done;
    try {
      await sb.updateRun(ctx.run.id, {
        status: modelErrored ? 'failed' : 'done',
        stage: finishedClean ? 'report' : ctx.currentStage,
        percent: finishedClean ? 100 : (ctx.run.percent || 0),
        summary: (ctx.doneSummary || '').slice(0, 1000),
        ended_at: Date.now()
      });
    } catch { /* best effort */ }
  }

  return {
    steps,
    summary: ctx.doneSummary || '(no summary)',
    proposals: ctx.proposals,
    artifacts: ctx.artifacts,
    findings: ctx.findings
  };
}

module.exports = { runLoop, WORK };
