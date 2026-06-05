'use strict';

/*
 * Record a finding to the project worklog — the agent's durable memory. Shows up
 * in the app's project detail and is fed back as context on the next run, so the
 * agent's understanding compounds instead of restarting cold (Roadmap Phase 2).
 */

module.exports = {
  name: 'note',
  description: 'Save a short finding or observation to the project journal so it persists as memory for future runs. Use for facts learned, decisions, dead ends — not for proposing changes (use "propose" for those).',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One line: what you learned or decided.' },
      detail: { type: 'string', description: 'Optional supporting detail.' }
    },
    required: ['summary']
  },
  async run(args, ctx) {
    const summary = (args.summary || '').trim();
    if (!summary) return { error: 'summary is required' };
    if (!ctx.project) return { error: 'note needs a project context' };

    await ctx.sb.addWorklog({
      project_id: ctx.project.id,
      kind: 'observation',
      summary,
      detail: args.detail ? { text: String(args.detail).slice(0, 4000) } : {},
      created_by: 'agent'
    });
    ctx.findings.push(summary);
    return { ok: true, saved: summary };
  }
};
