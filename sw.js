//
// Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
//
// TOPA service worker: lets the app open and show the last listings with no signal.
// The page, its code and events.json load fresh when online and fall back to the saved copy when not.
// Icons come from the cache first. Requests to other sites (Apple Music) pass straight through.

// the cache is named after the app version (app.js registers this file as sw.js?v=<VERSION>)
const VERSION = new URL(location.href).searchParams.get("v") || "dev";
const CACHE = `topa-${VERSION}`;
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./data.js",
  "./app.js",
  "./events.json",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()),
  );
});

// drop caches from older versions
self.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// fetch and keep a copy; when offline, use the copy
// "no-cache" makes the browser check with the server instead of reusing its own saved copy
// (a quick "not modified" reply when nothing changed), so updates show up on the next load
const fresh = (request, key = request) =>
  fetch(request, { cache: "no-cache" })
    .then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(key, copy));
      return response;
    })
    .catch(() => caches.match(key));

const cachedFirst = request => caches.match(request).then(hit => hit || fresh(request));

self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;

  let response;
  if (url.pathname.endsWith("/events.json"))
    response = fresh(request, "./events.json"); // one copy, whatever ?v= says
  else if (request.mode === "navigate")
    response = fresh(request).then(r => r || caches.match("./index.html"));
  else if (/\.(js|css|json)$/.test(url.pathname)) response = fresh(request);
  else response = cachedFirst(request);

  event.respondWith(response.then(r => r || Response.error()));
});
