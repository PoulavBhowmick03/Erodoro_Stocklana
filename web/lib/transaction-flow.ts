import type { SendPhase, TransactionTarget } from "./transaction-lifecycle";

/**
 * One user intention, and every approval it actually requires.
 *
 * A trader submits one economic action. Whether that action needs one wallet
 * approval or four depends on chain state they cannot see: whether they hold
 * enough of the claim, whether their balance has been projected into the
 * execution session yet, whether they already have a seat. The old UI resolved
 * those inside the submit handler and reported them through a single
 * `TxStatus`, so the second and third wallet prompts arrived unannounced and an
 * order that failed halfway looked like an order that failed.
 *
 * The model here is deliberately two pieces:
 *
 *   - `planSteps` is a pure function from observed chain state to the ordered
 *     steps required. It is re-run on every retry, which is what makes
 *     "retry only the incomplete step" fall out for free: a prerequisite that
 *     succeeded is no longer required, so it is no longer planned.
 *   - `FlowState` records what happened to the steps that were planned.
 *
 * Nothing here derives progress from a stored cursor. A cursor survives a
 * failure that changed the chain, and then replays a transaction that already
 * landed.
 */

/** Why a step exists. Drives both its label and whether it prompts a wallet. */
export type FlowStepKind =
  /** Lock collateral to mint P and N. */
  | "mint"
  /** Move balance from the Solana wallet into the execution session. */
  | "delegate"
  /** Wait for the delegated balance to appear. Not an approval. */
  | "project"
  /** Claim a seat, deposit and place the order. */
  | "order"
  /** Cancel a resting order. */
  | "cancel";

export type FlowStep = {
  kind: FlowStepKind;
  target: TransactionTarget;
  /** Whether this step puts a signature request in front of the user. */
  approval: boolean;
  label: string;
  /** The concrete amount this step acts on, when there is one. */
  detail?: string;
};

/**
 * How a step ended.
 *
 * The distinctions are the ones a user can act on. "Cancelled" is not a
 * failure and must not be styled as one — they chose it. "Expired" and
 * "rpc" are both worth retrying unchanged. "Simulation" means the transaction
 * would never have landed, so retrying it unchanged is pointless, and the
 * message carries the program's own explanation.
 */
export type FlowFailure =
  | { kind: "cancelled" }
  | { kind: "simulation"; message: string }
  | { kind: "expired" }
  | { kind: "rpc"; message: string }
  | { kind: "projection-timeout" }
  | { kind: "error"; message: string };

export type StepState =
  | { status: "pending" }
  | { status: "active"; phase: SendPhase; signature?: string }
  | { status: "done"; signature?: string }
  | { status: "failed"; failure: FlowFailure };

export type FlowState = {
  /** Stable identity for the intention, so a retry is recognisably the same one. */
  action: string;
  steps: FlowStep[];
  /** Parallel to `steps`. */
  states: StepState[];
  /**
   * Set when the flow stopped short and the user has to decide what happens
   * next. A flow that completed every step leaves this undefined.
   */
  halted?: { at: number; failure: FlowFailure };
  /**
   * Set when a prerequisite succeeded and the remaining work needs a fresh,
   * deliberate confirmation rather than an automatic continuation.
   */
  awaiting?: { at: number };
};

/** What the planner needs to observe before it can decide on the steps. */
export type FlowConditions = {
  /** How much of the claim the order is short, in whole tokens. */
  claimDeficit: number;
  /** Base atoms that must be moved into the session. */
  baseToDelegate: bigint;
  /** Quote atoms that must be moved into the session. */
  quoteToDelegate: bigint;
  /** Symbols, for labels only. */
  baseSymbol: string;
  collateralSymbol: string;
};

const amount = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: 4 });

/**
 * The steps an order requires right now.
 *
 * Order matters and is not arbitrary: collateral has to be locked before there
 * is a claim to delegate, and the balance has to be projected before an order
 * against it can rest. Each step is included only when the state it fixes is
 * actually observed, so a trader who is already set up sees exactly one
 * approval and is told so.
 */
export function planOrderSteps(conditions: FlowConditions): FlowStep[] {
  const steps: FlowStep[] = [];

  if (conditions.claimDeficit > 0) {
    steps.push({
      kind: "mint",
      target: "solana",
      approval: true,
      label: "Lock collateral",
      detail: `${amount(conditions.claimDeficit)} ${conditions.collateralSymbol}`,
    });
  }

  const delegating =
    conditions.baseToDelegate > BigInt(0) || conditions.quoteToDelegate > BigInt(0);
  if (delegating) {
    steps.push({
      kind: "delegate",
      target: "solana",
      approval: true,
      label: "Move balance to live execution",
    });
    steps.push({
      kind: "project",
      target: "magicblock",
      approval: false,
      label: "Confirm the live balance",
    });
  }

  steps.push({
    kind: "order",
    target: "magicblock",
    approval: true,
    label: "Place the order",
  });

  return steps;
}

/** Every step starts pending. */
export function beginFlow(action: string, steps: FlowStep[]): FlowState {
  return { action, steps, states: steps.map(() => ({ status: "pending" })) };
}

const replace = (states: StepState[], at: number, next: StepState) =>
  states.map((state, index) => (index === at ? next : state));

export function markActive(
  flow: FlowState,
  at: number,
  phase: SendPhase,
  signature?: string,
): FlowState {
  return { ...flow, states: replace(flow.states, at, { status: "active", phase, signature }) };
}

export function markDone(flow: FlowState, at: number, signature?: string): FlowState {
  return { ...flow, states: replace(flow.states, at, { status: "done", signature }) };
}

export function markFailed(flow: FlowState, at: number, failure: FlowFailure): FlowState {
  return {
    ...flow,
    states: replace(flow.states, at, { status: "failed", failure }),
    halted: { at, failure },
  };
}

/**
 * Stop after a prerequisite and wait to be told to continue.
 *
 * Minting is the case this exists for. Locking collateral is irreversible from
 * the trader's point of view and changes what they hold; chaining straight into
 * an order would mean one click produced two unrelated approvals, the second of
 * which they never separately agreed to.
 */
export function markAwaiting(flow: FlowState, at: number): FlowState {
  return { ...flow, awaiting: { at } };
}

/** How many wallet approvals remain, from `at` onwards. */
export function approvalsRemaining(flow: FlowState, at = 0): number {
  return flow.steps.filter((step, index) => index >= at && step.approval).length;
}

/**
 * The sentence shown before the first approval.
 *
 * Naming the count and the destinations up front is the whole point: a second
 * unexpected wallet prompt reads as a bug, and a MagicBlock prompt arriving
 * where a user expected Solana reads as the wrong network.
 */
export function describeApprovals(steps: FlowStep[]): string {
  const approvals = steps.filter((step) => step.approval);
  if (approvals.length === 0) return "No wallet approval needed.";

  const solana = approvals.filter((step) => step.target === "solana").length;
  const magicblock = approvals.length - solana;
  const parts: string[] = [];
  if (solana > 0) parts.push(`${solana} on Solana`);
  if (magicblock > 0) parts.push(`${magicblock} on MagicBlock`);

  return approvals.length === 1
    ? `1 wallet approval, ${parts.join("")}.`
    : `${approvals.length} wallet approvals: ${parts.join(", ")}.`;
}

/** Whether anything is still in flight. Guards duplicate submission. */
export function isRunning(flow: FlowState | null): boolean {
  if (!flow) return false;
  if (flow.halted || flow.awaiting) return false;
  return flow.states.some((state) => state.status === "active");
}

/** Whether every planned step reported success. */
export function isComplete(flow: FlowState | null): boolean {
  return Boolean(flow) && flow!.states.every((state) => state.status === "done");
}

/**
 * Turn whatever went wrong into something a user can act on.
 *
 * Kept here, as a pure function of the error, so the classification is
 * unit-testable and identical everywhere. `useSend` already renders its own
 * summary of these; a composed flow needs the machine-readable form so it can
 * decide whether retrying unchanged has any chance of working.
 */
export function classifyFailure(
  error: unknown,
  helpers: {
    isRejection: (error: unknown) => boolean;
    isExpired: (error: unknown) => boolean;
    explain: (error: unknown) => string;
  },
): FlowFailure {
  if (helpers.isRejection(error)) return { kind: "cancelled" };
  if (helpers.isExpired(error)) return { kind: "expired" };

  const message = error instanceof Error ? error.message : String(error);

  // A projection that never arrived is not a transaction failure at all --
  // the delegation landed, the balance simply has not been mirrored yet.
  if (/did not appear on MagicBlock/i.test(message)) {
    return { kind: "projection-timeout" };
  }

  // Rate limiting and transport faults are worth retrying unchanged. A
  // simulation failure never is: the program already rejected it.
  if (/\b429\b|rate.?limit|fetch failed|Failed to fetch|network error|ECONNRESET|socket hang up|timed? out/i.test(message)) {
    return { kind: "rpc", message: helpers.explain(error) };
  }
  if (/simulation failed|Error Code:|Error Message:|Program log: Error:/i.test(message)) {
    return { kind: "simulation", message: helpers.explain(error) };
  }
  return { kind: "error", message: helpers.explain(error) };
}
