const HELIUS_DEVNET_RPC = "https://devnet.helius-rpc.com/";
export const WAITLIST_LIMIT = 100_000;

export const ALLOWED_RPC_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getFeeForMessage",
  "getGenesisHash",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);

function corsHeaders(origin, requestUrl) {
  if (!origin || origin === new URL(requestUrl).origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, solana-client",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

export function isAllowedRpcOrigin(origin, requestUrl) {
  if (!origin || origin === new URL(requestUrl).origin) return true;
  try {
    const candidate = new URL(origin);
    const loopback =
      candidate.hostname === "localhost" ||
      candidate.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(candidate.hostname);
    return loopback && (candidate.protocol === "http:" || candidate.protocol === "https:");
  } catch {
    return false;
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function normalizeWaitlistEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return null;
  }
  return email;
}

const waitlistKey = async (email) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return `email:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

export async function handleWaitlist(request, env) {
  const origin = request.headers.get("origin");
  if (!isAllowedRpcOrigin(origin, request.url)) {
    return json({ error: "Cross-origin waitlist requests are not allowed." }, 403);
  }
  if (request.method !== "POST") {
    return json({ error: "Waitlist accepts POST requests only." }, 405);
  }
  if (!env.WAITLIST_DB) {
    return json({ error: "Waitlist storage is not configured." }, 503);
  }
  if (Number(request.headers.get("content-length") || "0") > 4_096) {
    return json({ error: "Waitlist request is too large." }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Enter a valid email address." }, 400);
  }
  const email = normalizeWaitlistEmail(body?.email);
  if (!email) return json({ error: "Enter a valid email address." }, 400);

  const emailHash = await waitlistKey(email);
  const existing = await env.WAITLIST_DB
    .prepare("SELECT 1 AS found FROM waitlist_entries WHERE email_hash = ? LIMIT 1")
    .bind(emailHash)
    .first();
  if (existing) return json({ ok: true }, 201);

  try {
    await env.WAITLIST_DB
      .prepare(
        "INSERT INTO waitlist_entries (email_hash, email, joined_at) VALUES (?, ?, ?)",
      )
      .bind(emailHash, email, new Date().toISOString())
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A duplicate can race the initial lookup. Treat that as the same
    // idempotent success as an ordinary repeat submission.
    if (/unique constraint/i.test(message)) return json({ ok: true }, 201);
    if (/WAITLIST_FULL/.test(message)) {
      const wonRace = await env.WAITLIST_DB
        .prepare("SELECT 1 AS found FROM waitlist_entries WHERE email_hash = ? LIMIT 1")
        .bind(emailHash)
        .first();
      if (wonRace) return json({ ok: true }, 201);
      return json({ error: "The waitlist has reached 100,000 people." }, 409);
    }
    throw error;
  }
  return json({ ok: true }, 201);
}

function validCall(call) {
  return (
    call &&
    typeof call === "object" &&
    call.jsonrpc === "2.0" &&
    typeof call.method === "string" &&
    ALLOWED_RPC_METHODS.has(call.method)
  );
}

export function validateRpcPayload(payload) {
  const calls = Array.isArray(payload) ? payload : [payload];
  if (calls.length === 0 || calls.length > 25) return false;
  return calls.every(validCall);
}

export async function handleRpc(request, env) {
  const origin = request.headers.get("origin");
  if (!isAllowedRpcOrigin(origin, request.url)) {
    return json({ error: "Cross-origin RPC requests are not allowed." }, 403);
  }
  const cors = corsHeaders(origin, request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return json({ error: "RPC accepts POST requests only." }, 405, cors);
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > 1_000_000) {
    return json({ error: "RPC request is too large." }, 413, cors);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "RPC body must be valid JSON." }, 400, cors);
  }
  if (!validateRpcPayload(payload)) {
    return json({ error: "RPC method is not available through this application." }, 403, cors);
  }
  if (!env.HELIUS_API_KEY) {
    return json({ error: "RPC service is not configured." }, 503, cors);
  }

  const upstreamUrl = new URL(HELIUS_DEVNET_RPC);
  upstreamUrl.searchParams.set("api-key", env.HELIUS_API_KEY);
  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
      ...cors,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/rpc" || url.pathname.startsWith("/rpc/")) {
      return handleRpc(request, env);
    }
    if (url.pathname === "/waitlist") {
      return handleWaitlist(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
