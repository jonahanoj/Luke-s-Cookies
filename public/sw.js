// Service worker: shows push notifications and opens the right chat on tap.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Luke's Cookies", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Luke's Cookies";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "New message",
      tag: data.tag || data.conversationId || "message",
      renotify: true,
      icon: "/assets/icon-192.png",
      data: { conversationId: data.conversationId || null },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const conversationId = event.notification.data?.conversationId || null;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          client.postMessage({ type: "open-chat", conversationId });
          return;
        }
      }
      await self.clients.openWindow(conversationId ? `/?c=${encodeURIComponent(conversationId)}` : "/");
    })()
  );
});
