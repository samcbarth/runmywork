'use strict';

/*
 * Progress signal for the Domino's-style tracker. The agent calls this when it
 * moves to a new phase of its workflow; the runtime patches the agent_runs row
 * the PWA polls. Stages, in order: look -> think -> do -> review -> revise ->
 * report. Percent never regresses (a revise->do loop keeps the bar forward).
 */

const STAGES = ['look', 'think', 'do', 'review', 'revise', 'report'];

module.exports = {
  name: 'stage',
  description: 'Tell the user which phase of your workflow you are in, so they can watch progress. Call it whenever you move to a new phase. In order: "look" (gather info, read project context), "think" (analyze, make a plan), "do" (execute / produce output), "review" (verify results), "revise" (fix issues found), "report" (summarize). Move forward as you work.',
  parameters: {
    type: 'object',
    properties: {
      stage: { type: 'string', enum: STAGES },
      note: { type: 'string', description: 'Optional one line on what you are doing in this stage.' }
    },
    required: ['stage']
  },
  async run(args, ctx) {
    const stage = String(args.stage || '').toLowerCase().trim();
    const idx = STAGES.indexOf(stage);
    if (idx < 0) return { error: `stage must be one of ${STAGES.join('|')}` };

    ctx.currentStage = stage;
    if (ctx.run) {
      const now = Date.now();
      ctx.run.stages = ctx.run.stages || [];
      ctx.run.stages.push({ stage, enteredAt: now, note: (args.note || '').slice(0, 200) });
      const pct = Math.round(((idx + 1) / STAGES.length) * 100);
      ctx.run.percent = Math.max(ctx.run.percent || 0, pct);
      await ctx.sb.updateRun(ctx.run.id, { stage, percent: ctx.run.percent, stages: ctx.run.stages });
    }
    return { ok: true, stage };
  },

  STAGES
};
