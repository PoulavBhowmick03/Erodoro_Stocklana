// SPDX-License-Identifier: Apache-2.0
//! Quote decoding and validation. Framework-independent: no account types
//! appear here, only bytes and numbers, so the same logic is exercised by unit
//! tests without a validator.

use crate::{
    error::OptionsError,
    pyth::{PriceUpdateV2, PYTH_RECEIVER_ID},
    state::FeedConfigData,
};

/// Matches `common::math::MAX_DECIMALS`.
pub const MAX_DECIMALS: u32 = 18;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub feed_id: [u8; 32],
    pub price: i128,
    pub decimals: u32,
    /// Publish time reported by the source, not the slot the read happened in.
    pub timestamp: i64,
}

/// `10^exp`, refusing anything past `MAX_DECIMALS`.
pub fn pow10(exp: u32) -> Result<i128, OptionsError> {
    if exp > MAX_DECIMALS {
        return Err(OptionsError::InvalidDecimals);
    }
    let mut acc: i128 = 1;
    for _ in 0..exp {
        acc = acc.checked_mul(10).ok_or(OptionsError::MathOverflow)?;
    }
    Ok(acc)
}

/// Turn a Pyth-style signed exponent into the unsigned decimal count the shared
/// math works in.
///
/// A negative exponent is the normal case and maps straight across: `-8` means
/// the integer carries 8 decimals. A non-negative exponent means the integer is
/// *coarser* than one unit, so it is materialized at 0 decimals rather than
/// pretending to a precision it does not have.
pub fn scale_from_expo(price: i64, expo: i32) -> Result<(i128, u32), OptionsError> {
    let price = price as i128;
    if expo <= 0 {
        let decimals = expo.unsigned_abs();
        if decimals > MAX_DECIMALS {
            return Err(OptionsError::OracleDecimalsInvalid);
        }
        Ok((price, decimals))
    } else {
        let exp = expo as u32;
        if exp > MAX_DECIMALS {
            return Err(OptionsError::OracleDecimalsInvalid);
        }
        let factor = pow10(exp)?;
        let scaled = price
            .checked_mul(factor)
            .ok_or(OptionsError::MathOverflow)?;
        Ok((scaled, 0))
    }
}

/// Decode a Pyth account's bytes into a quote, enforcing the signature floor.
///
/// `owner` is the account's owner program, passed separately so this stays
/// callable without an `AccountView`.
pub fn decode_pyth(
    owner: &[u8; 32],
    data: &[u8],
    min_signatures: u8,
) -> Result<PriceData, OptionsError> {
    if owner != &PYTH_RECEIVER_ID {
        return Err(OptionsError::InvalidOracle);
    }
    let update = PriceUpdateV2::try_from_account_data(data)?;
    if !update.verification_level.meets(min_signatures) {
        return Err(OptionsError::OraclePriceInvalid);
    }
    let msg = update.price_message;
    let (price, decimals) = scale_from_expo(msg.price, msg.exponent)?;
    Ok(PriceData {
        feed_id: msg.feed_id,
        price,
        decimals,
        timestamp: msg.publish_time,
    })
}

/// Decode and validate the quote behind `cfg`.
///
/// Checks, in order: the account is the one the config names; it is owned by
/// the Pyth receiver; its feed id matches; the price is positive; the publish
/// time is not in the future; and the quote is no older than `max_age_secs`.
///
/// The order matters and is the same as the Anchor variant's, because the error
/// a caller sees is part of the interface.
pub fn read_quote(
    cfg: &FeedConfigData,
    source_key: &[u8; 32],
    source_owner: &[u8; 32],
    source_data: &[u8],
    now: i64,
) -> Result<PriceData, OptionsError> {
    if source_key != &cfg.source {
        return Err(OptionsError::FeedMismatch);
    }

    let quote = decode_pyth(source_owner, source_data, cfg.min_verification_signatures)?;

    if quote.feed_id != cfg.feed_id {
        return Err(OptionsError::FeedMismatch);
    }
    if quote.price <= 0 {
        return Err(OptionsError::OraclePriceInvalid);
    }
    if quote.timestamp > now {
        return Err(OptionsError::OraclePriceInvalid);
    }
    if now.saturating_sub(quote.timestamp) > cfg.max_age_secs {
        return Err(OptionsError::OraclePriceStale);
    }
    Ok(quote)
}

/// The settlement read: a validated quote whose publish time is at or after
/// `after_ts` (the series' maturity) and no older than `max_age_secs`.
///
/// The caller passes its own `max_age_secs`, so a long-dated series and a
/// weekly one can share a feed config without sharing a staleness tolerance.
pub fn read_quote_at_or_after(
    cfg: &FeedConfigData,
    source_key: &[u8; 32],
    source_owner: &[u8; 32],
    source_data: &[u8],
    now: i64,
    after_ts: i64,
    max_age_secs: i64,
) -> Result<PriceData, OptionsError> {
    let quote = read_quote(cfg, source_key, source_owner, source_data, now)?;
    if quote.timestamp < after_ts {
        return Err(OptionsError::OraclePriceStale);
    }
    if now.saturating_sub(quote.timestamp) > max_age_secs {
        return Err(OptionsError::OraclePriceStale);
    }
    Ok(quote)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negative_exponent_maps_to_decimals() {
        // The TSLA/USD case: -8 means the integer carries 8 decimals.
        assert_eq!(scale_from_expo(400_00000000, -8).unwrap(), (400_00000000, 8));
        assert_eq!(scale_from_expo(400_00000, -5).unwrap(), (400_00000, 5));
        assert_eq!(scale_from_expo(7, 0).unwrap(), (7, 0));
    }

    #[test]
    fn positive_exponent_materializes_at_zero_decimals() {
        // expo 2 means each integer unit is 100, so 5 is really 500.
        assert_eq!(scale_from_expo(5, 2).unwrap(), (500, 0));
    }

    #[test]
    fn absurd_exponents_are_rejected() {
        assert!(scale_from_expo(1, -19).is_err());
        assert!(scale_from_expo(1, 19).is_err());
    }

    /// The exponent domain is small enough to walk end to end. Anything inside
    /// the band must succeed and anything outside must fail — no panics, no
    /// silent saturation, across the whole range.
    #[test]
    fn the_whole_exponent_domain_behaves() {
        for expo in -40i32..=40 {
            let got = scale_from_expo(1, expo);
            let inside = expo.unsigned_abs() <= MAX_DECIMALS;
            assert_eq!(got.is_ok(), inside, "expo {expo}");
            if let Ok((price, decimals)) = got {
                if expo <= 0 {
                    assert_eq!(price, 1);
                    assert_eq!(decimals, expo.unsigned_abs());
                } else {
                    assert_eq!(price, pow10(expo as u32).unwrap());
                    assert_eq!(decimals, 0);
                }
            }
        }
    }

    /// The `MathOverflow` arm of `scale_from_expo` is unreachable, and that is
    /// worth pinning rather than assuming.
    ///
    /// The widest case the `MAX_DECIMALS` guard admits is `i64::MAX * 10^18`,
    /// which is about `9.2e36` against an `i128` ceiling of about `1.7e38` — so
    /// the multiply always fits. The `checked_mul` stays as defence in depth
    /// against a future `MAX_DECIMALS` increase: at 21 decimals it would start
    /// to bite, and this test says so out loud.
    #[test]
    fn the_guarded_domain_can_never_overflow() {
        for expo in 1..=MAX_DECIMALS as i32 {
            for price in [i64::MAX, i64::MIN, 0, 1, -1] {
                assert!(
                    scale_from_expo(price, expo).is_ok(),
                    "price {price} expo {expo} should fit"
                );
            }
        }
        // The widest admitted product, computed independently.
        assert_eq!(
            scale_from_expo(i64::MAX, MAX_DECIMALS as i32).unwrap(),
            (i64::MAX as i128 * 1_000_000_000_000_000_000i128, 0)
        );
        // One decimal past the guard is refused before any multiply happens.
        assert_eq!(
            scale_from_expo(i64::MAX, MAX_DECIMALS as i32 + 1),
            Err(OptionsError::OracleDecimalsInvalid)
        );
    }

    /// Negative prices pass through scaling untouched — rejecting them is
    /// `read_quote`'s job, and it must not be silently absorbed here.
    #[test]
    fn scaling_preserves_sign() {
        assert_eq!(scale_from_expo(-5, -2).unwrap(), (-5, 2));
        assert_eq!(scale_from_expo(-5, 2).unwrap(), (-500, 0));
        assert_eq!(scale_from_expo(0, -8).unwrap(), (0, 8));
    }

    #[test]
    fn pow10_covers_its_domain_and_refuses_beyond() {
        assert_eq!(pow10(0).unwrap(), 1);
        assert_eq!(pow10(18).unwrap(), 1_000_000_000_000_000_000);
        assert_eq!(pow10(19), Err(OptionsError::InvalidDecimals));
        let mut expect: i128 = 1;
        for e in 0..=MAX_DECIMALS {
            assert_eq!(pow10(e).unwrap(), expect, "10^{e}");
            if e < MAX_DECIMALS {
                expect *= 10;
            }
        }
    }
}
