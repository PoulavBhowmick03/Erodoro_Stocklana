# Contract deployment costs

Measured on 2026-09-19, darwin-arm64, platform-tools v1.54. These are
**rent deposits for fresh loader-v3 deployments**, including both the 36-byte
Program account and the ELF plus 45-byte ProgramData header. Transaction fees,
priority fees, temporary upload-buffer funding and protocol state accounts are
additional. Rent deposits are not execution fees.

Mainnet and devnet RPC both currently quote **5,080 lamports per byte**, including
128 bytes of account overhead. The older 6,960 rate in `variants/COMPARISON.md`
is historical. Use live RPC quotes when budgeting, not a hardcoded rate.

## Core mainnet contracts

Mainnet's core deploy set is oracle adapter, factory and series. The custom
`market` prototype and test transfer hook are excluded by the deployment
manifests. Mainnet trading additionally needs the separately built Manifest
fork; it is **not included** in the core total below.

| Program | Anchor bytes | Pinocchio before | Pinocchio after | Fresh rent after (SOL) |
| --- | ---: | ---: | ---: | ---: |
| oracle_adapter | 138,416 | 19,688 | 15,624 | 0.081081880 |
| factory | 222,800 | 28,592 | 23,200 | 0.119567960 |
| series | 367,104 | 114,896 | 113,576 | 0.578678040 |
| **Total** | **728,320** | **163,176** | **152,400** | **0.779327880** |

At the same current rent rate, the previous Pinocchio builds cost 0.834070 SOL.
Changing their release profile from `opt-level = "z"` to `"s"`, retaining fat
LTO, saves **10,776 bytes / 0.054742080 SOL / 6.6%**. The size optimization
named `z` does not necessarily produce the smallest linked binary. No contract
logic, account checks or overflow checks were removed.

The equivalent Anchor builds cost **3.705001480 SOL**. The full Pinocchio
saving is **2.925673600 SOL (79.0%)**, mostly from optimizations already present
before this change. Do not attribute that entire saving to the profile change.

The custom-market prototype remains 69,768 bytes / 0.356133400 SOL, making all
four optimized programs **1.135461280 SOL** if that prototype is wanted too.

## What is deployed now

Read from devnet on the same date. These are actual Program + ProgramData
balances, not the new-build estimates above. Mainnet's manifest remains
configuration-only.

| Program | Allocated executable bytes | Currently held (SOL) |
| --- | ---: | ---: |
| oracle_adapter | 231,984 | 1.616954160 |
| factory | 278,968 | 1.943962800 |
| series | 432,560 | 3.012963120 |
| **Core total** | **943,512** | **6.573880080** |
| custom market prototype | 364,344 | 1.852887800 |
| Manifest fork | 696,688 | 3.541195320 |
| canonical external ephemeral SPL | 966,504 | 4.911860600 |

Some balances still reflect the earlier rent rate. Existing account allocations
and balances are distinct from the rent needed for a new smaller binary. An
upgrade does not automatically turn the fresh-deployment savings above into a
wallet refund. No public programs were upgraded or closed by this optimization.
The external canonical ephemeral SPL program is not a new deployment charge
for this repository.

## Reproduce

```sh
make build
make variants
pnpm deployment:cost
pnpm deployment:cost --include-market
pnpm deployment:cost --manifest /path/to/reviewed/manifest.so
pnpm deployment:cost --rpc https://api.devnet.solana.com --deployed deployments/devnet.json
pnpm deployment:cost --lamports-per-byte 5080 --json # explicit offline assumption
```

The report reads actual local ELF sizes, queries
`getMinimumBalanceForRentExemption` for each account size, and does not access a
wallet or submit transactions. `--deployed` verifies the RPC genesis hash
against the selected deployment manifest. Missing artifacts or failed RPC
queries fail instead of substituting historical estimates.

Validation of these builds: `make variants` completed without SBF errors;
oracle, factory and series validator suites each passed 6 tests (18 total);
their native suites passed 45, 24 and 67 tests respectively (136 total).
The oracle and factory tests now fund their extra signer through the existing
transaction helper, avoiding the airdrop websocket confirmation that previously
blocked these suites. All five Anchor artifact fingerprints remain unchanged.
Live RPC and explicit offline estimates agree to the lamport; prototype and
external-artifact inclusion and invalid-input rejection were also checked.

For deployment, keep `--max-len` at the artifact's actual size unless deliberately
reserving more space; CLI 3.0.13 already defaults to the original artifact's size.
Do not deploy the custom-market prototype or test hook as part of the core
mainnet set. Select the reviewed Manifest artifact explicitly: a stale sibling
checkout is not evidence of the current production build.

Solana references: [deployment accounts](https://solana.com/docs/programs/deploying),
[live rent RPC](https://solana.com/docs/rpc/http/getminimumbalanceforrentexemption).
