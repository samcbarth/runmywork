const Store = (() => {
  const KEYS = {
    projects:   'tracker_projects',
    settings:   'tracker_settings',
    session:    'tracker_active_session',
    githubCfg:  'tracker_github_config',
    githubSha:  'tracker_github_sha'
  };

  const DEFAULT_SETTINGS = {
    notificationsEnabled: false,
    thresholds: { blockedDaysWarning: 3, idleDaysWarning: 7, dailyReminderTime: '09:00' },
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
    const idleMs = ((settings.thresholds && settings.thresholds.idleDaysWarning) || 7) * 86400000;
    const projects = getProjects();
    let changed = false;

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
        changed = true;
      }
    });

    if (changed) _saveProjects(projects);
    return getProjects();
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

/* ── GitHub sync ─────────────────────────────────────────────────── */

const GithubSync = (() => {
  let _pushing = false;
  const REPO = 'samcbarth/runmywork';

  function getConfig() {
    try {
      const stored = JSON.parse(localStorage.getItem(Store.KEYS.githubCfg) || '{}');
      return { pat: stored.pat || '', repo: stored.repo || REPO };
    } catch { return { pat: '', repo: REPO }; }
  }

  function saveConfig(pat, repo) {
    localStorage.setItem(Store.KEYS.githubCfg, JSON.stringify({ pat, repo: repo || REPO }));
  }

  function isConfigured() {
    return !!getConfig().pat;
  }

  function _sha() { return localStorage.getItem(Store.KEYS.githubSha) || null; }
  function _setSha(sha) { localStorage.setItem(Store.KEYS.githubSha, sha); }

  function _b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
  function _b64decode(str) { return decodeURIComponent(escape(atob(str.replace(/\s/g, '')))); }

  function _applyData(data, sha) {
    if (sha) _setSha(sha);
    if (Array.isArray(data.projects)) {
      localStorage.setItem(Store.KEYS.projects, JSON.stringify(data.projects));
    }
    if (data.settings) {
      // Bootstrap PAT onto this device if found in data.json
      if (data.settings.githubPat) {
        saveConfig(data.settings.githubPat, data.settings.githubRepo || REPO);
      }
      const local = Store.getSettings();
      Store.saveSettings({
        ...local,
        ntfyTopic:  data.settings.ntfyTopic  || local.ntfyTopic  || '',
        thresholds: data.settings.thresholds || local.thresholds
      });
    }
  }

  async function pull() {
    const { repo } = getConfig();
    // Always try unauthenticated first — works for public repos, bootstraps PAT on new devices
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/contents/data.json`,
        { headers: { Accept: 'application/vnd.github.v3+json' } });
      if (res.ok) {
        const file = await res.json();
        _applyData(JSON.parse(_b64decode(file.content)), file.sha);
        return { ok: true };
      }
    } catch { /* fall through to authenticated */ }

    // Fall back to authenticated pull
    const { pat } = getConfig();
    if (!pat) return { ok: false, reason: 'not-configured' };
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/contents/data.json`,
        { headers: { Authorization: `token ${pat}`, Accept: 'application/vnd.github.v3+json' } });
      if (res.status === 404) return { ok: false, reason: 'not-found' };
      if (!res.ok) return { ok: false, reason: `http-${res.status}` };
      const file = await res.json();
      _applyData(JSON.parse(_b64decode(file.content)), file.sha);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  async function push() {
    if (_pushing) return { ok: false, reason: 'busy' };
    const { pat, repo } = getConfig();
    if (!pat) return { ok: false, reason: 'not-configured' };

    _pushing = true;
    try {
      const settings = Store.getSettings();
      const data = {
        projects: Store.getProjects(),
        settings: {
          ntfyTopic:  settings.ntfyTopic  || '',
          thresholds: settings.thresholds || {},
          githubPat:  pat,        // stored here so other devices bootstrap automatically
          githubRepo: repo
        },
        syncedAt: Date.now()
      };
      const content = _b64encode(JSON.stringify(data, null, 2));
      const sha = _sha();

      const res = await fetch(
        `https://api.github.com/repos/${repo}/contents/data.json`,
        {
          method: 'PUT',
          headers: {
            Authorization:   `token ${pat}`,
            Accept:          'application/vnd.github.v3+json',
            'Content-Type':  'application/json'
          },
          body: JSON.stringify({
            message: `sync ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
            content,
            ...(sha ? { sha } : {})
          })
        }
      );

      if (res.status === 409) {
        // SHA conflict — re-pull and retry once
        await pull();
        _pushing = false;
        return push();
      }

      if (!res.ok) { _pushing = false; return { ok: false, reason: `http-${res.status}` }; }

      const result = await res.json();
      _setSha(result.content.sha);
      _pushing = false;
      return { ok: true };
    } catch (e) {
      _pushing = false;
      return { ok: false, reason: e.message };
    }
  }

  return { getConfig, saveConfig, isConfigured, pull, push };
})();
