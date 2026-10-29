//
// Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
//
// Shared by the browser tests and the phone sheet: a small web server for the app, headless Chrome, open().
//
// Every run is the same: listings come from tests/fixtures/events.json, the clock is pinned with ?now=,
// the time zone is Pacific, and Apple Music and GoatCounter are blocked (no network, no counted visits).

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURE = join(ROOT, "tests/fixtures/events.json");
export const EVENTS = JSON.parse(await readFile(FIXTURE, "utf8")).events;

export const TZ = "America/Los_Angeles";
export const NOON = "2026-10-24T12:00"; // a Saturday, during the day
export const EVENING = "2026-10-24T21:00"; // same day, after most shows started
export const TESLA = { width: 1920, height: 1200 };
export const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
let server, base, browser;

// serves the app, with the fixture as events.json, and starts Chrome
export async function start() {
  server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file =
      path === "/events.json" ? FIXTURE : join(ROOT, normalize(path === "/" ? "/index.html" : path));
    try {
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/index.html`;
  // GitHub's Linux runners block Chrome's sandbox, so it's turned off there (CI is set on those runners)
  browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: process.env.CI ? ["--no-sandbox"] : [],
  });
}

export async function stop() {
  await browser?.close();
  server?.close();
}

function findChrome() {
  const paths = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  const found = paths.find(p => p && existsSync(p));
  if (!found) throw new Error("Chrome not found; set CHROME_PATH");
  return found;
}

// opens the app in a fresh browser session. With a test's `t`, it closes when the test ends and fails the test
// if the page threw; without one, close it with page.browserContext().close().
// `listings` swaps in a different events.json; `userAgent` passes as another device
export async function open(t, { query = "", viewport = TESLA, now = NOON, faves, listings, userAgent } = {}) {
  const session = await browser.createBrowserContext();
  const page = await session.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  t?.after(async () => {
    await session.close();
    assert.deepEqual(errors, [], "the page threw an error");
  });
  await page.emulateTimezone(TZ);
  await page.setViewport(viewport);
  if (userAgent) await page.setUserAgent(userAgent);
  await page.setBypassServiceWorker(true);
  await page.setRequestInterception(true);
  page.on("request", r => {
    if (/deezer|dzcdn|itunes|mzstatic|goatcounter|zgo\.at/.test(r.url())) return r.abort();
    if (listings && /\/events\.json/.test(r.url()))
      return r.respond({ contentType: "application/json", body: JSON.stringify(listings) });
    r.continue();
  });
  if (faves) {
    await page.evaluateOnNewDocument(f => localStorage.setItem("topa.faves.v1", JSON.stringify(f)), faves);
  }
  await page.goto(`${base}?now=${now}${query}`, { waitUntil: "networkidle0" });
  return page;
}

// another page in the same session (faster than open)
export async function visit(page, { query = "", now = NOON } = {}) {
  await page.goto(`${base}?now=${now}${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#main")?.children.length > 1); // more than the top bar
}

export const text = (page, sel) => page.$eval(sel, el => el.textContent.trim());
export const count = (page, sel) => page.$$eval(sel, els => els.length);
export const tap = async (page, sel) => {
  await page.click(sel);
  await new Promise(r => setTimeout(r, 50));
};
