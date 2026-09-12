"use client";

import { useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { buildTestMintIxs, TEST_MINT_DECIMALS, type TestMintResult } from "@/lib/test-mint";
import { LAST_MINT_KEY, LAST_SERIES_KEY } from "@/lib/use-token-balances";
import { useSend } from "@/lib/use-send";
import { useSigner } from "@/lib/use-signer";
import { AmountInput, Button, Panel, TxStatus } from "./ui";

/** Create valueless Token-2022 demo collateral, with uncommon controls folded away. */
export function MintPanel({ onMinted }: { onMinted?: () => void }) {
  const { connection } = useConnection();
  const publicKey = useSigner();
  const { state, send, reset } = useSend();
  const [scaled, setScaled] = useState(true);
  const [delegate, setDelegate] = useState(true);
  const [amount, setAmount] = useState("1000");

  const qty = Number(amount);
  const valid = Number.isFinite(qty) && qty > 0;
  const busy = state.kind === "sending";

  const create = async () => {
    if (!publicKey || !valid) return;
    let result: TestMintResult | null = null;
    const signature = await send(async () => {
      const built = await buildTestMintIxs(connection, publicKey, {
        scaledUiAmount: scaled,
        permanentDelegate: delegate,
        amount: qty,
      });
      result = built.result;
      return { ixs: built.ixs, signers: [built.mintKeypair] };
    });

    if (!signature || !result) return;
    window.sessionStorage.setItem(LAST_MINT_KEY, (result as TestMintResult).mint.toBase58());
    window.sessionStorage.removeItem(LAST_SERIES_KEY);
    onMinted?.();
  };

  return (
    <Panel tour="mint-form" title="Mint SOL-linked demo collateral" subtitle="Valueless Token-2022 collateral for this devnet demo.">
      <div className="max-w-xs">
        <AmountInput
          label="Amount to mint"
          value={amount}
          onChange={(value) => {
            setAmount(value);
            reset();
          }}
          suffix="demo units"
        />
      </div>

      <details className="border-line mt-4 rounded-sm border">
        <summary className="text-muted hover:text-text cursor-pointer px-3 py-2 text-sm">
          Advanced settings
        </summary>
        <div className="border-line-soft space-y-2 border-t p-3">
          <CompactToggle checked={scaled} onChange={setScaled} label="Simulate balance scaling" description="Adds Token-2022 Scaled UI support." />
          <CompactToggle checked={delegate} onChange={setDelegate} label="Simulate issuer control" description="Adds a permanent delegate that can move tokens." />
        </div>
      </details>

      <div className="mt-4">
        <Button tone="accent" disabled={busy || !publicKey || !valid} onClick={() => void create()}>
          {busy ? "Minting…" : "Mint demo collateral"}
        </Button>
      </div>

      <div data-tour="test-stock-status" aria-live="polite">
        <TxStatus state={state} />
      </div>
      <p className="text-dim mt-3 text-[0.75rem]">
        Devnet only · SOL-linked payoff · not SOL, a stock or a security · no real value · Token-2022 · {TEST_MINT_DECIMALS} decimals
      </p>
    </Panel>
  );
}

function CompactToggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <label className="bg-bg flex cursor-pointer items-center gap-3 rounded-sm px-3 py-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="shrink-0"
      />
      <span>
        <span className="block text-sm">{label}</span>
        <span className="text-dim mt-0.5 block text-[0.8125rem]">{description}</span>
      </span>
    </label>
  );
}
