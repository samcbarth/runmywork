const CACHE = 'runmywork-v7';
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/models.js',
  './js/store.js',
  './js/notifications.js',
  './js/app.js',
  './js/views/dashboard.js',
  './js/views/project-form.js',
  './js/views/project-detail.js',
  './js/views/session-modal.js',
  './js/views/settings.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

/* ── Notifications from page ── */

self.addEventListener('message', e => {
  if (e.data?.type === 'CHECK_NOTIFICATIONS') {
    e.waitUntil(_checkNotifications(e.data.payload));
  }
});

async function _checkNotifications(payload) {
  if (!payload || !payload.projects) return;
  const { projects, settings } = payload;

  const blockedMs = ((settings.thresholds && settings.thresholds.blockedDaysWarning) || 3) * 86400000;
  const idleMs    = ((settings.thresholds && settings.thresholds.idleDaysWarning)    || 7) * 86400000;
  const now = Date.now();

  for (const p of projects) {
    if (p.status === 'done' || p.status === 'archived') continue;
    if (p.snoozedUntil && p.snoozedUntil > now) continue;

    const last = p.statusHistory[p.statusHistory.length - 1];
    if (!last) continue;
    const timeIn = now - last.enteredAt;

    let shouldNotify = false;
    let body = '';

    if (p.status === 'blocked' && timeIn >= blockedMs) {
      const days = Math.floor(timeIn / 86400000);
      body = `Blocked for ${days} day${days !== 1 ? 's' : ''}${p.blockedReason ? ' — ' + p.blockedReason : ''}`;
      shouldNotify = true;
    } else if (p.status === 'idle' && timeIn >= idleMs) {
      const days = Math.floor(timeIn / 86400000);
      body = `Idle for ${days} day${days !== 1 ? 's' : ''} — no recent activity`;
      shouldNotify = true;
    }

    if (shouldNotify) {
      await self.registration.showNotification(p.title, {
        body,
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
        data: { projectId: p.id },
        tag: `project-${p.id}`,
        renotify: false
      });
    }
  }
}

/* ── Periodic Background Sync ── */

self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-projects') {
    e.waitUntil(_checkFromIDB());
  }
});

async function _checkFromIDB() {
  let projects = [];
  let settings = {};

  try {
    const db = await _openIDB();
    const tx = db.transaction('notify_cache', 'readonly');
    const store = tx.objectStore('notify_cache');
    projects = await _idbGetAll(store);
  } catch { return; }

  await _checkNotifications({ projects, settings });
}

function _openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tracker_notify_db', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('notify_cache', { keyPath: 'id' });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = reject;
  });
}

function _idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = reject;
  });
}

/* ── Notification click ── */

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const projectId = e.notification.data?.projectId;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      if (clients.length > 0) {
        const client = clients[0];
        client.focus();
        if (projectId) client.postMessage({ type: 'OPEN_PROJECT', projectId });
        return;
      }
      const url = projectId ? `./#project/${projectId}` : './';
      return self.clients.openWindow(url);
    })
  );
});
