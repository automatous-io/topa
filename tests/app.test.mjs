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
  assert.match(await text(added, ".hero small"), /HERE/);

  const listed = await open(t, { listings, query: "&view=Show:1" });
  assert.match(await text(listed, "a.srcline"), /Ventura Rocks/, "Ventura Rocks shows keep their link");
});

test("a show with no venue is listed by its town, and never as a blank venue", async t => {
  const show = {
    ...EVENTS[0],
    artist: "No Venue Quartet",
    venue: "",
    address: "",
    city: "Ojai",
    tags: ["Ojai"],
  };
  const listings = { updated: "2026-10-24T09:00:00-07:00", events: [show, ...EVENTS.slice(1, 4)] };
  const page = await open(t, { listings });
  const row = await page.$$eval(
    "#main .rw[data-show]",
    rs => rs.find(r => /No Venue Quartet/.test(r.textContent)).textContent,
  );
  assert.match(row, /Venue not listed · Ojai/);
  assert.equal(await count(page, '[data-venue=""]'), 0, "no link to a blank venue");
  await page.$$eval("#main .rw[data-show]", rs =>
    rs.find(r => /No Venue Quartet/.test(r.textContent)).click(),
  );
  assert.equal(await text(page, "h1"), "No Venue Quartet");
  const venues = await open(t, { listings, query: "&view=Venues" });
  assert.equal(await count(venues, "#main .vrow"), new Set(EVENTS.slice(1, 4).map(e => e.venue)).size);
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
  assert.equal(await text(page, ".plinks a"), "Website");
});

// ---- Layout ----

test("phones: TOPA in the middle of the tab bar opens Home; no county in the top bar", async t => {
  const page = await open(t, { viewport: PHONE });
  assert.equal(await page.$(".mbar .mcounty"), null);
  assert.deepEqual(
    await page.$$eval("nav button", bs =>
      bs
        .filter(b => getComputedStyle(b).display !== "none")
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        .map(b => b.innerText.trim()),
    ),
    ["Shows", "Bands", "TOPA", "Venues", "Faves"],
  );
  await tap(page, "nav .logo");
  assert.match(await text(page, ".hhead h1"), /^Good (morning|afternoon|evening)$/);
  assert.ok(await page.$("nav .logo.on"));
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
  await tap(page, "nav .logo");
  await tap(page, ".hinfo");
  assert.match(await text(page, ".aver a"), /^v\d+\.\d+\.\d+$/);
  await tap(page, ".ax");
  assert.equal(await page.$eval("#about", el => el.hidden), true);
});

// ---- Cancelled or changed? ----

test("a cancelled show is marked, skipped by Play all, and its page offers Back on", async t => {
  const i = EVENTS.findIndex(e => e.artist.startsWith("Ukulele"));
  const events = EVENTS.map((e, k) => (k === i ? { ...e, cancelled: true, cancel_note: "Rained out" } : e));
  const page = await open(t, { viewport: PHONE, listings: { updated: "2026-10-24T09:00:00-07:00", events } });
  assert.match(await text(page, ".top"), /1 cancelled/);
  const row = await page.$("#main .rw.off");
  assert.match(await row.evaluate(r => r.textContent), /Ukulele Weekly Jam.*Cancelled/);
  assert.equal(await row.$("[data-play]"), null, "no play button on a cancelled show");
  await tap(page, "#main .rw.off .tcol");
  assert.match(await text(page, ".offpill"), /Cancelled/);
  assert.match(await text(page, ".offwhy"), /Rained out/);
  assert.match(await text(page, ".report"), /Back on\?/);
});

test("Cancelled or changed? opens the form for that show", async t => {
  const page = await open(t, { viewport: PHONE });
  await tap(page, "#main .rw[data-show] .tcol");
  await tap(page, ".report");
  assert.equal(await page.$eval(".rgo", a => a.hasAttribute("href")), false, "nothing picked yet");
  await tap(page, '.ropt[data-rpick="New time"]');
  const href = await page.$eval(".rgo", a => a.href);
  const q = new URL(href).searchParams;
  assert.equal(q.get("template"), "report-show.yml");
  assert.equal(q.get("change"), "New time");
  assert.ok(q.get("band") && q.get("venue") && /^\d{4}-\d{2}-\d{2}$/.test(q.get("date")));
});

test("a show moved to a new time says so", async t => {
  const i = EVENTS.findIndex(e => e.artist.startsWith("Ukulele"));
  const was = EVENTS[i].start;
  const start = new Date(new Date(was).getTime() + 36e5).toISOString();
  const events = EVENTS.map((e, k) => (k === i ? { ...e, start, moved_from: was } : e));
  const page = await open(t, { viewport: PHONE, listings: { updated: "2026-10-24T09:00:00-07:00", events } });
  const row = await page.$$eval("#main .rw[data-show]", rs => rs.find(r => /Ukulele/.test(r.textContent)).textContent);
  assert.match(row, /New time/);
  await page.$$eval("#main .rw[data-show]", rs => rs.find(r => /Ukulele/.test(r.textContent)).querySelector(".tcol").click());
  assert.match(await text(page, ".newwhy"), /New time · was 10am/);
});

test("phones: swiping the About popup down closes it, a small drag doesn't", async t => {
  const page = await open(t, { viewport: PHONE });
  await tap(page, "nav .logo");
  await tap(page, ".hinfo");
  const box = await page.$eval("#about .acard", c => {
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 40 };
  });
  const swipe = async dy => {
    await page.touchscreen.touchStart(box.x, box.y);
    for (let i = 1; i <= 8; i++) await page.touchscreen.touchMove(box.x, box.y + (dy * i) / 8);
    await page.touchscreen.touchEnd();
    await new Promise(r => setTimeout(r, 300));
  };
  await swipe(60);
  assert.equal(await page.$eval("#about", el => el.hidden), false, "a small drag springs back");
  await swipe(220);
  assert.equal(await page.$eval("#about", el => el.hidden), true);
});

test("a band with a bio gets an About section; one without doesn't", async t => {
  const band = EVENTS[0].artist;
  const listings = {
    updated: "2026-10-24T09:00:00-07:00",
    events: EVENTS,
    bands: { [band]: { genres: ["funk", "soul"], town: "Ojai", bio: "Grooves with a twist.", bio_source: "Written by TOPA." } },
  };
  const page = await open(t, { viewport: PHONE, listings, query: `&view=Band:${encodeURIComponent(band)}` });
  assert.match(await text(page, ".bio"), /Grooves with a twist\..*funk.*soul.*From Ojai.*Written by TOPA\./s);
  const other = EVENTS.find(e => e.artist !== band).artist;
  const plain = await open(t, { viewport: PHONE, listings, query: `&view=Band:${encodeURIComponent(other)}` });
  assert.equal(await plain.$(".bio"), null);
});

// ---- Home ----

test("Home: the app opens on it, with faves and tonight, and ⓘ opens About with the area", async t => {
  const band = EVENTS.find(e => e.start.startsWith("2026-10-24")).artist;
  const page = await open(t, { viewport: PHONE, query: "&view=Home", faves: { bands: [band], venues: [] } });
  assert.match(await text(page, ".hhead h1"), /^Good (morning|afternoon|evening)$/);
  const heads = await page.$$eval(".hsec h2", hs => hs.map(h => h.textContent));
  assert.deepEqual(heads, ["Your faves are playing", "Today"]);
  assert.ok((await count(page, ".hlist .hrow")) > 1);
  assert.equal(await page.$(".feat"), null, "no Featured card until a band is featured");
  await tap(page, ".hinfo");
  assert.match(await text(page, ".aset"), /Area\s*Ventura County/);
});

test("Home: See all opens Faves with ‹ Home, and ‹ Home goes back", async t => {
  const band = EVENTS.find(e => e.start.startsWith("2026-10-24")).artist;
  const page = await open(t, { viewport: PHONE, query: "&view=Home", faves: { bands: [band], venues: [] } });
  await tap(page, '.hmore[data-v="Faves"]');
  assert.equal(await text(page, "h1"), "Faves");
  await tap(page, ".mbar .mback");
  assert.match(await text(page, ".hhead h1"), /^Good (morning|afternoon|evening)$/);
  await tap(page, 'nav [data-v="Faves"]');
  assert.equal(await page.$(".mbar .mback"), null, "the Faves tab itself has no ‹ Home");
});

test("Home: a featured band gets the card and a tag on its page; members show when sent", async t => {
  const e = EVENTS.find(x => x.start.startsWith("2026-10-24"));
  const listings = {
    updated: "2026-10-24T09:00:00-07:00",
    events: EVENTS,
    featured: [{ band: e.artist, blurb: "One line about them." }],
    bands: { [e.artist]: { members: [["Ana", "Vocals"], ["Bo", "Drums"]] } },
  };
  const page = await open(t, { viewport: PHONE, listings, query: "&view=Home" });
  assert.match(await text(page, ".feat"), /One line about them\./);
  await tap(page, ".feat .fbody > b");
  assert.match(await text(page, ".hero small"), /Featured on TOPA/i);
  assert.match(await text(page, ".members"), /Ana\s*Vocals\s*Bo\s*Drums/);
});

test("Home: each faved band shows once, with its next show", async t => {
  // a plain band name with two or more shows still ahead
  const counts = {};
  EVENTS.filter(e => e.start > "2026-10-24T14" && !/[,&/]|w\//.test(e.artist)).forEach(e => (counts[e.artist] = (counts[e.artist] || 0) + 1));
  const band = Object.keys(counts).find(n => counts[n] > 1);
  assert.ok(band, "the fixture has a band with two shows");
  const page = await open(t, { viewport: PHONE, query: "&view=Home", faves: { bands: [band], venues: [] } });
  const rows = await page.$eval(".hlist", l => [...l.querySelectorAll(".rb > b")].map(b => b.textContent));
  assert.equal(rows.filter(n => n === band).length, 1);
});

test("the app opens on Shows; Settings: Open to Home makes it start on Home", async t => {
  const page = await open(t, { viewport: PHONE, query: "&view=Home" });
  const plain = page.url().replace(/&view=Home/, "");
  await page.goto(plain, { waitUntil: "networkidle0" });
  assert.match(await text(page, "h1"), /^(Today|Tonight)$/);
  await tap(page, "nav .logo");
  await tap(page, ".hinfo");
  await tap(page, '[data-start="Home"]');
  await page.goto(plain, { waitUntil: "networkidle0" });
  assert.match(await text(page, ".hhead h1"), /^Good (morning|afternoon|evening)$/);
});
