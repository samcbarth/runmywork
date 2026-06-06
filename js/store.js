const Store = (() => {
  const KEYS = {
    projects:   'tracker_projects',
    settings:   'tracker_settings',
    session:    'tracker_active_session',
    approvals:  'tracker_approvals'
  };

  const DEFAULT_SETTINGS = {
    notificationsEnabled: false,
    thresholds: { blockedDaysWarning: 1, idleDaysWarning: 1, dailyReminderTime: '09:00' },
    lastNotificationCheck: 0,
    theme: 'auto',
    autoApprove: { add_tasks: false, add_link: false, set_priority: false, set_status: false, set_spec: false }
  };

  /* ── Projects ── */

  function getProjects() {
    try { return JSON.parse(localStorage.getItem(KEYS.projects) || '[]'); }
    catch { return []; }
  }

  function _saveProjects(projects) {
    localStorage.setItem(KEYS.projects, JSON.stringify(projects));
  }

  function getProject(id) {
    return getProjects().find(p => p.id === id) || null;
  }

  function saveProject(project) {
    const projects = getProjects();
    const idx = projects.findIndex(p => p.id === project.id);
    project.updatedAt = Date.now();
    if (idx >= 0) {
      projects[idx] = project;
    } else {
      projects.push(project);
    }
    _saveProjects(projects);
    _writeNotifyCache(project);
    setTimeout(() => App.syncPushProject(project.id), 0);
    return project;
  }

  function deleteProject(id) {
    _saveProjects(getProjects().filter(p => p.id !== id));
    _deleteNotifyCache(id);
    Sync.remove(id);   // upserts never delete — drop the row (cascades worklog/approvals)
  }

  /* ── Sessions ── */

  function addSession(projectId, session) {
    const projects = getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) return null;

    project.sessions.push(session);
    project.totalMinutes = project.sessions.reduce((s, x) => s + (x.durationMinutes || 0), 0);
    project.updatedAt = Date.now();

    if (project.status === 'idle') {
      Models.appendStatus(project, 'active', 'Resumed via session');
    }

    _saveProjects(projects);
    _writeNotifyCache(project);
    setTimeout(() => App.syncPushProject(project.id), 0);
    return project;
  }

  function deleteSession(projectId, sessionId) {
    const projects = getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) return null;

    project.sessions = project.sessions.filter(s => s.id !== sessionId);
    project.totalMinutes = project.sessions.reduce((s, x) => s + (x.durationMinutes || 0), 0);
    project.updatedAt = Date.now();

    _saveProjects(projects);
    setTimeout(() => App.syncPushProject(project.id), 0);
    return project;
  }

  /* ── Auto-idle detection ── */

  function runAutoIdleDetection() {
    const settings = getSettings();
    const idleMs = ((settings.thresholds && settings.thresholds.idleDaysWarning) || 1) * 86400000;
    const projects = getProjects();
    const newlyIdle = [];

    projects.forEach(project => {
      if (project.status !== 'active') return;

      const finishedSessions = project.sessions.filter(s => s.endedAt);
      const lastSession = finishedSessions.sort((a, b) => b.endedAt - a.endedAt)[0];
      const lastActivity = lastSession ? lastSession.endedAt : project.createdAt;

      if (Date.now() - lastActivity > idleMs) {
        const idleStart = lastActivity + idleMs;
        project.statusHistory.push({ status: 'idle', enteredAt: idleStart, note: 'Auto-detected idle' });
        project.status = 'idle';
        project.updatedAt = Date.now();
        newlyIdle.push(project);
      }
    });

    if (newlyIdle.length) _saveProjects(projects);
    return { projects: getProjects(), newlyIdle };
  }

  /* ── Settings ── */

  function getSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(KEYS.settings) || '{}');
      return {
        ...DEFAULT_SETTINGS,
        ...stored,
        thresholds: { ...DEFAULT_SETTINGS.thresholds, ...(stored.thresholds || {}) },
        autoApprove: { ...DEFAULT_SETTINGS.autoApprove, ...(stored.autoApprove || {}) }
      };
    } catch { return { ...DEFAULT_SETTINGS }; }
  }

  function saveSettings(settings) {
    localStorage.setItem(KEYS.settings, JSON.stringify(settings));
  }

  /* ── Approvals cache (pending agent proposals) ── */

  function getApprovals() {
    try { return JSON.parse(localStorage.getItem(KEYS.approvals) || '[]'); }
    catch { return []; }
  }

  function _saveApprovals(approvals) {
    localStorage.setItem(KEYS.approvals, JSON.stringify(approvals || []));
  }

  /* ── Active session (timer) ── */

  function getActiveSession() {
    try { return JSON.parse(localStorage.getItem(KEYS.session)); }
    catch { return null; }
  }

  function saveActiveSession(session) {
    localStorage.setItem(KEYS.session, JSON.stringify(session));
  }

  function clearActiveSession() {
    localStorage.removeItem(KEYS.session);
  }

  /* ── Data export / import ── */

  function exportData() {
    return JSON.stringify({ projects: getProjects(), settings: getSettings() }, null, 2);
  }

  function importData(json) {
    const data = JSON.parse(json);
    if (!Array.isArray(data.projects)) throw new Error('Invalid data format');
    _saveProjects(data.projects);
    if (data.settings) saveSettings(data.settings);
  }

  function clearAll() {
    localStorage.removeItem(KEYS.projects);
    localStorage.removeItem(KEYS.settings);
    localStorage.removeItem(KEYS.session);
    localStorage.removeItem(KEYS.approvals);
    _clearNotifyCache();
  }

  /* ── IndexedDB notify cache (for service worker) ── */

  function _openNotifyDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('no idb')); return; }
      const req = indexedDB.open('tracker_notify_db', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('notify_cache', { keyPath: 'id' });
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = reject;
    });
  }

  async function _writeNotifyCache(project) {
    try {
      const db = await _openNotifyDB();
      const tx = db.transaction('notify_cache', 'readwrite');
      tx.objectStore('notify_cache').put({
        id: project.id,
        title: project.title,
        status: project.status,
        statusHistory: project.statusHistory,
        snoozedUntil: project.snoozedUntil,
        blockedReason: project.blockedReason
      });
    } catch { /* silent */ }
  }

  async function _deleteNotifyCache(id) {
    try {
      const db = await _openNotifyDB();
      const tx = db.transaction('notify_cache', 'readwrite');
      tx.objectStore('notify_cache').delete(id);
    } catch { /* silent */ }
  }

  async function _clearNotifyCache() {
    try {
      const db = await _openNotifyDB();
      const tx = db.transaction('notify_cache', 'readwrite');
      tx.objectStore('notify_cache').clear();
    } catch { /* silent */ }
  }

  // Rewrite the whole notify cache from current projects. Called after Sync.pull
  // so a freshly-synced device/SW has data before the user edits anything (the
  // per-save _writeNotifyCache only covers locally-edited projects).
  async function refreshNotifyCache() {
    try {
      const db = await _openNotifyDB();
      const tx = db.transaction('notify_cache', 'readwrite');
      const store = tx.objectStore('notify_cache');
      store.clear();
      getProjects().forEach(p => store.put({
        id: p.id, title: p.title, status: p.status,
        statusHistory: p.statusHistory, snoozedUntil: p.snoozedUntil,
        blockedReason: p.blockedReason
      }));
    } catch { /* silent */ }
  }

  return {
    getProjects, getProject, saveProject, deleteProject,
    addSession, deleteSession, runAutoIdleDetection,
    getSettings, saveSettings,
    getApprovals, _saveApprovals,
    getActiveSession, saveActiveSession, clearActiveSession,
    exportData, importData, clearAll, refreshNotifyCache,
    KEYS
  };
})();

/* ── Supabase sync ───────────────────────────────────────────────── */

const Sync = (() => {
  // Public-by-design connection info, committed to the repo so every device is
  // synced with zero setup. The anon key is SAFE to embed — Row Level Security
  // governs access. NEVER put the service_role key (or any secret) here.
  // ↓↓↓ Fill these in from your Supabase project (Settings → API). ↓↓↓
  const SUPABASE_URL      = 'https://tmqffprfhavzbaycvxej.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRtcWZmcHJmaGF2emJheWN2eGVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NDE1MTQsImV4cCI6MjA5NjExNzUxNH0.rtcPzaPwo2qMYJdm_sdpOvjEuEuK0O0I6r-pPrqCma4';

  const REST    = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1`;
  const HEADERS = {
    apikey:         SUPABASE_ANON_KEY,
    Authorization:  `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json'
  };

  // Until the placeholders are replaced, sync is a no-op and the app runs
  // purely on localStorage (still fully usable offline).
  function isConfigured() {
    return !/YOUR-(PROJECT-REF|ANON-KEY)/.test(SUPABASE_URL + SUPABASE_ANON_KEY);
  }

  function _fetchWithTimeout(url, opts = {}, ms = 12000) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
  }

  /* ── row ↔ project mapping (single source of truth, camel ↔ snake) ── */
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
  function projectToRow(p) {
    return {
      id: p.id, title: p.title, description: p.description,
      status: p.status, priority: p.priority, tags: p.tags || [],
      created_at: p.createdAt, updated_at: p.updatedAt,
      status_history: p.statusHistory || [],
      sessions: p.sessions || [], total_minutes: p.totalMinutes || 0,
      blocked_reason: p.blockedReason || '', snoozed_until: p.snoozedUntil ?? null,
      links: p.links || [], tasks: p.tasks || [],
      ai_suggestion: p.aiSuggestion ?? null, ai_requested: !!p.aiRequested
    };
  }

  function _applyData(projectRows, settingsRow) {
    if (Array.isArray(projectRows)) {
      localStorage.setItem(Store.KEYS.projects, JSON.stringify(projectRows.map(rowToProject)));
    }
    if (settingsRow) {
      const local = Store.getSettings();
      Store.saveSettings({
        ...local,
        thresholds: settingsRow.thresholds || local.thresholds
      });
    }
  }

  async function pull() {
    if (!isConfigured()) return { ok: false, reason: 'not-configured' };
    try {
      const [pRes, sRes, aRes] = await Promise.all([
        _fetchWithTimeout(`${REST}/projects?select=*`, { headers: HEADERS }),
        _fetchWithTimeout(`${REST}/settings?id=eq.1&select=*`, { headers: HEADERS }),
        _fetchWithTimeout(`${REST}/approvals?status=eq.pending&select=*&order=created_at.desc`, { headers: HEADERS })
      ]);
      if (!pRes.ok) return { ok: false, reason: `http-${pRes.status}` };
      const projectRows = await pRes.json();
      const settingsRow = sRes.ok ? (await sRes.json())[0] : null;
      _applyData(projectRows, settingsRow);
      if (aRes.ok) Store._saveApprovals(await aRes.json());
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
    }
  }

  let _pushing = false;
  async function push() {
    if (!isConfigured()) return { ok: false, reason: 'not-configured' };
    if (_pushing) return { ok: false, reason: 'busy' };

    _pushing = true;
    try {
      const settings = Store.getSettings();
      const rows = Store.getProjects().map(projectToRow);

      // Coarse upsert of the full current state — matches the app's existing
      // whole-document push semantics; dataset is tiny so this is one round-trip.
      if (rows.length) {
        const pRes = await _fetchWithTimeout(`${REST}/projects?on_conflict=id`, {
          method: 'POST',
          headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(rows)
        });
        if (!pRes.ok) {
          const err = await pRes.text().catch(() => '');
          _pushing = false;
          return { ok: false, reason: `${pRes.status}: ${err.slice(0, 120)}` };
        }
      }

      const sRes = await _fetchWithTimeout(`${REST}/settings?on_conflict=id`, {
        method: 'POST',
        headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ id: 1, thresholds: settings.thresholds || {} }])
      });
      _pushing = false;
      if (!sRes.ok) return { ok: false, reason: `settings http-${sRes.status}` };
      return { ok: true };
    } catch (e) {
      _pushing = false;
      return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
    }
  }

  // Single-project upsert — pushes only the row that changed, so a save can
  // never resurrect another device's project from a stale full snapshot (the
  // cross-project clobber that whole-document push() risks). Within one project
  // it's still last-write-wins, which is fine for a single user.
  async function pushProject(id) {
    if (!isConfigured()) return { ok: false, reason: 'not-configured' };
    const project = Store.getProject(id);
    if (!project) return { ok: false, reason: 'no-such-project' };
    try {
      const res = await _fetchWithTimeout(`${REST}/projects?on_conflict=id`, {
        method: 'POST',
        headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([projectToRow(project)])
      });
      return { ok: res.ok, reason: res.ok ? undefined : `http-${res.status}` };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
    }
  }

  // Upserts never delete, so a removed project must be dropped explicitly or the
  // next pull() resurrects it. Called from Store.deleteProject.
  async function remove(id) {
    if (!isConfigured()) return { ok: false, reason: 'not-configured' };
    try {
      const res = await _fetchWithTimeout(`${REST}/projects?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { ...HEADERS, Prefer: 'return=minimal' }
      });
      return { ok: res.ok, reason: res.ok ? undefined : `http-${res.status}` };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /* ── Agent rails: approvals + worklog ──────────────────────────── */

  // Refresh the pending-proposals cache from the server.
  async function pullApprovals() {
    if (!isConfigured()) return { ok: false, reason: 'not-configured' };
    try {
      const res = await _fetchWithTimeout(
        `${REST}/approvals?status=eq.pending&select=*&order=created_at.desc`, { headers: HEADERS });
      if (!res.ok) return { ok: false, reason: `http-${res.status}` };
      Store._saveApprovals(await res.json());
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
    }
  }

  // Mark a proposal approved / rejected / applied. Also drops it from the local
  // pending cache so the UI updates without a round-trip.
  async function decideApproval(id, status) {
    if (!isConfigured()) return { ok: false, reason: 'not-configured' };
    Store._saveApprovals(Store.getApprovals().filter(a => a.id !== id));
    try {
      const res = await _fetchWithTimeout(`${REST}/approvals?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { ...HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify({ status, decided_at: Date.now() })
      });
      return { ok: res.ok, reason: res.ok ? undefined : `http-${res.status}` };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
    }
  }

  // Append an entry to a project's worklog (the agent's journal). Fire-and-forget.
  async function addWorklog(entry) {
    if (!isConfigured()) return { ok: false, reason: 'not-configured' };
    try {
      const res = await _fetchWithTimeout(`${REST}/worklog`, {
        method: 'POST',
        headers: { ...HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify([{ created_at: Date.now(), created_by: 'user', kind: 'note', detail: {}, summary: '', ...entry }])
      });
      return { ok: res.ok, reason: res.ok ? undefined : `http-${res.status}` };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
    }
  }

  // Lazy-load one project's recent worklog (project-detail opens this on demand).
  async function pullWorklog(projectId, limit = 50) {
    if (!isConfigured()) return { ok: false, reason: 'not-configured', entries: [] };
    try {
      const res = await _fetchWithTimeout(
        `${REST}/worklog?project_id=eq.${encodeURIComponent(projectId)}&order=created_at.desc&limit=${limit}`,
        { headers: HEADERS });
      if (!res.ok) return { ok: false, reason: `http-${res.status}`, entries: [] };
      return { ok: true, entries: await res.json() };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message, entries: [] };
    }
  }

  /* ── Project context / knowledge (append-only, versioned) ── */

  // One project's context entries, newest first.
  async function pullContext(projectId, limit = 50) {
    if (!isConfigured()) return { ok: false, reason: 'not-configured', entries: [] };
    try {
      const res = await _fetchWithTimeout(
        `${REST}/project_context?project_id=eq.${encodeURIComponent(projectId)}&order=created_at.desc&limit=${limit}`,
        { headers: HEADERS });
      if (!res.ok) return { ok: false, reason: `http-${res.status}`, entries: [] };
      return { ok: true, entries: await res.json() };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message, entries: [] };
    }
  }

  // Append a context entry (never overwrites — each save is a new version).
  async function addContext(entry) {
    if (!isConfigured()) return { ok: false, reason: 'not-configured' };
    try {
      const res = await _fetchWithTimeout(`${REST}/project_context`, {
        method: 'POST',
        headers: { ...HEADERS, Prefer: 'return=minimal' },
        body: JSON.stringify([{ created_at: Date.now(), created_by: 'user', kind: 'note', content: '', ...entry }])
      });
      return { ok: res.ok, reason: res.ok ? undefined : `http-${res.status}` };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
    }
  }

  /* ── Agent error log ── */

  async function pullErrorLog(projectId, limit = 50) {
    if (!isConfigured()) return { ok: false, reason: 'not-configured', entries: [] };
    try {
      const res = await _fetchWithTimeout(
        `${REST}/agent_error_log?project_id=eq.${encodeURIComponent(projectId)}&order=created_at.desc&limit=${limit}`,
        { headers: HEADERS });
      if (!res.ok) return { ok: false, reason: `http-${res.status}`, entries: [] };
      return { ok: true, entries: await res.json() };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message, entries: [] };
    }
  }

  /* ── Agent runs (progress tracker) ── */

  // The most recent agent run for a project (powers the Domino's-style tracker).
  async function pullLatestRun(projectId) {
    if (!isConfigured()) return { ok: false, reason: 'not-configured', run: null };
    try {
      const res = await _fetchWithTimeout(
        `${REST}/agent_runs?project_id=eq.${encodeURIComponent(projectId)}&order=started_at.desc&limit=1`,
        { headers: HEADERS });
      if (!res.ok) return { ok: false, reason: `http-${res.status}`, run: null };
      const rows = await res.json();
      return { ok: true, run: rows[0] || null };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message, run: null };
    }
  }

  return {
    pull, push, pushProject, remove,
    pullApprovals, decideApproval, addWorklog, pullWorklog,
    pullContext, addContext, pullLatestRun, pullErrorLog,
    isConfigured, rowToProject, projectToRow
  };
})();
