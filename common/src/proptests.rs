// SPDX-License-Identifier: Apache-2.0
//! Property-based fuzzing of the solvency-critical integer math.
//!
//! `proptest` generates thousands of random inputs per property and shrinks any
//! counterexample to a minimal failing case. These properties are the formal
//! statements of the invariants the programs rely on; if any breaks, the
//! protocol could leak collateral.
//!
//! Two of them cover the corporate-action adjustment and the shortfall
//! new properties for the corporate-action adjustment and the shortfall
//! haircut.

use crate::{
    apply_shortfall, checked_mul_div_floor, compute_pools, compute_redeem, effective_strike,
    normalize_decimals, MULTIPLIER_SCALE,
};
use proptest::collection::vec;
use proptest::prelude::*;

// Bounds chosen so intermediate products stay well within i128
// (max ~1.7e38). 1e18 * 1e18 = 1e36.
const BIG: i128 = 1_000_000_000_000_000_000; // 1e18
const PRICE_MAX: i128 = 1_000_000_000_000; // 1e12
const COLLATERAL_MAX: i128 = 100_000_000_000_000_000; // 1e17

proptest! {
    /// `checked_mul_div_floor` returns the exact floor of `a*b/d`.
    #[test]
    fn mul_div_is_exact_floor(a in 0i128..=BIG, b in 0i128..=BIG, d in 1i128..=BIG) {
        let r = checked_mul_div_floor(a, b, d).unwrap();
        let prod = a * b;
        prop_assert!(r * d <= prod, "floor below");
        prop_assert!(prod < (r + 1) * d, "floor tight");
    }

    /// Pools always partition the collateral, stay within bounds, and `P` is
    /// non-increasing in price.
    #[test]
    fn pools_partition_and_are_monotonic(
        collateral in 0i128..=COLLATERAL_MAX,
        strike in 1i128..=PRICE_MAX,
        price in 1i128..=PRICE_MAX,
    ) {
        let (p, n) = compute_pools(collateral, strike, price).unwrap();
        prop_assert_eq!(p + n, collateral);
        prop_assert!(p >= 0 && n >= 0);
        prop_assert!(p <= collateral && n <= collateral);
        if price <= strike {
            prop_assert_eq!(p, collateral);
            prop_assert_eq!(n, 0);
        }
        // Raising the price never increases the P pool.
        let (p_higher, _) = compute_pools(collateral, strike, price + 1).unwrap();
        prop_assert!(p_higher <= p);
    }

    /// The core solvency property: redeeming any partition of the supply pays
    /// out at most the pool. (Each side is an independent instance of this.)
    #[test]
    fn redeeming_a_partition_never_overdraws(
        (supply, pool, cuts) in (1i128..=BIG).prop_flat_map(|s| {
            (Just(s), 0i128..=s, vec(0i128..=s, 0..8))
        })
    ) {
        // Turn the random cut points into contiguous parts that sum to `supply`.
        let mut points = cuts;
        points.push(0);
        points.push(supply);
        points.sort_unstable();

        let mut total_paid = 0i128;
        for w in points.windows(2) {
            let part = w[1] - w[0];
            total_paid += compute_redeem(part, pool, supply).unwrap();
        }
        prop_assert!(total_paid <= pool, "overdrew pool: {} > {}", total_paid, pool);
    }

    /// Scaling a value up to more decimals is lossless and exactly reversible.
    #[test]
    fn normalize_up_then_down_roundtrips(
        value in 0i128..=BIG,
        from in 0u32..=9,
        delta in 0u32..=9,
    ) {
        let to = from + delta;
        let up = normalize_decimals(value, from, to).unwrap();
        let back = normalize_decimals(up, to, from).unwrap();
        prop_assert_eq!(back, value);

        // Scaling down then back up can only lose precision, never gain value.
        let down = normalize_decimals(value, to, from).unwrap();
        let up_again = normalize_decimals(down, from, to).unwrap();
        prop_assert!(up_again <= value);
    }

    /// A corporate action moves the price and the multiplier together. Adjusting
    /// the strike by the same ratio leaves both pools where they were, to within
    /// the one-unit slack that the two flooring steps allow. This is §6 stated
    /// as a property rather than as the two worked examples in the unit tests.
    #[test]
    fn corporate_action_preserves_the_pools(
        collateral in 1i128..=COLLATERAL_MAX,
        strike in 1i128..=PRICE_MAX,
        price in 1i128..=PRICE_MAX,
        ratio_num in 1i128..=20,
        ratio_den in 1i128..=20,
    ) {
        // Pools before any corporate action.
        let (p_before, _) = compute_pools(collateral, strike, price).unwrap();

        // The action rebases balances by `ratio_num/ratio_den`; the reported
        // price moves by the inverse, since the underlying is unchanged.
        //
        // Only ratios the 1e12 fixed-point scale represents exactly are in
        // scope. That is not a dodge: real corporate actions are 2:1, 1:2,
        // 3:2, 20:1 and the like, all exact here. A ratio like 1:3 is
        // inherently approximated by `MULTIPLIER_SCALE`, and the residual is
        // the documented twelve-decimal resolution of the multiplier rather
        // than anything `effective_strike` can fix.
        prop_assume!(MULTIPLIER_SCALE * ratio_num % ratio_den == 0);
        let m_creation = MULTIPLIER_SCALE;
        let m_settlement = MULTIPLIER_SCALE * ratio_num / ratio_den;
        prop_assume!(m_settlement > 0);
        let new_price = price * ratio_den / ratio_num;
        prop_assume!(new_price > 0);

        let adjusted = effective_strike(strike, m_creation, m_settlement).unwrap();
        let (p_after, n_after) = compute_pools(collateral, adjusted, new_price).unwrap();

        // Pools still partition the collateral, whatever the action was.
        prop_assert_eq!(p_after + n_after, collateral);

        // And P lands where it was, to within the rounding the three integer
        // steps allow. Since `p ~= collateral * strike / price`:
        //   - the ceiling in `effective_strike` moves the strike by at most 1,
        //     worth `collateral / new_price` of p;
        //   - the flooring of the synthetic price move drops `new_price` by at
        //     most 1, worth another `collateral / new_price` of p
        //     (`dp/d price = -p / price`, and `p <= collateral`);
        //   - the two floors inside `compute_pools` contribute 1 each.
        let slack = 2 * (collateral / new_price.max(1)) + 2;
        prop_assert!(
            (p_after - p_before).abs() <= slack,
            "p moved from {} to {} (slack {})", p_before, p_after, slack
        );
    }

    /// However a settled vault is drained, and in whatever order redeemers
    /// arrive, the haircut never pays out more than the vault holds and never
    /// depends on redemption order for the total.
    #[test]
    fn shortfall_is_order_independent_and_solvent(
        available in 0i128..=BIG,
        claims in vec(1i128..=BIG, 1..6),
    ) {
        let expected: i128 = claims.iter().sum();

        let settle = |order: &[i128]| -> (i128, Vec<i128>) {
            let mut left = available.min(expected);
            let mut owed = expected;
            let mut paid = Vec::new();
            for &quoted in order {
                let payout = apply_shortfall(quoted, left, owed).unwrap();
                left -= payout;
                owed -= quoted;
                paid.push(payout);
            }
            (paid.iter().sum(), paid)
        };

        let mut reversed = claims.clone();
        reversed.reverse();
        let (total_forward, forward) = settle(&claims);
        let (total_reverse, mut reverse) = settle(&reversed);
        reverse.reverse();

        // Never pays out more than the vault holds.
        prop_assert!(total_forward <= available.min(expected));
        prop_assert!(total_reverse <= available.min(expected));

        // Each claim gets the same payout regardless of when it is presented.
        //
        // Not bit-identical: each payout floors, so the vault keeps a sub-unit
        // remainder that very slightly improves the ratio for whoever redeems
        // next. Over `n` claims that drift accumulates to at most `n` units,
        // plus one for the claim's own flooring. That is the difference between
        // "the same haircut" and "first-come-first-served", which is what §7
        // is actually about.
        let tolerance = claims.len() as i128 + 1;
        for (f, r) in forward.iter().zip(reverse.iter()) {
            prop_assert!(
                (f - r).abs() <= tolerance,
                "order changed a payout: {} vs {} (tolerance {})", f, r, tolerance
            );
        }
    }
}
