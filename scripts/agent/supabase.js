'use strict';

/*
 * Supabase REST helpers for the agent runtime.
 * --------------------------------------------
 * Uses the service_role key (env only — never committed) and talks to the same
 * PostgREST API the PWA uses. Mirrors the camel/snake mapping in js/store.js so
 * the rest of the runtime works in the app's project shape.
 *
 * The agent NEVER writes project rows directly. The only mutations it performs
 * are: ai_suggestion patches (a headline), worklog appends (its journal), and
 * approvals inserts (gated proposals the human applies in the app). Project
 * state changes go exclusively through the approvals inbox.
 */

function makeSupabase(config) {
  const REST = `${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1`;
  const KEY = config.serviceKey;

  function headers(extra) {
    return {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'runmywork-agent',
      ...extra
    };
  }

  async function rest(path, opts = {}, ms = 15000) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(`${REST}${path}`, { ...opts, headers: headers(opts.headers), signal: ctrl.signal });
      return res;
    } finally {
      clearTimeout(id);
    }
  }

  // snake row → camel project (matches Sync.rowToProject in js/store.js)
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

  async function pullProjects() {
    const res = await rest(`/projects?select=*`);
    if (!res.ok) throw new Error(`projects GET failed: ${res.status} ${res.statusText}`);
    return (await res.json()).map(rowToProject);
  }

  async function pullProject(id) {
    const res = await rest(`/projects?id=eq.${encodeURIComponent(id)}&select=*`);
    if (!res.ok) throw new Error(`project GET failed: ${res.status} ${res.statusText}`);
    const rows = await res.json();
    return rows.length ? rowToProject(rows[0]) : null;
  }

  // Headline shown on the project card. Safe to overwrite each run.
  async function setSuggestion(projectId, suggestion, basedOnUpdatedAt) {
    const res = await rest(`/projects?id=eq.${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        ai_suggestion: { ...suggestion, basedOnUpdatedAt },
        ai_requested: false
      })
    });
    if (!res.ok) throw new Error(`suggestion PATCH failed: ${res.status} ${res.statusText}`);
  }

  /* ── worklog (agent journal / memory) ── */

  async function addWorklog(entry) {
    const row = {
      created_at: Date.now(), created_by: 'agent', kind: 'note',
      summary: '', detail: {}, ...entry
    };
    const res = await rest(`/worklog`, {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([row])
    });
    if (!res.ok) throw new Error(`worklog POST failed: ${res.status} ${res.statusText}`);
  }

  async function pullWorklog(projectId, limit = 40) {
    const res = await rest(
      `/worklog?project_id=eq.${encodeURIComponent(projectId)}&order=created_at.desc&limit=${limit}`);
    if (!res.ok) throw new Error(`worklog GET failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /* ── approvals (gated proposals) ── */

  async function pendingApprovals(projectId) {
    const res = await rest(
      `/approvals?project_id=eq.${encodeURIComponent(projectId)}&status=eq.pending&select=action_type,payload`);
    if (!res.ok) return [];
    return res.json();
  }

  async function createApproval(row) {
    const res = await rest(`/approvals`, {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{ status: 'pending', created_by: 'agent', created_at: Date.now(), ...row }])
    });
    if (!res.ok) throw new Error(`approvals POST failed: ${res.status} ${res.statusText}`);
  }

  /* ── project_context (user-authored knowledge / agent memory) ── */

  async function pullContext(projectId, limit = 50) {
    const res = await rest(
      `/project_context?project_id=eq.${encodeURIComponent(projectId)}&order=created_at.desc&limit=${limit}`);
    if (!res.ok) return [];
    return res.json();
  }

  /* ── agent_runs (progress tracker record the UI polls) ── */

  async function createRun(projectId) {
    const now = Date.now();
    const row = {
      project_id: projectId, status: 'running', stage: 'look', percent: 0,
      stages: [{ stage: 'look', enteredAt: now }], log: [],
      summary: '', started_at: now, updated_at: now
    };
    const res = await rest(`/agent_runs`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([row])
    });
    if (!res.ok) return null;                 // tracker is best-effort; never block the loop
    const rows = await res.json().catch(() => []);
    return rows[0] || null;
  }

  async function updateRun(id, patch) {
    if (!id) return;
    const res = await rest(`/agent_runs?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ updated_at: Date.now(), ...patch })
    });
    return res.ok;
  }

  /* ── agent_error_log (step-level failure details) ── */

  async function logError({ projectId, runId, stepNumber, errorMessage, errorStack, toolName }) {
    try {
      const row = {
        project_id: projectId,
        run_id: runId || null,
        step_number: stepNumber || 0,
        error_message: String(errorMessage || '').slice(0, 2000),
        error_stack: errorStack ? String(errorStack).slice(0, 5000) : null,
        tool_name: toolName || null,
        created_at: Date.now()
      };
      await rest(`/agent_error_log`, {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([row])
      });
    } catch { /* never block the loop for logging */ }
  }

  async function pullErrorLog(projectId, limit = 50) {
    const res = await rest(
      `/agent_error_log?project_id=eq.${encodeURIComponent(projectId)}&order=created_at.desc&limit=${limit}`);
    if (!res.ok) return [];
    return res.json();
  }

  async function ping() {
    const res = await rest(`/projects?select=id&limit=1`, {}, 6000);
    return res.ok;
  }

  return {
    pullProjects, pullProject, setSuggestion,
    addWorklog, pullWorklog,
    pendingApprovals, createApproval,
    pullContext, createRun, updateRun,
    logError, pullErrorLog,
    rowToProject, ping
  };
}

module.exports = { makeSupabase };
