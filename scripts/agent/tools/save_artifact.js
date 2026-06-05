'use strict';

/*
 * Persist a real deliverable: writes the content to a file in the project work
 * dir AND logs a worklog entry (truncated) so it's visible cross-device in the
 * app. Big/code deliverables live as files on the box; the journal keeps a
 * readable record. No secrets — the worklog is anon-readable (Phase 0 rule).
 */

const fs = require('fs');
const path = require('path');
const { safeResolve } = require('../sandbox');

module.exports = {
  name: 'save_artifact',
  description: 'Save a finished deliverable (research write-up, draft, plan, code) as a file in the project sandbox and record it in the journal. Use this for substantial output you want kept.',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Relative filename, e.g. "research/competitors.md" or "draft.txt".' },
      content: { type: 'string', description: 'The full content to save.' },
      summary: { type: 'string', description: 'One line describing the artifact.' }
    },
    required: ['filename', 'content']
  },
  async run(args, ctx) {
    const content = String(args.content ?? '');
    if (!content.trim()) return { error: 'content is empty' };
    const target = safeResolve(ctx.workDir, args.filename || 'artifact.txt');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');

    const rel = path.relative(ctx.workDir, target);
    const summary = (args.summary || `Saved artifact ${rel}`).trim();

    if (ctx.project) {
      await ctx.sb.addWorklog({
        project_id: ctx.project.id,
        kind: 'note',
        summary: `📄 ${summary}`,
        detail: { file: rel, preview: content.slice(0, 4000) },
        created_by: 'agent'
      });
    }
    ctx.artifacts.push({ file: rel, summary, bytes: Buffer.byteLength(content) });
    return { ok: true, file: rel, bytes: Buffer.byteLength(content) };
  }
};
