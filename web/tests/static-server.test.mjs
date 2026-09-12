import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveExportPath } from "./static-server.mjs";

const root = path.resolve("/tmp/erodoro-static-test/out");

test("static export paths remain inside the resolved root", () => {
  assert.equal(resolveExportPath(root, "/index.html"), path.join(root, "index.html"));
  assert.equal(
    resolveExportPath(`${root}/../out`, "/markets/index.html?flight=1"),
    path.join(root, "markets/index.html"),
  );
});

test("a sibling directory sharing the root prefix is rejected", () => {
  assert.equal(resolveExportPath(root, "/../out2/secret.txt"), null);
  assert.equal(resolveExportPath(root, "/%2e%2e/out2/secret.txt"), null);
});

test("malformed URL encoding is rejected by the request boundary", () => {
  assert.throws(() => resolveExportPath(root, "/%E0%A4%A"), URIError);
});
