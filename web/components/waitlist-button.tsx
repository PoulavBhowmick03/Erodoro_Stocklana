"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Submission =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

export function WaitlistButton() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [submission, setSubmission] = useState<Submission>({ kind: "idle" });
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submission.kind === "sending") return;
    setSubmission({ kind: "sending" });
    try {
      const response = await fetch("/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const result = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error || "Could not join the waitlist.");
      setSubmission({ kind: "ok" });
    } catch (error) {
      setSubmission({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not join the waitlist.",
      });
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setSubmission({ kind: "idle" });
          setOpen(true);
        }}
        className="border-line text-muted hover:border-text hover:text-text rounded-sm border px-3 py-2 text-[0.8125rem] whitespace-nowrap transition-colors sm:px-4"
      >
        Request access
      </button>

      {mounted && open && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="presentation">
          <button
            type="button"
            aria-label="Close waitlist"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/65"
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="waitlist-title"
            className="border-line bg-panel shadow-pop relative w-full max-w-md rounded-md border p-5 sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="eyebrow">Early access</p>
                <h2 id="waitlist-title" className="mt-2 text-2xl font-medium tracking-[-0.035em]">
                  Join the waitlist
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close waitlist"
                onClick={() => setOpen(false)}
                className="border-line text-muted hover:text-text rounded-sm border px-2.5 py-1.5 text-sm"
              >
                Close
              </button>
            </div>

            {submission.kind === "ok" ? (
              <div className="border-p/30 bg-p/5 mt-5 rounded-sm border p-4" role="status">
                <p className="text-p font-medium">You’re on the list.</p>
                <p className="text-muted mt-1 text-sm">We’ll email you when access opens.</p>
              </div>
            ) : (
              <form onSubmit={submit} className="mt-5">
                <label htmlFor="waitlist-email" className="text-muted text-sm">
                  Email
                </label>
                <input
                  ref={input}
                  id="waitlist-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    if (submission.kind === "error") setSubmission({ kind: "idle" });
                  }}
                  placeholder="you@example.com"
                  className="border-line bg-bg focus:border-text mt-2 w-full rounded-sm border px-3 py-2.5 text-sm outline-none"
                />
                <button
                  type="submit"
                  disabled={submission.kind === "sending"}
                  title={submission.kind === "sending" ? "Joining the waitlist" : undefined}
                  className="bg-text hover:bg-accent text-bg mt-3 w-full rounded-sm px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-wait disabled:opacity-60"
                >
                  {submission.kind === "sending" ? "Joining…" : "Join waitlist"}
                </button>
                {submission.kind === "error" && (
                  <p className="text-danger mt-3 text-sm" role="alert">
                    {submission.message}
                  </p>
                )}
                <p className="text-dim mt-3 text-xs">Product access updates only.</p>
              </form>
            )}
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
