'use strict';

/*
 * Spawn a sub-agent to work a focused sub-goal, then return its summary. This is
 * the multi-agent piece: the parent decomposes, each child runs its own loop with
 * its own budget (and optionally a different local model — e.g. a bigger model for
 * a hard sub-problem, a fast one for grunt work). Depth-capped to prevent runaway
 * recursion. Children share the project + sandbox, and file their own proposals
 * and journal entries directly.
 */

const RESTRICTED = ['web_search', 'fetch_url', 'files', 'note', 'save_artifact', 'propose', 'done', 'shell'];

module.exports = {
  name: 'delegate',
  description: 'Hand a focused sub-task to a sub-agent that runs its own tool loop and reports back a summary. Use to parallelise or isolate a chunk of work (e.g. "research X", "draft Y"). Provide a clear, self-contained goal — the sub-agent does not see this conversation.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'Self-contained sub-task for the sub-agent.' },
      context: { type: 'string', description: 'Any facts the sub-agent needs (it cannot see your conversation).' },
      budget: { type: 'number', description: 'Max steps for the sub-agent (default 6).' }
    },
    required: ['goal']
  },
  async run(args, ctx) {
    const maxDepth = ctx.config.maxDepth ?? 2;
    if (ctx.depth >= maxDepth) {
      return { error: `delegation depth limit (${maxDepth}) reached — do this work yourself` };
    }
    const goal = String(args.goal || '').trim();
    if (!goal) return { error: 'goal is required' };

    const budget = Math.min(Math.max(parseInt(args.budget, 10) || 6, 1), ctx.config.budget);
    ctx.log(`  ${'·'.repeat(ctx.depth + 1)}↳ delegate: ${goal.slice(0, 60)}`);

    const result = await ctx.runLoop({
      services: ctx.services,
      project: ctx.project,
      goal,
      contextText: args.context || '',
      depth: ctx.depth + 1,
      budget,
      model: ctx.config.workerModel,   // env-configured worker model; the LLM does not pick models
      allowList: RESTRICTED.filter(n => ctx.tools.has(n))   // no delegate/build_tool for children
    });

    // children file their own approvals/worklog; surface counts up for the report
    ctx.proposals.push(...result.proposals);
    ctx.artifacts.push(...result.artifacts);
    ctx.findings.push(...result.findings);

    return {
      ok: true,
      sub_summary: result.summary,
      steps: result.steps,
      proposals: result.proposals.length,
      artifacts: result.artifacts.length
    };
  }
};
