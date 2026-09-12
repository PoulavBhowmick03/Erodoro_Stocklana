import assert from "node:assert/strict";
import test from "node:test";

import {
  createRpcFallbackFetch,
  isRetryableRpcStatus,
} from "../lib/rpc-fallback.ts";

const ok = (body = "ok") => new Response(body, { status: 200 });

test("only rate limits and temporary server failures use the RPC fallback", () => {
  assert.equal(isRetryableRpcStatus(429), true);
  assert.equal(isRetryableRpcStatus(500), true);
  assert.equal(isRetryableRpcStatus(504), true);
  assert.equal(isRetryableRpcStatus(400), false);
  assert.equal(isRetryableRpcStatus(403), false);
});

test("a successful public Devnet response never calls Helius", async () => {
  const calls = [];
  const rpcFetch = createRpcFallbackFetch({
    fallbackUrl: "https://fallback.example/rpc",
    fetchImpl: async (input) => {
      calls.push(String(input));
      return ok("public");
    },
  });

  assert.equal(await (await rpcFetch("https://api.devnet.solana.com")).text(), "public");
  assert.deepEqual(calls, ["https://api.devnet.solana.com"]);
});

test("a public rate limit fails over to Helius and enters a cooldown", async () => {
  const calls = [];
  let clock = 1_000;
  const rpcFetch = createRpcFallbackFetch({
    fallbackUrl: "https://fallback.example/rpc",
    now: () => clock,
    cooldownMs: 30_000,
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      return url.includes("fallback")
        ? ok("helius")
        : new Response("limited", { status: 429 });
    },
  });

  assert.equal(await (await rpcFetch("https://api.devnet.solana.com")).text(), "helius");
  assert.equal(await (await rpcFetch("https://api.devnet.solana.com")).text(), "helius");
  assert.deepEqual(calls, [
    "https://api.devnet.solana.com",
    "https://fallback.example/rpc",
    "https://fallback.example/rpc",
  ]);

  clock += 30_001;
  await rpcFetch("https://api.devnet.solana.com");
  assert.equal(calls.at(-2), "https://api.devnet.solana.com");
  assert.equal(calls.at(-1), "https://fallback.example/rpc");
});

test("an invalid public request is returned without changing providers", async () => {
  const calls = [];
  const rpcFetch = createRpcFallbackFetch({
    fallbackUrl: "https://fallback.example/rpc",
    fetchImpl: async (input) => {
      calls.push(String(input));
      return new Response("bad request", { status: 400 });
    },
  });

  assert.equal((await rpcFetch("https://api.devnet.solana.com")).status, 400);
  assert.deepEqual(calls, ["https://api.devnet.solana.com"]);
});

test("a public transport failure uses Helius without hiding a double failure", async () => {
  let fallbackWorks = true;
  const primaryError = new Error("public network failed");
  const rpcFetch = createRpcFallbackFetch({
    fallbackUrl: "https://fallback.example/rpc",
    fetchImpl: async (input) => {
      if (!String(input).includes("fallback")) throw primaryError;
      if (!fallbackWorks) throw new Error("fallback network failed");
      return ok("helius");
    },
  });

  assert.equal(await (await rpcFetch("https://api.devnet.solana.com")).text(), "helius");
  fallbackWorks = false;
  await assert.rejects(() => rpcFetch("https://api.devnet.solana.com"), primaryError);
});
