// SPDX-License-Identifier: Apache-2.0
//! Solvency-critical integer math.
//!
//! [`checked_mul_div_floor`], [`normalize_decimals`], [`pow10`],
//! [`compute_pools`] and [`compute_redeem`] describe the payoff itself. They
//! are deliberately plain integer arithmetic with no framework dependency, so
//! they run on the host in microseconds — which is what makes the solvency
//! properties cheap enough to assert on every commit.
//!
//! Two rounding conventions run through this module, and both are deliberate:
//!
//! 1. **Payouts floor.** Every value paid out of the vault rounds down, so
//!    `total_paid <= collateral_locked` regardless of redemption order.
//! 2. **Rounding favours P.** P is the senior claim; where a rounding choice
//!    moves value between the two sides it moves it to P. Flooring the
//!    normalized price rounds `p_pool` up; ceiling the effective strike does
//!    the same. Both directions are asserted in tests rather than left to
//!    emerge from the arithmetic.

use crate::error::OptionsError;

/// Result alias for the pure math layer. `OptionsError` converts into an
/// Anchor error automatically, so `?` works directly inside instruction
/// handlers without a manual `map_err`.
pub type MathResult<T> = core::result::Result<T, OptionsError>;

/// Maximum number of decimals we will ever scale by. `10^38` overflows `i128`
/// (max ~1.7e38) only just, so we keep a conservative ceiling well below that
/// to leave headroom for the value being scaled.
pub const MAX_DECIMALS: u32 = 18;

/// Fixed-point scale used to carry a Token-2022 `scaledUiAmount` multiplier
/// through integer arithmetic.
///
/// The extension stores the multiplier as an `f64`. Floating point has no
/// place in a settlement calculation, so it is converted once, at the edge, to
/// a `1e12`-scaled integer and never touched as a float again. The scale
/// cancels in [`effective_strike`], so its exact value only bounds precision:
/// 1e12 resolves a corporate action ratio to twelve significant decimals,
/// far finer than any real split or dividend.
pub const MULTIPLIER_SCALE: i128 = 1_000_000_000_000;

/// Largest multiplier accepted from the mint. A rebase beyond a trillion-fold
/// is not a corporate action, it is a misconfigured or hostile mint, and
/// rejecting it keeps `strike * multiplier` far inside `i128`.
pub const MAX_MULTIPLIER: f64 = 1e12;

/// Compute the quotient and remainder of `a * b / denominator` without
/// requiring the intermediate product to fit in `i128`.
///
/// The fast path handles ordinary protocol values with one multiplication.
/// The fallback carries `(quotient, remainder)` while consuming the bits of
/// `a`. Both components remain bounded by the final quotient and the
/// denominator respectively, so overflow means the result itself is too large
/// rather than merely that an avoidable intermediate was too large.
fn checked_mul_div_rem(a: i128, b: i128, denominator: i128) -> MathResult<(i128, i128)> {
    if a < 0 || b < 0 {
        return Err(OptionsError::InvalidAmount);
    }
    if denominator <= 0 {
        return Err(OptionsError::DivisionByZero);
    }

    if let Some(product) = a.checked_mul(b) {
        return Ok((product / denominator, product % denominator));
    }

    let add_quotient = b / denominator;
    let add_remainder = b % denominator;
    let mut quotient = 0i128;
    let mut remainder = 0i128;

    for bit in (0..127).rev() {
        quotient = quotient.checked_mul(2).ok_or(OptionsError::MathOverflow)?;

        // Double the remainder without evaluating `remainder * 2` when that
        // intermediate would overflow. `remainder < denominator`, so
        // `denominator - remainder` is always positive.
        let distance_to_denominator = denominator - remainder;
        if remainder >= distance_to_denominator {
            remainder -= distance_to_denominator;
            quotient = quotient.checked_add(1).ok_or(OptionsError::MathOverflow)?;
        } else {
            remainder += remainder;
        }

        if ((a as u128) >> bit) & 1 == 0 {
            continue;
        }

        quotient = quotient
            .checked_add(add_quotient)
            .ok_or(OptionsError::MathOverflow)?;
        if add_remainder > 0 {
            let distance_to_denominator = denominator - add_remainder;
            if remainder >= distance_to_denominator {
                remainder -= distance_to_denominator;
                quotient = quotient.checked_add(1).ok_or(OptionsError::MathOverflow)?;
            } else {
                remainder += add_remainder;
            }
        }
    }

    Ok((quotient, remainder))
}

/// Compute `floor(a * b / denominator)` using checked integer arithmetic.
///
/// Returns an error instead of panicking on overflow, division by zero, or
/// negative inputs. All financial multiplications/divisions in the protocol go
/// through this helper so that payouts always round *down*, protecting
/// solvency (`total_paid <= collateral_locked`).
pub fn checked_mul_div_floor(a: i128, b: i128, denominator: i128) -> MathResult<i128> {
    let (quotient, _) = checked_mul_div_rem(a, b, denominator)?;
    Ok(quotient)
}

/// Compute `ceil(a * b / denominator)` using checked integer arithmetic.
///
/// Used only where rounding up is the conservative direction — currently the
/// effective strike, where rounding up favours the senior P claim. Never used
/// for a payout.
pub fn checked_mul_div_ceil(a: i128, b: i128, denominator: i128) -> MathResult<i128> {
    let (quotient, remainder) = checked_mul_div_rem(a, b, denominator)?;
    if remainder == 0 {
        Ok(quotient)
    } else {
        quotient.checked_add(1).ok_or(OptionsError::MathOverflow)
    }
}

/// Re-scale a non-negative fixed-point `value` from `from_decimals` to
/// `to_decimals`.
///
/// Scaling up multiplies by a power of ten (checked for overflow). Scaling down
/// divides and floors, which is the safe rounding direction for prices used in
/// settlement. Rejects decimal counts above [`MAX_DECIMALS`] to bound the
/// scaling factor.
pub fn normalize_decimals(value: i128, from_decimals: u32, to_decimals: u32) -> MathResult<i128> {
    if value < 0 {
        return Err(OptionsError::InvalidAmount);
    }
    if from_decimals > MAX_DECIMALS || to_decimals > MAX_DECIMALS {
        return Err(OptionsError::InvalidDecimals);
    }
    if from_decimals == to_decimals {
        return Ok(value);
    }
    if to_decimals > from_decimals {
        let factor = pow10(to_decimals - from_decimals)?;
        value.checked_mul(factor).ok_or(OptionsError::MathOverflow)
    } else {
        let factor = pow10(from_decimals - to_decimals)?;
        // factor is > 0 by construction.
        Ok(value / factor)
    }
}

/// `10^exp` as an `i128`, returning [`OptionsError::MathOverflow`] if it does
/// not fit.
pub fn pow10(exp: u32) -> MathResult<i128> {
    if exp > MAX_DECIMALS {
        return Err(OptionsError::InvalidDecimals);
    }
    let mut acc: i128 = 1;
    for _ in 0..exp {
        acc = acc.checked_mul(10).ok_or(OptionsError::MathOverflow)?;
    }
    Ok(acc)
}

/// Split `collateral` into the P pool and N pool given a settlement `price` and
/// the configured `strike` (both expressed with the same decimals).
///
/// ```text
/// price <= strike: p_pool = collateral,                     n_pool = 0
/// price >  strike: p_pool = floor(collateral*strike/price), n_pool = collateral - p_pool
/// ```
///
/// Callers must pass the *effective* strike ([`effective_strike`]), not the
/// strike stored at creation, or a corporate action will move value between
/// the two sides.
pub fn compute_pools(collateral: i128, strike: i128, price: i128) -> MathResult<(i128, i128)> {
    if collateral < 0 {
        return Err(OptionsError::InvalidAmount);
    }
    if strike <= 0 {
        return Err(OptionsError::InvalidStrike);
    }
    if price <= 0 {
        return Err(OptionsError::OraclePriceInvalid);
    }
    if price <= strike {
        return Ok((collateral, 0));
    }
    let p_pool = checked_mul_div_floor(collateral, strike, price)?;
    // p_pool <= collateral because strike < price, so the subtraction cannot
    // underflow.
    let n_pool = collateral
        .checked_sub(p_pool)
        .ok_or(OptionsError::MathUnderflow)?;
    Ok((p_pool, n_pool))
}

/// Pro-rata redemption payout: `floor(amount * pool / supply)`.
pub fn compute_redeem(amount: i128, pool: i128, supply: i128) -> MathResult<i128> {
    if supply == 0 {
        // Nothing was ever minted; there is nothing to redeem.
        return Ok(0);
    }
    checked_mul_div_floor(amount, pool, supply)
}

// --- Corporate actions (§6) ----------------------------------------------

/// Convert a Token-2022 `scaledUiAmount` multiplier from the `f64` the
/// extension stores into the `MULTIPLIER_SCALE`-fixed integer the rest of the
/// protocol uses.
///
/// This is the only place a float is read. It rounds to nearest, which is
/// exact for every ratio a real corporate action produces (2.0, 0.5, 1.5, 3.0
/// are all exactly representable in binary floating point and in 1e12 fixed
/// point). Rejects anything non-finite, non-positive, or absurdly large rather
/// than settling against it.
pub fn multiplier_to_fixed(multiplier: f64) -> MathResult<i128> {
    if !multiplier.is_finite() || multiplier <= 0.0 || multiplier > MAX_MULTIPLIER {
        return Err(OptionsError::MultiplierInvalid);
    }
    let scaled = (multiplier * MULTIPLIER_SCALE as f64).round();
    if !scaled.is_finite() || scaled < 1.0 {
        // A multiplier so small it rounds to zero would make the strike
        // adjustment a division by zero. Refuse rather than settle.
        return Err(OptionsError::MultiplierInvalid);
    }
    Ok(scaled as i128)
}

/// Which multiplier is in force at `as_of_ts`.
///
/// Token-2022 carries both the current multiplier and an optional scheduled
/// replacement with its effective timestamp. Settlement must resolve this
/// **as of the settlement price timestamp**, not as of whichever field happens
/// to be populated when the instruction runs — otherwise a corporate action
/// that lands between the price print and the `settle` transaction is applied
/// to a price that predates it.
pub fn resolve_multiplier(
    multiplier: f64,
    new_multiplier: f64,
    new_multiplier_effective_ts: i64,
    as_of_ts: i64,
) -> f64 {
    if as_of_ts >= new_multiplier_effective_ts {
        new_multiplier
    } else {
        multiplier
    }
}

/// Adjust the stored strike for any corporate action that landed during the
/// series term.
///
/// ```text
/// effective_strike = ceil(strike * multiplier_at_creation / multiplier_at_settlement)
/// ```
///
/// A rebase changes what one raw token unit means without moving any value.
/// Left unadjusted, a 2-for-1 split halves the oracle price against a fixed
/// strike and wipes out the N side in an event where nobody lost money. The
/// ratio restores the original economics exactly for a pure split.
///
/// Rounds **up**, so any sub-tick remainder accrues to the senior P claim.
/// This can raise the effective strike to at most one price tick above the
/// exact ratio, which at worst moves one tick of value from N to P; it can
/// never make the pools fail to sum to collateral, because `compute_pools`
/// derives `n_pool` by subtraction.
pub fn effective_strike(
    strike: i128,
    multiplier_at_creation: i128,
    multiplier_at_settlement: i128,
) -> MathResult<i128> {
    if strike <= 0 {
        return Err(OptionsError::InvalidStrike);
    }
    if multiplier_at_creation <= 0 || multiplier_at_settlement <= 0 {
        return Err(OptionsError::MultiplierInvalid);
    }
    if multiplier_at_creation == multiplier_at_settlement {
        return Ok(strike);
    }
    let adjusted = checked_mul_div_ceil(strike, multiplier_at_creation, multiplier_at_settlement)?;
    if adjusted <= 0 {
        // A large enough reverse split could round the strike to zero, which
        // `compute_pools` would reject anyway. Fail with the specific cause.
        return Err(OptionsError::InvalidStrike);
    }
    Ok(adjusted)
}

// --- Shortfall (§7) -------------------------------------------------------

/// Scale a quoted payout down when the vault holds less than it owes.
///
/// The issuer's permanent delegate can move collateral out of a settled vault.
/// Paying quoted amounts until the vault empties would hand everything to
/// whoever redeems first; instead every redeemer takes the same proportional
/// haircut whenever they show up:
///
/// ```text
/// available = vault_balance
/// expected  = (p_pool - p_redeemed) + (n_pool - n_redeemed)
/// payout    = floor(quoted * available / expected)   when available < expected
/// ```
///
/// `expected` is the *outstanding* obligation rather than the original pools,
/// so the ratio stays correct as redemptions proceed: a redeemer arriving
/// after a drain sees the same ratio as one arriving immediately after it.
pub fn apply_shortfall(quoted: i128, available: i128, expected: i128) -> MathResult<i128> {
    if quoted < 0 || available < 0 || expected < 0 {
        return Err(OptionsError::InvalidAmount);
    }
    if expected == 0 {
        // Nothing is owed, so nothing is payable.
        return Ok(0);
    }
    if available >= expected {
        return Ok(quoted);
    }
    checked_mul_div_floor(quoted, available, expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures are TSLAx-shaped: USD prices with 8 decimals, matching both the
    // mint's 8 decimals and Pyth's typical -8 exponent.
    const USD: i128 = 100_000_000; // 1.00 with 8 decimals
    const STRIKE_500: i128 = 500 * USD;
    /// One whole TSLAx in raw units (the mint has 8 decimals).
    const ONE_TOKEN: i128 = 100_000_000;

    /// Dollar value, in 8-decimal USD, of `raw` collateral units quoted at
    /// `price` while the mint carries `multiplier`.
    ///
    /// Raw units are what the vault holds and what `compute_pools` partitions;
    /// the `scaledUiAmount` multiplier is what turns them into shares. Keeping
    /// the conversion in one place is what makes the cap assertions below
    /// actually about dollars rather than about raw units.
    fn usd_value(raw: i128, price: i128, multiplier: i128) -> i128 {
        raw * multiplier / MULTIPLIER_SCALE * price / ONE_TOKEN
    }

    /// The dollar value of a single raw collateral unit at `price` — the most
    /// a flooring step can cost a holder, and therefore the tolerance every
    /// cap assertion is allowed.
    fn one_unit_of_value(price: i128) -> i128 {
        price / ONE_TOKEN + 1
    }

    #[test]
    fn mul_div_floors() {
        assert_eq!(checked_mul_div_floor(10, 3, 4).unwrap(), 7); // 30/4 = 7.5 -> 7
        assert_eq!(checked_mul_div_floor(100, 5, 10).unwrap(), 50);
        assert_eq!(checked_mul_div_floor(0, 5, 10).unwrap(), 0);
    }

    #[test]
    fn mul_div_ceils() {
        assert_eq!(checked_mul_div_ceil(10, 3, 4).unwrap(), 8); // 30/4 = 7.5 -> 8
        assert_eq!(checked_mul_div_ceil(100, 5, 10).unwrap(), 50); // exact stays exact
        assert_eq!(checked_mul_div_ceil(0, 5, 10).unwrap(), 0);
    }

    #[test]
    fn mul_div_does_not_reject_a_large_but_representable_result() {
        // The product cannot fit in i128, but the quotient can. This is the
        // shape of a full-supply redemption at the u64 account limit.
        let max_account_value = u64::MAX as i128;
        assert_eq!(
            checked_mul_div_floor(max_account_value, max_account_value, max_account_value).unwrap(),
            max_account_value
        );

        assert_eq!(
            checked_mul_div_floor(i128::MAX, i128::MAX - 1, i128::MAX).unwrap(),
            i128::MAX - 1
        );
        assert_eq!(
            checked_mul_div_ceil(i128::MAX, i128::MAX - 1, i128::MAX).unwrap(),
            i128::MAX - 1
        );

        let expected_floor = (i128::MAX / 3) * 2;
        assert_eq!(
            checked_mul_div_floor(i128::MAX, 2, 3).unwrap(),
            expected_floor
        );
        assert_eq!(
            checked_mul_div_ceil(i128::MAX, 2, 3).unwrap(),
            expected_floor + 1
        );
    }

    #[test]
    fn mul_div_still_rejects_a_result_that_does_not_fit() {
        assert_eq!(
            checked_mul_div_floor(i128::MAX, 2, 1),
            Err(OptionsError::MathOverflow)
        );
        assert_eq!(
            checked_mul_div_ceil(i128::MAX, 2, 1),
            Err(OptionsError::MathOverflow)
        );
    }

    #[test]
    fn mul_div_rejects_bad_input() {
        assert_eq!(
            checked_mul_div_floor(-1, 2, 3),
            Err(OptionsError::InvalidAmount)
        );
        assert_eq!(
            checked_mul_div_floor(1, 2, 0),
            Err(OptionsError::DivisionByZero)
        );
        assert_eq!(
            checked_mul_div_floor(i128::MAX, 2, 1),
            Err(OptionsError::MathOverflow)
        );
    }

    #[test]
    fn normalize_up_and_down() {
        // $1.00 at 2 decimals -> 8 decimals.
        assert_eq!(normalize_decimals(100, 2, 8).unwrap(), USD);
        // A Pyth quote at exponent -5 widened to the series' 8 decimals.
        assert_eq!(normalize_decimals(400_00000, 5, 8).unwrap(), 400 * USD);
        // Narrowing floors: $400.12345678 at 8 decimals -> 2 decimals.
        assert_eq!(normalize_decimals(400_12345678, 8, 2).unwrap(), 40_012);
        assert_eq!(normalize_decimals(42, 5, 5).unwrap(), 42);
    }

    #[test]
    fn pools_below_at_above_strike() {
        // 1 TSLAx, 8 decimals.
        let collateral = USD;
        // Below strike -> all P.
        assert_eq!(
            compute_pools(collateral, STRIKE_500, 250 * USD).unwrap(),
            (collateral, 0)
        );
        // At strike -> all P.
        assert_eq!(
            compute_pools(collateral, STRIKE_500, STRIKE_500).unwrap(),
            (collateral, 0)
        );
        // At twice the strike -> half/half.
        assert_eq!(
            compute_pools(collateral, STRIKE_500, 1_000 * USD).unwrap(),
            (collateral / 2, collateral / 2)
        );
    }

    #[test]
    fn pools_match_the_worked_example() {
        // The §1 table: 1 TSLAx locked, $500 strike, stock at $600.
        // P should receive $500 worth = 500/600 of the token.
        let collateral = ONE_TOKEN;
        let price = 600 * USD;
        let (p, n) = compute_pools(collateral, STRIKE_500, price).unwrap();
        assert_eq!(p, collateral * 500 / 600);
        assert_eq!(p + n, collateral);

        // P's dollar value is the $500 cap, short by at most the flooring of a
        // single raw unit. Never above it: the cap is what P is owed at most.
        let p_value = usd_value(p, price, MULTIPLIER_SCALE);
        let shortfall = 500 * USD - p_value;
        assert!(shortfall >= 0, "P must never be paid above the cap");
        assert!(
            shortfall <= one_unit_of_value(price),
            "cap missed by {shortfall}"
        );

        // And N holds the rest: $100 of a $600 stock capped at $500.
        let n_value = usd_value(n, price, MULTIPLIER_SCALE);
        assert!((100 * USD - n_value).abs() <= one_unit_of_value(price));
    }

    #[test]
    fn pools_always_sum_to_collateral() {
        let collateral = 1_000_000_000i128;
        for price in [
            1i128,
            250 * USD,
            STRIKE_500,
            STRIKE_500 + 1,
            999 * USD,
            1_000 * USD,
            9_999 * USD,
        ] {
            let (p, n) = compute_pools(collateral, STRIKE_500, price).unwrap();
            assert_eq!(p + n, collateral, "price {price}");
            assert!(p >= 0 && n >= 0);
            assert!(p <= collateral && n <= collateral);
        }
    }

    // --- Corporate actions ------------------------------------------------

    #[test]
    fn multiplier_conversion_is_exact_for_real_ratios() {
        assert_eq!(multiplier_to_fixed(1.0).unwrap(), MULTIPLIER_SCALE);
        assert_eq!(multiplier_to_fixed(2.0).unwrap(), 2 * MULTIPLIER_SCALE);
        assert_eq!(multiplier_to_fixed(0.5).unwrap(), MULTIPLIER_SCALE / 2);
        assert_eq!(multiplier_to_fixed(1.5).unwrap(), 3 * MULTIPLIER_SCALE / 2);
    }

    #[test]
    fn multiplier_conversion_rejects_junk() {
        assert_eq!(
            multiplier_to_fixed(0.0),
            Err(OptionsError::MultiplierInvalid)
        );
        assert_eq!(
            multiplier_to_fixed(-1.0),
            Err(OptionsError::MultiplierInvalid)
        );
        assert_eq!(
            multiplier_to_fixed(f64::NAN),
            Err(OptionsError::MultiplierInvalid)
        );
        assert_eq!(
            multiplier_to_fixed(f64::INFINITY),
            Err(OptionsError::MultiplierInvalid)
        );
        assert_eq!(
            multiplier_to_fixed(1e13),
            Err(OptionsError::MultiplierInvalid)
        );
        // Small enough to round to zero at 1e12 scale.
        assert_eq!(
            multiplier_to_fixed(1e-13),
            Err(OptionsError::MultiplierInvalid)
        );
    }

    #[test]
    fn two_for_one_split_leaves_p_economically_unchanged() {
        // The §6 worked example. Before: price $600, strike $500, multiplier 1.
        let collateral = ONE_TOKEN;
        let (p_before, n_before) = compute_pools(collateral, STRIKE_500, 600 * USD).unwrap();
        assert!(n_before > 0, "N must be worth something before the split");

        // Split lands: multiplier 1 -> 2, Pyth now reports the post-split $300.
        let m_creation = multiplier_to_fixed(1.0).unwrap();
        let m_settlement = multiplier_to_fixed(2.0).unwrap();
        let strike = effective_strike(STRIKE_500, m_creation, m_settlement).unwrap();
        assert_eq!(strike, 250 * USD);

        let price = 300 * USD;
        let (p_after, n_after) = compute_pools(collateral, strike, price).unwrap();
        assert_eq!(
            p_after, p_before,
            "P pool must be unchanged by a pure split"
        );
        assert_eq!(n_after, n_before, "N must not be wiped by a pure split");

        // And the cap still holds in dollars: p_after raw units, read at the
        // post-split multiplier of 2, are worth $500 at $300 a share.
        let p_value = usd_value(p_after, price, m_settlement);
        let shortfall = 500 * USD - p_value;
        assert!(shortfall >= 0, "P must never be paid above the cap");
        assert!(
            shortfall <= one_unit_of_value(price),
            "cap missed by {shortfall}"
        );
    }

    #[test]
    fn one_for_two_reverse_split_leaves_p_economically_unchanged() {
        // Reverse split: multiplier 1 -> 0.5, price doubles $600 -> $1200.
        let collateral = ONE_TOKEN;
        let (p_before, n_before) = compute_pools(collateral, STRIKE_500, 600 * USD).unwrap();

        let m_creation = multiplier_to_fixed(1.0).unwrap();
        let m_settlement = multiplier_to_fixed(0.5).unwrap();
        let strike = effective_strike(STRIKE_500, m_creation, m_settlement).unwrap();
        assert_eq!(strike, 1_000 * USD);

        let (p_after, n_after) = compute_pools(collateral, strike, 1_200 * USD).unwrap();
        assert_eq!(p_after, p_before);
        assert_eq!(n_after, n_before);
    }

    #[test]
    fn unadjusted_strike_would_have_wiped_out_n() {
        // The failure this adjustment exists to prevent: same 2-for-1 split,
        // but settling against the stored strike instead of the effective one.
        let collateral = ONE_TOKEN;
        let (p, n) = compute_pools(collateral, STRIKE_500, 300 * USD).unwrap();
        assert_eq!(p, collateral);
        assert_eq!(n, 0, "this is the bug: N wiped by a split, not a fall");
    }

    #[test]
    fn effective_strike_rounds_up_to_favour_p() {
        // A ratio that does not divide evenly: strike 1000, 3 -> 7 multiplier.
        // Exact value is 1000 * 3/7 = 428.57..., so ceiling gives 429.
        let m_creation = 3 * MULTIPLIER_SCALE;
        let m_settlement = 7 * MULTIPLIER_SCALE;
        let ceiled = effective_strike(1_000, m_creation, m_settlement).unwrap();
        let floored = checked_mul_div_floor(1_000, m_creation, m_settlement).unwrap();
        assert_eq!(ceiled, 429);
        assert_eq!(floored, 428);
        // A higher strike caps P higher, so ceiling is the P-favouring choice.
        assert!(ceiled > floored);
    }

    #[test]
    fn effective_strike_is_identity_without_a_corporate_action() {
        let m = multiplier_to_fixed(1.0).unwrap();
        assert_eq!(effective_strike(STRIKE_500, m, m).unwrap(), STRIKE_500);
    }

    #[test]
    fn effective_strike_rejects_bad_input() {
        let m = MULTIPLIER_SCALE;
        assert_eq!(effective_strike(0, m, m), Err(OptionsError::InvalidStrike));
        assert_eq!(
            effective_strike(STRIKE_500, 0, m),
            Err(OptionsError::MultiplierInvalid)
        );
        assert_eq!(
            effective_strike(STRIKE_500, m, 0),
            Err(OptionsError::MultiplierInvalid)
        );
    }

    #[test]
    fn scheduled_multiplier_resolves_against_the_price_timestamp() {
        // A change effective at t=1000. A price printed before it must use the
        // old multiplier; one printed at or after it must use the new one.
        assert_eq!(resolve_multiplier(1.0, 2.0, 1_000, 999), 1.0);
        assert_eq!(resolve_multiplier(1.0, 2.0, 1_000, 1_000), 2.0);
        assert_eq!(resolve_multiplier(1.0, 2.0, 1_000, 1_001), 2.0);
        // An unscheduled mint carries new == current with a zero timestamp.
        assert_eq!(resolve_multiplier(1.0, 1.0, 0, 12_345), 1.0);
    }

    // --- Shortfall --------------------------------------------------------

    #[test]
    fn shortfall_is_a_noop_when_the_vault_is_whole() {
        assert_eq!(apply_shortfall(100, 1_000, 1_000).unwrap(), 100);
        assert_eq!(apply_shortfall(100, 2_000, 1_000).unwrap(), 100);
    }

    #[test]
    fn shortfall_haircuts_proportionally() {
        // Vault holds 80 against 100 owed: every payout scales to 80%.
        assert_eq!(apply_shortfall(100, 80, 100).unwrap(), 80);
        assert_eq!(apply_shortfall(50, 80, 100).unwrap(), 40);
        assert_eq!(apply_shortfall(1, 80, 100).unwrap(), 0); // floors
                                                             // A fully drained vault pays nothing rather than reverting.
        assert_eq!(apply_shortfall(100, 0, 100).unwrap(), 0);
    }

    #[test]
    fn shortfall_is_independent_of_redemption_order() {
        // Three redeemers owed 50/30/20 against a vault holding 60 of 100.
        // Redeeming in any order must give each the same 60% share, because
        // `expected` tracks the outstanding obligation rather than the pools.
        fn run(order: &[i128]) -> Vec<i128> {
            let mut available = 60i128;
            let mut expected = 100i128;
            let mut paid = Vec::new();
            for &quoted in order {
                let payout = apply_shortfall(quoted, available, expected).unwrap();
                available -= payout;
                expected -= quoted;
                paid.push(payout);
            }
            paid
        }
        let forward = run(&[50, 30, 20]);
        let reverse = run(&[20, 30, 50]);
        assert_eq!(forward, vec![30, 18, 12]);
        assert_eq!(reverse, vec![12, 18, 30]);
        // Same total, same per-claim ratio, whoever shows up first.
        assert_eq!(forward.iter().sum::<i128>(), 60);
        assert_eq!(reverse.iter().sum::<i128>(), 60);
    }

    #[test]
    fn shortfall_never_overpays_the_vault() {
        // Exhaustive-ish sweep: for any drain level and any split of the
        // obligation, the total paid never exceeds what the vault holds.
        for available in [0i128, 1, 7, 33, 60, 99, 100] {
            for cuts in [vec![100i128], vec![50, 50], vec![33, 33, 34], vec![1, 99]] {
                let mut left = available;
                let mut expected = 100i128;
                let mut total = 0i128;
                for quoted in cuts {
                    let payout = apply_shortfall(quoted, left, expected).unwrap();
                    total += payout;
                    left -= payout;
                    expected -= quoted;
                }
                assert!(total <= available, "paid {total} out of {available}");
            }
        }
    }
}
