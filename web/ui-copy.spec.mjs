// Visual migration regression coverage, with recorded Solana responses only.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { serveStaticExport } from "./tests/static-server.mjs";
import { installChainFixture } from "./tests/chain-fixture.mjs";

const axe = fs.readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const close = await serveStaticExport(4323);
const browser = await chromium.launch();
const errors = [];
const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const routes = ["/", "/app", "/earn", "/auctions", "/swap", "/portfolio", "/rewards", "/market-rip", "/faucet"];

try {
  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      await context.addInitScript((theme) => {
        localStorage.setItem("erodoro.theme", theme);
        localStorage.setItem("erodoro.tour.v1", "1");
        localStorage.setItem("erodoro.testWallet", "seller");
      }, theme);
      await installChainFixture(context, "journeys", "replay");
      // Prevent real websocket subscriptions during fixture replay.
      await context.routeWebSocket(/.*/, (socket) => socket.close());
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date("2026-09-14T18:00:00Z"));
      page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
      page.on("console", (message) => {
        if (/hydration failed|didn't match/i.test(message.text())) errors.push(message.text());
      });
      if (width === 1440 && theme === "light") {
        await page.goto("http://localhost:4323/earn");
        await page.getByLabel("Stock", { exact: true }).locator("option").nth(1).waitFor({ state: "attached" });
        await page.getByLabel("Stock", { exact: true }).selectOption({ index: 1 });
        await page.getByLabel("Strike and expiry").selectOption({ index: 1 });
        await page.getByRole("textbox", { name: /quantity/i }).fill("0.1");
        await page.getByLabel(/minimum premium per token/i).fill("12");
        await page.getByRole("button", { name: "Review sell order" }).click();
        await page.waitForURL(url => url.pathname === "/trade/markets");
        const ticket = page.locator("[data-market-ticket]");
        await ticket.waitFor({ state: "visible" });
        await page.waitForTimeout(500);
        assert.equal(await ticket.getByLabel(/limit price/i).inputValue(), "12");
        assert.equal(await ticket.getByLabel(/quantity/i).inputValue(), "0.1");
        assert.match(new URL(page.url()).searchParams.get("market"), /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
        console.log("ok Earn preserves a Solana market and order draft");

        await page.goto("http://localhost:4323/swap");
        assert.equal(await page.getByRole("button", { name: "Swap unavailable" }).isDisabled(), true);
        await page.getByRole("button", { name: "Select stock", exact: true }).click();
        await page.getByRole("textbox", { name: "Search stocks or issuers" }).fill("no-such-stock");
        assert.equal(await page.getByText(/No matching stocks|No issuer assets are configured/).isVisible(), true);
        await page.keyboard.press("Escape");
        assert.equal(await page.getByRole("dialog").isVisible(), false);
        console.log("ok stock picker search and dismiss; unsupported swaps stay disabled");
      }
      for (const route of routes) {
        await page.goto(`http://localhost:4323${route}`);
        await page.locator("h1").first().waitFor({ state: "visible" });
        await page.waitForTimeout(1500);
        if (route === "/app") await page.getByText("Loading markets…").waitFor({ state: "hidden" });
        assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        assert.equal(overflow, false, `${route} overflows at ${width}px`);
        await page.evaluate(axe);
        const violations = await page.evaluate(async () => (await window.axe.run(document, {
          resultTypes: ["violations"],
          rules: { "color-contrast": { enabled: false } },
        })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.html.slice(0, 150)) })));
        if (violations.length) errors.push(`${route}, ${width}px, ${theme}: ${JSON.stringify(violations)}`);
        if (shots) await page.screenshot({ path: `${shots}/${width}-${theme}-${route.replaceAll("/", "") || "home"}.png`, fullPage: true });
        console.log(`ok ${width}px ${theme} ${route}`);
      }

      await context.close();
    }
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 } });
  await installChainFixture(context, "journeys", "replay");
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-09-14T18:00:00Z"));
  await page.goto("http://localhost:4323/app");
  await page.locator('[data-tour="series-card"]:visible').first().waitFor({ state: "visible" });
  await page.getByRole("button", { name: "I want upside", exact: true }).click();
  await page.getByRole("button", { name: "Buy upside →", exact: true }).first().waitFor({ state: "visible" });
  console.log("ok role changes synchronize discovery without a demo signer");
  await page.setViewportSize({ width: 1920, height: 1080 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "wide desktop header fits");
  if (shots) await page.screenshot({ path: `${shots}/1920-header.png` });
  await context.close();
  assert.deepEqual(errors, [], "no accessibility, runtime or hydration errors");
} finally {
  await browser.close();
  close();
}
