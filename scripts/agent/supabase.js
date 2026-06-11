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
      summary: r.summary || '',
      status: r.status, priority: r.priority, tags: r.tags || [],
      createdAt: r.created_at, updatedAt: r.updated_at,
      statusHistory: r.status_history || [],
      sessions: r.sessions || [], totalMinutes: r.total_minutes || 0,
      blockedReason: r.blocked_reason || '', snoozedUntil: r.snoozed_until ?? null,
      links: r.links || [], tasks: r.tasks || [],
      aiSuggestion: r.ai_suggestion ?? null, aiRequested: !!r.ai_requested,
      targetRepo: r.target_repo || '',
      liveUrl: r.live_url || '',
      previewUrl: r.preview_url || '',
      cadenceMinutes: r.cadence_minutes ?? 180,
      cadenceWindow: r.cadence_window ?? null,
      rulesPath: r.rules_path || '.runmywork/rules.md',
      rolesEnabled: r.roles_enabled || null,
      autoRunDisabled: !!r.auto_run_disabled,
      archivedAt: r.archived_at ?? null
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

  // Recently REJECTED proposals of one type — used to stop the agent re-filing a
  // claim the human already turned down with the same evidence.
  async function rejectedApprovals(projectId, actionType, limit = 20) {
    const res = await rest(
      `/approvals?project_id=eq.${encodeURIComponent(projectId)}&status=eq.rejected&action_type=eq.${encodeURIComponent(actionType)}&order=created_at.desc&limit=${limit}&select=payload,created_at`);
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

  async function createRun(projectId, mode) {
    const now = Date.now();
    const row = {
      project_id: projectId, status: 'running', stage: 'planning', percent: 0,
      stages: [{ stage: 'planning', enteredAt: now }], log: [],
      summary: '', started_at: now, updated_at: now
    };
    const res = await rest(`/agent_runs`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([row])
    });
    if (!res.ok) return null;                 // tracker is best-effort; never block the loop
    const rows = await res.json().catch(() => []);
    const created = rows[0] || null;
    // Stamp the action mode in a SEPARATE patch. Keeping it out of the insert means
    // a pre-migration schema (no `mode` column) still gets a working tracker run —
    // only the mode field fails to persist, never the row itself.
    if (created && mode) { try { await updateRun(created.id, { mode }); } catch { /* column may not exist yet */ } }
    return created;
  }

  // Newest run for a project (used to derive the next mode to execute).
  async function latestRun(projectId) {
    const res = await rest(
      `/agent_runs?project_id=eq.${encodeURIComponent(projectId)}&order=started_at.desc&limit=1`);
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return rows[0] || null;
  }

  // Write-phase gate. Returns { authorized, mode, plan } describing whether the
  // agent currently has human sign-off to run a write mode. An approved
  // `authorize_mode` proposal writes a worklog row kind 'mode_authorized'; that
  // token is valid until a NEWER planning run supersedes it (a new plan must be
  // re-approved before the next write phase).
  async function modeAuthorization(projectId) {
    const wlRes = await rest(
      `/worklog?project_id=eq.${encodeURIComponent(projectId)}&kind=eq.mode_authorized&order=created_at.desc&limit=1`);
    if (!wlRes.ok) return { authorized: false };
    const wl = (await wlRes.json().catch(() => []))[0];
    if (!wl) return { authorized: false };
    const authAt = wl.created_at || 0;
    const detail = wl.detail || {};

    // Superseded if a planning run started after this authorization.
    const planRes = await rest(
      `/agent_runs?project_id=eq.${encodeURIComponent(projectId)}&mode=eq.planning&started_at=gt.${authAt}&select=id&limit=1`);
    if (planRes.ok) {
      const newer = await planRes.json().catch(() => []);
      if (newer.length) return { authorized: false };
    }
    return { authorized: true, mode: detail.mode || null, plan: detail.plan || '', at: authAt };
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
    pendingApprovals, rejectedApprovals, createApproval,
    pullContext, createRun, updateRun, latestRun, modeAuthorization,
    logError, pullErrorLog,
    rowToProject, ping
  };
}

module.exports = { makeSupabase };
