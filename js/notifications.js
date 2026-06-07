const Notifications = (() => {
  async function checkOnOpen() {
    const settings = Store.getSettings();
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

    const now = Date.now();
    if (now - (settings.lastNotificationCheck || 0) < 3600000) return;

    const { projects } = Store.runAutoIdleDetection();
    const notifiable = Models.getNotifiableProjects(projects, settings);
    if (notifiable.length === 0) return;

    let reg = null;
    try { reg = await navigator.serviceWorker?.ready; } catch { /* no SW */ }

    for (const project of notifiable) {
      const timeIn = Models.timeInCurrentStatus(project);
      const days = Math.floor(timeIn / 86400000);
      const dayWord = days === 1 ? 'day' : 'days';
      const body = project.status === 'blocked'
        ? `Blocked for ${days} ${dayWord}${project.blockedReason ? ' — ' + project.blockedReason : ''}`
        : `Idle for ${days} ${dayWord} — no recent activity`;

      const opts = {
        body,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        data: { projectId: project.id },
        tag: `project-${project.id}`,
        renotify: false,
        requireInteraction: false
      };

      try {
        if (reg) reg.showNotification(project.title, opts);
        else new Notification(project.title, opts);
      } catch { /* silent */ }
    }

    settings.lastNotificationCheck = now;
    Store.saveSettings(settings);
  }

  // Fire a notification about an agent run (started / finished / failed). Uses the
  // SW registration when available so a click can reopen the project (see sw.js
  // notificationclick → OPEN_PROJECT); falls back to a page Notification otherwise.
  async function notifyAgentRun({ title, body, projectId, tag }) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const opts = {
      body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { projectId },
      tag: tag || 'rmw-agent-run',
      renotify: true,
      requireInteraction: false
    };
    let reg = null;
    try { reg = await navigator.serviceWorker?.ready; } catch { /* no SW */ }
    try {
      if (reg) {
        await reg.showNotification(title, opts);
      } else {
        const n = new Notification(title, opts);
        n.onclick = () => {
          window.focus();
          if (projectId) App.navigate(`project/${projectId}`);
          n.close();
        };
      }
    } catch { /* silent */ }
  }

  async function requestPermission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    const perm = await Notification.requestPermission();
    const settings = Store.getSettings();
    settings.notificationsEnabled = perm === 'granted';
    Store.saveSettings(settings);
    return perm;
  }

  async function tryRegisterPeriodicSync(reg) {
    if (!('periodicSync' in reg)) return;
    try {
      const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (status.state === 'granted') {
        await reg.periodicSync.register('check-projects', { minInterval: 86400000 });
      }
    } catch { /* not supported */ }
  }

  return { checkOnOpen, requestPermission, tryRegisterPeriodicSync, notifyAgentRun };
})();
