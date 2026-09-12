"use client";

import { NETWORK } from "@/lib/network-config";
import { sendPhaseLabel } from "@/lib/transaction-lifecycle";
import type { FlowFailure, FlowState, StepState } from "@/lib/transaction-flow";
import { approvalsRemaining, describeApprovals } from "@/lib/transaction-flow";
import { Button } from "./ui";

/**
 * One composed action, shown as the steps it actually requires.
 *
 * This replaces `TxStatus` wherever an action can need more than one approval.
 * The old single-status display could describe the transaction it was currently
 * sending but had no way to say that two more were coming, so a trader who
 * approved a delegation was surprised by an order prompt and had no way to tell
 * a half-finished flow from a failed one.
 *
 * Deliberately inline rather than a modal. The prices and quantities the user
 * is being asked to approve are on the page behind it, and covering them at the
 * moment of approval is exactly the wrong time.
 */
export function TransactionProgress({
  flow,
  onRetry,
  onContinue,
  onDismiss,
  continueLabel = "Continue",
}: {
  flow: FlowState | null;
  /** Re-plan from current chain state and resume. */
  onRetry?: () => void;
  /** Proceed past a deliberate pause. */
  onContinue?: () => void;
  onDismiss?: () => void;
  continueLabel?: string;
}) {
  if (!flow) return null;

  const halted = flow.halted;
  const awaiting = flow.awaiting;
  const done = flow.states.every((state) => state.status === "done");

  return (
    <section
      data-transaction-progress
      role="status"
      aria-live="polite"
      className={`rise-in mt-3 rounded-sm border ${
        halted
          ? halted.failure.kind === "cancelled"
            ? "border-line bg-panel-2"
            : "border-danger/35 bg-danger/8"
          : done
            ? "border-p/35 bg-p/8"
            : "border-n/30 bg-n/8"
      }`}
    >
      <ol className="divide-line-soft divide-y">
        {flow.steps.map((step, index) => (
          <li key={`${step.kind}-${index}`} className="flex items-start gap-2.5 px-3 py-2">
            <StepMark state={flow.states[index]} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-[0.8rem] font-medium">
                {step.label}
                {step.detail && (
                  <span className="text-muted font-mono text-[0.75rem]">{step.detail}</span>
                )}
                {step.approval && flow.states[index].status === "pending" && (
                  <span className="text-dim text-[0.7rem] tracking-[0.08em] uppercase">
                    {step.target === "magicblock" ? "MagicBlock" : "Solana"}
                  </span>
                )}
              </p>
              <StepDetail state={flow.states[index]} target={step.target} />
            </div>
          </li>
        ))}
      </ol>

      <Footer
        halted={halted}
        awaiting={Boolean(awaiting)}
        done={done}
        remaining={awaiting ? approvalsRemaining(flow, awaiting.at) : 0}
        steps={flow.steps}
        onRetry={onRetry}
        onContinue={onContinue}
        onDismiss={onDismiss}
        continueLabel={continueLabel}
      />
    </section>
  );
}

function Footer({
  halted,
  awaiting,
  done,
  remaining,
  steps,
  onRetry,
  onContinue,
  onDismiss,
  continueLabel,
}: {
  halted: FlowState["halted"];
  awaiting: boolean;
  done: boolean;
  remaining: number;
  steps: FlowState["steps"];
  onRetry?: () => void;
  onContinue?: () => void;
  onDismiss?: () => void;
  continueLabel: string;
}) {
  if (halted) {
    const retryable = halted.failure.kind !== "simulation";
    return (
      <div className="border-line-soft border-t px-3 py-2.5">
        <p className={`text-[0.8rem] leading-5 ${halted.failure.kind === "cancelled" ? "text-muted" : "text-danger"}`}>
          {failureMessage(halted.failure)}
        </p>
        {onRetry && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" tone={retryable ? "accent" : "default"} onClick={onRetry}>
              {retryable ? "Try again" : "Start over"}
            </Button>
            {onDismiss && (
              <Button size="sm" tone="ghost" onClick={onDismiss}>
                Dismiss
              </Button>
            )}
            {/* Anything that already landed stays landed. Saying so stops a
                retry from reading like a second charge for the same work. */}
            <span className="text-dim text-[0.75rem]">
              Completed steps are not repeated.
            </span>
          </div>
        )}
      </div>
    );
  }

  if (awaiting && onContinue) {
    return (
      <div className="border-line-soft border-t px-3 py-2.5">
        <p className="text-muted text-[0.8rem] leading-5">
          {remaining === 1
            ? "One approval left."
            : `${remaining} approvals left.`}{" "}
          Nothing further is sent until you continue.
        </p>
        <div className="mt-2">
          <Button size="sm" tone="accent" onClick={onContinue}>
            {continueLabel}
          </Button>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="border-line-soft border-t px-3 py-2">
        <p className="text-p flex items-center justify-between gap-2 text-[0.8rem]">
          <span>Done. Balances refresh from confirmed chain state.</span>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="text-dim hover:text-text text-[0.75rem] transition-colors"
            >
              Dismiss
            </button>
          )}
        </p>
      </div>
    );
  }

  return (
    <p className="border-line-soft text-dim border-t px-3 py-2 text-[0.75rem]">
      {describeApprovals(steps)}
    </p>
  );
}

function StepMark({ state }: { state: StepState }) {
  const base =
    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-[0.6rem] leading-none";
  if (state.status === "done") {
    return <span className={`${base} border-p/50 bg-p text-ink`} aria-label="completed">✓</span>;
  }
  if (state.status === "failed") {
    return (
      <span
        className={`${base} ${state.failure.kind === "cancelled" ? "border-line text-dim" : "border-danger/50 bg-danger text-ink"}`}
        aria-label={state.failure.kind === "cancelled" ? "cancelled" : "failed"}
      >
        {state.failure.kind === "cancelled" ? "–" : "!"}
      </span>
    );
  }
  if (state.status === "active") {
    return (
      <span className={`${base} border-n text-n`} aria-label="in progress">
        <span className="bg-n size-1.5 animate-pulse rounded-full" />
      </span>
    );
  }
  return <span className={`${base} border-line text-dim`} aria-hidden />;
}

function StepDetail({
  state,
  target,
}: {
  state: StepState;
  target: FlowState["steps"][number]["target"];
}) {
  if (state.status === "active") {
    return (
      <p className="text-n mt-0.5 text-[0.75rem]">{sendPhaseLabel(state.phase, target)}</p>
    );
  }
  if (state.status === "done" && state.signature) {
    return <Signature signature={state.signature} target={target} />;
  }
  if (state.status === "failed") {
    return (
      <p className={`mt-0.5 text-[0.75rem] ${state.failure.kind === "cancelled" ? "text-dim" : "text-danger"}`}>
        {failureMessage(state.failure)}
      </p>
    );
  }
  return null;
}

/**
 * Each signature next to the step that produced it, labelled with where it
 * landed. The two endpoints confirm against different ledgers, and a single
 * undifferentiated list of hashes cannot answer "which chain was that?".
 */
function Signature({
  signature,
  target,
}: {
  signature: string;
  target: FlowState["steps"][number]["target"];
}) {
  const short = `${signature.slice(0, 12)}…`;
  if (target === "magicblock") {
    return (
      <p className="text-dim mt-0.5 font-mono text-[0.7rem]">
        MagicBlock · {short}
      </p>
    );
  }
  return (
    <p className="text-dim mt-0.5 font-mono text-[0.7rem]">
      Solana ·{" "}
      <a
        href={`https://explorer.solana.com/tx/${signature}?cluster=${NETWORK.network}`}
        target="_blank"
        rel="noreferrer"
        className="hover:text-text underline underline-offset-2 transition-colors"
      >
        {short} ↗
      </a>
    </p>
  );
}

export function failureMessage(failure: FlowFailure): string {
  switch (failure.kind) {
    case "cancelled":
      return "Cancelled in your wallet. Nothing was sent.";
    case "expired":
      return "The approval expired before it landed. Try again.";
    case "projection-timeout":
      return "The delegated balance did not appear on MagicBlock in time. Your funds are safe on Solana; try again.";
    case "rpc":
      return `The network did not respond: ${failure.message}`;
    case "simulation":
      return failure.message;
    default:
      return failure.message;
  }
}
