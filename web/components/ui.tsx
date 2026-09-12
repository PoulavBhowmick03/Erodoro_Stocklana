"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { SendState } from "@/lib/use-send";
import { sendPhaseLabel } from "@/lib/transaction-lifecycle";
import { NETWORK } from "@/lib/network-config";

type Tone = "default" | "accent" | "primary" | "buy" | "sell" | "ghost";

const TONES: Record<Tone, string> = {
  default: "border-line hover:border-text hover:bg-panel-2 border bg-transparent",
  ghost: "border-transparent text-muted hover:text-text hover:bg-panel-2 border",
  accent: "bg-accent hover:bg-accent-soft text-ink border border-transparent",
  primary: "bg-text text-bg hover:bg-accent border border-transparent",
  buy: "bg-p hover:bg-p/90 text-ink border border-transparent",
  sell: "bg-ask hover:bg-ask/90 text-ink border border-transparent",
};

/**
 * Every button in the app.
 *
 * Two things here are deliberate. A disabled button carries the *reason* it is
 * disabled rather than only the fact — a greyed control with no explanation is
 * the single most common way a working app looks broken. And `busy` keeps the
 * button mounted and sized while a transaction is in flight, so the layout
 * does not jump at the exact moment the user is watching it.
 *
 * Note what is not here: a `danger` tone for ordinary trading. Selling N is the
 * seller's whole purpose, and painting it in the same red as "this failed"
 * tells the user their primary action is a mistake.
 */
export const Button = forwardRef<HTMLButtonElement, {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** Shown on hover, and read out, when `disabled`. */
  disabledReason?: string;
  busy?: boolean;
  tone?: Tone;
  size?: "sm" | "md" | "lg";
  full?: boolean;
  type?: "button" | "submit";
} & {
  "data-tour"?: string;
  "data-mobile-trade-button"?: boolean;
  "aria-haspopup"?: "dialog" | "menu" | "listbox" | "tree" | "grid" | true;
  "aria-expanded"?: boolean;
}>(function Button({
  children,
  onClick,
  disabled,
  disabledReason,
  busy = false,
  tone = "default",
  size = "md",
  full = false,
  type = "button",
  ...rest
}, ref) {
  const off = Boolean(disabled) || busy;
  const sizes =
    size === "sm"
      ? "px-3 py-1.5 text-[0.82rem]"
      : size === "lg"
        ? "px-4 py-3 text-sm font-semibold"
        : "px-4 py-2 text-sm";

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      onClick={onClick}
      disabled={off}
      title={off && disabledReason ? disabledReason : undefined}
      aria-disabled={off || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-sm font-medium transition-[background-color,border-color,color,transform] duration-150 ease-[var(--ease-ui)] active:not-disabled:translate-y-px disabled:cursor-not-allowed disabled:border-line disabled:bg-panel-2 disabled:text-dim disabled:shadow-none ${sizes} ${TONES[tone]} ${full ? "w-full" : ""}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
});

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 animate-spin" aria-hidden>
      <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.2" />
      <path d="M8 1.6a6.4 6.4 0 0 1 6.4 6.4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A steady green/amber dot for "this data is arriving", grey for "it is not".
 * The market screen polls; without this the difference between a quiet book and
 * a stalled connection is invisible.
 */
export function LiveDot({ live, label }: { live: boolean; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${live ? "bg-p live-dot" : "bg-dim"}`}
      />
      {label && <span className={live ? "text-p" : "text-dim"}>{label}</span>}
    </span>
  );
}

export function AmountInput(props: Omit<InputProps, "inputMode">) {
  return (
    <Input
      {...props}
      onChange={(v) => props.onChange(v.replace(/[^0-9.]/g, ""))}
      inputMode="decimal"
    />
  );
}

/**
 * The same field without the numeric filter.
 *
 * Split out of `AmountInput` after the collateral field on the create screen
 * turned out to be using it: the filter strips everything that is not a digit
 * or a dot, so pasting a base58 mint address left a handful of digits behind
 * and no indication that anything had been removed.
 */
export function TextInput(props: InputProps) {
  return <Input {...props} />;
}

type InputProps = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  placeholder?: string;
  inputMode?: "decimal" | "text";
  /** Renders a Max affordance beside the label. */
  onMax?: () => void;
  /** Small right-aligned note beside the label — a balance, usually. */
  note?: string;
  invalid?: boolean;
  onSubmit?: () => void;
  autoFocus?: boolean;
};

function Input({
  label,
  value,
  onChange,
  suffix,
  placeholder = "0.00",
  inputMode,
  onMax,
  note,
  invalid = false,
  onSubmit,
  autoFocus,
}: InputProps) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-dim text-[0.8125rem] tracking-[0.1em] uppercase">{label}</span>
        {note && <span className="text-dim font-mono text-[0.75rem]">{note}</span>}
        {onMax && (
          <button
            type="button"
            onClick={onMax}
            className="text-accent-ink hover:text-accent-soft text-[0.75rem] font-medium tracking-wide uppercase transition-colors"
          >
            Max
          </button>
        )}
      </span>
      <div
        className={`bg-bg flex items-center rounded-sm border px-3 transition-colors duration-150 ${
          invalid
            ? "border-danger"
            : "border-line focus-within:border-accent hover:border-muted"
        }`}
      >
        <input
          inputMode={inputMode ?? "text"}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className="text-text placeholder:text-dim/60 w-full bg-transparent py-2.5 font-mono text-sm tabular-nums outline-none"
        />
        {suffix && <span className="text-dim ml-2 shrink-0 font-mono text-xs">{suffix}</span>}
      </div>
    </label>
  );
}

/**
 * One segmented control, used everywhere there is a small mutually-exclusive
 * choice: buy/sell, P/N, the book tabs, the chart range.
 *
 * It was hand-rolled at each of those call sites before, with a different
 * radius, padding and active treatment at each one. Nothing signals "assembled
 * without looking at it" faster than seven versions of the same switch.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  full = false,
  label,
  tone,
}: {
  options: readonly { value: T; label: React.ReactNode; tone?: "buy" | "sell" | "neutral" }[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  full?: boolean;
  label?: string;
  /** Forces one accent for every option, rather than per-option tones. */
  tone?: "buy" | "sell" | "neutral";
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`border-line bg-panel-2/60 grid gap-0.5 rounded-sm border p-0.5 ${full ? "w-full" : "inline-grid"}`}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const active = option.value === value;
        const accent = tone ?? option.tone ?? "neutral";
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`rounded-[3px] font-medium whitespace-nowrap transition-all duration-150 ease-[var(--ease-ui)] ${
              size === "sm" ? "px-2.5 py-1 text-[0.78rem]" : "px-3 py-1.5 text-[0.85rem]"
            } ${
              active
                ? accent === "buy"
                  ? "bg-p text-ink shadow-raised"
                  : accent === "sell"
                    ? "bg-ask text-ink shadow-raised"
                    : "bg-panel text-text shadow-raised"
                : "text-dim hover:text-text"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Underlined tabs, for switching a whole region rather than one value. */
export function Tabs<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <div className="border-line flex overflow-x-auto border-b" role="tablist" aria-label={label}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={`shrink-0 border-b-2 px-2.5 py-2.5 text-sm transition-colors duration-150 sm:px-4 ${
              active
                ? "border-accent text-text"
                : "text-muted hover:text-text border-transparent"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Transaction feedback. Errors are rendered as prose because `explainError`
 * already turned them into something actionable — showing a raw Anchor dump
 * here would undo that.
 */
export function TxStatus({ state }: { state: SendState }) {
  if (state.kind === "idle") return null;

  const frame = "rise-in mt-3 rounded-sm border px-3 py-2.5 text-[0.82rem]";

  if (state.kind === "sending") {
    return (
      <div className={`${frame} border-n/30 bg-n/8 text-n`} role="status" aria-live="polite">
        <p className="flex items-center gap-2">
          <span className="bg-n size-1.5 animate-pulse rounded-full" />
          {sendPhaseLabel(state.phase, state.target)}
        </p>
        {state.signature && (
          <p className="mt-1 font-mono text-[0.75rem] break-all opacity-70">
            {state.signature.slice(0, 16)}…
          </p>
        )}
      </div>
    );
  }
  if (state.kind === "ok") {
    return (
      <div className={`${frame} border-p/35 bg-p/8 text-p`} role="status" aria-live="polite">
        <p className="flex items-center gap-2 font-medium">
          <CheckIcon /> Confirmed
        </p>
        <p className="mt-1 font-mono text-[0.75rem] break-all opacity-70">
          {state.signature.slice(0, 24)}…
        </p>
        {state.target === "solana" && (
          <a
            className="hover:text-text mt-1.5 inline-block underline underline-offset-2"
            href={`https://explorer.solana.com/tx/${state.signature}?cluster=${NETWORK.network}`}
            target="_blank"
            rel="noreferrer"
          >
            View transaction ↗
          </a>
        )}
      </div>
    );
  }
  if (state.kind === "cancelled") {
    return (
      <p className={`${frame} border-line bg-panel-2 text-muted`} role="status">
        Request cancelled · {state.message}
      </p>
    );
  }
  if (state.kind === "expired") {
    return (
      <p className={`${frame} border-n/30 bg-n/8 text-n`} role="status">
        Transaction expired · {state.message}
      </p>
    );
  }
  return (
    <p className={`${frame} border-danger/35 bg-danger/8 text-danger`} role="alert">
      Transaction failed · {state.message}
    </p>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="m3 8.4 3.2 3.2L13 4.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  /** Explains a term that is not self-evident, on hover and to a reader. */
  hint?: string;
}) {
  return (
    <div>
      <div className="text-dim flex items-center gap-1 text-[0.8125rem] tracking-[0.1em] uppercase">
        {label}
        {hint && <InfoDot hint={hint} />}
      </div>
      <div className="mt-1 font-mono text-[0.95rem]">{children}</div>
    </div>
  );
}

/** A small "what is this" marker. Native title, so it works on keyboard focus. */
export function InfoDot({ hint }: { hint: string }) {
  return (
    <span
      tabIndex={0}
      role="note"
      aria-label={hint}
      title={hint}
      className="border-line text-dim hover:border-text hover:text-text inline-flex size-3.5 cursor-help items-center justify-center rounded-full border text-[0.6rem] leading-none normal-case transition-colors"
    >
      ?
    </span>
  );
}

/**
 * A number that briefly highlights when it changes.
 *
 * The book polls every 1.5s. Without this, a price moving is indistinguishable
 * from a price that was always that value, and the screen reads as static even
 * while it is live.
 */
export function Ticking({
  value,
  className = "",
}: {
  value: string;
  className?: string;
}) {
  const [flash, setFlash] = useState(false);
  const previous = useRef(value);

  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 500);
    return () => window.clearTimeout(timer);
  }, [value]);

  return (
    <span
      className={`rounded-[3px] transition-colors duration-500 ${
        flash ? "bg-accent/20" : "bg-transparent"
      } ${className}`}
    >
      {value}
    </span>
  );
}

export function AddressLink({
  label,
  address,
}: {
  label: string;
  address: PublicKey | string;
}) {
  const value = typeof address === "string" ? address : address.toBase58();
  const [copied, setCopied] = useState(false);
  const explorer = `https://explorer.solana.com/address/${value}?cluster=${NETWORK.network}`;

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className="min-w-0">
      <div className="text-dim text-[0.8125rem] tracking-[0.08em] uppercase">{label}</div>
      <div className="mt-1 flex min-w-0 items-center gap-2">
        <code className="min-w-0 truncate text-[0.8125rem]">{value}</code>
        <button
          type="button"
          onClick={() => void copy()}
          className={`shrink-0 text-[0.8125rem] transition-colors ${copied ? "text-p" : "text-muted hover:text-text"}`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <a
          href={explorer}
          target="_blank"
          rel="noreferrer"
          className="text-muted hover:text-text shrink-0 text-[0.8125rem] transition-colors"
        >
          Explorer ↗
        </a>
      </div>
    </div>
  );
}

export function Panel({
  title,
  subtitle,
  children,
  tour,
  actions,
  flush = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  /** Anchor for the guided walkthrough. See `components/tour.tsx`. */
  tour?: string;
  actions?: React.ReactNode;
  /** Drop the frame when this panel is already inside one. */
  flush?: boolean;
}) {
  return (
    <section
      data-tour={tour}
      className={flush ? "" : "border-line bg-panel shadow-panel rounded-md border p-5"}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-medium tracking-[-0.025em]">{title}</h3>
          {subtitle && <p className="text-muted mt-1 max-w-[62ch] text-[0.85rem] leading-6">{subtitle}</p>}
        </div>
        {actions}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * The empty state used by every list in the app.
 *
 * Each surface had its own before, and they disagreed about whether an empty
 * list warrants a heading, a retry, or a way out. An empty screen is where a
 * user decides the product is broken, so it is the last place to improvise.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="border-line bg-panel rounded-md border px-6 py-14 text-center">
      <h2 className="text-lg font-medium">{title}</h2>
      <p className="text-muted mx-auto mt-2 max-w-md text-[0.9rem] leading-6">{body}</p>
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
