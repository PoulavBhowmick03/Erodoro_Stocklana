import Link from "next/link";
import { Nav } from "@/components/nav";
import { PayoffCalculator } from "@/components/payoff-calculator";
import { HeroArt } from "@/components/hero-art";
import { Reveal } from "@/components/reveal";
import { Showcase } from "@/components/showcase";
import { Ticker } from "@/components/ticker";
import { VerifyPanel } from "@/components/verify-panel";
import { IS_DEVNET } from "@/lib/network-config";

const GITHUB = "https://github.com/guha-rahul/erodoro-protocol";
const ACCESS = GITHUB + "/issues/new?labels=access&title=Request%20early%20access";

export default function Landing() {
  return (
    <>
      <Nav />
      <main className="editorial relative flex-1">
        <HeroBand />
        <Statement />
        <ProtocolStrip />
        <TheSplit />
        <Payoff />
        <BuyingN />
        <Showcase />
        <Risk />
        <VerifyPanel />
        <Faq />
      </main>
      <Footer />
      <ClosingBand />
    </>
  );
}

/**
 * The band above everything.
 *
 * Two ticker strips bounding a full-bleed still, borrowed from the editorial
 * protocol sites this page is trying to stand next to. What sits in the strips
 * is the difference: those run a token price, and this runs the deployment,
 * because there is no token and a number nobody can check is worth less than
 * no number at all.
 *
 * The caption sits in a solid block rather than floating over the photograph.
 * Partly because the art is authored greyscale and tinted per theme, so there
 * is no one text colour that reads against it in both -- and partly because
 * contrast over an image cannot be measured, by our audit or by anyone else.
 */
function HeroBand() {
  return (
    <section id="product" className="scroll-mt-20">
      <Ticker />
      <div className="bg-panel relative h-[46vh] max-h-[32rem] min-h-[19rem] overflow-hidden">
        <div className="absolute inset-0">
          <HeroArt />
        </div>
        {/* The wordmark set into the photograph rather than on top of it.
            `difference` on the layer and `overlay` on the type is what lets it
            take the engraving's own tone instead of sitting over it as a
            sticker -- and it needs no second colour for the dark theme. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center mix-blend-difference"
        >
          <span className="hero-wordmark">erodoro</span>
        </div>
        <div className="ink-band absolute bottom-0 left-0 max-w-[38rem] px-6 py-5 sm:px-10 sm:py-7">
          <p className="display-3">
            {IS_DEVNET ? "This is a devnet preview." : "Read the risks before trading."}
          </p>
          <p className="text-muted prose-editorial mt-2.5 text-[0.9375rem]">
            {IS_DEVNET
              ? "Unaudited, with no real-value assets. Everything below is deployed and checkable, and nothing here is a claim about a product that ships."
              : "Erodoro caps upside. It does not protect against a fall in the collateral."}
          </p>
        </div>
      </div>
      <Ticker />
    </section>
  );
}

/**
 * The one sentence someone actually reads, at the size that admits it.
 *
 * Not wrapped in the scroll reveal the statements below use: this is above the
 * fold on every viewport, so it is never scrolled into view and a reveal would
 * either never run or run before anyone could see it.
 */
function Statement() {
  return (
    <section className="border-line border-b">
      <div className="mx-auto grid max-w-6xl gap-12 px-6 py-16 sm:py-24 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-end">
        <div>
          <h1 className="display-1 max-w-[15ch] text-balance">
            Set your strike. Sell the upside.
          </h1>
          <p className="text-muted prose-editorial mt-8 max-w-[52ch] text-lg text-pretty">
            Lock an eligible tokenized equity, choose a strike and expiry, then
            offer the upside claim for USDC. You keep the capped equity claim
            below the strike.
          </p>

          <div data-hero-actions className="mt-10 flex flex-wrap items-center gap-3">
            {/* Square, hairline, no shadow. A rounded button reads as software
                chrome; this page is meant to read as print. */}
            <Link
              href="/app"
              data-cta
              className="bg-accent hover:bg-text text-ink label-mono inline-flex items-center gap-3 px-6 py-3.5 tracking-[0.1em] uppercase transition-colors"
            >
              {IS_DEVNET ? "Try on devnet" : "Open markets"} <span aria-hidden>↗</span>
            </Link>
            <a
              href={ACCESS}
              data-cta
              className="border-text hover:bg-text hover:text-bg label-mono inline-flex items-center gap-3 border px-6 py-3.5 tracking-[0.1em] uppercase transition-colors"
            >
              Request early access
            </a>
            <Link
              href="#payoff"
              className="text-muted hover:text-accent-ink prose-editorial px-2 py-3 text-[0.9375rem] underline underline-offset-4 transition-colors"
            >
              See how settlement works
            </Link>
          </div>
        </div>

        {/* The stack, named rather than badged. These are four dependencies a
            reader can go and verify, not partners who endorsed anything. */}
        <div className="lg:pb-2">
          <p className="kicker">Built on</p>
          <ul className="border-line mt-5 grid grid-cols-2 border-t border-l">
            {[
              ["Solana", "Settlement and custody"],
              ["MagicBlock", "Live order execution"],
              ["Manifest", "The order book"],
              ["Pyth", "Settlement price"],
            ].map(([name, role]) => (
              <li key={name} className="border-line hover:bg-panel border-r border-b p-5 transition-colors">
                <span className="display-3 block text-[1.15rem] tracking-[0.06em] uppercase">
                  {name}
                </span>
                <span className="text-dim prose-editorial mt-1.5 block text-[0.8125rem]">{role}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function ProtocolStrip() {
  return (
    <div className="border-line border-b">
      <div className="mx-auto grid max-w-6xl border-l px-0 sm:grid-cols-3">
        {[
          ["Settlement", "Solana"],
          ["Execution", "MagicBlock"],
          ["Pricing", "Visible limit orders"],
        ].map(([label, value]) => (
          <div key={label} className="border-line border-r border-b px-6 py-6 sm:border-b-0">
            <div className="kicker">{label}</div>
            <div className="display-3 mt-2">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const STEPS = [
  {
    n: "01",
    title: "Lock",
    kicker: "One deposit",
    body: (
      <>
        Deposit an eligible tokenized equity and choose a strike and expiry. Erodoro
        creates equal amounts of <Em>P</Em> and <Em>N</Em>.
      </>
    ),
  },
  {
    n: "02",
    title: "Sell N",
    kicker: "Order book",
    body: (
      <>
        <Em>N</Em> receives the value above the strike at expiry. Offer N for USDC
        through the order book. You receive USDC only if the order fills.
      </>
    ),
  },
  {
    n: "03",
    title: "Settle",
    kicker: "Anyone can call it",
    body: (
      <>
        After expiry, anyone can trigger settlement using the market&rsquo;s predefined
        Pyth feed and settlement window. The caller cannot substitute another price.
      </>
    ),
  },
];

/**
 * How it works, given the room it needs.
 *
 * The card anatomy is the borrowed part: a short headline at the top, then
 * deliberate empty space, then the kicker and the body sitting at the bottom
 * edge. The gap is doing work -- it is what stops three paragraphs in three
 * boxes from reading as a feature grid.
 */
function TheSplit() {
  return (
    <section id="how" className="border-line scroll-mt-20 border-b">
      <div className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
        <p className="kicker">The split</p>
        <Reveal
          as="h2"
          text="One share becomes two claims. You decide which one to keep."
          className="display-2 mt-5 max-w-[20ch]"
        />

        <div className="border-line mt-14 grid border-t border-l sm:grid-cols-3">
          {STEPS.map((step) => (
            <div
              key={step.n}
              className="border-line hover:bg-panel flex min-h-[18rem] flex-col border-r border-b p-7 transition-colors sm:p-8"
            >
              <div className="flex items-start justify-between gap-4">
                <span className="kicker text-accent-ink">{step.n}</span>
                <span className="kicker">{step.kicker}</span>
              </div>
              <h3 className="display-3 mt-7">{step.title}</h3>
              <p className="text-muted prose-editorial mt-4 flex-1 text-[0.9375rem]">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Risk() {
  return (
    <section id="risk" className="ink-band scroll-mt-20">
      <div className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
        <p className="kicker">Know the risks</p>
        <Reveal
          as="h2"
          text="It caps what you gain. It does not cushion what you lose."
          className="display-2 mt-5 max-w-[19ch]"
        />
        <div className="mt-12 grid gap-10 md:grid-cols-2">
          <div>
            <h3 className="display-3">You still bear the downside</h3>
            <p className="text-muted prose-editorial mt-3 text-[0.9375rem]">
              If the collateral falls, P falls with it. The USDC received for N is the only offset.
            </p>
          </div>
          <div>
            <h3 className="display-3">Issuer controls still apply</h3>
            <p className="text-muted prose-editorial mt-3 text-[0.9375rem]">
              Some Token-2022 assets give an issuer a permanent delegate that can move collateral.
              A short vault causes the same proportional haircut for every redemption.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/** `mark` names the two rows that give the rest of the column meaning: where
 *  the share started, and where the cap bites. Without them $250 is a number
 *  with no sign. */
const ROWS: [string, string, string, string?][] = [
  ["$250", "$250", "$0"],
  ["$400", "$400", "$0", "start"],
  ["$500", "$500", "$0", "strike"],
  ["$600", "$500", "$100"],
  ["$1000", "$500", "$500"],
];

function Payoff() {
  return (
    <Section id="payoff" title="The payoff">
      <div id="n" className="border-line mb-8 grid border-y sm:grid-cols-2 sm:divide-x sm:divide-[var(--color-line)]">
        <div className="py-6 sm:pr-8">
          <div className="text-p font-mono text-[0.8125rem] tracking-[0.12em] uppercase">
            P · Capped equity claim
          </div>
          <p className="text-muted mt-2 text-sm">Receives the collateral value up to the strike.</p>
          <p className="mt-4 font-mono text-sm">P = min(S, K)</p>
        </div>
        <div className="border-line border-t py-6 sm:border-t-0 sm:pl-8">
          <div className="text-n font-mono text-[0.8125rem] tracking-[0.12em] uppercase">
            N · Upside claim
          </div>
          <p className="text-muted mt-2 text-sm">Receives only the value above the strike.</p>
          <p className="mt-4 font-mono text-sm">N = max(S − K, 0)</p>
        </div>
      </div>
      <p className="text-dim mb-6 text-sm">
        S is the settlement price and K is the strike. P and N together represent the locked collateral.
      </p>
      <PayoffCalculator />

      {/* Focusable because it scrolls: on a narrow screen this table is wider
          than the page, and without a tab stop there is no way to reach the
          columns on the right from a keyboard. */}
      <div
        className="mt-10 overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Payout at expiry by settlement price"
      >
        <table className="w-full min-w-[26rem] text-[0.95rem]">
          <thead>
            <tr className="border-line border-b">
              <Th>At expiry</Th>
              <Th>P · Capped equity claim</Th>
              <Th>N · Upside claim</Th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([at, p, n, mark]) => (
              <tr key={at} className="border-line-soft border-b">
                <td className="text-muted py-3 pr-4 font-mono tabular-nums">
                  {at}
                  {mark && (
                    <span className="text-dim ml-2 font-sans text-[0.8125rem] tracking-[0.1em] uppercase">
                      {mark}
                    </span>
                  )}
                </td>
                <td className="text-p py-3 pr-4 font-mono tabular-nums">{p}</td>
                <td className="text-n py-3 font-mono tabular-nums">{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-dim mt-4 text-sm">
        One tokenized equity worth $400 when the position is created. Strike: $500.
        Values exclude any USDC received from selling N.
      </p>
    </Section>
  );
}

/** Decision questions first, implementation detail second. Native <details>
 * keeps the section usable before hydration and accessible by default. */
const FAQ: [string, React.ReactNode][] = [
  [
    "What can each side lose?",
    <>
      A seller keeps the collateral&rsquo;s full downside and gives up gains above the strike;
      the USDC received for <Em>N</Em> is the only offset. An <Em>N</Em> buyer can
      lose the entire purchase price, but there is no margin or liquidation and
      nothing more to owe.
    </>,
  ],
  [
    "How are orders priced and filled?",
    <>
      The market uses limit orders with price-time priority. A trade fills at the
      resting maker&rsquo;s price and may fill only part of the requested size. An
      unmatched order remains open until another trader takes it or its owner cancels it.
    </>,
  ],
  [
    "Is an order guaranteed to execute?",
    <>
      No. Execution requires a matching order and enough deposited balance on both
      sides. A displayed bid or ask can be filled or cancelled before your transaction
      lands, and thin markets may have a wide spread or no liquidity.
    </>,
  ],
  [
    "Can I exit before expiry?",
    <>
      If you hold equal amounts of <Em>P</Em> and <Em>N</Em>, you can merge them and
      unlock the collateral before expiry. If you hold only one claim, an early exit
      depends on selling it through the order book at the available market price.
    </>,
  ],
  [
    "Why does Erodoro use an order book?",
    <>
      A price-time order book lets traders choose a limit price instead of accepting a
      pool quote. Orders can fill partially, and visible bids and asks make the available
      liquidity and spread explicit.
    </>,
  ],
  [
    "What happens at expiry?",
    <>
      Trading stops. After the configured delay, anyone can settle the market using
      the approved Pyth price for its expiry window. The collateral is split into
      the <Em>P</Em> and <Em>N</Em> pools, and holders redeem their claim from the
      corresponding pool.
    </>,
  ],
  [
    "What do I receive at redemption?",
    <>
      P and N redeem for proportional amounts of the locked tokenized-equity collateral,
      not USDC. The oracle price determines how that collateral is divided between the two pools.
    </>,
  ],
  [
    "What fees does Erodoro charge?",
    <>
      Current V1 markets configure the protocol split fee at zero, and the order-book
      program charges no trading or cancellation fee. Solana network fees can still
      apply to L1 actions such as locking, unlocking, settlement, and redemption.
    </>,
  ],
  [
    "What does powered by MagicBlock mean?",
    <>
      Order placement, matching, and cancellation run on a delegated MagicBlock
      execution account. Collateral custody and settlement remain on Solana. If the
      live execution market is unavailable, trading becomes read-only; orders are not
      silently rerouted to a different venue.
    </>,
  ],
  [
    "Is this live and audited?",
    <>
      {IS_DEVNET
        ? "No. This is a devnet implementation, not a mainnet product. It has not received an external security audit, and the MagicBlock and ephemeral-token deployment path still requires production validation."
        : "Mainnet access is enabled only after the configured programs, issuer assets, oracle, and MagicBlock deployment pass the release gates. Check each market's issuer and risk details before trading."}
    </>,
  ],
];

/**
 * Numbered, full width, one per row.
 *
 * Still a native <details>: the numbering and the hover tint are presentation,
 * and giving up keyboard support and pre-hydration usability to get them would
 * be a bad trade.
 */
function Faq() {
  return (
    <section id="faq" className="border-line scroll-mt-20 border-t">
      <div className="mx-auto max-w-6xl px-6 pt-16 sm:pt-24">
        <p className="kicker">Questions</p>
        <Reveal as="h2" text="Got questions? Find answers." className="display-2 mt-5 max-w-[14ch]" />
      </div>
      <div className="border-line mx-auto mt-12 max-w-6xl border-t">
        {FAQ.map(([question, answer], index) => (
          <details key={question} className="border-line group border-b">
            <summary className="hover:bg-panel marker:content-none flex cursor-pointer list-none items-start gap-6 px-6 py-6 transition-colors">
              <span className="kicker text-accent-ink w-8 shrink-0 pt-1.5 tabular-nums">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="display-3 flex-1 text-[1.15rem]">{question}</span>
              <span
                aria-hidden
                className="text-dim shrink-0 pt-1 text-lg transition-transform duration-200 group-open:rotate-45"
              >
                +
              </span>
            </summary>
            <p className="text-muted prose-editorial max-w-[68ch] px-6 pb-7 pl-[3.5rem] text-[0.9375rem]">
              {answer}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

const N_SIDE: [string, React.ReactNode][] = [
  [
    "Receives",
    <>
      Everything above the strike. Below it, <Em>N</Em> expires worthless.
    </>,
  ],
  ["Maximum loss", <>The amount paid for N. There are no margin calls, liquidations or additional amounts to owe.</>],
  ["Liquidity risk", <>Exiting before expiry requires another trader. Thin markets may have wide spreads or no available buyer.</>],
  ["Fixed expiry", <>N settles once on a specified date. It is not a perpetual position and has no funding rate.</>],
];

/**
 * The other side of the trade.
 *
 * The rest of this page is written for the person locking a share. Nothing
 * happens unless somebody buys what they are selling, and that side had one
 * line in step 2 — a strange emphasis for the half that is actually scarce.
 */
function BuyingN() {
  return (
    <Section title="For upside buyers">
      <div className="border-line grid border-t border-l sm:grid-cols-2 lg:grid-cols-4">
        {N_SIDE.map(([label, body]) => (
          <div key={label} className="border-line border-r border-b p-5">
            <h3 className="text-n kicker">{label}</h3>
            <p className="text-muted prose-editorial mt-3 text-[0.9375rem]">{body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Footer() {
  return (
    <footer className="border-line border-t">
      <div className="mx-auto grid max-w-6xl gap-12 px-6 py-16 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-20">
        <div>
          {/* Not a heading: `tour.spec` resolves the hero by its accessible
              name, and a second element with a near-identical one would make
              that locator ambiguous rather than wrong -- which is the harder
              kind of failure to read. */}
          <p className="display-2 max-w-[12ch]">Keep the share. Sell the ceiling.</p>

          <div className="mt-12 grid grid-cols-2 gap-8 sm:grid-cols-4">
            {[
              ["Product", [["Markets", "/app"], ["Portfolio", "/portfolio"], ["Payoff", "#payoff"]]],
              ["Protocol", [["How it works", "#how"], ["Risks", "#risk"], ["Deployed", "#verify"]]],
              ["Source", [["GitHub", GITHUB], ["Docs", GITHUB + "#readme"]]],
              ["Questions", [["FAQ", "#faq"], ["Request access", ACCESS]]],
            ].map(([heading, links]) => (
              <div key={heading as string}>
                <p className="kicker">{heading as string}</p>
                <ul className="mt-4 space-y-2.5">
                  {(links as [string, string][]).map(([label, href]) => (
                    <li key={label}>
                      {href.startsWith("http") ? (
                        <a href={href} className="text-muted hover:text-accent-ink label-mono underline decoration-1 underline-offset-4 opacity-80 transition-all hover:opacity-100">
                          {label}
                        </a>
                      ) : (
                        <Link href={href} className="text-muted hover:text-accent-ink label-mono underline decoration-1 underline-offset-4 opacity-80 transition-all hover:opacity-100">
                          {label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="border-line lg:border-l lg:pl-20">
          <p className="display-3">Be early on the strike.</p>
          <p className="text-muted prose-editorial mt-3 max-w-[36ch] text-[0.9375rem]">
            Access is handled in the open, on the repository. Opening an issue is
            the whole process — there is no list and nothing to unsubscribe from.
          </p>
          {/* Styled like the newsletter field this borrows from, but honestly a
              link: the site is a static export with no server to post to, and a
              form that silently discards what someone typed is worse than none. */}
          <a
            href={ACCESS}
            data-cta
            className="border-text hover:bg-text hover:text-bg label-mono group mt-7 flex items-center justify-between gap-4 border px-5 py-3.5 tracking-[0.1em] uppercase transition-colors"
          >
            <span>Request early access</span>
            <span aria-hidden className="text-dim group-hover:text-accent-ink transition-colors">
              ↘
            </span>
          </a>
        </div>
      </div>

      <div className="border-line border-t">
        <div className="text-dim mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-6 text-sm">
          <span className="display-3 text-text tracking-[0.06em] uppercase">erodoro</span>
          <span className="font-mono text-[0.75rem] tracking-[0.1em] uppercase">
            Solana settlement · MagicBlock execution
          </span>
        </div>
      </div>
    </footer>
  );
}

/**
 * The closing band: the payoff, drawn once more at full width.
 *
 * The page this borrows from ends on a large piece of line art. This is the
 * same gesture with the one drawing erodoro already owns — the shape of the
 * thing being sold, flat below the strike and rising after it.
 */
function ClosingBand() {
  return (
    <div aria-hidden className="border-line text-text/12 overflow-hidden border-t">
      <svg viewBox="0 0 1200 200" className="h-24 w-full sm:h-36" preserveAspectRatio="none">
        <defs>
          <pattern id="closing-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M24 0H0v24" fill="none" stroke="currentColor" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="1200" height="200" fill="url(#closing-grid)" />
        <path
          d="M0 150H620L1200 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="text-accent/35"
        />
        <path d="M620 0V200" stroke="currentColor" strokeWidth="1.5" strokeDasharray="6 8" />
      </svg>
    </div>
  );
}

/* --- small building blocks --- */

function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="border-line scroll-mt-20 border-t">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-16 sm:py-20 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-12">
        <h2 className="eyebrow lg:pt-1">{title}</h2>
        {/* A grid item defaults to `min-width: auto`, so the payoff table's
            26rem minimum widened this whole column past the viewport and put a
            horizontal scrollbar on the page. The table has its own
            `overflow-x-auto`; this lets that container actually be narrower
            than the table inside it. */}
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-dim py-2.5 pr-4 text-left text-[0.8125rem] font-medium tracking-[0.1em] uppercase">
      {children}
    </th>
  );
}

function Em({ children }: { children: React.ReactNode }) {
  return <span className="text-text font-medium">{children}</span>;
}
