"use strict";

const CACHE_PREFIX = "hcn-console-shell-";

self.addEventListener("install", function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (name) {
              return name.startsWith(CACHE_PREFIX);
            })
            .map(function (name) {
              return caches.delete(name);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
      .then(function () {
        return self.clients.matchAll({
          includeUncontrolled: true,
          type: "window"
        });
      })
      .then(function (clients) {
        return Promise.all(
          clients.map(function (client) {
            return client.navigate("/hcn/");
          })
        );
      })
      .then(function () {
        return self.registration.unregister();
      })
  );
});
