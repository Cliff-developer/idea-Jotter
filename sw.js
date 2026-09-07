const CACHE = 'idea-jotter-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).catch(() => cached))
  );
});

// Best-effort background check, only fires on browsers that support Periodic
// Background Sync for installed PWAs (notably Chrome on Android). This lets
// deadline reminders have a chance to fire even if the app hasn't been
// opened recently — it is not a guarantee, since the OS can still decide
// not to wake the browser.
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'check-deadlines') {
    event.waitUntil(checkDeadlinesFromDB());
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow('./index.html');
    })
  );
});

// Minimal read-only IndexedDB check so the service worker can fire
// notifications without the page being open.
function checkDeadlinesFromDB() {
  return new Promise((resolve) => {
    const req = indexedDB.open('idea-jotter-db', 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('entries', 'readwrite');
      const store = tx.objectStore('entries');
      const getAll = store.getAll();
      getAll.onsuccess = async () => {
        const entries = getAll.result || [];
        const now = Date.now();
        const offsets = [
          { stage: '1h', ms: 60 * 60 * 1000, label: '1 hour before' },
          { stage: '15m', ms: 15 * 60 * 1000, label: '15 minutes before' },
          { stage: 'due', ms: 0, label: 'at the deadline' }
        ];
        for (const entry of entries) {
          if (entry.type !== 'task' || !entry.deadline || entry.done) continue;
          const deadlineTs = new Date(entry.deadline).getTime();
          entry.reminders = entry.reminders || [];
          let changed = false;
          for (const { stage, ms, label } of offsets) {
            const fireAt = deadlineTs - ms;
            const sent = entry.reminders.some((r) => r.stage === stage && r.sent);
            if (!sent && fireAt <= now && fireAt > now - 24 * 60 * 60 * 1000) {
              const title = stage === 'due' ? 'Deadline reached' : 'Deadline coming up';
              const body = (entry.text || 'Task').slice(0, 120) + (stage === 'due' ? '' : ` — ${label}`);
              await self.registration.showNotification(title, {
                body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: entry.id + '-' + stage
              });
              const existing = entry.reminders.find((r) => r.stage === stage);
              if (existing) existing.sent = true; else entry.reminders.push({ stage, sent: true });
              changed = true;
            }
          }
          if (changed) store.put(entry);
        }
        resolve();
      };
      getAll.onerror = () => resolve();
    };
    req.onerror = () => resolve();
  });
}
