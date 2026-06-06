'use strict';

/*
 * write_file — write or patch a real project file.
 * Gated behind AGENT_ALLOW_FILE_WRITE=1.
 *
 * Supports three ops:
 *   "write"  — full overwrite (use for new files or complete rewrites)
 *   "patch"  — replace one exact string with another (surgical edit, safer)
 *   "append" — add content to end of file
 *
 * Every successful write is tracked in ctx.changedFiles so it appears in the
 * run summary, worklog, and agent_runs record. The agent cannot escape the
 * project root (path traversal protection).
 *
 * NEVER commits automatically — that's git_commit's job.
 */

const fs   = require('fs');
const path = require('path');

const BLOCKED = [
  '.env', '.env.local', 'run-agent.bat',   // secrets
  'node_modules', '.git'                    // repo internals (prefix check below)
];

function safeResolve(root, rel) {
  const resolved = path.resolve(root, rel);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path "${rel}" escapes the project root.`);
  }
  // block secrets / git internals
  const rel2 = path.relative(root, resolved).replace(/\\/g, '/');
  for (const b of BLOCKED) {
    if (rel2 === b || rel2.startsWith(b + '/')) {
      throw new Error(`Writing "${rel}" is not allowed (blocked path).`);
    }
  }
  return resolved;
}

module.exports = {
  name: 'write_file',
  description: 'Write or patch a real file in the connected project. Requires AGENT_ALLOW_FILE_WRITE. op: "write" (full overwrite), "patch" (replace old_string with new_string — safer for edits), "append" (add to end). After writing, call git_commit to record the change.',
  parameters: {
    type: 'object',
    properties: {
      op:         { type: 'string', enum: ['write', 'patch', 'append'], description: 'write=full overwrite, patch=string replace, append=add to end.' },
      path:       { type: 'string', description: 'File path relative to project root.' },
      content:    { type: 'string', description: 'For write/append: the full content or text to append.' },
      old_string: { type: 'string', description: 'For patch: exact text to replace.' },
      new_string: { type: 'string', description: 'For patch: replacement text.' },
      reason:     { type: 'string', description: 'Why this change — stored in the change log.' }
    },
    required: ['op', 'path']
  },
  enabled: (config) => Boolean(config.projectRoot) && config.allowFileWrite,
  async run(args, ctx) {
    const root = ctx.config.projectRoot;
    if (!root) return { error: 'AGENT_PROJECT_ROOT not configured.' };
    if (!ctx.config.allowFileWrite) return { error: 'AGENT_ALLOW_FILE_WRITE not set.' };

    const op = String(args.op || '').trim();
    let target;
    try { target = safeResolve(root, args.path || ''); }
    catch (e) { return { error: e.message }; }

    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });

      switch (op) {
        case 'write': {
          // Warn if this looks like a hallucinated path (parent dir doesn't exist in root)
          const parentExists = fs.existsSync(path.dirname(target));
          if (!parentExists) {
            const hint = _nearbyFiles(root, args.path);
            return { error: `Parent directory does not exist for "${args.path}". Did you mean one of: ${hint}? Use read_file op:"list" to verify paths.` };
          }
          const content = String(args.content ?? '');
          fs.writeFileSync(target, content, 'utf8');
          _trackChange(ctx, args.path, op, args.reason);
          return { ok: true, op, path: args.path, bytes: Buffer.byteLength(content) };
        }
        case 'append': {
          const content = String(args.content ?? '');
          fs.appendFileSync(target, content, 'utf8');
          _trackChange(ctx, args.path, op, args.reason);
          return { ok: true, op, path: args.path, bytes: Buffer.byteLength(content) };
        }
        case 'patch': {
          const old_string = args.old_string;
          const new_string = args.new_string;
          if (old_string == null || new_string == null) {
            return { error: 'patch requires old_string and new_string.' };
          }
          if (!fs.existsSync(target)) {
            const hint = _nearbyFiles(root, args.path);
            return { error: `File not found: "${args.path}". Did you mean one of: ${hint}? Use read_file op:"list" to verify exact paths before patching.` };
          }
          const original = fs.readFileSync(target, 'utf8');
          if (!original.includes(old_string)) {
            return { error: `old_string not found in ${args.path}. Read the file first to get the exact text.` };
          }
          const count = (original.split(old_string).length - 1);
          if (count > 1) {
            return { error: `old_string matches ${count} places in ${args.path}. Make it more specific.` };
          }
          const updated = original.replace(old_string, new_string);
          fs.writeFileSync(target, updated, 'utf8');
          _trackChange(ctx, args.path, 'patch', args.reason);
          return { ok: true, op: 'patch', path: args.path };
        }
        default:
          return { error: `Unknown op "${op}". Use write | patch | append.` };
      }
    } catch (e) {
      return { error: e.message };
    }
  }
};

// Find files with similar names to help the model self-correct hallucinated paths.
function _nearbyFiles(root, badPath) {
  try {
    const path = require('path');
    const fs   = require('fs');
    const name = path.basename(badPath).toLowerCase();
    const results = [];
    function walk(dir, depth) {
      if (depth > 3) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (['.git','node_modules','work'].includes(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.name.toLowerCase().includes(name) || name.includes(e.name.toLowerCase())) {
          results.push(path.relative(root, full).replace(/\\/g, '/'));
        }
      }
    }
    walk(root, 0);
    return results.length ? results.slice(0, 5).join(', ') : '(no similar files found — use read_file op:"list" to explore)';
  } catch { return '(unknown)'; }
}

function _trackChange(ctx, filePath, op, reason) {
  if (!ctx.changedFiles) ctx.changedFiles = [];
  // dedupe: update existing entry if same file
  const existing = ctx.changedFiles.find(f => f.path === filePath);
  if (existing) {
    existing.ops.push(op);
    if (reason) existing.reason = reason;
  } else {
    ctx.changedFiles.push({ path: filePath, ops: [op], reason: reason || '' });
  }
}
