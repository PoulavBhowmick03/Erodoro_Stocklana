/**
 * Deterministic chain, by recording a real one once and replaying it forever.
 *
 * The alternative was hand-building Manifest market accounts, and that is not
 * a test harness -- it is a second, unverified implementation of a binary
 * layout the SDK is the only real authority on. A fixture that decodes wrong
 * proves nothing, and a fixture that has to be updated by hand every time the
 * layout moves gets deleted within a month.
 *
 * So: record against devnet once, replay from disk after that. The fixtures are
 * real encoded accounts, the decode path under test is the production one, and
 * no test needs the network.
 *
 * # Ordering matters, so responses are sequenced
 *
 * The same request is asked repeatedly and the answer legitimately changes --
 * a market account before and after an order is the obvious case. Keying purely
 * by request would collapse those into one answer and make it impossible to
 * test anything that changes state. Each key therefore holds the responses in
 * the order they were seen, and replay walks that list. Running past the end
 * repeats the last one, which is the correct steady state for a page that keeps
 * polling after the action finished.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const FIXTURES = path.resolve("tests/fixtures");

/** Endpoints worth intercepting. Everything else is served from `out/`. */
const CHAIN_HOSTS = [/helius-rpc\.com/, /magicblock\.app/, /solana\.com/, /rpcpool\.com/];

const isChainRequest = (url) => CHAIN_HOSTS.some((pattern) => pattern.test(url));

/**
 * Methods whose parameters are a serialized transaction.
 *
 * Those bytes carry a fresh blockhash and a fresh signature on every run, so
 * they are different every time by construction. Keying on them would mean a
 * recorded write never matches on replay -- which is exactly how the first
 * recording produced a fixture that could not replay a single send.
 */
const OPAQUE_PARAMS = new Set(["sendTransaction", "simulateTransaction", "getFeeForMessage"]);

/** A stable identity for a JSON-RPC call, ignoring the volatile id. */
function keyFor(url, body) {
  const host = new URL(url).host;
  const calls = Array.isArray(body) ? body : [body];
  const summary = calls.map((call) => ({
    method: call?.method,
    // `params` carries pubkeys and commitments, which are what make a call
    // distinct. The request id is a counter and would defeat all matching.
    params: OPAQUE_PARAMS.has(call?.method) ? "opaque" : call?.params,
  }));
  return `${host}:${crypto
    .createHash("sha1")
    .update(JSON.stringify(summary))
    .digest("hex")
    .slice(0, 16)}`;
}

function fixturePath(name) {
  return path.join(FIXTURES, `${name}.json`);
}

export function hasFixture(name) {
  return fs.existsSync(fixturePath(name));
}

/**
 * Install the interceptor.
 *
 * `mode` is "record" or "replay". Recording passes through to the real
 * endpoint and writes what came back; replaying never touches the network and
 * fails loudly on a request it has no answer for, so a test cannot silently
 * start depending on devnet again.
 */
export async function installChainFixture(context, name, mode = "replay", options = {}) {
  const file = fixturePath(name);
  const recorded = mode === "replay" && fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  const captured = {};
  const cursor = new Map();
  const missing = [];

  await context.route(
    (url) => isChainRequest(url.href ?? String(url)),
    async (route) => {
      // A page can close while requests are still in the air, and fulfilling a
      // route belonging to a closed context throws. That is noise, not a
      // finding, so it is swallowed here rather than failing a scenario that
      // already finished.
      try {
        await handle(route);
      } catch {
        // The context went away mid-flight.
      }
    },
  );

  async function handle(route) {
    {
      const request = route.request();
      let body = null;
      try {
        body = JSON.parse(request.postData() ?? "null");
      } catch {
        body = null;
      }
      if (!body) return route.continue();

      // Failure injection lives inside this one handler rather than in a
      // second route. Two handlers would race over precedence, and the method
      // being injected on is in the request body, not the URL, so a URL matcher
      // could not select it anyway.
      const calls = Array.isArray(body) ? body : [body];
      const injected = options.intercept?.(
        calls.map((call) => call?.method),
        request.url(),
      );
      if (injected) {
        return route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            Array.isArray(body)
              ? body.map((call) => ({ jsonrpc: "2.0", id: call.id, ...injected }))
              : { jsonrpc: "2.0", id: body.id, ...injected },
          ),
        });
      }

      const key = keyFor(request.url(), body);

      if (mode === "record") {
        const response = await route.fetch();
        const text = await response.text();
        (captured[key] ??= []).push(text);
        return route.fulfill({
          status: response.status(),
          headers: { "content-type": "application/json" },
          body: text,
        });
      }

      const answers = recorded[key];
      if (!answers?.length) {
        missing.push({ key, methods: (Array.isArray(body) ? body : [body]).map((c) => c?.method) });
        // A JSON-RPC error is more useful than a hang: the app renders its own
        // failure path and the test still finishes.
        return route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            Array.isArray(body)
              ? body.map((call) => ({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "no fixture" } }))
              : { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "no fixture" } },
          ),
        });
      }

      const index = cursor.get(key) ?? 0;
      cursor.set(key, index + 1);
      // Past the end, repeat the last answer: that is the steady state a page
      // which keeps polling should keep seeing.
      const answer = answers[Math.min(index, answers.length - 1)];
      return route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: answer,
      });
    }
  }

  return {
    /** Write what was recorded. No-op while replaying. */
    save() {
      if (mode !== "record") return;
      fs.mkdirSync(FIXTURES, { recursive: true });
      // Merge: a run records several scenarios in separate browser contexts,
      // and each has to contribute to the same replayable chain.
      const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      for (const [key, answers] of Object.entries(captured)) {
        const known = existing[key] ?? [];
        // Only extend: a longer observed sequence for the same request is the
        // more complete one, and truncating it would lose a state change.
        existing[key] = answers.length > known.length ? answers : known;
      }
      fs.writeFileSync(file, JSON.stringify(existing, null, 1));
    },
    /** Requests replay had no answer for. A healthy fixture has none. */
    missing,
  };
}
