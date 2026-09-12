// SPDX-License-Identifier: Apache-2.0
//
// §15, executed rather than remembered.
//
// Everything about the collateral mint is mutable by its issuer, and a
// checklist in a README is only as good as whoever last read it. This reads
// the live mint and the live feed configs and fails loudly on anything that
// would make a deployment unsafe.
//
//   pnpm preflight --mint <pubkey> [--maturity <unix-ts>] [--feed <pubkey>]...
//                  [--url <rpc>] [--vault <pubkey>]...
//
// Exits non-zero if any check fails. Warnings do not fail the run but are
// things a human has to have seen.

import * as anchor from "@coral-xyz/anchor";
const BN = (anchor as any).BN ?? (anchor as any).default.BN;
import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getPausableConfig,
  getPermanentDelegate,
  getScaledUiAmountConfig,
  getTransferHook,
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const PYTH_RECEIVER_ID = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** SPL Governance and Squads v3/v4 — the program owners a real multisig has. */
const KNOWN_MULTISIG_OWNERS = new Set([
  "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw",
  "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu",
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
]);
const PRICE_UPDATE_V2_DISCRIMINATOR = Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]);

type Level = "pass" | "warn" | "fail";
const results: { level: Level; message: string }[] = [];
const record = (level: Level, message: string) => results.push({ level, message });
const pass = (m: string) => record("pass", m);
const warn = (m: string) => record("warn", m);
const fail = (m: string) => record("fail", m);

function args(): { [k: string]: string[] } {
  const out: { [k: string]: string[] } = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    (out[key] ||= []).push(argv[i + 1]);
    i++;
  }
  return out;
}

async function main() {
  const a = args();
  const url = a.url?.[0] ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(url, "confirmed");

  if (!a.mint?.[0]) {
    console.error("usage: pnpm preflight --mint <pubkey> [--maturity <ts>] [--feed <pubkey>]...");
    process.exit(2);
  }
  const mintKey = new PublicKey(a.mint[0]);
  const maturity = a.maturity?.[0] ? Number(a.maturity[0]) : null;

  console.log(`\npreflight against ${url}`);
  console.log(`collateral mint ${mintKey.toBase58()}\n`);

  // --- the five extensions --------------------------------------------
  const mint = await getMint(connection, mintKey, "confirmed", TOKEN_2022_PROGRAM_ID);

  if (!mint.isInitialized) fail("mint is not initialized");

  // The one that can leave P short at maturity through no fault of the
  // contract. Its presence is not a blocker — it is the product — but it has
  // to be seen, and it has to be in the UI.
  const delegate = getPermanentDelegate(mint);
  if (delegate?.delegate && !delegate.delegate.equals(PublicKey.default)) {
    warn(
      `permanentDelegate is ACTIVE (${delegate.delegate.toBase58()}). The issuer can move or ` +
        `burn collateral out of any vault with no consent. This must appear in the UI and the ` +
        `market manifest as a headline risk.`
    );
  } else {
    pass("permanentDelegate is not set");
  }

  const pausable = getPausableConfig(mint);
  if (pausable) {
    if (pausable.paused) {
      fail("mint is PAUSED — no split, merge or redemption can settle collateral");
    } else {
      pass(`pausableConfig present, not paused (authority ${pausable.authority.toBase58()})`);
    }
  } else {
    pass("no pausableConfig");
  }

  if (mint.freezeAuthority) {
    warn(
      `freeze authority is ACTIVE (${mint.freezeAuthority.toBase58()}). Any vault token account ` +
        `can be frozen individually.`
    );
  } else {
    pass("no freeze authority");
  }

  const hook = getTransferHook(mint);
  if (hook && hook.programId && !hook.programId.equals(PublicKey.default)) {
    warn(
      `transferHook is ARMED (${hook.programId.toBase58()}). Confirm the hook permits the series ` +
        `PDA as an authority, and that clients resolve its extra accounts.`
    );
  } else if (hook) {
    warn(
      "transferHook is initialized but dormant. It can be armed without redeploying the mint; " +
        "every client must already resolve hook accounts."
    );
  } else {
    pass("no transferHook extension");
  }

  const scaled = getScaledUiAmountConfig(mint);
  if (scaled) {
    const current = Number(scaled.multiplier);
    const next = Number(scaled.newMultiplier);
    const effective = Number(scaled.newMultiplierEffectiveTimestamp);
    if (!Number.isFinite(current) || current <= 0) {
      fail(`scaledUiAmount multiplier is unusable: ${current}`);
    } else {
      pass(`scaledUiAmount multiplier ${current} (authority ${scaled.authority.toBase58()})`);
    }
    const now = Math.floor(Date.now() / 1000);
    if (next !== current && effective > now) {
      const when = new Date(effective * 1000).toISOString();
      if (maturity !== null && effective <= maturity) {
        fail(
          `a corporate action (multiplier ${current} -> ${next}) lands at ${when}, inside the ` +
            `term of a series maturing at ${new Date(maturity * 1000).toISOString()}. Pick a ` +
            `different maturity.`
        );
      } else {
        warn(`a multiplier change to ${next} is scheduled for ${when}`);
      }
    } else {
      pass("no multiplier change scheduled");
    }
  } else {
    warn("no scaledUiAmount extension — corporate actions will not be visible on-chain");
  }

  // --- vault token accounts -------------------------------------------
  for (const v of a.vault ?? []) {
    const acc = await getAccount(connection, new PublicKey(v), "confirmed", TOKEN_2022_PROGRAM_ID);
    if (acc.isFrozen) fail(`vault ${v} is FROZEN`);
    else pass(`vault ${v} is not frozen (${acc.amount} raw units)`);
  }

  // --- feed configs ----------------------------------------------------
  const feeds = a.feed ?? [];
  if (feeds.length === 0) {
    warn("no --feed given; oracle configs were not checked");
  }
  if (feeds.length > 0) {
    const idlPath = path.resolve(process.cwd(), "target", "idl", "oracle_adapter.json");
    if (!fs.existsSync(idlPath)) {
      fail(`cannot check feeds: ${idlPath} missing (run \`make idl\`)`);
    } else {
      const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
      const provider = new anchor.AnchorProvider(
        connection,
        // Read-only: no wallet is needed and none should be used.
        { publicKey: PublicKey.default } as any,
        {}
      );
      const program = new anchor.Program(idl, provider);
      for (const f of feeds) {
        const cfg: any = await (program.account as any).feedConfig.fetch(new PublicKey(f));
        const source = cfg.source as PublicKey;
        const sourceInfo = await connection.getAccountInfo(source, "confirmed");
        if (!sourceInfo) {
          fail(`feed ${f} names missing source account ${source.toBase58()}`);
          continue;
        }
        if (!sourceInfo.owner.equals(PYTH_RECEIVER_ID)) {
          fail(
            `feed ${f} source ${source.toBase58()} is owned by ${sourceInfo.owner.toBase58()}, ` +
              `not the Pyth receiver ${PYTH_RECEIVER_ID.toBase58()}`
          );
        } else {
          pass(`feed ${f} source is owned by the Pyth receiver`);
        }

        if (
          sourceInfo.data.length <= 42 ||
          !sourceInfo.data.subarray(0, 8).equals(PRICE_UPDATE_V2_DISCRIMINATOR)
        ) {
          fail(`feed ${f} source is not a PriceUpdateV2 account`);
          continue;
        }

        const verificationTag = sourceInfo.data.readUInt8(40);
        const messageOffset = verificationTag === 0 ? 42 : verificationTag === 1 ? 41 : -1;
        if (messageOffset < 0 || sourceInfo.data.length < messageOffset + 32) {
          fail(`feed ${f} source carries an invalid verification level`);
          continue;
        }

        const configuredFeedId = Buffer.from(cfg.feedId);
        const sourceFeedId = sourceInfo.data.subarray(messageOffset, messageOffset + 32);
        if (!sourceFeedId.equals(configuredFeedId)) {
          fail(`feed ${f} source currently contains a different Pyth feed id`);
        } else {
          pass(`feed ${f} source identity matches its configured feed id`);
        }

        const maxAge = Number(cfg.maxAgeSecs.toString());
        if (!Number.isSafeInteger(maxAge) || maxAge <= 0) {
          fail(`feed ${f} has invalid max_age_secs = ${cfg.maxAgeSecs.toString()}`);
        } else {
          pass(`feed ${f} rejects quotes older than ${maxAge}s`);
        }

        if (cfg.minVerificationSignatures === 0) {
          fail(
            `feed ${f} has min_verification_signatures = 0, so it accepts a Pyth update backed ` +
              `by no guardian signatures`
          );
        } else {
          pass(`feed ${f} requires ${cfg.minVerificationSignatures} guardian signatures`);
        }

        if (
          verificationTag === 0 &&
          sourceInfo.data.readUInt8(41) < cfg.minVerificationSignatures
        ) {
          fail(
            `feed ${f} source currently has only ${sourceInfo.data.readUInt8(41)} guardian ` +
              `signatures, below the configured floor ${cfg.minVerificationSignatures}`
          );
        } else {
          pass(`feed ${f} source currently meets its verification floor`);
        }
      }
    }
  }

  // --- upgrade authority -------------------------------------------------
  //
  // Every program here can be replaced by whoever holds its upgrade authority.
  // If that is one hot key, the whole protocol -- including the vaults holding
  // collateral -- is one key compromise away from being replaced with something
  // that drains them. No amount of on-chain checking helps: the checker is the
  // thing being replaced.
  //
  // This does not check that the key is *safe*, which is unknowable from
  // outside. It checks that it is not obviously a lone signer: an authority
  // account owned by a governance or multisig program, or none at all because
  // the program was deployed `--final`.
  const deployments = (() => {
    try {
      const raw = fs.readFileSync(
        path.resolve(import.meta.dirname, "..", "deployments", "devnet.json"),
        "utf8",
      );
      return JSON.parse(raw).programs as Record<string, string>;
    } catch {
      return null;
    }
  })();

  if (!deployments) {
    warn("no deployments manifest found; upgrade authority not checked");
  } else {
    for (const [name, id] of Object.entries(deployments)) {
      const programId = new PublicKey(id);
      const info = await connection.getAccountInfo(programId);
      if (!info) {
        warn(`${name} (${id}) is not deployed on this cluster`);
        continue;
      }
      if (!info.owner.equals(BPF_UPGRADEABLE_LOADER)) {
        // Loader-v2 and friends have no upgrade authority at all.
        pass(`${name} is not upgradeable (owner ${info.owner.toBase58()})`);
        continue;
      }

      // Program account: 4-byte enum then the 32-byte programdata address.
      const programDataAddress = new PublicKey(info.data.subarray(4, 36));
      const pd = await connection.getAccountInfo(programDataAddress);
      if (!pd) {
        fail(`${name} programdata ${programDataAddress.toBase58()} is missing`);
        continue;
      }

      // ProgramData: 4-byte enum, 8-byte slot, 1-byte Option tag, then the
      // authority if the tag is set.
      const hasAuthority = pd.data.readUInt8(12) === 1;
      if (!hasAuthority) {
        pass(`${name} is immutable — upgrade authority has been revoked`);
        continue;
      }

      const authority = new PublicKey(pd.data.subarray(13, 45));
      const authInfo = await connection.getAccountInfo(authority);
      const owner = authInfo?.owner.toBase58();
      if (owner && KNOWN_MULTISIG_OWNERS.has(owner)) {
        pass(`${name} upgrade authority ${authority.toBase58()} is held by ${owner}`);
      } else if (authInfo && authInfo.executable === false && authInfo.data.length > 0) {
        warn(
          `${name} upgrade authority ${authority.toBase58()} is a program-owned account ` +
            `(${owner}) this script does not recognise — confirm it is a multisig`,
        );
      } else {
        fail(
          `${name} upgrade authority ${authority.toBase58()} is a plain wallet. ` +
            `One key can replace this program, and the vaults it governs. Move it to a ` +
            `multisig or deploy --final before mainnet.`,
        );
      }
    }
  }

  // --- report -----------------------------------------------------------
  console.log("");
  for (const r of results) {
    const tag = r.level === "pass" ? "  ok  " : r.level === "warn" ? " warn " : " FAIL ";
    console.log(`[${tag}] ${r.message}`);
  }
  const fails = results.filter((r) => r.level === "fail").length;
  const warns = results.filter((r) => r.level === "warn").length;
  console.log(`\n${results.length} checks: ${fails} failed, ${warns} warnings\n`);

  if (fails > 0) {
    console.error("PREFLIGHT FAILED — do not deploy\n");
    process.exit(1);
  }
  if (warns > 0) {
    console.log("Preflight passed with warnings. Every warning must have been read by a human.\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
