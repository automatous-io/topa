//
// Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
//
// Every main screen on every phone, side by side in phone-sheet/index.html. Run: npm run sheet

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT, start, stop } from "./harness.mjs";
import { PHONES, SCREENS, openPhone, showScreen, layoutProblems } from "./phones.mjs";

const OUT = join(ROOT, "phone-sheet");
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const slug = s =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT);
await start();
const cells = {}; // screen name -> phone name -> { img, problems, small }
await Promise.all(
  PHONES.map(async phone => {
    // 2x keeps the files small
    const page = await openPhone(null, { ...phone, deviceScaleFactor: Math.min(phone.deviceScaleFactor, 2) });
    for (const screen of SCREENS) {
      await showScreen(page, screen);
      const img = `${slug(screen.name)}--${slug(phone.name)}.png`;
      await page.screenshot({ path: join(OUT, img) });
      (cells[screen.name] ??= {})[phone.name] = { img, ...(await layoutProblems(page)) };
    }
    await page.browserContext().close();
  }),
);
await stop();

const total = Object.values(cells).flatMap(row => Object.values(row).flatMap(c => c.problems)).length;
const head = PHONES.map(p => `<th>${esc(p.name)}<small>${p.width}×${p.height}</small></th>`).join("");
const rows = SCREENS.map(
  s =>
    `<tr><th scope="row">${esc(s.name)}</th>` +
    PHONES.map(p => {
      const c = cells[s.name][p.name];
      return (
        `<td><a href="${c.img}"><img src="${c.img}" width="${Math.round(p.width * 0.6)}" alt="${esc(s.name)} on ${esc(p.name)}"></a>` +
        c.problems.map(x => `<p class="bad">${esc(x)}</p>`).join("") +
        (c.small.length
          ? `<details><summary>${c.small.length} under 44px</summary>${c.small.map(esc).join("<br>")}</details>`
          : "") +
        `</td>`
      );
    }).join("") +
    `</tr>`,
);
await writeFile(
  join(OUT, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>TOPA on phones</title>
<style>
body{margin:0;padding:16px;background:#120e18;color:#f4eef7;font:14px system-ui,sans-serif}
h1{margin:0 0 4px;font-size:22px}p.sum{margin:0 0 16px;color:#a99bb5}
table{border-collapse:collapse}th,td{padding:8px;vertical-align:top;text-align:left}
thead th{position:sticky;top:0;background:#120e18;z-index:1}th small{display:block;color:#a99bb5;font-weight:400}
tbody th{position:sticky;left:0;background:#120e18;white-space:nowrap}
img{display:block;border-radius:12px;border:1px solid #2a2235}
.bad{margin:6px 0 0;max-width:240px;color:#ff8a66}
details{margin-top:6px;max-width:240px;color:#a99bb5;font-size:12px}
</style>
<h1>TOPA on phones</h1>
<p class="sum">${SCREENS.length} screens × ${PHONES.length} phones · ${total ? `${total} layout problems (in coral)` : "no layout problems"} · tap a screenshot for full size</p>
<table><thead><tr><th></th>${head}</tr></thead><tbody>${rows.join("\n")}</tbody></table>
`,
);
console.log(`${join(OUT, "index.html")} · ${total} layout problems`);
