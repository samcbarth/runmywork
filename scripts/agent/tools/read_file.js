'use strict';

/*
 * read_file — read any file in the project root (read-only, no gate needed).
 * Paths are resolved relative to config.projectRoot and cannot escape it.
 * Also supports list_dir to explore the tree before reading.
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 12000;   // ~3k tokens — enough for most source files

function safeResolve(root, rel) {
  const resolved = path.resolve(root, rel);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path "${rel}" escapes the project root.`);
  }
  return resolved;
}

module.exports = {
  name: 'read_file',
  description: 'Read a file or list a directory inside the connected project. op: "read" (path), "list" (path, optional). Paths relative to the project root. Use this to understand the codebase before making changes.',
  parameters: {
    type: 'object',
    properties: {
      op:   { type: 'string', enum: ['read', 'list'], description: '"read" a file, "list" a directory.' },
      path: { type: 'string', description: 'Relative path from the project root. E.g. "js/store.js" or "scripts/agent".' },
      offset: { type: 'number', description: 'For read: byte offset to start from (for large files).' }
    },
    required: ['op', 'path']
  },
  enabled: (config) => Boolean(config.projectRoot),
  async run(args, ctx) {
    const root = ctx.config.projectRoot;
    if (!root) return { error: 'AGENT_PROJECT_ROOT not configured.' };

    const op = String(args.op || 'read');
    let target;
    try { target = safeResolve(root, args.path || '.'); }
    catch (e) { return { error: e.message }; }

    try {
      if (op === 'list') {
        if (!fs.existsSync(target)) return { error: 'Path not found.' };
        const stat = fs.statSync(target);
        if (!stat.isDirectory()) return { error: 'Not a directory. Use op:"read" for files.' };
        const entries = fs.readdirSync(target, { withFileTypes: true })
          .filter(d => !d.name.startsWith('.') || d.name === '.gitignore')
          .map(d => d.isDirectory() ? d.name + '/' : d.name)
          .sort();
        return { path: args.path, entries };
      }

      // read
      if (!fs.existsSync(target)) return { error: `File not found: ${args.path}` };
      const stat = fs.statSync(target);
      if (stat.isDirectory()) return { error: 'Path is a directory. Use op:"list".' };

      const offset = Number(args.offset) || 0;
      const buf = Buffer.alloc(MAX_BYTES);
      const fd = fs.openSync(target, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, MAX_BYTES, offset);
      fs.closeSync(fd);
      const content = buf.slice(0, bytesRead).toString('utf8');
      const truncated = (offset + bytesRead) < stat.size;
      return {
        path: args.path,
        size: stat.size,
        offset,
        truncated,
        next_offset: truncated ? offset + bytesRead : null,
        content
      };
    } catch (e) {
      return { error: e.message };
    }
  }
};
