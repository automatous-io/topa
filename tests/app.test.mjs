//
// Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
//
// Browser tests for TOPA: they open the real app in headless Chrome and use it the way a person would
// (tap chips, star bands, search, switch pages), then check what's on screen.
//
// The setup (server, Chrome, fixture listings, pinned clock) is in harness.mjs.
//
// Run: npm install, then npm test. Chrome is found automatically, or set CHROME_PATH.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EVENTS, TZ, NOON, EVENING, PHONE, start, stop, open, text, count, tap } from "./harness.mjs";

before(start);
after(stop);

// ---- what the fixture says should be on screen ----

// "2026-10-24" for a moment in time, as a date in Pacific time
const dateOf = ms => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
// "2026-10-24T12:00" read as Pacific time -> milliseconds
function pacific(s) {
  const asUtc = Date.parse(s + "Z");
  const shown = Date.parse(new Date(asUtc).toLocaleString("en-US", { timeZone: TZ }) + " UTC");
  return asUtc + (asUtc - shown);
}
// shows on a date, minus today's shows that started more than 2 hours ago (the app hides those)
const showsOn = (date, now) =>
  EVENTS.filter(e => {
    const start = Date.parse(e.start);
    return dateOf(start) === date && (date !== dateOf(now) || start >= now - 2 * 3600e3);
  });

// rows in the main list (not the Faves section pinned above it)
const listRows = page =>
  page.$$eval("#main .rw[data-show]", rows => rows.filter(r => !r.closest(".favsec")).length);

// ---- Shows ----

test("opens on today's shows, titled Today before 4pm", async t => {
  const page = await open(t);
  assert.equal(await text(page, "h1"), "Today");
  const expected = showsOn("2026-10-24", pacific(NOON));
  assert.equal(await text(page, ".tsub"), `Sat, Oct 24 · ${expected.length} shows`);
  assert.equal(await listRows(page), expected.length);
});

test("says Tonight from 4pm and drops shows that already ended", async t => {
  const page = await open(t, { now: EVENING });
  assert.equal(await text(page, "h1"), "Tonight");
  const expected = showsOn("2026-10-24", pacific(EVENING));
  assert.ok(expected.length < showsOn("2026-10-24", pacific(NOON)).length);
  assert.equal(await listRows(page), expected.length);
});

test("day chips switch the list to that day", async t => {
  const page = await open(t);
  await tap(page, '.chip[data-d="2026-10-25"]');
  assert.equal(await text(page, "h1"), "Sunday");
  assert.match(await text(page, ".tsub"), /^Oct 25 · \d+ shows?$/);
  assert.equal(await listRows(page), showsOn("2026-10-25", pacific(NOON)).length);
});

test("a genre chip keeps only shows with that genre", async t => {
  const page = await open(t);
  const genre = await page.$eval(".sw[data-row=genres] .chip[data-g]:not([data-g=''])", el => el.dataset.g);
  await tap(page, `.chip[data-g="${genre}"]`);
  const rows = await listRows(page);
  assert.ok(rows > 0);
  assert.equal(await text(page, ".tsub"), `Sat, Oct 24 · ${rows} show${rows > 1 ? "s" : ""}`);
});

test("search finds bands, venues and shows, and clearing it goes back", async t => {
  const page = await open(t);
  await page.type("#s", "rock");
  assert.equal(await text(page, "h1"), "Search");
  assert.ok((await count(page, "#main .rw[data-show]")) > 0);
  await tap(page, ".clr");
  assert.equal(await text(page, "h1"), "Today");
});

// ---- Faves ----

test("starring a show faves the band, pins it under My Faves, and survives a reload", async t => {
  const page = await open(t);
  const band = await page.$eval("#main .rw [data-sb]", el => el.dataset.sb);
  await tap(page, `#main .rw [data-sb="${band}"]`);
  assert.equal(await text(page, ".favsec h2"), "My Faves");
  assert.ok(await page.$(`.favsec [data-sb="${band}"].on`));
  await page.reload({ waitUntil: "networkidle0" });
  assert.ok(await page.$(`.favsec [data-sb="${band}"].on`), "fave was not saved");
});

test("a show pinned under My Faves isn't listed again below it", async t => {
  const page = await open(t);
  const total = await listRows(page);
  const band = await page.$eval("#main .rw [data-sb]", el => el.dataset.sb);
  await tap(page, `#main .rw [data-sb="${band}"]`);
  const pinned = await count(page, ".favsec .rw[data-show]");
  assert.ok(pinned > 0);
  assert.equal(await count(page, `#main .rw:not(.favsec .rw) [data-sb="${band}"]`), 0);
  assert.equal(await listRows(page), total - pinned);
});

test("every starred show moves up to My Faves, not just the first few", async t => {
  const page = await open(t);
  const total = await listRows(page);
  for (let i = 0; i < 5; i++) {
    const band = await page.$eval("#main .rw:not(.favsec .rw) .star:not(.on)", el => el.dataset.sb);
    await tap(page, `#main .rw:not(.favsec .rw) [data-sb="${band}"]`);
  }
  assert.equal(await count(page, "#main .rw:not(.favsec .rw) .star.on"), 0);
  const pinned = await count(page, ".favsec .rw[data-show]");
  assert.ok(pinned >= 5);
  assert.equal(await listRows(page), total - pinned);
});

test("shows at a faved venue are tagged Fave venue", async t => {
  const venue = showsOn("2026-10-24", pacific(NOON))[0].venue;
  const page = await open(t, { faves: { bands: [], venues: [venue] } });
  assert.ok((await count(page, ".favsec .fvtag")) > 0);
});

test("the Faves page switches between bands and venues", async t => {
  const [a, b] = EVENTS;
  const page = await open(t, { query: "&view=Faves", faves: { bands: [a.artist], venues: [b.venue] } });
  assert.equal(await count(page, ".cards .vcard"), 0);
  await tap(page, '[data-ftab="venues"]');
  assert.equal(await count(page, ".cards .vcard"), 1);
});

test("the star on a band photo faves it without leaving the Bands page", async t => {
  const page = await open(t, { query: "&view=Bands" });
  const band = await page.$eval(".agrid .fv.tog", el => el.dataset.sb);
  await tap(page, ".agrid .fv.tog");
  assert.equal(await text(page, "h1"), "Bands");
  await page.waitForSelector(`.agrid .fv.tog.on[data-sb="${band}"]`, { timeout: 2000 });
});

// ---- Venues and pages ----

test("the Venues list shows each venue's next show, never one that already ended", async t => {
  const page = await open(t, { query: "&view=Venues", now: EVENING });
  const labels = await page.$$eval(".vrow .vwhen", els => els.map(e => e.textContent));
  assert.ok(labels.length > 0);
  for (const l of labels) assert.ok(!/^Today (10|11|12|1|2|3)/.test(l), `ended show listed: ${l}`);
});

test("tapping a row opens the show, and back returns to the list", async t => {
  const page = await open(t);
  await Promise.all([
    page.waitForFunction(() => location.search.includes("view=Show")),
    tap(page, "#main .rw .rb b"),
  ]);
  assert.ok(await page.$(".hero"));
  await page.goBack();
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Today");
});

test("the car-only voice hint shows only in the Tesla", async t => {
  const venue = EVENTS[0].venue;
  const plain = await open(t, { query: `&view=Venue:${encodeURIComponent(venue)}` });
  assert.equal(await plain.$(".vhint"), null);
  const car = await open(t, { query: `&tesla=1&view=Venue:${encodeURIComponent(venue)}` });
  assert.match(await text(car, ".vhint"), /Navigate to/);
});

// ---- Shows people added (community/) ----

test("an added show uses its venue's added details and has no Ventura Rocks link", async t => {
  const vr = EVENTS.find(e => e.url && Date.parse(e.start) > pacific(NOON));
  const listings = {
    updated: "2026-10-24T09:00:00-07:00",
    events: [
      {
        artist: "The Tide Pool Ramblers",
        start: "2026-10-24T20:00:00-07:00",
        end: null,
        venue: "The New Spot",
        address: "1 Main St, Ojai, CA 93023",
        city: "Ojai",
        tags: ["rock"],
        url: "",
        source: "community",
        lat: 34.448,
        lng: -119.243,
      },
      { ...vr, source: "ventura-rocks" },
    ],
    venues: { "The New Spot": { phone: "(805) 555-0123", website: "https://newspot.example" } },
  };
  const added = await open(t, { listings, query: "&view=Show:0" });
  assert.equal(await text(added, "h1"), "The Tide Pool Ramblers");
  assert.doesNotMatch(await text(added, ".srcline"), /Ventura Rocks/);
  assert.ok(await added.$('a[href="tel:8055550123"]'), "calls the added phone number");
  assert.ok(await added.$('a[href="https://newspot.example"]'), "links the added website");
  // distance works from the map spot that came with the show
  await added.evaluate(() => {
    USER = { lat: 34.448, lng: -119.243 };
    render();
  });
  assert.match(await text(added, ".mrow .sub"), /here/);

  const listed = await open(t, { listings, query: "&view=Show:1" });
  assert.match(await text(listed, "a.srcline"), /Ventura Rocks/, "Ventura Rocks shows keep their link");
});

test("a venue someone added shows up before its first show", async t => {
  const listings = {
    updated: "2026-10-24T09:00:00-07:00",
    events: EVENTS.slice(0, 3),
    venues: {
      "The Quiet Room": { city: "Santa Paula", address: "1 Main St, Santa Paula", lat: 34.35, lng: -119.06 },
    },
  };
  const list = await open(t, { listings, query: "&view=Venues" });
  assert.match(await list.$eval("#main", el => el.textContent), /The Quiet Room.*No shows yet/);
  const page = await open(t, { listings, query: "&view=" + encodeURIComponent("Venue:The Quiet Room") });
  assert.equal(await text(page, "h1"), "The Quiet Room");
  assert.ok(await page.$(".addrow a"), "links to add a show there");
});

test("a band someone added shows up before its first show, but not under its other names", async t => {
  const listings = {
    updated: "2026-10-24T09:00:00-07:00",
    events: EVENTS.slice(0, 3),
    bands: {
      "Quiet Ramblers": { genres: ["folk"], links: { website: "https://example.com" } },
      "The Quiet Ramblers": { genres: ["folk"], alias_of: "Quiet Ramblers" },
    },
  };
  const list = await open(t, { listings, query: "&view=Bands" });
  const tiles = await list.$$eval(".agrid .tile b", els => els.map(e => e.textContent));
  assert.ok(tiles.includes("Quiet Ramblers"));
  assert.ok(!tiles.includes("The Quiet Ramblers"), "an alias isn't its own band");
  const page = await open(t, { listings, query: "&view=" + encodeURIComponent("Band:Quiet Ramblers") });
  assert.match(await text(page, ".hero small"), /FOLK/);
  assert.equal(await text(page, ".blinks .bl"), "Website");
});

// ---- Layout ----

test("phones get the TOPA top bar and a four-button tab bar", async t => {
  const page = await open(t, { viewport: PHONE });
  assert.match(await text(page, ".mbar .mhome"), /TOPA/);
  assert.match(await text(page, ".mbar .mhome"), /Local Music/);
  assert.match(await text(page, ".mbar .mcounty"), /Ventura County/);
  assert.deepEqual(
    await page.$$eval("nav button", bs =>
      bs.filter(b => getComputedStyle(b).display !== "none").map(b => b.textContent.trim()),
    ),
    ["Shows", "Bands", "Venues", "Faves"],
  );
  // About opens from the logo
  await tap(page, ".mbar .mhome");
  assert.equal(await page.$eval("#about", el => el.hidden), false);
});

test("phones: the search button slides out a search box, and the X closes it", async t => {
  const page = await open(t, { viewport: PHONE });
  await tap(page, ".mbar [data-search]");
  assert.ok(await page.$(".mbar #ms"));
  await page.type("#ms", "ventura");
  assert.ok((await page.$$("#main section")).length > 0);
  await tap(page, ".mbar [data-searchx]");
  assert.equal(await page.$(".mbar #ms"), null);
  assert.equal(await text(page, "h1"), "Today");
});

test("About opens and closes, and shows the version", async t => {
  const page = await open(t);
  await tap(page, "nav .about-tab");
  assert.match(await text(page, ".aver a"), /^v\d+\.\d+\.\d+$/);
  await tap(page, ".ax");
  assert.equal(await page.$eval("#about", el => el.hidden), true);
});
