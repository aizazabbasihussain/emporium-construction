/* global self, caches, importScripts */
/* Spec P1-20 BR-1: caches the app shell so it opens offline. Never caches API calls or writes. */
importScripts('/sw-rules.js');

var rules = self.swRules;

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(rules.CACHE)
      .then(function (cache) {
        return cache.addAll(rules.SHELL);
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (name) {
              return name !== rules.CACHE;
            })
            .map(function (name) {
              return caches.delete(name);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

function networkFirst(request, cacheKey) {
  return fetch(request)
    .then(function (response) {
      if (response.ok) {
        var copy = response.clone();
        caches.open(rules.CACHE).then(function (cache) {
          return cache.put(cacheKey, copy);
        });
      }
      return response;
    })
    .catch(function () {
      return caches.match(cacheKey).then(function (cached) {
        return cached || Response.error();
      });
    });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var strategy = rules.strategyFor(
    request.method,
    request.url,
    request.mode,
    request.destination,
    self.location.origin,
  );
  if (strategy === null) return;
  if (strategy === 'shell') {
    // Every page of this single-page app is the same shell.
    event.respondWith(networkFirst(request, '/'));
  } else if (strategy === 'hashed') {
    event.respondWith(
      caches.match(request).then(function (cached) {
        return cached || networkFirst(request, request);
      }),
    );
  } else {
    event.respondWith(networkFirst(request, request));
  }
});
