import test from "node:test";
import assert from "node:assert/strict";

import { can, deriveCapabilities, whyNot } from "../lib/capabilities.ts";

/** A deployment where everything has been observed and everything is true. */
const proven = {
  network: "mainnet-beta",
  programsDeployed: true,
  sessionActive: true,
  exitInterfaceDeployed: true,
  binariesPinned: true,
  exitProven: true,
  oracleMinSignatures: 5,
};

/** Today's devnet: trading works, nothing about custody exit is established. */
const devnet = {
  network: "devnet",
  programsDeployed: true,
  sessionActive: true,
  exitInterfaceDeployed: null,
  binariesPinned: false,
  exitProven: false,
  oracleMinSignatures: 0,
};

const evidence = (overrides) => ({ ...devnet, ...overrides });

test("an unverified cluster grants nothing, not even reads", () => {
  const caps = deriveCapabilities(evidence({ network: null }));
  assert.equal(can(caps, "trading.read"), false);
  assert.equal(can(caps, "trading.write"), false);
  assert.equal(can(caps, "custody.exit"), false);
  assert.match(whyNot(caps, "trading.read"), /not been verified/);
});

test("undeployed programs are reported as such rather than as an empty market", () => {
  const caps = deriveCapabilities(evidence({ programsDeployed: false }));
  assert.equal(can(caps, "trading.read"), false);
  assert.match(whyNot(caps, "trading.read"), /not deployed/);
  // The reason propagates, so a disabled order button explains the real cause
  // rather than blaming the session.
  assert.match(whyNot(caps, "trading.write"), /not deployed/);
});

test("an outstanding deployment check never disables trading", () => {
  const caps = deriveCapabilities(evidence({ programsDeployed: null }));
  // Absence of evidence is not evidence of absence. A check that has not come
  // back yet must not read as "the protocol is missing" -- that turns one slow
  // RPC call into a permanently dead order button, which is exactly what the
  // journey suite caught when this was written the other way round.
  assert.equal(can(caps, "trading.read"), true);
  assert.equal(can(caps, "trading.write"), true);
});

test("an unsafe settlement feed withholds custody exit however well it was proved", () => {
  const caps = deriveCapabilities({ ...proven, oracleMinSignatures: 0 });
  assert.equal(can(caps, "trading.read"), true);
  assert.equal(can(caps, "trading.write"), true);
  // Everything about the exit path itself is in place. The price the exit pays
  // out against is not, and that is enough.
  assert.equal(can(caps, "custody.exit"), false);
  assert.equal(can(caps, "custody.claim"), false);
  assert.match(whyNot(caps, "custody.exit"), /Settlement pricing is not trustworthy/);
  assert.match(whyNot(caps, "custody.exit"), /no minimum signature threshold/);
});

test("an unread settlement feed is not treated as a safe one", () => {
  const caps = deriveCapabilities({ ...proven, oracleMinSignatures: null });
  assert.equal(can(caps, "custody.exit"), false);
  assert.match(whyNot(caps, "custody.exit"), /has not been read yet/);
});

test("no live session means reads but no writes", () => {
  const caps = deriveCapabilities(evidence({ sessionActive: false }));
  assert.equal(can(caps, "trading.read"), true);
  assert.equal(can(caps, "trading.write"), false);
  assert.match(whyNot(caps, "trading.write"), /live execution/);
});

test("today's devnet can trade but cannot return custody", () => {
  const caps = deriveCapabilities(devnet);
  assert.equal(can(caps, "trading.read"), true);
  assert.equal(can(caps, "trading.write"), true);
  assert.equal(can(caps, "custody.exit"), false);
  assert.equal(can(caps, "custody.claim"), false);
  assert.match(whyNot(caps, "custody.exit"), /has not been checked/);
});

test("every unmet custody condition is nameable on its own", () => {
  const unchecked = deriveCapabilities(evidence({ exitInterfaceDeployed: null }));
  assert.match(whyNot(unchecked, "custody.exit"), /not been checked/);

  const missing = deriveCapabilities(evidence({ exitInterfaceDeployed: false }));
  assert.match(whyNot(missing, "custody.exit"), /do not expose the exit interface/);

  const unpinned = deriveCapabilities(
    evidence({ exitInterfaceDeployed: true, binariesPinned: false }),
  );
  assert.match(whyNot(unpinned, "custody.exit"), /reproduced and pinned/);

  const unproven = deriveCapabilities(
    evidence({ exitInterfaceDeployed: true, binariesPinned: true, exitProven: false }),
  );
  assert.match(whyNot(unproven, "custody.exit"), /has not been executed/);
});

test("claiming can never outrun exiting", () => {
  // Claim is downstream of exit by construction: there is nothing to claim
  // until custody has actually been released.
  for (const overrides of [
    { exitInterfaceDeployed: false },
    { exitInterfaceDeployed: true, binariesPinned: false },
    { exitInterfaceDeployed: true, binariesPinned: true, exitProven: false },
  ]) {
    const caps = deriveCapabilities(evidence(overrides));
    assert.equal(can(caps, "custody.claim"), false, JSON.stringify(overrides));
    assert.equal(whyNot(caps, "custody.claim"), whyNot(caps, "custody.exit"));
  }
});

test("a fully proven deployment grants custody exit and claim", () => {
  const caps = deriveCapabilities(proven);
  assert.equal(can(caps, "custody.exit"), true);
  assert.equal(can(caps, "custody.claim"), true);
  assert.equal(can(caps, "oracle.acceptable"), true);
});

test("an unread oracle is withheld rather than assumed acceptable", () => {
  const caps = deriveCapabilities(evidence({ oracleMinSignatures: null }));
  assert.equal(can(caps, "oracle.acceptable"), false);
  assert.match(whyNot(caps, "oracle.acceptable"), /has not been read/);
});

test("a zero signature threshold is never acceptable", () => {
  const caps = deriveCapabilities(evidence({ oracleMinSignatures: 0 }));
  assert.equal(can(caps, "oracle.acceptable"), false);
  assert.match(whyNot(caps, "oracle.acceptable"), /no minimum signature threshold/);
});

test("demo fixtures exist on devnet and nowhere else", () => {
  assert.equal(can(deriveCapabilities(devnet), "demo.fixtures"), true);
  assert.equal(can(deriveCapabilities(proven), "demo.fixtures"), false);
  assert.equal(
    can(deriveCapabilities(evidence({ network: null })), "demo.fixtures"),
    false,
  );
});

test("mainnet does not grant custody exit merely for being mainnet", () => {
  // The whole point of the model: the network name is not evidence.
  const caps = deriveCapabilities({
    ...proven,
    exitInterfaceDeployed: true,
    binariesPinned: false,
    exitProven: false,
  });
  assert.equal(can(caps, "custody.exit"), false);
});
