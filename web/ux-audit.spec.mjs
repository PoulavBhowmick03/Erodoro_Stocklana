// Exhaustive interaction audit of the built static export.
//
// Walks every route in both themes and both viewports, clicks every control it
// can reach, and fails on anything that throws, overflows the viewport, gets
// clipped by it, renders below the WCAG AA contrast floor, or sits disabled
// with no explanation of why.
//
// It complements `tour.spec.mjs`: that suite asserts the information
// architecture is what we intended, this one asserts the result is actually
// usable. Between them they caught a hydration mismatch on every dark-theme
// load, a wallet button clipped off the right edge of every phone, a devnet
// menu hanging 140px off the left edge, and filled buttons rendering white
// labels on light fills at 2.3:1.
import { chromium } from "playwright";
import fs from "node:fs";
import { createRequire } from "node:module";
import { serveStaticExport } from "./tests/static-server.mjs";

/**
 * The custom checks below cover what a generic engine cannot know about this
 * product -- a disabled control with no stated reason, a control clipped by the
 * viewport, the exact contrast of our own tokens. axe covers the standards
 * conformance they were never meant to replace: roles, names, labels, landmark
 * structure, duplicate ids.
 *
 * Injected as source rather than imported into the page, because the page is a
 * static export with no bundler available to it at test time.
 */
const AXE_SOURCE = fs.readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

const PORT = 4318;
const closeServer = await serveStaticExport(PORT);
const BASE = `http://localhost:${PORT}`;
const ROUTES = ["/", "/app", "/portfolio", "/mint", "/admin/registry", "/trade/markets"];

const problems = [];
const note = (route, kind, detail) => problems.push({ route, kind, detail });

// Chain noise we cannot fix from the UI and that does not represent a defect.
const IGNORE =
  /429|Failed to load resource|rate.?limit|ERR_ABORTED|favicon|Download the React DevTools|scroll-behavior/i;

const browser = await chromium.launch();

async function session({ theme, width, height, label }) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript(
    ([t]) => {
      try {
        localStorage.setItem("erodoro.theme", t);
        localStorage.setItem("erodoro.testWallet", "seller");
        localStorage.setItem("erodoro.tour.v1", "1");
      } catch {}
    },
    [theme],
  );
  const page = await ctx.newPage();
  let route = "(none)";
  page.on("pageerror", (e) => note(route, "pageerror", e.message.slice(0, 200)));
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "error" && !IGNORE.test(text)) note(route, "console", text.slice(0, 200));
    if (/hydration failed|didn't match/i.test(text)) note(route, "hydration", text.slice(0, 200));
  });

  for (const path of ROUTES) {
    route = `${label}${path}`;
    await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) =>
      note(route, "navigation", e.message.slice(0, 120)),
    );
    await page.waitForTimeout(2_500);

    // The theme the page actually painted must match what was stored.
    const applied = await page.evaluate(() => document.documentElement.dataset.theme);
    if (applied !== theme) note(route, "theme", `stored ${theme}, applied ${applied}`);

    await audit(page, route);
    await accessibility(page, route);

    // Click everything reachable, one control at a time, re-reading the page
    // between clicks because each click may replace the tree.
    const count = await page.locator("button:visible").count();
    for (let index = 0; index < Math.min(count, 40); index += 1) {
      const control = page.locator("button:visible").nth(index);
      const name = await control.textContent().catch(() => "");
      const aria = (await control.getAttribute("aria-label").catch(() => "")) ?? "";
      if (/theme/i.test(aria)) continue;
      const disabled = await control.isDisabled().catch(() => true);
      if (disabled) {
        // A disabled control has to say why, or it just looks broken.
        const why = await control.getAttribute("title");
        if (!why) note(route, "silent-disabled", `"${(name ?? "").trim().slice(0, 40)}"`);
        continue;
      }
      await control.click({ timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(220);
    }
    await page.waitForTimeout(700);
    await audit(page, `${route} (after clicks)`);
    if (process.env.SHOTS) {
      await page.screenshot({
        path: `${process.env.SHOTS}/${label.replace(/\W+/g, "")}${path.replace(/\W+/g, "-") || "-root"}.png`,
        fullPage: true,
      }).catch(() => {});
    }
  }
  await ctx.close();
}

/**
 * Standards conformance, from axe.
 *
 * Only violations that are certain are failed on: axe's "incomplete" results
 * are things it could not decide, and treating a maybe as a failure would train
 * everyone to ignore the suite.
 */
async function accessibility(page, route) {
  const results = await page
    .evaluate(async (source) => {
      // eslint-disable-next-line no-eval
      if (!window.axe) new Function(source)();
      const run = await window.axe.run(document, {
        resultTypes: ["violations"],
        rules: {
          // Colour is checked by our own tokens-aware pass below, which
          // understands the theme variables axe cannot resolve.
          "color-contrast": { enabled: false },
        },
      });
      return run.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.slice(0, 2).map((node) => node.html.slice(0, 90)),
      }));
    }, AXE_SOURCE)
    .catch((error) => [{ id: "axe-failed", impact: "serious", help: error.message, nodes: [] }]);

  for (const violation of results) {
    if (violation.impact === "minor") continue;
    note(
      route,
      `a11y:${violation.id}`,
      `${violation.help} — ${violation.nodes.join(" | ")}`,
    );
  }
}

/** Layout and legibility checks that do not depend on chain data. */
async function audit(page, route) {
  const found = await page.evaluate(() => {
    const out = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 2) {
      out.push({ kind: "h-overflow", detail: `${doc.scrollWidth} > ${doc.clientWidth}` });
    }

    // A control cut off by the viewport edge does not widen the document, so
    // `scrollWidth` never notices it. The mobile header clipped its own wallet
    // button this way, which is the single control a visitor cannot work
    // around, and every automated check passed.
    for (const el of document.querySelectorAll("button,a,input,select,[role='button']")) {
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || Number(style.opacity) < 0.1) continue;
      if (b.left < -1 || b.right > doc.clientWidth + 1) {
        out.push({
          kind: "clipped-control",
          detail: `${el.tagName} "${(el.textContent ?? "").trim().slice(0, 28)}" x=${Math.round(b.left)}..${Math.round(b.right)} of ${doc.clientWidth}`,
        });
      }
    }

    // Colours reach us as rgb(), rgba(), oklab() and color-mix() results.
    // Regex-scraping the numbers out of an oklab() string yields nonsense, so
    // let the browser rasterise each value and read the pixel back instead.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.globalCompositeOperation = "copy";
    const rgba = (value) => {
      try {
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      } catch {
        return null;
      }
    };
    const over = (fg, bg) =>
      [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));

    // Walk up compositing every partially transparent layer, so text on a
    // translucent header is measured against what is actually behind it.
    const backdrop = (el) => {
      const layers = [];
      // Starts at the element itself: a button paints its own background, and
      // that is what its label actually sits on.
      for (let node = el; node; node = node.parentElement) {
        const c = rgba(getComputedStyle(node).backgroundColor);
        if (!c || c[3] === 0) continue;
        layers.push(c);
        if (c[3] >= 0.999) break;
      }
      let base = [255, 255, 255];
      for (const layer of layers.reverse()) base = over(layer, base);
      return base;
    };

    const luminance = ([r, g, b]) =>
      [r, g, b]
        .map((c) => c / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);

    for (const el of document.querySelectorAll("p,span,h1,h2,h3,h4,dt,dd,td,th,button,a,label,li")) {
      // Decorative text can use image compositing that computed styles cannot
      // measure. It is absent from the accessibility tree by contract, so it
      // is not readable content this contrast pass can make a claim about.
      if (el.closest('[aria-hidden="true"]')) continue;
      const text = el.textContent?.trim();
      if (!text || el.children.length) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || Number(style.opacity) < 0.15) continue;

      const fg = rgba(style.color);
      if (!fg || fg[3] < 0.1) continue;
      const bg = backdrop(el);
      const composited = over(fg, bg);
      const a = luminance(composited);
      const b = luminance(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5) - 0.05) {
        out.push({
          kind: "contrast",
          detail: `${ratio.toFixed(2)}:1 ${style.fontSize} "${text.slice(0, 34)}"`,
        });
      }
    }
    return out;
  });
  const seen = new Set();
  for (const f of found) {
    const key = `${f.kind}:${f.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    note(route, f.kind, f.detail);
  }
}

await session({ theme: "light", width: 1440, height: 900, label: "light-desktop " });
await session({ theme: "dark", width: 1440, height: 900, label: "dark-desktop " });
await session({ theme: "light", width: 390, height: 844, label: "light-mobile " });
await session({ theme: "dark", width: 390, height: 844, label: "dark-mobile  " });

await browser.close();
closeServer();

const grouped = new Map();
for (const p of problems) {
  const key = `${p.kind} · ${p.detail}`;
  if (!grouped.has(key)) grouped.set(key, new Set());
  grouped.get(key).add(p.route);
}
console.log(`\n===== ${grouped.size} distinct findings (${problems.length} total) =====`);
for (const [key, routes] of [...grouped].sort()) {
  console.log(`\n${key}\n   ${[...routes].slice(0, 4).join(", ")}`);
}
process.exit(grouped.size ? 1 : 0);
