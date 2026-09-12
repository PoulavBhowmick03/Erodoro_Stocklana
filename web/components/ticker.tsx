import { DEPLOYMENTS } from "@/lib/deployment-facts";
import { NETWORK } from "@/lib/network-config";

/**
 * The strip that bounds the hero.
 *
 * The reference this borrows from runs a token price across it. There is no
 * token and no price, so this runs the deployment instead: which cluster, which
 * programs, how many books are live, and what is still unaudited. Every item is
 * checked into `deployments/` and generated into `lib/deployment-facts.ts` at
 * build time, which is what lets the landing route keep its most useful
 * property -- it renders with no wallet, no RPC and no request.
 *
 * Deliberately not a price, a total, or a count of anyone. `web/README.md`
 * forbids invented metrics, and a number nobody can check is worse than no
 * number: the first reader to look will find nothing behind it.
 */
const short = (address: string, n = 4) =>
  `${address.slice(0, n)}…${address.slice(-n)}`;

function items(): string[] {
  const facts = DEPLOYMENTS[NETWORK.label] ?? DEPLOYMENTS.devnet;
  const out = [facts.cluster.toUpperCase()];
  for (const program of facts.programs) {
    out.push(`${program.label.toUpperCase()} ${short(program.address)}`);
  }
  if (facts.magicblock.registeredBooks) {
    out.push(`${facts.magicblock.registeredBooks} BOOKS REGISTERED`);
  }
  if (facts.magicblock.validator) {
    out.push(`VALIDATOR ${short(facts.magicblock.validator)}`);
  }
  out.push("UNAUDITED");
  return out;
}

function Track({ entries }: { entries: string[] }) {
  return (
    <div className="flex shrink-0 items-center">
      {entries.map((entry, index) => (
        <span key={`${entry}-${index}`} className="flex items-center">
          <span className="label-mono px-5 text-[0.625rem] tracking-[0.18em] whitespace-nowrap uppercase">
            {entry}
          </span>
          <span aria-hidden className="opacity-30">
            ·
          </span>
        </span>
      ))}
    </div>
  );
}

export function Ticker() {
  const entries = items();
  return (
    <div className="ink-band overflow-hidden py-2" data-ticker>
      <div className="marquee">
        <Track entries={entries} />
        {/* The second copy exists only so the loop has no seam. Reading the
            same twenty addresses twice is not an experience worth giving a
            screen reader. */}
        <div aria-hidden>
          <Track entries={entries} />
        </div>
      </div>
    </div>
  );
}
