#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "deployments/program-artifacts.json"), "utf8"),
);
const platform = `${process.platform}-${process.arch}`;
const expectedPrograms = manifest.platforms?.[platform];

if (!expectedPrograms) {
  console.error(
    `No pinned program artifacts for ${platform}; recorded platforms: ${Object.keys(manifest.platforms ?? {}).join(", ") || "none"}`,
  );
  process.exit(1);
}

let failed = false;
console.log(`checking pinned program artifacts for ${platform}`);
for (const [name, expected] of Object.entries(expectedPrograms)) {
  const file = path.join(root, "target/deploy", `${name}.so`);
  if (!fs.existsSync(file)) {
    console.error(`${name}: missing ${file}; run make build first`);
    failed = true;
    continue;
  }
  const bytes = fs.readFileSync(file);
  const actual = {
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    console.error(
      `${name}: artifact changed (bytes ${expected.bytes} -> ${actual.bytes}, sha256 ${expected.sha256} -> ${actual.sha256})`,
    );
    failed = true;
  } else {
    console.log(`${name}: unchanged · ${actual.bytes} bytes · ${actual.sha256}`);
  }
}

if (failed) process.exit(1);
