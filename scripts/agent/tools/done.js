'use strict';

module.exports = {
  name: 'done',
  description: 'Finish the task. Call this when you have made the progress you can. Provide a short, honest summary of what you accomplished, what you proposed, and anything that blocked you. If the project has success criteria, set criteria_advanced to name the criterion you moved forward and whether it is now met. If you changed any UI, set visual_summary to describe what the change looks like now and WHERE on the page it appears (which view/section, what the user sees) — be concrete. This run executes ONE action mode; as your closing report set next_mode to the mode that should run next (one of: discovery, analysis, planning, approval_request, implementation, validation, revision, deployment, reporting) and next_rationale to one line on why.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Concise summary of what was done and proposed.' },
      criteria_advanced: { type: 'string', description: 'Which success criterion you advanced this run, and whether it is now met. Empty if none.' },
      visual_summary: { type: 'string', description: 'For UI changes: what the change looks like now and where it appears on the page (view, section, layout, fields, buttons, empty/loading states). Empty if no visible change.' },
      next_mode: { type: 'string', enum: ['discovery', 'analysis', 'planning', 'approval_request', 'implementation', 'validation', 'revision', 'deployment', 'reporting'], description: 'The action mode that should run next. CHOOSE by this rubric, do not just pick the default successor: work spans >1 file OR >1 step OR is vague/underscoped → "planning" (break it down first). Plan + small clear tasks filed → "approval_request". Human authorized the write phase → "implementation". You just wrote code → "validation" (ALWAYS verify after writing). Validation found failures → "revision"; validation passed → "deployment". Committed & shipped → "reporting". Unresolved tasks or failed criteria remain → "planning" for the next item; everything met → objective complete (leave empty). NEVER move on to a new task while the current one has unmet/failed criteria.' },
      next_rationale: { type: 'string', description: 'One line on why that mode comes next.' }
    },
    required: ['summary']
  },
  async run(args, ctx) {
    ctx.done = true;
    ctx.doneSummary = (args.summary || '').trim() || ctx.doneSummary;
    if (args.criteria_advanced) ctx.criteriaAdvanced = String(args.criteria_advanced).trim();
    if (args.visual_summary) ctx.visualSummary = String(args.visual_summary).trim();
    if (args.next_mode) ctx.nextMode = String(args.next_mode).trim();
    if (args.next_rationale) ctx.nextRationale = String(args.next_rationale).trim();
    return { ok: true, finished: true };
  }
};
