"use client";

/**
 * What this deployment can actually do, as observed rather than assumed.
 *
 * The app previously branched on `IS_DEVNET`, which answers "which network was
 * this built for" and nothing else. That is the wrong question in both
 * directions: a devnet build can be pointed at a cluster where the programs are
 * absent, and a mainnet build would happily render a Return-to-wallet button
 * for an exit path that has never been executed against the deployed binaries.
 *
 * A capability here is a claim about behaviour, so each one is either observed
 * from chain state or explicitly withheld. Nothing is inferred from the network
 * name alone.
 *
 * # Withheld is not the same as broken
 *
 * When a capability is unavailable the UI still shows custody and balances
 * honestly -- what is held, and where. It simply does not offer a control that
 * cannot succeed. A button that fails is worse than an absent button with an
 * explanation, because the user cannot tell whether they did something wrong.
 */
export type Capability =
  /** Books can be read and quoted. */
  | "trading.read"
  /** Orders can be placed and cancelled. */
  | "trading.write"
  /** A session can be committed and closed, releasing custody back to L1. */
  | "custody.exit"
  /** Balances released by an exit can be claimed into the Solana wallet. */
  | "custody.claim"
  /** The configured feed meets this deployment's verification bar. */
  | "oracle.acceptable"
  /** Demo assets, demo signers and the guided walkthrough exist. */
  | "demo.fixtures";

export type CapabilityState =
  | { available: true }
  | { available: false; reason: string };

export type Capabilities = Record<Capability, CapabilityState>;

/**
 * The evidence a capability decision is made from. Every field is something
 * that was actually read, so a caller cannot accidentally pass an assumption.
 */
export type CapabilityEvidence = {
  /** The verified cluster, or null while the genesis check is outstanding. */
  network: "devnet" | "mainnet-beta" | null;
  /**
   * Whether the programs this app calls are deployed and executable. Null while
   * the check is outstanding -- unknown is not the same as absent, and telling
   * someone the protocol is missing because a read timed out is a lie with a
   * support ticket attached.
   */
  programsDeployed: boolean | null;
  /** Whether at least one canonical book is delegated to a live session. */
  sessionActive: boolean;
  /**
   * Whether the deployed e-token program exposes the exit interface this app
   * would have to call. Null means it has not been checked.
   */
  exitInterfaceDeployed: boolean | null;
  /**
   * Whether the exact deployed Manifest and e-token binaries have been
   * reproduced and pinned. This cannot be observed from the browser; it is a
   * release fact, supplied by configuration.
   */
  binariesPinned: boolean;
  /**
   * Whether a public commit, exit and L1 claim has been executed against this
   * deployment and its balances proved to conserve. Also a release fact.
   */
  exitProven: boolean;
  /** The feed's minimum signature threshold, or null if unread. */
  oracleMinSignatures: number | null;
};

/**
 * Why an order cannot be placed while the book is on L1.
 *
 * The venue is named here rather than reworded downstream. `execution-policy`
 * cannot import this at runtime -- both modules are loaded directly by the test
 * runner, which needs full specifiers -- so the credit is repeated as a literal
 * and `ux-policy.test.mjs` asserts the two still agree.
 */
export const LIVE_EXECUTION_PENDING =
  "Orders become available when live execution (powered by MagicBlock) is ready.";

const YES: CapabilityState = { available: true };
const no = (reason: string): CapabilityState => ({ available: false, reason });

/**
 * Decide every capability from evidence.
 *
 * Pure, so the rules can be tested exhaustively without a cluster. The order of
 * the checks inside each capability is the order a user would want the
 * explanation in: the most fundamental missing thing first.
 */
export function deriveCapabilities(evidence: CapabilityEvidence): Capabilities {
  const verified = evidence.network !== null;

  /*
    Only a *confirmed* absence withholds anything.

    This originally treated the outstanding check as a reason to withhold, and
    the journey suite caught what that meant: one slow or unrecorded RPC call
    left the order button disabled for good, explaining itself with "has not
    been established yet". That is a worse failure than the one the check was
    added to fix -- it converts a slow read into a dead interface.

    Absence of evidence is not evidence of absence. If the programs really are
    missing, the market read fails on its own and says so; this only upgrades
    that message once it is actually known.
  */
  const read: CapabilityState = !verified
    ? no("The connected cluster has not been verified yet.")
    : evidence.programsDeployed === false
      ? no("Erodoro is not deployed on the connected cluster.")
      : YES;

  const write: CapabilityState = !read.available
    ? read
    : !evidence.sessionActive
      ? no(LIVE_EXECUTION_PENDING)
      : YES;

  const oracle: CapabilityState =
    evidence.oracleMinSignatures === null
      ? no("The settlement feed configuration has not been read yet.")
      : evidence.oracleMinSignatures <= 0
        ? no("The settlement feed accepts prices with no minimum signature threshold.")
        : YES;

  /*
    Returning custody is the capability with the most ways to be wrong and the
    worst consequence for getting it wrong: a control that appears to move
    someone's money back to their wallet and does not. Every condition below has
    to hold, and each is reported separately so the gap is nameable.
  */
  const exit: CapabilityState = !read.available
    ? read
    : evidence.exitInterfaceDeployed === null
      ? no("The deployed exit interface has not been checked on this cluster.")
      : !evidence.exitInterfaceDeployed
        ? no("The deployed programs do not expose the exit interface this would call.")
        : !evidence.binariesPinned
          ? no("The deployed trading binaries have not been reproduced and pinned.")
          : !evidence.exitProven
            ? no("A public commit, exit and claim has not been executed against this deployment.")
            : /*
                 The settlement feed is the last condition rather than an
                 unrelated one. Returning custody is the point at which a
                 position stops being a position and becomes a final amount, and
                 that amount is priced off this feed. A deployment that would
                 settle against an unsigned price has no business paying anyone
                 out, however well its exit path was proved.
              */
              !oracle.available
              ? no(`Settlement pricing is not trustworthy on this deployment. ${oracle.reason}`)
              : YES;

  const claim: CapabilityState = !exit.available
    ? exit
    : YES;

  const demo: CapabilityState =
    evidence.network === "devnet"
      ? YES
      : no("Demo assets and signers exist only on devnet.");

  return {
    "trading.read": read,
    "trading.write": write,
    "custody.exit": exit,
    "custody.claim": claim,
    "oracle.acceptable": oracle,
    "demo.fixtures": demo,
  };
}

/** Convenience for the common "can I show this control" question. */
export function can(capabilities: Capabilities, capability: Capability): boolean {
  return capabilities[capability].available;
}

/** Why not, for the cases where the answer has to be shown to someone. */
export function whyNot(
  capabilities: Capabilities,
  capability: Capability,
): string | undefined {
  const state = capabilities[capability];
  return state.available ? undefined : state.reason;
}
