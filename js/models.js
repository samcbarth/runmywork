const Models = (() => {
  function createProject(data = {}) {
    const now = Date.now();
    return {
      id: crypto.randomUUID(),
      title: data.title || 'Untitled Project',
      description: data.description || '',
      status: data.status || 'active',
      priority: data.priority || 'medium',
      tags: data.tags || [],
      createdAt: now,
      updatedAt: now,
      statusHistory: [{ status: data.status || 'active', enteredAt: now, note: data.note || '' }],
      sessions: [],
      totalMinutes: 0,
      blockedReason: data.blockedReason || '',
      snoozedUntil: null,
      links: [],
      tasks: []
    };
  }

  function currentStatusEntry(project) {
    return project.statusHistory[project.statusHistory.length - 1];
  }

  function appendStatus(project, status, note = '') {
    project.statusHistory.push({ status, enteredAt: Date.now(), note });
    project.status = status;
    project.updatedAt = Date.now();
    return project;
  }

  function timeInCurrentStatus(project) {
    return Date.now() - currentStatusEntry(project).enteredAt;
  }

  function _sumStatusTime(project, targetStatus) {
    let total = 0;
    const h = project.statusHistory;
    for (let i = 0; i < h.length; i++) {
      if (h[i].status !== targetStatus) continue;
      const start = h[i].enteredAt;
      const end = i < h.length - 1 ? h[i + 1].enteredAt : Date.now();
      total += end - start;
    }
    return total;
  }

  function timeBlockedTotal(project) { return _sumStatusTime(project, 'blocked'); }
  function timeIdleTotal(project)    { return _sumStatusTime(project, 'idle'); }

  function formatDuration(minutes) {
    if (!minutes || minutes < 1) return '—';
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  function formatDays(ms) {
    const days = Math.floor(ms / 86400000);
    if (days === 0) {
      const hours = Math.floor(ms / 3600000);
      if (hours === 0) {
        const mins = Math.floor(ms / 60000);
        return mins < 2 ? 'just now' : `${mins}m`;
      }
      return `${hours}h`;
    }
    return days === 1 ? '1 day' : `${days} days`;
  }

  function formatDate(epochMs) {
    if (!epochMs) return '';
    return new Date(epochMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function formatDateTime(epochMs) {
    if (!epochMs) return '';
    return new Date(epochMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function getNotifiableProjects(projects, settings) {
    const now = Date.now();
    const blockedMs = ((settings.thresholds && settings.thresholds.blockedDaysWarning) || 3) * 86400000;
    const idleMs    = ((settings.thresholds && settings.thresholds.idleDaysWarning)    || 7) * 86400000;

    return projects.filter(p => {
      if (p.status === 'done' || p.status === 'archived') return false;
      if (p.snoozedUntil && p.snoozedUntil > now) return false;
      const timeIn = timeInCurrentStatus(p);
      if (p.status === 'blocked' && timeIn >= blockedMs) return true;
      if (p.status === 'idle'    && timeIn >= idleMs)    return true;
      return false;
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    createProject, currentStatusEntry, appendStatus,
    timeInCurrentStatus, timeBlockedTotal, timeIdleTotal,
    formatDuration, formatDays, formatDate, formatDateTime,
    getNotifiableProjects, escapeHtml
  };
})();
