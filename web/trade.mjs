import { chromium } from "playwright";
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1300, height: 1200 } })).newPage();
const log = [];
page.on("console", (m) => m.type() === "error" && log.push("ERR " + m.text().slice(0, 160)));

const status = async () => {
  const t = await page.locator("main").innerText();
  const m = t.match(/(confirmed · \S+|Not enough[^\n]*|Too early[^\n]*|You rejected[^\n]*|Fast mode is on[^\n]*|This contract[^\n]*|[A-Z][^\n]*failed[^\n]*|Error[^\n]*|Simulation[^\n]*)/);
  return m ? m[1].slice(0, 150) : "(no status)";
};

await page.goto("http://localhost:3000/app", { waitUntil: "networkidle" });
const skip = page.getByRole("button", { name: "Skip" });
if (await skip.isVisible().catch(() => false)) await skip.click();
await page.locator('[data-tour="test-keys"]').getByRole("button", { name: /^seller/ }).click();
await page.waitForTimeout(4000);
await page.locator('[data-tour="series-card"]', { hasText: "7fk5" }).first().click();
await page.waitForTimeout(3000);

// 1. lock collateral -> P and N
await page.getByLabel("How much to lock").fill("10");
await page.getByRole("button", { name: "Lock", exact: true }).click();
await page.waitForTimeout(9000);
console.log("1 lock       :", await status());

// 2. deposit N into escrow
await page.getByLabel("N amount").fill("10");
await page.getByRole("button", { name: "Deposit" }).click();
await page.waitForTimeout(9000);
console.log("2 deposit N  :", await status());

// 3. sell N at 2.00
await page.getByLabel("Price").fill("2");
await page.getByLabel("Size").fill("5");
await page.getByRole("button", { name: "Sell N" }).click();
await page.waitForTimeout(9000);
console.log("3 sell order :", await status());
console.log("   book now  :", (await page.locator('[data-tour="book"]').first().innerText()).split("\n").slice(0,6).join(" | "));

// 4. switch to buyer
await page.locator('[data-tour="test-keys"]').getByRole("button", { name: /^buyer/ }).click();
await page.waitForTimeout(5000);
console.log("4 as buyer   : signer line ->", ((await page.locator("main").innerText()).match(/Signing as \w+/) ?? ["?"])[0]);
console.log("   sees       :", (await page.locator("main").innerText()).includes("Lock or unlock") ? "seller controls still shown" : "no seller controls");

// 5. buyer deposits cash and fills
await page.getByLabel("Cash amount").fill("50");
await page.getByRole("button", { name: "Deposit" }).click();
await page.waitForTimeout(9000);
console.log("5 deposit $  :", await status());

const fill = page.getByRole("button", { name: "Fill" });
console.log("6 fill button:", (await fill.count()) ? "present" : "MISSING");
if (await fill.count()) {
  await fill.first().click();
  await page.waitForTimeout(9000);
  console.log("   fill      :", await status());
}
console.log("\nconsole:", log.length ? log.slice(0,6).join("\n") : "none");
await b.close();
