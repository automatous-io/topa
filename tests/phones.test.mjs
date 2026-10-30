//
// Copyright 2026 AUTOMATOUS.IO. All rights reserved. See LICENSE.
//
// Every main screen fits on each phone in phones.mjs, and the basics work. To see them: npm run sheet

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start, stop, open, text, count, tap } from "./harness.mjs";
import { PHONES, SCREENS, openPhone, showScreen, layoutProblems } from "./phones.mjs";

before(start);
after(stop);

// the phones run side by side
describe("phones", { concurrency: true }, () => {
  for (const phone of PHONES) {
    test(`${phone.name} (${phone.width}px): every screen fits`, async t => {
      const page = await openPhone(t, phone);
      const found = [];
      for (const screen of SCREENS) {
        await showScreen(page, screen);
        const { problems } = await layoutProblems(page);
        found.push(...problems.map(p => `${screen.name}: ${p}`));
        // every day, since the title is the day's name
        if (screen.name === "Shows") {
          const days = await count(page, ".chips.days .chip");
          for (let i = 0; i < days; i++) {
            await page.$$eval(".chips.days .chip", (cs, i) => cs[i].click(), i);
            const day = await text(page, "h1");
            found.push(...(await layoutProblems(page)).problems.map(p => `Shows · ${day}: ${p}`));
          }
        }
      }
      assert.deepEqual([...new Set(found)], [], `layout problems on ${phone.name}`);
    });

    test(`${phone.name} (${phone.width}px): tabs, search, About and faves work`, async t => {
      const page = await open(t, { viewport: phone });
      for (const tab of ["Bands", "Venues", "Faves", "Shows"]) {
        await tap(page, `nav [data-v="${tab}"]`);
        assert.match(await text(page, "h1"), tab === "Shows" ? /^(Today|Tonight)$/ : new RegExp(`^${tab}$`));
      }
      await tap(page, ".mbar [data-search]");
      await page.type("#ms", "jazz");
      assert.ok((await count(page, "#main .rw[data-show]")) > 0, "search found nothing");
      await tap(page, ".mbar [data-searchx]");
      await tap(page, "nav .logo");
      await tap(page, "[data-about-add]");
      assert.equal(await text(page, ".atitle"), "Add to TOPA");
      await tap(page, "[data-about-back]");
      await tap(page, ".ax");
      assert.equal(await page.$eval("#about", el => el.hidden), true);
      await tap(page, "#main .rw[data-show] .star");
      assert.ok((await count(page, ".favsec .rw[data-show]")) > 0, "faving a band didn't pin it to My Faves");
    });
  }
});
