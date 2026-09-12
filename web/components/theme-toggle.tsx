"use client";

import { useEffect, useState } from "react";

/**
 * Light/dark control for the whole product.
 *
 * Light is the default and the identity; dark exists because the market screen
 * is the one page people leave open, and a full-bleed cream terminal is tiring
 * to sit in front of. The choice is explicit rather than following
 * `prefers-color-scheme`, so a first visit always shows the design as intended.
 *
 * The value is applied by the inline script in `app/layout.tsx` before first
 * paint. This component only has to stay in sync with what that already did,
 * which is why it reads the attribute rather than the stored key.
 */
export const THEME_KEY = "erodoro.theme";

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [dark, setDark] = useState(false);
  // Rendered on the server as light, so the first client paint has to agree
  // with the server before it is allowed to reflect the real setting.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.dataset.theme === "dark");
    setReady(true);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try {
      window.localStorage.setItem(THEME_KEY, next ? "dark" : "light");
    } catch {
      // Private browsing. The choice simply does not persist.
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
      className={`border-line text-muted hover:text-text hover:border-text inline-flex shrink-0 items-center justify-center rounded-sm border transition-colors ${
        compact ? "size-8" : "size-9"
      }`}
    >
      <span aria-hidden className={ready ? "" : "opacity-0"}>
        {dark ? <SunIcon /> : <MoonIcon />}
      </span>
    </button>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M13.5 9.4A5.8 5.8 0 0 1 6.6 2.5a5.8 5.8 0 1 0 6.9 6.9Z" strokeLinejoin="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2 3.1 3.1" strokeLinecap="round" />
    </svg>
  );
}
