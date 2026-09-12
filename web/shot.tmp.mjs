import { chromium } from "playwright";
import { serveStaticExport } from "./tests/static-server.mjs";
import path from "path";
const close = await serveStaticExport(4456, path.resolve("out"));
const b = await chromium.launch();
const out = process.argv[2];
for (const [theme, w, h, tag] of [["light",1440,900,"light"],["dark",1440,900,"dark"],["light",390,844,"mobile"]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await ctx.addInitScript((t) => { try { localStorage.setItem("erodoro.theme", t); } catch {} }, theme);
  const page = await ctx.newPage();
  await page.goto("http://localhost:4456/", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${tag}-1.png` });
  for (const [i, y] of [[2, 1500], [3, 3000], [4, 5200]]) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/${tag}-${i}.png` });
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${tag}-5.png` });
  await ctx.close();
}
await b.close(); close();
console.log("done");
