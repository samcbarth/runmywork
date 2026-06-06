'use strict';

module.exports = {
  name: 'done',
  description: 'Finish the task. Call this when you have made the progress you can. Provide a short, honest summary of what you accomplished, what you proposed, and anything that blocked you. If the project has success criteria, set criteria_advanced to name the criterion you moved forward and whether it is now met.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Concise summary of what was done and proposed.' },
      criteria_advanced: { type: 'string', description: 'Which success criterion you advanced this run, and whether it is now met. Empty if none.' }
    },
    required: ['summary']
  },
  async run(args, ctx) {
    ctx.done = true;
    ctx.doneSummary = (args.summary || '').trim() || ctx.doneSummary;
    if (args.criteria_advanced) ctx.criteriaAdvanced = String(args.criteria_advanced).trim();
    return { ok: true, finished: true };
  }
};
