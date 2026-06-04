#!/usr/bin/env node
'use strict';

/*
 * RunMyWork — local AI advisor
 * ----------------------------
 * Runs on the machine that hosts Ollama (LAN-only). For each open project it
 * asks a local Ollama model for the single best next action + a few concrete
 * tasks, writes the result back to Supabase, and the PWA shows it on the next
 * load. Nothing leaves your network except the generated text that gets stored
 * in your own Supabase project.
 *
 * Talks to the same Supabase REST API the web app uses, reading projects and
 * patching each one's suggestion in place.
 *
 * Requires Node 18+ (global fetch). No npm install needed.
 *
 * Config (all via environment variables):
 *   SUPABASE_URL               (required) e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  (required) service_role key — stays on this box, never committed
 *   OLLAMA_HOST                default "http://127.0.0.1:11434"
 *   OLLAMA_MODEL               default "llama3.1"
 *   ADVISOR_FORCE              "1" to (re)generate for every open project, ignoring the
 *                              "unchanged since last suggestion" skip. Default off.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const OLLAMA_HOST  = (process.env.OLLAMA_HOST  || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL        = process.env.OLLAMA_MODEL  || 'llama3.1';
const FORCE        = process.env.ADVISOR_FORCE === '1';

const REST = `${SUPABASE_URL}/rest/v1`;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set — cannot reach the datastore. Aborting.');
  process.exit(1);
}

/* ── helpers ─────────────────────────────────────────────────────── */

function log(...args) { console.log(`[advisor]`, ...args); }

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

function sbHeaders() {
  return {
    apikey:         SERVICE_KEY,
    Authorization:  `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'User-Agent':   'runmywork-advisor'
  };
}

// Map a Supabase row (snake_case) to the camelCase project shape the prompt +
// needsAdvice logic expect. Mirrors Sync.rowToProject in js/store.js.
function rowToProject(r) {
  return {
    id: r.id, title: r.title, description: r.description,
    status: r.status, priority: r.priority, tags: r.tags || [],
    createdAt: r.created_at, updatedAt: r.updated_at,
    statusHistory: r.status_history || [],
    sessions: r.sessions || [], totalMinutes: r.total_minutes || 0,
    blockedReason: r.blocked_reason || '', snoozedUntil: r.snoozed_until ?? null,
    links: r.links || [], tasks: r.tasks || [],
    aiSuggestion: r.ai_suggestion ?? null, aiRequested: !!r.ai_requested
  };
}

/* ── Supabase data read / write ──────────────────────────────────── */

async function pullProjects() {
  const res = await fetchJson(`${REST}/projects?select=*`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase GET failed: ${res.status} ${res.statusText}`);
  return (await res.json()).map(rowToProject);
}

// Write only the advisor's fields for one project — no read-modify-write of the
// whole dataset, so this can never clobber a concurrent edit from the app.
async function writeSuggestion(project) {
  const res = await fetchJson(`${REST}/projects?id=eq.${encodeURIComponent(project.id)}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ ai_suggestion: project.aiSuggestion, ai_requested: false })
  });
  if (!res.ok) throw new Error(`Supabase PATCH failed: ${res.status} ${res.statusText}`);
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

  const projects = await pullProjects();
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
      await writeSuggestion(project);
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

  log(`Wrote ${changed} suggestion(s) back to Supabase.`);
}

main().catch(e => { console.error('Advisor failed:', e.message); process.exit(1); });
