// SPDX-License-Identifier: Apache-2.0
//! Everything that touches the Token-2022 collateral mint.
//!
//! Two jobs: reading the `scaledUiAmount` multiplier that drives the
//! corporate-action adjustment (§6), and moving collateral in a way that keeps
//! working the day the issuer arms the transfer hook (§9).
//!
//! The TLV decode and the transfer CPI both live in [`crate::transfer`]; this
//! module is the policy around them. `spl-token-2022` is not linked at all —
//! it is a dev-dependency of the transfer wire tests only, where it serves as
//! the reference implementation.

use {
    crate::{error::err, transfer},
    common::{multiplier_to_fixed, resolve_multiplier, OptionsError},
    pinocchio::{account::AccountView, cpi::Seed, error::ProgramError},
};

/// The `scaledUiAmount` state of a mint: what a raw unit means now, and what
/// it is scheduled to mean later.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MintMultipliers {
    pub current: f64,
    pub new: f64,
    pub new_effective_ts: i64,
}

impl MintMultipliers {
    /// A mint with no `scaledUiAmount` extension: one raw unit is one share,
    /// forever. This is the plain-SPL case that step 2 of the build order
    /// runs against, and it must behave identically to a Token-2022 mint whose
    /// multiplier happens to be 1.
    pub const IDENTITY: Self = Self {
        current: 1.0,
        new: 1.0,
        new_effective_ts: 0,
    };

    /// The multiplier in force at `as_of_ts`.
    ///
    /// Settlement must call this with the *price* timestamp, not the
    /// instruction's clock: a corporate action that lands between the print
    /// and the `settle` transaction has not happened yet as far as that price
    /// is concerned.
    pub fn effective_at(&self, as_of_ts: i64) -> f64 {
        resolve_multiplier(self.current, self.new, self.new_effective_ts, as_of_ts)
    }

    /// The multiplier in force at `as_of_ts`, as fixed-point.
    pub fn fixed_at(&self, as_of_ts: i64) -> Result<i128, ProgramError> {
        Ok(multiplier_to_fixed(self.effective_at(as_of_ts)).map_err(err)?)
    }

    /// Whether a multiplier change lands strictly between two instants.
    pub fn changes_between(&self, from_ts: i64, to_ts: i64) -> bool {
        self.effective_at(from_ts) != self.effective_at(to_ts)
    }
}

/// Read the `scaledUiAmount` extension off a mint account.
///
/// A mint without the extension — a plain SPL Token mint, or a Token-2022 mint
/// that never enabled it — reads as [`MintMultipliers::IDENTITY`] rather than
/// failing, so the same code path serves both.
pub fn read_multipliers(mint: &AccountView) -> Result<MintMultipliers, ProgramError> {
    let data = mint.try_borrow()?;
    let (current, new, new_effective_ts) = transfer::scaled_ui_amount(&data)?;
    let multipliers = MintMultipliers {
        current,
        new,
        new_effective_ts,
    };
    // Reject an unreadable multiplier here rather than letting a NaN
    // reach the strike adjustment.
    multiplier_to_fixed(multipliers.current).map_err(err)?;
    multiplier_to_fixed(multipliers.new).map_err(err)?;
    Ok(multipliers)
}

/// Refuse to open a series that would settle through a corporate action we
/// already know about (§6).
///
/// A scheduled rebase is knowable at creation. The strike adjustment handles a
/// pure split exactly, but a rebased cash dividend it cannot — so where the
/// operator has the choice, they should make it, by picking a different
/// maturity rather than settling through a known action.
pub fn require_no_scheduled_change(
    multipliers: &MintMultipliers,
    now: i64,
    maturity_ts: i64,
) -> Result<(), ProgramError> {
    if multipliers.changes_between(now, maturity_ts) {
        return Err(err(OptionsError::MultiplierChangeScheduled));
    }
    Ok(())
}

/// Move collateral, surviving an armed transfer hook.
///
/// `transfer_checked` is used for two reasons: it is the only transfer
/// instruction Token-2022 will run a transfer hook for, and passing the
/// decimals explicitly means a mint whose decimals do not match the series
/// config fails loudly instead of moving the wrong amount.
///
/// The hook is dormant on TSLAx today (`transferHook.programId` is `None`) and
/// can be armed by the authority without redeploying the mint. Routing through
/// the hook-aware planner means that day is a non-event: the hook program and
/// its extra account metas resolve from `additional_accounts` and join the
/// instruction. When no hook is armed, `additional_accounts` is simply empty
/// and this is an ordinary transfer.
///
/// Callers pass the trailing accounts straight through. Off-chain, the extra
/// accounts are resolved with the `spl-transfer-hook-interface` helper and
/// appended to the transaction.
#[allow(clippy::too_many_arguments)]
pub fn transfer_collateral(
    token_program: &AccountView,
    from: &AccountView,
    mint: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    additional_accounts: &[&AccountView],
    amount: u64,
    decimals: u8,
    signer_seeds: &[Seed],
) -> Result<(), ProgramError> {
    if amount == 0 {
        return Ok(());
    }
    transfer::invoke_transfer_checked(
        token_program,
        from,
        mint,
        to,
        authority,
        additional_accounts,
        amount,
        decimals,
        signer_seeds,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use common::MULTIPLIER_SCALE;

    const MATURITY: i64 = 1_760_000_000;

    #[test]
    fn a_mint_without_the_extension_reads_as_identity() {
        let m = MintMultipliers::IDENTITY;
        assert_eq!(m.effective_at(0), 1.0);
        assert_eq!(m.effective_at(MATURITY), 1.0);
        assert_eq!(m.fixed_at(MATURITY).unwrap(), MULTIPLIER_SCALE);
        assert!(!m.changes_between(0, i64::MAX));
    }

    #[test]
    fn a_scheduled_change_resolves_against_the_instant_asked_about() {
        let m = MintMultipliers {
            current: 1.0,
            new: 2.0,
            new_effective_ts: MATURITY,
        };
        assert_eq!(m.effective_at(MATURITY - 1), 1.0);
        assert_eq!(m.effective_at(MATURITY), 2.0);
        assert_eq!(m.fixed_at(MATURITY - 1).unwrap(), MULTIPLIER_SCALE);
        assert_eq!(m.fixed_at(MATURITY).unwrap(), 2 * MULTIPLIER_SCALE);
    }

    #[test]
    fn creation_refuses_a_series_that_would_span_a_known_split() {
        let m = MintMultipliers {
            current: 1.0,
            new: 2.0,
            new_effective_ts: MATURITY - 86_400,
        };
        // The split lands inside the term: refuse, and make the operator pick
        // a different maturity.
        assert!(require_no_scheduled_change(&m, MATURITY - 200_000, MATURITY).is_err());
        // A series that matures before the split is fine.
        assert!(require_no_scheduled_change(&m, MATURITY - 200_000, MATURITY - 100_000).is_ok());
        // So is one that opens after it has already landed.
        assert!(require_no_scheduled_change(&m, MATURITY, MATURITY + 100_000).is_ok());
    }

    /// The scenario the creation-time check alone does not cover.
    ///
    /// A series opens against a mint with nothing scheduled, so creation
    /// passes. The issuer later schedules a multiplier change landing before
    /// maturity. Nothing about the series changed, but it is now unsafe to mint
    /// into -- and the only thing standing between a new holder and that series
    /// is the same check, run again at `split`.
    #[test]
    fn a_change_scheduled_after_creation_is_caught_on_the_next_split() {
        let open_ts = MATURITY - 300_000;

        // At creation nothing is scheduled, so the series opens.
        let clean = MintMultipliers::IDENTITY;
        assert!(require_no_scheduled_change(&clean, open_ts, MATURITY).is_ok());

        // The issuer then schedules a 2-for-1 landing inside the term.
        let scheduled = MintMultipliers {
            current: 1.0,
            new: 2.0,
            new_effective_ts: MATURITY - 100_000,
        };

        // Creation would now be refused -- and so must every later split.
        assert!(
            require_no_scheduled_change(&scheduled, open_ts + 1, MATURITY).is_err(),
            "a split into a series with a scheduled change must be refused"
        );

        // But only the entrance closes. A holder whose maturity falls before
        // the change can still be served, which is the case the guard must not
        // over-reject.
        assert!(
            require_no_scheduled_change(&scheduled, open_ts + 1, MATURITY - 200_000).is_ok(),
            "a series maturing before the change is still safe to mint into"
        );
    }

    #[test]
    fn an_unscheduled_mint_never_looks_like_a_pending_change() {
        // Token-2022 carries `new == current` when nothing is scheduled.
        let m = MintMultipliers {
            current: 1.5,
            new: 1.5,
            new_effective_ts: 0,
        };
        assert!(!m.changes_between(0, i64::MAX));
        assert!(require_no_scheduled_change(&m, 0, i64::MAX).is_ok());
    }
}
