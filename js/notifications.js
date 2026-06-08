const Notifications = (() => {
  // VAPID public key (safe to embed; the private half lives only as a Supabase
  // edge secret). Generated with Node crypto; matches VAPID_PUBLIC_KEY in send-push.
  const VAPID_PUBLIC_KEY = 'BPYIBqHlPDK_3kefKQZviZBjXCK0yWnQWlSBxRrrGNsErRcWlMcKaxV9ZTC_pbsKcuvhViMhgxG_765PfTIpmpM';

  function _urlB64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // Subscribe this installed PWA / browser to Web Push and store the subscription
  // in Supabase so the agent (in the cloud) can push to it even when the app is
  // closed. Idempotent — re-subscribing just re-saves the same endpoint.
  async function subscribeToPush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
      if (Notification.permission !== 'granted') return false;
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: _urlB64ToUint8Array(VAPID_PUBLIC_KEY)
        });
      }
      const json = sub.toJSON();
      if (!json.keys) return false;
      await Sync.savePushSubscription({ endpoint: sub.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth });
      return true;
    } catch (e) {
      console.warn('Push subscribe failed:', e);
      return false;
    }
  }

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
    // Wire up closed-app delivery: subscribe to Web Push so the cloud agent can
    // reach the phone even when the PWA isn't open.
    if (perm === 'granted') subscribeToPush();
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

  return { checkOnOpen, requestPermission, tryRegisterPeriodicSync, notifyAgentRun, subscribeToPush };
})();
