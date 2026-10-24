//
// Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
//
// TOPA Local Music Finder
// Shows listings from events.json (written 3x a day by scripts/fetch_events.py), plays 30-second previews
// from Deezer, and keeps faves on the device. Venue data and the genre map live in data.js.

// ---- Settings and state ----
// the app's version: shown in About, and it names the offline cache, so bumping it refreshes every device
const VERSION = "0.9.6";
const params = new URLSearchParams(location.search);

// the car's browser calls itself "TeslaBrowser/<version>" on Linux; in case a version leaves that out, a Linux
// touchscreen (which almost nothing else is) counts too. ?tesla=1 shows the car-only bits anywhere, for testing.
const IN_TESLA =
  /Tesla/i.test(navigator.userAgent) ||
  (/X11; Linux/.test(navigator.userAgent) &&
    !/Android/.test(navigator.userAgent) &&
    navigator.maxTouchPoints > 0) ||
  params.has("tesla");
const NOW = params.get("now") ? new Date(params.get("now")) : new Date(); // ?now=… pins the date for testing

// what the app saves in the browser (the version number lets a future format change start fresh)
const LOCATION_KEY = "topa.location.v1",
  LISTINGS_KEY = "topa.listings.v1",
  FAVES_KEY = "topa.faves.v1";

const COUNTY = { lat: 34.36, lng: -119.13, county: true }; // stand-in when the browser shares no location

const RADII = [5, 10, 25],
  ANY = 60; // the "Any distance" setting

// localStorage that never throws (private mode, full storage)
const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch (_) {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (_) {
      try {
        localStorage.removeItem(k);
      } catch (__) {}
    }
  },
};

let USER = (s => (s && typeof s.lat === "number" ? s : null))(store.get(LOCATION_KEY)) || COUNTY;

let radius = ANY; // opens at "Any distance" every visit

let SAVED = (s => (s && s.bands && s.venues ? s : { bands: [], venues: [] }))(store.get(FAVES_KEY));

let EVENTS = []; // upcoming shows, soonest first; a show's id is its position here

let status = { c: "loading" }; // c: loading | cached | live | offline; updated: when events.json last changed

// the current page: "Shows", "Bands", "Band:<name>", "Venues", "Venue:<name>", "Show:<id>", "Faves"
let view = (v => (v && v !== "Search" && v !== "Home" ? v : "Shows"))(params.get("view"));

let prev = "Shows"; // the page before, so a show page can highlight where it was opened from

let day = "", // Shows: day button ("tonight", "2026-10-23", "weekend", "all")
  genre = "", // Shows: genre button
  term = "", // Shows: search box
  ssort = "time", // Shows: time | dist
  bsort = "soon", // Bands: soon | az
  vsort = "near", // Venues: near | az
  bandFilter = "",
  venueFilter = "",
  faveTab = "bands"; // Faves: bands | venues

// ---- Listings ----
function normTag(t) {
  return (t || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyGenres(tags) {
  const out = new Set();
  (tags || []).forEach(t => {
    const n = normTag(t);
    if (GENRE_MAP[n]) GENRE_MAP[n].forEach(g => out.add(g));
    else
      for (const k in GENRE_FALLBACK) {
        if (n.includes(k)) out.add(GENRE_FALLBACK[k]);
      }
  });
  return [...out];
}

const isTicketed = t => t.some(x => /ticketed/i.test(x));

const VR_SITE = "https://www.venturarocks.com",
  VR_CAL = VR_SITE + "/Weekly-Gigs.htm";

// "398 N. Moorpark Road, Thousand Oaks" -> "Thousand Oaks" (for listings that came without a town)
const townFromAddress = a => {
  const parts = (a || "").split(",").map(x => x.trim());
  return (
    parts
      .slice(1)
      .reverse()
      .find(x => x && !/^(CA|USA|\d{5})\b/i.test(x)) || ""
  );
};

function toShow(o, rawTags) {
  o.url = o.url || VR_CAL;
  o.city = o.city || townFromAddress(o.address);
  const c = KNOWN_VENUES[o.venue] || CITY_FALLBACK[o.city] || null;
  return {
    ...o,
    lat: c ? c[0] : null,
    lng: c ? c[1] : null,
    tags: classifyGenres(rawTags),
    tix: isTicketed(rawTags),
  };
}

const dayStart = d => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const dropPast = l => l.filter(e => e.startMs >= dayStart(NOW).getTime());

function setEvents(l) {
  const was = view.startsWith("Show:") && EVENTS[+view.slice(5)];
  EVENTS = l.map((e, i) => ({ ...e, id: i }));
  if (was) {
    const m = EVENTS.find(e => e.artist === was.artist && e.startMs === was.startMs);
    if (m && String(m.id) !== view.slice(5)) {
      view = "Show:" + m.id;
      try {
        history.replaceState({ v: view, prev }, "", urlFor(view));
      } catch (_) {}
    }
  }
  setTimeout(queueLookups, 0);
}

async function fetchListings() {
  const last = store.get(LISTINGS_KEY),
    bust = (last && last.updated) || Math.floor(Date.now() / 9e5);
  let r = await fetch("events.json?v=" + encodeURIComponent(bust), { cache: "no-cache" });
  let d = r.ok ? await r.json() : null;
  if (!d || !Array.isArray(d.events) || !d.events.length) throw 0;
  return {
    updated: d.updated,
    events: d.events.map(e => toShow({ ...e, startMs: new Date(e.start).getTime() }, e.tags || [])),
  };
}

// show the saved copy right away (works offline), then swap in the latest events.json
async function load() {
  const c = store.get(LISTINGS_KEY),
    cached = c && Array.isArray(c.events) ? dropPast(c.events) : [];
  setEvents(cached);
  status = cached.length ? { c: "cached", updated: c.updated } : { c: "loading" };
  render();
  if (!(await fetchLatest()) && !cached.length) status = { c: "offline" };
  render();
}

// get the latest events.json and keep a copy for next time; false when offline
async function fetchLatest() {
  try {
    const j = await fetchListings();
    setEvents(dropPast(j.events));
    store.set(LISTINGS_KEY, { ts: Date.now(), updated: j.updated, events: j.events });
    status = { c: "live", updated: j.updated };
    return true;
  } catch (_) {
    return false;
  }
}

// pull-to-refresh: fresh listings in place (same page, day and filters), plus a quiet check for a newer app
async function refresh() {
  countEvent("refresh");
  const ok = await fetchLatest();
  render();
  toast(ok ? "Shows refreshed" : "Couldn't refresh. Check your connection.");
  navigator.serviceWorker
    ?.getRegistration()
    .then(r => r && r.update())
    .catch(() => {});
}

// ---- Formatting helpers ----
const esc = s =>
  String(s ?? "").replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const milesBetween = (a, b, c, d) => {
  const r = x => (x * Math.PI) / 180,
    s = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 7917.6 * Math.asin(Math.sqrt(s));
};

const milesTo = e => (e.lat == null ? null : milesBetween(USER.lat, USER.lng, e.lat, e.lng));

const distanceLabel = e => {
  if (USER.county) return "";
  const m = milesTo(e);
  return m == null ? "" : m < 0.1 ? "here" : m.toFixed(1) + " mi";
};

const inRadius = e => radius >= ANY || (milesTo(e) ?? 1e9) <= radius;

const timeLabel = e => {
  const d = new Date(e.start);
  let h = d.getHours(),
    m = d.getMinutes();
  return (h % 12 || 12) + (m ? ":" + String(m).padStart(2, "0") : "") + (h < 12 ? "am" : "pm");
};

const weekdayLabel = e => new Date(e.start).toLocaleDateString("en-US", { weekday: "short" });

const sameDay = (a, b) => a.toDateString() === b.toDateString();

function weekendDays() {
  const f = dayStart(NOW),
    w = f.getDay();
  if (w !== 5 && w !== 6 && w !== 0) f.setDate(f.getDate() + (5 - w));
  else if (w === 6) f.setDate(f.getDate() - 1);
  else if (w === 0) f.setDate(f.getDate() - 2);
  return [0, 1, 2]
    .map(i => {
      const d = new Date(f);
      d.setDate(f.getDate() + i);
      return d;
    })
    .filter(d => d >= dayStart(NOW));
}

const venueName = v =>
  v
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s+-\s+VMH$/, "")
    .trim();

const bandName = e =>
  e.artist
    .replace(/^happy hour w\/\s*/i, "")
    .split(/,| w\/ /)[0]
    .replace(/\s*(&|and)\s+friends$/i, "")
    .trim() || e.artist;

const hash = s => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};

const initials = s => {
  const w = s
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(x => x && !/^(the|and|of)$/i.test(x));
  return ((w[0] || "?")[0] + (w[1] ? w[1][0] : "")).toUpperCase();
};

// ---- Building blocks (HTML snippets) ----

// a band or venue picture: the Deezer photo when there is one, otherwise initials on a color unique to the name
function art(s, cls = "", band = true) {
  const ph = band && photoFor(s);
  if (ph)
    return `<div class="art ${cls}"${band ? ` data-a="${esc(s)}"` : ""} style="background-image:url('${ph}')"></div>`;
  const h = hash(s),
    a = h % 360,
    b = (a + 40 + ((h >> 9) % 100)) % 360;
  return `<div class="art g ${cls}"${band ? ` data-a="${esc(s)}"` : ""} style="background:linear-gradient(${(h >> 4) % 360}deg,hsl(${a} 70% 45%),hsl(${b} 75% 22%))">${esc(initials(s))}</div>`;
}

const playBadge = h =>
  `<span class="pb" role="button" aria-label="Play preview" data-play="${esc(h)}"${hasPreview(h) ? "" : " hidden"}>${svg("play")}</span>`;

const artWithPlay = (h, c = "") => art(h, c).replace(/<\/div>$/, playBadge(h) + "</div>");

// band tiles (Bands grid, search): the star on the photo is a button, so faving takes one tap like on rows
const bandTileArt = h => {
  const on = SAVED.bands.includes(h);
  const star =
    `<span class="fv tog${on ? " on" : ""}" role="button" data-sb="${esc(h)}" ` +
    `aria-label="${on ? "Unfave" : "Fave"} ${esc(h)}">${svg("Faves")}</span>`;
  return artWithPlay(h, "round").replace(/<\/div>$/, star + "</div>");
};

const heroPlayButton = h => (
  lookupBand(h).catch(() => {}),
  `<button class="hplay" data-play="${esc(h)}" data-single aria-label="Play preview"${hasPreview(h) ? "" : " hidden"}>${svg("play")}</button>`
);

const sortButton = (label, attr) =>
  `<button class="chip" ${attr} aria-label="Sorted: ${label}. Tap to switch.">${svg("sort")}${label}</button>`;

const playAllButton = (l = "Play all") =>
  `<button class="chip pall" data-playall>${svg("play")}${l}</button>`;

const venueArt = (v, c = "") => art(venueName(v), c, false);

const toggleFave = (k, n) => {
  const a = SAVED[k],
    i = a.indexOf(n);
  i < 0 ? a.push(n) : a.splice(i, 1);
  store.set(FAVES_KEY, SAVED);
};

const searchWords = () => term.toLowerCase().split(/\s+/).filter(Boolean);
const byDistance = a =>
  a.slice().sort((x, y) => (milesTo(x) ?? 1e9) - (milesTo(y) ?? 1e9) || x.startMs - y.startMs);

const groupBy = (l, f) => {
  const m = new Map();
  l.forEach(e => {
    const k = f(e);
    m.has(k) || m.set(k, []);
    m.get(k).push(e);
  });
  return m;
};

// inline SVG icons, drawn on a 24×24 grid
const ICONS = {
  Shows: '<path d="M4 5h16v16H4zM4 9h16M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="2"/>',
  Bands: '<circle cx="12" cy="8" r="4.5"/><path d="M3.5 21a8.5 8.5 0 0 1 17 0z"/>',
  Venues:
    '<path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/>',
  Faves: '<path d="M12 2.5l2.9 6.2 6.8.8-5 4.6 1.3 6.7L12 17.5l-6 3.3 1.3-6.7-5-4.6 6.8-.8z"/>',
  info: '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 10.5v6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="7.3" r="1.4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  install:
    '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  share:
    '<path d="M12 15V4M8 7.5 12 4l4 3.5M7 11H6a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  store:
    '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 8h18l-1 3H4z"/><path d="M5 11v9h14v-9"/><path d="M10 20v-5h4v5"/></g>',
  pin: '<g fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 21s7-6.6 7-12a7 7 0 1 0-14 0c0 5.4 7 12 7 12z"/><circle cx="12" cy="9" r="2.6"/></g>',
  tel: '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  globe:
    '<g fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></g>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>',
  next: '<path d="M5.5 6l9 6-9 6zM16 6h2.5v12H16z"/>',
  prev: '<path d="M18.5 6l-9 6 9 6zM5.5 6H8v12H5.5z"/>',
  sort: '<path d="M7 3 2.5 8H6v13h2V8h3.5zM17 21l4.5-5H18V3h-2v13h-3.5z"/>',
};

// a close / clear "×" drawn as an icon, so it sits dead center in its round button
const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const svg = k => `<svg viewBox="0 0 24 24" fill="currentColor">${ICONS[k]}</svg>`;

const mapsQuery = v => encodeURIComponent([venueName(v.venue), v.city, "CA"].filter(Boolean).join(", "));

// Maps listing, call, website, directions
const venueActions = v => {
  const tel = VENUE_PHONES[v.venue];
  const web = VENUE_SITES[v.venue];
  const link = (href, icon, title, label, newTab = true) =>
    `<a class="mi" href="${href}"${newTab ? ' target="_blank" rel="noopener"' : ""} title="${title}" aria-label="${label}">${svg(icon)}</a>`;
  return [
    link(
      `https://www.google.com/maps/search/?api=1&query=${mapsQuery(v)}`,
      "store",
      "Look up venue",
      "Look up venue in Maps",
    ),
    tel ? link(`tel:${tel.replace(/[^\d+]/g, "")}`, "tel", `Call ${esc(tel)}`, "Call venue", false) : "",
    web ? link(web, "globe", "Website", "Venue website") : "",
    link(
      `https://www.google.com/maps/dir/?api=1&destination=${mapsQuery(v)}`,
      "pin",
      "Directions",
      "Directions",
    ),
  ].join("");
};

// in the car: tapping a map link may not start the car's navigation, but voice always does
const voiceHint = v =>
  IN_TESLA
    ? `<p class="vhint">${svg("mic")}<span>Say <b>“Navigate to ${esc(venueName(v.venue))}”</b>` +
      `${v.address ? `<i>${esc(v.address)}</i>` : ""}</span></p>`
    : "";

// the TOPA wordmark: the Topa Topa ridgeline in sunset colors, with the name beneath it
// (the ridgeline comes from the first version of the app). The name is plain text under the drawing, not
// part of it, so every browser stacks the two the same way. `id` keeps each copy's gradient separate.
const RIDGE =
  "M30 150 L110 120 L180 128 L235 82 L285 116 L320 104 L370 50 L430 98 L470 84 L540 120 L600 116 L650 150";
const ridge = id =>
  `<svg class="wm" viewBox="20 40 640 116" aria-hidden="true">` +
  `<defs><linearGradient id="wg-${id}" x1="0" x2="1"><stop offset="0" stop-color="#ff5f8f"/>` +
  `<stop offset="1" stop-color="#ff9a5a"/></linearGradient></defs>` +
  `<path class="wm-ridge" d="${RIDGE}" stroke="url(#wg-${id})"/></svg>`;
const wordmark = id => `${ridge(id)}<span class="wm-name">TOPA</span>`;

const starButton = (on, attr, big) =>
  `<button class="star${on ? " on" : ""}${big ? " big" : ""}" ${attr} aria-label="${on ? "Unfave" : "Fave"}" title="${on ? "Unfave" : "Fave"}">${on ? "★" : "☆"}</button>`;

// ---- Page history ----
// every page change goes into the browser history, so swipe-back and the browser's back arrow work
const urlFor = v => {
  const u = new URLSearchParams(location.search);
  v === "Shows" ? u.delete("view") : u.set("view", v);
  const s = u.toString();
  return location.pathname + (s ? "?" + s : "");
};

// ---- Visit counting (GoatCounter: no cookies, nothing personal; local testing isn't counted) ----
// pages count as "/shows", "/band/Pozo", "/venue/The Grape"…; taps like previews and directions count as events
function pagePath(v) {
  const page = v.split(":")[0],
    arg = v.slice(page.length + 1);
  const name = page === "Show" ? (EVENTS[+arg] ? EVENTS[+arg].artist : "") : arg;
  return "/" + page.toLowerCase() + (name ? "/" + name : "");
}
window.goatcounter = { path: () => pagePath(view) }; // the first page, counted when the script loads
const countView = () => window.goatcounter.count?.({ path: pagePath(view) });
const countEvent = (name, title = "") => window.goatcounter.count?.({ path: name, title, event: true });

function go(v) {
  if (v === view) return;
  prev = view;
  view = v;
  try {
    history.pushState({ v, prev }, "", urlFor(v));
  } catch (_) {}
  render();
  document.getElementById("main").scrollTop = 0;
  countView();
}

addEventListener("popstate", ev => {
  const st = ev.state || {};
  view = st.v || "Shows";
  prev = st.prev || "Shows";
  render();
  document.getElementById("main").scrollTop = 0;
  countView();
});

// ---- Lists and the Shows page ----
// one band's dates: lead with the venue (the band is already in the page header)
// distance in the gray line under a name (wide screens) or under the time (phones); empty when unknown
const milesPart = e => {
  const d = distanceLabel(e);
  return d ? `<i class="mp"> · ${d}</i>` : "";
};
const milesUnderTime = e => {
  const d = distanceLabel(e);
  return d ? `<small class="tm">${d}</small>` : "";
};

const venueDateRow = e => {
  const d = new Date(e.start);
  const bill = e.artist !== bandName(e) ? ` <em>· ${esc(e.artist)}</em>` : "";
  return (
    `<div class="rw rwb" data-show="${e.id}">` +
    `<div class="tcol"><span>${weekdayLabel(e)}</span><span>${d.getMonth() + 1}/${d.getDate()}</span><b>${timeLabel(e)}</b>${milesUnderTime(e)}</div>` +
    `<div class="rb"><b>${esc(venueName(e.venue))}</b>` +
    `<button class="vb" data-venue="${esc(e.venue)}">${esc(e.city)}${milesPart(e)}${bill}<span>›</span></button></div></div>`
  );
};

// a show in a list; timeOnly when the date is already in the title or a day divider,
// atVenue on lists that are all at one venue (its name, town and distance are already in the header)
const showRow = (e, timeOnly, atVenue) => {
  const d = new Date(e.start);
  const band = bandName(e);
  const date = timeOnly
    ? ""
    : `<span>${weekdayLabel(e)}</span><span>${d.getMonth() + 1}/${d.getDate()}</span>`;
  // the star is for the band, so a show that's here because its venue is faved says so
  const faveVenue = !atVenue && SAVED.venues.includes(e.venue) && !SAVED.bands.includes(band);
  const labels = [
    ...(faveVenue ? ['<i class="fvtag">★ Fave venue</i>'] : []),
    ...e.tags.slice(0, faveVenue ? 2 : 3).map(x => `<i>${esc(x)}</i>`),
  ];
  const tags = labels.length ? `<div class="tg">${labels.join("")}</div>` : "";
  return (
    `<div class="rw" data-show="${e.id}"><div class="tcol">${date}<b>${timeLabel(e)}</b>${atVenue ? "" : milesUnderTime(e)}</div>${artWithPlay(band)}` +
    `<div class="rb"><b>${esc(e.artist)}</b>` +
    (atVenue
      ? ""
      : `<button class="vb" data-venue="${esc(e.venue)}">${esc(venueName(e.venue))} <em>· ${esc(e.city)}${milesPart(e)}</em><span>›</span></button>`) +
    `</div>` +
    `${tags}${starButton(SAVED.bands.includes(band), `data-sb="${esc(band)}"`)}</div>`
  );
};

// "Today" until 4pm, then "Tonight": for the current day (page titles, chips, headings)
const todayWord = () => (NOW.getHours() < 16 ? "Today" : "Tonight");
// for one show today: "Today 1pm" for an afternoon set, "Tonight 8pm" for an evening one
const showDayWord = e => (new Date(e.start).getHours() < 16 ? "Today" : "Tonight");

// "Tonight 8pm", "Sun 11/1 4pm"
const nextLabel = e => {
  const d = new Date(e.start);
  return `${sameDay(d, NOW) ? showDayWord(e) : `${weekdayLabel(e)} ${d.getMonth() + 1}/${d.getDate()}`} ${timeLabel(e)}`;
};

// a venue in a list: name, town, distance and show count, its next show, and a fave star
const venueRow = (n, L) => {
  const next = L.find(isStillOn) || L[0];
  const meta = [next.city, distanceLabel(next), countLabel(L.length, "show")]
    .filter(Boolean)
    .map(esc)
    .join(" · ");
  return (
    `<div class="rw vrow" data-venue="${esc(n)}">${venueArt(n)}` +
    `<div class="rb"><b>${esc(venueName(n))}</b><span class="vmeta">${meta}</span></div>` +
    `<div class="vnext"><span class="vwhen">${nextLabel(next)}</span><span class="vwho">${esc(next.artist)}</span></div>` +
    `${starButton(SAVED.venues.includes(n), `data-sv="${esc(n)}"`)}</div>`
  );
};

const showsInRange = () => EVENTS.filter(inRadius);

// "35 shows", "1 band"
const countLabel = (n, what) => (n ? `${n} ${what}${n > 1 ? "s" : ""}` : "");

// opens the distance picker
const distanceButton = (c = "") =>
  `<button class="pill loc ${c}" data-pop>${svg("Venues")}${radius < ANY ? `Within ${radius} mi` : "Any distance"}</button>`;

// page header: title (+ optional count), an optional search box, then buttons
function topBar(title, extra = "", sub = "", noDistance, search = "") {
  const distance = noDistance ? "" : `<i class="brk"></i>${distanceButton()}`;
  return (
    `<div class="top"><div class="tt"><h1>${title}</h1>${sub ? `<p class="tsub">${sub}</p>` : ""}</div>` +
    `${search}${extra}${distance}</div>`
  );
}

// day chips: Today/Tonight, the next 6 days, This weekend, All (empty ones hidden)
const dayKey = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const isStillOn = e => !sameDay(new Date(e.start), NOW) || e.startMs >= NOW - 2 * 36e5;

function dayOptions() {
  const t0 = dayStart(NOW),
    wk = weekendDays().map(dayKey),
    defs = [["tonight", todayWord(), todayWord(), e => sameDay(new Date(e.start), NOW)]];
  for (let i = 1; i < 7; i++) {
    const d = new Date(t0);
    d.setDate(t0.getDate() + i);
    const k = dayKey(d);
    defs.push([
      k,
      d.toLocaleDateString("en-US", { weekday: "short" }) + " " + d.getDate(),
      d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }),
      e => dayKey(new Date(e.start)) === k,
    ]);
  }
  defs.push(
    ["weekend", "This weekend", "This weekend", e => wk.includes(dayKey(new Date(e.start)))],
    ["all", "All", "All upcoming", () => true],
  );
  const N = showsInRange().filter(isStillOn);
  return defs.map(([k, l, long, f]) => ({ k, l, long, L: N.filter(f) })).filter(d => d.L.length);
}

// a sideways-scrolling chip row; arrows show on wide screens when more chips are hidden
const CHEVRON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';
const scrollRow = (name, inner) =>
  `<div class="sw" data-row="${name}"><button class="sa l" data-scroll="-1" aria-label="Scroll left">${CHEVRON}</button>` +
  `<div class="chips ${name}">${inner}</div>` +
  `<button class="sa r" data-scroll="1" aria-label="Scroll right">${CHEVRON}</button></div>`;

// mark each row with which sides have hidden chips (drives the arrows and edge fades)
function updateScrollRows() {
  for (const w of document.querySelectorAll(".sw")) {
    const c = w.querySelector(".chips");
    w.classList.toggle("more-l", c.scrollLeft > 2);
    w.classList.toggle("more-r", c.scrollLeft + c.clientWidth < c.scrollWidth - 2);
  }
}
addEventListener("resize", updateScrollRows);
document.addEventListener("scroll", ev => ev.target.closest?.(".sw") && updateScrollRows(), true);

function pickDay() {
  const D = dayOptions();
  let cur = D.find(d => d.k === day);
  if (!cur) cur = D.find(d => d.k !== "weekend" && d.k !== "all") || D[0];
  const sel = cur ? cur.k : "";
  const chips = D.map(
    d => `<button class="chip${d.k === sel ? " on" : ""}" data-d="${d.k}">${d.l}</button>`,
  ).join("");
  const L0 = cur ? cur.L : [],
    G = [
      ...groupBy(
        L0.flatMap(e => e.tags.map(t => ({ t }))),
        x => x.t,
      ).entries(),
    ]
      .sort((a, b) => b[1].length - a[1].length)
      .map(x => x[0]);
  if (genre && !G.includes(genre)) genre = "";
  const gchips = G.length
    ? scrollRow(
        "genres",
        `<button class="chip${!genre ? " on" : ""}" data-g="">All genres</button>${G.map(g => `<button class="chip${g === genre ? " on" : ""}" data-g="${esc(g)}">${esc(g)}</button>`).join("")}`,
      )
    : "";
  return {
    cur,
    chips: scrollRow("days", chips),
    gchips,
    G,
    L: genre ? L0.filter(e => e.tags.includes(genre)) : L0,
    lbl: cur ? cur.long : "Shows",
  };
}

const searchBox = () =>
  `<div class="sf"><input class="search" id="s" placeholder="Search bands, venues, towns" value="${esc(term)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search"><button class="clr" data-clear="s" aria-label="Clear search"${term ? "" : " hidden"}>${CLOSE_ICON}</button></div>`;

const emptyMessage = () =>
  !EVENTS.length
    ? `<p class="empty">${status.c === "offline" ? "Couldn't load shows. Check your connection and try again." : "Loading shows…"}</p>`
    : `<p class="empty">No upcoming shows within ${radius >= ANY ? "the county" : radius + " mi"}.</p>${radius < ANY ? `<button class="chip pall" data-anyrad>Show all distances</button>` : ""}`;

function showsPage() {
  const k = searchWords();
  if (k.length) {
    const R = byDistance(
      EVENTS.filter(e =>
        k.every(x =>
          (e.artist + " " + e.venue + " " + e.city + " " + e.tags.join(" ")).toLowerCase().includes(x),
        ),
      ),
    );
    return (
      topBar(
        "Search",
        playAllButton("Play results") + distanceButton("d-top"),
        countLabel(R.length, "show"),
        true,
        searchBox(),
      ) +
      `<div class="frow fm">${distanceButton("d-row")}</div>` +
      searchResults(k, R)
    );
  }
  const { chips, gchips, L, lbl } = pickDay();
  const byDay = [
    ...groupBy(
      L.slice().sort((a, b) => a.startMs - b.startMs),
      e => dayKey(new Date(e.start)),
    ),
  ];
  const dh = k => {
    const d = new Date(k + "T12:00");
    return sameDay(d, NOW)
      ? todayWord()
      : d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  };
  const n = L.length,
    multi = byDay.length > 1;
  const ord = l =>
    ssort === "dist"
      ? byDistance(l)
      : l.slice().sort((a, b) => a.startMs - b.startMs || (milesTo(a) ?? 1e9) - (milesTo(b) ?? 1e9));
  // one button that flips the order (Soonest / Nearest)
  const sb = n
    ? `<button class="chip sortb" data-ssort="${ssort === "time" ? "dist" : "time"}" aria-label="Sorted by ${ssort === "time" ? "start time" : "distance"}. Tap to switch.">${svg("sort")}${ssort === "time" ? "Soonest" : "Nearest"}</button>`
    : "";
  // "My Faves": faved bands, or anything at a faved venue, pinned on top (same filters as the list; they stay in it too)
  const faves = L.filter(e => SAVED.bands.includes(bandName(e)) || SAVED.venues.includes(e.venue)).sort(
    (a, b) => a.startMs - b.startMs,
  );
  const FAVES_SHOWN = 3;
  const favesSection = faves.length
    ? `<section class="favsec"><h2 class="dh">My Faves</h2>` +
      faves
        .slice(0, FAVES_SHOWN)
        .map(x => showRow(x, !multi))
        .join("") +
      (faves.length > FAVES_SHOWN
        ? `<button class="seeall" data-v="Faves">See all in Faves<span>›</span></button>`
        : "") +
      // the divider alone separates My Faves from the full list; the day is already in the page title
      `</section><div class="rule"></div>`
    : "";
  // wide screens: distance sits in the header; phones: distance and sort lead the genre row
  return (
    topBar(lbl, playAllButton() + distanceButton("d-top"), countLabel(n, "show"), true, searchBox()) +
    chips +
    `<div class="frow">${distanceButton("d-row")}${gchips}${sb}</div><div class="rule"></div>` +
    favesSection +
    (n
      ? byDay
          .map(
            ([k, l]) =>
              (multi ? `<h2 class="dh">${dh(k)}</h2>` : "") +
              ord(l)
                .map(x => showRow(x, true))
                .join(""),
          )
          .join("")
      : emptyMessage())
  );
}

const updatedLabel = () =>
  status.updated
    ? new Date(status.updated).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "";

function searchResults(k, L) {
  const hit = s => k.every(x => s.toLowerCase().includes(x));
  const B = [...groupBy(EVENTS, bandName)].filter(([n, l]) => hit(n + " " + l[0].tags.join(" "))),
    V = [...groupBy(EVENTS, e => e.venue)]
      .filter(([n, l]) => hit(venueName(n) + " " + l[0].city))
      .sort((a, b) => (milesTo(a[1][0]) ?? 1e9) - (milesTo(b[1][0]) ?? 1e9));
  const sec = (t, n, body) => `<section><h2>${t} <span class="cnt">${n}</span></h2>${body}</section>`;
  return (
    (B.length
      ? sec(
          "Bands",
          B.length,
          `<div class="row">${B.map(([n, l]) => `<button class="tile" data-band="${esc(n)}">${bandTileArt(n)}<b>${esc(n)}</b><small>${nextLabel(l.find(isStillOn) || l[0])}${l.filter(isStillOn).length > 1 ? " · " + l.filter(isStillOn).length + " shows" : ""}</small></button>`).join("")}</div>`,
        )
      : "") +
    (V.length ? sec("Venues", V.length, V.map(([n, l]) => venueRow(n, l)).join("")) : "") +
    (L.length
      ? sec(
          "Shows",
          L.length,
          L.slice(0, 40)
            .map(x => showRow(x))
            .join(""),
        )
      : "") +
    (B.length || V.length || L.length ? "" : '<p class="empty">No matches.</p>')
  );
}

// ---- Other pages ----
// Each page function returns its HTML. render() draws the sidebar and the current page.

const filterBox = (id, placeholder, value) =>
  `<div class="sf"><input class="search" id="${id}" placeholder="${placeholder}" value="${esc(value)}" autocomplete="off">` +
  `<button class="clr" data-clear="${id}" aria-label="Clear filter"${value ? "" : " hidden"}>${CLOSE_ICON}</button></div>`;

const showCount = n => `${n} upcoming show${n === 1 ? "" : "s"}`;

function bandsPage() {
  const filter = bandFilter.toLowerCase();
  // shows that already ended today don't count, so "next show" is always still ahead
  const bands = [...groupBy(EVENTS.filter(isStillOn), bandName)].filter(([n]) =>
    n.toLowerCase().includes(filter),
  );
  bands.sort(
    bsort === "az"
      ? (a, b) => a[0].localeCompare(b[0])
      : (a, b) => a[1][0].startMs - b[1][0].startMs || a[0].localeCompare(b[0]),
  );
  const sort = sortButton(
    bsort === "soon" ? "Soonest" : "A–Z",
    `data-sort="${bsort === "soon" ? "az" : "soon"}"`,
  );
  const tile = ([n, L]) =>
    `<button class="tile" data-band="${esc(n)}">${bandTileArt(n)}<b>${esc(n)}</b>` +
    `<small>${nextLabel(L[0])}${L.length > 1 ? " · " + L.length + " shows" : ""}</small></button>`;
  return (
    topBar(
      "Bands",
      playAllButton() + sort,
      countLabel(bands.length, "band"),
      true,
      filterBox("bf", "Filter bands", bandFilter),
    ) + `<div class="agrid">${bands.map(tile).join("")}</div>`
  );
}

function bandPage(name) {
  const L = EVENTS.filter(e => bandName(e) === name);
  const genres = L[0] && L[0].tags.length ? " · " + esc(L[0].tags.join(", ").toUpperCase()) : "";
  return (
    `<div class="hero">${art(name, "round")}<div class="hx">` +
    `<small>ARTIST${genres}</small><h1>${esc(name)}</h1><p>${showCount(L.length)}</p>` +
    `<div class="acts" style="align-items:center">${heroPlayButton(name)}</div>` +
    `</div>${starButton(SAVED.bands.includes(name), `data-sb="${esc(name)}"`, 1)}</div>` +
    L.map(venueDateRow).join("")
  );
}

function venuesPage() {
  const filter = venueFilter.toLowerCase();
  const venues = [...groupBy(showsInRange().filter(isStillOn), e => e.venue)].filter(([n, L]) =>
    (venueName(n) + " " + L[0].city).toLowerCase().includes(filter),
  );
  // "Nearest" needs a location; without one the list starts A–Z
  const order = USER.county && vsort === "near" ? "az" : vsort;
  venues.sort(
    order === "az"
      ? (a, b) => venueName(a[0]).localeCompare(venueName(b[0]))
      : (a, b) => (milesTo(a[1][0]) ?? 1e9) - (milesTo(b[1][0]) ?? 1e9),
  );
  const sort = sortButton(
    order === "near" ? "Nearest" : "A–Z",
    `data-vsort="${order === "near" ? "az" : "near"}"`,
  );
  return (
    topBar(
      "Venues",
      sort,
      countLabel(venues.length, "venue"),
      false,
      filterBox("vf", "Filter venues or towns", venueFilter),
    ) +
    (venues.length ? "" : '<p class="empty">No venues match.</p>') +
    venues.map(([n, L]) => venueRow(n, L)).join("")
  );
}

function venuePage(key) {
  const L = EVENTS.filter(e => e.venue === key || venueName(e.venue) === key);
  const v = L[0];
  if (!v) return `<p class="empty">No upcoming shows at ${esc(key)}.</p>`;
  // plain time order: Today/Tonight, This week (next 7 days), Later
  const upcoming = L.filter(isStillOn).sort((a, b) => a.startMs - b.startMs);
  const weekEnd = dayStart(NOW).getTime() + 7 * 864e5;
  const tonight = upcoming.filter(e => sameDay(new Date(e.start), NOW));
  const thisWeek = upcoming.filter(e => !tonight.includes(e) && e.startMs < weekEnd);
  const later = upcoming.filter(e => !tonight.includes(e) && !thisWeek.includes(e));
  const section = (title, list, gap) =>
    list.length
      ? `<h2${gap ? ' style="margin-top:24px"' : ""}>${title}</h2>${list.map(e => showRow(e, false, true)).join("")}`
      : "";
  const dist = distanceLabel(v);
  return (
    `<div class="hero">${venueArt(v.venue)}<div class="hx">` +
    `<small>VENUE · ${esc(v.city.toUpperCase())}${dist ? " · " + dist.toUpperCase() : ""}</small>` +
    `<h1>${esc(venueName(v.venue))}</h1>` +
    `<div class="mrow">${playAllButton("Play lineup")}${venueActions(v)}<span class="sub">${showCount(L.length)}</span></div>${voiceHint(v)}` +
    `</div>${starButton(SAVED.venues.includes(v.venue), `data-sv="${esc(v.venue)}"`, 1)}</div>` +
    section(todayWord(), tonight) +
    section("This week", thisWeek, tonight.length) +
    section("Later", later.slice(0, 30), tonight.length || thisWeek.length)
  );
}

function showPage(id) {
  const e = EVENTS[+id];
  if (!e) return `<p class="empty">That show is no longer listed.</p>`;
  const band = bandName(e);
  const date = new Date(e.start)
    .toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
    .toUpperCase();
  const otherDates = EVENTS.filter(x => bandName(x) === band && x.id !== e.id);
  const alsoHere = EVENTS.filter(x => x.venue === e.venue && bandName(x) !== band).slice(0, 6);
  const listing =
    `<a class="mi" href="${esc(e.url || VR_CAL)}" target="_blank" rel="noopener" title="View on Ventura Rocks" ` +
    `aria-label="View on Ventura Rocks">${svg("ext")}</a>`;
  const tags = e.tags.length ? `<div class="tg">${e.tags.map(x => `<i>${esc(x)}</i>`).join("")}</div>` : "";
  return (
    `<div class="hero">${art(band)}<div class="hx">` +
    `<small>${date} · <span class="ac">${timeLabel(e)}</span></small><h1>${esc(e.artist)}</h1>` +
    `<button class="vb big" data-venue="${esc(e.venue)}">${esc(venueName(e.venue))} <em>· ${esc(e.city)}</em><span>›</span></button>` +
    `<div class="mrow">${heroPlayButton(band)}${listing}${venueActions(e)}<span class="sub">${distanceLabel(e)}</span></div>${voiceHint(e)}` +
    `${tags}</div>${starButton(SAVED.bands.includes(band), `data-sb="${esc(band)}"`, 1)}</div>` +
    (otherDates.length ? `<h2>More ${esc(band)} dates</h2>${otherDates.map(venueDateRow).join("")}` : "") +
    (alsoHere.length
      ? `<h2 style="margin-top:24px">Also at ${esc(venueName(e.venue))}</h2>${alsoHere.map(x => showRow(x, false, true)).join("")}`
      : "")
  );
}

function favesPage() {
  const upcoming = EVENTS.filter(isStillOn);
  const bands = [...groupBy(upcoming, bandName)].filter(([n]) => SAVED.bands.includes(n));
  const venues = SAVED.venues.map(n => [n, upcoming.filter(e => e.venue === n)]);
  if (!bands.length && !venues.length)
    return (
      topBar("Faves", "", "", true) +
      `<p class="empty">No faves yet. Tap ☆ on a show to fave the band, or on a venue to fave the venue.</p>`
    );
  const bandCard = ([n, L]) => {
    const next = L[0];
    const dist = distanceLabel(next);
    return (
      `<div class="card" data-show="${next.id}">${artWithPlay(n, "round")}<div class="ci">` +
      `<button class="cn" data-band="${esc(n)}">${esc(n)}</button>` +
      `<span>Next: ${nextLabel(next)} · ${esc(venueName(next.venue))}</span>` +
      `<span>${dist ? dist + " · " : ""}${showCount(L.length)}</span>` +
      `</div>${starButton(true, `data-sb="${esc(n)}"`)}</div>`
    );
  };
  const venueCard = ([n, L]) => {
    const v = L[0] || { venue: n, city: "", address: "", lat: null };
    const where = [v.city, distanceLabel(v)].filter(Boolean).map(esc).join(" · ");
    return (
      `<div class="card vcard">${venueArt(n)}<div class="ci">` +
      `<button class="cn" data-venue="${esc(n)}">${esc(venueName(n))}</button>` +
      `<span>${where}${v.city ? " · " : ""}${showCount(L.length)}</span><span>${esc(v.address)}</span>` +
      `</div>${starButton(true, `data-sv="${esc(n)}"`)}<div class="mrow vacts">${venueActions(v)}</div></div>`
    );
  };
  // Bands / Venues chips (with counts) switch the list instead of stacking both on one long page.
  // No count line under the title (the chips have it) and no distance button (faves list everything saved).
  const tab = !bands.length ? "venues" : !venues.length ? "bands" : faveTab;
  const chip = (k, label, n) =>
    n
      ? `<button class="chip${tab === k ? " on" : ""}" data-ftab="${k}">${label} <span>${n}</span></button>`
      : "";
  return (
    topBar("Faves", "", "", true) +
    `<div class="chips days ftabs">${chip("bands", "Bands", bands.length)}${chip("venues", "Venues", venues.length)}</div>` +
    `<div class="cards">${(tab === "bands" ? bands.map(bandCard) : venues.map(venueCard)).join("")}</div>`
  );
}

const PAGES = {
  Shows: showsPage,
  Bands: bandsPage,
  Band: bandPage,
  Venues: venuesPage,
  Venue: venuePage,
  Show: showPage,
  Faves: favesPage,
};

// the sidebar / tab bar; detail pages highlight the section they belong to
function navHtml(page) {
  const opener = prev
    .split(":")[0]
    .replace(/^Band$/, "Bands")
    .replace(/^Venue$/, "Venues");
  const current = { Show: opener, Band: "Bands", Venue: "Venues" }[page] || page;
  const tabs = ["Shows", "Bands", "Venues", "Faves"]
    .map(k => `<button data-v="${k}" class="${k === current ? "on" : ""}">${svg(k)}${k}</button>`)
    .join("");
  // when the listings last changed (the Ventura Rocks credit lives in About)
  const updated = updatedLabel() ? `Updated<i>${updatedLabel()}</i>` : "";
  return (
    `<button class="logo" data-about aria-label="About TOPA">${wordmark("nav")}</button>${tabs}` +
    `<button class="about-tab" data-about>${svg("info")}About</button>` +
    `<div class="credit">${updated}</div>`
  );
}

function render() {
  if (!PAGES[view.split(":")[0]]) view = "Shows";
  const page = view.split(":")[0];
  const arg = view.slice(page.length + 1);
  // keep chip rows where they were scrolled (tapping a genre re-renders the page)
  const rowScroll = {};
  for (const w of document.querySelectorAll(".sw"))
    rowScroll[w.dataset.row] = w.querySelector(".chips").scrollLeft;
  document.getElementById("nav").innerHTML = navHtml(page);
  // phones have no sidebar logo, so each page starts with a small TOPA that also opens About
  const phoneLogo = `<button class="mlogo" data-about aria-label="About TOPA">${wordmark("phone")}<small>Ventura County Local Music Finder</small></button>`;
  document.getElementById("main").innerHTML = phoneLogo + PAGES[page](arg);
  for (const w of document.querySelectorAll(".sw"))
    w.querySelector(".chips").scrollLeft = rowScroll[w.dataset.row] || 0;
  updateScrollRows();
  markScrolled();
  syncPlayIcons();
  prioritizeOnScreen();
  wireTextBoxes();
}

// typing re-renders the page; keep the cursor in the box
function wireTextBoxes() {
  const boxes = { bf: v => (bandFilter = v), vf: v => (venueFilter = v), s: v => (term = v) };
  for (const [id, set] of Object.entries(boxes)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.oninput = () => {
      set(el.value);
      render();
      const box = document.getElementById(id);
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    };
  }
}

// ---- Distance and location ----

function distancePopup() {
  const b = (r, l) => `<button class="chip${radius === r ? " on" : ""}" data-rad="${r}">${l}</button>`;
  document.getElementById("pop").innerHTML =
    `<h3>Distance</h3><div class="rads">${RADII.map(r => b(r, r + " mi")).join("")}${b(ANY, "Any")}</div>${USER.county ? `<p class="rnote">Picking a mile range turns on your location.</p>` : ""}`;
}

// ok: optional step to run once the location arrives (if location is refused, say so)
function locate(ok, msg = "Turn on location to filter by distance.") {
  const no = () => ok && toast(msg);
  if (!navigator.geolocation) return no();
  navigator.geolocation.getCurrentPosition(
    p => {
      USER = { lat: p.coords.latitude, lng: p.coords.longitude };
      store.set(LOCATION_KEY, USER);
      if (ok) ok();
      render();
      if (document.getElementById("pop").classList.contains("on")) distancePopup();
    },
    no,
    { timeout: 10000, maximumAge: 6e5 },
  );
}

// ---- 30-second previews (Deezer) ----
// Deezer's API has no CORS headers, so it is called with JSONP. Preview links expire after ~15 min,
// so only the artist match is saved; track links are fetched fresh when you press play.
const DEEZER_API = "https://api.deezer.com",
  MATCH_KEY = "topa.matches.v1";

let MATCHES = (s => (s && typeof s === "object" && !Array.isArray(s) ? s : {}))(store.get(MATCH_KEY));

// MATCHES[band] = { v, t }: v is { id, n: Deezer name, pic, np: 1 if no playable previews } or 0 for no match;
// t is when it was checked. Matches are rechecked after 14 days, misses after 3.
const matchFor = h => {
  const r = MATCHES[h];
  if (!r) return undefined;
  if (Date.now() - r.t > (r.v ? 12096e5 : 2592e5)) return undefined;
  return r.v;
};

const saveMatch = (h, v) => {
  MATCHES[h] = { v, t: Date.now() };
  store.set(MATCH_KEY, MATCHES);
};

const hasPreview = h => {
  const v = matchFor(h);
  return !!(v && !v.np);
};

// the band's Deezer photo, if it's a real image and not the blank placeholder
const photoFor = h => {
  const v = matchFor(h),
    u = v && safeUrl(v.pic);
  return u && !/\/artist\/\//.test(u) ? u : "";
};

// swap initials for the photo on tiles already on screen, without a re-render (keeps typing focus)
const paintPhotos = h => {
  const u = photoFor(h);
  if (!u) return;
  document.querySelectorAll(".art[data-a]").forEach(el => {
    if (el.dataset.a !== h || !el.classList.contains("g")) return;
    el.classList.remove("g");
    el.style.background = "";
    el.style.backgroundImage = `url('${u}')`;
    [...el.childNodes].forEach(n => n.nodeType === 3 && n.remove());
  });
};

// for comparing names: lowercase, no accents or punctuation, "&" = "and", no leading "The"
const normName = s =>
  String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]/g, "");

// cover/tribute acts and generic listings ("Open Mic") almost always match the wrong Deezer artist
const GENERIC =
  /open mic|\bjam\b|karaoke|\bdj\b|orchestra|symphony|choir|tribute|\bcovers?\b|party|festival|fundraiser|showcase|jazz band|\bnight\b/i;

const bandEvents = h => EVENTS.filter(x => bandName(x) === h);

// bands worth looking up
const canMatch = h => {
  const L = bandEvents(h);
  return (
    L.length > 0 &&
    normName(h).length > 2 &&
    !GENERIC.test(h) &&
    !L.some(
      e => e.tags.includes("covers") || e.tags.includes("tribute") || /tribute|\bcovers?\b/i.test(e.artist),
    )
  );
};

// Deezer sends no CORS headers, so calls go through JSONP (a <script> tag with a callback)
let jsonpCount = 0;

const jsonp = u =>
  new Promise((res, rej) => {
    const cb = "__dz" + ++jsonpCount + "_" + Date.now(),
      s = document.createElement("script");
    const done = () => {
        clearTimeout(to);
        window[cb] = () => {};
        s.remove();
      },
      to = setTimeout(() => {
        done();
        rej("timeout");
      }, 9000);
    window[cb] = d => {
      done();
      d && !d.error ? res(d) : rej(d && d.error);
    };
    s.onerror = () => {
      done();
      rej("net");
    };
    s.src = u + (u.includes("?") ? "&" : "?") + "output=jsonp&callback=" + cb;
    document.head.appendChild(s);
  });

// a band's top tracks with preview links, kept for 10 minutes (the links expire)
const trackCache = new Map();

async function topTracks(id) {
  const c = trackCache.get(id);
  if (c && Date.now() - c.ts < 6e5) return c.list;
  const d = await jsonp(`${DEEZER_API}/artist/${encodeURIComponent(id)}/top?limit=5`);
  const list = (d.data || [])
    .filter(t => t && t.preview)
    .map(t => ({
      title: t.title_short || t.title || "",
      url: t.preview,
      cover: t.album && (t.album.cover_big || t.album.cover_medium),
    }));
  trackCache.set(id, { ts: Date.now(), list });
  return list;
}

// find a band on Deezer (cached); reveals its play buttons and photo when found
const lookupsInFlight = new Map();

function lookupBand(h) {
  const v = matchFor(h);
  if (v !== undefined) return Promise.resolve(v);
  if (lookupsInFlight.has(h)) return lookupsInFlight.get(h);
  if (!canMatch(h)) return Promise.resolve(0);
  const p = (async () => {
    const d = await jsonp(`${DEEZER_API}/search/artist?q=${encodeURIComponent(h)}&limit=10`),
      tix = bandEvents(h).some(e => e.tix);
    // exact name only; a huge catalog on a small bar gig usually means several artists share the name
    const c = (d.data || [])
      .filter(a => normName(a.name) === normName(h) && a.nb_album > 0 && (tix || a.nb_album <= 30))
      .sort((a, b) => b.nb_fan - a.nb_fan)[0];
    if (!c) {
      saveMatch(h, 0);
      return 0;
    }
    const tr = await topTracks(c.id);
    const r = { id: c.id, n: c.name, pic: c.picture_big || c.picture_medium || "" };
    if (!tr.length) r.np = 1;
    saveMatch(h, r);
    if (!r.np) showPlayButtons(h, true);
    paintPhotos(h);
    return r;
  })().finally(() => lookupsInFlight.delete(h));
  lookupsInFlight.set(h, p);
  return p;
}

const playButtonsFor = h => [...document.querySelectorAll("[data-play]")].filter(b => b.dataset.play === h);
const showPlayButtons = (h, on) => playButtonsFor(h).forEach(b => (b.hidden = !on));

// check every band in the feed in the background (soonest first), gently: Deezer allows ~50 calls / 5s
const lookupQueue = [];

let lookupBusy = false;

function queueLookups() {
  lookupQueue.length = 0;
  prioritizeOnScreen();
  const seen = new Set(lookupQueue);
  EVENTS.slice()
    .sort((a, b) => a.startMs - b.startMs)
    .forEach(e => {
      const h = bandName(e);
      if (!seen.has(h)) {
        seen.add(h);
        if (matchFor(h) === undefined && canMatch(h)) lookupQueue.push(h);
      }
    });
  runLookups();
}

// bands on the current screen jump the line
function prioritizeOnScreen() {
  const m = document.getElementById("main");
  if (!m) return;
  const want = [...new Set([...m.querySelectorAll("[data-play]")].map(b => b.dataset.play))]
    .filter(h => matchFor(h) === undefined && canMatch(h))
    .slice(0, 30);
  for (let i = lookupQueue.length - 1; i >= 0; i--)
    if (want.includes(lookupQueue[i])) lookupQueue.splice(i, 1);
  lookupQueue.unshift(...want);
  if (want.length) runLookups();
}

async function runLookups() {
  if (lookupBusy) return;
  lookupBusy = true;
  let fails = 0;
  while (lookupQueue.length && fails < 3) {
    const h = lookupQueue.shift();
    if (matchFor(h) !== undefined) continue;
    try {
      await lookupBand(h);
      fails = 0;
    } catch (_) {
      fails++;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  lookupBusy = false;
}

// ---- Player ----

// a tiny silent sound, used to unlock audio on iOS
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
const audio = new Audio();
audio.preload = "auto";

// queue: [{band, track}], index: what's playing, token: bumps on every change so stale async work stops
const playback = { queue: [], index: 0, token: 0, band: null, unlocked: false };

const inPlayer = s => document.querySelector("#player " + s);
const safeUrl = u => (/^https:\/\/[^"'()\\\s]+$/.test(u || "") ? u : "");

const nextShow = h =>
  bandEvents(h)
    .filter(isStillOn)
    .sort((a, b) => a.startMs - b.startMs)[0] || bandEvents(h)[0];

const mmss = t =>
  isFinite(t) ? Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0") : "0:00";

let toastTimer;

function toast(m) {
  const el = document.getElementById("toast");
  el.textContent = m;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 2800);
}

// iOS/Safari only lets audio start inside a tap, so prime the element on the first one
function unlockAudio() {
  if (playback.unlocked) return;
  playback.unlocked = true;
  audio.src = SILENT_WAV;
  audio.play().catch(() => {});
}

// single: play one band's top tracks; otherwise one track per band, in order, starting at `start`
async function playQueue(names, start, single) {
  countEvent(single ? "play-band" : "play-all", names[start] || "");
  const tok = ++playback.token;
  if (single) {
    const h = names[0];
    playback.queue = [{ band: h, track: 0 }];
    playback.index = 0;
    showPlayer(playback.queue[0]);
    let tr = [];
    try {
      const v = await lookupBand(h);
      tr = v ? await topTracks(v.id) : [];
    } catch (_) {}
    if (tok !== playback.token) return;
    playback.queue = (tr.length ? tr : [0]).map((_, i) => ({ band: h, track: i }));
  } else {
    playback.queue = names.map(h => ({ band: h, track: 0 }));
    playback.index = start || 0;
  }
  playCurrent();
}

async function playCurrent() {
  const tok = ++playback.token,
    it = playback.queue[playback.index];
  if (!it) return;
  playback.band = it.band;
  audio.pause();
  showPlayer(it);
  let v, tr;
  try {
    v = await lookupBand(it.band);
    tr = v ? await topTracks(v.id) : [];
  } catch (_) {
    if (tok === playback.token) {
      toast("Couldn't reach Deezer. Check the connection.");
      syncPlayIcons();
    }
    return;
  }
  if (tok !== playback.token) return;
  const t = tr[it.track] || tr[0];
  if (!t) {
    showPlayButtons(it.band, false);
    if (playback.index < playback.queue.length - 1) {
      playback.index++;
      return playCurrent();
    }
    toast("No preview found for " + it.band);
    return syncPlayIcons();
  }
  audio.src = t.url;
  audio.play().catch(() => {});
  showPlayer(it, t, v);
}

function showPlayer(it, t, v) {
  const P = document.getElementById("player"),
    e = nextShow(it.band);
  P.hidden = false;
  document.getElementById("app").classList.add("pl");
  const pic = safeUrl((v && v.pic) || (t && t.cover));
  inPlayer(".pla").style.backgroundImage = pic ? `url("${pic}")` : "";
  inPlayer(".plt").textContent = t ? t.title : "Loading preview…";
  inPlayer(".plb").textContent =
    it.band + (e ? " · " + nextLabel(e) + " · " + venueName(e.venue) : "") + (e ? "  ›" : "");
  inPlayer(".plp i").style.width = "0";
  inPlayer(".plcur").textContent = "0:00";
  if (t && "mediaSession" in navigator && window.MediaMetadata)
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: it.band,
      album: e ? nextLabel(e) + " · " + venueName(e.venue) : "TOPA",
      artwork: pic ? [{ src: pic, sizes: "500x500", type: "image/jpeg" }] : [],
    });
  syncPlayIcons();
}

function syncPlayIcons() {
  const on = playback.queue.length && !audio.paused && audio.src !== SILENT_WAV;
  document.querySelectorAll("[data-play]").forEach(b => {
    const me = on && b.dataset.play === playback.band;
    if (b.classList.contains("on") !== me || !b.firstChild) {
      b.classList.toggle("on", me);
      b.innerHTML = svg(me ? "pause" : "play");
    }
  });
  const pp = inPlayer(".pp");
  if (pp) pp.innerHTML = svg(on ? "pause" : "play");
  if (!inPlayer("[data-pl=prev]").firstChild) {
    inPlayer("[data-pl=prev]").innerHTML = svg("prev");
    inPlayer("[data-pl=next]").innerHTML = svg("next");
  }
}

function playNext() {
  if (playback.index < playback.queue.length - 1) {
    playback.index++;
    playCurrent();
  } else {
    audio.pause();
    audio.currentTime = 0;
    syncPlayIcons();
  }
}

function playPrev() {
  if (audio.currentTime > 3 || playback.index === 0) audio.currentTime = 0;
  else {
    playback.index--;
    playCurrent();
  }
}

function closePlayer() {
  playback.token++;
  playback.queue = [];
  playback.band = null;
  audio.pause();
  document.getElementById("player").hidden = true;
  document.getElementById("app").classList.remove("pl");
  syncPlayIcons();
}

audio.addEventListener("play", syncPlayIcons);

audio.addEventListener("pause", syncPlayIcons);

audio.addEventListener("ended", () => {
  if (audio.src !== SILENT_WAV && playback.queue.length) playNext();
});

audio.addEventListener("error", () => {
  if (playback.queue.length && audio.src && audio.src !== SILENT_WAV) {
    toast("That preview wouldn't load. Skipping.");
    trackCache.clear();
    playNext();
  }
});

audio.addEventListener("timeupdate", () => {
  if (audio.src === SILENT_WAV) return;
  const d = audio.duration || 30;
  inPlayer(".plp i").style.width = Math.min(100, (audio.currentTime / d) * 100) + "%";
  inPlayer(".plcur").textContent = mmss(audio.currentTime);
  inPlayer(".pldur").textContent = mmss(d);
});

if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession,
    set = (a, f) => {
      try {
        ms.setActionHandler(a, f);
      } catch (_) {}
    };
  set("play", () => audio.play());
  set("pause", () => audio.pause());
  set("nexttrack", playNext);
  set("previoustrack", playPrev);
}

function onPlayerClick(t, ev) {
  const d = t.dataset;
  unlockAudio();
  if (d.pl === "toggle") {
    if (!playback.queue.length) return;
    audio.paused ? audio.play().catch(() => {}) : audio.pause();
  } else if (d.pl === "next") playNext();
  else if (d.pl === "prev") playPrev();
  else if (d.pl === "close") closePlayer();
  else if (d.pl === "seek") {
    const r = t.getBoundingClientRect();
    if (audio.duration)
      audio.currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * audio.duration;
  } else if (d.plshow !== undefined) {
    const e = playback.band && nextShow(playback.band);
    if (e) go("Show:" + e.id);
  } else if (d.play) {
    const h = d.play;
    if (playback.band === h && playback.queue.length) {
      audio.paused ? audio.play().catch(() => {}) : audio.pause();
      return;
    }
    if (d.single !== undefined) return playQueue([h], 0, true);
    // play the band, then keep going through the other playable bands in the same shelf/grid/list
    const box = t.closest(".row,.agrid,.cards") || document.getElementById("main");
    const names = [
      ...new Set(
        [...box.querySelectorAll("[data-play]:not([hidden]):not([data-single])")].map(b => b.dataset.play),
      ),
    ];
    names.length > 1 ? playQueue(names, Math.max(0, names.indexOf(h)), false) : playQueue([h], 0, true);
  } else if (d.playall !== undefined) {
    const names = [
      ...new Set(
        [...document.querySelectorAll("#main [data-play]:not([hidden]):not([data-single])")].map(
          b => b.dataset.play,
        ),
      ),
    ];
    names.length
      ? playQueue(names, 0, names.length === 1)
      : toast(
          lookupQueue.length || lookupBusy
            ? "Still finding previews. Try again in a few seconds."
            : "No previews found for these bands.",
        );
  }
}

// ---- About ----

const REPO = "https://github.com/automatous-io/topa";

// "Get the app": how to add TOPA to the home screen. Hidden in the car (its browser can't install apps)
// and when it's already running from the home screen.
const INSTALLED = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const ON_IPHONE = /iPhone|iPad|iPod/.test(navigator.userAgent);
const ON_ANDROID = /Android/.test(navigator.userAgent);
let installPrompt = null; // Android/Chrome hands us this when the app can be installed with one tap
addEventListener("beforeinstallprompt", ev => {
  ev.preventDefault();
  installPrompt = ev;
});

function installHtml() {
  if (IN_TESLA || INSTALLED) return "";
  // one card either way: a one-tap Install where the browser allows it, otherwise the steps
  const card = (tag, attrs, icon, title, sub) =>
    `<${tag} class="ainstall"${attrs}><span class="ai-icon">${svg(icon)}</span>` +
    `<span class="ai-text"><b>${title}</b><small>${sub}</small></span>` +
    (tag === "button" ? `<span class="ai-go">›</span>` : "") +
    `</${tag}>`;
  if (installPrompt)
    return card("button", " data-install", "install", "Install TOPA", "Opens full-screen, like an app");
  if (ON_IPHONE)
    return card("div", "", "share", "Add to Home Screen", "In Safari, tap Share, then Add to Home Screen");
  if (ON_ANDROID) return card("div", "", "install", "Install TOPA", "In Chrome, tap ⋮, then Install app");
  return card(
    "div",
    "",
    "install",
    "Get the app",
    "On a phone, add TOPA to your home screen from the browser's menu",
  );
}

function aboutHtml() {
  const link = (href, label) => `<a class="chip" href="${href}" target="_blank" rel="noopener">${label}</a>`;
  return (
    `<button class="ax" data-about-close aria-label="Close">${CLOSE_ICON}</button>` +
    `<div class="ahead">${wordmark("about")}<p>Ventura County Local Music Finder</p></div>` +
    `<p class="astory">A personal project by local music lovers who wanted to find live music nearby, ` +
    `pick a show fast, and have their Tesla navigate there by voice. The future is now!</p>` +
    `<h3>How it works</h3>` +
    `<p>Shows come from the public <a href="${VR_SITE}" target="_blank" rel="noopener">Ventura Rocks</a> calendar, ` +
    `checked about 3 times a day${updatedLabel() ? ` (last change ${updatedLabel()})` : ""}. ` +
    `Every show links back to its Ventura Rocks listing.</p>` +
    `<p>Artist photos and 30-second previews come from <a href="https://www.deezer.com" target="_blank" rel="noopener">Deezer</a> ` +
    `when a band's name matches. Some matches may be wrong, and many local bands have no previews.</p>` +
    `<p>Distances are approximate. Visits are counted anonymously (no cookies, nothing personal) to see how TOPA is used.</p>` +
    installHtml() +
    `<div class="alinks">${link(REPO, "GitHub")}${link(REPO + "#readme", "README")}${link(REPO + "/blob/main/LICENSE", "License")}</div>` +
    `<p class="acopy">Copyright 2026 AUTOMATOUS.IO. All rights reserved. All show listings are from ` +
    `the public Ventura Rocks calendar, and artist photos and previews are from Deezer. Not affiliated with or endorsed by either.</p>` +
    `<a class="aver" href="${REPO}" target="_blank" rel="noopener">v${VERSION}</a>`
  );
}

function openAbout() {
  const a = document.getElementById("about");
  a.querySelector(".acard").innerHTML = aboutHtml();
  a.hidden = false;
}
const closeAbout = () => (document.getElementById("about").hidden = true);

addEventListener("keydown", ev => ev.key === "Escape" && closeAbout());

// ---- Taps ----
// one click handler for the whole app; buttons say what they do with data-* attributes
document.body.onclick = ev => {
  if (ev.target.id === "about") return closeAbout(); // tapped outside the card
  const link = ev.target.closest("a[href]");
  if (link) {
    if (link.href.includes("/maps/dir/"))
      countEvent("directions", link.closest("[data-venue]")?.dataset.venue || "");
    return;
  }
  const t = ev.target.closest(
    "[data-play],[data-playall],[data-pl],[data-plshow],[data-vsort],[data-clear],[data-show],[data-v],[data-d],[data-g],[data-band],[data-venue],[data-sort],[data-sb],[data-sv],[data-pop],[data-anyrad],[data-rad],[data-ssort],[data-ftab],[data-scroll],[data-about],[data-about-close],[data-install]",
  );
  const pop = document.getElementById("pop");
  if (!ev.target.closest("#pop") && !(t && t.dataset.pop !== undefined)) pop.classList.remove("on");
  if (!t) return;
  const d = t.dataset,
    top = () => (document.getElementById("main").scrollTop = 0);
  if (d.about !== undefined) return openAbout();
  if (d.install !== undefined && installPrompt) {
    countEvent("install");
    installPrompt.prompt();
    installPrompt = null;
    return closeAbout();
  }
  if (d.aboutClose !== undefined) return closeAbout();
  if (d.scroll) {
    const c = t.parentNode.querySelector(".chips");
    c.scrollBy({ left: +d.scroll * c.clientWidth * 0.7, behavior: "smooth" });
    return;
  }
  if (d.play || d.playall !== undefined || d.pl || d.plshow !== undefined) {
    onPlayerClick(t, ev);
    return;
  }
  if (d.vsort) {
    if (d.vsort === "near" && USER.county)
      locate(() => (vsort = "near"), "Turn on location to sort by distance.");
    else {
      vsort = d.vsort;
      render();
    }
    return;
  }
  if (d.clear) {
    d.clear === "s" ? (term = "") : d.clear === "vf" ? (venueFilter = "") : (bandFilter = "");
    render();
    const n = document.getElementById(d.clear);
    n && n.focus();
    return;
  }
  if (d.show) go("Show:" + d.show);
  else if (d.band || d.venue) go(d.band ? "Band:" + d.band : "Venue:" + d.venue);
  else if (d.v) {
    if (d.v === view) top();
    else go(d.v);
  } else if (d.d !== undefined) {
    day = d.d;
    genre = "";
    render();
  } else if (d.ftab) {
    faveTab = d.ftab;
    render();
  } else if (d.g !== undefined) {
    genre = d.g;
    render();
  } else if (d.sort) {
    bsort = d.sort;
    render();
  } else if (d.sb) {
    countEvent("fave-band", d.sb);
    toggleFave("bands", d.sb);
    render();
  } else if (d.sv) {
    countEvent("fave-venue", d.sv);
    toggleFave("venues", d.sv);
    render();
  } else if (d.pop !== undefined) {
    pop.classList.toggle("on");
    distancePopup();
  } else if (d.anyrad !== undefined) {
    radius = ANY;
    render();
  } else if (d.rad) {
    const r = +d.rad;
    pop.classList.remove("on");
    if (r < ANY && USER.county) locate(() => (radius = r));
    else {
      radius = r;
      render();
    }
  } else if (d.ssort) {
    if (d.ssort === "dist" && USER.county)
      locate(() => (ssort = "dist"), "Turn on location to sort by distance.");
    else {
      ssort = d.ssort;
      render();
    }
  }
};

// phones: the pinned TOPA header only gets its dark backing once the page is scrolled
function markScrolled() {
  document.body.classList.toggle("scrolled", document.getElementById("main").scrollTop > 4);
}
document.getElementById("main").addEventListener("scroll", markScrolled, { passive: true });

// ---- Pull to refresh ----
// Phones and the home-screen app have no reload button, and the page scrolls inside <main>, so the
// browser's own pull-to-refresh doesn't kick in. Pull down at the top of any page to refresh.
(() => {
  const main = document.getElementById("main"),
    ptr = document.getElementById("ptr"),
    PULL_TO_REFRESH = 80,
    SIZE = 52;
  let y0 = null,
    x0 = 0,
    pull = 0,
    busy = false;
  // the page slides down with your finger and the button sits in the gap it opens
  const show = (y, turn) => {
    main.style.transform = y ? `translateY(${y}px)` : "";
    ptr.style.transform = `translate(-50%, ${Math.max(0, y - SIZE) / 2 + SIZE}px) rotate(${turn}deg)`;
    ptr.style.opacity = Math.min(1, y / (PULL_TO_REFRESH * 0.6));
  };
  const reset = () => {
    ptr.classList.add("back");
    main.classList.add("back");
    show(0, 0);
    setTimeout(() => {
      ptr.classList.remove("back", "spin", "ready");
      main.classList.remove("back");
    }, 250);
  };
  main.addEventListener(
    "touchstart",
    ev => {
      // center the button over the page area (on the Tesla the sidebar takes the left edge)
      const r = main.getBoundingClientRect();
      ptr.style.left = `${r.left + r.width / 2}px`;
      y0 = !busy && main.scrollTop <= 0 && ev.touches.length === 1 ? ev.touches[0].clientY : null;
      x0 = ev.touches[0].clientX;
      pull = 0;
    },
    { passive: true },
  );
  main.addEventListener(
    "touchmove",
    ev => {
      if (y0 === null) return;
      const dy = ev.touches[0].clientY - y0,
        dx = Math.abs(ev.touches[0].clientX - x0);
      if (dy <= 0 || dx > dy || main.scrollTop > 0) {
        if (pull) reset();
        y0 = pull ? y0 : null;
        pull = 0;
        return;
      }
      ev.preventDefault(); // stop the page's own bounce while pulling
      pull = Math.min(dy * 0.55, 130);
      ptr.classList.toggle("ready", pull >= PULL_TO_REFRESH);
      show(pull, pull * 3);
    },
    { passive: false },
  );
  main.addEventListener("touchend", async () => {
    if (y0 === null) return;
    y0 = null;
    if (pull < PULL_TO_REFRESH) return reset();
    busy = true;
    ptr.classList.add("spin");
    show(PULL_TO_REFRESH, 0);
    await Promise.all([refresh(), new Promise(r => setTimeout(r, 600))]); // spin long enough to see
    busy = false;
    reset();
  });
})();

// ---- Start ----
try {
  history.replaceState({ v: view, prev }, "", urlFor(view));
} catch (_) {}

load();

if (USER !== COUNTY || !store.get(LOCATION_KEY)) locate();

if ("serviceWorker" in navigator && location.protocol !== "file:")
  // the version rides along in the worker's address, so a new version installs a new worker with a fresh cache
  addEventListener("load", () =>
    navigator.serviceWorker.register(`sw.js?v=${VERSION}`, { updateViaCache: "none" }).catch(() => {}),
  );
