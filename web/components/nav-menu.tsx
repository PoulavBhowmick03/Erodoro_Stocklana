"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export type NavItem = { href: string; label: string; hint?: string };

/**
 * A grouped nav dropdown.
 *
 * The header used to be a flat row of every route, which gave equal weight to
 * things that do not deserve it: reading about the payoff, minting devnet
 * scaffolding, and actually holding a position are not the same kind of thing.
 * Explanation collapses in here; the surfaces you act on stay flat and visible.
 *
 * Closes on outside click and on Escape, and reports `aria-expanded`, because a
 * menu that only responds to a mouse is a menu half the users cannot open.
 */
export function NavMenu({ label, items }: { label: string; items: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`flex items-center gap-1 border-b px-3 py-5 text-sm transition-colors ${
          open ? "border-text text-text" : "border-transparent text-muted hover:text-text"
        }`}
      >
        {label}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden="true"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="border-line bg-panel absolute top-full left-0 z-50 mt-1.5 min-w-[14rem] rounded-md border p-1.5 shadow-[0_18px_50px_rgb(10_17_24/0.12)]"
        >
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="hover:bg-panel-2 block rounded-sm px-3 py-2 transition-colors"
            >
              <span className="text-text block text-sm">{item.label}</span>
              {item.hint && (
                <span className="text-dim mt-0.5 block text-[0.78rem]">{item.hint}</span>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
