import fs from "node:fs";
import path from "node:path";

/**
 * The hero still.
 *
 * The art is a photograph of an engraved share certificate cut along one
 * horizontal line: the lower portion lies flat and sharp, the upper portion
 * lifts away and breaks into drifting shards. That cut is the strike. What
 * stays is P, what leaves is N -- the picture is the product, not decoration
 * placed near it.
 *
 * Authored greyscale and tinted in CSS (`.hero-art` in `globals.css`) so one
 * asset serves both themes.
 *
 * The file is checked for at build time rather than assumed. This route ships
 * as a static export, so `fs` here runs during `next build` and never in a
 * browser; if the asset has not been dropped in yet the engraved fallback below
 * renders instead. A `<picture>` pointed at a missing file shows a broken-image
 * icon, which is a worse landing page than no photograph at all.
 */
const DIR = path.join(process.cwd(), "public", "hero");

/**
 * Which variants `scripts/prepare-hero.mjs` actually wrote.
 *
 * Read rather than assumed: the widths depend on how large the source was, and
 * whether AVIF exists depends on what encoder the machine that prepared it
 * had. A hardcoded list would point <source> at files that were never written.
 */
type Variants = { widths: number[]; height: number };

function variants(): Variants | null {
  const manifest = path.join(DIR, "variants.json");
  if (!fs.existsSync(manifest)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as Variants;
    return parsed.widths?.length ? parsed : null;
  } catch {
    return null;
  }
}

function sourceSet(widths: number[], extension: string) {
  const present = widths.filter((width) =>
    fs.existsSync(path.join(DIR, `certificate-${width}.${extension}`)),
  );
  if (!present.length) return null;
  return present.map((width) => `/hero/certificate-${width}.${extension} ${width}w`).join(", ");
}

export function HeroArt() {
  const built = variants();
  if (!built) return <EngravedFallback />;

  const avif = sourceSet(built.widths, "avif");
  const webp = sourceSet(built.widths, "webp");
  const jpg = sourceSet(built.widths, "jpg");

  if (!jpg) return <EngravedFallback />;
  const widest = Math.max(...built.widths);

  return (
    <picture>
      {avif && <source type="image/avif" srcSet={avif} sizes="100vw" />}
      {webp && <source type="image/webp" srcSet={webp} sizes="100vw" />}
      <img
        src={`/hero/certificate-${widest}.jpg`}
        srcSet={jpg}
        sizes="100vw"
        // Stated so the band reserves its height before the image arrives.
        // `next.config.ts` disables image optimisation, so nothing downstream
        // infers these for us.
        width={widest}
        height={Math.round((built.height / built.widths[0]) * widest)}
        fetchPriority="high"
        decoding="async"
        alt="An engraved share certificate cut along one horizontal line, the upper portion lifting away and breaking into drifting fragments."
        className="hero-art h-full w-full object-cover object-[center_34%]"
      />
    </picture>
  );
}

/**
 * What the band shows before the photograph exists: the same idea in line work.
 * A ruled sheet, a certificate outline, one cut, and the fragments above it.
 */
function EngravedFallback() {
  const shards = [
    "M300 176l58-30 12 44z",
    "M394 150l70-16-6 46z",
    "M486 140l64 6-22 42z",
    "M570 152l58 26-40 30z",
    "M250 200l40-8 4 30z",
    "M646 186l44 30-38 20z",
  ];
  return (
    <svg
      viewBox="0 0 960 412"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label="A ruled sheet with a certificate cut along one line, its upper portion breaking into fragments."
      className="hero-art h-full w-full"
    >
      <defs>
        <pattern id="hero-grid" width="16" height="16" patternUnits="userSpaceOnUse">
          <path d="M16 0H0v16" fill="none" stroke="currentColor" strokeWidth="0.5" opacity="0.16" />
        </pattern>
      </defs>
      <rect width="960" height="412" fill="url(#hero-grid)" className="text-text" />
      {/* The part that stays: whole, square, still on the sheet. */}
      <rect
        x="252" y="228" width="456" height="150"
        fill="none" stroke="currentColor" strokeWidth="1.25" className="text-text" opacity="0.75"
      />
      <rect
        x="266" y="242" width="428" height="122"
        fill="none" stroke="currentColor" strokeWidth="0.5" className="text-text" opacity="0.4"
      />
      {[262, 274, 286, 298].map((y) => (
        <path
          key={y}
          d={`M296 ${y}H664`}
          stroke="currentColor" strokeWidth="0.5" className="text-text" opacity="0.28"
        />
      ))}
      {/* The cut. */}
      <path d="M252 222H708" stroke="currentColor" strokeWidth="1.25" strokeDasharray="5 5" className="text-accent" />
      {/* The part that leaves. */}
      {shards.map((d) => (
        <path key={d} d={d} fill="none" stroke="currentColor" strokeWidth="1" className="text-text" opacity="0.5" />
      ))}
    </svg>
  );
}
