//
// Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
//
// Retakes screenshots/ for a release: every page on a phone and the Tesla, with the real listings and previews.
// Run: npm run shots           (all)
//      npm run shots phone     (one device: phone or tesla)
//      npm run shots tesla 05-band-page
// NOW=2026-11-05T17:30 npm run shots   pins the clock (default: today at 5:30pm)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "screenshots");
const [ONLY, PICK] = process.argv.slice(2);
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const NOW = process.env.NOW || `${today}T17:30`;

const faves = { bands: ["Jim Friery", "Matterform", "Spencer the Gardener", "Josephoenix"], venues: ["The Grape", "Ojai Ranch House"] };
const where = { lat: 34.2575, lng: -119.2268 }; // east Ventura
const DEV = {
  phone: {
    vp: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    q: "",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  },
  tesla: { vp: { width: 1280, height: 800, deviceScaleFactor: 1.5 }, q: "&tesla=1" },
};

const pause = ms => new Promise(r => setTimeout(r, ms));
const clickText = (p, sel, re) =>
  p.$$eval(sel, (els, re) => els.find(e => new RegExp(re, "i").test(e.textContent))?.click(), re);

// waits for a band's ▶ (previews load in the background), then plays it
async function playBand(p, band) {
  await p.waitForFunction(
    b => [...document.querySelectorAll("[data-play]")].some(e => e.dataset.play === b && !e.hidden),
    { timeout: 20000 },
    band,
  );
  await p.$$eval("[data-play]", (els, b) => els.find(e => e.dataset.play === b && !e.hidden && e.offsetParent).click(), band);
  await pause(2500);
}

const SHOTS = [
  ["00-home", "&view=Home"],
  ["01-shows"],
  ["02-shows-weekend", "", p => clickText(p, ".chips.days .chip", "weekend")],
  [
    "03-search",
    "",
    async (p, dev) => {
      if (dev === "phone") {
        await p.click(".mbar [data-search]");
        await p.type("#ms", "rock");
      } else await p.type("#s", "rock");
      await pause(400);
    },
  ],
  ["04-bands", "&view=Bands"],
  ["05-band-page", "&view=Band:Jim%20Friery"],
  ["06-venues", "&view=Venues"],
  ["07-venue-page", "&view=Venue:The%20Grape"],
  ["08-show-page", "", p => p.$$eval("#main .rw[data-show]", rs => rs.find(r => /Jim Friery/.test(r.textContent)).click())],
  ["09-faves", "&view=Faves"],
  ["09b-faves-venues", "&view=Faves", p => p.click("[data-ftab=venues]")],
  ["10-distance-picker", "", (p, dev) => p.click(dev === "phone" ? ".pill.loc.d-row" : ".pill.loc.d-top")],
  ["11-player", "", p => playBand(p, "Jim Friery")],
  ["12-settings", "&view=Home", p => p.click(".hcog")],
  [
    "12b-add",
    "&view=Home",
    async p => {
      await p.click(".hcog");
      await pause(300);
      await p.click("[data-about-add]");
    },
  ],
  [
    "12c-about",
    "&view=Home",
    async p => {
      await p.click(".hcog");
      await pause(300);
      await p.click("[data-about-info]");
    },
  ],
  [
    "13-full-player",
    "",
    async p => {
      await playBand(p, "Jim Friery");
      await p.click("[data-plfull]");
    },
  ],
];

// the repo as a website, with the live listings
const LIVE = "https://topa.automatous.io/events.json";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = join(ROOT, normalize(path === "/" ? "/index.html" : path));
  if (path === "/events.json" && !existsSync(file)) {
    const live = await fetch(LIVE).then(r => (r.ok ? r.text() : ""), () => "");
    return live ? res.writeHead(200, { "content-type": "application/json" }).end(live) : res.writeHead(404).end();
  }
  try {
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/index.html`;

const chrome = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(p => p && existsSync(p));
const browser = await puppeteer.launch({ headless: true, executablePath: chrome, args: ["--autoplay-policy=no-user-gesture-required"] });

async function page(dev, query = "") {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  p.on("pageerror", e => console.log("page error:", e.message));
  await p.setViewport(DEV[dev].vp);
  if (DEV[dev].ua) await p.setUserAgent(DEV[dev].ua);
  await p.emulateTimezone("America/Los_Angeles");
  await p.evaluateOnNewDocument(
    (f, w) => {
      localStorage.setItem("topa.faves.v1", JSON.stringify(f));
      localStorage.setItem("topa.location.v1", JSON.stringify(w));
      localStorage.setItem("topa.karaoke.v1", "true");
      sessionStorage.setItem("topa.splash", "1");
    },
    faves,
    where,
  );
  await p.goto(`${BASE}?now=${NOW}${DEV[dev].q}${query}`, { waitUntil: "networkidle0" });
  await p.evaluate(() => document.fonts.ready);
  await pause(1500);
  return p;
}

let failed = 0;
for (const dev of ONLY ? [ONLY] : ["phone", "tesla"]) {
  for (const [name, query, act] of SHOTS.filter(s => !PICK || s[0] === PICK)) {
    const p = await page(dev, query);
    try {
      if (act) await act(p, dev);
      await p.mouse.move(2, 2);
      await pause(700);
      await p.screenshot({ path: join(OUT, `${dev}-${name}.png`) });
      console.log("ok", dev, name);
    } catch (e) {
      failed++;
      console.log("FAILED", dev, name, e.message);
    }
    await p.browserContext().close();
  }
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
