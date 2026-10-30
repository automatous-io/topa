//
// Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
//
// TOPA Local Music Finder
// Shows listings from events.json (written 3x a day by scripts/fetch_events.py), plays 30-second previews
// from Apple Music, and keeps faves on the device. Town centers and the genre map live in data.js.

// ---- Settings and state ----
// the app's version: shown in About, and it names the offline cache, so bumping it refreshes every device
const VERSION = "2.5.1";
const params = new URLSearchParams(location.search);

// Is this the car's browser? Some versions say "Tesla" in the user agent, but current ones just say
// "X11; Linux x86_64" like desktop Chrome on Linux, so a Linux touchscreen (which almost nothing else is)
// counts too. As a sure fallback, opening TOPA once with ?tesla=1 remembers it on this device (?tesla=0 undoes it).
const IN_TESLA = (() => {
  const ua = navigator.userAgent;
  const touch =
    navigator.maxTouchPoints > 0 || "ontouchstart" in window || matchMedia("(any-pointer: coarse)").matches;
  const linuxTouchscreen = /X11; Linux/.test(ua) && !/Android|CrOS/.test(ua) && touch;
  const flag = params.get("tesla");
  try {
    if (flag === "0") localStorage.removeItem("topa.car.v1");
    else if (flag !== null) localStorage.setItem("topa.car.v1", "1");
    if (localStorage.getItem("topa.car.v1")) return true;
  } catch (_) {}
  return flag !== null && flag !== "0" ? true : /Tesla/i.test(ua) || linuxTouchscreen;
})();
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
  searchOpen = false, // phones: the search button was tapped (the box shows even before typing)
  searchSlide = false, // phones: play the search box's slide-out on the next draw only
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

// a show sent to TOPA directly (community/), not from the Ventura Rocks calendar
const isAdded = e => e.source === "community";

function toShow(o, rawTags) {
  o.url = o.url || (isAdded(o) ? "" : VR_CAL);
  o.city = o.city || townFromAddress(o.address);
  // the venue's map spot, else its town's center
  const c = o.lat != null && o.lng != null ? [o.lat, o.lng] : CITY_FALLBACK[o.city] || null;
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
    extra: { bands: d.bands || {}, venues: d.venues || {} },
  };
}

// band and venue details people added (events.json "bands" and "venues")
let EXTRA = { bands: {}, venues: {} };
const setExtra = x => (EXTRA = { bands: (x && x.bands) || {}, venues: (x && x.venues) || {} });
const addedVenue = name => EXTRA.venues[name] || {};
// an added venue as a stand-in show, for venues with nothing scheduled yet (town, address, map spot)
const venueSpot = name => {
  const v = addedVenue(name);
  return {
    venue: name,
    city: v.city || "",
    address: v.address || "",
    lat: v.lat ?? null,
    lng: v.lng ?? null,
  };
};
// bands people added that have no shows yet, listed anyway (not their other names): [name, []]
const emptyBands = () =>
  Object.keys(EXTRA.bands)
    .filter(n => !EXTRA.bands[n].alias_of && !EVENTS.some(e => bandName(e) === n))
    .map(n => [n, []]);
// venues people added that have no shows yet, listed anyway: [name, []]
const emptyVenues = () =>
  Object.keys(EXTRA.venues)
    .filter(n => !EVENTS.some(e => e.venue === n))
    .map(n => [n, []]);

// show the saved copy right away (works offline), then swap in the latest events.json
async function load() {
  const c = store.get(LISTINGS_KEY),
    cached = c && Array.isArray(c.events) ? dropPast(c.events) : [];
  setExtra(c && c.extra);
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
    setExtra(j.extra);
    setEvents(dropPast(j.events));
    store.set(LISTINGS_KEY, { ts: Date.now(), updated: j.updated, events: j.events, extra: j.extra });
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
// a listing can come without a venue (it happens on Ventura Rocks): it still shows, but never as a venue
const venueLabel = e => (e.venue ? venueName(e.venue) : "Venue not listed");
// the venue under a band name: a link to its page, or plain text when there's no venue
const venueLink = (e, cls, inner) =>
  e.venue
    ? `<button class="${cls}" data-venue="${esc(e.venue)}">${inner}<span>›</span></button>`
    : `<span class="${cls}">${inner}</span>`;
const townPart = e => (e.city ? ` <em>· ${esc(e.city)}${milesPart(e)}</em>` : milesPart(e));

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

// a band or venue picture: its photo when there is one, otherwise initials on a color unique to the name
// (photo: for venues; bands look up their own)
function art(s, cls = "", band = true, photo = "") {
  const ph = photo || (band && photoFor(s));
  if (ph)
    return `<div class="art ${cls}"${band ? ` data-a="${esc(s)}"` : ""} style="background-image:url('${ph}')"></div>`;
  return `<div class="art g ${cls}"${band ? ` data-a="${esc(s)}"` : ""} style="background:${nameColors(s)}">${esc(initials(s))}</div>`;
}

// the two colors unique to a name, as a gradient (initials tiles and header washes)
function nameColors(s) {
  const h = hash(s),
    a = h % 360,
    b = (a + 40 + ((h >> 9) % 100)) % 360;
  return `linear-gradient(${(h >> 4) % 360}deg,hsl(${a} 70% 45%),hsl(${b} 75% 22%))`;
}

// behind a venue or show page header: the venue's photo, else its colors
const heroBg = name => {
  const ph = venuePhoto(name);
  return `<div class="hbg${ph ? "" : " g"}" style="background:${ph ? `center 35% / cover url('${ph}')` : nameColors(venueName(name))}"></div>`;
};

const playBadge = h =>
  `<span class="pb" role="button" aria-label="Play preview" data-play="${esc(h)}"${hasPreview(h) ? "" : " hidden"}>${svg("play")}</span>`;

// play button at the end of a show row
const rowPlay = h =>
  `<button class="rplay" aria-label="Play preview" data-play="${esc(h)}"${hasPreview(h) ? "" : " hidden"}>${svg("play")}</button>`;

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

const venueArt = (v, c = "") => art(venueName(v), c, false, venuePhoto(v));

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
  // tab icons
  Shows:
    '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></g>',
  Bands:
    '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></g>',
  Venues:
    '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></g>',
  Faves:
    '<path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  search:
    '<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></g>',
  info: '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 10.5v6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="7.3" r="1.4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  install:
    '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  share:
    '<path d="M12 15V4M8 7.5 12 4l4 3.5M7 11H6a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  // for a band's own show link when it's their Instagram post
  ig: '<rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.3" cy="6.7" r="1.3"/>',
  // where a show came from: @ for shows sent to TOPA, a calendar for Ventura Rocks
  at: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.6"/><path d="M15.6 8.6v4.6a2.4 2.4 0 0 0 4.8 0V12a8.4 8.4 0 1 0-3.4 6.8"/></g>',
  cal: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10.2h17M8 3v4M16 3v4"/></g>',
  store:
    '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 8h18l-1 3H4z"/><path d="M5 11v9h14v-9"/><path d="M10 20v-5h4v5"/></g>',
  pin: '<g fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 21s7-6.6 7-12a7 7 0 1 0-14 0c0 5.4 7 12 7 12z"/><circle cx="12" cy="9" r="2.6"/></g>',
  tel: '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  globe:
    '<g fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></g>',
  // band link icons
  bc: '<path d="M3 17 9 7h12l-6 10z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  sp: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M7.5 9.5c3-1 6.5-.7 9 .8M8 12.6c2.5-.7 5.2-.4 7.2.8M8.6 15.4c1.9-.5 3.9-.3 5.5.6"/></g>',
  yt: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10 9.2v5.6l4.8-2.8z"/></g>',
  sc: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17h9.5a3.5 3.5 0 0 0 0-7 5.5 5.5 0 0 0-9.5-2.6z"/><path d="M3 13.5V17M6 11v6"/></g>',
  fb: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M15.5 7.5h-1.8a2.2 2.2 0 0 0-2.2 2.2V21M9 12.5h6"/></g>',
  shr: '<path d="M12 15V4M8 7.5 12 4l4 3.5M7 11H6a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
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

// venue tiles: Directions, Call, Website, Share. Missing details show dimmed; no Share in the car.
// share: the page to share, e.g. "Venue:The Grape"
const venueActions = (v, share) => {
  const tel = addedVenue(v.venue).phone;
  const web = safeUrl(addedVenue(v.venue).website);
  const tile = (href, icon, label, title, cls = "", newTab = true) =>
    href
      ? `<a class="vt${cls}" href="${href}"${newTab ? ' target="_blank" rel="noopener"' : ""} title="${title}">${svg(icon)}<span>${label}</span></a>`
      : `<span class="vt off" aria-disabled="true" title="No ${label.toLowerCase()} for this venue yet">${svg(icon)}<span>${label}</span></span>`;
  return (
    `<div class="vtiles${IN_TESLA ? " three" : ""}">` +
    tile(`https://www.google.com/maps/dir/?api=1&destination=${mapsQuery(v)}`, "pin", "Directions", "Directions", " dir") +
    tile(tel && `tel:${tel.replace(/[^\d+]/g, "")}`, "tel", "Call", `Call ${esc(tel || "")}`, "", false) +
    tile(web, "globe", "Website", "Venue website") +
    (IN_TESLA ? "" : `<button class="vt" data-share="${esc(share)}">${svg("shr")}<span>Share</span></button>`) +
    `</div>`
  );
};

// full address of a page
const pageUrl = v => location.origin + urlFor(v);

// share menu if there is one (https only), else copy the link, else show it
async function sharePage(v) {
  const url = pageUrl(v),
    title = "TOPA: " + pagePath(v).split("/").pop();
  countEvent("share", v);
  if (navigator.share) {
    try {
      return await navigator.share({ title, url });
    } catch (err) {
      if (err && err.name === "AbortError") return; // closed the share menu
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return toast("Link copied");
  } catch (_) {}
  // fallback copy for insecure pages
  const box = document.createElement("textarea");
  box.value = url;
  box.setAttribute("readonly", "");
  box.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(box);
  box.select();
  box.setSelectionRange(0, url.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (_) {}
  box.remove();
  toast(copied ? "Link copied" : url);
}

// in the car: tapping a map link may not start the car's navigation, but voice always does
const voiceHint = v =>
  IN_TESLA
    ? `<p class="vhint">${svg("mic")}<span>Say <b>“Navigate to ${esc(venueName(v.venue))}”</b>` +
      `${v.address ? `<i>${esc(v.address)}</i>` : ""}</span></p>`
    : "";

// TOPA wordmark: the ridgeline and the name; the CSS lays them out per spot
const RIDGE = "M1 15 L8 11 L13 13 L19 3 L24 9 L28 6 L33 12";
const ridge = () =>
  `<svg class="wm" viewBox="0 0 34 18" aria-hidden="true"><path class="wm-ridge" d="${RIDGE}"/></svg>`;
const wordmark = (id, tag) =>
  `<span class="wmk wmk-${id}">${ridge()}<span class="wm-name">TOPA</span>` +
  (tag ? `<span class="wm-tag">Local Music<br>Finder</span>` : "") +
  `</span>`;

const starButton = (on, attr, big) =>
  `<button class="star${on ? " on" : ""}${big ? " big" : ""}" ${attr} aria-label="${on ? "Unfave" : "Fave"}" title="${on ? "Unfave" : "Fave"}">${svg("Faves")}</button>`;

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
    `<div class="tcol"><span>${weekdayLabel(e)}</span><span>${d.getMonth() + 1}/${d.getDate()}</span><b>${timeLabel(e)}${sourceIcon(e, true)}</b>${milesUnderTime(e)}</div>` +
    `<div class="rb"><b>${esc(venueLabel(e))}</b>` +
    venueLink(e, "vb", `${esc(e.city)}${milesPart(e)}${bill}`) +
    `</div></div>`
  );
};

// where a show came from: @ (sent to TOPA) or a calendar (Ventura Rocks); after: gap on the left
const sourceIcon = (e, after) =>
  isAdded(e)
    ? `<span class="srci cm${after ? " af" : ""}" title="Sent straight to TOPA">${svg("at")}</span>`
    : `<span class="srci vr${after ? " af" : ""}" title="From the Ventura Rocks community calendar">${svg("cal")}</span>`;

// key for the source icons, under a list of shows
const sourceKey = () =>
  `<div class="skey"><span>${svg("cal")}Ventura Rocks calendar</span><span class="cm">${svg("at")}Sent to TOPA</span></div>`;

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
    `<div class="rw" data-show="${e.id}"><div class="tcol">${date}<b>${timeLabel(e)}${sourceIcon(e, true)}</b>${atVenue ? "" : milesUnderTime(e)}</div>${artWithPlay(band)}` +
    `<div class="rb"><b>${esc(e.artist)}</b>` +
    (atVenue
      ? ""
      : venueLink(e, "vb", esc(venueLabel(e)) + townPart(e))) +
    `</div>` +
    `${tags}${rowPlay(band)}${starButton(SAVED.bands.includes(band), `data-sb="${esc(band)}"`)}</div>`
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
  const next = L.find(isStillOn) || L[0] || venueSpot(n);
  const meta = [next.city, distanceLabel(next), L.length ? countLabel(L.length, "show") : "No shows yet"]
    .filter(Boolean)
    .map(esc)
    .join(" · ");
  return (
    `<div class="rw vrow" data-venue="${esc(n)}">${venueArt(n)}` +
    `<div class="rb"><b>${esc(venueName(n))}</b><span class="vmeta">${meta}</span></div>` +
    (L.length
      ? `<div class="vnext"><span class="vwhen">${nextLabel(next)}</span><span class="vwho">${esc(next.artist)}</span></div>`
      : `<div class="vnext"></div>`) +
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
    wd = d => d.toLocaleDateString("en-US", { weekday: "short" }),
    // tile: [small line, big line] for the phone's day tiles
    defs = [["tonight", todayWord(), todayWord(), e => sameDay(new Date(e.start), NOW), [wd(t0), t0.getDate()]]];
  for (let i = 1; i < 7; i++) {
    const d = new Date(t0);
    d.setDate(t0.getDate() + i);
    const k = dayKey(d);
    defs.push([
      k,
      d.toLocaleDateString("en-US", { weekday: "short" }) + " " + d.getDate(),
      // title is the weekday only; the date goes underneath
      d.toLocaleDateString("en-US", { weekday: "long" }),
      e => dayKey(new Date(e.start)) === k,
      [wd(d), d.getDate()],
    ]);
  }
  defs.push(
    ["weekend", "This weekend", "Weekend", e => wk.includes(dayKey(new Date(e.start))), ["", "Weekend"]],
    ["all", "All", "All shows", () => true, ["", "All"]],
  );
  const N = showsInRange().filter(isStillOn);
  return defs.map(([k, l, long, f, tile]) => ({ k, l, long, tile, L: N.filter(f) })).filter(d => d.L.length);
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
    // wide screens show dl, phones the dt tile
    d =>
      `<button class="chip${d.k === sel ? " on" : ""}${d.tile[0] ? "" : " wide"}" data-d="${d.k}">` +
      `<span class="dl">${d.l}</span><span class="dt">${d.tile[0] ? `<small>${d.tile[0]}</small>` : ""}<b>${d.tile[1]}</b></span></button>`,
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

// empty search: suggested towns and genres
function searchIdeas() {
  const top = (f, n) =>
    [...groupBy(EVENTS.filter(isStillOn).flatMap(f), x => x)]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, n)
      .map(x => x[0]);
  const chips = l => l.map(x => `<button class="chip" data-term="${esc(x)}">${esc(x)}</button>`).join("");
  const towns = top(e => (e.city ? [e.city] : []), 8),
    genres = top(e => e.tags, 8);
  return (
    (towns.length ? `<h2 class="dh">Towns</h2><div class="ideas">${chips(towns)}</div>` : "") +
    (genres.length ? `<h2 class="dh">Genres</h2><div class="ideas">${chips(genres)}</div>` : "")
  );
}

function showsPage() {
  const k = searchWords();
  if (searchOpen && !k.length)
    return (
      topBar("Search", `<button class="chip sx" data-searchx>Cancel</button>`, "", true, searchBox()) +
      searchIdeas()
    );
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
        playAllButton("Play results") + distanceButton("d-top") + `<button class="chip sx" data-searchx>Cancel</button>`,
        countLabel(R.length, "show"),
        true,
        searchBox(),
      ) +
      `<div class="frow fm">${distanceButton("d-row")}</div>` +
      searchResults(k, R)
    );
  }
  const { cur, chips, gchips, L, lbl } = pickDay();
  // date line under the title, e.g. "Fri, Oct 30 · 38 shows"
  const today = !cur
    ? ""
    : cur.k === "tonight"
      ? NOW.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + " · "
      : /^\d{4}-/.test(cur.k)
        ? new Date(cur.k + "T12:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · "
        : "";
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
  // "My Faves": faved bands, or anything at a faved venue, pinned on top (same filters as the list)
  const faves = L.filter(e => SAVED.bands.includes(bandName(e)) || SAVED.venues.includes(e.venue)).sort(
    (a, b) => a.startMs - b.startMs,
  );
  // all of the day's faves go here and are left out of the list below
  const pinned = new Set(faves.map(x => x.id));
  const favesSection = faves.length
    ? `<section class="favsec"><h2 class="dh">My Faves</h2>` +
      faves.map(x => showRow(x, !multi)).join("") +
      // the divider alone separates My Faves from the full list; the day is already in the page title
      `</section><div class="rule"></div>`
    : "";
  // wide screens: distance sits in the header; phones: distance and sort lead the genre row
  return (
    topBar(lbl, playAllButton() + distanceButton("d-top"), n ? today + countLabel(n, "show") : "", true, searchBox()) +
    chips +
    `<div class="frow">${distanceButton("d-row")}${gchips}${sb}</div><div class="rule"></div>` +
    favesSection +
    (n
      ? byDay
          .map(([k, l]) => [k, l.filter(x => !pinned.has(x.id))])
          .filter(([, l]) => l.length)
          .map(
            ([k, l]) =>
              (multi ? `<h2 class="dh">${dh(k)}</h2>` : "") +
              ord(l)
                .map(x => showRow(x, true))
                .join(""),
          )
          .join("") + sourceKey()
      : emptyMessage())
  );
}

const updatedLabel = () =>
  status.updated
    ? new Date(status.updated).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "";

function searchResults(k, L) {
  const hit = s => k.every(x => s.toLowerCase().includes(x));
  const tagsOf = (n, l) => (l[0] ? l[0].tags : (EXTRA.bands[n] && EXTRA.bands[n].genres) || []);
  const B = [...groupBy(EVENTS, bandName), ...emptyBands()].filter(([n, l]) =>
      hit(n + " " + tagsOf(n, l).join(" ")),
    ),
    V = [...groupBy(EVENTS.filter(e => e.venue), e => e.venue), ...emptyVenues()]
      .filter(([n, l]) => hit(venueName(n) + " " + (l[0] || venueSpot(n)).city))
      .sort(
        (a, b) => (milesTo(a[1][0] || venueSpot(a[0])) ?? 1e9) - (milesTo(b[1][0] || venueSpot(b[0])) ?? 1e9),
      );
  const sec = (t, n, body) => `<section><h2>${t} <span class="cnt">${n}</span></h2>${body}</section>`;
  return (
    (B.length
      ? sec(
          "Bands",
          B.length,
          `<div class="row">${B.map(([n, l]) => `<button class="tile" data-band="${esc(n)}">${bandTileArt(n)}<b>${esc(n)}</b><small>${l.length ? nextLabel(l.find(isStillOn) || l[0]) + (l.filter(isStillOn).length > 1 ? " · " + l.filter(isStillOn).length + " shows" : "") : "No shows yet"}</small></button>`).join("")}</div>`,
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
    (L.length ? sourceKey() : "") +
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
  const bands = [...groupBy(EVENTS.filter(isStillOn), bandName), ...emptyBands()].filter(([n]) =>
    n.toLowerCase().includes(filter),
  );
  // bands with no shows yet go last when sorting by soonest
  const when = L => (L[0] ? L[0].startMs : Infinity);
  bands.sort(
    bsort === "az"
      ? (a, b) => a[0].localeCompare(b[0])
      : (a, b) => when(a[1]) - when(b[1]) || a[0].localeCompare(b[0]),
  );
  const sort = sortButton(
    bsort === "soon" ? "Soonest" : "A–Z",
    `data-sort="${bsort === "soon" ? "az" : "soon"}"`,
  );
  const tile = ([n, L]) =>
    `<button class="tile" data-band="${esc(n)}">${bandTileArt(n)}<b>${esc(n)}</b>` +
    `<small>${L.length ? nextLabel(L[0]) + (L.length > 1 ? " · " + L.length + " shows" : "") : "No shows yet"}</small></button>`;
  return (
    topBar(
      "Bands",
      `<i class="brk"></i>` + playAllButton() + sort,
      countLabel(bands.length, "band"),
      true,
      filterBox("bf", "Filter bands", bandFilter),
    ) + `<div class="agrid">${bands.map(tile).join("")}</div>`
  );
}

// the links a band can send, and their names
const LINK_NAMES = {
  website: "Website",
  instagram: "Instagram",
  facebook: "Facebook",
  bandcamp: "Bandcamp",
  spotify: "Spotify",
  youtube: "YouTube",
  soundcloud: "SoundCloud",
};
const LINK_ICONS = {
  website: "globe",
  instagram: "ig",
  facebook: "fb",
  bandcamp: "bc",
  spotify: "sp",
  youtube: "yt",
  soundcloud: "sc",
};
// links as one line of small icon + name links (Instagram shows the @handle); empty when there are none
const igHandle = url => (url.match(/instagram\.com\/([^/?#]+)/i) || [])[1];
// the fave star as a round outlined button, sitting in a row with other buttons
const ringStar = (on, attr) => starButton(on, attr).replace('class="star', 'class="star ring');
// a band's round picture with its fave star on the corner (band and show pages, like the Bands grid)
const artWithStar = name =>
  `<div class="artw">${art(name, "round")}` +
  starButton(SAVED.bands.includes(name), `data-sb="${esc(name)}"`).replace('class="star', 'class="star badge') +
  `</div>`;

const linkLine = (links, keys) => {
  const shown = keys
    .filter(k => safeUrl(links[k]))
    .map(k => {
      const url = safeUrl(links[k]),
        handle = k === "instagram" && igHandle(url);
      return `<a href="${esc(url)}" target="_blank" rel="noopener">${svg(LINK_ICONS[k])}${esc(handle ? "@" + handle : LINK_NAMES[k])}</a>`;
    });
  return shown.length ? `<p class="plinks">${shown.join("")}</p>` : "";
};
const bandLinks = name => linkLine((EXTRA.bands[name] && EXTRA.bands[name].links) || {}, Object.keys(LINK_NAMES));
// a venue's website has its own tile
const venueLinks = name => linkLine(addedVenue(name), ["instagram", "facebook"]);

// "+ Add a show" links at the bottom of band and venue pages, with the form filled in
// what TOPA knows about a band or venue, to fill in its update form (keys are the form's field ids)
const filled = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
const bandNow = name => {
  const b = EXTRA.bands[name] || {},
    links = b.links || {};
  return filled({
    name,
    genres: (b.genres || []).join(", "),
    town: b.town,
    ...Object.fromEntries(Object.keys(LINK_NAMES).map(k => [k, links[k]])),
    apple: b.apple && b.apple !== "none" ? `https://music.apple.com/us/artist/${b.apple}` : b.apple,
  });
};
const venueNow = v => {
  const added = addedVenue(v.venue),
    spot = added.lat != null ? [added.lat, added.lng] : null;
  return filled({
    pick: v.venue,
    address: added.address || v.address,
    city: added.city || v.city,
    coords: spot ? spot.join(", ") : "",
    phone: added.phone,
    website: added.website,
    instagram: added.instagram,
  });
};

const addLinks = list =>
  `<div class="addrow">${list
    .map(
      ([form, label, fill]) =>
        `<a href="${formUrl(form, fill)}" target="_blank" rel="noopener">+ ${label}</a>`,
    )
    .join("")}</div>`;

function bandPage(name) {
  const L = EVENTS.filter(e => bandName(e) === name);
  const tags = L[0] && L[0].tags.length ? L[0].tags : (EXTRA.bands[name] && EXTRA.bands[name].genres) || [];
  const genres = tags.length ? " · " + esc(tags.join(", ").toUpperCase()) : "";
  return (
    `<div class="hero">${artWithStar(name)}<div class="hx">` +
    `<small>ARTIST${genres}</small><h1>${esc(name)}</h1>` +
    `<div class="acts">${heroPlayButton(name)}` +
    `<span class="acount">${L.length ? showCount(L.length) : "No shows yet"}</span></div>${bandLinks(name)}` +
    `</div></div>` +
    L.map(venueDateRow).join("") +
    (L.length ? sourceKey() : "") +
    addLinks([
      ["add-show", "Add a show", { band: name }],
      ["add-band", "Update band info", bandNow(name)],
    ])
  );
}

function venuesPage() {
  const filter = venueFilter.toLowerCase();
  const place = ([n, L]) => L[0] || venueSpot(n);
  const venues = [
    ...groupBy(
      showsInRange().filter(e => e.venue && isStillOn(e)),
      e => e.venue,
    ),
    ...emptyVenues().filter(x => inRadius(place(x))),
  ].filter(x => (venueName(x[0]) + " " + place(x).city).toLowerCase().includes(filter));
  // "Nearest" needs a location; without one the list starts A–Z
  const order = USER.county && vsort === "near" ? "az" : vsort;
  venues.sort(
    order === "az"
      ? (a, b) => venueName(a[0]).localeCompare(venueName(b[0]))
      : (a, b) => (milesTo(place(a)) ?? 1e9) - (milesTo(place(b)) ?? 1e9),
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
  const v = L[0] || (EXTRA.venues[key] ? venueSpot(key) : null);
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
    `<div class="hero ph">${heroBg(v.venue)}<div class="hx">` +
    `<small>VENUE · ${esc(v.city.toUpperCase())}${dist ? " · " + dist.toUpperCase() : ""}</small>` +
    `<h1>${esc(venueName(v.venue))}</h1>` +
    (v.address ? `<p class="vaddr">${esc(v.address)}</p>` : "") +
    venueLinks(v.venue) +
    `${venueActions(v, "Venue:" + v.venue)}${voiceHint(v)}` +
    // the star shares a row with Play lineup (or "No shows yet"), never a row of its own
    `<div class="lrow">` +
    (L.length
      ? `<button class="lineup" data-playall>${svg("play")}Play lineup · ${countLabel(L.length, "show")}</button>`
      : `<p class="sub">No shows yet</p>`) +
    ringStar(SAVED.venues.includes(v.venue), `data-sv="${esc(v.venue)}"`) +
    `</div></div></div>` +
    section(todayWord(), tonight) +
    section("This week", thisWeek, tonight.length) +
    section("Later", later.slice(0, 30), tonight.length || thisWeek.length) +
    (upcoming.length ? sourceKey() : "") +
    addLinks([
      ["add-show", "Add a show here", { venue: v.venue }],
      ["add-venue", "Update venue info", venueNow(v)],
    ])
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
  const alsoHere = e.venue ? EVENTS.filter(x => x.venue === e.venue && bandName(x) !== band).slice(0, 6) : [];
  // source line: the Ventura Rocks listing or the link the show was sent with
  const href = isAdded(e) ? safeUrl(e.url) : e.url || VR_CAL;
  const onIg = isAdded(e) && /^https:\/\/(www\.)?instagram\.com\//.test(href);
  const from = !isAdded(e)
    ? "From the Ventura Rocks calendar · see the listing"
    : "Sent to TOPA" + (href ? (onIg ? " · see the Instagram post" : " · see the details") : "");
  const source = href
    ? `<a class="srcline" href="${esc(href)}" target="_blank" rel="noopener">${sourceIcon(e)}${from} ›</a>`
    : `<p class="srcline">${sourceIcon(e)}${from}</p>`;
  const tags = e.tags.length ? `<div class="tg">${e.tags.map(x => `<i>${esc(x)}</i>`).join("")}</div>` : "";
  return (
    `<div class="hero ph sh">${heroBg(e.venue || band)}<div class="hx"><div class="hid">${artWithStar(band)}<div class="hidt">` +
    `<small>${date} · <span class="ac">${timeLabel(e).toUpperCase()}</span>${sourceIcon(e, true)}` +
    `${distanceLabel(e) ? " · " + distanceLabel(e).toUpperCase() : ""}</small><h1>${esc(e.artist)}</h1>` +
    venueLink(e, "vb big", esc(venueLabel(e)) + (e.city ? ` <em>· ${esc(e.city)}</em>` : "")) +
    `</div></div><div class="mrow">${heroPlayButton(band)}${tags}</div>` +
    `${bandLinks(band)}</div></div>` +
    (e.venue
      ? `<h2>${esc(venueName(e.venue))}</h2>${venueLinks(e.venue)}${venueActions(e, "Show:" + e.id)}${voiceHint(e)}`
      : "") +
    source +
    (otherDates.length ? `<h2>More ${esc(band)} dates</h2>${otherDates.map(venueDateRow).join("")}` : "") +
    (alsoHere.length
      ? `<h2>Also at ${esc(venueName(e.venue))}</h2>${alsoHere.map(x => showRow(x, false, true)).join("")}`
      : "") +
    (otherDates.length || alsoHere.length ? sourceKey() : "")
  );
}

function favesPage() {
  const upcoming = EVENTS.filter(isStillOn);
  const bands = [...groupBy(upcoming, bandName), ...emptyBands()].filter(([n]) => SAVED.bands.includes(n));
  const venues = SAVED.venues.map(n => [n, upcoming.filter(e => e.venue === n)]);
  if (!bands.length && !venues.length)
    return (
      topBar("Faves", "", "", true) +
      `<p class="empty">No faves yet. Tap ☆ on a show to fave the band, or on a venue to fave the venue.</p>`
    );
  const bandCard = ([n, L]) => {
    const next = L[0];
    if (!next)
      return (
        `<div class="card" data-band="${esc(n)}">${artWithPlay(n, "round")}<div class="ci">` +
        `<button class="cn" data-band="${esc(n)}">${esc(n)}</button><span>No shows yet</span>` +
        `</div>${starButton(true, `data-sb="${esc(n)}"`)}</div>`
      );
    const dist = distanceLabel(next);
    return (
      `<div class="card" data-show="${next.id}">${artWithPlay(n, "round")}<div class="ci">` +
      `<button class="cn" data-band="${esc(n)}">${esc(n)}</button>` +
      `<span>Next: ${nextLabel(next)} · ${esc(venueLabel(next))}</span>` +
      `<span>${dist ? dist + " · " : ""}${showCount(L.length)}</span>` +
      `</div>${starButton(true, `data-sb="${esc(n)}"`)}</div>`
    );
  };
  const venueCard = ([n, L]) => {
    const v = L[0] || venueSpot(n);
    const where = [v.city, distanceLabel(v)].filter(Boolean).map(esc).join(" · ");
    return (
      `<div class="card vcard">${venueArt(n)}<div class="ci">` +
      `<button class="cn" data-venue="${esc(n)}">${esc(venueName(n))}</button>` +
      `<span>${where}${v.city ? " · " : ""}${showCount(L.length)}</span><span>${esc(v.address)}</span>` +
      `</div>${starButton(true, `data-sv="${esc(n)}"`)}<div class="vacts">${venueActions(v, "Venue:" + n)}</div></div>`
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
    `<button class="logo" data-about aria-label="About TOPA">${wordmark("nav", true)}</button>${tabs}` +
    `<button class="about-tab" data-about>${svg("info")}About</button>` +
    `<div class="credit">${updated}</div>`
  );
}

// a day title too wide for the phone uses the short name: Wednesday → Wed
function fitTitle() {
  const h = document.querySelector(".top h1");
  if (!h) return;
  const full = h.dataset.full || h.textContent;
  h.textContent = full;
  h.removeAttribute("aria-label");
  const short = /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day$/.test(full) && full.slice(0, 3);
  if (short && h.scrollWidth > h.clientWidth) {
    h.dataset.full = full;
    h.textContent = short;
    h.setAttribute("aria-label", full);
  }
}
addEventListener("resize", fitTitle);

function render() {
  if (!PAGES[view.split(":")[0]]) view = "Shows";
  const page = view.split(":")[0];
  const arg = view.slice(page.length + 1);
  // keep chip rows where they were scrolled (tapping a genre re-renders the page)
  const rowScroll = {};
  for (const w of document.querySelectorAll(".sw"))
    rowScroll[w.dataset.row] = w.querySelector(".chips").scrollLeft;
  document.getElementById("nav").innerHTML = navHtml(page);
  // phone top bar: logo (opens About), county, search
  // in search mode the bar becomes the search box
  const searching = page === "Shows" && (searchOpen || !!term);
  const phoneBar = searching
    ? `<header class="mbar"><div class="msf${searchSlide ? " slide" : ""}">${svg("search")}` +
      `<input id="ms" type="search" placeholder="Bands, venues, towns, genres" value="${esc(term)}" ` +
      `autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="Search">` +
      `<button class="mbtn" data-searchx aria-label="Close search">${CLOSE_ICON}</button></div></header>`
    : `<header class="mbar"><button class="mhome" data-about aria-label="About TOPA">${wordmark("phone", true)}</button>` +
      `<span class="mcounty">${svg("Venues")}Ventura County</span>` +
      `<button class="mbtn" data-search aria-label="Search bands, venues, towns">${svg("search")}</button></header>`;
  searchSlide = false;
  const main = document.getElementById("main");
  main.classList.toggle("srch", searching);
  main.innerHTML = phoneBar + PAGES[page](arg);
  for (const w of document.querySelectorAll(".sw"))
    w.querySelector(".chips").scrollLeft = rowScroll[w.dataset.row] || 0;
  // keep the picked day tile in view
  const dayRow = document.querySelector('.sw[data-row="days"] .chips'),
    picked = dayRow && dayRow.querySelector(".chip.on");
  if (picked) {
    const pad = 48,
      l = picked.getBoundingClientRect().left - dayRow.getBoundingClientRect().left + dayRow.scrollLeft,
      r = l + picked.offsetWidth;
    if (r > dayRow.scrollLeft + dayRow.clientWidth - pad) dayRow.scrollLeft = r - dayRow.clientWidth + pad;
    else if (l < dayRow.scrollLeft + pad) dayRow.scrollLeft = Math.max(0, l - pad);
  }
  fitTitle();
  updateScrollRows();
  markScrolled();
  syncPlayIcons();
  prioritizeOnScreen();
  wireTextBoxes();
}

// typing re-renders the page; keep the cursor in the box
function wireTextBoxes() {
  const boxes = { bf: v => (bandFilter = v), vf: v => (venueFilter = v), s: v => (term = v), ms: v => (term = v) };
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

// ---- 30-second previews (Apple Music) ----
// Apple's iTunes Search API: free, no key, about 20 calls a minute. Bands are checked in the background,
// soonest and on-screen first.
const ITUNES = "https://itunes.apple.com",
  MATCH_KEY = "topa.matches.v2"; // v1 held Deezer matches
try {
  localStorage.removeItem("topa.matches.v1");
} catch (_) {}

let MATCHES = (s => (s && typeof s === "object" && !Array.isArray(s) ? s : {}))(store.get(MATCH_KEY));

// MATCHES[band] = { v, t }: v is { id, n: Apple Music name, pic, url: artist page, np: 1 if no previews }
// or 0 for no match; t is when it was checked. Matches are rechecked after 14 days, misses after 3.
// a band's own details can pin its Apple Music artist (an id) or turn previews off ("none")
const pinnedArtist = h => String((EXTRA.bands[h] && EXTRA.bands[h].apple) || "");

const matchFor = h => {
  const pin = pinnedArtist(h);
  if (pin === "none") return 0;
  const r = MATCHES[h];
  if (!r) return undefined;
  if (pin && !(r.v && String(r.v.id) === pin)) return undefined; // a saved guess that isn't the pinned artist
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

// a photo the band sent in (a file in the repo, e.g. community/photos/bands/saltgrass.jpg)
const localPhoto = p => (/^(community\/)?photos\/[\w/-]+\.jpg$/.test(p || "") ? p : "");
const bandPhoto = h => localPhoto(EXTRA.bands[h] && EXTRA.bands[h].photo);
// a venue's photo (its own, else TOPA's)
const venuePhoto = v => localPhoto(addedVenue(v).photo);

// the band's picture: its own photo, else album art from Apple Music
const photoFor = h => {
  const v = matchFor(h);
  return bandPhoto(h) || (v && safeUrl(v.pic)) || "";
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

// cover/tribute acts and generic listings ("Open Mic") almost always match the wrong artist
const GENERIC =
  /open mic|\bjam\b|karaoke|\bdj\b|orchestra|symphony|choir|tribute|\bcovers?\b|party|festival|fundraiser|showcase|jazz band|\bnight\b/i;

const bandEvents = h => EVENTS.filter(x => bandName(x) === h);

// bands worth looking up: ones with shows, or a profile someone added
const canMatch = h => {
  const L = bandEvents(h);
  return (
    (L.length > 0 || !!EXTRA.bands[h]) &&
    normName(h).length > 2 &&
    !GENERIC.test(h) &&
    !L.some(
      e => e.tags.includes("covers") || e.tags.includes("tribute") || /tribute|\bcovers?\b/i.test(e.artist),
    )
  );
};

// Apple's album art at 600x600 instead of 100x100
const bigArt = u => safeUrl((u || "").replace(/\/\d+x\d+bb\./, "/600x600bb."));

const getJson = async u => {
  const r = await fetch(u);
  if (!r.ok) throw r.status;
  return r.json();
};

// Apple Music songs -> what the player needs
const toTracks = songs =>
  songs
    .filter(t => t && t.wrapperType === "track" && t.previewUrl)
    .slice(0, 5)
    .map(t => ({
      title: t.trackName || "",
      url: t.previewUrl,
      cover: bigArt(t.artworkUrl100),
      link: t.trackViewUrl,
    }));

// a band's top tracks with preview links, kept for the visit
const trackCache = new Map();

async function topTracks(id) {
  if (trackCache.has(id)) return trackCache.get(id);
  const d = await getJson(`${ITUNES}/lookup?id=${encodeURIComponent(id)}&entity=song&limit=10`);
  const list = toTracks(d.results || []);
  trackCache.set(id, list);
  return list;
}

// find a band on Apple Music (cached); reveals its play buttons and picture when found
const lookupsInFlight = new Map();

function lookupBand(h) {
  const v = matchFor(h);
  if (v !== undefined) return Promise.resolve(v);
  if (lookupsInFlight.has(h)) return lookupsInFlight.get(h);
  const pin = pinnedArtist(h);
  if (!pin && !canMatch(h)) return Promise.resolve(0);
  const p = (async () => {
    let songs;
    if (pin)
      songs = (await getJson(`${ITUNES}/lookup?id=${encodeURIComponent(pin)}&entity=song&limit=10`)).results;
    else {
      // songs by artists with this exact name; the one with the most songs wins
      const d = await getJson(
        `${ITUNES}/search?term=${encodeURIComponent(h)}&entity=song&attribute=artistTerm&limit=25`,
      );
      const mine = (d.results || []).filter(t => normName(t.artistName || "") === normName(h));
      const counts = {};
      mine.forEach(t => (counts[t.artistId] = (counts[t.artistId] || 0) + 1));
      const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      songs = mine.filter(t => String(t.artistId) === best);
    }
    const first = (songs || []).find(t => t.wrapperType === "track") || (songs || [])[0];
    if (!first) {
      saveMatch(h, 0);
      return 0;
    }
    const tr = toTracks(songs);
    trackCache.set(String(first.artistId), tr);
    const r = { id: String(first.artistId), n: first.artistName, pic: tr[0] ? tr[0].cover : "" };
    r.url = safeUrl((first.artistViewUrl || first.artistLinkUrl || "").replace(/\?.*$/, ""));
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

// check every band in the background, soonest first, at Apple's pace
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
    await new Promise(r => setTimeout(r, 3200));
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
      toast("Couldn't reach Apple Music. Check the connection.");
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

// what the player is showing, for the full-screen player
let nowShowing = null;

function showPlayer(it, t, v) {
  nowShowing = { it, t, v };
  const P = document.getElementById("player"),
    e = nextShow(it.band);
  P.hidden = false;
  document.getElementById("app").classList.add("pl");
  const pic = safeUrl((v && v.pic) || (t && t.cover));
  inPlayer(".pla").style.backgroundImage = pic ? `url("${pic}")` : "";
  inPlayer(".plt").textContent = t ? t.title : "Loading preview…";
  // credit Apple Music and link to the song
  const am = inPlayer(".pldz"),
    amLink = safeUrl((t && t.link) || (v && v.url));
  am.hidden = !amLink;
  if (amLink) am.href = amLink;
  inPlayer(".plb").textContent =
    it.band + (e ? " · " + nextLabel(e) + " · " + venueLabel(e) : "") + (e ? "  ›" : "");
  inPlayer(".plp i").style.width = "0";
  inPlayer(".plcur").textContent = "0:00";
  if (t && "mediaSession" in navigator && window.MediaMetadata)
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: it.band,
      album: e ? nextLabel(e) + " · " + venueLabel(e) : "TOPA",
      artwork: pic ? [{ src: pic, sizes: "500x500", type: "image/jpeg" }] : [],
    });
  syncPlayIcons();
  paintFull();
}

// ---- Full-screen player ----
const inFull = s => document.querySelector("#fp " + s);
const fullOpen = () => !document.getElementById("fp").hidden;

function openFull() {
  if (!nowShowing) return;
  document.getElementById("fp").hidden = false;
  paintFull();
  countEvent("full-player");
}
const closeFull = () => (document.getElementById("fp").hidden = true);

// fill in the full-screen player
function paintFull() {
  if (!fullOpen() || !nowShowing) return;
  const { it, t, v } = nowShowing,
    e = nextShow(it.band),
    q = playback.queue;
  const pic = safeUrl((v && v.pic) || (t && t.cover));
  inFull(".fpart").style.backgroundImage = pic ? `url("${pic}")` : "";
  inFull(".fpart").textContent = pic ? "" : initials(it.band);
  const oneBand = q.every(x => x.band === it.band);
  inFull(".fpq").textContent =
    q.length > 1 ? `${oneBand ? "Top songs" : "Lineup"} · ${playback.index + 1} of ${q.length}` : "Preview";
  inFull(".fpt").textContent = t ? t.title : "Loading preview…";
  inFull(".fpb").textContent = it.band;
  const show = inFull(".fpshow");
  show.hidden = !e;
  if (e) {
    const d = new Date(e.start);
    inFull(".fptime").textContent = timeLabel(e).toUpperCase();
    inFull(".fpven").textContent = venueLabel(e);
    inFull(".fpwhen").textContent = [
      sameDay(d, NOW) ? showDayWord(e) : `${weekdayLabel(e)} ${d.getMonth() + 1}/${d.getDate()}`,
      e.city,
      distanceLabel(e),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const dir = inFull(".fpdir");
  dir.hidden = !e;
  if (e) dir.href = `https://www.google.com/maps/dir/?api=1&destination=${mapsQuery(e)}`;
  const am = inFull(".fpam"),
    amLink = safeUrl((t && t.link) || (v && v.url));
  am.hidden = !amLink;
  if (amLink) am.href = amLink;
  const faved = SAVED.bands.includes(it.band);
  const fave = inFull(".fpfave");
  fave.classList.toggle("on", faved);
  fave.setAttribute("aria-label", faved ? "Unfave this band" : "Fave this band");
  fave.innerHTML = svg("Faves");
  dir.innerHTML = svg("Venues");
  inFull("[data-pl=prev]").innerHTML = svg("prev");
  inFull("[data-pl=next]").innerHTML = svg("next");
  paintFullPlay();
  paintFullTime();
}
function paintFullPlay() {
  if (!fullOpen()) return;
  const on = playback.queue.length && !audio.paused && audio.src !== SILENT_WAV;
  inFull(".fppp").innerHTML = svg(on ? "pause" : "play");
}
function paintFullTime() {
  if (!fullOpen() || audio.src === SILENT_WAV) return;
  const d = audio.duration || 30;
  inFull(".fpp i").style.width = Math.min(100, (audio.currentTime / d) * 100) + "%";
  inFull(".fpcur").textContent = mmss(audio.currentTime);
  inFull(".fpdur").textContent = mmss(d);
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
  paintFullPlay();
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
  closeFull();
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
  paintFullTime();
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

// a TOPA form on GitHub (.github/ISSUE_TEMPLATE), with answers filled in, e.g. formUrl("add-show", { venue })
const formUrl = (form, fill = {}) =>
  `${REPO}/issues/new?` +
  new URLSearchParams({ template: form + ".yml", ...fill }).toString().replace(/&/g, "&amp;");

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

// "Get the app": one tap where the browser allows it, otherwise the steps
function installTile() {
  if (IN_TESLA || INSTALLED) return "";
  const tile = (tag, attrs, icon, sub) =>
    `<${tag} class="abig inst"${attrs}>${svg(icon)}<span><b>Get the app</b><small>${sub}</small></span></${tag}>`;
  if (installPrompt) return tile("button", " data-install", "install", "Install with one tap");
  if (ON_IPHONE) return tile("div", "", "share", "Share › Add to Home Screen");
  if (ON_ANDROID) return tile("div", "", "install", "⋮ › Install app");
  return tile("div", "", "install", "Add it from your phone's browser");
}

const newTab = (href, label) => `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;

// About
function aboutHtml() {
  const app = installTile();
  const fact = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  return (
    `<div class="abar"><button class="ax" data-about-close aria-label="Close">${CLOSE_ICON}</button></div>` +
    `<header class="ahero">${wordmark("about", true)}` +
    `<p class="astory">Made for and by local live music lovers.<br>` +
    `Bands, fans, and venues add to it, so it keeps getting better.</p></header>` +
    `<div class="abody">` +
    `<div class="abigs${app ? "" : " one"}">` +
    `<button class="abig add" data-about-add>${svg("at")}<span><b>Add to TOPA</b><small>Shows, bands, venues</small></span><span class="ago">›</span></button>` +
    app +
    `</div>` +
    `<h3>Where shows come from</h3>` +
    `<div class="legend">` +
    `<div><span class="srci vr">${svg("cal")}</span><span>The ${newTab(VR_SITE, "Ventura Rocks")} ` +
    `community calendar, checked 3x a day</span></div>` +
    `<div><span class="srci cm">${svg("at")}</span><span>Sent to TOPA by bands, fans, and venues</span></div>` +
    `</div>` +
    `<h3>Good to know</h3>` +
    `<dl class="afacts">` +
    fact("Previews and art", newTab("https://music.apple.com", "Apple Music")) +
    fact("Distances", "Approximate") +
    fact("Visits", "Counted anonymously, no cookies") +
    (updatedLabel() ? fact("Listings updated", updatedLabel()) : "") +
    `</dl>` +
    `<p class="alinks">${newTab(REPO, "GitHub")}${newTab(REPO + "#readme", "README")}` +
    `${newTab(REPO + "/blob/main/LICENSE", "License")}<span class="aver">${newTab(REPO, "v" + VERSION)}</span></p>` +
    `<p class="acopy">© 2026 AUTOMATOUS.IO.<br>Not affiliated with Ventura Rocks or Apple.</p>` +
    `</div>`
  );
}

// About's second page: the four forms
function addHtml() {
  const form = (name, icon, title, sub) =>
    `<a class="aform" href="${formUrl(name)}" target="_blank" rel="noopener">${svg(icon)}` +
    `<span><b>${title}</b><small>${sub}</small></span></a>`;
  const step = (title, text) => `<li><b>${title}</b><span>${text}</span></li>`;
  return (
    `<div class="abar"><button class="aback" data-about-back>‹ About</button>` +
    `<button class="ax" data-about-close aria-label="Close">${CLOSE_ICON}</button></div>` +
    `<header class="ahero addh"><div class="atrow"><span class="aat">${svg("at")}</span>` +
    `<div><h2 class="atitle">Add to TOPA</h2><p class="atag">Shows, bands, venues</p></div></div>` +
    `<p class="astory">Bands, fans, and venues can add shows.<br>` +
    `They get the <span class="srci cm">${svg("at")}</span>mark in the list.</p></header>` +
    `<div class="abody">` +
    `<div class="aforms">` +
    form("add-show", "plus", "Show", "One night at any venue") +
    form("add-weekly-show", "cal", "Weekly show", "Open mics, residencies") +
    form("add-band", "Bands", "Band", "Links, photo, previews") +
    form("add-venue", "Venues", "Venue", "Address, map spot, photo") +
    `</div>` +
    `<p class="anote"><b>Already listed?</b>Send the same form with just what's changing. Blank answers stay as they are.</p>` +
    `<h3>How it works</h3>` +
    `<ol class="asteps">` +
    step("Pick what you're adding", "A show, a weekly show, a band, or a venue.") +
    step(
      "Fill in a short form",
      "It's on GitHub, so you'll need a free account. A bot checks it in about a minute and tells you if anything needs fixing.",
    ) +
    step("It goes live", "Once it's approved, it shows up on TOPA within minutes.") +
    `</ol>` +
    `</div>`
  );
}

// show one of About's pages from the top
const aboutPage = html => {
  const card = document.querySelector("#about .acard");
  card.innerHTML = html;
  card.scrollTop = 0;
};

function openAbout() {
  const a = document.getElementById("about");
  a.querySelector(".acard").innerHTML = aboutHtml();
  a.hidden = false;
}
const closeAbout = () => (document.getElementById("about").hidden = true);

addEventListener("keydown", ev => ev.key === "Escape" && (closeAbout(), closeFull()));

// phone search button: open Shows in search mode
function openSearch() {
  searchOpen = true;
  searchSlide = true;
  view === "Shows" ? render() : go("Shows");
  const box = document.getElementById("ms");
  if (box) box.focus();
}

// ---- Taps ----
// one click handler for the whole app; buttons say what they do with data-* attributes
document.body.onclick = ev => {
  if (ev.target.id === "about") return closeAbout(); // tapped outside the card
  if (ev.target.id === "fp") return closeFull(); // wide screens: tapped outside the player card
  const link = ev.target.closest("a[href]");
  if (link) {
    if (link.href.includes("/maps/dir/"))
      countEvent("directions", link.closest("[data-venue]")?.dataset.venue || "");
    return;
  }
  const t = ev.target.closest(
    "[data-share],[data-plfull],[data-fpclose],[data-fpfave],[data-search],[data-searchx],[data-term],[data-play],[data-playall],[data-pl],[data-plshow],[data-vsort],[data-clear],[data-show],[data-v],[data-d],[data-g],[data-band],[data-venue],[data-sort],[data-sb],[data-sv],[data-pop],[data-anyrad],[data-rad],[data-ssort],[data-ftab],[data-scroll],[data-about],[data-about-close],[data-about-add],[data-about-back],[data-install]",
  );
  const pop = document.getElementById("pop");
  if (!ev.target.closest("#pop") && !(t && t.dataset.pop !== undefined)) pop.classList.remove("on");
  if (!t) return;
  const d = t.dataset,
    top = () => (document.getElementById("main").scrollTop = 0);
  if (d.about !== undefined) return openAbout();
  if (d.share) return sharePage(d.share);
  if (d.plfull !== undefined) return openFull();
  if (d.fpclose !== undefined) return closeFull();
  if (d.fpfave !== undefined) {
    const h = playback.band;
    if (!h) return;
    countEvent("fave-band", h);
    toggleFave("bands", h);
    render();
    return paintFull();
  }
  // phones: the mini player opens the full-screen player
  if (d.plshow !== undefined && !t.closest("#fp") && matchMedia("(max-width: 700px)").matches) return openFull();
  if (d.plshow !== undefined && t.closest("#fp")) closeFull();
  if (d.search !== undefined) return openSearch();
  if (d.searchx !== undefined) {
    searchOpen = false;
    term = "";
    return render();
  }
  if (d.term) {
    term = d.term;
    return render();
  }
  if (d.install !== undefined && installPrompt) {
    countEvent("install");
    installPrompt.prompt();
    installPrompt = null;
    return closeAbout();
  }
  if (d.aboutClose !== undefined) return closeAbout();
  if (d.aboutAdd !== undefined) return aboutPage(addHtml());
  if (d.aboutBack !== undefined) return aboutPage(aboutHtml());
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
    // the Shows tab exits search
    if (d.v === "Shows" && (searchOpen || term)) {
      searchOpen = false;
      term = "";
      if (view === "Shows") return render(), top();
    }
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

// phones: the top bar gets its backing once the page scrolls
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
// a tap skips the opening splash
document.getElementById("splash").onclick = ev => (ev.currentTarget.style.display = "none");

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
