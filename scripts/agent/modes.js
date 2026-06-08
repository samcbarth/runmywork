'use strict';

/*
 * Agent action modes.
 * -------------------
 * Every run executes EXACTLY ONE mode. The mode decides three things:
 *   1. which tools the agent can even see  (allowList → registry.loadTools)
 *   2. how its goal is framed              (goalFragment, prepended in run.js)
 *   3. what it must hand off next          (nextMode, recommended by `done`)
 *
 * Modes are classed read | write. Read modes auto-chain run-to-run. Write modes
 * (implementation / revision / deployment) modify project assets and require a
 * single human approval (an `authorize_mode` proposal) before the write phase
 * begins — see run.js gating + tools/propose.js.
 *
 * Tool-gating needs no special plumbing: loadTools(config, allowList) already
 * filters by tool name and runLoop forwards opts.allowList. A mode just lists the
 * tool names it permits. `stage` and `done` are included everywhere (the loop
 * relies on done; stage is harmless). Tools gated by env (shell/github/etc.) are
 * still dropped by their own enabled() check even if listed here.
 */

// Read-only tool surface shared by Discovery / Analysis (research only; the
// `files`/`save_artifact` tools are sandboxed to the work dir, never the project).
const READ_TOOLS = [
  'web_search', 'fetch_url', 'read_file', 'find_in_file',
  'files', 'note', 'save_artifact', 'stage', 'done'
];

// Read tools + propose (proposals are themselves gated in the approval inbox, so
// a read mode that only proposes still changes no asset directly).
const PLAN_TOOLS = [...READ_TOOLS, 'propose'];

// Full write surface for Implementation / Revision.
const WRITE_TOOLS = [
  'read_file', 'find_in_file', 'files', 'write_file', 'verify',
  'git', 'github', 'shell', 'propose', 'note', 'save_artifact', 'stage', 'done'
];

const MODES = {
  discovery: {
    id: 'discovery', label: 'Discovery', klass: 'read',
    allowList: READ_TOOLS, nextMode: 'analysis',
    goalFragment:
      'DISCOVERY MODE (read-only). Gather context only. Read the project spec, ' +
      'context, tasks, linked files and code, and any documentation. Identify what ' +
      'is missing or unclear. Make NO changes and propose nothing — record what you ' +
      'find with the note tool. Finish by calling done with a summary of what you ' +
      'learned and set next_mode to "analysis".',
    promptFragment:
      'You are in DISCOVERY mode. Your only job is to gather and record context. ' +
      'You CANNOT modify any project asset and have no write or propose tools. ' +
      'Read, search, fetch, and note your findings, then call done.'
  },

  analysis: {
    id: 'analysis', label: 'Analysis', klass: 'read',
    allowList: READ_TOOLS, nextMode: 'planning',
    goalFragment:
      'ANALYSIS MODE (read-only). Evaluate the current state against the spec and ' +
      'success criteria. Identify problems, dependencies, risks and opportunities. ' +
      'Produce findings and recommendations with the note/save_artifact tools. Make ' +
      'NO changes. Finish by calling done with your findings and set next_mode to ' +
      '"planning".',
    promptFragment:
      'You are in ANALYSIS mode. Evaluate, do not change. You have no write or ' +
      'propose tools. Record findings and recommendations, then call done.'
  },

  planning: {
    id: 'planning', label: 'Planning', klass: 'read',
    allowList: PLAN_TOOLS, nextMode: 'approval_request',
    goalFragment:
      'PLANNING MODE (no code changes). Turn the objective into a concrete, reviewable ' +
      'plan. Break large work into SMALL tasks (use propose add_tasks, max 6 at a time) ' +
      'and, if the project lacks a clear spec, propose one (propose set_spec). Success ' +
      'criteria MUST be 3-5 items (never more than 5), each specific, observable and ' +
      'verifiable — something the human can check off by looking at the result, not a vague ' +
      'goal. Do NOT edit any file or write code. Finish by calling done summarising the plan ' +
      'and set next_mode to "approval_request".',
    promptFragment:
      'You are in PLANNING mode. You may research and file proposals (add_tasks, ' +
      'set_spec, update_description) but you CANNOT edit files or write code. Decompose ' +
      'big work into small reviewable tasks, then call done.'
  },

  approval_request: {
    id: 'approval_request', label: 'Approval Request', klass: 'read',
    allowList: PLAN_TOOLS, nextMode: 'implementation',
    goalFragment:
      'APPROVAL REQUEST MODE (no code changes). Present the work about to be done for ' +
      'human sign-off. Ensure the concrete tasks are filed (propose add_tasks) and then ' +
      'file ONE propose authorize_mode with mode "implementation" and a short plain-' +
      'language plan of exactly what the implementation phase will change. Do NOT edit ' +
      'any file. Finish by calling done and set next_mode to "implementation".',
    promptFragment:
      'You are in APPROVAL REQUEST mode. You cannot change project assets. Make sure ' +
      'the plan is filed as proposals and file one authorize_mode proposal for the ' +
      'implementation phase, then call done. The human approves in the app inbox.'
  },

  implementation: {
    id: 'implementation', label: 'Implementation', klass: 'write',
    allowList: WRITE_TOOLS, nextMode: 'validation',
    goalFragment:
      'IMPLEMENTATION MODE (writes code). Execute the APPROVED plan and nothing beyond ' +
      'it. Make the real change: read_file to inspect, write_file to edit, verify to ' +
      'check syntax, then git add + git commit. Stay strictly within the approved scope. ' +
      'If you discover the plan was WRONG or the task is BIGGER than expected, STOP — do ' +
      'NOT force a partial or hacky commit. Call done with next_mode "planning" and explain ' +
      'what changed, so the task is re-decomposed and re-approved. Otherwise finish by ' +
      'calling done with what you changed and set next_mode to "validation".',
    promptFragment: null   // use the default executor prompt (with deploy note)
  },

  validation: {
    id: 'validation', label: 'Validation', klass: 'read',
    allowList: ['read_file', 'find_in_file', 'files', 'verify', 'shell', 'note', 'stage', 'done'],
    nextMode: 'deployment',
    goalFragment:
      'VALIDATION MODE (read-only). Test and verify the work just implemented. Run ' +
      'verify on changed files, review outputs, and confirm the success criteria were ' +
      'actually met. Make NO changes. If everything passes, set next_mode to ' +
      '"deployment". If you find failures, document them with note and set next_mode to ' +
      '"revision". Finish by calling done with the validation result.',
    promptFragment:
      'You are in VALIDATION mode. Test and verify only — you have no write tools. ' +
      'Confirm the work meets its criteria, document any failures, then call done with ' +
      'next_mode set to "deployment" (pass) or "revision" (fail).'
  },

  revision: {
    id: 'revision', label: 'Revision', klass: 'write',
    allowList: WRITE_TOOLS, nextMode: 'validation',
    goalFragment:
      'REVISION MODE (writes code). Read the "OPEN CRITERIA NEEDING WORK" block in your ' +
      'context — those are the success criteria the user marked FAILED in review, with ' +
      'their feedback. Fix ONLY those criteria; do NOT touch criteria already marked met ' +
      'and do not add new scope. Apply targeted corrections (read_file → write_file → ' +
      'verify → git commit) that directly address the user feedback. If the fix turns out ' +
      'to need a bigger rethink than a targeted correction, STOP and call done with ' +
      'next_mode "planning" instead of forcing it. Otherwise finish by calling done with ' +
      'what you fixed and set next_mode to "validation" so the fix is re-checked.',
    promptFragment: null
  },

  deployment: {
    id: 'deployment', label: 'Deployment', klass: 'write',
    allowList: ['read_file', 'git', 'verify', 'note', 'stage', 'done'],
    nextMode: 'reporting',
    goalFragment:
      'DEPLOYMENT MODE. The validated change is ready to ship. FIRST run git op:"status". ' +
      'If the tree is CLEAN, the change was already committed and pushed in the ' +
      'implementation phase (each phase runs on a fresh checkout of main) — do NOT try to ' +
      'add or commit; just run git op:"log" to confirm the change is present and call done. ' +
      'Only if status shows uncommitted changes should you git add + git commit. The ' +
      'workflow pushes and verifies automatically — you never push yourself. Finish by ' +
      'calling done and set next_mode to "reporting".',
    promptFragment:
      'You are in DEPLOYMENT mode. Check git status first. A clean tree means the work is ' +
      'already committed and shipped — confirm with git log and call done; do not attempt ' +
      'another commit (there is nothing to stage). Only commit if status shows real changes.'
  },

  reporting: {
    id: 'reporting', label: 'Reporting', klass: 'read',
    allowList: ['read_file', 'files', 'note', 'stage', 'done'],
    nextMode: 'discovery',
    goalFragment:
      'REPORTING MODE (read-only). Summarise what the flow accomplished: actions taken, ' +
      'results, blockers, and lessons. Recommend what should happen next. Make NO ' +
      'changes. Finish by calling done with the report and set next_mode to "discovery" ' +
      '(to start the next objective) — or note that the objective is complete.',
    promptFragment:
      'You are in REPORTING mode. Summarise outcomes and recommend next steps. You have ' +
      'no write tools. Call done with your report.'
  }
};

const ORDER = [
  'discovery', 'analysis', 'planning', 'approval_request',
  'implementation', 'validation', 'revision', 'deployment', 'reporting'
];

// Worker specialties — the orchestrator (run.js) classifies the focus item and
// has the agent act as the matching specialist for this run. This realises the
// orchestrator→specialist-worker pattern inside the single-process mode system:
// the mode still gates which tools exist; the specialty shapes WHAT to prioritise.
const WORKER_SPECIALTIES = {
  ui: {
    id: 'ui', label: 'UI',
    match: /\b(ui|ux|button|css|style|styles|layout|screen|page|view|render|component|color|colour|font|responsive|modal|form|design|frontend|front-end)\b/i,
    guidance: 'Act as the UI specialist. Focus on the user-facing change — markup, styles, layout, what the user actually sees and clicks. Keep changes accessible and consistent with existing styles. After editing, set visual_summary to describe what the change looks like and where it appears.'
  },
  backend: {
    id: 'backend', label: 'Backend',
    match: /\b(api|endpoint|server|backend|back-end|database|schema|sql|query|migration|auth|token|webhook|integration|data model|state)\b/i,
    guidance: 'Act as the Backend specialist. Focus on data and logic — endpoints, schema, queries, state, integrations. Preserve existing contracts and callers; do not break the API. Validate inputs and handle errors.'
  },
  testing: {
    id: 'testing', label: 'Testing',
    match: /\b(test|tests|testing|spec|coverage|verify|verification|assert|regression|qa|lint)\b/i,
    guidance: 'Act as the Testing specialist. Focus on verification — run and/or add checks, confirm the behaviour against the success criteria, and report pass/fail precisely with evidence.'
  },
  documentation: {
    id: 'documentation', label: 'Documentation',
    match: /\b(doc|docs|documentation|readme|comment|comments|changelog|guide|instructions|wiki|annotate)\b/i,
    guidance: 'Act as the Documentation specialist. Focus on clear, accurate docs/comments/changelog that match the actual code. Use today\'s real date for any dated entries. Do not change behaviour.'
  },
  research: {
    id: 'research', label: 'Research',
    match: /\b(research|investigate|explore|compare|evaluate|find out|figure out|spike|options|approach|feasibility)\b/i,
    guidance: 'Act as the Research specialist. Investigate and gather context — read, search, fetch, and record findings with note/save_artifact. Recommend a concrete next step; do not change project assets.'
  }
};

// Classify a focus item / goal text into a worker specialty. Returns null for
// general work (no specialist persona needed).
function classifyWorker(text) {
  const s = String(text || '');
  for (const id of ['testing', 'documentation', 'ui', 'backend', 'research']) {
    if (WORKER_SPECIALTIES[id].match.test(s)) return WORKER_SPECIALTIES[id];
  }
  return null;
}

function getMode(id) {
  return MODES[id] || null;
}

function isWrite(id) {
  const m = MODES[id];
  return Boolean(m && m.klass === 'write');
}

// Where a fresh objective starts. A project with no spec yet should begin at
// discovery; one that already has a spec can skip straight to planning. Either
// way the chain runs read-only until the write gate.
function defaultStartMode(spec) {
  if (spec && spec.hasGoal) return 'planning';
  return 'discovery';
}

module.exports = { MODES, ORDER, getMode, isWrite, defaultStartMode, READ_TOOLS, PLAN_TOOLS, WRITE_TOOLS, WORKER_SPECIALTIES, classifyWorker };
