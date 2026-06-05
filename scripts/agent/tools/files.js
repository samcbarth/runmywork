'use strict';

/*
 * Sandboxed filesystem. All paths are jailed to the project's work/<id>/ dir via
 * sandbox.safeResolve — the agent cannot touch anything else on the machine.
 * One tool, four ops, so the model has a small, clear surface.
 */

const fs = require('fs');
const path = require('path');
const { safeResolve } = require('../sandbox');

const MAX_READ = 8000;

module.exports = {
  name: 'files',
  description: 'Read, write, append, or list files in your project sandbox (an isolated work folder). op: "read" (args.path), "write" (args.path, args.content), "append" (args.path, args.content), "list" (args.path optional dir). Paths are relative to the sandbox.',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['read', 'write', 'append', 'list'] },
      path: { type: 'string', description: 'Relative path inside the sandbox.' },
      content: { type: 'string', description: 'Content for write/append.' }
    },
    required: ['op']
  },
  async run(args, ctx) {
    const op = String(args.op || '').trim();
    let target;
    try { target = safeResolve(ctx.workDir, args.path || '.'); }
    catch (e) { return { error: e.message }; }

    try {
      switch (op) {
        case 'read': {
          if (!fs.existsSync(target)) return { error: 'file not found' };
          const data = fs.readFileSync(target, 'utf8');
          return {
            path: args.path,
            truncated: data.length > MAX_READ,
            content: data.length > MAX_READ ? data.slice(0, MAX_READ) + '\n…[truncated]' : data
          };
        }
        case 'write':
        case 'append': {
          const content = String(args.content ?? '');
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (op === 'append') fs.appendFileSync(target, content, 'utf8');
          else fs.writeFileSync(target, content, 'utf8');
          return { ok: true, path: args.path, bytes: Buffer.byteLength(content) };
        }
        case 'list': {
          const dir = fs.existsSync(target) ? target : ctx.workDir;
          if (!fs.statSync(dir).isDirectory()) return { error: 'not a directory' };
          const entries = fs.readdirSync(dir, { withFileTypes: true })
            .map(d => (d.isDirectory() ? d.name + '/' : d.name));
          return { dir: path.relative(ctx.workDir, dir) || '.', entries };
        }
        default:
          return { error: `unknown op "${op}". Use read|write|append|list` };
      }
    } catch (e) {
      return { error: e.message };
    }
  }
};
