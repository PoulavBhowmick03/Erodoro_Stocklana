// Verify every account name lib/actions.ts passes actually exists on the
// instruction it targets. Anchor resolves some accounts automatically, so a
// *missing* name may be fine — but a misspelled one is always a bug, and it
// would otherwise only surface when a user signs.
import fs from "fs";
import path from "path";

const root = path.resolve(import.meta.dirname, "..");
const idl = (n) => JSON.parse(fs.readFileSync(path.join(root, `lib/idl/${n}.json`), "utf8"));
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const accountsOf = (i, name) => {
  const ix = i.instructions.find((x) => camel(x.name) === camel(name));
  if (!ix) throw new Error(`instruction ${name} not found in IDL`);
  return new Set(ix.accounts.map((a) => camel(a.name)));
};

// The exact account maps lib/actions.ts builds, including the shared ones.
const CALLS = [
  ["series", "split", ["holder","series","collateralMint","collateralVault","holderCollateral","pMint","nMint","receiverP","receiverN","feeVault","collateralTokenProgram","tokenProgram"]],
  ["series", "merge", ["holder","series","collateralMint","collateralVault","holderCollateral","pMint","nMint","holderP","holderN","collateralTokenProgram","tokenProgram"]],
  ["series", "redeemP", ["holder","series","settlement","collateralMint","collateralVault","holderCollateral","collateralTokenProgram","tokenProgram","pMint","holderP"]],
  ["series", "redeemN", ["holder","series","settlement","collateralMint","collateralVault","holderCollateral","collateralTokenProgram","tokenProgram","nMint","holderN"]],
  ["series", "settle", ["payer","series","settlement","collateralMint","collateralVault","pMint","nMint","oracleAdapter","priceSource","systemProgram"]],
  ["market", "deposit", ["trader","market","book","baseVault","quoteVault","traderBase","traderQuote","tokenProgram"]],
  ["market", "withdraw", ["trader","market","book","baseVault","quoteVault","traderBase","traderQuote","tokenProgram"]],
  ["market", "placeOrder", ["trader","market","book"]],
  ["market", "cancelOrder", ["trader","market","book"]],
  ["market", "fillOrder", ["trader","market","book"]],
  // Session control. `delegateBook` names only the accounts it passes
  // explicitly; the PDAs and programs around it are resolved by Anchor, and
  // the validator arrives through remaining_accounts rather than the map.
  ["market", "delegateBook", ["payer","market","book"]],
  ["market", "commitBook", ["payer","book"]],
  ["market", "undelegateBook", ["payer","book"]],
];

const idls = { series: idl("series"), market: idl("market") };
let bad = 0;

for (const [prog, method, used] of CALLS) {
  const valid = accountsOf(idls[prog], method);
  const unknown = used.filter((u) => !valid.has(u));
  const missing = [...valid].filter((v) => !used.includes(v));
  if (unknown.length) {
    bad++;
    console.log(`  ✗ ${prog}.${method}: unknown account(s) ${unknown.join(", ")}`);
  } else {
    const note = missing.length ? ` (auto-resolved: ${missing.join(", ")})` : "";
    console.log(`  ✓ ${prog}.${method}: ${used.length} accounts valid${note}`);
  }
}

// The names `lib/use-series.ts` passes to `program.coder.accounts.decode`.
//
// `Program`'s constructor normalises IDL account names to camelCase, so the
// coder it exposes answers to `seriesConfig` while the IDL spells it
// `SeriesConfig` -- and a `BorshAccountsCoder` built straight from that IDL
// answers to the PascalCase form instead. The two disagree. Passing the wrong
// one throws on every decode, and because a decode failure is deliberately
// tolerated there (one bad account must not blank the list) the symptom is an
// empty markets table rather than an error. Cheap to assert, expensive to find.
const DECODED = [
  ["series", "seriesConfig"],
  ["series", "settlement"],
];

for (const [prog, account] of DECODED) {
  // Anchor lowercases the leading character too, which `camel` (built for
  // snake_case instruction names) does not.
  const lowerFirst = (n) => n.charAt(0).toLowerCase() + n.slice(1);
  const names = new Set((idls[prog].accounts ?? []).map((a) => lowerFirst(camel(a.name))));
  if (names.has(account)) {
    console.log(`  ✓ ${prog} decodes ${account}`);
  } else {
    bad++;
    console.log(
      `  ✗ ${prog}: no account decodes as ${account} (have: ${[...names].join(", ")})`,
    );
  }
}

console.log(bad === 0 ? "\nall account maps match the deployed IDLs" : `\n${bad} mismatched`);
process.exit(bad === 0 ? 0 : 1);
