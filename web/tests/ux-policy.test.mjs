import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  confirmationStrategy,
  isTransactionExpired,
  sendPhaseLabel,
} from "../lib/transaction-lifecycle.ts";
import {
  assertMagicBlockOrderRoute,
  executionStatus,
  MAGICBLOCK_CREDIT,
  orderMutationBlocker,
} from "../lib/execution-policy.ts";
import { deriveCapabilities, LIVE_EXECUTION_PENDING } from "../lib/capabilities.ts";
import {
  claimDescription,
  claimLabel,
  orderMaximum,
  orderPreview,
  sizedPercentage,
} from "../lib/trading-ux.ts";
import { isWalletConnectionFailure, isWalletRejection } from "../lib/wallet-errors.ts";

/** A deployment with nothing wrong with it, so a test can name the one thing. */
const evidence = (overrides) => ({
  network: "devnet",
  programsDeployed: true,
  sessionActive: true,
  exitInterfaceDeployed: true,
  binariesPinned: true,
  exitProven: true,
  oracleMinSignatures: 3,
  ...overrides,
});

test("confirmation retains the lifetime signed into the transaction", () => {
  const lifetime = { blockhash: "signed-blockhash", lastValidBlockHeight: 42 };
  assert.deepEqual(confirmationStrategy("signature", lifetime), {
    signature: "signature",
    blockhash: "signed-blockhash",
    lastValidBlockHeight: 42,
  });
});

test("expired transactions are separated from ordinary failures", () => {
  assert.equal(
    isTransactionExpired(new Error("Signature 123 has expired: block height exceeded")),
    true,
  );
  assert.equal(isTransactionExpired(new Error("custom program error: 0x1")), false);
  assert.equal(
    isTransactionExpired({ name: "TransactionExpiredBlockheightExceededError" }),
    true,
  );
});

test("wallet rejection is a cancelled action, not a framework failure", () => {
  assert.equal(isWalletRejection(new Error("User rejected the request.")), true);
  assert.equal(
    isWalletRejection({ cause: new Error("Request rejected by the user") }),
    true,
  );
  assert.equal(isWalletRejection(new Error("RPC node unavailable")), false);
});

test("a broken browser-wallet connector does not become an interface failure", () => {
  assert.equal(
    isWalletConnectionFailure(new Error("WalletConnectionError: Failed to connect to MetaMask")),
    true,
  );
  assert.equal(
    isWalletConnectionFailure({ cause: new Error("MetaMask extension not found") }),
    true,
  );
  assert.equal(isWalletConnectionFailure(new Error("program account is invalid")), false);
});

test("transaction phases name the network only after submission", () => {
  assert.equal(sendPhaseLabel("preparing", "solana"), "Checking the transaction…");
  assert.equal(sendPhaseLabel("approval", "magicblock"), "Approve in your wallet…");
  assert.equal(sendPhaseLabel("submitted", "magicblock"), "Submitted to MagicBlock…");
  assert.equal(sendPhaseLabel("confirming", "solana"), "Confirming on Solana…");
});

test("order policy permits reads but blocks every non-MagicBlock mutation", () => {
  // The blocker no longer re-decides whether execution is live; it repeats what
  // the capability model decided, so the two can never disagree on screen.
  const ready = deriveCapabilities(evidence({ sessionActive: true }));
  const pending = deriveCapabilities(evidence({ sessionActive: false }));

  assert.match(
    orderMutationBlocker({ connected: false, capabilities: ready }),
    /Connect a wallet/,
  );
  assert.match(
    orderMutationBlocker({ connected: true, capabilities: pending }),
    /available.*MagicBlock/i,
  );
  assert.equal(orderMutationBlocker({ connected: true, capabilities: ready }), undefined);
  // The venue is named in one place. If the credit is edited out of the
  // capability's reason, the order ticket silently stops naming it.
  assert.ok(LIVE_EXECUTION_PENDING.includes(MAGICBLOCK_CREDIT));
  assert.throws(() => assertMagicBlockOrderRoute(false), /Order not sent.*MagicBlock/);
  assert.doesNotThrow(() => assertMagicBlockOrderRoute(true));
  assert.match(executionStatus(true), /Live execution.*powered by MagicBlock/);
  assert.match(executionStatus(false), /Preparing live execution.*powered by MagicBlock/);
});

test("claim language describes the payoff without claiming downside protection", () => {
  assert.equal(claimLabel("P"), "Capped equity claim");
  assert.equal(claimLabel("N"), "Upside claim");
  assert.match(claimDescription("P"), /full downside/);
  assert.match(claimDescription("N"), /above the strike/);
});

test("percentage sizing respects the available side of the order", () => {
  const buyMax = orderMaximum({
    side: "buy",
    price: 2,
    availableBase: 10,
    availableQuote: 100,
  });
  assert.equal(buyMax, 50);
  assert.equal(sizedPercentage(buyMax, 25), 12.5);
  assert.equal(
    orderMaximum({ side: "sell", price: 2, availableBase: 10, availableQuote: 100 }),
    10,
  );
});

test("order preview shows the debit and post-order balance", () => {
  assert.deepEqual(
    orderPreview({
      side: "buy",
      price: 2,
      size: 4,
      availableBase: 10,
      availableQuote: 20,
    }),
    { total: 8, remaining: 12 },
  );
  assert.deepEqual(
    orderPreview({
      side: "sell",
      price: 2,
      size: 4,
      availableBase: 10,
      availableQuote: 20,
    }),
    { total: 8, remaining: 6 },
  );
});

test("both order implementations hard-route mutations to MagicBlock", () => {
  const custom = fs.readFileSync(new URL("../components/book-panel.tsx", import.meta.url), "utf8");
  const manifest = fs.readFileSync(new URL("../components/manifest-book-panel.tsx", import.meta.url), "utf8");
  const actions = fs.readFileSync(new URL("../lib/actions.ts", import.meta.url), "utf8");
  const provider = fs.readFileSync(new URL("../components/solana-provider.tsx", import.meta.url), "utf8");

  assert.match(
    custom,
    /const order = async[\s\S]*assertMagicBlockOrderRoute\(delegated\);[\s\S]*await send\(build, erConnection\)/,
  );
  assert.match(
    manifest,
    /const planOrder = useCallback\([\s\S]*assertMagicBlockOrderRoute\(delegated\);[\s\S]*manifestOrderIx[\s\S]*\n\s*\}, rollup\);/,
  );
  assert.doesNotMatch(custom, /protected leg/i);
  assert.doesNotMatch(manifest, /protected leg/i);
  assert.doesNotMatch(manifest, /Open Manifest book|Activate MagicBlock market|Prepare custody|Operator diagnostics/);
  assert.doesNotMatch(manifest, /Read-only · waiting for MagicBlock/);
  assert.doesNotMatch(actions, /FALLBACK_VALIDATOR/);
  assert.match(actions, /Could not verify the MagicBlock validator/);
  assert.match(provider, /autoConnect=\{false\}/);
});

test("the default market flow hides implementation setup and prepares an order automatically", () => {
  const manifest = fs.readFileSync(new URL("../components/manifest-book-panel.tsx", import.meta.url), "utf8");
  const ticket = fs.readFileSync(new URL("../components/order-book-ui.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(manifest, /Prepare to trade|Add trading balance|Prepare custody|Create book/);
  const flow = fs.readFileSync(new URL("../lib/transaction-flow.ts", import.meta.url), "utf8");
  assert.match(flow, /label: "Move balance to live execution"/);
  assert.match(flow, /label: "Confirm the live balance"/);
  // The projection wait must never be counted as a wallet approval, or the
  // ticket overstates what the user is about to be asked to sign.
  assert.match(flow, /kind: "project",\s*\n\s*target: "magicblock",\s*\n\s*approval: false/);
  assert.match(manifest, /approvals=\{/);
  assert.match(manifest, /manifestDepositIxs\([\s\S]*manifestOrderIx/);
  assert.match(ticket, /You pay at most/);
  assert.match(ticket, /You receive at least/);
  assert.match(ticket, /balance after/);
  assert.doesNotMatch(ticket, /window\.localStorage/);
});

test("admin listing verifies both claim books before reporting the market live", () => {
  const registry = fs.readFileSync(new URL("../components/create-panel.tsx", import.meta.url), "utf8");

  assert.match(registry, /for \(const baseMint of \[pMintPda\(address\), nMintPda\(address\)\]\)/);
  assert.match(registry, /waitForManifestBookLive/);
  assert.match(registry, /if \(!activated\) return;[\s\S]*tradingIsLive\(address\)/);
  assert.match(registry, /listedSeries && listedMarketLive/);
  assert.doesNotMatch(registry, /setListedSeries\(address\);[\s\S]{0,120}await activateTrading/);
});

test("an unexpected L1 owner is never treated as a MagicBlock session", () => {
  const rollup = fs.readFileSync(new URL("../lib/rollup.ts", import.meta.url), "utf8");
  assert.match(rollup, /info\.owner\.equals\(MAGICBLOCK_DELEGATION_PROGRAM_ID\)/);
  assert.match(rollup, /Market account has unexpected owner/);
});

test("canonical navigation separates markets, portfolio, demo setup and admin", () => {
  const chrome = fs.readFileSync(new URL("../components/app-chrome.tsx", import.meta.url), "utf8");
  const legacy = fs.readFileSync(new URL("../components/legacy-admin-redirect.tsx", import.meta.url), "utf8");
  const portfolio = fs.readFileSync(new URL("../app/portfolio/page.tsx", import.meta.url), "utf8");

  assert.match(chrome, /href: "\/app", label: "Markets"/);
  assert.match(chrome, /href: "\/portfolio", label: "Portfolio"/);
  assert.match(chrome, /href: "\/faucet", label: "Get test assets"/);
  assert.match(chrome, /function WalletMenu[\s\S]*?>\s*Select wallet\s*<\/summary>[\s\S]*?<TestWalletBar/);
  assert.doesNotMatch(chrome, /Devnet tools/);
  assert.doesNotMatch(chrome, />\s*Demo setup\s*</);
  assert.equal((chrome.match(/<TourButton \/>/g) ?? []).length, 1);
  assert.doesNotMatch(chrome, /\["\/create", "Registry"\]/);
  assert.match(legacy, /router\.replace\("\/admin\/registry"\)/);
  assert.match(portfolio, /title: "Portfolio · erodoro"/);
});

test("selecting a demo signer reads the real factory account namespace", () => {
  const chrome = fs.readFileSync(new URL("../components/app-chrome.tsx", import.meta.url), "utf8");
  const routeError = fs.readFileSync(new URL("../app/error.tsx", import.meta.url), "utf8");
  const globalError = fs.readFileSync(new URL("../app/global-error.tsx", import.meta.url), "utf8");

  assert.match(chrome, /\(factory\.account as any\)\.factoryState\s*\.fetchNullable/);
  assert.doesNotMatch(chrome, /\(factory\.account as any\)\.factory\s*\.fetchNullable/);
  assert.match(routeError, /onClick=\{reset\}/);
  assert.match(globalError, /onClick=\{reset\}/);
});

test("confirmed guide actions advance without unmounting their transaction status", () => {
  const seriesHook = fs.readFileSync(new URL("../lib/use-series.ts", import.meta.url), "utf8");
  const seriesActions = fs.readFileSync(new URL("../components/series-actions.tsx", import.meta.url), "utf8");
  const manifest = fs.readFileSync(new URL("../components/manifest-book-panel.tsx", import.meta.url), "utf8");
  const ui = fs.readFileSync(new URL("../components/ui.tsx", import.meta.url), "utf8");

  assert.match(seriesHook, /const reload = useCallback\(\(\) => load\(false\)/);
  assert.match(seriesActions, /if \(!signature\) return;[\s\S]*complete\("act"\)/);
  assert.match(manifest, /onOrderPlaced = useCallback\([\s\S]*complete\("act"\)/);
  // The tour still advances only on a resolved flow, and the outcome is read
  // back from the book rather than assumed from the confirmation.
  assert.match(manifest, /if \(finished\) void onOrderPlaced\(requested, before\)/);
  assert.match(manifest, /setOutcome\(describeFill\(\{ requested, restingAfter \}\)\)/);
  assert.match(ui, /<button\b[\s\S]{0,400}?onClick=\{onClick\}/);
  assert.match(ui, /disabledReason/);
});

test("retired user-facing labels do not return to the primary surfaces", () => {
  const landing = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const discovery = fs.readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
  const positions = fs.readFileSync(new URL("../components/positions-panel.tsx", import.meta.url), "utf8");
  const terminal = fs.readFileSync(new URL("../components/series-detail.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(landing, />\s*Launch App\s*</);
  assert.doesNotMatch(landing, /\["Hedge"/);
  assert.doesNotMatch(discovery, /title="Contracts"|This is not downside protection/);
  assert.doesNotMatch(positions, />not settled yet</);
  assert.doesNotMatch(terminal, />\s*← All contracts\s*</);
  assert.match(terminal, /Advanced trading/);
});

test("strategy, hierarchy, and market discovery stay decision-first", () => {
  const terminal = fs.readFileSync(new URL("../components/series-detail.tsx", import.meta.url), "utf8");
  const manifest = fs.readFileSync(new URL("../components/manifest-book-panel.tsx", import.meta.url), "utf8");
  const markets = fs.readFileSync(new URL("../components/markets-table.tsx", import.meta.url), "utf8");

  assert.match(manifest, /intent === "seller" \? "sell" : "buy"/);
  assert.match(manifest, /onIntentChange\(next === "sell" \? "seller" : "buyer"\)/);
  assert.ok(
    terminal.indexOf("<ManifestBookPanel") < terminal.indexOf("data-market-education"),
    "trading workspace must precede education",
  );
  for (const label of ["Market", "Reference", "Strike", "Distance", "Expiry", "Best bid", "Bid size", "Status"]) {
    assert.ok(markets.includes(`"${label}"`), `discovery includes ${label}`);
  }
  assert.match(markets, /aria-label="Stock"/);
  assert.match(markets, /label="Expiry window"/);
  // Volume stays disclosed, but as one footnote rather than a column holding a
  // "—" on every row for a figure that cannot exist without an indexer.
  assert.doesNotMatch(markets, />24h volume</);
  assert.match(markets, /trade-history indexer/);
});

test("the landing page states no metric it cannot back", () => {
  const landing = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const ticker = fs.readFileSync(new URL("../components/ticker.tsx", import.meta.url), "utf8");
  const verify = fs.readFileSync(new URL("../components/verify-panel.tsx", import.meta.url), "utf8");

  // No floor, anywhere. The product caps upside; the first reader to open the
  // contract will check, and this is the wording they would check against.
  //
  // "guaranteed" is deliberately not on this list. The FAQ asks "Is an order
  // guaranteed to execute?" and answers no, which is exactly the disclosure
  // this test exists to protect -- a word-level ban would pressure someone
  // into deleting it to get the suite green.
  for (const word of ["protected", "hedged", "insured", "risk-free", "safe"]) {
    assert.doesNotMatch(
      landing,
      new RegExp(`\\b${word}\\b`, "i"),
      `landing must not describe the position as ${word}`,
    );
  }

  // No total value, no user count, no raise. There is no indexer behind any of
  // them and no way for a reader to check one.
  assert.doesNotMatch(landing, /\bTVL\b|total value locked/i);
  assert.doesNotMatch(landing, /\d[\d,]*\+? (users|traders|holders)/i);
  assert.doesNotMatch(landing, /\$[\d,]+(?:\.\d+)?[MBK]\b/);

  // Everything the ticker and the verify panel state comes from the generated
  // deployment facts, so a redeploy cannot leave the page vouching for
  // addresses that are no longer live.
  for (const source of [ticker, verify]) {
    assert.match(source, /from "@\/lib\/deployment-facts"/);
  }
  assert.doesNotMatch(ticker, /[1-9A-HJ-NP-Za-km-z]{32,44}/, "no hardcoded addresses in the ticker");
  assert.doesNotMatch(verify, /[1-9A-HJ-NP-Za-km-z]{32,44}/, "no hardcoded addresses in the verify panel");

  // The page admits the gap in the same section that invites verification.
  assert.match(verify, /settlementExit/);
  assert.match(verify, /cannot yet be returned/);
});

test("the landing page renders without a wallet, an RPC, or a chain read", () => {
  const landing = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const parts = ["ticker", "verify-panel", "hero-art", "showcase", "reveal"].map((name) =>
    fs.readFileSync(new URL(`../components/${name}.tsx`, import.meta.url), "utf8"),
  );

  // `/` is the one route that has to render for someone with no extension
  // installed on a bad connection. Pulling web3.js or a wallet adapter into it
  // would cost that quietly -- the page would still work, just several hundred
  // kilobytes later.
  for (const source of [landing, ...parts]) {
    assert.doesNotMatch(source, /@solana\/web3\.js|wallet-adapter|useConnection/);
  }
  // And none of them may be client components: a "use client" here would drag
  // the whole subtree into the browser bundle for a page that never changes.
  for (const source of parts) {
    assert.doesNotMatch(source, /^"use client"/m);
  }
});

test("the production interface has no Three.js or WebGL runtime", () => {
  const pkg = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const landing = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(pkg, /[\"']three[\"']/);
  assert.doesNotMatch(landing, /World|WebGL|THREE/);
});

test("public header is focused and verifiable market details are present", () => {
  const nav = fs.readFileSync(new URL("../components/nav.tsx", import.meta.url), "utf8");
  const waitlist = fs.readFileSync(new URL("../components/waitlist-button.tsx", import.meta.url), "utf8");
  const oracle = fs.readFileSync(new URL("../components/oracle-panel.tsx", import.meta.url), "utf8");
  const ui = fs.readFileSync(new URL("../components/ui.tsx", import.meta.url), "utf8");

  for (const label of ["Built on Solana"]) {
    assert.match(nav, new RegExp(`>\\s*${label}\\s*<`));
  }
  for (const label of ["Product", "How it works", "Risks", "Docs", "GitHub"]) {
    assert.doesNotMatch(nav, new RegExp(`>\\s*${label}\\s*<`));
  }
  assert.match(waitlist, />\s*Request access\s*</);
  assert.match(waitlist, /type="email"/);
  assert.match(waitlist, /fetch\("\/waitlist"/);
  assert.match(oracle, /Confidence/);
  assert.match(oracle, /Latest update/);
  assert.match(oracle, /Verification/);
  assert.match(ui, /Copy/);
  assert.match(ui, /Explorer/);
});
