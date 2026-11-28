import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { $, browser, expect } from "@wdio/globals";
import { api, mockPage, RECORDS } from "./fixtures.js";

const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PAGES = ["/"];
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

async function violations() {
  await browser.execute(axeSource);
  const result = await browser.execute(
    tags => window.axe.run(document, { runOnly: { type: "tag", values: tags } }),
    WCAG_22_AA,
  );
  return result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`);
}

const WIDTHS = [
  ["phone", 375, 812],
  ["desktop", 1280, 900],
];

for (const colorScheme of ["light", "dark"]) {
  for (const [width, w, height] of WIDTHS) {
    describe(`${colorScheme} theme at ${width} width @safari`, () => {
      before(async function () {
        if (!browser.isBidi) {
          // Safari speaks classic WebDriver only, which can't emulate a colour scheme or set the viewport.
          if (colorScheme === "dark") this.skip();
          await browser.setWindowSize(Number(w), Number(height));
          return;
        }
        await browser.setViewport({ width: Number(w), height: Number(height) });
        await browser.emulate("colorScheme", colorScheme);
      });

      for (const path of PAGES) {
        it(`${path} has no WCAG 2.2 AA violations`, async () => {
          await browser.url(path);
          await $("#standard").waitForExist();
          expect(await violations()).toEqual([]);
        });
      }

      it("/ with results, events and a record to accept has no WCAG 2.2 AA violations", async function () {
        // Safari's classic WebDriver can't mock requests, so this fixture-driven pass runs in Chrome and Firefox only.
        if (!browser.isBidi) this.skip();
        await mockPage();
        const record = await browser.mock(api("/api/repositories/engage/record"), { method: "get" });
        await record.respond(RECORDS, { statusCode: 200, headers: { "Content-Type": "application/json" } });
        await browser.url("/");
        const row = $('li[data-repository="engage"]');
        await row.waitForExist();
        await row.$("button=Show changes").click();
        await row.$("button=Accept this record").waitForClickable();
        await row.$("button=Accept this record").click();
        await expect(row.$(".record-detail")).toHaveText(expect.stringContaining("Accept this record for engage?"));
        expect(await violations()).toEqual([]);
        await browser.mockRestoreAll();
      });
    });
  }
}
