import { chromium } from "playwright";
import { serveStaticExport } from "./tests/static-server.mjs";

const PORT = 4319;
const closeServer = await serveStaticExport(PORT);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const failures = [];
const hydrationErrors = [];
const ok = (condition, message) => {
  console.log(`${condition ? "  ok  " : "  FAIL"} ${message}`);
  if (!condition) failures.push(message);
};
const visible = async (locator) => locator.isVisible().catch(() => false);
page.on("console", (message) => {
  if (/hydration failed|server rendered html didn't match/i.test(message.text())) hydrationErrors.push(message.text());
});
page.on("pageerror", (error) => {
  if (/hydration failed|server rendered html didn't match/i.test(error.message)) hydrationErrors.push(error.message);
});

await page.goto(`http://localhost:${PORT}/`);
ok((await page.locator("[data-landing-wordmark]").textContent()).trim() === "erodoro", "landing header keeps the erodoro wordmark");
ok(await visible(page.locator("[data-landing-header]").getByRole("link", { name: "Try devnet" })), "landing header exposes the devnet app");
ok(await visible(page.locator("[data-landing-header]").getByRole("button", { name: "Request access" })), "landing header exposes the waitlist");
ok(!(await visible(page.locator("[data-landing-header]").getByRole("link", { name: "Docs" }))), "landing header omits secondary documentation links");
await page.locator("[data-landing-header]").getByRole("button", { name: "Request access" }).click();
ok(await visible(page.getByRole("dialog", { name: "Join the waitlist" }).getByRole("textbox", { name: "Email" })), "request access opens an email waitlist");
await page.getByRole("button", { name: "Close waitlist" }).last().click();
ok(await visible(page.getByRole("heading", { name: "Set your strike. Sell the upside." })), "hero states the seller decision clearly");
ok(await visible(page.getByRole("link", { name: "Try on devnet" })), "hero labels the deployment as devnet");
ok(await visible(page.getByRole("link", { name: "See how settlement works" })), "hero links directly to settlement education");
ok(await visible(page.locator("#risk").getByText("You still bear the downside")), "downside risk is permanently visible");
ok(await visible(page.locator("#risk").getByText("Issuer controls still apply")), "issuer-control risk is permanently visible");
ok(await visible(page.getByText("P · Capped equity claim", { exact: true }).first()), "P is defined before the calculator");
ok(await visible(page.getByText("N · Upside claim", { exact: true }).first()), "N is defined before the calculator");
ok(await visible(page.getByRole("heading", { name: "For upside buyers" })), "buyers have a dedicated decision section");
ok(!(await visible(page.getByText("Hedge", { exact: true }))), "unrelated hedge copy is removed");
ok(await visible(page.locator("#faq").getByText("What do I receive at redemption?")), "FAQ explains the redemption asset");

await page.goto(`http://localhost:${PORT}/app`);
await page.getByRole("heading", { name: "Markets" }).waitFor({ timeout: 10_000 });
ok((await page.title()) === "Markets · erodoro", "Markets has the correct browser identity");
ok(await visible(page.getByText("I own the collateral")), "seller intent is plain language");
ok(await visible(page.getByText("I want exposure above the strike")), "buyer intent is plain language");
ok(!(await visible(page.getByRole("link", { name: /registry/i }))), "admin registry is absent from user navigation");
ok(await visible(page.getByRole("link", { name: "Create demo assets" }).first()), "demo asset setup is available from the app header");
await page.getByText("Select wallet", { exact: true }).click();
ok(await visible(page.getByText("demo account", { exact: true })), "demo traders are available under Select wallet");

// The guide is never offered unprompted. It used to appear on its own 700ms
// after the markets loaded, over the corner someone had started reading.
await page.waitForTimeout(2_000);
ok(
  !(await visible(page.getByRole("heading", { name: "New to Erodoro?" }))),
  "the guide never opens by itself",
);
ok(await visible(page.locator('[data-tour="role-choice"]')), "market content is not covered on arrival");
// It is still reachable, from the menu that was opened just above.
await page.getByRole("button", { name: "Guide", exact: true }).click();
const guide = page.getByRole("dialog");
ok(await visible(guide.getByText("Choose a demo account")), "guide begins with the demo accounts");
const highlightReady = await page.locator("[data-tour-highlight]").waitFor({ state: "visible", timeout: 3_000 }).then(() => true).catch(() => false);
ok(highlightReady, "guide highlights a real control");
await guide.getByRole("button", { name: "Skip" }).click();
await page.locator('[data-tour="test-key-seller"]').click();
await page.waitForTimeout(500);
ok(
  !(await visible(page.getByRole("heading", { name: "Something broke on this page" }))),
  "selecting a demo signer keeps the market directory mounted",
);

await page.goto(`http://localhost:${PORT}/portfolio`);
await page.getByRole("heading", { name: "Portfolio" }).waitFor({ timeout: 8_000 });
ok((await page.title()) === "Portfolio · erodoro", "Portfolio has its own metadata and heading");
ok(await visible(page.getByText("Your P and N positions, open orders, and balances held in live execution.")), "Portfolio has position-specific guidance");
// The two categories that used to be invisible: a resting order, and money
// sitting inside an execution session rather than in the wallet.
ok(await visible(page.getByRole("tab", { name: /Open orders/ })), "Portfolio accounts for resting orders");
ok(await visible(page.getByRole("tab", { name: /Live balances/ })), "Portfolio accounts for funds held in live execution");
await page.getByRole("tab", { name: /Live balances/ }).click();
await page.waitForTimeout(1_500);
ok(
  !(await visible(page.getByRole("button", { name: /return to wallet|withdraw/i }))),
  "no control claims funds can be returned to the wallet while a session holds them",
);

await page.goto(`http://localhost:${PORT}/app?view=positions`);
await page.waitForURL((url) => url.pathname === "/portfolio", { timeout: 5_000 });
ok(new URL(page.url()).pathname === "/portfolio", "legacy Portfolio links reach the canonical route");

await page.goto(`http://localhost:${PORT}/create`);
await page.waitForURL((url) => url.pathname === "/admin/registry", { timeout: 5_000 });
ok(new URL(page.url()).pathname === "/admin/registry", "legacy Registry links reach the canonical admin route");
await page.getByRole("heading", { name: "Admin registry" }).waitFor({ timeout: 8_000 });
ok(await visible(page.getByRole("heading", { name: "Admin registry" })), "admin route identifies itself clearly");
ok(!(await visible(page.locator('[data-tour="test-key-seller"]'))), "trader fixtures do not appear on the admin route");

await page.goto(`http://localhost:${PORT}/mint`);
await page.getByRole("heading", { name: "Create demo assets" }).waitFor({ timeout: 8_000 });
ok(await visible(page.getByText(/no real value/i).first()), "demo assets carry a persistent value warning");
const steps = page.locator("[data-setup-step]");
ok((await steps.count()) === 4, "demo setup has four compact stages");
const boxes = await Promise.all(Array.from({ length: 4 }, (_, index) => steps.nth(index).boundingBox()));
ok(boxes.every((box, index) => box && boxes[0] && Math.abs(box.y - boxes[0].y) < 3 && (index === 0 || box.x > boxes[index - 1].x)), "demo setup moves left to right");

await page.goto(`http://localhost:${PORT}/app`);
await page.evaluate(() => window.localStorage.setItem("erodoro.tour.v1", "1"));
const row = page.locator('[data-tour="series-card"]:visible').first();
const hasMarket = await row.waitFor({ state: "visible", timeout: 12_000 }).then(() => true).catch(() => false);
if (hasMarket) {
  await row.click();
  await page.waitForURL((url) => url.pathname === "/trade/markets" && Boolean(url.searchParams.get("market")), { timeout: 8_000 });
  ok(new URL(page.url()).searchParams.get("view") === "n", "normal market links open the N strategy in a shareable URL");
  const workspace = page.locator("[data-market-workspace]");
  await workspace.waitFor({ state: "visible", timeout: 15_000 });
  const education = page.locator("[data-market-education]");
  const educationBox = await education.boundingBox();
  const workspaceBox = await workspace.boundingBox();
  ok(educationBox && workspaceBox && workspaceBox.y + workspaceBox.height <= educationBox.y, "trading appears before payoff and protocol education");
  const ticket = page.locator("[data-market-ticket]");
  ok(await visible(ticket.getByText(/Upside claim \(N\)/)), "default ticket is the N upside market");
  ok(!(await visible(ticket.getByText(/Capped equity claim \(P\)/))), "P trading is hidden from the default strategy");
  await page.getByRole("button", { name: "Sell upside", exact: true }).click();
  ok((await ticket.getByRole("button", { name: "Sell", exact: true }).getAttribute("aria-pressed")) === "true", "seller strategy opens a Sell N ticket");
  await page.getByRole("button", { name: "Buy upside", exact: true }).click();
  ok((await ticket.getByRole("button", { name: "Buy", exact: true }).getAttribute("aria-pressed")) === "true", "buyer strategy opens a Buy N ticket");
  ok(!(await visible(page.getByText(/Prepare to trade|Prepare custody|Create book/))), "traders see no setup action");
  ok(await visible(page.getByText(/powered by MagicBlock/).first()), "market execution is attributed to MagicBlock");
  const priceChart = page.locator("[data-market-price-chart]");
  const ladder = page.locator("[data-orderbook-ladder]");
  if (await visible(priceChart) && await visible(ladder)) {
    const chartBox = await priceChart.boundingBox();
    const ladderBox = await ladder.boundingBox();
    ok(chartBox && ladderBox && chartBox.y + chartBox.height <= ladderBox.y, "price chart sits above asks and bids");
  }
  await page.getByRole("button", { name: /Advanced trading/ }).click();
  ok(
    await visible(workspace.getByRole("button", { name: /P · Capped/ })),
    "advanced trading reveals the P market on the book selector",
  );
  await workspace.getByRole("button", { name: /P · Capped/ }).click();
  ok(await visible(ticket.getByText(/Capped equity claim \(P\)/)), "selecting P retargets the ticket at the P market");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileTrade = page.locator("[data-mobile-trade-button]");
  ok(await visible(mobileTrade), "mobile keeps a trade action within reach");
  await mobileTrade.click();
  const mobileTicket = page.getByRole("dialog", { name: /order ticket/i });
  ok(await visible(mobileTicket), "mobile opens the complete ticket as a bottom sheet");
  // The sheet slides up on open; measure where it comes to rest, not where it
  // is mid-animation.
  await page.waitForTimeout(450);
  const mobileBox = await mobileTicket.boundingBox();
  ok(Boolean(mobileBox && mobileBox.y >= 0 && mobileBox.y + mobileBox.height <= 845), "mobile ticket remains inside the viewport");

  // A role="dialog" has to behave like one. Focus starts inside it, cannot
  // leave it by tabbing, and comes back to the trigger when it closes.
  // Focus is moved by an effect after the sheet commits, so poll for it rather
  // than sampling the frame the click returned on.
  const focusLanded = await page
    .waitForFunction(() => {
      const sheet = document.querySelector('[role="dialog"][data-market-ticket]');
      return Boolean(sheet && sheet.contains(document.activeElement));
    }, null, { timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  ok(focusLanded, "opening the sheet moves focus into it");
  ok(
    await page.evaluate(() => {
      const main = document.querySelector("main");
      const sheet = document.querySelector('[role="dialog"][data-market-ticket]');
      // The sheet must be outside the page it is inerting, or marking the page
      // inert would silence the sheet too.
      return Boolean(main?.hasAttribute("inert") && sheet && !main.contains(sheet));
    }),
    "the page behind the sheet is inert, and the sheet is not inside it",
  );
  for (let i = 0; i < 25; i += 1) await page.keyboard.press("Tab");
  ok(
    await mobileTicket.evaluate((node) => node.contains(document.activeElement)),
    "tabbing cannot escape the sheet",
  );
  await page.keyboard.press("Escape");
  ok(!(await visible(mobileTicket)), "Escape closes the sheet");
  ok(
    await page.evaluate(() =>
      document.activeElement?.hasAttribute("data-mobile-trade-button") ?? false,
    ),
    "closing returns focus to the control that opened it",
  );
  ok(
    !(await page.evaluate(() => document.querySelector("main")?.hasAttribute("inert") ?? true)),
    "closing releases the rest of the page",
  );
} else {
  console.log("  skip live market terminal checks (no listed market was readable)");
}

ok(hydrationErrors.length === 0, "all tested routes hydrate without a mismatch");
await browser.close();
closeServer();
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall UX checks passed");
process.exit(failures.length ? 1 : 0);
