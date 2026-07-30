"use strict";

const CACHE_PREFIX = "hcn-console-shell-";
const CACHE_NAME = CACHE_PREFIX + "v11";
const SHELL_PATHNAMES = Object.freeze([
  "/hcn/",
  "/hcn/app.css",
  "/hcn/app.js",
  "/hcn/manifest.webmanifest"
]);
const SHELL_PATHS = Object.freeze([
  ...SHELL_PATHNAMES,
  "/hcn/?shell=v11",
  "/hcn/app.css?shell=v11",
  "/hcn/app.js?shell=v11",
  "/hcn/manifest.webmanifest?shell=v11"
]);
const SHELL_PATH_SET = new Set(SHELL_PATHNAMES);
const BYPASS_PREFIXES = Object.freeze([
  "/api/",
  "/auth/",
  "/hcn/auth/",
  "/hcn/api/"
]);

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(SHELL_PATHS);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (name) {
              return name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME;
            })
            .map(function (name) {
              return caches.delete(name);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers.has("authorization")) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PREFIXES.some(function (prefix) {
    return url.pathname.startsWith(prefix);
  })) return;
  if (!SHELL_PATH_SET.has(url.pathname)) return;

  event.respondWith(
    caches.match(request).then(function (cached) {
      if (cached) return cached;

      return fetch(request).then(function (response) {
        if (!response.ok || response.type !== "basic") return response;
        return caches.open(CACHE_NAME).then(function (cache) {
          return cache.put(request, response.clone()).then(function () {
            return response;
          });
        });
      });
    })
  );
});
