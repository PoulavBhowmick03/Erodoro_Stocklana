"use client";

/**
 * The boundary for failures in the root layout itself, where `app/error.tsx`
 * cannot reach.
 *
 * This replaces the root layout when it fires, so it has to supply its own
 * `<html>` and `<body>` — and it does **not** get the app's global styles, so
 * everything here is inline. That is a Next constraint, not a preference: a
 * class from `globals.css` would simply not resolve.
 *
 * The colours are hardcoded to the app palette because global CSS is not
 * available when the root layout itself fails.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#f2f0e9",
          color: "#0a1118",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
        }}
      >
        <title>Something broke · erodoro</title>
        <div
          style={{
            maxWidth: "34rem",
            width: "100%",
            border: "1px solid #c9c4ba",
            background: "#fbfaf6",
            borderRadius: "0.375rem",
            padding: "2rem",
          }}
        >
          <div style={{ color: "#b53b3b", fontFamily: "ui-monospace, monospace", fontSize: "0.68rem", letterSpacing: "0.12em", textTransform: "uppercase" }}>Interface error</div>
          <h1 style={{ fontSize: "1.75rem", margin: "0.75rem 0 0", fontWeight: 500, letterSpacing: "-0.035em" }}>
            Something broke before the page could load
          </h1>
          <p style={{ color: "#58616b", fontSize: "0.92rem", marginTop: "0.75rem", lineHeight: 1.7 }}>
            Your funds are not affected. Nothing here touches the chain — this is the
            interface failing to start.
          </p>
          {error.digest && (
            <p
              style={{
                color: "#7a807f",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "0.78rem",
                marginTop: "0.75rem",
              }}
            >
              digest {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            style={{
              marginTop: "1.5rem",
              border: "1px solid #0a1118",
              background: "#0a1118",
              color: "#f2f0e9",
              borderRadius: "0.125rem",
              padding: "0.5rem 1rem",
              fontSize: "0.88rem",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
