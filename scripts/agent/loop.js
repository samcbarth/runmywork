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
const { verifyFile } = require('./tools/verify');

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
    case 'web_search':    return `searched: ${trunc(a.query, 60)}`;
    case 'fetch_url':     return `read: ${trunc(a.url, 70)}`;
    case 'files':         return `file ${a.op || ''} ${trunc(a.path, 40)}`.trim();
    case 'read_file':     return `read: ${trunc(a.path, 50)} (${a.op || 'read'})`;
    case 'find_in_file':  return `found: ${trunc(a.search, 40)} in ${trunc(a.path, 30)}`;
    case 'write_file':    return `wrote: ${trunc(a.path, 45)} (${a.op || 'patch'})`;
    case 'git':           return `git ${a.op || ''}${a.message ? `: ${trunc(a.message, 40)}` : ''}`;
    case 'save_artifact': return `saved: ${trunc(a.filename || a.summary, 50)}`;
    case 'propose':       return `proposed: ${a.action || ''}`.trim();
    case 'note':          return `noted: ${trunc(a.summary, 60)}`;
    case 'delegate':      return `delegated: ${trunc(a.goal, 55)}`;
    case 'done':          return 'finished';
    default:             return name;
  }
}

// Map each tool to the lifecycle stage it represents, so the tracker advances
// from real tool activity even when the model never calls stage() itself. The
// agent only drives the first three stages (planning/editing/testing); the
// remaining four (pushed/deploying/live_verified/complete) are driven by
// deploy-verify.js after the agent process exits.
const TOOL_STAGE_MAP = {
  web_search: 'planning', fetch_url: 'planning', read_file: 'planning',
  find_in_file: 'planning', files: 'planning', note: 'planning',
  save_artifact: 'planning', delegate: 'planning',
  write_file: 'editing', git: 'editing', shell: 'editing', github: 'editing',
  verify: 'testing',
  propose: 'testing'
};
// Full lifecycle order — percent is index-based against all 7 so the in-loop
// stages (planning..testing) leave room for the post-agent deploy stages.
const STAGE_ORDER = ['planning', 'editing', 'testing', 'pushed', 'deploying', 'live_verified', 'complete'];

// Move the tracker stage forward (never backward) based on the tool just run.
async function autoAdvanceStage(ctx, toolName) {
  if (!ctx.run) return;
  const inferred = TOOL_STAGE_MAP[toolName];
  if (!inferred) return;
  const curIdx = STAGE_ORDER.indexOf(ctx.currentStage);
  const newIdx = STAGE_ORDER.indexOf(inferred);
  if (newIdx <= curIdx) return;
  ctx.currentStage = inferred;
  const pct = Math.round(((newIdx + 1) / STAGE_ORDER.length) * 100);
  ctx.run.percent = Math.max(ctx.run.percent || 0, pct);
  ctx.run.stages = ctx.run.stages || [];
  ctx.run.stages.push({ stage: inferred, enteredAt: Date.now(), note: `auto:${toolName}` });
  try {
    await ctx.sb.updateRun(ctx.run.id, {
      stage: inferred, percent: ctx.run.percent, stages: ctx.run.stages
    });
  } catch { /* tracker is best-effort */ }
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
  const hasProjectRoot = Boolean(config && config.projectRoot);
  const canWrite       = hasProjectRoot && (config.allowFileWrite);
  const canCommit      = canWrite && config.allowGitWrite;

  const execBlock = hasProjectRoot ? `
REAL PROJECT FILES ARE ACCESSIBLE. Execution rules (strict):
1. Use read_file op list to confirm the exact path before touching any file.
2. Use read_file op read to see the file content.
3. Use find_in_file to get the EXACT text block you want to replace — never type old_string from memory.
4. Use write_file op patch with the exact_match from find_in_file as old_string.
5. If write_file returns "old_string not found", call find_in_file again with a different search term.
6. After writing code, call verify on the file to confirm it has no syntax errors. Fix any errors before continuing.
7. Then use git op add and git op commit with a clear message describing what changed.
8. Never commit .env files or secrets.
` : '';

  // The tracker advances automatically from real tool usage (see autoAdvanceStage),
  // so the prompt no longer needs to force stage() calls. Keep it Groq-safe: quoting
  // tool names with parens makes Groq/llama misfire into XML hermes format.
  const deployNote = hasProjectRoot
    ? ' After you finish, the system automatically pushes your commit, deploys it to the live site, and verifies the change is actually live — so committing is NOT the finish line. A code change only counts once it is deployed and visible live; if it does not deploy, the run is not complete.'
    : '';
  const progressNote = `Work step by step through your phases: planning → editing → testing.${deployNote} Finish by calling done with an honest summary of what you changed and, for any UI change, what it now looks like and where it appears on the page.`;

  return `You are an autonomous work agent inside RunMyWork, a personal project hub.
You are given ONE project and a goal. Make real progress using the available tools, then stop.

Rules:
- You are a WORKER, not an advisor. Do the work — never write prose about what
  someone should do. If you catch yourself writing "I will…" or "I recommend…",
  stop and call a tool instead. Suggestions are only acceptable when the work is
  genuinely BLOCKED (missing access, external dependency); otherwise, act.
- Each step: pick ONE concrete action, call ONE tool, read the result, then pick
  the next action. Keep going until the criterion is actually advanced.
- The PROJECT SPEC (goal + success criteria) is your north star. Every run should move
  at least one success criterion closer to met. If the project has no spec yet, your job
  is to research it and propose one (action set_spec).
- Record findings with the note tool so they persist for next time.
- Save research and drafts with the save_artifact tool.
${hasProjectRoot ? `- A REAL CODE REPOSITORY is connected. Prefer concrete execution over talk: when a
  criterion needs a code change, use read_file → write_file → verify → git add → git commit
  to actually make it. Do NOT substitute a markdown draft (save_artifact) or an add_tasks
  proposal for doing the work. Do the implementation YOURSELF — do not delegate it to a
  sub-agent. A criterion is only "advanced" when a real change is committed.
` : ''}${execBlock}
Project state changes (tasks, status, priority) require human approval. Use the propose tool
to file a proposal — never apply state changes directly.

${progressNote}

Project: "${project ? project.title : '(board-level)'}".`;
}

function buildUserPrompt(goal, project, contextText) {
  const lines = [];
  // SPEC + memory lead (contextText starts with the authoritative PROJECT SPEC), so the
  // spec frames everything before the model even sees the mutable project state.
  if (contextText) { lines.push('CONTEXT & MEMORY', contextText, ''); }
  if (project) {
    lines.push(`PROJECT STATE`);
    lines.push(`Title: ${project.title}`);
    if (project.summary) lines.push(`Summary: ${project.summary}`);
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
    changedFiles: [],     // real project files written by write_file tool
    committed: false,     // set true by git commit (reality check)
    criteriaAdvanced: '', // set by done tool (which success criterion advanced)
    done: false,
    doneSummary: '',
    visualSummary: '', // set by done tool — what a UI change looks like + where
    currentStage: 'planning',
    run: null,        // agent_runs row (top-level project loops only)
    tools,
    runLoop          // delegate uses this to spawn sub-loops
  };
  ensureDir(ctx.workDir);

  // Only the top loop on a real project owns a tracker run. Best-effort: if the
  // table/insert fails, ctx.run stays null and the loop runs exactly as before.
  if (depth === 0 && project) {
    try {
      ctx.run = await sb.createRun(project.id);
      if (!ctx.run) log('  ⚠ tracker: createRun returned null — tracker will be silent this run');
    } catch (e) {
      log(`  ⚠ tracker: createRun threw: ${e.message} — tracker will be silent this run`);
      ctx.run = null;
    }
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
  let stalled = false;
  const callCounts = new Map();   // repetition guard: identical tool+args signature → count

  while (steps < budget && !ctx.done && !stalled) {
    steps++;
    let resp;
    try {
      resp = await ollama.chat(messages, schemas, { model });
    } catch (e) {
      log(`  ${'·'.repeat(depth + 1)} model error: ${e.message}`);
      modelErrored = true;
      if (depth === 0) {
        await sb.logError({
          projectId: project && project.id,
          runId: ctx.run && ctx.run.id,
          stepNumber: steps,
          errorMessage: `Model error: ${e.message}`,
          errorStack: e.stack,
          toolName: null
        });
      }
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

      // Repetition guard: the same tool+args repeated isn't working. Nudge at 3,
      // break at 5 so a stuck model can't burn the whole budget on one dead action.
      if (name !== 'done' && name !== 'stage') {
        const sig = `${name}:${JSON.stringify(args)}`;
        const n = (callCounts.get(sig) || 0) + 1;
        callCounts.set(sig, n);
        if (n >= 5) {
          // Push a synthetic tool response before breaking so message history stays valid.
          messages.push({ role: 'tool', content: JSON.stringify({ error: 'repetition stall — aborting' }), tool_name: name });
          if (depth === 0) {
            await sb.logError({
              projectId: project && project.id, runId: ctx.run && ctx.run.id,
              stepNumber: steps, toolName: name,
              errorMessage: `Repetition stall: "${name}" called ${n}× with identical args — aborting run.`
            });
          }
          stalled = true;
          break;
        }
        if (n === 3) {
          // Push a synthetic tool response FIRST — OpenAI requires every tool_call_id
          // to have a matching tool message before the next user/assistant turn.
          messages.push({ role: 'tool', content: JSON.stringify({ skipped: true, note: 'identical call repeated — try a different approach' }), tool_name: name });
          messages.push({ role: 'user', content: `You've called ${name} with the same arguments 3 times and it isn't working. Stop repeating it — try a different approach, a different tool, or call done.` });
          continue;
        }
      }

      let result;
      try {
        result = await dispatch(ctx.tools, name, args, ctx);
      } catch (e) {
        result = JSON.stringify({ error: e.message });
        if (depth === 0) {
          await sb.logError({
            projectId: project && project.id,
            runId: ctx.run && ctx.run.id,
            stepNumber: steps,
            errorMessage: `Tool "${name}" threw: ${e.message}`,
            errorStack: e.stack,
            toolName: name
          });
        }
      }
      // On done, run two self-correction gates (top-level project loops only):
      if (name === 'done' && ctx.done && depth === 0) {
        // Gate 1 — goal asked for a code change but nothing was written.
        const goalAsksForWrite = /patch|edit|write|modify|change|update|add.*line|remove.*line|wire up/i.test(opts.goal || '');
        const didWrite = (ctx.changedFiles || []).length > 0;
        if (goalAsksForWrite && !didWrite && steps < budget - 1) {
          ctx.done = false;
          messages.push({ role: 'user', content: 'You called done but the goal required a file edit and no files were changed. Use write_file to make the change now, then call done again.' });
          continue;
        }

        // Gate 2 — verify changed code is syntactically valid. Block done + force a fix.
        const root = config.projectRoot;
        if (root && didWrite && steps < budget - 1) {
          const broken = [];
          for (const f of ctx.changedFiles) {
            try {
              const v = verifyFile(root, f.path);
              if (!v.ok) broken.push(`${f.path}${v.line ? ` (line ${v.line})` : ''}: ${v.error}`);
            } catch { /* skip unverifiable */ }
          }
          if (broken.length) {
            ctx.done = false;
            if (depth === 0) {
              await sb.logError({
                projectId: project && project.id, runId: ctx.run && ctx.run.id,
                stepNumber: steps, toolName: 'verify',
                errorMessage: `Verify gate rejected done — syntax errors:\n${broken.join('\n')}`
              });
            }
            messages.push({ role: 'user', content: `You called done but the file(s) you changed have syntax errors:\n${broken.join('\n')}\nFix them with write_file, run verify to confirm, then call done again.` });
            continue;
          }
        }
      }

      messages.push({ role: 'tool', content: result, tool_name: name });

      // feed the tracker (the `stage` tool updates stage/percent itself)
      if (name !== 'stage') {
        const errored = typeof result === 'string' && result.includes('"error"');
        await pushRunLog(`${describeCall(name, args)}${errored ? ' — error' : ''}`);
        // Auto-advance the tracker stage from what the agent actually did. The
        // model rarely calls stage() on its own, so the bar would otherwise sit
        // at "look" the whole run. Stage only moves FORWARD (max of current/new).
        await autoAdvanceStage(ctx, name);
      }

      // build_tool may have grown the toolset
      if (name === 'build_tool') schemas = ctx.reloadTools();
      if (ctx.done) break;
    }
  }

  // log budget exhaustion (agent ran out of steps without calling done)
  if (!ctx.done && !modelErrored && !stalled && depth === 0 && project) {
    await sb.logError({
      projectId: project.id,
      runId: ctx.run && ctx.run.id,
      stepNumber: steps,
      errorMessage: `Budget exhausted after ${steps} steps without calling done`,
      errorStack: null,
      toolName: null
    });
  }

  // Reality check (anti-hallucination): if the summary implies file/commit changes
  // but none were actually recorded, correct the summary and log the mismatch.
  if (depth === 0 && project) {
    const claimsChange = /\b(wrote|edited|patched|committed|updated the file|added.*to|changed.*file|implemented|fixed)\b/i.test(ctx.doneSummary || '');
    const reallyChanged = (ctx.changedFiles || []).length > 0 || ctx.committed;
    if (claimsChange && !reallyChanged) {
      ctx.doneSummary = `${ctx.doneSummary}\n(note: no file changes were actually recorded this run.)`;
      try {
        await sb.logError({
          projectId: project.id, runId: ctx.run && ctx.run.id, stepNumber: steps, toolName: null,
          errorMessage: `Summary/reality mismatch — model claimed a change but no files changed and nothing was committed.`
        });
      } catch { /* best effort */ }
    }
  }

  // finalize the tracker run
  if (ctx.run) {
    const finishedClean = ctx.done;
    // If the agent committed code, the run is NOT complete yet — the workflow
    // still has to push to main, let GitHub Pages deploy, and verify the change
    // is actually live. Hand the run off in the "testing" stage with status
    // still running; deploy-verify.js drives it to live_verified → complete.
    const handingOff = ctx.committed && finishedClean && !modelErrored;
    try {
      if (handingOff) {
        await sb.updateRun(ctx.run.id, {
          status: 'running',
          stage: 'testing',
          percent: Math.max(ctx.run.percent || 0, Math.round((3 / 7) * 100)),
          summary: (ctx.doneSummary || '').slice(0, 1000)
          // no ended_at — the run is still in flight (deploy + live verify pending)
        });
      } else {
        await sb.updateRun(ctx.run.id, {
          status: modelErrored ? 'failed' : 'done',
          stage: modelErrored ? ctx.currentStage : (finishedClean ? 'complete' : ctx.currentStage),
          percent: finishedClean && !modelErrored ? 100 : (ctx.run.percent || 0),
          summary: (ctx.doneSummary || '').slice(0, 1000),
          ended_at: Date.now()
        });
      }
    } catch { /* best effort */ }
  }

  return {
    steps,
    summary: ctx.doneSummary || '(no summary)',
    proposals: ctx.proposals,
    artifacts: ctx.artifacts,
    findings: ctx.findings,
    changedFiles: ctx.changedFiles || [],
    committed: Boolean(ctx.committed),
    criteriaAdvanced: ctx.criteriaAdvanced || '',
    visualSummary: ctx.visualSummary || '',
    runId: ctx.run && ctx.run.id
  };
}

module.exports = { runLoop, WORK };
