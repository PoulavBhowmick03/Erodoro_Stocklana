# Moving the upgrade authority to a multisig

`scripts/preflight.ts` fails every program in this repo because each one's
upgrade authority is a plain wallet. Whoever holds that key can replace any
program — including `series`, which holds the collateral — and nothing on chain
helps, because the checker is the thing being replaced.

This is the runbook. It cannot be run for you: it needs the current authority's
signature. It should take under an hour, and it removes the largest single risk
here.

## What has to be true at the end

`pnpm preflight --mint <collateral> --url <rpc>` prints `ok` for every program's
upgrade authority instead of `FAIL`. That check passes on an authority owned by
SPL Governance or Squads v3/v4, and on a program deployed `--final`.

## Before you start

```sh
# Confirm what you are moving, and that you hold it.
solana address                                  # must match the authority below
for p in FMByTd4JrYycj1V7hVKHqjHnLZ5D4rwyYYscSqYiuGfz \
         AJPJRQQpgT461SaiBvZY4ixdS6S5R2QYQsod6Qdpm8p9 \
         CRBW3Et1ogjExdSnFty3gM4zyGoN7He5zfqkaieZqQkZ \
         FYAhsmE2JCxuAFhq2asH2wC4i7ZaUE7kwRbcgzM3AwgC; do
  solana program show "$p" -u <rpc> | grep -E "Program Id|Authority"
done
```

Those four are the devnet set in `deployments/devnet.json`. On mainnet they will
be different addresses; take them from the deployment manifest you actually
shipped, not from here.

## 1. Create the multisig

Squads is the usual choice on Solana and is what `preflight` recognises. Create
it at <https://app.squads.so> or with their CLI, then note the **vault** address
— that is the signer, and it is not the same as the multisig account address.

Two properties matter more than the tooling:

- **Threshold above one.** A 1-of-N multisig is a plain wallet with extra steps.
- **Keys held by different people, on different hardware.** Three keys in the
  same drawer is one key.

A timelock on top is worth considerably more than the multisig alone: it turns a
compromised quorum from "instant drain" into "a window in which somebody
notices". `scripts/monitor.ts` is what would notice.

## 2. Transfer, one program at a time

```sh
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_VAULT_ADDRESS> \
  --upgrade-authority ~/.config/solana/id.json \
  -u <rpc>
```

The new authority does not sign, so this needs
`--skip-new-upgrade-authority-signer-check`:

```sh
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_VAULT_ADDRESS> \
  --upgrade-authority ~/.config/solana/id.json \
  --skip-new-upgrade-authority-signer-check \
  -u <rpc>
```

**Do the least important program first** — `oracle_adapter` or `factory`, not
`series`. If the vault address is wrong you will find out on a program that
holds nothing, and a wrong address here is unrecoverable: the authority is gone
and the program can never be upgraded again.

Verify each before moving to the next:

```sh
solana program show <PROGRAM_ID> -u <rpc> | grep Authority
```

## 3. Prove the multisig can actually upgrade

Do this **before** transferring `series`, and treat it as the real gate.

An authority you cannot exercise is not safer than a hot key — it is worse,
because a bug becomes unfixable. Propose and execute a no-op upgrade of the
first program through the multisig: redeploy the identical binary. If the quorum
cannot complete that, stop and fix the setup rather than transferring anything
else.

## 4. Transfer the rest, `series` last

Then confirm:

```sh
pnpm preflight --mint <collateral-mint> --url <rpc>
```

Every program should now report `ok` on its authority. If one reports **warn**
— "a program-owned account this script does not recognise" — the authority is
owned by a program that is not in `KNOWN_MULTISIG_OWNERS` in
`scripts/preflight.ts`. Confirm by hand what that program is, then add it there
rather than ignoring the warning.

## The alternative: `--final`

```sh
solana program deploy --final ...
```

An immutable program has no upgrade authority, so there is nothing to steal. It
also means a discovered bug is permanent and the only remedy is deploying a new
program at a new address and migrating every account to it.

For a protocol holding collateral, before an external audit, that is the wrong
tradeoff. Revisit it once the code has been reviewed and has run for a while.

## What this does not fix

The upgrade authority is one of several keys with power here, and moving it does
not touch the others:

- **The `factory` admin** decides which oracles may be settled against and which
  mints may be escrowed. It cannot touch existing collateral, but it can list a
  hostile series.
- **The `oracle_adapter` admin** can rotate a feed's source address. Finding 3
  in `SECURITY.md` is marked fixed and is: the mock backend was removed, so a
  rotation must still point at an account owned by the Pyth receiver, and the
  configured feed id is immutable and checked against every decoded update. What
  remains is the ability to choose *which* Pyth account of that feed a series
  reads — narrower than the original finding, and still worth a quorum.
- **The collateral issuer** holds a permanent delegate over anything in a vault.
  That is the threat model, not a misconfiguration, and no key management on
  this side changes it.

Each of those should move to the multisig too. The upgrade authority is first
because it is the only one that can replace the code that checks the others.

Until they do — and after, because a multisig can be compromised too — run the
monitor with a snapshot:

```sh
pnpm monitor --cluster mainnet --snapshot ops/authorities.json \
             --webhook "$MONITOR_WEBHOOK"
```

It records every upgrade authority, every series admin and status, and every
feed's admin, source and signature floor, then reports anything that moved since
the last run. The conservation checks catch a vault that is already short; this
catches the step before, which is an admin key being used at all.
