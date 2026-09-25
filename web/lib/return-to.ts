/**
 * Where to send someone back to after a detour they did not choose.
 *
 * A buyer without enough USDC has to go and get some, and the app is what sends
 * them. Carrying the origin in the URL is the only way back that survives a
 * reload -- but a route read out of a query string is attacker-controlled
 * input, so it is validated against what this app can actually render rather
 * than trusted.
 *
 * The rules are deliberately strict, and each one closes something real:
 *
 *   - It must start with a single `/`. `//evil.example` is a protocol-relative
 *     URL that browsers treat as another origin, and it is the classic way an
 *     open redirect gets in.
 *   - It must not contain a scheme or a backslash, which are the other two ways
 *     to smuggle an absolute destination past a naive prefix check.
 *   - Its path must be one this app actually has. Anything else is either a
 *     typo or someone probing, and neither deserves a redirect.
 */
const ROUTES = new Set([
  "/",
  "/app",
  "/earn",
  "/auctions",
  "/market-rip",
  "/swap",
  "/rewards",
  "/faucet",
  "/portfolio",
  "/mint",
  "/trade/markets",
  "/admin/registry",
]);

export const RETURN_PARAM = "returnTo";

/** The candidate if it is safe to navigate to, otherwise `null`. */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  // A single leading slash, and nothing that could reintroduce an origin.
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//")) return null;
  if (value.includes("\\")) return null;
  if (/^\/+\s*[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  // Whitespace and control characters are how a naive parser gets confused
  // about where the path ends.
  if (/[\u0000-\u0020\u007f]/.test(value)) return null;

  const [pathAndQuery] = value.split("#");
  const [path, query = ""] = pathAndQuery.split("?");
  const normalised = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!ROUTES.has(normalised)) return null;

  // Rebuild rather than pass through, so nothing survives that was not parsed.
  return query ? `${normalised}?${query}` : normalised;
}

/** The current location, in the form `safeReturnTo` will accept back. */
export function returnToParam(pathname: string, search: string): string {
  return `${pathname}${search && search !== "?" ? search : ""}`;
}

/** Append a validated origin to a destination. */
export function withReturnTo(destination: string, origin: string): string {
  const safe = safeReturnTo(origin);
  if (!safe) return destination;
  const join = destination.includes("?") ? "&" : "?";
  return `${destination}${join}${RETURN_PARAM}=${encodeURIComponent(safe)}`;
}
