// SPDX-License-Identifier: Apache-2.0
//
// Capture the landing page's product shots from the built export.
//
// A landing page that shows a mockup is making a claim it will stop honouring
// the first time the interface changes. These come from the real build, driven
// by the same recorded chain fixture the journey suite replays -- so they are
// the actual product, at this commit, and they regenerate byte-for-byte
// deterministically because nothing here touches the network.
//
//   pnpm build && node web/scripts/capture-showcase.mjs
//
// Run it after a change that alters either surface, and commit the result.

import fs from "fs";
import path from "path";
import { chromium } from "playwright";

import { serveStaticExport } from "../tests/static-server.mjs";
import { hasFixture, installChainFixture } from "../tests/chain-fixture.mjs";

const web = path.resolve(import.meta.dirname, "..");
const OUT = path.join(web, "public", "showcase");
const PORT = 4331;
const BASE = `http://localhost:${PORT}`;
const FIXTURE = "journeys";

if (!hasFixture(FIXTURE)) {
  console.error(
    `No recorded chain fixture named "${FIXTURE}". Record one with:\n` +
      "  pnpm --dir web record:flows",
  );
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
const closeServer = await serveStaticExport(PORT, path.join(web, "out"));
const browser = await chromium.launch();

/**
 * Shots are taken at 2× on a wide viewport and cropped to the top of the
 * document. The panel that displays them clips the bottom anyway, so capturing
 * a full page would only be pixels nobody sees.
 */
async function shoot(name, route, prepare) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("erodoro.testWallet", "seller");
      // The guide would otherwise offer itself over the shot.
      localStorage.setItem("erodoro.tour.v1", "1");
      localStorage.setItem("erodoro.theme", "light");
    } catch {}
  });
  await installChainFixture(context, FIXTURE, "replay");
  await context.routeWebSocket(/.*/, (socket) => socket.close());

  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-09-14T18:00:00Z"));
  await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  if (prepare) await prepare(page);
  // Let the book's poll settle so two runs do not differ by one tick.
  await page.waitForTimeout(1_200);

  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1440, height: 856 } });
  await context.close();
  console.log(`  ${name.padEnd(12)} ${String(Math.round(fs.statSync(file).size / 1024)).padStart(5)} KB`);
}

console.log("capturing:");

await shoot("terminal", "/app", async (page) => {
  await page.getByLabel("Rank by").selectOption("expiry");
  const row = page.locator('tr[data-tour="series-card"]').first();
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.click();
  await page.waitForTimeout(2_500);
  // Compose a real order so the ticket shows its approval line rather than an
  // empty form. This is the screen the page is claiming to have.
  const ticket = page.locator("[data-market-ticket]");
  await ticket.getByLabel(/limit price/i).fill("14");
  await ticket.getByLabel(/quantity/i).fill("1");
  await page.waitForTimeout(600);
});

await shoot("portfolio", "/portfolio", async (page) => {
  await page.waitForTimeout(1_500);
});

await browser.close();
closeServer();
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
