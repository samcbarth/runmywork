'use strict';

/*
 * Progress signal for the Domino's-style tracker. The agent calls this when it
 * moves to a new phase of its workflow; the runtime patches the agent_runs row
 * the PWA polls.
 *
 * Full lifecycle (7 stages): planning -> editing -> testing -> pushed ->
 * deploying -> live_verified -> complete. The AGENT only drives the first three
 * (its own work). The remaining four are driven by the workflow AFTER the agent
 * process exits — push to main, GitHub Pages deploy, live-URL verification — so
 * a run is only "complete" once the change is actually live. Percent is computed
 * against all 7 stages and never regresses.
 */

// Full lifecycle, in order. Percent is index-based against this list.
const STAGES = ['planning', 'editing', 'testing', 'pushed', 'deploying', 'live_verified', 'complete'];
// Stages the model itself may set. The post-agent deploy/verify stages are
// driven by deploy-verify.js patching the run row directly, not by this tool.
const AGENT_STAGES = ['planning', 'editing', 'testing'];

module.exports = {
  name: 'stage',
  description: 'Tell the user which phase of your work you are in, so they can watch progress. Call it whenever you move to a new phase. Use: "planning" (gather info, read context, decide what to change), "editing" (make the actual file changes), "testing" (verify the changes are correct). The later stages (pushed, deploying, live verified, complete) happen automatically after you finish — you do not set those.',
  parameters: {
    type: 'object',
    properties: {
      stage: { type: 'string', enum: AGENT_STAGES },
      note: { type: 'string', description: 'Optional one line on what you are doing in this stage.' }
    },
    required: ['stage']
  },
  async run(args, ctx) {
    const stage = String(args.stage || '').toLowerCase().trim();
    const idx = STAGES.indexOf(stage);
    if (idx < 0 || !AGENT_STAGES.includes(stage)) return { error: `stage must be one of ${AGENT_STAGES.join('|')}` };

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

  STAGES,
  AGENT_STAGES
};
