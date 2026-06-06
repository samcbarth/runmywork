'use strict';

/*
 * verify — check that a file the agent wrote is actually valid.
 * ------------------------------------------------------------
 * The agent's self-correction step: after editing code, run this before done.
 *   • .js   → `node --check` (syntax)
 *   • .json → JSON.parse
 *   • other → skipped (reported as "no verifier")
 *
 * Returns { ok:true } or { ok:false, error, line? } so the model can read the
 * exact syntax error and fix it. The loop ALSO runs this automatically on done
 * (see loop.js done-gate) — this tool lets the agent check proactively.
 */

const fs        = require('fs');
const path      = require('path');
const { execFileSync } = require('child_process');

function safeResolve(root, rel) {
  const resolved = path.resolve(root, rel);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path "${rel}" escapes the project root.`);
  }
  return resolved;
}

// Shared so loop.js can call the same logic on the done-gate.
function verifyFile(root, relPath) {
  const target = safeResolve(root, relPath);
  if (!fs.existsSync(target)) return { ok: false, error: `File not found: ${relPath}` };

  const ext = path.extname(target).toLowerCase();
  if (ext === '.js') {
    try {
      execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
      return { ok: true, checked: 'node --check' };
    } catch (e) {
      const out = (e.stderr ? e.stderr.toString() : e.message) || '';
      const m = out.match(/:(\d+)\b/);
      return { ok: false, error: out.split('\n').slice(0, 4).join('\n').trim(), line: m ? Number(m[1]) : undefined };
    }
  }
  if (ext === '.json') {
    try { JSON.parse(fs.readFileSync(target, 'utf8')); return { ok: true, checked: 'JSON.parse' }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: true, checked: 'skipped', note: `No verifier for ${ext || 'this file type'}; not checked.` };
}

module.exports = {
  name: 'verify',
  description: 'Check that a file you edited is valid before finishing. Runs a syntax check (node --check for .js, JSON.parse for .json). Call this after write_file and before done. Returns the exact error if invalid so you can fix it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project root to verify.' }
    },
    required: ['path']
  },
  enabled: (config) => Boolean(config.projectRoot),
  async run(args, ctx) {
    const root = ctx.config.projectRoot;
    if (!root) return { error: 'AGENT_PROJECT_ROOT not configured.' };
    try { return verifyFile(root, args.path || ''); }
    catch (e) { return { error: e.message }; }
  },
  // exported for the loop's done-gate
  verifyFile
};
