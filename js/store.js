const Store = (() => {
  const KEYS = {
    projects:   'tracker_projects',
    settings:   'tracker_settings',
    session:    'tracker_active_session'
  };

  const DEFAULT_SETTINGS = {
    notificationsEnabled: false,
    thresholds: { blockedDaysWarning: 1, idleDaysWarning: 1, dailyReminderTime: '09:00' },
    lastNotificationCheck: 0,
    theme: 'auto'
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
    setTimeout(() => App.syncPush(), 0);
    return project;
  }

  function deleteProject(id) {
    _saveProjects(getProjects().filter(p => p.id !== id));
    _deleteNotifyCache(id);
    Sync.remove(id);                       // upserts never delete — drop the row explicitly
    setTimeout(() => App.syncPush(), 0);
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
    setTimeout(() => App.syncPush(), 0);
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
    setTimeout(() => App.syncPush(), 0);
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
        thresholds: { ...DEFAULT_SETTINGS.thresholds, ...(stored.thresholds || {}) }
      };
    } catch { return { ...DEFAULT_SETTINGS }; }
  }

  function saveSettings(settings) {
    localStorage.setItem(KEYS.settings, JSON.stringify(settings));
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

  return {
    getProjects, getProject, saveProject, deleteProject,
    addSession, deleteSession, runAutoIdleDetection,
    getSettings, saveSettings,
    getActiveSession, saveActiveSession, clearActiveSession,
    exportData, importData, clearAll,
    KEYS
  };
})();

/* ── Supabase sync ───────────────────────────────────────────────── */

const Sync = (() => {
  // Public-by-design connection info, committed to the repo so every device is
  // synced with zero setup. The anon key is SAFE to embed — Row Level Security
  // governs access. NEVER put the service_role key (or any secret) here.
  // ↓↓↓ Fill these in from your Supabase project (Settings → API). ↓↓↓
  const SUPABASE_URL      = 'https://YOUR-PROJECT-REF.supabase.co';
  const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY';

  const NTFY_TOPIC = 'rmw-sam-9k2x7p';   // hardcoded — subscribe to this in the ntfy app

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
        ntfyTopic:  settingsRow.ntfy_topic || local.ntfyTopic || '',
        thresholds: settingsRow.thresholds || local.thresholds
      });
    }
  }

  async function pull() {
    if (!isConfigured()) return { ok: false, reason: 'not-configured' };
    try {
      const [pRes, sRes] = await Promise.all([
        _fetchWithTimeout(`${REST}/projects?select=*`, { headers: HEADERS }),
        _fetchWithTimeout(`${REST}/settings?id=eq.1&select=*`, { headers: HEADERS })
      ]);
      if (!pRes.ok) return { ok: false, reason: `http-${pRes.status}` };
      const projectRows = await pRes.json();
      const settingsRow = sRes.ok ? (await sRes.json())[0] : null;
      _applyData(projectRows, settingsRow);
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
        body: JSON.stringify([{ id: 1, ntfy_topic: NTFY_TOPIC, thresholds: settings.thresholds || {} }])
      });
      _pushing = false;
      if (!sRes.ok) return { ok: false, reason: `settings http-${sRes.status}` };
      return { ok: true };
    } catch (e) {
      _pushing = false;
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

  return { pull, push, remove, isConfigured, rowToProject, projectToRow, NTFY_TOPIC };
})();
