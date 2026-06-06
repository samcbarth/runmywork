'use strict';

const GITHUB_API = 'https://api.github.com';

function tok(ctx) {
  const t = ctx.config && ctx.config.githubToken;
  if (!t) throw new Error('GITHUB_TOKEN not set — add it to run-agent.bat');
  return t;
}

function hdr(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'runmywork-agent'
  };
}

async function gh(path, opts, token) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${GITHUB_API}${path}`, {
      ...opts,
      headers: { ...hdr(token), ...(opts && opts.headers ? opts.headers : {}) },
      signal: ctrl.signal
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = typeof data === 'object' && data.message ? data.message : text.slice(0, 200);
      throw new Error(`GitHub ${res.status}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(id);
  }
}

module.exports = {
  name: 'github',
  description: `Interact with GitHub. op values:
- list_repos: list your repos (no extra args needed)
- list_prs: open PRs for owner/repo
- get_pr: PR detail + CI check status (needs number)
- create_pr: open a pull request (needs head, title; base defaults to "main")
- list_issues: open issues for owner/repo
- create_issue: file a new issue (needs title)
- list_commits: recent commits on a branch`,
  parameters: {
    type: 'object',
    properties: {
      op:     { type: 'string', enum: ['list_repos','list_prs','get_pr','create_pr','list_issues','create_issue','list_commits'] },
      owner:  { type: 'string', description: 'GitHub user or org name' },
      repo:   { type: 'string', description: 'Repository name' },
      number: { type: 'integer', description: 'PR number (for get_pr)' },
      head:   { type: 'string', description: 'Source branch (for create_pr)' },
      base:   { type: 'string', description: 'Target branch (default: main)' },
      title:  { type: 'string', description: 'Title (for create_pr / create_issue)' },
      body:   { type: 'string', description: 'Body / description' },
      branch: { type: 'string', description: 'Branch for list_commits (default: repo default branch)' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Labels for create_issue' }
    },
    required: ['op']
  },
  enabled: (config) => Boolean(config.githubToken),
  async run(args, ctx) {
    const token = tok(ctx);
    const { op, owner, repo } = args;

    try {
      switch (op) {
        case 'list_repos': {
          const data = await gh('/user/repos?sort=updated&per_page=20&type=owner', {}, token);
          return JSON.stringify(data.map(r => ({
            name: r.full_name,
            private: r.private,
            default_branch: r.default_branch,
            updated_at: r.updated_at,
            open_issues: r.open_issues_count
          })));
        }

        case 'list_prs': {
          if (!owner || !repo) return JSON.stringify({ error: 'owner and repo required' });
          const data = await gh(`/repos/${owner}/${repo}/pulls?state=open&per_page=20`, {}, token);
          return JSON.stringify(data.map(pr => ({
            number: pr.number, title: pr.title, state: pr.state, draft: pr.draft,
            head: pr.head.ref, base: pr.base.ref, url: pr.html_url, created_at: pr.created_at
          })));
        }

        case 'get_pr': {
          if (!owner || !repo || !args.number) return JSON.stringify({ error: 'owner, repo, and number required' });
          const pr = await gh(`/repos/${owner}/${repo}/pulls/${args.number}`, {}, token);
          let checks = { check_runs: [] };
          try { checks = await gh(`/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=10`, {}, token); } catch {}
          return JSON.stringify({
            number: pr.number, title: pr.title, state: pr.state, draft: pr.draft,
            mergeable: pr.mergeable, merged: pr.merged,
            head: pr.head.ref, base: pr.base.ref, url: pr.html_url,
            checks: (checks.check_runs || []).map(c => ({ name: c.name, status: c.status, conclusion: c.conclusion }))
          });
        }

        case 'create_pr': {
          if (!owner || !repo || !args.head || !args.title) return JSON.stringify({ error: 'owner, repo, head, and title required' });
          const data = await gh(`/repos/${owner}/${repo}/pulls`, {
            method: 'POST',
            body: JSON.stringify({ title: args.title, body: args.body || '', head: args.head, base: args.base || 'main', draft: false })
          }, token);
          return JSON.stringify({ number: data.number, url: data.html_url, state: data.state });
        }

        case 'list_issues': {
          if (!owner || !repo) return JSON.stringify({ error: 'owner and repo required' });
          const data = await gh(`/repos/${owner}/${repo}/issues?state=open&per_page=20`, {}, token);
          return JSON.stringify(
            data.filter(i => !i.pull_request).map(i => ({
              number: i.number, title: i.title, url: i.html_url,
              labels: (i.labels || []).map(l => l.name), created_at: i.created_at
            }))
          );
        }

        case 'create_issue': {
          if (!owner || !repo || !args.title) return JSON.stringify({ error: 'owner, repo, and title required' });
          const data = await gh(`/repos/${owner}/${repo}/issues`, {
            method: 'POST',
            body: JSON.stringify({ title: args.title, body: args.body || '', labels: args.labels || [] })
          }, token);
          return JSON.stringify({ number: data.number, url: data.html_url });
        }

        case 'list_commits': {
          if (!owner || !repo) return JSON.stringify({ error: 'owner and repo required' });
          const qs = args.branch ? `?sha=${encodeURIComponent(args.branch)}&per_page=10` : '?per_page=10';
          const data = await gh(`/repos/${owner}/${repo}/commits${qs}`, {}, token);
          return JSON.stringify(data.map(c => ({
            sha: c.sha.slice(0, 7),
            message: c.commit.message.split('\n')[0].slice(0, 100),
            author: c.commit.author.name,
            date: c.commit.author.date
          })));
        }

        default:
          return JSON.stringify({ error: `unknown op "${op}"` });
      }
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  }
};
