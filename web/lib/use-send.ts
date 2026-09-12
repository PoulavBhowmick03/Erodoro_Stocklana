"use client";

import { useCallback, useState } from "react";
import {
  ComputeBudgetProgram,
  Connection,
  Transaction,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useTestWallet } from "@/components/test-wallet";
import { useNetworkState } from "@/components/network-boundary";
import { explainError } from "./actions";
import { reportSendFailure } from "./send-failure";
import { isWalletRejection } from "./wallet-errors";
import {
  confirmationStrategy,
  isTransactionExpired,
  type SendPhase,
  type TransactionTarget,
} from "./transaction-lifecycle";

export type SendState =
  | { kind: "idle" }
  | {
      kind: "sending";
      phase: SendPhase;
      target: TransactionTarget;
      signature?: string;
    }
  | { kind: "ok"; signature: string; target: TransactionTarget }
  | { kind: "cancelled"; message: string }
  | { kind: "expired"; message: string }
  | { kind: "error"; message: string };

/**
 * What a builder hands back.
 *
 * Usually just instructions. Creating a mint is the exception: the new account
 * signs its own creation, and that keypair only exists inside the builder, so
 * it has to travel out with the instructions that need it.
 */
export type Built =
  | TransactionInstruction[]
  | { ixs: TransactionInstruction[]; signers?: Keypair[] };

/**
 * Send a set of instructions as one transaction and surface the outcome.
 *
 * Everything goes in a single transaction on purpose: the ATA-creation
 * instructions the action builders prepend only make sense alongside the
 * instruction that uses them, and splitting them would leave a wallet holding
 * empty accounts if the second half failed.
 */
export function useSend() {
  const { connection: l1 } = useConnection();
  const { publicKey: walletKey, sendTransaction } = useWallet();
  const { keypair } = useTestWallet();
  const network = useNetworkState();
  const [state, setState] = useState<SendState>({ kind: "idle" });

  const publicKey = keypair?.publicKey ?? walletKey;

  const send = useCallback(
    async (
      build: () => Promise<Built>,
      /**
       * Where to land the transaction. Defaults to L1; order instructions on a
       * delegated book pass the rollup connection instead.
       *
       * This is explicit at every call site on purpose. The two endpoints
       * confirm against different ledgers, and a default that silently
       * followed delegation state would make "which chain did that land on?"
       * unanswerable exactly when it matters.
       */
      target?: Connection,
      /**
       * Observers for a caller that is composing several sends into one user
       * action. `useSend` keeps rendering its own single-transaction summary
       * for the simple call sites; a flow needs the phase transitions and the
       * raw error as they happen, rather than a rendered sentence after.
       */
      hooks?: {
        onPhase?: (phase: SendPhase, target: TransactionTarget, signature?: string) => void;
        onError?: (error: unknown) => void;
      },
    ) => {
      const phase = (
        next: SendPhase,
        transactionTarget: TransactionTarget,
        signature?: string,
      ) => {
        setState({ kind: "sending", phase: next, target: transactionTarget, signature });
        hooks?.onPhase?.(next, transactionTarget, signature);
      };
      const fail = (error: unknown) =>
        reportSendFailure(error, {
          onError: hooks?.onError,
          update: setState,
          helpers: { isWalletRejection, isTransactionExpired, explainError },
        });
      if (!network.mutationsAllowed) {
        return fail(
          new Error("Transaction blocked until the configured Solana network is verified."),
        );
      }
      if (!publicKey) {
        return fail(new Error("Pick a test key or connect a wallet first."));
      }
      const connection = target ?? l1;
      const transactionTarget: TransactionTarget = target ? "magicblock" : "solana";
      phase("preparing", transactionTarget);
      try {
        const built = await build();
        const ixs = Array.isArray(built) ? built : built.ixs;
        const extra = Array.isArray(built) ? [] : (built.signers ?? []);
        const tx = new Transaction().add(...ixs);

        /**
         * Simulate before asking anyone to sign.
         *
         * A wallet extension reports a failed preflight as
         * `WalletSendTransactionError: Unexpected error` and drops the program
         * logs, so "you have no collateral", "you are not the admin" and a
         * genuine bug all reach the user as the same sentence. Running the
         * simulation here keeps the logs, and `explainError` can say which one
         * it was. It costs one RPC round trip and saves a signature prompt for
         * a transaction that was never going to land.
         */
        let unitsConsumed = 0;
        {
          const { blockhash } = await connection.getLatestBlockhash("confirmed");
          tx.recentBlockhash = blockhash;
          tx.feePayer = keypair?.publicKey ?? publicKey;
          const sim = await connection.simulateTransaction(tx);
          unitsConsumed = sim.value.unitsConsumed ?? 0;
          if (sim.value.err) {
            const logs = sim.value.logs ?? [];
            const anchorLog = logs.find((l) => /Error Code:|Error Message:/.test(l));
            const programLog = logs.find((l) => /^Program log: Error:/.test(l));
            throw new Error(
              anchorLog ?? programLog ?? `Simulation failed: ${JSON.stringify(sim.value.err)}`,
            );
          }
        }

        // Settlement transactions contend for Solana block space. A modest,
        // observed priority fee and a bounded compute limit make them land
        // reliably without applying Solana fee mechanics to MagicBlock.
        if (!target) {
          const computeLimit = unitsConsumed
            ? Math.min(
                1_400_000,
                Math.max(50_000, Math.ceil(unitsConsumed * 1.15)),
              )
            : null;
          let microLamports = 0;
          try {
            const writable = ixs
              .flatMap((ix) => ix.keys)
              .filter((key) => key.isWritable)
              .map((key) => key.pubkey)
              .slice(0, 128);
            const fees = (await connection.getRecentPrioritizationFees({
              lockedWritableAccounts: writable,
            }))
              .map((fee) => fee.prioritizationFee)
              .filter((fee) => fee > 0)
              .sort((a, b) => a - b);
            microLamports = fees[Math.floor(fees.length * 0.6)] ?? 0;
          } catch {
            // A provider without this optional RPC still sends at base fee.
          }
          if (computeLimit) {
            tx.instructions.unshift(
              ComputeBudgetProgram.setComputeUnitLimit({ units: computeLimit }),
            );
          }
          if (microLamports > 0) {
            tx.instructions.unshift(
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
            );
          }
        }

        // Fetch the lifetime immediately before approval, after every
        // instruction is final. This exact lifetime is also used to confirm.
        const lifetime = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = lifetime.blockhash;
        tx.feePayer = keypair?.publicKey ?? publicKey;
        phase("approval", transactionTarget);

        // A test keypair signs and sends itself. Routing it through the wallet
        // adapter would ask an extension to sign for a key it does not hold.
        let signature: string;
        if (keypair) {
          tx.sign(keypair, ...extra);
          signature = await connection.sendRawTransaction(tx.serialize(), {
            preflightCommitment: "confirmed",
            maxRetries: 3,
          });
        } else {
          signature = await sendTransaction(tx, connection, {
            signers: extra,
            preflightCommitment: "confirmed",
            maxRetries: 3,
          });
        }
        phase("submitted", transactionTarget, signature);
        // Let the submitted state paint before moving into confirmation. This
        // separates wallet acceptance from chain finality without adding a
        // synthetic delay to the transaction itself.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        phase("confirming", transactionTarget, signature);
        await connection.confirmTransaction(
          confirmationStrategy(signature, lifetime),
          "confirmed",
        );
        setState({ kind: "ok", signature, target: transactionTarget });
        return signature;
      } catch (e) {
        return fail(e);
      }
    },
    [l1, publicKey, sendTransaction, keypair, network.mutationsAllowed],
  );

  return { state, send, reset: () => setState({ kind: "idle" }) };
}
