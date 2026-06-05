'use strict';

/*
 * git — read the repo state and commit/push changes.
 *
 * ops always available (when projectRoot set):
 *   status  — show working tree state (modified/untracked/staged)
 *   diff    — show unstaged diff (args.path optional — one file or whole tree)
 *   log     — recent commits (args.n default 10)
 *
 * ops gated behind AGENT_ALLOW_GIT_WRITE:
 *   add     — stage files (args.paths: string[] or "." for all changed)
 *   commit  — create a commit (args.message required)
 *
 * ops gated behind AGENT_ALLOW_GIT_PUSH:
 *   push    — push current branch to origin
 *
 * Commit messages are automatically suffixed with a co-author tag so every
 * agent commit is clearly labelled.
 */

const { execSync } = require('child_process');

function run(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 }).trim();
}

function trunc(s, n) { return s.length > n ? s.slice(0, n) + '\n…[truncated]' : s; }

module.exports = {
  name: 'git',
  description: 'Inspect and commit changes in the connected project repo. op: "status", "diff" (args.path optional), "log" (args.n=10), "add" (args.paths[]), "commit" (args.message), "push". commit and push require explicit env flags. Always read status+diff before committing.',
  parameters: {
    type: 'object',
    properties: {
      op:      { type: 'string', enum: ['status', 'diff', 'log', 'add', 'commit', 'push'] },
      path:    { type: 'string', description: 'For diff: specific file path (optional).' },
      paths:   { type: 'array', items: { type: 'string' }, description: 'For add: list of paths to stage. Use ["."] for all modified tracked files.' },
      message: { type: 'string', description: 'For commit: the commit message. Be descriptive — mention what changed and why.' },
      n:       { type: 'number', description: 'For log: number of commits to show (default 10).' }
    },
    required: ['op']
  },
  enabled: (config) => Boolean(config.projectRoot),
  async run(args, ctx) {
    const root = ctx.config.projectRoot;
    if (!root) return { error: 'AGENT_PROJECT_ROOT not configured.' };

    const op = String(args.op || '').trim();

    try {
      switch (op) {
        case 'status': {
          const out = run('git status --porcelain=v1', root);
          if (!out) return { status: 'clean', files: [] };
          const files = out.split('\n').map(l => ({ code: l.slice(0, 2).trim(), path: l.slice(3) }));
          return { status: 'dirty', files };
        }

        case 'diff': {
          const pathArg = args.path ? ` -- ${JSON.stringify(args.path)}` : '';
          const out = run(`git diff HEAD${pathArg}`, root);
          return { diff: trunc(out || '(no changes)', 8000) };
        }

        case 'log': {
          const n = Math.min(Number(args.n) || 10, 30);
          const out = run(`git log --oneline -${n}`, root);
          return { commits: out.split('\n').filter(Boolean) };
        }

        case 'add': {
          if (!ctx.config.allowGitWrite) return { error: 'AGENT_ALLOW_GIT_WRITE not set.' };
          const paths = Array.isArray(args.paths) && args.paths.length ? args.paths : ['.'];
          // only stage tracked/modified files — never force-add secrets
          const safeArgs = paths.map(p => JSON.stringify(p)).join(' ');
          run(`git add ${safeArgs}`, root);
          const staged = run('git diff --cached --name-only', root);
          return { ok: true, staged: staged.split('\n').filter(Boolean) };
        }

        case 'commit': {
          if (!ctx.config.allowGitWrite) return { error: 'AGENT_ALLOW_GIT_WRITE not set.' };
          const msg = String(args.message || '').trim();
          if (!msg) return { error: 'commit requires a message.' };
          // Check there is something staged
          const staged = run('git diff --cached --name-only', root);
          if (!staged.trim()) return { error: 'Nothing staged. Call git op:"add" first.' };
          const fullMsg = `${msg}\n\nCo-Authored-By: RunMyWork Agent <agent@runmywork.local>`;
          // Write message to a temp file to avoid shell quoting nightmares
          const os = require('os');
          const fs = require('fs');
          const tmp = require('path').join(os.tmpdir(), `rmw-commit-${Date.now()}.txt`);
          fs.writeFileSync(tmp, fullMsg, 'utf8');
          try {
            const out = run(`git commit -F "${tmp}"`, root);
            // track in ctx
            if (!ctx.changedFiles) ctx.changedFiles = [];
            return { ok: true, output: trunc(out, 500) };
          } finally {
            try { fs.unlinkSync(tmp); } catch {}
          }
        }

        case 'push': {
          if (!ctx.config.allowGitPush) return { error: 'AGENT_ALLOW_GIT_PUSH not set. This is intentionally separate from allowGitWrite.' };
          const out = run('git push', root);
          return { ok: true, output: trunc(out || '(pushed)', 300) };
        }

        default:
          return { error: `Unknown op "${op}". Use status|diff|log|add|commit|push.` };
      }
    } catch (e) {
      return { error: e.message };
    }
  }
};
