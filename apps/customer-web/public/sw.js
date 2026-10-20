/**
 * The service worker.
 *
 * It exists for one reason: a push message has to be shown when the page is
 * not open, and only the service worker can do that.
 *
 * The payload arrives **encrypted**, and the browser decrypts it for us — the
 * private key never left the browser — so `event.data.json()` is the message
 * the platform sent, already in the clear.
 */

self.addEventListener('install', () => {
  // A new worker takes over from the old one without waiting for every tab to
  // close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * A push arrived.
 *
 * The title and the body are what the platform chose. Nothing is added to
 * them here: a message that says more than the platform said is a message the
 * platform cannot take back.
 */
self.addEventListener('push', (event) => {
  let payload = { title: 'Vyloop', body: '', url: '/' };

  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      // A payload that is not JSON is still a message. It is shown as it
      // arrived rather than dropped, because a message the customer cannot see
      // is a message that was never sent.
    }
  }

  const title = payload.title || 'Vyloop';
  const options = {
    body: payload.body || '',
    icon: '/brand/default.jpg',
    badge: '/brand/default.jpg',
    data: { url: payload.url || '/' },
    tag: payload.tag || undefined,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/**
 * The customer tapped the notification.
 *
 * The app is focused if it is open, and opened otherwise. Either way the
 * customer lands on the page the message pointed at.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
