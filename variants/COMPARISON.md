# Three builds of one program: what the framework costs

Measured 2026-08-15. The program is `oracle-adapter` — 573 lines, four
instructions, one PDA account, a Pyth decoder. It was chosen because it is the
only program in this repo with no Token-2022 dependency, so it isolates the
framework from everything else.

## Why measure at all

Deploy rent on Solana is `(bytes + 173) * 6960` lamports. Not "roughly
proportional to" size — *exactly* size. So the framework question is a byte
question with an exact answer, and `series` + `factory` needing ~5 SOL is a
framework decision that was never priced.

## Result

| Build | Binary | Rent | vs Anchor |
| --- | ---: | ---: | ---: |
| Anchor 0.31.1 | 202,776 B | **1.4125 SOL** | — |
| **Pinocchio 0.11.2** | **28,376 B** | **0.1987 SOL** | **−86.0%** |
| Quasar 0.1.0 | — | — | blocked, see below |

**1.2138 SOL saved on one program**, and the program is the smallest of the
five.

### Extrapolated to the whole protocol

At the same 86% ratio, and assuming the other programs compress comparably —
they will not, exactly, since `series` links `anchor-spl` for Token-2022 and
that is a different kind of weight:

| | Anchor today | At Pinocchio's ratio |
| --- | ---: | ---: |
| `series` + `factory` (the blocked deploy) | 4.9527 SOL | ~0.6951 SOL |
| All five programs | 9.5263 SOL | ~1.3383 SOL |

The `series` + `factory` figure is the one that matters: it is what the devnet
faucet would not cover.

## What the 86% actually buys, and what it costs

Anchor's `#[derive(Accounts)]` generates the ownership, signer, writable, PDA
and `has_one` checks. Pinocchio generates nothing. Those checks did not
disappear — they moved into a hand-written `accounts` module in the Pinocchio
variant, and **they are the security model**.

That is the whole trade, and it is not a typing-effort trade. This repo already
found three vulnerabilities in internal review, one of them *series-address
squatting* — a PDA check — with Anchor's constraints in place. Removing the
generator means every future change re-opens that class by hand.

So the honest reading of 1.21 SOL is: it is cheap for `oracle-adapter`, which
has one PDA and no custody, and it is not obviously worth it for `series`, which
holds collateral behind four Token-2022 issuer levers.

## Correction (2026-08-20): the id claim below was false, and the suite was dead

Two things recorded here did not hold, and both were found by trying to build
on them rather than by reading:

**The two builds did not share a program id.** This file claimed they did. The
Anchor build declares `FMByTd4Jr…`; the Pinocchio variant declared
`AZnVLRAsvn…`. The test that was supposed to guarantee it compared the
constant against a *transcribed literal of itself*, so it passed while the two
genuinely differed. It now compares against `oracle_adapter::ID`. Nothing was
unsafe at runtime -- PDA derivation uses the runtime `program_id`, not the
constant -- but the guarantee was not being checked.

**`make pinocchio-oracle` was running zero tests.** The Makefile deployed the
binary at `FMByTd4Jr…` while the suite looked for it at `AZnVLRAsvn…`, so
`before()` called `this.skip()` every run and mocha reported success. The tier
this file leans on -- "the rent bug was caught by `make pinocchio-oracle` and
by nothing else" -- had been switched off. Repairing it surfaced three further
defects that the skip had hidden:

- return data was read from `getTransaction().meta`, which is not populated for
  a top-level instruction; the Anchor suite uses `simulateTransaction`
- the rotation test asserted that `set_source` accepts a source on a *different*
  feed, which both builds correctly refuse -- and no two fixtures shared a feed
  id, so it could never have passed
- the suite only worked while the committed fixtures were stale: `read_quote`
  rejects a publish time ahead of the clock, and every fixture is stamped `+75s`
  so settlement tests can reach a future maturity

Two fixtures were added to close that: `at-600-alt` (same feed id, different
address -- a valid rotation target) and `at-600-past` (behind the clock, so a
quote can actually be read). `make pinocchio-oracle` now runs 6 and passes 6.

The size measurements below were re-checked and stand.

## Conformance: the two builds are indistinguishable

A cheaper binary is worthless if it behaves differently. Both builds share:

- the same program id, checked against `oracle_adapter::ID` itself
- the same 114-byte account layout and `sha256("account:FeedConfig")[..8]`
  discriminator, so an account written by one is readable by the other
- the same `sha256("global:<name>")[..8]` instruction discriminators, so a
  client built against the Anchor IDL reaches either
- the same error codes — Anchor's `#[error_code]` numbering from 6000

None of those are transcribed as literals and hoped for. Each is derived in a
test.

`tests/conformance.rs` links **both crates** and runs them against identical
bytes — 13 tests including proptest fuzzing:

- every truncation of a valid update is rejected by both
- every one of the 256 verification-tag bytes reaches the same verdict
- all 64 single-bit flips in the discriminator are rejected by both
- trailing bytes (the receiver over-allocates in production) tolerated identically
- arbitrary random bytes, and arbitrary bytes behind a valid discriminator,
  never panic and never disagree
- fully randomised well-formed updates always decode identically
- `scale_from_expo` agrees across the whole realistic exponent domain

Two decoders written from one spec by different means — one deriving borsh, one
walking a cursor — is exactly where a differential test earns its keep. A
fixture-only suite proves each is right; only this proves they are right
*together*.

## Quasar: blocked, and worth revisiting

Quasar is where this codebase would want to land: `#[derive(Accounts)]`, `init`,
`has_one` and PDA seeds stay declarative, while accounts are cast from the input
buffer rather than deserialized. Both the size win and the derived checks.

It does not compile on v0.1.0. Two gaps, verified against the framework source:

1. **No access to a foreign-owned account's raw bytes.** Account wrappers are
   `#[repr(transparent)]` over a private `AccountView` exposing only a *typed*
   `Deref` and `address()` — no accessor, no `AsRef<AccountView>`, no `owner()`,
   no `try_borrow()`. Decoding a Pyth account owned by the Pyth receiver is this
   program's entire job.
2. **`i64` instruction arguments do not compile** — `PodI64` has no
   `SchemaWrite`. No signed integer argument appears in any Quasar example or
   test program.

Details and the workarounds that were refused: `oracle-adapter-quasar/README.md`.

## `factory`, ported 2026-08-20

The second port, and the first done against the corrected baseline. Measured
after `no-idl` was enabled, so the figure below is the *marginal* win over an
already-trimmed Anchor build rather than over the old one.

| Build | Binary | Rent | vs Anchor |
| --- | ---: | ---: | ---: |
| Anchor 0.31.1, `no-idl` | 242,696 B | **1.6904 SOL** | — |
| **Pinocchio 0.11.2** | **40,368 B** | **0.2822 SOL** | **−83.4%** |

**1.4082 SOL saved.** Lower than the oracle adapter's 86% because the factory
carries more genuine logic per byte, not because of SPL weight — it links
`anchor-spl` for a single `InterfaceAccount<Mint>` check, 0.7% of its symbols.

What it has that `oracle-adapter` did not is a **CPI into another Anchor
program**. `series::create_series` takes 14 accounts whose signer and writable
flags are declared by the *callee*, plus an
`sha256("global:create_series")[..8] ++ borsh(params)` payload. All of it is
hand-built in `src/series_cpi.rs`, and a proptest in the conformance suite
asserts the payload is byte-identical to what `anchor_lang` would have
serialised for arbitrary parameters. A slip there would not fail locally — it
would quietly create a series on different terms than the caller asked for.

`tests/conformance.rs` runs 24 tests linking both crates: program ids read from
`factory::ID` and `series::ID` themselves, account layouts round-tripped through
Anchor's own `try_deserialize`, all 64 single-bit discriminator flips rejected,
error codes read from `common::OptionsError`, and both builds' `validate_policy`
compared under proptest — including that they reject *in the same order*, since
the code a caller sees depends on which condition trips first.

`make pinocchio-factory` runs 6 more on a validator: PDA derivation, the
CreateAccount CPI, the rent lookup, Anchor's `close` semantics (the rent lands
on the recipient to the lamport), and the `Program data:` event wire format.

**`create_series` itself is not executed on a validator.** Its payload is proven
byte-identical, but standing up a Token-2022 collateral mint with the extension
set `series` demands belongs to the e2e suite. That gap is real and is the next
thing to close.

## `market`, ported 2026-08-21

| Build | Binary | Rent | vs Anchor |
| --- | ---: | ---: | ---: |
| Anchor 0.31.1, `no-idl` | 363,848 B | **2.5347 SOL** | — |
| **Pinocchio 0.11.2** | **80,600 B** | **0.5633 SOL** | **−77.8%** |

**1.9714 SOL saved.** All eleven instructions, including the four MagicBlock
ones.

### The stack limit, which only executing it revealed

The first working build faulted on entry: `Access violation` at 100 compute
units, every instruction. `Book` materialised as a struct is **6,472 bytes** --
32 slots at 72 and 128 orders at 32 once Rust has padded them -- and Solana caps
a stack frame at **4,096**. `process_instruction` came out at 20,672.

Anchor never meets this because `Box<Account<Book>>` puts the deserialised book
on the heap. This crate has no allocator, so the fix was to stop deserialising:
`BookView` reads and writes the account bytes in place, and only one `Slot` or
`Order` is on the stack at a time.

Two things about how it was found are worth keeping:

- **`cargo build-sbf` reported the overflow and exited 0 anyway.** It printed
  `Error: Function ... overflows the maximum allowed frame space` on stderr and
  still emitted a `.so`. A build that "succeeds" and produces a binary that
  faults on entry is not something a warning count catches -- the lines begin
  with `Error:`, not `error:`.
- **All 22 host tests were green the whole time.** They exercise the engine and
  the wire formats, and neither has anything to say about frame size. Only
  `make pinocchio-market` found it.

Keeping borsh's layout has a cost worth stating: the trailing scalars sit
*after* both vectors, so appending a slot shifts the entire orders region right.
`BookView` does that memmove rather than storing at fixed maximum offsets, which
would be cheaper and would no longer be the layout Anchor reads.

### What is and is not executed

`make pinocchio-market` runs 8 on a validator: the market PDA, three ATA
creations, real SPL transfers in and out, the market PDA signing a withdrawal,
slot release, and the event wire format.

The four delegation instructions are **not** executed. `delegate_book`,
`commit_book`, `undelegate_book` and `process_undelegation` need the delegation
and magic programs, which a plain `solana-test-validator` does not carry -- that
is what `make rollup` and a MagicBlock stack are for. Their payloads are proven
byte-identical to the SDK's, which is a real check and is not the same as having
run them.

### The one thing hand-porting `market` takes on

Scoping the delegation path turned up a liability that is not about effort.

`commit_book` and `undelegate_book` do not speak Anchor and do not speak borsh.
They build `MagicBlockInstruction::ScheduleIntentBundle(MagicIntentBundleArgs)`
and serialise it with **bincode**, through `Instruction::new_with_bincode`. For
what `market` actually does the payload is small and entirely tractable -- one
committed account, every other field empty:

```text
u32(11)                        # MagicBlockInstruction::ScheduleIntentBundle
u8(1) u32(0) u64(1) u8(idx)    # commit = Some(CommitTypeArgs::Standalone([idx]))
u8(0)                          # commit_and_undelegate            = None
u8(0)                          # commit_finalize                  = None
u8(0)                          # commit_finalize_and_undelegate   = None
u64(0)                         # standalone_actions               = []
```

`undelegate_book` is the same with the first two `Option`s swapped.

The problem is `u32(11)`. That is a **positional** index into
`MagicBlockInstruction`, a `serde` enum owned by MagicBlock, not by this repo,
and it carries no version tag. If a future SDK inserts a variant ahead of
`ScheduleIntentBundle`, the Anchor build recompiles and stays correct; a
hand-encoded build keeps emitting `11` and silently targets whatever now sits
there. Anchor discriminators do not have this problem -- they are
`sha256("global:<name>")`, derived from a name rather than a position, which is
why every one of them in these ports is derived in a test rather than pinned.

This is worth doing anyway, but not blind. The mitigation is cheap and belongs
in the port: link the SDK in `dev-dependencies` and assert in the conformance
suite that the hand-built bytes equal what `MagicBlockInstruction::
ScheduleIntentBundle(..)` serialises to. That turns an unversioned positional
dependency into one that fails a test the moment the SDK moves, which is the
same trick the other two ports use for discriminators and layouts.

## `series`: what is left, and why it is not the same job

> **Update 2026-09-14: ported.** `variants/series-pinocchio` is now a complete
> fourth port — 126,128 B, 0.8791 SOL, down from 367,104 B / 2.5562 SOL
> (−65.9% on the program, −62.5% on the four-program deploy). The section
> below records why it was believed impossible; the port answers each point:
> the transfer-hook resolution is replicated byte-for-byte against SPL
> (`tests/transfer_wire.rs`, 7 tests), the money math is linked not rewritten,
> and the full lifecycle executes on a validator through the unchanged Anchor
> client (`make pinocchio-series`, 6 tests). `series` holds collateral, so the
> port stays behind its differential suites until review says otherwise.

`series` is 2.7630 SOL of the 3.8190 remaining — 72%. It is also the only
program that holds collateral, so it is the one where a missed account check
costs someone their money rather than their transaction.

Symbol breakdown of the current binary (396,640 B, Anchor with `no-idl`):

| | bytes | share |
| --- | ---: | ---: |
| series logic + other | 131,789 | 34.5% |
| **anchor** | **115,976** | **30.4%** |
| spl-token-2022 | 58,088 | 15.2% |
| solana-program | 35,400 | 9.3% |
| core / compiler-builtins | 31,680 | 8.3% |
| oracle-adapter dependency | 9,104 | 2.4% |

### Corrected: it is worth about 1.26 SOL, and it is not a Pinocchio port

An earlier version of this section estimated 120,000–160,000 B and 1.65–1.92
SOL, extrapolating from the ratio the other three achieved. Building the
dependency floor showed why that does not transfer.

`series` moves collateral through
`spl_token_2022::onchain::invoke_transfer_checked`, which is what resolves
transfer-hook extra accounts — the mechanism §9 rests on, and the reason an
issuer can arm a blocklist after a series exists without breaking it. That
function takes **`solana_program::AccountInfo`**, not Pinocchio's `AccountView`.
So the entrypoint has to hand out `AccountInfo`, and the program is not a
Pinocchio port at all: it is an Anchor-less `solana-program` program.

**Measured floor: 97,760 bytes** — a program containing nothing but that
transfer call and `common::math::compute_pools` / `compute_redeem`. No series
logic whatsoever. That is 0.6828 SOL before a single line of the protocol.

With `series`' own 2,467 lines on top, a realistic build lands near 200,000–
230,000 B, or 1.39–1.60 SOL. **The saving is about 1.26 SOL, not 1.7–1.9.**

Hand-rolling hook resolution in Pinocchio would recover some of the 58 KB. It
is roughly 14 KB of `ExtraAccountMetaList` walking and
`add_extra_accounts_for_execute_cpi`, it is security-critical, and getting it
wrong means either every transfer fails or a blocklist hook is silently
bypassed. On the one program holding collateral, for a fraction of a SOL, that
is not a trade worth making.

### So: `series` should stay on Anchor

`COMPARISON.md`'s original recommendation said exactly this — *"Token-2022
extension handling is the product, `anchor-spl` is heavy precisely because it
does that work, and the derived account checks are load-bearing for the code
that holds collateral."* Measuring the floor confirms it rather than overturns
it.

What was built before that became clear — layouts, check primitives, the error
mapping, and the `common::math` linkage — stays in `variants/series-pinocchio`
as a `lib`. It is 13 passing tests' worth of evidence about the layout and the
error surface, and it is the starting point if the calculus ever changes.

The three ports that *were* worth doing are done: 8.9230 → 3.8190 SOL.

### The money math should be linked, not reimplemented

`common/src/math.rs` — 714 lines, and **zero references to Anchor**. It is the
settlement partition, the redeem pro-rata, the shortfall haircut and the strike
adjustment: `compute_pools`, `compute_redeem`, `apply_shortfall`,
`effective_strike`, `normalize_decimals`, `checked_mul_div_*`. Its only coupling
is `MathResult<T> = Result<T, OptionsError>`, and it uses exactly eight variants
of that enum.

The other three ports reimplemented their logic and proved equivalence with
differential tests. **`series` should not.** Reimplementing this arithmetic buys
nothing and risks the one class of bug that differential fuzzing is weakest
against: both implementations being wrong in the same way because one was
written by reading the other. Linking the crate makes the math identical by
construction rather than by test.

Two ways to get there, and the tradeoff is measured rather than assumed:

**Link `common` as it stands**, pulling `anchor-lang` in for the error enum
only. **Measured**, not estimated: a minimal Pinocchio program is 4,760 bytes;
the same program with `compute_pools`, `compute_redeem`, `apply_shortfall` and
`effective_strike` linked is **18,696**. That is **13,936 bytes, 0.0970 SOL**.

An earlier version of this section estimated ~10 KB / 0.07 SOL from the error
tables in the Anchor `oracle_adapter`. The estimate was low, and it missed a
consequence that only shows up on building: `anchor-lang` brings
`solana-program`, which supplies its own global allocator and panic handler, so
the crate **cannot** use `no_allocator!` or `nostd_panic_handler!`. Declaring
them is a `duplicate lang item panic_impl` error. Part of the 13,936 is that
heavier runtime replacing Pinocchio's minimal one, not the arithmetic.

Still the recommended default. A tenth of a SOL is the right price for
arithmetic that cannot drift on the one program holding collateral — but it is
a tenth, not the fifteen-hundredths this file first claimed, and the `no_std`
property is lost with it.

**Or feature-gate `common`** so `math` compiles without `anchor-lang`. Cleaner
and free, but `#[error_code]` generates the enum *and* consumes the `#[msg]`
attributes on every variant, so the gate has to be per-variant or the enum has
to be declared twice — and a second declaration is exactly the transcription
risk the whole exercise is trying to avoid. Worth doing only if the 0.07 SOL
matters more than the extra surface, which on these numbers it does not.

### What the port still has to write by hand

Everything `common::math` does not cover: the account checks. Ten instructions,
and the Token-2022 paths are the hard part — `invoke_transfer_checked` resolving
transfer-hook accounts, the `ScaledUiAmountConfig` read, and `sweep_dust`, which
takes the entire remaining balance once both supplies are zero.

`variants/ACCOUNT-CHECKS.md` is the format that mapping should take.

## Build flags: 3.8144 -> 3.5070 SOL

Two changes, neither touching program source.

| program | build | before | after | saved |
| --- | --- | ---: | ---: | ---: |
| oracle_adapter | Pinocchio | 28,904 B / 0.2024 | 25,960 B / 0.1819 | 0.0205 |
| factory | Pinocchio | 40,368 B / 0.2822 | 36,592 B / 0.2559 | 0.0263 |
| market | Pinocchio | 81,440 B / 0.5680 | 73,528 B / 0.5130 | 0.0551 |
| series | Anchor, `no-idl` | 396,640 B / 2.7618 | 367,104 B / 2.5562 | 0.2056 |
| | | **3.8144** | **3.5070** | **0.3074** |

### 1. Two rustc flags, 0.2091 SOL

- `-Zlocation-detail=none` drops the file/line/column record behind every
  `#[track_caller]` panic. 8,512 B on `series`.
- `-Zfmt-debug=none` drops the bodies of derived `Debug` impls. 6,904 B.

Additive: 15,416 B together on `series`, the sum of the two measured alone.

Neither costs observability here. No program in this repo calls `msg!` and no
program source formats a `{:?}`; both greps return nothing. Errors surface as
Anchor codes, which are string constants in `.rodata` and untouched by either
flag. The 20 validator tests that assert on specific codes
(`6035`/`FeedMismatch`, `6002`/`Unauthorized`, the factory's owner check, the
market's self-fill refusal) pass unchanged.

The Anchor builds shrink too, though only `series` is on the deploy path:
`oracle_adapter` 167,008 -> 147,432, `factory` 242,696 -> 229,696, `market`
363,848 -> 346,408, `test_transfer_hook` 89,496 -> 55,608.

#### They have to be target-scoped

As plain `RUSTFLAGS` the build fails:

```
error: the option `Z` is only accepted on the nightly compiler
```

`cargo-build-sbf` folds `RUSTFLAGS` into its own target flags and passes them to
the SBF rustc, which is 1.89.0-dev and accepts `-Z` -- the wrapper already
passes it `-Zremap-cwd-prefix=`. But `anchor build` also runs a host cargo whose
rustc is the rustup stable toolchain, and cargo strips `RUSTC_BOOTSTRAP` from
its version probe, so the flags reach a compiler that rejects them.

`CARGO_TARGET_SBPF_SOLANA_SOLANA_RUSTFLAGS` scopes them to the target. Host
rustc never sees them, no bootstrap variable is needed, and the binaries come
out byte-identical to a `RUSTC_BOOTSTRAP=1 RUSTFLAGS=...` build. That is
`SBF_ENV` in the Makefile.

`.cargo/config.toml` does not work: `cargo-build-sbf` sets the same env var
itself, and env beats config.

### 2. `opt-level = "z"` reaching dependencies, 0.0983 SOL

`[profile.release]` was `opt-level = 3` with per-package overrides to `"z"` for
`series`, `factory`, `oracle-adapter` and `market`. An override applies to that
crate alone, so every dependency kept building at 3 -- including `anchor-lang`,
`anchor-spl` and `spl-token-2022`, which are most of the `series` binary.

Moving `opt-level = "z"` onto `[profile.release]` takes `series` from 381,224 to
367,104 B. The four Pinocchio variants already set it on the profile, which is
part of why they measure as small as they do.

`cargo-build-sbf` also composes `-C opt-level=s` into the target flags when it
sets them itself. Presetting `CARGO_TARGET_SBPF_SOLANA_SOLANA_RUSTFLAGS`
displaces that, so the profile decides.

#### What it costs in CU

Across the e2e suite, `series` only:

| | max CU | median CU |
| --- | ---: | ---: |
| dependencies at `opt-level = 3` | 98,261 | 4,492 |
| dependencies at `opt-level = "z"` | 122,080 | 4,492 |

The median does not move. The heaviest instruction rises 24%, leaving 39%
headroom against the 200,000 default rather than 51%. e2e passes 12 either way.

That figure does not cover the heaviest path. "runs the full lifecycle with the
hook armed" was pending in both runs -- its fixtures expire during the
56-second wait for the Pyth snapshots to become settleable -- so 122,080 is the
maximum observed, not the maximum available. Fixing the fixture timing is what
would close it.

### Built by `make`

`make build` carries the flags. `make variants` is new and builds the three
Pinocchio deploy artifacts with them; before this the variants had no make
target and this file told you to build them by hand, which costs 0.1018 SOL in
missed flags. Checked by deleting
`variants/oracle-adapter-pinocchio/target/sbpf-solana-solana` and rebuilding
through the target: 25,960 B, not 28,904.

## Measured and rejected: `no-log-ix-name`

Declared by every program and never enabled, like `no-idl` was. Enabling it
saves **0.024 SOL** across all four and removes the `Program log: Instruction:
X` line from every invocation. Left off: the observability on a live deploy is
worth more than a fortieth of a SOL.

## Measured and blocked: SBPF v2 and v3

`cargo-build-sbf` 3.0.13 takes `--arch`, default `v0`. v3 drops relocation
entirely: `.rel.dyn`, `.dynsym`, `.dynstr` and `.dynamic` disappear from the
ELF, leaving `.text`, `.rodata` and `.shstrtab`. On `series` the `.rel.dyn`
section alone is 27,520 bytes.

Built at both, across the whole deploy path:

| program | build | v0 | v3 | saved |
| --- | --- | ---: | ---: | ---: |
| oracle_adapter | Pinocchio | 28,904 B / 0.2024 | 26,224 B / 0.1837 | 0.0187 |
| factory | Pinocchio | 40,368 B / 0.2822 | 36,600 B / 0.2559 | 0.0262 |
| market | Pinocchio | 81,440 B / 0.5680 | 75,032 B / 0.5234 | 0.0446 |
| series | Anchor, `no-idl` | 396,640 B / 2.7618 | 368,360 B / 2.5650 | 0.1968 |
| | | **3.8144** | **3.5281** | **0.2863** |

**0.2863 SOL, 7.5%, for a build flag** — no rewrite and no new attack surface,
which is the shape this file has twice called the one worth taking first. The
intermediate arches are not worth a second look: v1 came out *larger* than v0
(397,928 B) and v2 saved 96 bytes.

**It does not deploy.** `SIMD-0178, SIMD-0179 and SIMD-0189: Enable deployment
and execution of SBPFv3 programs`
(`BUwGLeF3Lxyfv1J1wY8biFHBB2hrk2QhbNftQf3VV3cC`) reads `inactive` on **mainnet
and devnet both**, as does `SIMD-0167: Enable Loader-v4`.

That was established by running it rather than by reading the gate.
`make pinocchio-oracle` against the v3 binary fails all 6 on `Program is not
deployed` / `Unsupported program id`; rebuilt at v0 and put through the same
suite it passes 6. A local `solana-test-validator` does not carry the feature
either, so there is nowhere to execute one today — which also means a v3 build
cannot be conformance-tested before the gate opens.

Banked, not spendable. It costs one flag in the `build` target and in the three
`cargo build-sbf` lines on the day that gate activates, and `solana feature
status` is worth re-reading before any mainnet deploy.

## Measured and impossible: dropping `zk-ops`

`series` depends on `spl-token-2022` 8.0 directly, and its default feature
`zk-ops` gates confidential-transfer arithmetic this protocol never touches.
`default-features = false` does not build — `spl-token-2022` 8.0.1 fails with
seven errors, `confidential_mint_burn::verify_proof` and
`ciphertext_arithmetic` unresolved, because the crate's own non-`zk-ops` path
is broken upstream. Not a trade that was declined; an option that is not there.

## What the saving is worth, and where it is not

Every figure above is for a *fresh* deploy. Read from devnet on 2026-08-21:

| program | on-chain data length | balance |
| --- | ---: | ---: |
| oracle_adapter | 231,984 B | 1.6158 |
| series | 432,560 B | 3.0118 |
| factory | 278,968 B | 1.9428 |
| market | 364,344 B | 2.5370 |
| | | **9.1075** |

`series` and `factory` sit 35,920 and 36,272 bytes above their current `no-idl`
binaries — precisely the IDL-handler weight the first free win removed.
`market` is 496 above and never carried any. `oracle_adapter` is larger than
any build measured in this file (202,776 B as Anchor before `no-idl`, 167,008
after), so that one predates more than the IDL change. **Devnet is running
pre-optimization builds throughout, and none of the 5.11 SOL has been realized
on any cluster.**

It does confirm the rent formula against ground truth rather than arithmetic:
`market` at 364,344 B holds 2.53703832 SOL, and `(364,344 + 173) * 6960` is
2.53703832 to the lamport. Nothing over-allocates — `solana program deploy`
takes the binary's length, not double it.

The part that matters for planning: **upgrading into these accounts recovers
nothing.** A ProgramData account can be extended and never shrunk, so deploying
the 40,368-byte `factory` over the 278,968-byte one leaves the account at
278,968 bytes and the 1.94 SOL where it is. Capturing the saving means
`solana program close` and a redeploy to a *fresh* address — which changes the
program id, and `deployments/devnet.json` already records what that costs in
its `mock_oracle` entry.

On mainnet, where nothing is deployed, 3.8144 SOL applies directly to the first
deploy. That is where this work gets paid.

## Recommendation

- **`oracle-adapter` is a genuine Pinocchio candidate.** One PDA, no custody,
  proven byte-identical to the Anchor build, and it frees ~0.97 SOL over the
  `no-idl` baseline.
- **`factory` is ported and verified** — 24 conformance tests, 6 on a validator,
  1.41 SOL. It holds no collateral, which is what made it the safe second step.
- **`market` is next** — order book on a rollup hot path, CU-sensitive, no
  Token-2022 dependency, but 60 KB of MagicBlock SDK that only partly ports.
- **`series` is the one to weigh hardest.** Token-2022 extension handling is the
  product, `anchor-spl` is heavy precisely because it does that work, and the
  derived account checks are load-bearing for the code that holds collateral. If
  it is ported, it needs the differential treatment the other two got, and the
  e2e suite run against the ported build before any deploy.
- **Do not rewrite anything to solve a faucet limit.** Devnet SOL is free. This
  work is worth doing for mainnet economics and for CU, not to dodge an airdrop
  cap.
- **Free first.** Enabling the `no-idl` cargo feature — declared in every
  program and never switched on — removed ~36 KB from each of three programs for
  0.766 SOL, with no rewrite and no new attack surface. Nothing reads the
  on-chain IDL; every client loads `web/lib/idl/*.json`.
- **Take the build flags.** `-Zlocation-detail=none`, `-Zfmt-debug=none` and
  `opt-level = "z"` on the profile are 0.3074 SOL between them, with no source
  change. `make build` and `make variants` carry them. The only cost is 24% on
  the heaviest `series` instruction, which still leaves 39% headroom.
- **The byte levers are otherwise exhausted.** `no-idl` and the build flags were
  taken, `no-log-ix-name` was declined for observability, `zk-ops` cannot be
  turned off, and `--arch v3` — a further 0.2863 SOL — has no cluster that will
  load it. What remains below 3.5070 SOL is the `series` port, and the section
  above measures why that is 1.26 SOL rather than the 1.7–1.9 first assumed, on
  the one program holding collateral.
- **Re-read `solana feature status` before a mainnet deploy.** Two gates would
  change this file the day they activate: SBPFv3 (0.2863 SOL, a build flag) and
  Loader-v4.

## Reproducing

```sh
# Anchor build
make build && stat -f%z target/deploy/oracle_adapter.so

# Pinocchio build
cd variants/oracle-adapter-pinocchio
cargo build-sbf --tools-version v1.54
stat -f%z target/deploy/oracle_adapter_pinocchio.so

# conformance (links both crates)
cargo test --test conformance

# the factory port
cd ../factory-pinocchio && cargo build-sbf --tools-version v1.54
cargo test --test conformance

# and the tiers that actually execute them
make pinocchio-oracle    # 6
make pinocchio-factory   # 6

# the arch measurement, and the gate that blocks it
cargo build-sbf --tools-version v1.54 --arch v3
solana feature status -u m | grep -i sbpf

# what is actually deployed, against the formula below
solana program show <program-id> -u d
```

Rent for any binary: `(bytes + 173) * 6960` lamports.
