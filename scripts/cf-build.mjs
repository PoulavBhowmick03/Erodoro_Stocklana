#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Build the front end during `pnpm install`, but only on Cloudflare.
//
// Workers Builds runs three steps: clone, install, then the deploy command. The
// build step in between exists only if a Build command is set in the dashboard,
// and that setting is not in this repository, cannot be reviewed, and was in
// fact empty. The whole failure was:
//
//   Installing project dependencies: pnpm install --frozen-lockfile
//   Executing user deploy command: npx wrangler deploy
//   ✘ [ERROR] The directory specified by the "assets.directory" field
//             does not exist: /opt/buildhome/repo/web/out
//
// Install ran, deploy ran, nothing in between ever produced `web/out`.
//
// Install is a step that always runs, so hanging the build off it makes a
// checkout sufficient on its own: clone the repo, connect it, and it deploys.
// Nothing to configure and nothing to forget.
//
// This is deliberately a no-op everywhere else. A postinstall hook that
// silently ran a Next build on every local `pnpm install` would be a bad
// trade for the convenience.

import { spawnSync } from "node:child_process";

/**
 * Cloudflare's build image, identified two ways.
 *
 * `WORKERS_CI` is the documented marker. The `/opt/buildhome` path is the
 * belt: it is where the image checks the repository out, visible in the build
 * log above, and it does not depend on an environment variable name staying
 * stable across a product rename.
 */
const onCloudflare =
  process.env.WORKERS_CI === "1" ||
  process.env.CF_PAGES === "1" ||
  process.env.HOME === "/opt/buildhome" ||
  process.cwd().startsWith("/opt/buildhome");

if (!onCloudflare) {
  process.exit(0);
}

console.log("[cf-build] Cloudflare build environment detected, building web/out");

for (const args of [
  ["--dir", "web", "install", "--no-frozen-lockfile"],
  ["--dir", "web", "build"],
]) {
  const r = spawnSync("pnpm", args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[cf-build] pnpm ${args.join(" ")} exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

console.log("[cf-build] web/out is ready for wrangler deploy");
