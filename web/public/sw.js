/*
 * A service worker that does nothing, on purpose (27.24).
 *
 * Chrome will not offer to install a page without one, so this exists to answer that and to answer
 * nothing else: every request goes to the network exactly as it would have.
 *
 * **It must stay this way.** The obvious next step is a cache-first handler, and it would be
 * wrong: this frontend talks to a server the user runs, over a WebRTC connection the app makes
 * itself, and nothing it fetches is stale-tolerant. A cached bundle would also outlive a deploy on
 * a device that never happens to look, which is precisely the failure mode nobody can debug from
 * the other end of a message.
 *
 * `skipWaiting` and `clients.claim` so a replaced worker does not linger for a session — with no
 * caching there is nothing for a new worker to migrate, so taking over at once is free.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
