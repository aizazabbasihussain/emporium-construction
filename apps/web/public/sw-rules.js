/* global self */
/* Spec P1-20 BR-1: what the service worker may cache. Loaded by sw.js with importScripts. */
(function (scope) {
  var CACHE = 'ops-shell-v1';
  var SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
  var ASSET_KINDS = ['script', 'style', 'font', 'image', 'manifest'];

  /**
   * How a request is answered:
   *   'shell'   page navigation: network first, the cached shell when offline
   *   'hashed'  built files under /assets/ (content-hashed): cache first
   *   'asset'   other scripts, styles, fonts, images: network first, cache when offline
   *   null      everything else, above all API calls and every write: straight to the network
   * Only GET requests to this site's own address are ever cached.
   */
  function strategyFor(method, url, mode, destination, origin) {
    if (method !== 'GET') return null;
    var parsed = new URL(url);
    if (parsed.origin !== origin) return null;
    if (mode === 'navigate') return 'shell';
    if (ASSET_KINDS.indexOf(destination) === -1) return null;
    return parsed.pathname.indexOf('/assets/') === 0 ? 'hashed' : 'asset';
  }

  scope.swRules = { CACHE: CACHE, SHELL: SHELL, strategyFor: strategyFor };
})(self);
