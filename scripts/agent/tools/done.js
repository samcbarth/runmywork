'use strict';

module.exports = {
  name: 'done',
  description: 'Finish the task. Call this when you have made the progress you can. Provide a short, honest summary of what you accomplished, what you proposed, and anything that blocked you.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Concise summary of what was done and proposed.' }
    },
    required: ['summary']
  },
  async run(args, ctx) {
    ctx.done = true;
    ctx.doneSummary = (args.summary || '').trim() || ctx.doneSummary;
    return { ok: true, finished: true };
  }
};
