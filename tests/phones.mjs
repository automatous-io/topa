//
// Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
//
// The phones, the screens, and what counts as a layout problem. Used by phones.test.mjs and phone-sheet.mjs.

import { EVENTS, open, visit } from "./harness.mjs";

// sizes as each phone's browser reports them
export const PHONES = [
  { name: "Small (old iPhone SE)", width: 320, height: 568, deviceScaleFactor: 2 },
  { name: "Galaxy S24", width: 360, height: 780, deviceScaleFactor: 3 },
  { name: "iPhone SE", width: 375, height: 667, deviceScaleFactor: 2 },
  { name: "iPhone 13 mini", width: 375, height: 812, deviceScaleFactor: 3 },
  { name: "iPhone 16", width: 393, height: 852, deviceScaleFactor: 3 },
  { name: "iPhone 16 Pro", width: 402, height: 874, deviceScaleFactor: 3 },
  { name: "Pixel 9", width: 412, height: 915, deviceScaleFactor: 2.625 },
  { name: "iPhone 16 Pro Max", width: 440, height: 956, deviceScaleFactor: 3 },
].map(p => ({ ...p, isMobile: true, hasTouch: true }));

// so Get the app shows each phone's own steps
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const userAgent = phone => (/iPhone/.test(phone.name) ? IPHONE : ANDROID);

const band = EVENTS[0].artist;
const venue = EVENTS[0].venue;
const faves = { bands: [band], venues: [venue] };
const pause = ms => new Promise(r => setTimeout(r, ms));
const press = async (page, sel) => {
  await page.click(sel);
  await pause(80);
};

// every main screen
export const SCREENS = [
  { name: "Shows", query: "" },
  {
    name: "Shows · Wednesday",
    query: "",
    go: page => page.$$eval(".chips.days .chip", cs => cs.find(c => /wed/i.test(c.textContent))?.click()),
  },
  {
    name: "Search",
    query: "",
    go: async page => {
      await press(page, ".mbar [data-search]");
      await page.type("#ms", "jazz");
      await pause(200);
    },
  },
  { name: "Bands", query: "&view=Bands" },
  { name: "Venues", query: "&view=Venues" },
  { name: "Faves", query: "&view=Faves" },
  { name: "Band page", query: `&view=Band:${encodeURIComponent(band)}` },
  { name: "Venue page", query: `&view=Venue:${encodeURIComponent(venue)}` },
  { name: "Show page", query: "", go: page => press(page, "#main .rw[data-show]") },
  { name: "About", query: "", go: page => press(page, "nav .logo") },
  {
    name: "Add to TOPA",
    query: "",
    go: async page => {
      await press(page, "nav .logo");
      await press(page, "[data-about-add]");
    },
  },
];

// one session per phone, with a band and a venue faved so Faves isn't empty
export const openPhone = (t, phone) => open(t, { viewport: phone, faves, userAgent: userAgent(phone) });

export async function showScreen(page, screen) {
  await visit(page, { query: screen.query });
  await page.evaluate(() => document.fonts.ready);
  if (screen.go) await screen.go(page);
  await pause(150);
}

// problems: the page scrolls sideways, a title or button is cut off (list names ending in "…" are fine),
// a pill or chip wraps, or a tap target is under 36px. `small` lists the ones under Apple's 44px, for the sheet
export const layoutProblems = page =>
  page.evaluate(() => {
    const shown = e => {
      const s = getComputedStyle(e),
        b = e.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && b.width > 0 && b.height > 0;
    };
    const label = e =>
      (e.getAttribute("aria-label") || e.textContent).trim().replace(/\s+/g, " ").slice(0, 40);
    const problems = [],
      small = [];
    // band, venue and show pages: the top fade starts behind the top bar, not partway down it
    const hero = document.querySelector("#main .hero");
    if (hero && scrollY === 0 && hero.getBoundingClientRect().top > 0)
      problems.push(
        `the page's top color starts ${Math.round(hero.getBoundingClientRect().top)}px below the top`,
      );
    if (document.documentElement.scrollWidth > innerWidth + 1)
      problems.push(`page scrolls sideways (${document.documentElement.scrollWidth}px wide)`);
    for (const e of document.querySelectorAll("#main h1, #main h2, #main h3, button, .chip, #about a")) {
      if (!shown(e) || e.scrollWidth - e.clientWidth <= 2) continue;
      const onPurpose = getComputedStyle(e).textOverflow === "ellipsis" && e.closest(".rw, .tile, .card");
      if (!onPurpose) problems.push(`cut off: ${e.tagName.toLowerCase()} "${label(e)}"`);
    }
    // pills and chips stay on one line
    for (const e of document.querySelectorAll(".chip, .pill, .mcounty, nav button, .abig b")) {
      // day tiles are two lines on purpose
      if (!shown(e) || e.closest(".days")) continue;
      const lines = new Set();
      const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) {
        if (!walk.currentNode.textContent.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(walk.currentNode);
        for (const box of r.getClientRects()) lines.add(Math.round(box.top));
      }
      if (lines.size > 1) problems.push(`wraps onto ${lines.size} lines: "${label(e)}"`);
    }
    for (const e of document.querySelectorAll("button, .chip, a.aform, input")) {
      // names inside a tappable row or card; the row is the real target
      if (!shown(e) || e.parentElement.closest("[data-show], [data-band], [data-venue]")) continue;
      const b = e.getBoundingClientRect(),
        size = Math.round(Math.min(b.width, b.height));
      if (size < 36) problems.push(`too small to tap (${size}px): "${label(e)}"`);
      else if (size < 44) small.push(`${size}px "${label(e)}"`);
    }
    return { problems: [...new Set(problems)], small: [...new Set(small)] };
  });
