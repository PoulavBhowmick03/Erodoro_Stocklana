# erodoro — web

Next.js 16 (App Router, Turbopack) + Tailwind 4.

The visual UI is adapted from `erodoro-base` (source revision `6a09954`).
Wallets, canonical market discovery, Manifest orders, Pyth settlement and
MagicBlock execution remain Solana integrations.

- `/` — editorial landing page and live strategy discovery.
- `/earn` — stock, listed terms and premium selection; hands a draft to the
  existing Solana trading ticket for review.
- `/app`, `/trade/markets` — market filters, favorites and the live order book.
- `/portfolio` — positions, open orders, execution balances and wallet tokens.
- `/faucet` — the existing devnet asset workflow in the copied page layout.
- `/auctions`, `/swap`, `/market-rip`, `/rewards` — copied presentation with
  explicit unavailable/inactive states. There are no corresponding Solana
  auction, swap, Rip or rewards integrations; these pages cannot submit those
  actions. `/buy` and `/sell` redirect to the appropriate swap view.

The app prerenders to `out/` for static hosting. No contract deployment is
required by this UI change.

```sh
pnpm install
pnpm dev                 # http://localhost:3000
pnpm build               # produces out/
pnpm test:unit
pnpm test:tour
pnpm test:flows
pnpm test:ui-copy         # nine routes, both themes, mobile and desktop
```

If the environment prevents Turbopack's internal worker from binding a port,
run `pnpm prebuild && pnpm exec next build --webpack`. Browser suites serve
`out/` locally and replay recorded Solana responses, including the Cloudflare
RPC proxy. They pin the recorded date so expired fixtures stay deterministic.
`SHOTS=/tmp/erodoro-ui-shots pnpm test:ui-copy` saves screenshots.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_MAINNET_RPC_URL` | none | Dedicated Mainnet RPC; required for the Mainnet build |
| `NEXT_PUBLIC_NETWORK` | `devnet` | Build target; the RPC genesis must match before the app mounts |
| `NEXT_PUBLIC_EPHEMERAL_RPC_URL` | Devnet MagicBlock | Rollup endpoint; required explicitly on Mainnet |
| `NEXT_PUBLIC_ROLLUP_VALIDATOR` | discovered on Devnet | Expected validator identity; required on Mainnet |
| `NEXT_PUBLIC_*_PROGRAM_ID` | checked IDLs on Devnet | Per-deployment addresses; required on Mainnet |
| `NEXT_PUBLIC_QUOTE_MINT` | demo USDC / Circle USDC | Deployment-wide Manifest quote mint |

Local devnet development starts on Solana's public endpoint and fails over to
the Cloudflare `/rpc` Worker for rate limits and temporary transport failures.
The production build uses that route directly. In both cases Helius is backed
by the `HELIUS_API_KEY` Worker secret, so the provider credential is not shipped
to browsers. Mainnet builds use `web/.env.mainnet.example` and fail before
compilation when required production values are missing.

## Deploy

`next.config.ts` sets `output: "export"`, so `pnpm build` emits plain static
files to `web/out` — 49 of them, no server, no Next.js runtime adapter.

### Cloudflare

Live at **https://erodoro-protocol.hypersettle.workers.dev**

The Worker name in `wrangler.jsonc` must match the existing service
(`erodoro-protocol`) — a different name silently creates a second Worker
rather than updating the deployed one.

Deploying by hand from a checkout:

```sh
pnpm build && npx wrangler deploy
```

`wrangler.jsonc` points the assets binding at `web/out` and runs the Worker first
only for `/rpc`. Upload the runtime credential with
`npx wrangler secret put HELIUS_API_KEY`; do not add it to `vars`.
In the Workers Builds settings:

| Setting | Value |
| --- | --- |
| Build command | `pnpm build` |
| Deploy command | `npx wrangler deploy` |

**The build command is the part that is easy to miss.** With it empty,
Cloudflare installs the repo root's dependencies — which are the Anchor test
harness, not the frontend — and then `wrangler deploy` fails with *"Could not
detect a directory containing static files"*, because nothing ever built
`web/out`.

### Anywhere else

Either works — pick whichever the platform makes easier.

**From the repo root** (nothing to configure beyond the output path). The root
`package.json` delegates `build`, `dev` and `start` into this directory:

| Setting | Value |
| --- | --- |
| Root directory | *(repo root)* |
| Build command | `pnpm build` |
| Output directory | `web/out` |

**From `web/`:**

| Setting | Value |
| --- | --- |
| Root directory | `web` |
| Build command | `pnpm build` |
| Output directory | `out` |

On Vercel the second form needs no build command at all — setting the root
directory to `web` is enough.

Any static host works: point it at `web/out`. Nothing here needs a server.

## Theme

Light is the default and the product's identity. Dark is opt-in from the
control in the header, stored in `localStorage` under `erodoro.theme`, and
applied by an inline script in `app/layout.tsx` before the first paint — the
site is a static export, so the server cannot know the choice, and reading it in
an effect would flash the wrong palette on every load.

Every colour is a `--c-*` token in `app/globals.css`, re-pointed once per theme.
Components use the Tailwind `--color-*` names and never a raw hex, which is what
lets one block swap the whole palette. Two tokens exist specifically because a
single value cannot serve both themes:

| Token | Why |
| --- | --- |
| `--color-ink` | The label *on* a filled button. White on dark-theme's bright mint is 2.3:1. |
| `--color-accent-ink` | The brand terracotta as small text. At fill strength it is 3.4:1 on cream. |

Every foreground/background pair in the shipped UI clears WCAG AA, verified by
`pnpm test:audit` rather than by eye.

## Verifying the integration

Two checks, because a wrong account name or seed produces a plausible-looking
transaction that only fails when somebody signs it.

```sh
pnpm check:accounts   # every account map in lib/actions.ts against the IDLs
pnpm check:pdas       # the PDA derivations against real devnet accounts
```

`check:accounts` runs automatically before every build, so refreshing the IDLs
after a program change surfaces a renamed account immediately. `check:pdas`
needs network, so it stays manual.

## Interface tests

```sh
pnpm test:ux          # everything below, against a fresh build
pnpm test:unit        # source-level policy: labels, ordering, retired copy
pnpm test:tour:build  # information architecture, in a browser
pnpm test:audit       # usability of the result, in a browser
```

The last two are complementary. `tour.spec.mjs` asserts the app is arranged the
way we meant. `ux-audit.spec.mjs` asserts that arrangement is usable: it walks
every route in both themes at desktop and phone widths, clicks every control it
can reach, and fails on a page error, a hydration mismatch, a horizontal
overflow, a control clipped by the viewport, text below the AA contrast floor,
or a disabled control that does not say why it is disabled.

That last rule is worth keeping. A greyed-out button with no explanation is
indistinguishable from a broken one, and it is the most common way a working
app looks broken.

`ux-audit.spec.mjs` also runs axe on every route in both themes. The two are
complementary: axe knows the standards, and the custom checks know this product
— a clipped control, an unexplained disabled state, and the exact contrast of
our own theme tokens are all things a generic engine cannot judge. Both suites
share one static-export server (`tests/static-server.mjs`), which is where the
`.txt` content type lives; served wrong, every in-app navigation silently
degrades to a full page load and client state resets mid-flow.

### Deterministic journeys

`flows.spec.mjs` covers whole journeys — a seller short of the claim, a buyer
short of cash and the funding detour, a rejected wallet approval — against a
**recorded** chain, so it needs no network and gives the same answer every run.

Recording once and replaying was the only honest option. Hand-building Manifest
market accounts would mean writing a second, unverified implementation of a
binary layout the SDK is the only real authority on: a fixture that decodes
wrong proves nothing, and one that needs hand-editing whenever the layout moves
gets deleted within a month. The fixtures are real encoded accounts and the
decode path under test is the production one.

```sh
pnpm test:flows     # replay (offline, deterministic)
pnpm record:flows   # re-record against devnet, then commit tests/fixtures/
```

Two details make replay work, and both were found by it failing:

- **Writes are keyed by method, not parameters.** `sendTransaction` and
  `simulateTransaction` carry a serialized transaction with a fresh blockhash
  and signature every run, so keying on parameters means a recorded write can
  never match on replay.
- **Responses are sequenced per key.** The same request legitimately returns
  different answers over time — a market account before and after an order —
  so each key holds its responses in order. Past the end the last one repeats,
  which is the right steady state for a page that keeps polling.

Replay also asserts that nothing fell through to the network: a request with no
recorded answer is reported and fails the run, rather than quietly hitting
devnet and passing.

Failure injection goes through the same handler rather than a second route,
because the method being injected on lives in the request body and a URL matcher
cannot select it. Each way an order can fail is asserted to be reported as
itself: a rejection is not an error, a program rejection reaches the user as the
program's own reason rather than an instruction code, an expired lifetime and a
rate-limited endpoint are both retryable unchanged, and a transaction the
program would reject offers a restart rather than re-sending something identical
and doomed.

**Every deterministic scenario resolves before confirmation, and that is a
limit rather than an oversight.** `confirmTransaction` resolves over a WebSocket
subscription, which HTTP route interception cannot replay. The outcomes that
need a confirmed transaction — a projection that never arrives, a draft clearing
after placement, a fill classified as rested or filled — are covered by unit
tests over the same pure functions, and were each verified against live devnet
when they were built.

## Capabilities

What the app offers is decided by `lib/capabilities.ts`, from evidence rather
than from the configured network name. A devnet build can point at a cluster
where the programs are absent, and a mainnet build must not render a
return-to-wallet control for an exit path that has never been executed against
the deployed binaries.

`custody.exit` is the one to understand. It requires all of: the exit interface
deployed under the configured program id, the deployed trading binaries
reproduced and pinned, and a public commit/exit/claim actually executed and
proved to conserve balances. The last two are release facts the browser cannot
observe, so they are supplied by configuration and default to false — a missing
variable must never read as "yes, that was done".

| Variable | Meaning |
| --- | --- |
| `NEXT_PUBLIC_TRADING_BINARIES_PINNED` | The deployed Manifest and e-token binaries were reproduced and pinned |
| `NEXT_PUBLIC_CUSTODY_EXIT_PROVEN` | A public commit, exit and L1 claim completed with balances conserved |

When a capability is withheld the UI still shows custody and balances honestly;
it just does not offer a control that cannot succeed, and it says why.

## IDLs

`lib/idl/*.json` are copied from `target/idl/` and carry their own program
addresses, so there is no address list to keep in sync. After any interface
change:

```sh
make idl && cp target/idl/*.json web/lib/idl/
```

## House rules

**Never imply a floor.** The product caps upside; it does not protect
downside. Copy like "protected", "safe", "hedged" or "insured" is factually
wrong, and the first reader to open the contract will say so publicly. The risk
banner on both routes stays.

**No invented metrics.** There is no production TVL or Mainnet deployment. The
status list says exactly that and should keep saying it until it changes.

**List series from the factory registry only.** Creation is permissionless —
anyone can open a series naming themselves as admin. `useSeries` reads
`SeriesRecord` for this reason; never switch it to enumerating the `series`
program's accounts at large.
