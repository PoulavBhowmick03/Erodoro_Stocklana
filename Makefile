# SPDX-License-Identifier: Apache-2.0
# Build and test tooling for the covered-call protocol.

# Platform-tools version used for the SBF build.
#
# The version bundled with solana-cli 3.0.13 is v1.51, which ships rustc
# 1.84.1. Several crates in the dependency graph (reached transitively through
# `borsh-derive` -> `proc-macro-crate` -> the `toml_edit` chain, and through
# `blake3`) now require edition 2024, stabilized in rustc 1.85. v1.52 and above
# ship rustc 1.89 and build the graph as-is.
#
# Pinning those crates down instead was tried and abandoned: the chain
# regenerates on every `cargo update`, and pinning build-time proc-macro
# dependencies to stale versions trades one maintenance problem for a worse one.
TOOLS_VERSION ?= v1.54

# Two unstable rustc flags, worth 0.2091 SOL across the **Anchor** deploy path.
# They drop the file/line/column records behind `#[track_caller]` panics and the
# bodies of derived `Debug` impls. Neither is reachable here: no program calls
# `msg!` and no program source formats a `{:?}`. Per-program numbers are in
# `variants/COMPARISON.md`.
#
# The Pinocchio variants use `PINOCCHIO_RUSTFLAGS` below instead, which drops
# `-Zlocation-detail=none` for a reason recorded there.
#
# Set through `CARGO_TARGET_<TRIPLE>_RUSTFLAGS` rather than `RUSTFLAGS`.
# `cargo-build-sbf` folds a plain `RUSTFLAGS` into its target flags and hands
# them to the SBF rustc, which is 1.89.0-dev and accepts `-Z`. But `anchor
# build` also runs a *host* cargo whose rustc is the rustup stable toolchain,
# and cargo strips `RUSTC_BOOTSTRAP` from its version probe -- so as
# `RUSTFLAGS` the flags reach a compiler that rejects them with "the option `Z`
# is only accepted on the nightly compiler". Scoped to the target they never
# reach host rustc and no bootstrap variable is needed.
#
# Presetting this variable also displaces the `-C opt-level=s` that
# `cargo-build-sbf` would otherwise compose in, which is what lets
# `[profile.release] opt-level = "z"` in Cargo.toml decide instead.
SBF_TRIPLE ?= sbpf-solana-solana
SIZE_RUSTFLAGS ?= -Zlocation-detail=none -Zfmt-debug=none
SBF_ENV = CARGO_TARGET_$(shell echo $(SBF_TRIPLE) | tr 'a-z-' 'A-Z_')_RUSTFLAGS="$(SIZE_RUSTFLAGS)"

# The Pinocchio variants do **not** get `-Zlocation-detail=none`, and that is
# deliberate rather than an oversight.
#
# Presetting the target-scoped variable above displaces the flags
# `cargo-build-sbf` composes for itself, and one of those is `-C lto=fat`. With
# the `cdylib`+`lib` crate type the variants used to carry, cargo suppressed the
# profile's `lto` anyway, so nothing was lost. Now that they are `cdylib`-only
# (see `variants/*/Cargo.toml`) LTO actually runs, and that combination --
# `-Zlocation-detail=none` *with* `lto = "fat"` -- miscompiles. Measured, not
# assumed: the LTO build with that flag fails four lifecycle assertions on a
# validator (settle returns `OraclePriceStale` where the price is fresh, redeem
# returns `IllegalOwner`) while the identical source without the flag passes.
# An unverifiable 6,880 bytes is not worth a collateral program that reads the
# wrong account, so `-Zfmt-debug=none` is kept and `-Zlocation-detail=none` is
# not. `-Zfmt-debug=none` is size-neutral once LTO runs -- 114,896 bytes on
# `series` with it, 114,896 without -- so nothing is given up with the flag.
#
# The Anchor programs in `build` above keep both flags. They are `cdylib`+`lib`,
# so their LTO stays off and the flag remains the pure win it was measured to be.
PINOCCHIO_RUSTFLAGS ?= -Zfmt-debug=none
PINOCCHIO_SBF_ENV = CARGO_TARGET_$(shell echo $(SBF_TRIPLE) | tr 'a-z-' 'A-Z_')_RUSTFLAGS="$(PINOCCHIO_RUSTFLAGS)"

## A tier whose `before()` cannot find its program calls `this.skip()`, and
## mocha then reports success having run nothing. That is how
## `make pinocchio-oracle` spent weeks green while executing zero tests, and it
## recurred on CI the moment the job got far enough to run these -- three tiers
## reported success having run 0 tests and skipped 20. The failure has two
## halves, so there are two guards.
##
## The validator not coming up. Each tier used to poll for its program, then run
## the suite regardless of whether it appeared.
##   $(call await_program,<port>,<pubkey>)
define await_program
for i in $$(seq 1 60); do \
   solana account -u http://127.0.0.1:$(1) $(2) >/dev/null 2>&1 && break; \
   sleep 1; \
 done; \
 solana account -u http://127.0.0.1:$(1) $(2) >/dev/null 2>&1 || { \
   echo "$(2) never appeared on 127.0.0.1:$(1)"; \
   echo "--- is the validator process alive? ---"; \
   kill -0 $$vpid 2>/dev/null && echo "pid $$vpid alive" || echo "pid $$vpid gone"; \
   echo "--- rpc getHealth ---"; \
   curl -s -m 5 http://127.0.0.1:$(1) -X POST -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' || echo "(no response)"; \
   echo; \
   echo "--- solana account, error not suppressed ---"; \
   solana account -u http://127.0.0.1:$(1) $(2) 2>&1 | tail -5 || true; \
   echo "--- last 40 lines of $(3) ---"; \
   tail -40 $(3) 2>/dev/null || echo "(no validator log)"; \
   exit 1; \
 }
endef

## The suite skipping. `e2e` already takes its outcome from mocha rather than
## from the exit code; these now do the same, and additionally treat a pending
## test as failure -- on these tiers `pending` means `before()` bailed.
##   $(call assert_ran,<logfile>,<tier>)
define assert_ran
if grep -qE '[0-9]+ failing' $(1); then \
   echo "$(2): mocha reported failures"; exit 1; \
 fi; \
 if grep -qE '[0-9]+ pending' $(1); then \
   echo "$(2): tests were skipped, which on this tier means the program was not reachable"; exit 1; \
 fi; \
 grep -qE '[1-9][0-9]* passing' $(1) || { \
   echo "$(2): no passing count -- the suite did not finish"; exit 1; \
 }
endef

# Own port, so this never collides with `anchor localnet` or a MagicBlock stack.
PINOCCHIO_PORT ?= 8999
PINOCCHIO_FACTORY_PORT ?= 8998
PINOCCHIO_MARKET_PORT ?= 8997
PINOCCHIO_SERIES_PORT ?= 8996

# The RPC port was moved; gossip and the faucet were not, so all three tiers
# were still asking for the defaults. Anchor.toml records what that costs -- the
# validator "panics rather than falling back", and moving gossip "requires an
# explicit bind address, or it tries to bind 0.0.0.0 and panics on an
# unspecified IP". That fix reached the `anchor test` validator and never
# reached these three, which is why they came up locally and died on CI.
PINOCCHIO_GOSSIP ?= 8011
PINOCCHIO_FACTORY_GOSSIP ?= 8012
PINOCCHIO_MARKET_GOSSIP ?= 8013
PINOCCHIO_SERIES_GOSSIP ?= 8014
PINOCCHIO_FAUCET ?= 9901
PINOCCHIO_FACTORY_FAUCET ?= 9902
PINOCCHIO_MARKET_FAUCET ?= 9903
PINOCCHIO_SERIES_FAUCET ?= 9904
BIND ?= 127.0.0.1

# A program's address is fixed by `declare_id!`, not by the keypair sitting in
# target/deploy -- and `target` is gitignored, so `anchor build` mints a fresh
# random keypair on any clean checkout. Passing that keypair to `--bpf-program`
# loaded each program at an address nobody was looking for: on CI the validator
# was healthy, `getHealth` answered ok, and `solana account` said
# `AccountNotFound` for the declared id. It only ever worked locally because the
# keypairs here happen to predate the ids.
#
# These are the same constants the suites and `await_program` use, so the loaded
# address and the looked-for address can no longer drift apart.
ORACLE_ID ?= FMByTd4JrYycj1V7hVKHqjHnLZ5D4rwyYYscSqYiuGfz
FACTORY_ID ?= CRBW3Et1ogjExdSnFty3gM4zyGoN7He5zfqkaieZqQkZ
MARKET_ID ?= FYAhsmE2JCxuAFhq2asH2wC4i7ZaUE7kwRbcgzM3AwgC
SERIES_ID ?= AJPJRQQpgT461SaiBvZY4ixdS6S5R2QYQsod6Qdpm8p9

PROGRAMS := oracle-adapter series factory market

DEVNET_URL ?= https://api.devnet.solana.com
RPC_URL ?= https://api.mainnet-beta.solana.com
WALLET ?= $(HOME)/.config/solana/id.json

# The two halves of a local MagicBlock stack: the base validator and the
# ephemeral one the book gets delegated to.
BASE_URL ?= http://localhost:8899
ER_URL ?= http://localhost:7799

.PHONY: help all test e2e rollup devnet devnet-market preflight build variants idl fmt fmt-check clippy clean pinocchio-oracle pinocchio-factory pinocchio-market

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

all: test build idl e2e ## Everything that runs without a funded wallet

test: ## Native unit and property tests (no validator needed)
	cargo test --workspace

## The Pyth fixtures carry publish times relative to when they were taken, so
## they are regenerated on every run rather than committed and left to go stale.
## `anchor test` exits non-zero even when every test passes.
##
## It streams a log file per program declared in `[programs.localnet]` and reads
## them back once the suite ends. Two of the five never emit anything --
## `test_transfer_hook` is armed but silent, and `factory` does its work through
## a CPI -- so the read fails with `No such file or directory` *after* mocha has
## already reported 12 passing. Left alone this makes the target permanently
## red, which is precisely the "CI job that fails for reasons unrelated to the
## diff" this repo pulled the validator tiers out of CI to avoid.
##
## So the outcome is taken from mocha rather than from anchor's exit code, and
## a missing summary is treated as failure -- a run that crashed before
## reporting must not pass because it also printed no `failing` line.
## `set -o pipefail` is a bashism, and make runs recipes under `/bin/sh`. On
## macOS that is bash and the recipe works; on Ubuntu it is dash, which exits
## with "Illegal option -o pipefail" -- so this target failed only on CI, and
## only once the pnpm step stopped failing ahead of it. Scoped to this recipe,
## since it is the one bashism in the file and every other target is portable.
e2e: SHELL := /bin/bash
e2e: ## Full lifecycle on a local validator, against real Pyth accounts
	pnpm pyth:fixture
	@set -o pipefail; anchor test --skip-build 2>&1 | tee /tmp/erodoro-e2e.log; \
	 if grep -qE '^\s+[0-9]+ failing' /tmp/erodoro-e2e.log; then \
	   echo "e2e: mocha reported failures"; exit 1; \
	 elif ! grep -qE '^\s+[0-9]+ passing' /tmp/erodoro-e2e.log; then \
	   echo "e2e: no mocha summary -- the suite did not finish"; exit 1; \
	 else \
	   echo "e2e: $$(grep -oE '[0-9]+ passing' /tmp/erodoro-e2e.log | head -1)"; \
	 fi

## Needs a MagicBlock stack already running, with `market` preloaded:
##   npm install -g @magicblock-labs/ephemeral-validator
##   mb-stack --reset --upgradeable-program \
##     target/deploy/market-keypair.json target/deploy/market.so $$(solana address)
rollup: ## A real ephemeral-rollup session against a local MagicBlock stack
	PROVIDER_ENDPOINT=$(BASE_URL) EPHEMERAL_PROVIDER_ENDPOINT=$(ER_URL) \
		ANCHOR_PROVIDER_URL=$(BASE_URL) ANCHOR_WALLET=$(WALLET) pnpm rollup

pinocchio-oracle: SHELL := /bin/bash
pinocchio-oracle: ## Execute the Pinocchio oracle build on a validator
	@# The 43 tests in variants/ are all pure logic. This is the only thing that
	@# runs the program: PDA derivation, the CreateAccount CPI, the rent lookup
	@# and the return-data path. Worth doing before spending SOL upgrading the
	@# program that owns every FeedConfig account.
	@#
	@# Its own validator on its own port and ledger, rather than `anchor
	@# localnet`, so it cannot collide with a MagicBlock stack already holding
	@# 8899 -- and so it loads four Pyth fixtures instead of the whole
	@# e2e set.
	@rm -rf /tmp/pinocchio-ledger
	@set -e -o pipefail; \
	 solana-test-validator --reset --quiet \
	   --ledger /tmp/pinocchio-ledger \
	   --rpc-port $(PINOCCHIO_PORT) \
	   --gossip-port $(PINOCCHIO_GOSSIP) \
	   --faucet-port $(PINOCCHIO_FAUCET) \
	   --bind-address $(BIND) \
	   --bpf-program $(ORACLE_ID) \
	     variants/oracle-adapter-pinocchio/target/deploy/oracle_adapter_pinocchio.so \
	   --account 5UwXgaBafMgP2NV8x2rKvWU67ehJzHpCoBbcHsb6w1VF tests/fixtures/pyth-at-600.json \
	   --account 81x6PaZzbDX1gHVCGnrpW9N6gDVqgAY5qmuk4yRo6bkC tests/fixtures/pyth-at-600-alt.json \
	   --account EHogBYxtkS8XJu88EDfAyxzA4eF9QzyrKMdFE5rTER5f tests/fixtures/pyth-at-600-past.json \
	   --account 5L1pifLzp6N71UvLUuvXDqTQfQKrJDWQTQQnWHJSsW6M tests/fixtures/pyth-at-300.json \
	   > /tmp/pinocchio-oracle-validator.log 2>&1 & vpid=$$!; \
	 trap 'kill $$vpid 2>/dev/null || true' EXIT; \
	 $(call await_program,$(PINOCCHIO_PORT),$(ORACLE_ID),/tmp/pinocchio-oracle-validator.log); \
	 ANCHOR_PROVIDER_URL=http://127.0.0.1:$(PINOCCHIO_PORT) ANCHOR_WALLET=$(WALLET) \
	   pnpm pinocchio:oracle 2>&1 | tee /tmp/pinocchio-oracle.log; \
	 $(call assert_ran,/tmp/pinocchio-oracle.log,pinocchio-oracle)

pinocchio-factory: SHELL := /bin/bash
pinocchio-factory: ## Execute the Pinocchio factory build on a validator
	@# Same tier as `pinocchio-oracle`, for the second port. The factory build
	@# has 24 conformance tests and all of them are pure logic; this is the
	@# only thing that runs it -- PDA derivation, the CreateAccount CPI, the
	@# rent lookup, Anchor's `close` semantics and the event wire format.
	@#
	@# The oracle adapter goes up as its *Anchor* build: `approve_oracle`
	@# checks the owner and discriminator of a real `FeedConfig`, and a
	@# forgery would not exercise that.
	@rm -rf /tmp/pinocchio-factory-ledger
	@set -e -o pipefail; \
	 solana-test-validator --reset --quiet \
	   --ledger /tmp/pinocchio-factory-ledger \
	   --rpc-port $(PINOCCHIO_FACTORY_PORT) \
	   --gossip-port $(PINOCCHIO_FACTORY_GOSSIP) \
	   --faucet-port $(PINOCCHIO_FACTORY_FAUCET) \
	   --bind-address $(BIND) \
	   --bpf-program $(FACTORY_ID) \
	     variants/factory-pinocchio/target/deploy/factory_pinocchio.so \
	   --bpf-program $(ORACLE_ID) \
	     target/deploy/oracle_adapter.so \
	   --account EHogBYxtkS8XJu88EDfAyxzA4eF9QzyrKMdFE5rTER5f tests/fixtures/pyth-at-600-past.json \
	   > /tmp/pinocchio-factory-validator.log 2>&1 & vpid=$$!; \
	 trap 'kill $$vpid 2>/dev/null || true' EXIT; \
	 $(call await_program,$(PINOCCHIO_FACTORY_PORT),$(FACTORY_ID),/tmp/pinocchio-factory-validator.log); \
	 ANCHOR_PROVIDER_URL=http://127.0.0.1:$(PINOCCHIO_FACTORY_PORT) ANCHOR_WALLET=$(WALLET) \
	   pnpm pinocchio:factory 2>&1 | tee /tmp/pinocchio-factory.log; \
	 $(call assert_ran,/tmp/pinocchio-factory.log,pinocchio-factory)

pinocchio-market: SHELL := /bin/bash
pinocchio-market: ## Execute the Pinocchio market build on a validator
	@# The L1 half of the program: PDA derivation, three ATA creations, SPL
	@# transfers in and out, the market PDA signing a withdrawal, and the event
	@# wire format. The four delegation instructions need the delegation and
	@# magic programs, which a plain validator does not have -- their payloads
	@# are checked against the SDK in the crate's own suite instead.
	@rm -rf /tmp/pinocchio-market-ledger
	@set -e -o pipefail; \
	 solana-test-validator --reset --quiet \
	   --ledger /tmp/pinocchio-market-ledger \
	   --rpc-port $(PINOCCHIO_MARKET_PORT) \
	   --gossip-port $(PINOCCHIO_MARKET_GOSSIP) \
	   --faucet-port $(PINOCCHIO_MARKET_FAUCET) \
	   --bind-address $(BIND) \
	   --bpf-program $(MARKET_ID) \
	     variants/market-pinocchio/target/deploy/market_pinocchio.so \
	   > /tmp/pinocchio-market-validator.log 2>&1 & vpid=$$!; \
	 trap 'kill $$vpid 2>/dev/null || true' EXIT; \
	 $(call await_program,$(PINOCCHIO_MARKET_PORT),$(MARKET_ID),/tmp/pinocchio-market-validator.log); \
	 ANCHOR_PROVIDER_URL=http://127.0.0.1:$(PINOCCHIO_MARKET_PORT) ANCHOR_WALLET=$(WALLET) \
	   pnpm pinocchio:market 2>&1 | tee /tmp/pinocchio-market.log; \
	 $(call assert_ran,/tmp/pinocchio-market.log,pinocchio-market)

devnet: ## Oracle-layer tests against the programs deployed to devnet
	ANCHOR_PROVIDER_URL=$(DEVNET_URL) ANCHOR_WALLET=$(WALLET) pnpm devnet

devnet-market: ## Order-book tests against the market program on devnet
	ANCHOR_PROVIDER_URL=$(DEVNET_URL) ANCHOR_WALLET=$(WALLET) pnpm devnet:market

pinocchio-series: SHELL := /bin/bash
pinocchio-series: ## Execute the Pinocchio series build end to end on a validator
	@# The full lifecycle through the Anchor TS client, unchanged: series
	@# creation with its ATA and mints, split, merge, pause without trapping
	@# collateral, settlement against a fresh Pyth-layout quote, pro-rata
	@# redemption on both sides, dust sweep, and admin renouncement. The
	@# transfer-hook and multisig branches cannot execute on a plain validator
	@# with no hook program; their wire bytes are proven equal to SPL's in
	@# `variants/series-pinocchio/tests/transfer_wire.rs`.
	@rm -rf /tmp/pinocchio-series-ledger
	@node scripts/series-pyth-fixture.mjs /tmp/series-pyth-fixture.json
	@set -e -o pipefail; \
	 solana-test-validator --reset --quiet \
	   --ledger /tmp/pinocchio-series-ledger \
	   --rpc-port $(PINOCCHIO_SERIES_PORT) \
	   --gossip-port $(PINOCCHIO_SERIES_GOSSIP) \
	   --faucet-port $(PINOCCHIO_SERIES_FAUCET) \
	   --bind-address $(BIND) \
	   --bpf-program $(SERIES_ID) \
	     variants/series-pinocchio/target/deploy/series_pinocchio.so \
	   --bpf-program $(ORACLE_ID) \
	     target/deploy/oracle_adapter.so \
	   --account 5UwXgaBafMgP2NV8x2rKvWU67ehJzHpCoBbcHsb6w1VF /tmp/series-pyth-fixture.json \
	   > /tmp/pinocchio-series-validator.log 2>&1 & vpid=$$!; \
	 trap 'kill $$vpid 2>/dev/null || true' EXIT; \
	 $(call await_program,$(PINOCCHIO_SERIES_PORT),$(SERIES_ID),/tmp/pinocchio-series-validator.log); \
	 ANCHOR_PROVIDER_URL=http://127.0.0.1:$(PINOCCHIO_SERIES_PORT) ANCHOR_WALLET=$(WALLET) \
	   pnpm pinocchio:series 2>&1 | tee /tmp/pinocchio-series.log; \
	 $(call assert_ran,/tmp/pinocchio-series.log,pinocchio-series)

## §15 executed rather than remembered. Reads the live mint's five extensions
## and every feed config, and exits non-zero on anything unsafe.
##   make preflight MINT=<pubkey> [MATURITY=<ts>] [FEEDS="--feed <pk> --feed <pk>"]
preflight: ## Pre-deployment checks against a live mint
	node scripts/preflight.ts --mint $(MINT) --url $(RPC_URL) \
		$(if $(MATURITY),--maturity $(MATURITY),) $(FEEDS)

## `--no-idl` only skips generating the IDL JSON; the `#[program]` macro still
## emits the on-chain IDL-account instructions unless the `no-idl` *cargo*
## feature is set. Nothing reads the on-chain IDL -- every client builds from
## `web/lib/idl/*.json` -- so those handlers were 36-37 KB of dead weight per
## program, and rent is bytes. Measured: 0.766 SOL across the three that carry
## them (`market` emits none).
build: ## Build all programs to SBF
	$(SBF_ENV) anchor build --no-idl -- --tools-version $(TOOLS_VERSION) --features no-idl
	@ls -la target/deploy/*.so

## The four Pinocchio ports are what gets deployed for `oracle_adapter`,
## `factory`, `market` and `series`. They are
## independent workspaces, so `anchor build` does not reach them, and they were
## previously built by hand from `variants/COMPARISON.md`. A hand-built binary
## loses $(PINOCCHIO_RUSTFLAGS) and the `lto = "fat"` these crates get by being
## `cdylib`-only -- together worth 0.2037 SOL across the four.
variants: ## Build the Pinocchio deploy artifacts
	@for v in oracle-adapter factory market series; do \
	  echo "  building $$v-pinocchio" ; \
	  ( cd variants/$$v-pinocchio && $(PINOCCHIO_SBF_ENV) cargo build-sbf --tools-version $(TOOLS_VERSION) ) || exit 1 ; \
	done
	@ls -la variants/*/target/deploy/*_pinocchio.so

## Generated separately from `build`: `anchor build` forwards the trailing args
## to both the SBF build and the IDL build, and `--tools-version` is not a valid
## argument to the `cargo test` invocation the IDL build runs. The IDL build uses
## the host toolchain, which needs no override.
idl: ## Generate the IDL for every program
	@mkdir -p target/idl
	@for p in $(PROGRAMS); do \
		out=target/idl/$$(echo $$p | tr '-' '_').json ; \
		( cd programs/$$p && anchor idl build ) > $$out || exit 1 ; \
		echo "  $$p -> $$out" ; \
	done

fmt: ## Format
	cargo fmt --all

fmt-check: ## Check formatting
	cargo fmt --all -- --check

clippy: ## Lint
	cargo clippy --workspace --all-targets

clean: ## Remove build artifacts
	cargo clean
	rm -rf .anchor test-ledger target/idl
