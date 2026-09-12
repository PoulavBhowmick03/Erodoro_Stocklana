"use client";

import { useCallback, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";

import { usePrograms } from "@/lib/programs";
import { useSend } from "@/lib/use-send";
import { useSigner } from "@/lib/use-signer";
import { mergeIx, redeemIx, settleIx, splitIx } from "@/lib/actions";
import { toRaw } from "@/lib/format";
import { AmountInput, Button, Panel, TxStatus } from "./ui";
import { useTour } from "./tour";

/**
 * Locking collateral, as a capability rather than a panel.
 *
 * The order ticket needs to mint: a seller who arrives holding stock and no N
 * cannot place the ask they came for, and the fix is one instruction away. It
 * used to be a second form permanently stacked above the ticket, which put an
 * unrelated input between the trader and their order on every visit — including
 * the ones where their balance was already sufficient.
 *
 * Exposing it as a hook lets the ticket offer it exactly when the shortfall
 * exists, and stay out of the way otherwise.
 */
export function useClaimMint({
  address,
  config,
}: {
  address: PublicKey;
  config: any;
}) {
  const publicKey = useSigner();
  const { series } = usePrograms();

  const decimals: number = config.collateralDecimals;
  const status = Object.keys(config.status)[0];
  const matured = config.maturityTs.toNumber() <= Math.floor(Date.now() / 1000);

  const blocked = !publicKey
    ? "Connect a wallet or choose a demo account to lock collateral."
    : status === "paused"
      ? "Locking is paused for this market. You can still unlock what you already put in."
      : status === "settled"
        ? "This market has settled. Redeem instead of locking."
        : matured
          ? "This market has matured and is awaiting settlement."
          : undefined;

  /**
   * The instructions, not the send.
   *
   * Minting used to own its own `useSend`, which made it impossible to compose:
   * an order that needed collateral first produced two independent transaction
   * states, neither of which knew about the other, so the UI could not say that
   * a second approval was coming or that the first one had already landed.
   * Handing back a builder lets the order flow run this as one of its steps.
   */
  const buildSplit = useCallback(
    (amount: number) => {
      if (!publicKey) throw new Error("Connect a wallet or choose a demo account first.");
      if (blocked) throw new Error(blocked);
      const raw = new BN(toRaw(amount.toFixed(decimals), decimals));
      return splitIx({ series, address, config, wallet: publicKey }, raw);
    },
    [address, blocked, config, decimals, publicKey, series],
  );

  return { buildSplit, blocked };
}

/**
 * Write actions for one series.
 *
 * Which actions exist depends on the lifecycle, and the UI mirrors the program
 * rather than guessing: split needs an open, pre-maturity series; merge works
 * while paused too; redemption only exists after settlement.
 */
export function SeriesActions({
  address,
  config,
  settlement,
  onDone,
  tour,
  priceSource,
  flush = false,
}: {
  address: PublicKey;
  config: any;
  settlement: any | null;
  onDone: () => void;
  tour?: string;
  priceSource?: PublicKey;
  flush?: boolean;
}) {
  const publicKey = useSigner();
  const { series } = usePrograms();
  const { state, send, reset } = useSend();
  const { complete } = useTour();
  const [amount, setAmount] = useState("");

  const decimals: number = config.collateralDecimals;
  const status = Object.keys(config.status)[0];
  const settled = status === "settled";
  const matured = config.maturityTs.toNumber() <= Math.floor(Date.now() / 1000);

  if (!publicKey) return null;

  const ctx = { series, address, config, wallet: publicKey };
  const raw = () => new BN(toRaw(amount || "0", decimals));
  const busy = state.kind === "sending";
  const invalid = !amount || raw().lten(0);
  const reason = invalid ? "Enter an amount greater than zero." : undefined;

  const run = async (build: () => Promise<any>) => {
    const signature = await send(build);
    if (!signature) return;
    setAmount("");
    onDone();
    complete("act");
  };

  if (!settled && matured) {
    return (
      <Panel
        flush={flush}
        tour={tour ?? "series-actions"}
        title="Settle market"
        subtitle="Settlement is permissionless and uses only this market's predefined oracle source."
      >
        <Button
          tone="accent"
          busy={busy}
          disabled={!priceSource}
          disabledReason="Waiting for the configured oracle source."
          onClick={() => priceSource && run(() => settleIx(ctx, priceSource))}
        >
          Settle at the approved oracle price
        </Button>
        <TxStatus state={state} />
      </Panel>
    );
  }

  return (
    <Panel
      flush={flush}
      tour={tour ?? "series-actions"}
      title={settled ? "Redeem claims" : "Create or unlock claims"}
      subtitle={
        settled
          ? "This market has settled. Redeem P or N for its share of the collateral pool."
          : "Lock tokenized equity to mint equal amounts of P and N. Merge equal amounts back to unlock the original collateral."
      }
    >
      <div className="max-w-sm">
        <AmountInput
          label={settled ? "Quantity to redeem" : "Amount"}
          value={amount}
          onChange={(v) => {
            setAmount(v);
            reset();
          }}
          suffix={settled ? "P / N" : "collateral"}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {settled ? (
          <>
            <Button tone="accent" busy={busy} disabled={invalid} disabledReason={reason} onClick={() => run(() => redeemIx(ctx, "P", raw()))}>
              Redeem P
            </Button>
            <Button busy={busy} disabled={invalid} disabledReason={reason} onClick={() => run(() => redeemIx(ctx, "N", raw()))}>
              Redeem N
            </Button>
          </>
        ) : (
          <>
            <Button
              tone="accent"
              busy={busy}
              disabled={invalid || status !== "open" || matured}
              disabledReason={
                status !== "open"
                  ? "This market is not open for locking."
                  : matured
                    ? "This market has matured."
                    : reason
              }
              onClick={() => run(() => splitIx(ctx, raw()))}
            >
              Lock and mint P + N
            </Button>
            <Button busy={busy} disabled={invalid} disabledReason={reason} onClick={() => run(() => mergeIx(ctx, raw()))}>
              Merge P + N and unlock
            </Button>
          </>
        )}
      </div>

      {!settled && !matured && status === "open" && (
        <p className="text-dim mt-3 text-[0.8125rem]">
          Unlocking requires equal amounts of P and N. The original collateral is returned immediately.
        </p>
      )}
      {!settled && status === "paused" && (
        <p className="text-n mt-3 text-[0.8125rem]">
          Locking is paused. You can still unlock, so nothing you already put in is stuck.
        </p>
      )}
      {settled && settlement?.shortfallObserved && (
        <p className="text-danger mt-3 text-[0.8125rem]">
          The issuer moved collateral out, so the vault holds less than it owes. Everyone
          takes the same haircut, whenever they cash out.
        </p>
      )}

      <TxStatus state={state} />
    </Panel>
  );
}
