'use strict';

/*
 * The gated bridge from autonomous work → tracked project state.
 * --------------------------------------------------------------
 * This is the ONLY tool that can change a project. It never applies anything; it
 * files a `pending` approval that the human approves in the app's inbox. The
 * action_type + payload shapes match exactly what js/views/approvals.js knows how
 * to apply: add_tasks | set_status | set_priority | add_link.
 *
 * Repeated runs dedup against existing pending proposals so the inbox never fills
 * with duplicates.
 */

const STATUSES = ['active', 'blocked', 'idle', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];

function buildPayload(action, args) {
  switch (action) {
    case 'add_tasks': {
      const tasks = (Array.isArray(args.tasks) ? args.tasks : [])
        .map(t => String(t || '').trim()).filter(Boolean).slice(0, 6);
      if (!tasks.length) throw new Error('add_tasks needs a non-empty "tasks" array of strings');
      return { tasks };
    }
    case 'set_status': {
      const status = String(args.status || '').toLowerCase().trim();
      if (!STATUSES.includes(status)) throw new Error(`set_status "status" must be one of ${STATUSES.join('|')}`);
      return { status, note: (args.note || 'Agent-proposed').slice(0, 200) };
    }
    case 'set_priority': {
      const priority = String(args.priority || '').toLowerCase().trim();
      if (!PRIORITIES.includes(priority)) throw new Error(`set_priority "priority" must be one of ${PRIORITIES.join('|')}`);
      return { priority };
    }
    case 'add_link': {
      const url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('add_link needs a valid http(s) "url"');
      return { url, label: (args.label || url).slice(0, 120) };
    }
    case 'set_spec': {
      const goal = String(args.goal || '').trim();
      if (!goal) throw new Error('set_spec needs a non-empty "goal" string');
      const list = (v) => (Array.isArray(v) ? v : [])
        .map(s => String(s || '').trim()).filter(Boolean).slice(0, 8);
      const successCriteria = list(args.successCriteria);
      if (!successCriteria.length) throw new Error('set_spec needs at least one "successCriteria" item');
      return {
        goal: goal.slice(0, 600),
        requirements:    list(args.requirements),
        successCriteria,
        constraints:     list(args.constraints)
      };
    }
    case 'update_description': {
      const description = String(args.description || '').trim();
      const summary     = String(args.summary || '').trim();
      if (!description && !summary) throw new Error('update_description needs description and/or summary');
      return { description: description.slice(0, 2000), summary: summary.slice(0, 200) };
    }
    case 'mark_criterion_done': {
      const criterion = String(args.criterion || '').trim();
      if (!criterion) throw new Error('mark_criterion_done needs a criterion string');
      return {
        criterion: criterion.slice(0, 400),
        evidence:  String(args.evidence || '').trim().slice(0, 800)
      };
    }
    case 'mark_task_done': {
      const taskText = String(args.task_text || '').trim();
      if (!taskText) throw new Error('mark_task_done needs "task_text" (the open task to mark done)');
      return {
        task_text: taskText.slice(0, 200),
        note:      String(args.note || '').trim().slice(0, 400)
      };
    }
    default:
      throw new Error(`unknown action "${action}". Use add_tasks | set_status | set_priority | add_link | set_spec | update_description | mark_criterion_done | mark_task_done`);
  }
}

// Is an equivalent proposal already pending? (avoid duplicate inbox spam)
function alreadyPending(pending, action, payload) {
  return pending.some(a => {
    if (a.action_type !== action) return false;
    const p = a.payload || {};
    if (action === 'set_status') return p.status === payload.status;
    if (action === 'set_priority') return p.priority === payload.priority;
    if (action === 'add_link') return p.url === payload.url;
    if (action === 'add_tasks') return true;          // one pending add_tasks batch is enough
    if (action === 'set_spec') return true;           // one pending spec proposal is enough
    if (action === 'update_description') return true; // one pending description update at a time
    if (action === 'mark_criterion_done') return p.criterion === payload.criterion; // dedupe by criterion text
    if (action === 'mark_task_done') return p.task_text === payload.task_text; // dedupe by task text
    return false;
  });
}

module.exports = {
  name: 'propose',
  description: 'Propose a change to the project that the human approves in the app. This is the ONLY way to change tracked state. action is one of: add_tasks (args.tasks: string[]), set_status (args.status: active|blocked|idle|done), set_priority (args.priority: low|medium|high), add_link (args.url, args.label), set_spec (args.goal, args.requirements[], args.successCriteria[], args.constraints[] — defines the project goal + measurable success criteria), update_description (args.description: full description, args.summary: 1-2 sentence tagline for cards — updates how the project describes itself), mark_criterion_done (args.criterion: exact criterion text, args.evidence: what you did to meet it — file a completion claim for a success criterion), mark_task_done (args.task_text: exact text of an open task you finished, args.note: what you did — marks that task complete). Always include a clear rationale.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add_tasks', 'set_status', 'set_priority', 'add_link', 'set_spec', 'update_description', 'mark_criterion_done', 'mark_task_done'] },
      rationale: { type: 'string', description: 'Why this change — shown to the human in the approval.' },
      tasks: { type: 'array', items: { type: 'string' }, description: 'For add_tasks.' },
      status: { type: 'string', description: 'For set_status.' },
      priority: { type: 'string', description: 'For set_priority.' },
      url: { type: 'string', description: 'For add_link.' },
      label: { type: 'string', description: 'For add_link.' },
      note: { type: 'string', description: 'Optional note for set_status.' },
      goal: { type: 'string', description: 'For set_spec: one-sentence project goal.' },
      requirements: { type: 'array', items: { type: 'string' }, description: 'For set_spec: key requirements.' },
      successCriteria: { type: 'array', items: { type: 'string' }, description: 'For set_spec: 3-6 measurable, checkable success criteria.' },
      constraints: { type: 'array', items: { type: 'string' }, description: 'For set_spec: constraints/boundaries.' },
      description: { type: 'string', description: 'For update_description: full project description (up to 2000 chars).' },
      summary: { type: 'string', description: 'For update_description: 1-2 sentence tagline shown on cards (up to 200 chars).' },
      criterion: { type: 'string', description: 'For mark_criterion_done: exact text of the success criterion being claimed done.' },
      evidence: { type: 'string', description: 'For mark_criterion_done: what was done/found to meet this criterion.' },
      task_text: { type: 'string', description: 'For mark_task_done: exact text of the open task you completed.' },
      project_id: { type: 'string', description: 'Board-planner mode only: which project to target. Omit when working a single project.' }
    },
    required: ['action', 'rationale']
  },
  async run(args, ctx) {
    // Per-project mode: target is the loop's project. Board-planner mode
    // (ctx.project is null): caller names the project via project_id.
    const target = ctx.project || (ctx.boardProjects || []).find(p => p.id === args.project_id);
    if (!target) {
      return { error: ctx.boardProjects ? 'at board level, propose requires a valid project_id' : 'propose needs a project context' };
    }
    const action = String(args.action || '').trim();
    let payload;
    try { payload = buildPayload(action, args); }
    catch (e) { return { error: e.message }; }

    const pending = await ctx.sb.pendingApprovals(target.id);
    if (alreadyPending(pending, action, payload)) {
      return { ok: true, skipped: 'an equivalent proposal is already pending' };
    }

    const rationale = (args.rationale || '').slice(0, 400);
    await ctx.sb.createApproval({
      project_id: target.id,
      action_type: action,
      payload,
      rationale
    });
    await ctx.sb.addWorklog({
      project_id: target.id,
      kind: 'proposal',
      summary: rationale || `Proposed ${action}`,
      detail: { action_type: action, payload },
      created_by: 'agent'
    });

    const desc = action === 'add_tasks' ? `add ${payload.tasks.length} task(s)`
      : action === 'set_status' ? `status → ${payload.status}`
      : action === 'set_priority' ? `priority → ${payload.priority}`
      : action === 'set_spec' ? `spec (${payload.successCriteria.length} criteria)`
      : action === 'update_description' ? `update description/summary`
      : action === 'mark_criterion_done' ? `criterion done: "${(payload.criterion || '').slice(0, 50)}"`
      : action === 'mark_task_done' ? `task done: "${(payload.task_text || '').slice(0, 50)}"`
      : `link ${payload.label}`;
    ctx.proposals.push(desc);
    return { ok: true, proposed: desc, note: 'Filed for human approval in the app inbox.' };
  }
};
