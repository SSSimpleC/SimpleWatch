/* global self, caches */
// Authenticated online playback gains nothing from an old offline HTML shell.
// Retire only our shell caches; leave all requests to the browser.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("simplewatch-shell-"))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
// No fetch listener, no navigation fallback and no automatic page reload.
