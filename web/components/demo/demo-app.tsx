"use client";

import Link from "next/link";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { STUB_ASSETS } from "@/lib/demo-config";
import { changeDemo, useDemoLedger } from "@/lib/demo/store";
import { buyStub, closeStub, initialLedger, markStub, moveDemoCash, moveStubPrice, redeemCapped, sellStub, setStubPrice, settleDue, stubLots, swapStub, updateOrder } from "@/lib/demo/ledger";
import { shortDate, totalQty, usd } from "@/lib/rips/model";
import { Logo } from "../logo";
import { ThemeToggle } from "../theme-toggle";
import { TickerMark } from "../rips/bits";

const control = "border-line bg-panel hover:border-text rounded-xl border px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed";
const input = "border-line bg-bg w-full rounded-xl border px-3 py-3 text-sm";
const primary = "rip-cta mt-5 min-h-12 w-full px-4 text-base";

function useDemoNow() {
  const state = useDemoLedger();
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const tick = () => setClock(Math.floor(Date.now() / 1000));
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => window.clearInterval(timer);
  }, []);
  return clock + state.offset;
}

export function DemoHeader() {
  const state = useDemoLedger();
  const path = usePathname();
  return <header className="border-line bg-bg sticky top-0 z-50 border-b">
    <p className="border-line border-b px-4 py-2 text-center text-xs sm:text-sm">Demo mode · simulated assets, prices and funds · no transactions on chain</p>
    <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
      <Logo href="/" />
      <div className="flex items-center gap-2">
        <span className="text-muted text-sm tabular-nums" aria-label="Demo wallet balance">{usd(state.cash, 2)} USDC</span>
        <ThemeToggle compact />
        <button className={control} onClick={() => changeDemo((s) => ({ ...s, connected: !s.connected }))}>{state.connected ? "Demo wallet · connected" : "Connect demo wallet"}</button>
      </div>
    </div>
    <nav aria-label="Demo" className="mx-auto flex max-w-6xl gap-2 overflow-x-auto px-4 pb-3">
      {[["/earn", "Earn"], ["/market-rip", "Market Rip"], ["/rips", "My Rips"], ["/app", "Markets"], ["/portfolio", "Portfolio"], ["/swap", "Swap"], ["/faucet", "Demo funds"]].map(([href, label]) =>
        <Link key={href} href={href} aria-current={path === href ? "page" : undefined} className={`shrink-0 rounded-full px-3 py-2 text-sm ${path === href ? "bg-text text-bg" : "border-line border hover:border-text"}`}>{label}</Link>)}
    </nav>
  </header>;
}

export function DemoControls() {
  const state = useDemoLedger();
  const now = useDemoNow();
  const [symbol, setSymbol] = useState<string>("AAPL");
  const [price, setPrice] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const nextExpiry = [...state.positions, ...state.capped].map((p) => p.expiryTs).filter((t) => t > now).sort((a, b) => a - b)[0];
  return <><DemoStockPrices /><details className="border-line bg-panel mt-10 rounded-2xl border p-4">
    <summary className="cursor-pointer text-sm font-semibold">Demo controls</summary>
    <p className="text-muted mt-3 text-sm">Change the scenario to test balances, failures and expiry. Settlement here pays simulated USDC; on-chain redemption returns collateral tokens.</p>
    <div className="mt-4 flex flex-wrap gap-2">
      <button className={control} onClick={() => { changeDemo((s) => ({ ...s, cash: s.cash + 1000 })); setNotice("Added $1,000 demo USDC."); }}>Add $1,000 demo USDC</button>
      <button className={control} onClick={() => { changeDemo((s) => ({ ...s, cash: 0 })); setNotice("Demo USDC balance set to zero."); }}>Set demo USDC to zero</button>
      <button className={control} disabled={!nextExpiry} title={!nextExpiry ? "Buy or list a position first." : undefined} onClick={() => { changeDemo((s) => settleDue({ ...s, offset: nextExpiry + 1 - Math.floor(Date.now() / 1000) }, nextExpiry + 1)); setNotice("Advanced to expiry. Redeem from Portfolio."); }}>Advance to next expiry</button>
    </div>
    {!nextExpiry && <p className="text-dim mt-2 text-xs">Buy or list a position to test expiry.</p>}
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="text-sm">Transaction outcome<select aria-label="Transaction outcome" className={`${input} mt-1`} value={state.failure} onChange={(e) => changeDemo((s) => ({ ...s, failure: e.target.value as typeof s.failure }))}>
        <option value="none">Success</option><option value="reject">Reject approval</option><option value="network">Network timeout</option>
      </select></label>
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1 text-sm">Asset<select aria-label="Scenario asset" className={`${input} mt-1`} value={symbol} onChange={(e) => { setSymbol(e.target.value); setPrice(""); }}>{STUB_ASSETS.map((a) => <option key={a.symbol}>{a.symbol}</option>)}</select></label>
        <label className="min-w-0 flex-1 text-sm">Stub price<input aria-label="Stub price" type="number" min="0.01" step="any" className={`${input} mt-1`} placeholder={String(state.prices[symbol])} value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        <button className={control} disabled={!Number.isFinite(Number(price)) || Number(price) <= 0} onClick={() => { changeDemo((s) => setStubPrice(s, symbol, Number(price), Math.floor(Date.now() / 1000) + s.offset)); setNotice(`${symbol} stub price updated.`); }}>Apply price</button>
      </div>
    </div>
    <p className="text-dim mt-3 text-xs">Demo date: {now ? new Date(now * 1000).toLocaleString() : "Loading…"}. Fixtures are illustrative; they are not current market prices.</p>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button className={control} onClick={() => setConfirmReset(true)}>Reset demo</button>
      {confirmReset && <><span className="text-sm">Clear this browser’s demo positions and orders?</span><button className={control} onClick={() => { changeDemo(() => initialLedger()); setConfirmReset(false); setNotice("Demo reset. $1,000 USDC and 10 of each stock restored."); }}>Confirm demo reset</button><button className={control} onClick={() => setConfirmReset(false)}>Keep demo</button></>}
    </div>
    {notice && <p role="status" className="text-p mt-3 text-sm">{notice}</p>}
  </details></>;
}

/** Visible controls make price scenarios part of the journey, not a hidden input. */
function DemoStockPrices() {
  const state = useDemoLedger();
  const [notice, setNotice] = useState("");
  const move = (symbol: string, percent: number) => {
    const next = changeDemo((s) => moveStubPrice(s, symbol, percent, Math.floor(Date.now() / 1000) + s.offset));
    setNotice(`${symbol} ${percent > 0 ? "increased" : "decreased"} ${Math.abs(percent)}% to ${usd(next.prices[symbol], 2)}. Open position values updated.`);
  };
  return <section aria-labelledby="demo-stock-prices" className="border-line mt-10 border-t pt-6">
    <h2 id="demo-stock-prices" className="font-display text-xl font-semibold">Move stock prices</h2>
    <p className="text-muted mt-2 text-sm">Click to raise or lower a simulated stock price. Open claims reprice immediately; expired payouts stay fixed. These controls currently update this browser’s demo only.</p>
    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {STUB_ASSETS.map((asset) => {
        const price = state.prices[asset.symbol];
        const movePct = (price / asset.base - 1) * 100;
        return <article key={asset.symbol} className="border-line bg-panel rounded-2xl border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-semibold">{asset.symbol}</h3><span className="font-mono text-sm tabular-nums" aria-label={`${asset.symbol} demo stock price`}>{usd(price, 2)}</span></div>
          <p className={`mt-1 text-xs tabular-nums ${movePct > 0 ? "text-p" : movePct < 0 ? "text-danger" : "text-muted"}`}>{movePct > 0 ? "+" : ""}{movePct.toFixed(2)}% from starting price</p>
          <div className="mt-3 flex gap-2">
            <button className={`${control} flex-1`} aria-label={`Decrease ${asset.symbol} price 5%`} onClick={() => move(asset.symbol, -5)}>↓ −5%</button>
            <button className={`${control} flex-1`} aria-label={`Increase ${asset.symbol} price 5%`} onClick={() => move(asset.symbol, 5)}>↑ +5%</button>
          </div>
          <button className="text-muted hover:text-text mt-3 text-xs underline underline-offset-2" aria-label={`Reset ${asset.symbol} price`} onClick={() => {
            changeDemo((s) => setStubPrice(s, asset.symbol, asset.base, Math.floor(Date.now() / 1000) + s.offset));
            setNotice(`${asset.symbol} price reset to ${usd(asset.base, 2)}.`);
          }}>Reset price</button>
        </article>;
      })}
    </div>
    {notice && <p role="status" className="text-muted mt-3 text-sm">{notice}</p>}
  </section>;
}

/** Route adapter keeps every simulated journey outside the Solana provider. */
export function DemoRoute({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <p role="status" className="p-6 text-sm">Loading demo wallet…</p>;
  if (path === "/market-rip" || path.startsWith("/rips")) return children;
  if (path === "/") return <DemoStrategyList />;
  return <><DemoHeader /><main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8"><Suspense fallback={<p>Loading demo…</p>}><DemoScreen /></Suspense><DemoControls /></main></>;
}

function DemoStrategyList() {
  const state = useDemoLedger();
  const now = useDemoNow();
  return <div className="grid gap-3 sm:grid-cols-3">{stubLots(state, now).filter((l) => l.id.includes("-7-")).slice(0, 3).map((lot) => <Link key={lot.id} href={`/trade/markets?market=${lot.id}`} className="border-line bg-panel rounded-xl border p-4"><p className="font-semibold">{lot.symbol} · simulated</p><p className="text-muted mt-2 text-sm">Above {usd(lot.strike)} · {shortDate(lot.expiryTs)}</p><p className="text-muted text-sm">Upside price {usd(lot.askPrice)}</p></Link>)}</div>;
}

function DemoScreen() {
  const path = usePathname();
  if (path === "/earn") return <DemoEarn />;
  if (path === "/portfolio") return <DemoPortfolio />;
  if (path === "/app") return <DemoMarkets />;
  if (path === "/trade/markets") return <DemoTrade />;
  if (["/swap", "/buy", "/sell"].includes(path)) return <DemoSwap />;
  if (["/faucet", "/mint", "/create", "/admin/registry"].includes(path)) return <><h1 className="font-display text-3xl">Your demo assets</h1><p className="text-muted mt-3">The wallet starts with $1,000 demo USDC and 10 units of each stock. Use Demo controls to fund or reset it.</p><DemoStocks /></>;
  return <><h1 className="font-display text-3xl">{path === "/rewards" ? "Rewards" : "Auctions"}</h1><p className="text-muted mt-3">There is no {path === "/rewards" ? "rewards" : "auction"} product in this protocol. Try simulated limit orders from Earn or Markets.</p><Link className="mt-5 inline-block underline" href="/earn">Try Earn →</Link></>;
}

function useNotice() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const act = (fn: () => void, success: string) => {
    try { fn(); setError(false); setMessage(success); } catch (e) { setError(true); setMessage(e instanceof Error ? e.message : String(e)); }
  };
  return { act, feedback: message ? <p role={error ? "alert" : "status"} className={`mt-4 text-sm ${error ? "text-danger" : "text-p"}`}>{message}</p> : null };
}

function DemoEarn() {
  const state = useDemoLedger();
  const now = useDemoNow();
  const params = useSearchParams();
  const router = useRouter();
  const [symbol, setSymbol] = useState(params.get("stock") ?? "");
  const [lotId, setLotId] = useState("");
  const [qty, setQty] = useState("");
  const [premium, setPremium] = useState("");
  const lots = stubLots(state, now).filter((l) => l.symbol === symbol);
  const lot = lots.find((l) => l.id === lotId);
  const reason = !state.connected ? "Connect the demo wallet to continue." : !lot ? "Choose a stock, strike and expiry." : !Number.isFinite(Number(qty)) || Number(qty) <= 0 ? "Enter a quantity greater than zero." : Number(qty) > state.stocks[symbol] ? "Quantity exceeds your stock balance." : !Number.isFinite(Number(premium)) || Number(premium) <= 0 ? "Enter a minimum premium greater than zero." : null;
  return <><h1 className="font-display text-3xl">Earn premium on your stocks</h1><p className="text-muted mt-3">Choose terms and review a simulated upside sale. You keep the capped claim and the stock’s downside risk.</p>
    <div className="mt-8 grid gap-6 lg:grid-cols-2"><section className="border-line bg-panel space-y-5 rounded-2xl border p-6">
      <h2 className="text-xl font-semibold">1. Choose your stock</h2>
      <label className="block text-sm">Stock<select aria-label="Stock" className={`${input} mt-2`} value={symbol} onChange={(e) => { setSymbol(e.target.value); setLotId(""); }}><option value="">Select stock</option>{STUB_ASSETS.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol} · {a.name}</option>)}</select></label>
      <label className="block text-sm">Quantity<input aria-label="Quantity" className={`${input} mt-2`} type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
      <p className="text-muted text-sm">Balance {symbol ? `${state.stocks[symbol] ?? 0} ${symbol}` : "—"}</p>
      <h2 className="text-xl font-semibold">2. Set your terms</h2>
      <label className="block text-sm">Strike and expiry<select aria-label="Strike and expiry" className={`${input} mt-2`} value={lotId} onChange={(e) => setLotId(e.target.value)}><option value="">Choose listed terms</option>{lots.map((l) => <option key={l.id} value={l.id}>Above {usd(l.strike)} · {shortDate(l.expiryTs)}</option>)}</select></label>
      <label className="block text-sm">Minimum premium per token<input aria-label="Minimum premium per token" className={`${input} mt-2`} type="number" min="0" step="any" value={premium} onChange={(e) => setPremium(e.target.value)} /></label>
    </section><aside className="border-line bg-panel rounded-2xl border p-6"><h2 className="text-xl font-semibold">3. Review your upside</h2><p className="text-muted mt-4">{lot ? `Sell the upside on ${qty || "0"} ${symbol} above ${usd(lot.strike)} until ${shortDate(lot.expiryTs)}.` : "Choose your stock and terms to preview your sale."}</p>
      <p className="text-muted mt-5 text-sm">Gross premium if fully filled</p><p className="font-display mt-2 text-3xl">{usd((Number(qty) || 0) * (Number(premium) || 0))} USDC</p><p className="text-muted mt-3 text-sm">The stock is locked when you place the order. Premium arrives only after a counterparty fills it.</p>
      <button className={primary} disabled={!!reason} title={reason ?? undefined} onClick={() => router.push(`/trade/markets?market=${lotId}&side=sell&qty=${encodeURIComponent(qty)}&premium=${encodeURIComponent(premium)}`)}>Review sell order</button>{reason && <p className="text-dim mt-3 text-sm">{reason}</p>}
    </aside></div></>;
}

function DemoMarkets() {
  const state = useDemoLedger();
  const now = useDemoNow();
  const [search, setSearch] = useState("");
  const lots = stubLots(state, now).filter((l) => `${l.symbol} ${l.name}`.toLowerCase().includes(search.toLowerCase()));
  return <><h1 className="font-display text-3xl">Markets</h1><p className="text-muted mt-3">Simulated stock upside. Prices and inventory are fixtures.</p><input className={`${input} mt-5 max-w-sm`} aria-label="Search stocks" placeholder="Search stocks" value={search} onChange={(e) => setSearch(e.target.value)} /><div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{lots.map((l) => <Link key={l.id} href={`/trade/markets?market=${l.id}`} className="border-line bg-panel hover:border-text rounded-2xl border p-5"><div className="flex items-center gap-3"><TickerMark symbol={l.symbol} /><h2 className="text-lg font-semibold">{l.symbol} upside</h2></div><dl className="mt-4 space-y-2 text-sm"><div className="flex justify-between"><dt>Stock price</dt><dd>{usd(l.spot!)}</dd></div><div className="flex justify-between"><dt>Above</dt><dd>{usd(l.strike)}</dd></div><div className="flex justify-between"><dt>Expiry</dt><dd>{shortDate(l.expiryTs)}</dd></div><div className="flex justify-between"><dt>Upside ask</dt><dd>{usd(l.askPrice)}</dd></div><div className="flex justify-between"><dt>On offer</dt><dd>{usd(l.availableUsd)}</dd></div></dl></Link>)}</div>{!lots.length && <p className="mt-5 text-sm">No matching active demo markets. Reset the demo to start new terms.</p>}</>;
}

function DemoTrade() {
  const state = useDemoLedger();
  const now = useDemoNow();
  const params = useSearchParams();
  const lots = stubLots(state, now);
  const lot = lots.find((l) => l.id === params.get("market"));
  const [side, setSide] = useState(params.get("side") === "sell" ? "sell" : "buy");
  const [qty, setQty] = useState(params.get("qty") ?? "1");
  const [premium, setPremium] = useState(params.get("premium") ?? "1");
  const [budget, setBudget] = useState("5");
  const { act, feedback } = useNotice();
  if (!lot) return <><h1 className="text-2xl">Market unavailable</h1><p className="text-muted mt-3">Choose an active demo market. This one may have expired.</p><Link href="/app" className="mt-5 inline-block underline">Browse markets</Link></>;
  return <><Link href="/app" className="text-muted text-sm">← Markets</Link><h1 className="font-display mt-4 text-3xl">{lot.symbol} upside above {usd(lot.strike)}</h1><p className="text-muted mt-3">Expires {shortDate(lot.expiryTs)} · demo N claim · can expire worth nothing</p>
    <div className="mt-8 grid gap-6 lg:grid-cols-2"><section className="border-line bg-panel rounded-2xl border p-6"><h2 className="text-xl font-semibold">Simulated order book</h2><dl className="mt-5 space-y-4 text-sm"><div className="flex justify-between"><dt>Stock price</dt><dd>{usd(lot.spot!)}</dd></div><div className="flex justify-between"><dt>Best ask</dt><dd>{usd(lot.askPrice, 4)}</dd></div><div className="flex justify-between"><dt>Best bid</dt><dd>{usd(lot.askPrice * 0.98, 4)}</dd></div><div className="flex justify-between"><dt>Ask inventory</dt><dd>{usd(lot.availableUsd)}</dd></div></dl><p className="text-muted mt-5 text-sm">Synthetic counterparties fill buys immediately. Your limit sell orders rest until you simulate a fill in Portfolio.</p></section>
    <section className="border-line bg-panel rounded-2xl border p-6"><div role="radiogroup" aria-label="Trade side" className="flex gap-2">{["buy", "sell"].map((s) => <button className={control} key={s} role="radio" aria-checked={side === s} onClick={() => setSide(s)}>{s === "buy" ? "Buy upside" : "Sell upside"}</button>)}</div>
      {side === "buy" ? <label className="mt-5 block text-sm">Spend demo USDC<input className={`${input} mt-2`} aria-label="Spend demo USDC" type="number" min="0" step="any" value={budget} onChange={(e) => setBudget(e.target.value)} /></label> : <><label className="mt-5 block text-sm">Stock quantity<input className={`${input} mt-2`} aria-label="Stock quantity" type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></label><label className="mt-5 block text-sm">Premium per token<input className={`${input} mt-2`} aria-label="Premium per token" type="number" min="0" step="any" value={premium} onChange={(e) => setPremium(e.target.value)} /></label><p className="text-muted mt-3 text-sm">Balance {state.stocks[lot.symbol]} {lot.symbol}. You keep the capped claim and downside risk.</p></>}
      <button className={primary} onClick={() => act(() => changeDemo((s) => side === "buy" ? buyStub(s, lot.id, Number(budget), "buy", Math.floor(Date.now() / 1000) + s.offset).state : sellStub(s, lot.id, Number(qty), Number(premium), Math.floor(Date.now() / 1000) + s.offset)), side === "buy" ? "Demo purchase complete. View it in My Rips or Portfolio." : "Demo sell order placed. Stock locked; premium awaits a fill.")}>{side === "buy" ? "Buy simulated upside" : "Place demo sell order"}</button>{feedback}<Link href="/portfolio" className="mt-5 inline-block underline">View Portfolio →</Link>
    </section></div></>;
}

function DemoStocks() {
  const state = useDemoLedger();
  return <div className="mt-6 grid gap-3 sm:grid-cols-3">{STUB_ASSETS.map((a) => <div key={a.symbol} className="border-line bg-panel rounded-2xl border p-4"><h2 className="font-semibold">{a.symbol} · {a.name}</h2><p className="text-muted mt-2 text-sm">{state.stocks[a.symbol]} stock · {usd(state.prices[a.symbol])} stub price</p></div>)}</div>;
}

function DemoPortfolio() {
  const state = useDemoLedger();
  const now = useDemoNow();
  const [tab, setTab] = useState("Positions");
  const { act, feedback } = useNotice();
  return <><h1 className="font-display text-3xl">Your portfolio</h1><p className="text-muted mt-3">Your simulated positions, premiums, orders and tokens.</p><div role="tablist" aria-label="Portfolio" className="mt-6 flex flex-wrap gap-2">{["Positions", "Open orders", "Live balances", "Wallet tokens", "Activity"].map((t) => <button key={t} role="tab" aria-selected={tab === t} className={control} onClick={() => setTab(t)}>{t}</button>)}</div>{feedback}
    <div role="tabpanel" className="mt-6 space-y-3">
      {tab === "Positions" && <>{!state.positions.length && !state.capped.length && <p>No positions yet. <Link href="/market-rip" className="underline">Try a Rip</Link> or <Link href="/earn" className="underline">list your upside</Link>.</p>}{state.positions.map((p) => <article key={p.id} className="border-line bg-panel flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-5"><div><h2 className="font-semibold">{p.symbol} · N upside claim</h2><p className="text-muted mt-2 text-sm">{totalQty(p).toFixed(6)} claims · above {usd(p.strike)} · {shortDate(p.expiryTs)}</p><p className="mt-1 text-sm">Simulated value {usd(markStub(p, state, now).value)}</p></div><div className="flex gap-2"><Link className={control} href={`/rips/position?id=${encodeURIComponent(p.id)}`}>Details</Link><button className={control} onClick={() => act(() => changeDemo((s) => closeStub(s, p.id, p.expiryTs <= now ? "redeem" : "sell", Math.floor(Date.now() / 1000) + s.offset)), p.expiryTs <= now ? "Demo position redeemed." : "Demo position sold; USDC returned.")}>{p.expiryTs <= now ? "Redeem demo claim" : "Sell demo position"}</button></div></article>)}
      {state.capped.map((p) => <article key={p.id} className="border-line bg-panel flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-5"><div><h2 className="font-semibold">{p.symbol} · P capped claim</h2><p className="text-muted mt-2 text-sm">{p.qty} locked stock · cap {usd(p.strike)} · {shortDate(p.expiryTs)}</p><p className="text-muted mt-1 text-sm">Retains downside risk. Premium is separate.</p></div><button className={control} disabled={p.expiryTs > now} title={p.expiryTs > now ? "Available after expiry. Use Demo controls to advance time." : undefined} onClick={() => act(() => changeDemo((s) => redeemCapped(s, p.id, Math.floor(Date.now() / 1000) + s.offset)), "Demo capped claim redeemed.")}>Redeem capped claim</button></article>)}</>}
      {tab === "Open orders" && <>{!state.orders.some((o) => o.status === "open") && <p>No open orders.</p>}{state.orders.filter((o) => o.status === "open").map((o) => <article key={o.id} className="border-line bg-panel rounded-2xl border p-5"><h2 className="font-semibold">{o.lot.symbol} · sell {o.qty} upside at {usd(o.premium)} each</h2><p className="text-muted mt-2 text-sm">Premium if filled: {usd(o.qty * o.premium)}. {o.lot.expiryTs <= now ? "Expired; cancel to unlock stock." : "Waiting for a simulated counterparty."}</p><div className="mt-4 flex flex-wrap gap-2"><button className={control} disabled={o.lot.expiryTs <= now} title={o.lot.expiryTs <= now ? "This order expired." : undefined} onClick={() => act(() => changeDemo((s) => updateOrder(s, o.id, "fill", Math.floor(Date.now() / 1000) + s.offset)), "Order filled. Demo premium credited.")}>Simulate counterparty fill</button><button className={control} onClick={() => act(() => changeDemo((s) => updateOrder(s, o.id, "cancel", Math.floor(Date.now() / 1000) + s.offset)), "Order cancelled. Stock returned.")}>Cancel demo order</button></div></article>)}</>}
      {tab === "Live balances" && <section className="border-line bg-panel rounded-2xl border p-5"><h2 className="font-semibold">Simulated execution session</h2><p className="text-muted mt-3">Wallet {usd(state.cash)} USDC · session {usd(state.sessionCash)} USDC</p><p className="text-muted mt-2 text-sm">Session funding is a separate custody rehearsal. Demo purchases use the wallet balance.</p><div className="mt-4 flex flex-wrap gap-2"><button className={control} onClick={() => act(() => changeDemo((s) => moveDemoCash(s, "deposit", 10)), "Deposited $10 into demo session.")}>Deposit $10 demo USDC</button><button className={control} disabled={state.sessionCash <= 0} title={state.sessionCash <= 0 ? "Deposit demo funds first." : undefined} onClick={() => act(() => changeDemo((s) => moveDemoCash(s, "withdraw", s.sessionCash)), "Session funds returned to demo wallet.")}>Return demo funds to wallet</button></div></section>}
      {tab === "Wallet tokens" && <DemoStocks />}
      {tab === "Activity" && <>{!state.activity.length && <p>No demo activity yet.</p>}{state.activity.map((a) => <p className="border-line border-b py-3 text-sm" key={a.id}>{a.text}</p>)}</>}
    </div></>;
}

function DemoSwap() {
  const state = useDemoLedger();
  const params = useSearchParams();
  const path = usePathname();
  const [side, setSide] = useState<"buy" | "sell">(params.get("side") === "sell" || path === "/sell" ? "sell" : "buy");
  const [symbol, setSymbol] = useState<string>("AAPL");
  const [qty, setQty] = useState("1");
  const { act, feedback } = useNotice();
  return <><h1 className="font-display text-3xl">Swap demo stocks</h1><section className="border-line bg-panel mt-6 max-w-lg rounded-2xl border p-6"><div className="flex gap-2">{(["buy", "sell"] as const).map((s) => <button key={s} className={control} onClick={() => setSide(s)} aria-pressed={side === s}>{s === "buy" ? "Buy stock" : "Sell stock"}</button>)}</div><label className="mt-5 block text-sm">Stock<select aria-label="Swap stock" className={`${input} mt-2`} value={symbol} onChange={(e) => setSymbol(e.target.value)}>{STUB_ASSETS.map((a) => <option key={a.symbol}>{a.symbol}</option>)}</select></label><label className="mt-5 block text-sm">Quantity<input className={`${input} mt-2`} aria-label="Swap quantity" type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></label><p className="text-muted mt-4 text-sm">{state.stocks[symbol]} stock available · quote {usd((Number(qty) || 0) * state.prices[symbol])} demo USDC</p><button className={primary} onClick={() => act(() => changeDemo((s) => swapStub(s, symbol, Number(qty), side)), "Demo swap complete.")}>{side === "buy" ? "Buy demo stock" : "Sell demo stock"}</button>{feedback}</section></>;
}
