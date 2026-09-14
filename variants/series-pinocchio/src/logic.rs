// SPDX-License-Identifier: Apache-2.0
//! Every decision the series makes, with no accounts involved.
//!
//! The instruction handlers in `lib.rs` are deliberately thin: they gather
//! account state, call into this module, and move tokens according to what it
//! returns. Keeping the rules here is what lets the invariants in §12 of the
//! implementation plan be tested on the host, without a validator, at the
//! speed that makes them worth running on every commit.

use crate::{error::err, state::SeriesStatus};
use common::{
    apply_shortfall, checked_mul_div_floor, compute_pools, compute_redeem, effective_strike,
    normalize_decimals, OptionsError, MAX_DECIMALS,
};
use pinocchio::error::ProgramError;

/// Basis-point denominator.
pub const BPS_DENOMINATOR: i128 = 10_000;

// --- Lifecycle guards -----------------------------------------------------

/// `split` is allowed only on an open, pre-maturity series.
pub fn require_splittable(status: SeriesStatus, now: i64, maturity_ts: i64) -> Result<(), ProgramError> {
    if !(status != SeriesStatus::Settled) {
        return Err(err(OptionsError::AlreadySettled));
    }
    if !(status == SeriesStatus::Open) {
        return Err(err(OptionsError::SeriesPaused));
    }
    if !(now < maturity_ts) {
        return Err(err(OptionsError::SeriesClosed));
    }
    Ok(())
}

/// `merge` is allowed while `Open` *or* `Paused`, but never after settlement.
///
/// The asymmetry is deliberate: pausing stops
/// new risk being created without trapping collateral that already is.
pub fn require_mergeable(status: SeriesStatus, now: i64, maturity_ts: i64) -> Result<(), ProgramError> {
    if !(status != SeriesStatus::Settled) {
        return Err(err(OptionsError::AlreadySettled));
    }
    if !(now < maturity_ts) {
        return Err(err(OptionsError::SeriesClosed));
    }
    Ok(())
}

/// `settle` is callable once, and only after the maturity plus its delay.
pub fn require_settleable(
    status: SeriesStatus,
    now: i64,
    maturity_ts: i64,
    settlement_delay_secs: i64,
) -> Result<(), ProgramError> {
    if !(status != SeriesStatus::Settled) {
        return Err(err(OptionsError::AlreadySettled));
    }
    if !(now >= maturity_ts) {
        return Err(err(OptionsError::SeriesNotMatured));
    }
    let settle_at = maturity_ts.saturating_add(settlement_delay_secs);
    if !(now >= settle_at) {
        return Err(err(OptionsError::SettlementTooEarly));
    }
    Ok(())
}

/// The structural market-status check (§8).
///
/// A quote may only settle a series if it was printed in the window that
/// starts at maturity and runs `max_price_lag_secs` past it. With
/// `maturity_ts` placed at a real US market close, this is what stops a series
/// settling against a 03:00 Sunday print on thin liquidity — and it holds
/// against Pyth, which publishes no trading status on-chain for the adapter to
/// gate on.
///
/// `max_price_lag_secs` must be chosen wide enough to cover the gap to the
/// next valid print if the close itself is missed, and narrow enough that the
/// window cannot reach into the following session.
pub fn require_settlement_window(
    quote_ts: i64,
    maturity_ts: i64,
    max_price_lag_secs: i64,
) -> Result<(), ProgramError> {
    if !(quote_ts >= maturity_ts) {
        return Err(err(OptionsError::OraclePriceStale));
    }
    let deadline = maturity_ts.saturating_add(max_price_lag_secs);
    if !(quote_ts <= deadline) {
        return Err(err(OptionsError::MarketClosed));
    }
    Ok(())
}

/// Ensure settlement becomes callable while at least one quote can still pass
/// both the timestamp window and the applicable staleness bounds.
///
/// The series and its feed config each impose a maximum quote age, so the
/// effective limit is the tighter of the two. At the first instant settlement
/// is callable, the newest admissible quote was printed at
/// `maturity + max_price_lag_secs`; if that quote is already too old, every
/// later call is impossible as well.
pub fn validate_settlement_timing(
    settlement_delay_secs: i64,
    max_oracle_age_secs: i64,
    max_price_lag_secs: i64,
    feed_max_age_secs: i64,
) -> Result<(), ProgramError> {
    if !(settlement_delay_secs >= 0) {
        return Err(err(OptionsError::InvalidParams));
    }
    if !(max_oracle_age_secs > 0) {
        return Err(err(OptionsError::InvalidParams));
    }
    if !(max_price_lag_secs > 0) {
        return Err(err(OptionsError::InvalidParams));
    }
    if !(feed_max_age_secs > 0) {
        return Err(err(OptionsError::InvalidParams));
    }

    let effective_max_age = max_oracle_age_secs.min(feed_max_age_secs);
    let latest_usable_quote_age = max_price_lag_secs
        .checked_add(effective_max_age)
        .ok_or(OptionsError::InvalidParams)
        .map_err(err)?;
    if !(settlement_delay_secs <= latest_usable_quote_age) {
        return Err(err(OptionsError::InvalidParams));
    }
    Ok(())
}

// --- Settlement -----------------------------------------------------------

/// Everything `settle` needs that is not an account.
#[derive(Clone, Copy, Debug)]
pub struct SettleParams {
    pub strike: i128,
    pub price_decimals: u32,
    /// `MULTIPLIER_SCALE` fixed-point, captured at creation.
    pub multiplier_at_creation: i128,
    /// `MULTIPLIER_SCALE` fixed-point, resolved as of the price timestamp.
    pub multiplier_at_settlement: i128,
    pub collateral: u64,
    pub quote_price: i128,
    pub quote_decimals: u32,
}

/// The frozen result of a settlement.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Pools {
    pub price: i128,
    pub effective_strike: i128,
    pub p_pool: u64,
    pub n_pool: u64,
}

/// Normalize the quote, adjust the strike for any corporate action, and
/// partition the collateral.
///
/// The order matters. The strike is adjusted *before* the comparison against
/// the price, because the whole point of §6 is that a rebase moves the price
/// and the strike together; comparing a post-split price against a pre-split
/// strike is exactly the bug.
pub fn compute_settlement(params: &SettleParams) -> Result<Pools, ProgramError> {
    if !(params.price_decimals <= MAX_DECIMALS) {
        return Err(err(OptionsError::InvalidDecimals));
    }
    let price = normalize_decimals(
        params.quote_price,
        params.quote_decimals,
        params.price_decimals,
    )
    .map_err(err)?;
    if !(price > 0) {
        return Err(err(OptionsError::OraclePriceInvalid));
    }

    let effective = effective_strike(
        params.strike,
        params.multiplier_at_creation,
        params.multiplier_at_settlement,
    )
    .map_err(err)?;

    let (p_pool, n_pool) =
        compute_pools(params.collateral as i128, effective, price).map_err(err)?;

    Ok(Pools {
        price,
        effective_strike: effective,
        p_pool: to_u64(p_pool)?,
        n_pool: to_u64(n_pool)?,
    })
}

/// What settlement observed about the series' health, as flags rather than as
/// reverts.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Default)]
pub struct SettlementHealth {
    /// The two claim supplies disagree. Someone burned P or N outside the
    /// protocol; whoever did forfeits to the rest of their own side.
    pub supply_mismatch: bool,
    /// The vault holds less than the senior claim outstanding.
    pub under_collateralized: bool,
}

/// Record the state of the series at settlement without gating on it.
///
/// # Why this does not revert
///
/// The obvious implementation gates settlement on `p_supply == n_supply` and
/// `collateral >= p_supply`, reverting otherwise. That is a permanent denial
/// of service here, for two reasons:
///
/// 1. `P` and `N` are plain SPL mints, so **any holder can burn their own
///    tokens** without going through this program. Burning a single unit of P
///    makes the supplies disagree forever. `settle` would revert on every
///    call, `merge` is already closed after maturity, and every holder's
///    collateral is stranded for good — at a cost to the attacker of one raw
///    token unit.
/// 2. The issuer's permanent delegate can drain the vault *before* maturity as
///    easily as after. A collateral gate hands them a way to freeze a series
///    permanently rather than merely to take from it.
///
/// Neither condition threatens solvency, which is what those checks were
/// really protecting. `compute_pools` partitions whatever collateral is
/// actually present, so `p_pool + n_pool == collateral` however the supplies
/// look, and redemption pays at most `pool * amount / supply_at_settlement`
/// per side. A holder who burned their claim simply leaves more of their own
/// side's pool to everyone else on it.
///
/// So settlement records both conditions and proceeds. This is the same
/// posture §7 takes on a post-settlement drain: price it, do not gate it.
pub fn assess_settlement_health(collateral: u64, p_supply: u64, n_supply: u64) -> SettlementHealth {
    SettlementHealth {
        supply_mismatch: p_supply != n_supply,
        under_collateralized: collateral < p_supply.max(n_supply),
    }
}

// --- Redemption -----------------------------------------------------------

/// What one redemption pays.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Payout {
    /// The holder's pro-rata claim against the frozen pool.
    pub quoted: u64,
    /// What the vault can actually pay, after any proportional haircut.
    pub paid: u64,
    /// Whether the vault held less than it owed at this moment.
    pub shortfall: bool,
}

/// Price one redemption, applying the shortfall haircut if the vault has been
/// drained (§7).
///
/// `outstanding` is the *quoted* claim still owed across both sides, not the
/// original pools — that is what keeps the ratio stable as redemptions
/// proceed, so a holder arriving late sees the same haircut as one arriving
/// early instead of finding an empty vault.
pub fn redeem_payout(
    amount: u64,
    pool: u64,
    supply_at_settlement: u64,
    outstanding: u64,
    vault_balance: u64,
) -> Result<Payout, ProgramError> {
    if !(amount > 0) {
        return Err(err(OptionsError::InvalidAmount));
    }
    let quoted = to_u64(compute_redeem(
        amount as i128,
        pool as i128,
        supply_at_settlement as i128,
    )
    .map_err(err)?)?;
    let shortfall = vault_balance < outstanding;
    let paid = to_u64(apply_shortfall(
        quoted as i128,
        vault_balance as i128,
        outstanding as i128,
    )
    .map_err(err)?)?;
    // A haircut can only ever reduce a payout.
    if !(paid <= quoted) {
        return Err(err(OptionsError::MathOverflow));
    }
    Ok(Payout {
        quoted,
        paid,
        shortfall,
    })
}

// --- Fees -----------------------------------------------------------------

/// Split-time fee, floored. `0` for V1.
pub fn fee_amount(amount: u64, fee_bps: u16) -> Result<u64, ProgramError> {
    if fee_bps == 0 {
        return Ok(0);
    }
    to_u64(checked_mul_div_floor(
        amount as i128,
        fee_bps as i128,
        BPS_DENOMINATOR,
    )
    .map_err(err)?)
}

// --- Creation-time validation ---------------------------------------------

/// The minimum any series must satisfy, whatever created it.
///
/// The factory layers stricter policy bounds on top; this is the floor below
/// which a series is not merely ill-advised but incoherent.
#[allow(clippy::too_many_arguments)]
pub fn validate_series_params(
    strike: i128,
    price_decimals: u32,
    maturity_ts: i64,
    now: i64,
    settlement_delay_secs: i64,
    max_oracle_age_secs: i64,
    max_price_lag_secs: i64,
    min_split_amount: u64,
    fee_bps: u16,
    multiplier_at_creation: i128,
) -> Result<(), ProgramError> {
    if !(strike > 0) {
        return Err(err(OptionsError::InvalidStrike));
    }
    if !(price_decimals > 0 && price_decimals <= MAX_DECIMALS) {
        return Err(err(OptionsError::InvalidDecimals));
    }
    if !(maturity_ts > now) {
        return Err(err(OptionsError::InvalidMaturity));
    }
    validate_settlement_timing(
        settlement_delay_secs,
        max_oracle_age_secs,
        max_price_lag_secs,
        max_oracle_age_secs,
    )?;
    if !(min_split_amount > 0) {
        return Err(err(OptionsError::InvalidParams));
    }
    if !(fee_bps as i128 <= BPS_DENOMINATOR) {
        return Err(err(OptionsError::InvalidParams));
    }
    if !(multiplier_at_creation > 0) {
        return Err(err(OptionsError::MultiplierInvalid));
    }
    Ok(())
}

fn to_u64(value: i128) -> Result<u64, ProgramError> {
    u64::try_from(value).map_err(|_| err(OptionsError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;
    use common::{multiplier_to_fixed, resolve_multiplier, MULTIPLIER_SCALE};

    const USD: i128 = 100_000_000; // 8 decimals, matching TSLAx and Pyth's -8
    const ONE_TOKEN: u64 = 100_000_000; // 1 TSLAx in raw units
    const STRIKE_500: i128 = 500 * USD;
    const MATURITY: i64 = 1_760_000_000;

    fn params(collateral: u64, price_usd: i128, m_settlement: i128) -> SettleParams {
        SettleParams {
            strike: STRIKE_500,
            price_decimals: 8,
            multiplier_at_creation: MULTIPLIER_SCALE,
            multiplier_at_settlement: m_settlement,
            collateral,
            quote_price: price_usd,
            quote_decimals: 8,
        }
    }

    // --- §12 carried over: lifecycle ------------------------------------

    #[test]
    fn split_requires_an_open_pre_maturity_series() {
        assert!(require_splittable(SeriesStatus::Open, MATURITY - 1, MATURITY).is_ok());
        assert!(require_splittable(SeriesStatus::Paused, MATURITY - 1, MATURITY).is_err());
        assert!(require_splittable(SeriesStatus::Settled, MATURITY - 1, MATURITY).is_err());
        // At maturity exactly, splitting is already closed.
        assert!(require_splittable(SeriesStatus::Open, MATURITY, MATURITY).is_err());
    }

    #[test]
    fn merge_works_while_paused_but_never_after_settlement() {
        // Invariant 6. A pause must not trap collateral.
        assert!(require_mergeable(SeriesStatus::Open, MATURITY - 1, MATURITY).is_ok());
        assert!(require_mergeable(SeriesStatus::Paused, MATURITY - 1, MATURITY).is_ok());
        assert!(require_mergeable(SeriesStatus::Settled, MATURITY - 1, MATURITY).is_err());
        assert!(require_mergeable(SeriesStatus::Open, MATURITY, MATURITY).is_err());
    }

    #[test]
    fn settle_is_callable_once_and_only_after_maturity_plus_delay() {
        // Invariant 7.
        let delay = 3_600;
        assert!(require_settleable(SeriesStatus::Open, MATURITY - 1, MATURITY, delay).is_err());
        assert!(require_settleable(SeriesStatus::Open, MATURITY, MATURITY, delay).is_err());
        assert!(
            require_settleable(SeriesStatus::Open, MATURITY + delay - 1, MATURITY, delay).is_err()
        );
        assert!(require_settleable(SeriesStatus::Open, MATURITY + delay, MATURITY, delay).is_ok());
        // Already settled: never again, however late.
        assert!(
            require_settleable(SeriesStatus::Settled, MATURITY + delay, MATURITY, delay).is_err()
        );
    }

    #[test]
    fn settlement_records_health_instead_of_gating_on_it() {
        // Invariants 1 and 2, as observations rather than preconditions.
        let healthy = assess_settlement_health(100, 100, 100);
        assert!(!healthy.supply_mismatch);
        assert!(!healthy.under_collateralized);

        assert!(!assess_settlement_health(150, 100, 100).under_collateralized);
        assert!(assess_settlement_health(100, 100, 99).supply_mismatch);
        assert!(assess_settlement_health(99, 100, 100).under_collateralized);
    }

    #[test]
    fn burning_a_claim_token_cannot_strand_a_series() {
        // The denial of service this replaced a revert to avoid. `P` and `N`
        // are plain SPL mints, so anyone can burn one unit of P and make the
        // supplies disagree forever. Under the old gate that bricked `settle`
        // permanently, and `merge` is already closed after maturity, so every
        // holder's collateral was stranded for the price of one raw unit.
        let health = assess_settlement_health(ONE_TOKEN, ONE_TOKEN - 1, ONE_TOKEN);
        assert!(health.supply_mismatch, "the mismatch is still recorded");

        // Settlement proceeds, and solvency is unaffected: the pools still
        // partition the whole vault.
        let pools = compute_settlement(&params(ONE_TOKEN, 1_000 * USD, MULTIPLIER_SCALE)).unwrap();
        assert_eq!(pools.p_pool + pools.n_pool, ONE_TOKEN);

        // The holder who burned simply leaves more of their own side's pool to
        // everyone else on it. Redeeming the whole reduced P supply still pays
        // at most the P pool, never more.
        let reduced_supply = ONE_TOKEN - 1;
        let payout = redeem_payout(
            reduced_supply,
            pools.p_pool,
            reduced_supply,
            pools.p_pool + pools.n_pool,
            ONE_TOKEN,
        )
        .unwrap();
        assert_eq!(
            payout.paid, pools.p_pool,
            "the remaining P holders split it all"
        );
        assert!(payout.paid <= pools.p_pool, "and never more than the pool");
    }

    #[test]
    fn a_pre_settlement_drain_cannot_strand_a_series_either() {
        // The issuer's permanent delegate can drain before maturity as easily
        // as after. A collateral gate would have handed them a way to freeze a
        // series permanently rather than merely to take from it.
        let health = assess_settlement_health(ONE_TOKEN / 2, ONE_TOKEN, ONE_TOKEN);
        assert!(health.under_collateralized, "recorded");

        // Settlement still partitions what is actually there.
        let pools =
            compute_settlement(&params(ONE_TOKEN / 2, 1_000 * USD, MULTIPLIER_SCALE)).unwrap();
        assert_eq!(pools.p_pool + pools.n_pool, ONE_TOKEN / 2);
    }

    // --- §12 case 11: settlement must land on a real market print --------

    #[test]
    fn settlement_window_rejects_prints_outside_the_session() {
        let lag = 900; // fifteen minutes past the close
        assert!(require_settlement_window(MATURITY, MATURITY, lag).is_ok());
        assert!(require_settlement_window(MATURITY + lag, MATURITY, lag).is_ok());
        // Before the close: not this series' settlement print.
        assert!(require_settlement_window(MATURITY - 1, MATURITY, lag).is_err());
        // A print from the middle of the following weekend, which is what the
        // window exists to keep out.
        assert!(require_settlement_window(MATURITY + 200_000, MATURITY, lag).is_err());
    }

    // --- §12 case 3: pools partition the collateral ----------------------

    #[test]
    fn pools_sum_to_collateral_at_every_price() {
        // Invariant 3.
        for price in [1, 250 * USD, STRIKE_500, STRIKE_500 + 1, 10_000 * USD] {
            let pools = compute_settlement(&params(ONE_TOKEN, price, MULTIPLIER_SCALE)).unwrap();
            assert_eq!(
                pools.p_pool + pools.n_pool,
                ONE_TOKEN,
                "pools must partition collateral at price {price}"
            );
        }
    }

    #[test]
    fn below_strike_everything_goes_to_p() {
        let pools = compute_settlement(&params(ONE_TOKEN, 250 * USD, MULTIPLIER_SCALE)).unwrap();
        assert_eq!(pools.p_pool, ONE_TOKEN);
        assert_eq!(pools.n_pool, 0);
        // Exactly at the strike, too.
        let at = compute_settlement(&params(ONE_TOKEN, STRIKE_500, MULTIPLIER_SCALE)).unwrap();
        assert_eq!(at.p_pool, ONE_TOKEN);
        assert_eq!(at.n_pool, 0);
    }

    #[test]
    fn above_strike_splits_against_the_cap() {
        let pools = compute_settlement(&params(ONE_TOKEN, 1_000 * USD, MULTIPLIER_SCALE)).unwrap();
        assert_eq!(pools.p_pool, ONE_TOKEN / 2);
        assert_eq!(pools.n_pool, ONE_TOKEN / 2);
    }

    // --- §12 case 13: decimals -------------------------------------------

    #[test]
    fn decimal_round_trips_favour_p() {
        // Case 13. The same $600 price delivered at three source scales must
        // land on the same pools, and where flooring the price loses
        // precision it must round the P pool *up*, never down.
        let at_8 = compute_settlement(&SettleParams {
            quote_price: 600 * USD,
            quote_decimals: 8,
            ..params(ONE_TOKEN, 0, MULTIPLIER_SCALE)
        })
        .unwrap();
        let at_5 = compute_settlement(&SettleParams {
            quote_price: 600_00000,
            quote_decimals: 5,
            ..params(ONE_TOKEN, 0, MULTIPLIER_SCALE)
        })
        .unwrap();
        assert_eq!(
            at_8.price, at_5.price,
            "widening a coarser feed is lossless"
        );
        assert_eq!(at_8.p_pool, at_5.p_pool);

        // Now a price with more precision than the series carries: $600.999...
        // at 10 decimals into an 8-decimal series. Flooring the price makes
        // the denominator smaller, so the P pool comes out no smaller than it
        // would at full precision. P is the senior claim; this is the
        // direction the rounding is meant to go.
        let precise = compute_settlement(&SettleParams {
            quote_price: 600_9999999999,
            quote_decimals: 10,
            ..params(ONE_TOKEN, 0, MULTIPLIER_SCALE)
        })
        .unwrap();
        assert_eq!(precise.price, 600_99999999, "price floors on the way down");
        let unfloored = ONE_TOKEN as i128 * STRIKE_500 / 600_9999999999i128 * 100;
        assert!(
            precise.p_pool as i128 >= unfloored / 100,
            "flooring the price must not shrink the P pool"
        );
    }

    // --- §12 case 8: corporate actions -----------------------------------

    #[test]
    fn a_two_for_one_split_leaves_the_pools_unchanged() {
        // Case 8, forward direction. $600 pre-split becomes $300 post-split
        // with a multiplier of 2.
        let before = compute_settlement(&params(ONE_TOKEN, 600 * USD, MULTIPLIER_SCALE)).unwrap();
        let after = compute_settlement(&params(
            ONE_TOKEN,
            300 * USD,
            multiplier_to_fixed(2.0).unwrap(),
        ))
        .unwrap();
        assert_eq!(after.effective_strike, 250 * USD);
        assert_eq!(after.p_pool, before.p_pool);
        assert_eq!(after.n_pool, before.n_pool);
        assert!(after.n_pool > 0, "N must survive a pure split");
    }

    #[test]
    fn a_one_for_two_reverse_split_leaves_the_pools_unchanged() {
        // Case 8, reverse direction. $600 becomes $1200 with a multiplier of
        // 0.5.
        let before = compute_settlement(&params(ONE_TOKEN, 600 * USD, MULTIPLIER_SCALE)).unwrap();
        let after = compute_settlement(&params(
            ONE_TOKEN,
            1_200 * USD,
            multiplier_to_fixed(0.5).unwrap(),
        ))
        .unwrap();
        assert_eq!(after.effective_strike, 1_000 * USD);
        assert_eq!(after.p_pool, before.p_pool);
        assert_eq!(after.n_pool, before.n_pool);
    }

    #[test]
    fn without_the_adjustment_a_split_would_wipe_out_n() {
        // The bug the adjustment exists to prevent, stated as a test: settle
        // the post-split $300 price against an unadjusted multiplier of 1.
        let unadjusted =
            compute_settlement(&params(ONE_TOKEN, 300 * USD, MULTIPLIER_SCALE)).unwrap();
        assert_eq!(unadjusted.n_pool, 0);
        // With the adjustment, N keeps its value.
        let adjusted = compute_settlement(&params(
            ONE_TOKEN,
            300 * USD,
            multiplier_to_fixed(2.0).unwrap(),
        ))
        .unwrap();
        assert!(adjusted.n_pool > 0);
    }

    // --- §12 case 9: scheduled multipliers -------------------------------

    #[test]
    fn a_multiplier_effective_before_the_price_timestamp_is_applied() {
        // Case 9. A 2:1 split scheduled to land one minute before the print.
        let effective_ts = MATURITY - 60;
        let resolved = resolve_multiplier(1.0, 2.0, effective_ts, MATURITY);
        assert_eq!(resolved, 2.0);
        let pools = compute_settlement(&params(
            ONE_TOKEN,
            300 * USD,
            multiplier_to_fixed(resolved).unwrap(),
        ))
        .unwrap();
        assert_eq!(pools.effective_strike, 250 * USD);
        assert!(pools.n_pool > 0);
    }

    #[test]
    fn a_multiplier_effective_after_the_price_timestamp_is_not_applied() {
        // Case 9, the other half. The same split scheduled for one minute
        // *after* the print must not touch this settlement — the price being
        // settled predates the action.
        let effective_ts = MATURITY + 60;
        let resolved = resolve_multiplier(1.0, 2.0, effective_ts, MATURITY);
        assert_eq!(resolved, 1.0);
        let pools = compute_settlement(&params(
            ONE_TOKEN,
            600 * USD,
            multiplier_to_fixed(resolved).unwrap(),
        ))
        .unwrap();
        assert_eq!(pools.effective_strike, STRIKE_500, "strike must not move");
    }

    // --- §12 cases 4, 5, 10: redemption ----------------------------------

    #[test]
    fn redemption_is_pro_rata_against_the_frozen_pool() {
        // A whole vault, P holds 5/6 of it after a settlement at $600.
        let pools = compute_settlement(&params(ONE_TOKEN, 600 * USD, MULTIPLIER_SCALE)).unwrap();
        let supply = ONE_TOKEN;
        let outstanding = pools.p_pool + pools.n_pool;
        // Redeeming half the P supply pays half the P pool.
        let half = redeem_payout(supply / 2, pools.p_pool, supply, outstanding, ONE_TOKEN).unwrap();
        assert_eq!(half.quoted, pools.p_pool / 2);
        assert_eq!(half.paid, half.quoted);
        assert!(!half.shortfall);
    }

    #[test]
    fn full_redemption_supports_the_entire_u64_account_domain() {
        let payout = redeem_payout(u64::MAX, u64::MAX, u64::MAX, u64::MAX, u64::MAX).unwrap();
        assert_eq!(payout.quoted, u64::MAX);
        assert_eq!(payout.paid, u64::MAX);
        assert!(!payout.shortfall);
    }

    #[test]
    fn redemption_never_overdraws_its_pool_in_any_order() {
        // Invariants 4 and 5. Partition each side's supply into uneven pieces
        // and redeem them in several orders; the running total must never
        // exceed the pool, and the pool must never be over-retired.
        let pools = compute_settlement(&params(ONE_TOKEN, 731 * USD, MULTIPLIER_SCALE)).unwrap();
        let supply = ONE_TOKEN;
        let cuts = [supply / 7, supply / 3, supply / 11, supply / 9];
        let claimed: u64 = cuts.iter().sum();
        assert!(
            claimed < supply,
            "cuts must be a partition, not an overdraw"
        );
        let remainder = supply - claimed;

        for rotation in 0..4usize {
            let mut order: Vec<u64> = cuts.to_vec();
            order.rotate_left(rotation);
            order.push(remainder);

            let mut p_redeemed = 0u64;
            let mut vault = ONE_TOKEN;
            let mut total_paid = 0u64;
            for amount in order {
                let outstanding = (pools.p_pool - p_redeemed) + pools.n_pool;
                let payout =
                    redeem_payout(amount, pools.p_pool, supply, outstanding, vault).unwrap();
                p_redeemed += payout.quoted;
                vault -= payout.paid;
                total_paid += payout.paid;
            }
            assert!(
                p_redeemed <= pools.p_pool,
                "over-retired the P pool: {} > {}",
                p_redeemed,
                pools.p_pool
            );
            assert!(total_paid <= pools.p_pool);
        }
    }

    #[test]
    fn a_drained_vault_haircuts_every_redeemer_equally() {
        // Case 10. Settle, then let the issuer's permanent delegate take half
        // the vault, and check that redemption order stops mattering.
        let pools = compute_settlement(&params(ONE_TOKEN, 1_000 * USD, MULTIPLIER_SCALE)).unwrap();
        let supply = ONE_TOKEN;
        let drained = ONE_TOKEN / 2;

        // Three P holders with unequal stakes.
        let stakes = [supply / 2, supply / 3, supply - supply / 2 - supply / 3];

        let run = |order: &[u64]| -> Vec<u64> {
            let mut p_redeemed = 0u64;
            let mut vault = drained;
            let mut paid = Vec::new();
            for &amount in order {
                let outstanding = (pools.p_pool - p_redeemed) + pools.n_pool;
                let payout =
                    redeem_payout(amount, pools.p_pool, supply, outstanding, vault).unwrap();
                assert!(payout.shortfall, "the drain must be visible on-chain");
                p_redeemed += payout.quoted;
                vault -= payout.paid;
                paid.push(payout.paid);
            }
            paid
        };

        let forward = run(&stakes);
        let mut reversed = stakes;
        reversed.reverse();
        let mut backward = run(&reversed);
        backward.reverse();

        for (i, (f, b)) in forward.iter().zip(backward.iter()).enumerate() {
            let diff = (*f as i128 - *b as i128).abs();
            assert!(
                diff <= stakes.len() as i128,
                "holder {i} was paid {f} first and {b} last — order changed the outcome"
            );
        }
        // And the vault is never overdrawn.
        assert!(forward.iter().sum::<u64>() <= drained);
    }

    #[test]
    fn a_fully_drained_vault_pays_nothing_rather_than_reverting() {
        // Redeeming into an empty vault must fail soft: the holder's claim is
        // retired against a zero payout, and the shortfall is flagged. A hard
        // revert would leave the series permanently unredeemable.
        let pools = compute_settlement(&params(ONE_TOKEN, 1_000 * USD, MULTIPLIER_SCALE)).unwrap();
        let outstanding = pools.p_pool + pools.n_pool;
        let payout = redeem_payout(ONE_TOKEN, pools.p_pool, ONE_TOKEN, outstanding, 0).unwrap();
        assert_eq!(payout.paid, 0);
        assert!(payout.quoted > 0);
        assert!(payout.shortfall);
    }

    #[test]
    fn redeeming_zero_is_rejected() {
        assert!(redeem_payout(0, 100, 100, 100, 100).is_err());
    }

    #[test]
    fn an_empty_series_settles_to_zero_pools() {
        let pools = compute_settlement(&params(0, 600 * USD, MULTIPLIER_SCALE)).unwrap();
        assert_eq!(pools.p_pool, 0);
        assert_eq!(pools.n_pool, 0);
        // And redeeming against a zero supply pays nothing rather than
        // dividing by zero.
        assert_eq!(redeem_payout(1, 0, 0, 0, 0).unwrap().paid, 0);
    }

    // --- Fees and validation ---------------------------------------------

    #[test]
    fn fees_floor_and_default_to_zero() {
        assert_eq!(fee_amount(ONE_TOKEN, 0).unwrap(), 0);
        assert_eq!(fee_amount(ONE_TOKEN, 100).unwrap(), ONE_TOKEN / 100);
        // 1 bps of 9 units floors to nothing rather than rounding against the
        // depositor.
        assert_eq!(fee_amount(9, 1).unwrap(), 0);
    }

    #[test]
    fn creation_rejects_incoherent_parameters() {
        let ok = || {
            validate_series_params(
                STRIKE_500,
                8,
                MATURITY,
                MATURITY - 1,
                60,
                60,
                900,
                1,
                0,
                MULTIPLIER_SCALE,
            )
        };
        assert!(ok().is_ok());

        assert!(
            validate_series_params(
                STRIKE_500,
                8,
                MATURITY,
                MATURITY - 1,
                961,
                60,
                900,
                1,
                0,
                MULTIPLIER_SCALE,
            )
            .is_err(),
            "settlement cannot start after every admissible quote is stale"
        );
        assert!(
            validate_series_params(
                STRIKE_500,
                8,
                MATURITY,
                MATURITY - 1,
                960,
                60,
                900,
                1,
                0,
                MULTIPLIER_SCALE,
            )
            .is_ok(),
            "the exact timing boundary remains feasible"
        );
        assert!(
            validate_settlement_timing(1_201, 5_000, 900, 300).is_err(),
            "the feed config's tighter age bound is also load-bearing"
        );

        let bad = |strike, decimals, maturity, now, lag, min, fee, mult| {
            validate_series_params(strike, decimals, maturity, now, 60, 60, lag, min, fee, mult)
                .is_err()
        };
        // Zero or negative strike.
        assert!(bad(
            0,
            8,
            MATURITY,
            MATURITY - 1,
            900,
            1,
            0,
            MULTIPLIER_SCALE
        ));
        // Zero price decimals: the strike would have no scale.
        assert!(bad(
            STRIKE_500,
            0,
            MATURITY,
            MATURITY - 1,
            900,
            1,
            0,
            MULTIPLIER_SCALE
        ));
        // Maturity in the past.
        assert!(bad(
            STRIKE_500,
            8,
            MATURITY,
            MATURITY,
            900,
            1,
            0,
            MULTIPLIER_SCALE
        ));
        // No settlement window at all.
        assert!(bad(
            STRIKE_500,
            8,
            MATURITY,
            MATURITY - 1,
            0,
            1,
            0,
            MULTIPLIER_SCALE
        ));
        // Zero minimum split, which would let dust mint claim tokens.
        assert!(bad(
            STRIKE_500,
            8,
            MATURITY,
            MATURITY - 1,
            900,
            0,
            0,
            MULTIPLIER_SCALE
        ));
        // A fee above 100%.
        assert!(bad(
            STRIKE_500,
            8,
            MATURITY,
            MATURITY - 1,
            900,
            1,
            10_001,
            MULTIPLIER_SCALE
        ));
        // An unreadable multiplier.
        assert!(bad(STRIKE_500, 8, MATURITY, MATURITY - 1, 900, 1, 0, 0));
    }
}
