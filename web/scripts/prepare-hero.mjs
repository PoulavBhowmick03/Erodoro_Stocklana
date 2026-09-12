// SPDX-License-Identifier: Apache-2.0
//
// Turn a dropped hero source image into the sizes and formats the page serves.
//
// `next.config.ts` sets `images: { unoptimized: true }` -- the export has no
// server, so nothing resizes or re-encodes at request time. Whatever ships is
// what every visitor downloads, at whatever size it happens to be. This does
// that work once, at authoring time.
//
// Drop the original at web/public/hero/source.<ext> and run:
//
//   node web/scripts/prepare-hero.mjs
//
// It writes certificate-{1600,2400}.{avif,webp,jpg}. The AVIF is what almost
// everyone gets; the JPEG exists so the <img> has a src that always resolves.

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const dir = path.resolve(import.meta.dirname, "..", "public", "hero");

/**
 * Preferred widths, filtered down to what the source can actually carry.
 *
 * Upscaling is the one thing this must not do quietly. An engraving is nothing
 * but fine lines, and resampling it up turns them into grey mush that looks
 * worse than the smaller file it came from -- while costing more bytes to say
 * so. If nothing qualifies, the source's own width is emitted instead.
 */
const PREFERRED = [1600, 2400];
const MAX_UPSCALE = 1.15;

const source = ["png", "jpg", "jpeg", "webp", "avif", "tif", "tiff"]
  .map((extension) => path.join(dir, `source.${extension}`))
  .find(fs.existsSync);

if (!source) {
  console.error(
    `No hero source found. Save the image as ${path.relative(process.cwd(), dir)}/source.png\n` +
      "(or .jpg/.webp/.tif) and run this again.",
  );
  process.exit(1);
}

try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  console.error("ffmpeg is required. brew install ffmpeg");
  process.exit(1);
}

const probe = JSON.parse(
  execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "json", source,
  ]).toString(),
).streams[0];

console.log(`source: ${path.basename(source)} — ${probe.width}×${probe.height}`);
if (probe.width < 2000) {
  // Not fatal: a smaller source still produces a usable 1600w. But a full-bleed
  // band on a 1440pt display at 2× wants real pixels, and upscaling an
  // engraving turns its finest lines to mush.
  console.warn(
    `warning: ${probe.width}px wide is thin for a full-bleed hero. ` +
      "Regenerating the source at 2400px or wider is worth it.",
  );
}

// The photograph is authored in colour and tinted to the theme in CSS, so the
// greyscale conversion happens here rather than in the browser: `filter` runs
// on every paint, and this way the bytes are smaller too.
const chain = (width) =>
  `scale=${width}:-2:flags=lanczos,format=gray,eq=contrast=1.04`;

const report = (file) => {
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`  ${path.basename(file).padEnd(26)} ${String(kb).padStart(5)} KB`);
};

let widths = PREFERRED.filter((width) => width <= probe.width * MAX_UPSCALE);
if (!widths.length) {
  widths = [probe.width - (probe.width % 2)];
  console.log(`emitting at the source's own ${widths[0]}px rather than upscaling`);
}

const produced = [];

/**
 * Which encoders this machine actually has.
 *
 * ffmpeg builds vary: Homebrew's ships no libwebp and, depending on the
 * formula, either libaom or libsvtav1 or neither. macOS `sips` writes AVIF
 * regardless. Rather than hardcode one toolchain and fail on someone else's
 * machine, this asks, then emits what it can and says what it skipped.
 */
function canSips() {
  try {
    return execFileSync("sips", ["--formats"]).toString().match(/public\.avif.*Writable/) !== null;
  } catch {
    return false;
  }
}
const sipsAvif = canSips();

for (const width of widths) {
  // The JPEG is produced first and everything else is derived from it: it is
  // the one format every ffmpeg build can write, and it is the `src` the <img>
  // falls back to, so if this fails there is nothing worth continuing for.
  const jpg = path.join(dir, `certificate-${width}.jpg`);
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-i", source,
    "-vf", chain(width), "-q:v", "4", "-frames:v", "1", jpg,
  ]);
  report(jpg);

  if (sipsAvif) {
    const avif = path.join(dir, `certificate-${width}.avif`);
    execFileSync("sips", ["-s", "format", "avif", "-s", "formatOptions", "70", jpg, "--out", avif], {
      stdio: "ignore",
    });
    report(avif);
  }

  produced.push(width);
}

if (!sipsAvif) {
  console.log("  (no AVIF encoder found — serving JPEG only)");
}

// The page reads this rather than assuming a fixed set of widths, so a source
// that only supports one variant produces a correct srcset instead of a
// <source> pointing at a file that was never written.
const manifest = path.join(dir, "variants.json");
fs.writeFileSync(
  manifest,
  JSON.stringify({ widths: produced, height: Math.round((probe.height / probe.width) * produced[0]) }, null, 2) + "\n",
);
console.log(`wrote ${path.basename(manifest)} — ${produced.join(", ")}`);
