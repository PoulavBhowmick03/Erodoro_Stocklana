import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  handleRpc,
  handleWaitlist,
  isAllowedRpcOrigin,
  normalizeWaitlistEmail,
  validateRpcPayload,
  WAITLIST_LIMIT,
} from "./worker.mjs";

function waitlistDb(seed = []) {
  const entries = new Map(seed.map((email, index) => [`seed:${index}`, { email }]));
  return {
    entries,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              return entries.has(values[0]) ? { found: 1 } : null;
            },
            async run() {
              if (!sql.startsWith("INSERT")) throw new Error("unexpected statement");
              if (entries.has(values[0])) throw new Error("UNIQUE constraint failed");
              if (entries.size >= WAITLIST_LIMIT) throw new Error("WAITLIST_FULL");
              entries.set(values[0], { email: values[1], joinedAt: values[2] });
            },
          };
        },
      };
    },
  };
}

test("RPC allowlist admits application reads and mutations", () => {
  assert.equal(validateRpcPayload({ jsonrpc: "2.0", id: 1, method: "getAccountInfo" }), true);
  assert.equal(validateRpcPayload({ jsonrpc: "2.0", id: 2, method: "sendTransaction" }), true);
});

test("RPC allowlist rejects unrelated and oversized batches", () => {
  assert.equal(validateRpcPayload({ jsonrpc: "2.0", id: 1, method: "requestAirdrop" }), false);
  assert.equal(
    validateRpcPayload(Array.from({ length: 26 }, (_, id) => ({ jsonrpc: "2.0", id, method: "getBalance" }))),
    false,
  );
});

test("RPC proxy rejects cross-origin browser traffic before using the secret", async () => {
  const request = new Request("https://erodoro-protocol.hypersettle.workers.dev/rpc", {
    method: "POST",
    headers: { origin: "https://example.com", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
  });
  const response = await handleRpc(request, { HELIUS_API_KEY: "not-used" });
  assert.equal(response.status, 403);
});

test("RPC proxy permits only same-origin and loopback fallback callers", () => {
  const worker = "https://erodoro-protocol.hypersettle.workers.dev/rpc";
  assert.equal(isAllowedRpcOrigin(null, worker), true);
  assert.equal(isAllowedRpcOrigin("https://erodoro-protocol.hypersettle.workers.dev", worker), true);
  assert.equal(isAllowedRpcOrigin("http://localhost:3000", worker), true);
  assert.equal(isAllowedRpcOrigin("http://127.0.2.2:3013", worker), true);
  assert.equal(isAllowedRpcOrigin("https://example.com", worker), false);
});

test("loopback preflight advertises the narrow RPC CORS policy", async () => {
  const request = new Request("https://erodoro-protocol.hypersettle.workers.dev/rpc", {
    method: "OPTIONS",
    headers: { origin: "http://localhost:3000" },
  });
  const response = await handleRpc(request, { HELIUS_API_KEY: "not-used" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.equal(response.headers.get("access-control-allow-methods"), "POST, OPTIONS");
});

test("waitlist email validation normalizes valid input and rejects malformed input", () => {
  assert.equal(normalizeWaitlistEmail("  Person@Example.COM "), "person@example.com");
  assert.equal(normalizeWaitlistEmail("not-an-email"), null);
  assert.equal(normalizeWaitlistEmail("person @example.com"), null);
});

test("waitlist stores normalized emails without exposing them in the response", async () => {
  const db = waitlistDb();
  const request = new Request("https://erodoro-protocol.hypersettle.workers.dev/waitlist", {
    method: "POST",
    headers: {
      origin: "https://erodoro-protocol.hypersettle.workers.dev",
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: "Person@Example.COM" }),
  });
  const response = await handleWaitlist(request, { WAITLIST_DB: db });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(db.entries.size, 1);
  assert.equal([...db.entries.values()][0].email, "person@example.com");
});

test("waitlist rejects invalid and cross-origin submissions", async () => {
  const db = waitlistDb();
  const invalid = await handleWaitlist(
    new Request("https://erodoro-protocol.hypersettle.workers.dev/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "wrong" }),
    }),
    { WAITLIST_DB: db },
  );
  assert.equal(invalid.status, 400);

  const crossOrigin = await handleWaitlist(
    new Request("https://erodoro-protocol.hypersettle.workers.dev/waitlist", {
      method: "POST",
      headers: { origin: "https://example.com", "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.com" }),
    }),
    { WAITLIST_DB: db },
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(db.entries.size, 0);
});

test("waitlist stops at exactly 100,000 unique entries but remains idempotent", async () => {
  const db = waitlistDb(Array.from({ length: WAITLIST_LIMIT }, (_, index) => `person-${index}@example.com`));
  const submit = (email) => handleWaitlist(
    new Request("https://erodoro-protocol.hypersettle.workers.dev/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }),
    { WAITLIST_DB: db },
  );

  const full = await submit("one-too-many@example.com");
  assert.equal(full.status, 409);
  assert.deepEqual(await full.json(), { error: "The waitlist has reached 100,000 people." });
  assert.equal(db.entries.size, WAITLIST_LIMIT);

  const existingEmail = "existing@example.com";
  const existingHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(existingEmail));
  const key = `email:${Array.from(new Uint8Array(existingHash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  db.entries.delete("seed:0");
  db.entries.set(key, { email: existingEmail });
  const duplicate = await submit(existingEmail);
  assert.equal(duplicate.status, 201);
  assert.equal(db.entries.size, WAITLIST_LIMIT);
});

test("database migration enforces the capacity inside the insert transaction", () => {
  const migration = fs.readFileSync(new URL("./migrations/0002_waitlist_capacity_counter.sql", import.meta.url), "utf8");
  assert.match(migration, /entry_count INTEGER NOT NULL/);
  assert.match(migration, /BEFORE INSERT ON waitlist_entries/);
  assert.match(migration, /entry_count.*>= 100000/s);
  assert.match(migration, /RAISE\(ABORT, 'WAITLIST_FULL'\)/);
  assert.match(migration, /AFTER INSERT ON waitlist_entries/);
  assert.match(migration, /entry_count = entry_count \+ 1/);
  assert.match(migration, /AFTER DELETE ON waitlist_entries/);
});
