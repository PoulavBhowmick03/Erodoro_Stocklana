// SPDX-License-Identifier: Apache-2.0
//! `FeedConfig`, laid out byte-for-byte as the Anchor variant writes it.
//!
//! Keeping the layout identical is not cosmetic. It means an account created by
//! one variant is readable by the other, so the conformance tests can assert on
//! the *same* bytes, and a migration between framework builds would not need to
//! rewrite state.
//!
//! ```text
//! offset  size  field
//!      0     8  Anchor discriminator, sha256("account:FeedConfig")[..8]
//!      8    32  admin
//!     40    32  feed_id
//!     72    32  source
//!    104     8  max_age_secs           (i64, little-endian)
//!    112     1  min_verification_signatures
//!    113     1  bump
//! ```

use crate::error::OptionsError;

/// `sha256("account:FeedConfig")[..8]`, the discriminator Anchor writes.
/// Derived independently in the tests below rather than trusted as a literal.
pub const FEED_CONFIG_DISCRIMINATOR: [u8; 8] = [75, 97, 12, 15, 89, 221, 78, 71];

pub const FEED_CONFIG_SEED: &[u8] = b"feed-config";

/// Total account size including the discriminator.
pub const FEED_CONFIG_LEN: usize = 8 + 32 + 32 + 32 + 8 + 1 + 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FeedConfig {
    pub admin: [u8; 32],
    /// Pyth feed id for the pair. Every quote is checked against this, so a
    /// series can never settle against the price of a different asset.
    pub feed_id: [u8; 32],
    pub source: [u8; 32],
    /// Maximum accepted staleness of a quote relative to the cluster clock.
    pub max_age_secs: i64,
    /// Minimum guardian signatures a partially-verified Pyth update must carry.
    /// `Full` always clears it. A zero floor accepts an update backed by no
    /// signatures at all, so mainnet configs must set this.
    pub min_verification_signatures: u8,
    pub bump: u8,
}

impl FeedConfig {
    pub fn load(data: &[u8]) -> Result<Self, OptionsError> {
        if data.len() < FEED_CONFIG_LEN || data[..8] != FEED_CONFIG_DISCRIMINATOR {
            return Err(OptionsError::InvalidParams);
        }
        let mut admin = [0u8; 32];
        let mut feed_id = [0u8; 32];
        let mut source = [0u8; 32];
        let mut age = [0u8; 8];
        admin.copy_from_slice(&data[8..40]);
        feed_id.copy_from_slice(&data[40..72]);
        source.copy_from_slice(&data[72..104]);
        age.copy_from_slice(&data[104..112]);
        Ok(Self {
            admin,
            feed_id,
            source,
            max_age_secs: i64::from_le_bytes(age),
            min_verification_signatures: data[112],
            bump: data[113],
        })
    }

    pub fn store(&self, data: &mut [u8]) -> Result<(), OptionsError> {
        if data.len() < FEED_CONFIG_LEN {
            return Err(OptionsError::InvalidParams);
        }
        data[..8].copy_from_slice(&FEED_CONFIG_DISCRIMINATOR);
        data[8..40].copy_from_slice(&self.admin);
        data[40..72].copy_from_slice(&self.feed_id);
        data[72..104].copy_from_slice(&self.source);
        data[104..112].copy_from_slice(&self.max_age_secs.to_le_bytes());
        data[112] = self.min_verification_signatures;
        data[113] = self.bump;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> FeedConfig {
        FeedConfig {
            admin: [1u8; 32],
            feed_id: [2u8; 32],
            source: [3u8; 32],
            max_age_secs: 60,
            min_verification_signatures: 13,
            bump: 254,
        }
    }

    #[test]
    fn the_layout_is_114_bytes() {
        assert_eq!(FEED_CONFIG_LEN, 114);
    }

    /// The discriminator is what makes an account created by the Anchor build
    /// readable by this one. Derive it here instead of trusting the literal —
    /// a transcription error would only surface as a cross-variant mismatch on
    /// a live account, which is the worst place to find it.
    #[test]
    fn the_discriminator_is_the_anchor_derivation() {
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(b"account:FeedConfig");
        assert_eq!(hash[..8], FEED_CONFIG_DISCRIMINATOR);
    }

    #[test]
    fn round_trips_through_bytes() {
        let cfg = sample();
        let mut buf = [0u8; FEED_CONFIG_LEN];
        cfg.store(&mut buf).unwrap();
        assert_eq!(FeedConfig::load(&buf).unwrap(), cfg);
    }

    #[test]
    fn fields_land_at_the_documented_offsets() {
        let cfg = sample();
        let mut buf = [0u8; FEED_CONFIG_LEN];
        cfg.store(&mut buf).unwrap();
        assert_eq!(&buf[..8], &FEED_CONFIG_DISCRIMINATOR);
        assert_eq!(&buf[8..40], &[1u8; 32]);
        assert_eq!(&buf[40..72], &[2u8; 32]);
        assert_eq!(&buf[72..104], &[3u8; 32]);
        assert_eq!(&buf[104..112], &60i64.to_le_bytes());
        assert_eq!(buf[112], 13);
        assert_eq!(buf[113], 254);
    }

    #[test]
    fn negative_max_age_survives_the_round_trip() {
        // `initialize` rejects it, but the codec must not corrupt it — a codec
        // that only handles values the validator happens to allow is a codec
        // with an untested branch.
        let cfg = FeedConfig {
            max_age_secs: i64::MIN,
            ..sample()
        };
        let mut buf = [0u8; FEED_CONFIG_LEN];
        cfg.store(&mut buf).unwrap();
        assert_eq!(FeedConfig::load(&buf).unwrap().max_age_secs, i64::MIN);
    }

    #[test]
    fn rejects_a_foreign_discriminator() {
        let mut buf = [0u8; FEED_CONFIG_LEN];
        sample().store(&mut buf).unwrap();
        buf[0] ^= 0xff;
        assert!(FeedConfig::load(&buf).is_err());
    }

    #[test]
    fn rejects_every_truncation() {
        let mut buf = [0u8; FEED_CONFIG_LEN];
        sample().store(&mut buf).unwrap();
        for len in 0..FEED_CONFIG_LEN {
            assert!(
                FeedConfig::load(&buf[..len]).is_err(),
                "a {len}-byte account loaded when it should not have"
            );
        }
    }

    #[test]
    fn tolerates_a_longer_account() {
        // Anchor sizes accounts exactly, but an oversized account must read as
        // its prefix rather than being rejected outright.
        let mut buf = [0u8; FEED_CONFIG_LEN + 16];
        sample().store(&mut buf).unwrap();
        assert_eq!(FeedConfig::load(&buf).unwrap(), sample());
    }

    #[test]
    fn store_refuses_a_short_buffer() {
        let mut buf = [0u8; FEED_CONFIG_LEN - 1];
        assert!(sample().store(&mut buf).is_err());
    }
}
