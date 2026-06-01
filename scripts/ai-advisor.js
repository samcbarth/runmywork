#!/usr/bin/env node
'use strict';

/*
 * RunMyWork — local AI advisor
 * ----------------------------
 * Runs on the machine that hosts Ollama (LAN-only). For each open project it
 * asks a local Ollama model for the single best next action + a few concrete
 * tasks, writes the result back into data.json on GitHub, and the PWA shows it
 * on the next load. Nothing leaves your network except the generated text that
 * gets committed to your own repo.
 *
 * Talks to GitHub with the same Contents API the web app uses, so it reads and
 * writes data.json on the repo's default branch — the same file the app syncs.
 *
 * Requires Node 18+ (global fetch). No npm install needed.
 *
 * Config (all via environment variables):
 *   GITHUB_PAT     (required) fine-grained/classic PAT with Contents read+write on the repo
 *   GITHUB_REPO    default "samcbarth/runmywork"
 *   OLLAMA_HOST    default "http://127.0.0.1:11434"
 *   OLLAMA_MODEL   default "llama3.1"
 *   ADVISOR_FORCE  "1" to (re)generate for every open project, ignoring the
 *                  "unchanged since last suggestion" skip. Default off.
 */

const REPO        = process.env.GITHUB_REPO   || 'samcbarth/runmywork';
const PAT         = process.env.GITHUB_PAT    || '';
const OLLAMA_HOST = (process.env.OLLAMA_HOST  || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL       = process.env.OLLAMA_MODEL  || 'llama3.1';
const FORCE       = process.env.ADVISOR_FORCE === '1';

const GH_API = `https://api.github.com/repos/${REPO}/contents/data.json`;

if (!PAT) {
  console.error('GITHUB_PAT is not set — cannot read or write data.json. Aborting.');
  process.exit(1);
}

/* ── helpers ─────────────────────────────────────────────────────── */

function log(...args) { console.log(`[advisor]`, ...args); }

function b64decode(str) {
  return Buffer.from(str.replace(/\s/g, ''), 'base64').toString('utf8');
}
function b64encode(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

async function fetchJson(url, opts, ms = 15000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function ghHeaders() {
  return {
    Authorization: `token ${PAT}`,
    Accept:        'application/vnd.github.v3+json',
    'User-Agent':  'runmywork-advisor'
  };
}

/* ── GitHub data.json read / write ───────────────────────────────── */

async function pullData() {
  const res = await fetchJson(GH_API, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status} ${res.statusText}`);
  const file = await res.json();
  return { data: JSON.parse(b64decode(file.content)), sha: file.sha };
}

async function pushData(data) {
  // Re-fetch the SHA right before writing to avoid clobbering a concurrent
  // sync from the app (same pattern the web app uses).
  let sha = null;
  const getRes = await fetchJson(GH_API, { headers: ghHeaders() });
  if (getRes.ok) sha = (await getRes.json()).sha;

  const body = {
    message: `advisor ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    content: b64encode(JSON.stringify(data, null, 2)),
    ...(sha ? { sha } : {})
  };
  const res = await fetchJson(GH_API, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`GitHub PUT failed: ${res.status} ${err.message || res.statusText}`);
  }
}

/* ── Ollama ──────────────────────────────────────────────────────── */

const SYSTEM_PROMPT =
`You are a focused work advisor inside a personal project hub. The user tracks
many projects of all kinds — software, writing, research, planning, life admin.
For one project at a time you read its current state and return the single most
useful next action plus a few concrete tasks.

Rules:
- Be specific and actionable. No pep talk, no restating the obvious.
- "nextAction" is one short sentence: the very next concrete step to move it forward.
- "tasks" is 0-4 short, concrete to-do items (each a few words). Omit ones already listed.
- If the project is blocked, focus on how to get unblocked.
- Respond with ONLY a JSON object: {"nextAction": string, "tasks": string[]}.`;

function buildUserPrompt(project) {
  const openTasks = (project.tasks || []).filter(t => !t.done).map(t => t.text);
  const doneTasks = (project.tasks || []).filter(t => t.done).map(t => t.text);
  const lines = [];
  lines.push(`Title: ${project.title}`);
  if (project.description) lines.push(`Description: ${project.description}`);
  lines.push(`Status: ${project.status}`);
  if (project.priority && project.priority !== 'medium') lines.push(`Priority: ${project.priority}`);
  if (project.tags && project.tags.length) lines.push(`Tags: ${project.tags.join(', ')}`);
  if (project.status === 'blocked' && project.blockedReason) lines.push(`Blocked by: ${project.blockedReason}`);
  if (openTasks.length) lines.push(`Open tasks:\n- ${openTasks.join('\n- ')}`);
  if (doneTasks.length) lines.push(`Completed tasks: ${doneTasks.join('; ')}`);
  const mins = project.totalMinutes || 0;
  lines.push(`Time invested so far: ${mins} minutes across ${(project.sessions || []).length} sessions.`);
  return lines.join('\n');
}

async function askOllama(project) {
  const res = await fetchJson(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: 'json',
      options: { temperature: 0.4 },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildUserPrompt(project) }
      ]
    })
  }, 120000);

  if (!res.ok) throw new Error(`Ollama responded ${res.status} ${res.statusText}`);
  const body = await res.json();
  const content = body.message && body.message.content;
  if (!content) throw new Error('Ollama returned no content');

  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error(`Ollama did not return valid JSON: ${content.slice(0, 200)}`); }

  const nextAction = typeof parsed.nextAction === 'string' ? parsed.nextAction.trim() : '';
  let tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  tasks = tasks.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()).slice(0, 4);

  if (!nextAction && tasks.length === 0) throw new Error('Empty suggestion');
  return { nextAction, tasks };
}

/* ── main ────────────────────────────────────────────────────────── */

function needsAdvice(project) {
  if (project.status === 'done' || project.status === 'archived') return false;
  if (FORCE) return true;
  if (project.aiRequested) return true;                 // user tapped "Ask the advisor"
  const sug = project.aiSuggestion;
  if (!sug) return true;                                // never run
  if (sug.basedOnUpdatedAt !== project.updatedAt) return true; // project changed since last run
  return false;
}

async function main() {
  log(`model=${MODEL} host=${OLLAMA_HOST} repo=${REPO}${FORCE ? ' (force)' : ''}`);

  // Quick reachability check so we fail fast & clearly if Ollama is down.
  try {
    const ping = await fetchJson(`${OLLAMA_HOST}/api/tags`, {}, 5000);
    if (!ping.ok) throw new Error(`status ${ping.status}`);
  } catch (e) {
    console.error(`Cannot reach Ollama at ${OLLAMA_HOST} (${e.message}). Is it running?`);
    process.exit(1);
  }

  const { data } = await pullData();
  const projects = data.projects || [];
  const targets = projects.filter(needsAdvice);

  if (targets.length === 0) {
    log('No projects need advice right now.');
    return;
  }

  log(`${targets.length} project(s) to review.`);
  let changed = 0;

  for (const project of targets) {
    try {
      log(`→ ${project.title}`);
      const { nextAction, tasks } = await askOllama(project);
      project.aiSuggestion = {
        nextAction,
        tasks,
        model: MODEL,
        generatedAt: Date.now(),
        basedOnUpdatedAt: project.updatedAt
      };
      project.aiRequested = false;
      changed++;
      log(`   ${nextAction || '(tasks only)'}`);
    } catch (e) {
      console.warn(`   skipped — ${e.message}`);
    }
  }

  if (changed === 0) {
    log('Nothing to write.');
    return;
  }

  data.advisedAt = Date.now();
  await pushData(data);
  log(`Wrote ${changed} suggestion(s) back to data.json.`);
}

main().catch(e => { console.error('Advisor failed:', e.message); process.exit(1); });
