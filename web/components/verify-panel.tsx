import { DEPLOYMENTS } from "@/lib/deployment-facts";
import { NETWORK } from "@/lib/network-config";

/**
 * The section that stands where a landing page usually puts social proof.
 *
 * There is no raise to announce, no users to count and no testimonials that
 * would not have to be invented. What there is, is a deployment anyone can
 * open in an explorer and check against this page -- so that is what goes here.
 *
 * Every address comes from `deployments/*.json` through the generated
 * `lib/deployment-facts.ts`, and `prebuild` fails if the two have drifted. The
 * page vouches for these addresses, so it should not be possible to redeploy
 * and quietly leave it vouching for the old ones.
 *
 * The last row is the important one. It states what does not work yet, in the
 * same typeface and the same weight as everything that does.
 */
const explorer = (address: string, cluster: string) =>
  `https://explorer.solana.com/address/${address}${cluster === "devnet" ? "?cluster=devnet" : ""}`;

export function VerifyPanel() {
  const facts = DEPLOYMENTS[NETWORK.label] ?? DEPLOYMENTS.devnet;

  return (
    <section id="verify" className="border-line scroll-mt-20 border-t">
      <div className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
        <p className="kicker">Deployed and checkable</p>
        <h2 className="display-2 mt-6 max-w-[15ch]">Don&rsquo;t take our word for it.</h2>
        <p className="text-muted prose-editorial mt-7 max-w-[58ch] text-lg text-pretty">
          Every program this page describes is live on {facts.cluster} and open in
          any explorer. The addresses below are generated from the deployment
          manifest at build time, so they cannot drift from what is actually
          running.
        </p>

        <div className="border-line mt-12 grid border-t border-l sm:grid-cols-2 lg:grid-cols-3">
          {facts.programs.map((program) => (
            <a
              key={program.key}
              href={explorer(program.address, facts.cluster)}
              target="_blank"
              rel="noreferrer"
              className="border-line hover:bg-panel group border-r border-b p-5 transition-colors"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="display-3 text-[1.15rem]">{program.label}</span>
                <span aria-hidden className="text-dim group-hover:text-accent-ink transition-colors">
                  ↗
                </span>
              </div>
              <p className="text-muted prose-editorial mt-2.5 text-[0.875rem]">{program.purpose}</p>
              <p className="text-dim label-mono mt-5 text-[0.6875rem] break-all">{program.address}</p>
            </a>
          ))}
        </div>

        <dl className="border-line grid border-l sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Cluster", facts.cluster],
            ["Genesis hash", facts.genesisHash ? `${facts.genesisHash.slice(0, 12)}…` : "—"],
            ["Books registered", String(facts.magicblock.registeredBooks)],
            ["Audit", "None. Unaudited."],
          ].map(([label, value]) => (
            <div key={label} className="border-line border-r border-b p-5">
              <dt className="kicker">{label}</dt>
              <dd className="label-mono mt-2.5 text-[0.8125rem] break-all">{value}</dd>
            </div>
          ))}
        </dl>

        {facts.magicblock.settlementExit && (
          /* The one thing on this page that says what the protocol cannot do.
             It sits in the verification section on purpose: the same block that
             invites someone to check the claims should be the block that admits
             the gap, rather than burying it in a footnote. */
          <div className="border-n/30 bg-n/8 mt-10 border p-6">
            <p className="kicker text-n">Known limitation</p>
            <p className="text-text prose-editorial mt-2.5 max-w-[70ch] text-[0.9375rem]">
              Balances moved into a live execution session cannot yet be returned
              to a Solana wallet on the public deployment. You can trade and
              cancel with them; you cannot withdraw them.
            </p>
            {/* The manifest's own words, kept verbatim underneath the plain
                summary. The summary is what a visitor needs; this is what
                someone checking the claim needs. */}
            <p className="text-dim label-mono mt-4 max-w-[80ch] text-[0.6875rem] leading-6">
              {facts.magicblock.settlementExit}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
