'use strict';

/*
 * Run a command — OFF unless AGENT_ALLOW_SHELL=1.
 * -----------------------------------------------
 * Defence in depth:
 *   - spawned with shell:false, so there is NO shell to interpret ; | && > $() —
 *     the agent can run one allowlisted binary, not a chain.
 *   - the binary (first token) must be on the allowlist (AGENT_SHELL_ALLOW to extend).
 *   - cwd is jailed to the project sandbox.
 *   - hard timeout; output capped.
 * This lets the agent build/test/inspect real code. It is NOT a security boundary
 * strong enough to run hostile code — keep the allowlist tight.
 */

const { spawn } = require('child_process');
const { safeResolve } = require('../sandbox');

const DEFAULT_ALLOW = ['node', 'npm', 'npx', 'git', 'gh', 'python', 'python3', 'pip', 'pip3',
  'pytest', 'tsc', 'go', 'cargo', 'rustc', 'java', 'javac', 'mvn', 'make', 'dotnet', 'ls', 'dir'];

// quote-aware tokenizer (no shell, so we split args ourselves)
function tokenize(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

module.exports = {
  name: 'shell',
  description: 'Run a single allowlisted command (e.g. "npm test", "node build.js", "git status") inside the project sandbox. No shell features — no pipes, redirects, or chaining. Returns stdout/stderr and exit code.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command, e.g. "npm install". First word must be an allowed binary.' },
      cwd: { type: 'string', description: 'Optional sub-directory of the sandbox to run in.' }
    },
    required: ['command']
  },
  enabled(config) { return config.allowShell; },

  async run(args, ctx) {
    const cmd = String(args.command || '').trim();
    if (!cmd) return { error: 'command is required' };

    const argv = tokenize(cmd);
    const bin = argv[0];
    const allow = ctx.config.shellAllow && ctx.config.shellAllow.length ? ctx.config.shellAllow : DEFAULT_ALLOW;
    if (!allow.includes(bin)) {
      return { error: `"${bin}" is not allowed. Allowed: ${allow.join(', ')}. (Extend with AGENT_SHELL_ALLOW.)` };
    }

    let cwd;
    try { cwd = safeResolve(ctx.workDir, args.cwd || '.'); }
    catch (e) { return { error: e.message }; }

    return new Promise(resolve => {
      let out = '', err = '', done = false;
      const child = spawn(bin, argv.slice(1), { cwd, shell: false, windowsHide: true });
      const timer = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); resolve({ error: 'command timed out (120s)', stdout: out.slice(0, 4000) }); } }, 120000);

      child.stdout.on('data', d => { out += d; if (out.length > 20000) out = out.slice(-20000); });
      child.stderr.on('data', d => { err += d; if (err.length > 8000) err = err.slice(-8000); });
      child.on('error', e => { if (!done) { done = true; clearTimeout(timer); resolve({ error: `spawn failed: ${e.message}` }); } });
      child.on('close', code => {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve({ exitCode: code, stdout: out.slice(-6000), stderr: err.slice(-3000) });
      });
    });
  }
};
