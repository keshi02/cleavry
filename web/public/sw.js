// Self-unregistering kill-switch.
//
// An earlier version of this service worker cached `eraser.html` and
// served it for any request that didn't match the SHELL list — which
// silently broke the new /en and /ja landing pages, sending those
// URLs to the editor instead. PWA / offline support is disabled for
// now until the caching strategy is rewritten properly.
//
// Existing users who already have the old SW registered will pick
// this file up on next visit, drop every cache, unregister
// themselves, and reload — leaving a clean no-SW state.

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Drop every cache this origin has accumulated.
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    // Unregister this SW from the browser.
    await self.registration.unregister();
    // Force any open tabs to reload so they pick up the no-SW state.
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.navigate(client.url);
  })());
});

// Fall through to the network for everything; we don't want to cache
// anything during the cleanup window.
self.addEventListener('fetch', () => { /* no-op */ });
