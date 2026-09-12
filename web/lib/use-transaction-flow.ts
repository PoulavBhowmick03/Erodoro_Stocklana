"use client";

import { useCallback, useRef, useState } from "react";
import type { Connection } from "@solana/web3.js";

import { explainError } from "./actions";
import { isWalletRejection } from "./wallet-errors";
import { isTransactionExpired } from "./transaction-lifecycle";
import {
  beginFlow,
  classifyFailure,
  markActive,
  markAwaiting,
  markDone,
  markFailed,
  type FlowState,
  type FlowStep,
  type FlowStepKind,
} from "./transaction-flow";
import { useSend, type Built } from "./use-send";

/**
 * What the caller must supply to run one composed action.
 *
 * `plan` is called again on every retry and every continuation, so it must read
 * live chain state rather than close over a snapshot. That single rule is what
 * makes "retry only the incomplete step" work: a prerequisite that already
 * landed is no longer observable as missing, so it is no longer planned, so it
 * is never signed twice.
 */
export type FlowPlan = {
  steps: FlowStep[];
  /**
   * Perform one planned step. Returning a signature records it against that
   * step; a step that is a wait rather than a transaction returns nothing.
   */
  execute: (
    step: FlowStep,
    send: FlowSend,
  ) => Promise<string | null | void>;
};

/** The send available to a step, already wired into the flow's progress. */
export type FlowSend = (build: () => Promise<Built>, target?: Connection) => Promise<string | null>;

/**
 * Run a multi-approval action and report it honestly.
 *
 * The hook owns three things the call sites kept getting wrong on their own:
 * it never lets a second submission start while one is unresolved, it never
 * repeats a step that already succeeded, and it never continues past a
 * deliberate pause without the user asking.
 */
export function useTransactionFlow(action: string, options?: { pauseAfter?: FlowStepKind[] }) {
  const { send, reset } = useSend();
  const [flow, setFlow] = useState<FlowState | null>(null);

  /**
   * Steps that already landed, carried across re-plans.
   *
   * Re-planning correctly forgets a completed prerequisite, which is the point
   * -- but the user still needs to see that it happened and what it cost. This
   * keeps the record without keeping the work.
   */
  const history = useRef<{ step: FlowStep; signature?: string }[]>([]);
  const planner = useRef<(() => Promise<FlowPlan>) | null>(null);
  const running = useRef(false);
  /**
   * Held in a ref because callers pass an array literal, which is a new
   * identity every render. As a `useCallback` dependency that rebuilt the
   * whole runner on each render for no reason.
   */
  const pauseAfter = useRef<FlowStepKind[]>(options?.pauseAfter ?? []);
  pauseAfter.current = options?.pauseAfter ?? [];

  const drive = useCallback(
    async (plan: FlowPlan) => {
      const done = history.current;
      const steps = [...done.map((entry) => entry.step), ...plan.steps];
      const offset = done.length;

      let current = beginFlow(action, steps);
      done.forEach((entry, index) => {
        current = markDone(current, index, entry.signature);
      });
      setFlow(current);

      for (let index = 0; index < plan.steps.length; index += 1) {
        const at = offset + index;
        const step = plan.steps[index];
        let failure: unknown = null;

        current = markActive(current, at, "preparing");
        setFlow(current);

        const scoped: FlowSend = (build, target) =>
          send(build, target, {
            onPhase: (phase, _target, signature) => {
              current = markActive(current, at, phase, signature);
              setFlow(current);
            },
            onError: (error) => {
              failure = error;
            },
          });

        let signature: string | null | void;
        try {
          signature = await plan.execute(step, scoped);
        } catch (error) {
          failure = error;
          signature = null;
        }

        // `send` reports a failure by returning null after calling `onError`;
        // a step that is a plain wait throws instead. Both land here.
        if (failure || (step.approval && !signature)) {
          current = markFailed(
            current,
            at,
            classifyFailure(failure ?? new Error("The transaction was not sent."), {
              isRejection: isWalletRejection,
              isExpired: isTransactionExpired,
              explain: explainError,
            }),
          );
          setFlow(current);
          running.current = false;
          return false;
        }

        const recorded = typeof signature === "string" ? signature : undefined;
        current = markDone(current, at, recorded);
        setFlow(current);
        history.current = [...history.current, { step, signature: recorded }];

        const more = index < plan.steps.length - 1;
        if (more && pauseAfter.current.includes(step.kind)) {
          current = markAwaiting(current, at + 1);
          setFlow(current);
          running.current = false;
          return false;
        }
      }

      running.current = false;
      return true;
    },
    [action, send],
  );

  /** Begin, or resume after a pause or a failure. Always re-plans first. */
  const run = useCallback(
    async (plan?: () => Promise<FlowPlan>) => {
      if (running.current) return false;
      if (plan) {
        planner.current = plan;
        history.current = [];
      }
      const active = planner.current;
      if (!active) return false;

      running.current = true;
      reset();
      try {
        return await drive(await active());
      } catch (error) {
        // The planner itself failed, so there is no step to attribute this to.
        setFlow({
          action,
          steps: [],
          states: [],
          halted: {
            at: 0,
            failure: classifyFailure(error, {
              isRejection: isWalletRejection,
              isExpired: isTransactionExpired,
              explain: explainError,
            }),
          },
        });
        running.current = false;
        return false;
      }
    },
    [action, drive, reset],
  );

  const dismiss = useCallback(() => {
    if (running.current) return;
    history.current = [];
    planner.current = null;
    setFlow(null);
    reset();
  }, [reset]);

  return {
    flow,
    /** Start a new action. Clears any previous history. */
    start: (plan: () => Promise<FlowPlan>) => run(plan),
    /** Re-plan from current chain state and carry on. */
    resume: () => run(),
    dismiss,
    /** True while a step is unresolved. Callers gate submission on this. */
    busy: running.current,
  };
}
