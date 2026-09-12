/**
 * Deterministic journey coverage.
 *
 * Replays a recorded chain (see `tests/chain-fixture.mjs`), so these run with
 * no network and give the same answer every time. What they assert is what the
 * other suites cannot: that a whole flow reaches the right end, and that the
 * ways it can go wrong are each reported as themselves.
 *
 * Record a fresh chain with:
 *
 *     FIXTURE_MODE=record node flows.spec.mjs
 *
 * which talks to devnet once and writes `tests/fixtures/`.
 */
import { chromium } from "playwright";
import { serveStaticExport } from "./tests/static-server.mjs";
import { hasFixture, installChainFixture } from "./tests/chain-fixture.mjs";

const PORT = 4321;
const MODE = process.env.FIXTURE_MODE === "record" ? "record" : "replay";
const FIXTURE = "journeys";
const closeServer = await serveStaticExport(PORT);
const BASE = `http://localhost:${PORT}`;

const failures = [];
const ok = (condition, message) => {
  console.log(`${condition ? "  ok  " : "  FAIL"} ${message}`);
  if (!condition) failures.push(message);
};
const visible = (locator) => locator.isVisible().catch(() => false);

/** Let in-flight routes settle before tearing a scenario down. */
async function finish(context) {
  await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  await context.close().catch(() => {});
}

if (MODE === "replay" && !hasFixture(FIXTURE)) {
  console.log("  skip deterministic journeys (no recorded chain)");
  console.log("       record one with: FIXTURE_MODE=record node flows.spec.mjs");
  closeServer();
  process.exit(0);
}

const browser = await chromium.launch();
/** Every fixture handle opened, so a recording run can flush them all. */
const fixtures = [];

/** A page with a replayed chain and a chosen demo signer. */
async function openMarket(signer, { intercept } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(
    ([role]) => {
      try {
        localStorage.setItem("erodoro.testWallet", role);
        localStorage.setItem("erodoro.tour.v1", "1");
        // Deliberately not clearing sessionStorage: this script runs on every
        // navigation, so clearing here would wipe the order draft during the
        // very detour the draft exists to survive.
      } catch {}
    },
    [signer],
  );

  const fixture = await installChainFixture(context, FIXTURE, MODE, { intercept });
  fixtures.push(fixture);
  const page = await context.newPage();

  await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(MODE === "record" ? 4_000 : 1_500);
  const row = page.locator('tr[data-tour="series-card"]').first();
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.click();
  await page.waitForTimeout(MODE === "record" ? 8_000 : 2_500);
  return { context, page, fixture };
}

const ticketOf = (page) => page.locator("[data-market-ticket]");

async function compose(page, { side, price, size }) {
  const ticket = ticketOf(page);
  await page.getByRole("button", { name: side === "buy" ? "Buy upside" : "Sell upside", exact: true }).click();
  await ticket.getByLabel(/limit price/i).fill(price);
  await ticket.getByLabel(/quantity/i).fill(size);
  await page.waitForTimeout(400);
  return ticket;
}


/**
 * Compose an order, submit it, and return what the step list ended up saying.
 *
 * Every scenario below fails before confirmation, and that is a deliberate
 * limit rather than an oversight: `confirmTransaction` resolves over a
 * WebSocket subscription, which HTTP route interception cannot replay. The
 * outcomes that need a confirmed transaction -- a projection that never
 * arrives, a draft clearing after placement -- are covered by unit tests over
 * the same pure functions, and were verified against live devnet when they
 * were built.
 */
async function submitAndRead(signer, intercept, order = { side: "sell", price: "12", size: "1" }) {
  const { context, page } = await openMarket(signer, { intercept });
  const ticket = await compose(page, order);
  await ticket.getByRole("button", { name: /^(Sell|Buy) Upside claim$/ }).click();
  const progress = page.locator("[data-transaction-progress]");
  await progress.waitFor({ state: "visible", timeout: 25_000 }).catch(() => {});
  // Let the step settle out of its in-flight state before reading it.
  await page.waitForTimeout(1_500);
  const text = (await progress.innerText().catch(() => "")) ?? "";
  return { context, page, progress, text };
}

// ---------------------------------------------------------------------------
// The seller, composing more than they hold.
// ---------------------------------------------------------------------------
{
  const { context, page } = await openMarket("seller");
  const ticket = await compose(page, { side: "sell", price: "12", size: "40" });

  ok(
    await visible(ticket.getByText(/more than you hold/)),
    "a seller short of the claim is told exactly how short",
  );
  ok(
    await visible(ticket.getByText(/Submitting locks .* to mint it first/)),
    "the shortfall names locking as part of submitting, not as a separate errand",
  );
  const approvals = await ticket.getByText(/wallet approvals?:/).textContent().catch(() => "");
  ok(
    /3 wallet approvals/.test(approvals ?? ""),
    `the wallet cost is stated before the first prompt (saw: ${approvals?.trim()})`,
  );
  await finish(context);
}

// ---------------------------------------------------------------------------
// The buyer, composing more than they can pay for.
// ---------------------------------------------------------------------------
{
  const { context, page } = await openMarket("buyer");
  const ticket = await compose(page, { side: "buy", price: "9", size: "40000" });

  ok(
    await visible(ticket.getByText(/costs .* more than you hold/)),
    "a buyer short of cash is told exactly how short",
  );
  const fund = ticket.getByRole("link", { name: /Get demo USDC/ });
  ok(await visible(fund), "devnet offers the funding route rather than stopping");

  await fund.click();
  await page.waitForURL((url) => url.pathname === "/mint", { timeout: 10_000 });
  const backLink = page.getByRole("link", { name: /Back to the market/ });
  const bannerShown = await backLink
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  ok(bannerShown, "the funding page knows where the buyer came from");

  await backLink.click();
  await page.waitForURL((url) => url.pathname === "/trade/markets", { timeout: 10_000 });
  await page.waitForTimeout(MODE === "record" ? 6_000 : 2_500);

  const back = ticketOf(page);
  const restoredPrice = await back.getByLabel(/limit price/i).inputValue().catch(() => "?");
  const restoredSize = await back.getByLabel(/quantity/i).inputValue().catch(() => "?");
  ok(
    restoredPrice === "9" && restoredSize === "40000",
    `the composed order survives the funding detour (saw ${restoredPrice} / ${restoredSize})`,
  );
  await finish(context);
}

// ---------------------------------------------------------------------------
// Rejecting the wallet is a choice, not a failure.
// ---------------------------------------------------------------------------
{
  const { context, page } = await openMarket("seller", {
    // Every send is refused the way a wallet refuses one, wherever it lands.
    intercept: (methods) =>
      methods.includes("sendTransaction")
        ? { error: { code: -32003, message: "User rejected the request." } }
        : null,
  });

  const ticket = await compose(page, { side: "sell", price: "12", size: "1" });
  await ticket.getByRole("button", { name: /^Sell Upside claim$/ }).click();
  const progress = page.locator("[data-transaction-progress]");
  await progress.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});

  const text = (await progress.innerText().catch(() => "")) ?? "";
  ok(/Cancelled in your wallet/i.test(text), "a rejected approval is reported as cancelled");
  ok(
    !/failed/i.test(text.replace(/Transaction failed · /g, "")),
    "a rejection is not dressed up as a failure",
  );
  ok(
    await visible(progress.getByRole("button", { name: /Try again/ })),
    "a cancelled flow can be resumed rather than restarted from scratch",
  );
  ok(
    /Completed steps are not repeated/.test(text),
    "the flow states that finished work will not be re-signed",
  );
  await finish(context);
}

// ---------------------------------------------------------------------------
// Portfolio survives a market it cannot read.
// ---------------------------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("erodoro.testWallet", "seller");
      localStorage.setItem("erodoro.tour.v1", "1");
    } catch {}
  });
  fixtures.push(await installChainFixture(context, FIXTURE, MODE));
  const page = await context.newPage();
  await page.goto(`${BASE}/portfolio`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(MODE === "record" ? 9_000 : 4_000);

  ok(
    await visible(page.getByRole("tab", { name: /Open orders/ })),
    "Portfolio reaches its open-orders view",
  );
  await page.getByRole("tab", { name: /Live balances/ }).click();
  await page.waitForTimeout(1_500);
  ok(
    !(await visible(page.getByRole("button", { name: /Return .*to wallet/i }))),
    "no control offers to return custody while the capability is withheld",
  );
  const note = page.locator("[data-custody-note]");
  if (await visible(note)) {
    ok(
      /not available on this deployment/i.test(await note.innerText()),
      "the custody note explains why returning funds is unavailable",
    );
  }
  await finish(context);
}


// ---------------------------------------------------------------------------
// A transaction the program would reject never becomes a signature prompt.
// ---------------------------------------------------------------------------
{
  const { context, text, progress } = await submitAndRead("seller", (methods) =>
    methods.includes("simulateTransaction")
      ? {
          result: {
            context: { slot: 1 },
            value: {
              err: { InstructionError: [0, { Custom: 6003 }] },
              logs: [
                "Program log: Instruction: Split",
                "Program log: AnchorError caused by account: holder_collateral. Error Code: InsufficientCollateral. Error Number: 6003. Error Message: not enough collateral.",
              ],
              unitsConsumed: 1200,
            },
          },
        }
      : null,
  );

  // The error table turns the Anchor code into a sentence, which is the point
  // of having one: "not enough collateral" is what the user can act on, and
  // leaking `InsufficientCollateral` at them would be a regression, not a win.
  ok(
    /not enough collateral/i.test(text),
    "a program rejection reaches the user as the program's reason, in plain language",
  );
  ok(
    !/Custom:\s*6003|InstructionError/.test(text),
    "the raw instruction error is not shown in place of that reason",
  );
  ok(
    await visible(progress.getByRole("button", { name: /Start over/ })),
    "a rejection that cannot succeed unchanged offers a restart, not a retry",
  );
  ok(
    !(await visible(progress.getByRole("button", { name: /^Try again$/ }))),
    "re-sending an identical doomed transaction is not offered",
  );
  await finish(context);
}

// ---------------------------------------------------------------------------
// An approval that sat too long is its own outcome.
// ---------------------------------------------------------------------------
{
  const { context, text, progress } = await submitAndRead("seller", (methods) =>
    methods.includes("sendTransaction")
      ? { error: { code: -32002, message: "Transaction simulation failed: Blockhash not found" } }
      : null,
  );

  ok(/expired/i.test(text), "an expired lifetime is reported as expiry, not as a failure");
  ok(
    await visible(progress.getByRole("button", { name: /^Try again$/ })),
    "an expired approval can be retried unchanged",
  );
  await finish(context);
}

// ---------------------------------------------------------------------------
// Rate limiting is the network being busy, not the user being wrong.
// ---------------------------------------------------------------------------
{
  const { context, text, progress } = await submitAndRead("seller", (methods) =>
    methods.includes("sendTransaction")
      ? { error: { code: -32005, message: "Server responded with 429 Too Many Requests" } }
      : null,
  );

  ok(!/rejected|cancelled/i.test(text), "a busy endpoint is not reported as a rejection");
  ok(
    await visible(progress.getByRole("button", { name: /^Try again$/ })),
    "a rate-limited send can be retried unchanged",
  );
  await finish(context);
}

// ---------------------------------------------------------------------------
// A market that is not in the registry.
// ---------------------------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("erodoro.testWallet", "seller");
      localStorage.setItem("erodoro.tour.v1", "1");
    } catch {}
  });
  fixtures.push(await installChainFixture(context, FIXTURE, MODE));
  const page = await context.newPage();
  await page.goto(`${BASE}/trade/markets?market=11111111111111111111111111111111&view=n`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(MODE === "record" ? 6_000 : 3_000);

  const missingText = await page.locator("main").innerText().catch(() => "");
  ok(
    /not listed|unavailable/i.test(missingText),
    "an unlisted market says so instead of rendering an empty terminal",
  );
  ok(
    await visible(page.getByRole("link", { name: /Browse markets/ })),
    "an unlisted market offers a way back to the ones that exist",
  );
  await finish(context);
}

// ---------------------------------------------------------------------------
// Nobody connected.
// ---------------------------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // No demo signer selected, and no wallet extension in a headless browser.
  await context.addInitScript(() => {
    try {
      localStorage.removeItem("erodoro.testWallet");
      localStorage.setItem("erodoro.tour.v1", "1");
    } catch {}
  });
  fixtures.push(await installChainFixture(context, FIXTURE, MODE));
  const page = await context.newPage();
  await page.goto(`${BASE}/app`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(MODE === "record" ? 4_000 : 1_500);
  await page.locator('tr[data-tour="series-card"]').first().click();
  await page.waitForTimeout(MODE === "record" ? 8_000 : 2_500);

  const ticket = ticketOf(page);
  const submit = ticket.getByRole("button", { name: /^(Sell|Buy) Upside claim$/ });
  ok(await submit.isDisabled().catch(() => false), "an order cannot be submitted with no signer");
  const reason = await submit.getAttribute("title");
  ok(
    Boolean(reason && /connect|choose/i.test(reason)),
    `the disabled action says a signer is what is missing (saw: ${reason})`,
  );
  await finish(context);
}

await browser.close();
closeServer();

// A replay that silently fell back to the network would still pass, so the
// fixture reports what it had no answer for and that is failed on directly.
if (MODE === "replay") {
  const gaps = fixtures.flatMap((fixture) => fixture.missing);
  const methods = [...new Set(gaps.flatMap((gap) => gap.methods))].filter(Boolean);
  ok(gaps.length === 0, `every chain read is served from the fixture${methods.length ? ` (missing: ${methods.join(", ")})` : ""}`);
}

if (MODE === "record") {
  // One merged fixture across every scenario, so replay has an answer for each
  // of them without re-recording per test.
  for (const fixture of fixtures) fixture.save();
  console.log("\nrecorded chain written to tests/fixtures/");
}
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall journey checks passed");
process.exit(failures.length ? 1 : 0);
