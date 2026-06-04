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

      _sendNtfy(project.title, body, project.status === 'blocked' ? 'high' : 'default').catch(() => {});
    }

    settings.lastNotificationCheck = now;
    Store.saveSettings(settings);
  }

  function ping(title, body, priority) {
    _sendNtfy(title, body, priority).catch(() => {});
  }

  async function _sendNtfy(title, body, priority) {
    await fetch(`https://ntfy.sh/${Sync.NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        'Title':    title,
        'Priority': priority || 'default',
        'Tags':     priority === 'high' ? 'rotating_light' : 'calendar'
      },
      body
    });
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

  return { checkOnOpen, ping, requestPermission, tryRegisterPeriodicSync };
})();
