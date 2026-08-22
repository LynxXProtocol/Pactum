//! Kani bounded proofs for dispute-slashing economics (Issue #192).
//!
//! These harnesses are compiled only under `cfg(kani)` and are **not** part of
//! the default `cargo test` / CI contract jobs. Run manually:
//!
//! ```bash
//! cargo install --locked kani-verifier
//! cargo kani setup
//! cargo kani -p registry --tests
//! ```

use super::*;

/// Slash cut never exceeds stake, never goes negative, and conserves mass.
#[kani::proof]
fn proof_slash_cut_bounded_and_conservative() {
    let staked: i128 = kani::any();
    let percent: u64 = kani::any();
    kani::assume(staked >= 0);
    kani::assume(staked <= 1_000_000);
    kani::assume(percent <= 100);

    if let Some(SlashCut { cut, remaining }) = slash_cut(staked, percent) {
        assert!(cut >= 0);
        assert!(remaining >= 0);
        assert!(cut <= staked);
        assert_eq!(cut + remaining, staked);
    }
}

/// Vault token balance is unchanged by slash accounting (no drain on slash).
#[kani::proof]
fn proof_slash_does_not_drain_vault_tokens() {
    let staked: i128 = kani::any();
    let vault: i128 = kani::any();
    kani::assume(staked >= 0 && staked <= 1_000_000);
    kani::assume(vault >= staked && vault <= 2_000_000);

    if let Some((remaining, vault_after)) =
        apply_slash_accounting(staked, vault, SLASH_PERCENT_OF_STAKE)
    {
        assert_eq!(vault_after, vault);
        assert!(remaining <= staked);
        assert!(vault_after >= remaining);
    }
}

/// Weak TVL: after any single-attestor slash, vault still covers recorded stake.
#[kani::proof]
fn proof_vault_covers_stake_after_slash() {
    let mut snap = VaultSnapshot {
        vault_tokens: kani::any(),
        recorded: [kani::any(), 0, 0, 0],
        len: 1,
    };
    kani::assume(snap.recorded[0] >= 0 && snap.recorded[0] <= 500_000);
    kani::assume(snap.vault_tokens >= snap.recorded[0]);
    kani::assume(snap.vault_tokens <= 1_000_000);
    assert!(vault_covers_recorded_stakes(&snap));

    if let Some(cut) = slash_cut(snap.recorded[0], SLASH_PERCENT_OF_STAKE) {
        snap.recorded[0] = cut.remaining;
        assert!(vault_covers_recorded_stakes(&snap));
    }
}

/// Timeout path never slashes; dissenting voters are the only slash targets.
#[kani::proof]
fn proof_slash_policy_matches_voting_rules() {
    let slash_dissenters: bool = kani::any();
    let cast_a_vote: bool = kani::any();
    let voted_with_winner: bool = kani::any();

    let decision = should_slash_attestor(slash_dissenters, cast_a_vote, voted_with_winner);

    if !slash_dissenters {
        assert_eq!(decision, SlashDecision::Spare);
    } else if !cast_a_vote || voted_with_winner {
        assert_eq!(decision, SlashDecision::Spare);
    } else {
        assert_eq!(decision, SlashDecision::Slash);
    }
}
