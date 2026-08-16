#![cfg(test)]

//! Exhaustive unit tests for the ledger-based time-decay trust score.
//!
//! These tests prove the acceptance criteria of issue #54:
//! - a recent breach tanks the score immediately, and
//! - the breach's impact mathematically degrades over simulated ledger
//!   advances (exact values at power-of-two decay boundaries).
//!
//! The query path contains no loop and performs a single storage read, so
//! correctness is asserted here at 1,000 folded buckets to demonstrate the
//! O(1) behavior holds regardless of history length.

use super::*;
use crate::commitments::CommitmentStatus;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, BytesN, Env};

fn setup() -> (Env, RegistryContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    let counterparty = Address::generate(&env);
    (env, client, issuer, counterparty)
}

/// Test harness for long-horizon decay tests. Simulates a live network whose
/// contract stays alive across large ledger jumps: entries start with a TTL
/// of `min_persistent_entry_ttl` (4096 by default) and are extended to at
/// most ~518,400 ledgers by the contract's own bump-on-access, so a single
/// jump past that would archive them. Initializing the contract gives
/// `advance_ledgers` a call that bumps the instance TTL, mirroring production
/// (regular use keeps entries alive). This only affects TTL mechanics — never
/// the decay math under test.
fn setup_long_horizon() -> (Env, RegistryContractClient<'static>, Address, Address) {
    let (env, client, issuer, counterparty) = setup();
    let arbitrator = Address::generate(&env);
    client.initialize(&arbitrator);
    (env, client, issuer, counterparty)
}

/// Advances the ledger sequence to `target_seq` in chunks of 200,000 ledgers,
/// keeping the contract instance and the issuer's trust history alive along
/// the way (exactly as production use would): `get_arbitrator` bumps the
/// instance TTL and `get_trust_score` bumps the history entry TTL, each to
/// ~518,400 ledgers past the current sequence. When `commitment` is `Some`,
/// `get_commitment` keeps that entry alive too (dispute/resolve read it).
///
/// Chunk math: a bump at ledger `s` extends the entry to `s + 518,400`, and
/// the bump only fires when the entry is within `241,920` of expiry, so the
/// gap between bumps never exceeds 400,000 ledgers — always below 518,400,
/// and the final chunk lands exactly on `target_seq` and re-arms the TTL for
/// the next call. Never alters the decay math.
fn advance_ledgers(
    env: &Env,
    client: &RegistryContractClient<'static>,
    issuer: &Address,
    target_seq: u32,
    commitment: Option<u64>,
) {
    const CHUNK: u32 = 200_000;
    let mut seq = env.ledger().get().sequence_number;
    while seq < target_seq {
        let next = seq.saturating_add(CHUNK).min(target_seq);
        env.ledger().with_mut(|l| l.sequence_number = next);
        client.get_arbitrator();
        client.get_trust_score(issuer);
        client.get_reputation(issuer);
        if let Some(id) = commitment {
            client.get_commitment(&id);
        }
        seq = next;
    }
}

fn setup_with_arbitrator() -> (
    Env,
    RegistryContractClient<'static>,
    Address,
    Address,
    Address,
) {
    let (env, client, issuer, counterparty) = setup();
    let arbitrator = Address::generate(&env);
    client.initialize(&arbitrator);
    (env, client, issuer, counterparty, arbitrator)
}

/// Creates a commitment at ledger seq/timestamp 1000 (due 2000) and attests
/// it with `outcome` at timestamp 1500, all within bucket 0.
fn create_and_attest(
    env: &Env,
    client: &RegistryContractClient<'static>,
    issuer: &Address,
    counterparty: &Address,
    terms: u8,
    outcome: CommitmentStatus,
) -> u64 {
    env.ledger().with_mut(|l| {
        l.timestamp = 1000;
        l.sequence_number = 1000;
    });
    let resolver = Address::generate(env);
    let id = client.create_commitment(issuer, counterparty, &BytesN::from_array(env, &[terms; 32]), &2000, &100_000_000, &resolver);
    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(issuer, &id, &outcome);
    id
}

// -----------------------------------------------------------------------------
// 1. No history -> defined baseline
// -----------------------------------------------------------------------------

#[test]
fn test_no_history_returns_baseline() {
    let (env, client, _issuer, _counterparty) = setup();
    let stranger = Address::generate(&env);
    assert_eq!(client.get_trust_score(&stranger), 50);
}

// -----------------------------------------------------------------------------
// 2. Recent breach has immediate impact
// -----------------------------------------------------------------------------

#[test]
fn test_recent_breach_tanks_score_immediately() {
    let (env, client, issuer, counterparty) = setup();
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        1,
        CommitmentStatus::Breached,
    );

    // Single breach with no history: 50 - 50 = 0.
    assert_eq!(client.get_trust_score(&issuer), 0);
}

#[test]
fn test_recent_breach_tanks_mixed_history() {
    let (env, client, issuer, counterparty) = setup();
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        1,
        CommitmentStatus::Fulfilled,
    );
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        2,
        CommitmentStatus::Breached,
    );

    // 1 fulfilled (+10) + 1 breached (-50) on the 50 baseline: 50 + 10 - 50 = 10.
    assert_eq!(client.get_trust_score(&issuer), 10);
}

// -----------------------------------------------------------------------------
// 3. Old breach has reduced impact (exact decay values)
// -----------------------------------------------------------------------------

#[test]
fn test_breach_impact_decays_with_ledger_advances() {
    let (env, client, issuer, counterparty) = setup_long_horizon();
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        1,
        CommitmentStatus::Breached,
    );

    // Bucket 0 -> bucket 64 (64 * 10,000 ledgers): one decay step, weight 1/2.
    advance_ledgers(
        &env,
        &client,
        &issuer,
        1000 + 64 * crate::trust_score::BUCKET_SIZE_LEDGERS,
        None,
    );
    assert_eq!(client.get_trust_score(&issuer), 25);

    // Bucket 0 -> bucket 128: two decay steps, weight 1/4.
    advance_ledgers(
        &env,
        &client,
        &issuer,
        1000 + 128 * crate::trust_score::BUCKET_SIZE_LEDGERS,
        None,
    );
    assert_eq!(client.get_trust_score(&issuer), 37);

    // Bucket 0 -> bucket 256: four decay steps, weight 1/16 -> 50 - 3.125 -> 46.
    advance_ledgers(
        &env,
        &client,
        &issuer,
        1000 + 256 * crate::trust_score::BUCKET_SIZE_LEDGERS,
        None,
    );
    assert_eq!(client.get_trust_score(&issuer), 46);

    // Bucket 0 -> bucket 2048: 32 decay steps, weight 0 -> baseline.
    advance_ledgers(
        &env,
        &client,
        &issuer,
        1000 + 2048 * crate::trust_score::BUCKET_SIZE_LEDGERS,
        None,
    );
    assert_eq!(client.get_trust_score(&issuer), 50);
}

#[test]
fn test_mixed_history_decay_exact_values() {
    let (env, client, issuer, counterparty) = setup_long_horizon();
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        1,
        CommitmentStatus::Fulfilled,
    );
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        2,
        CommitmentStatus::Breached,
    );

    // k=0: 50 + 10 - 50 = 10.  k=1: 50 + 5 - 25 = 30.  k=2: 50 + 2.5 - 12.5 -> 40.
    advance_ledgers(
        &env,
        &client,
        &issuer,
        1000 + 64 * crate::trust_score::BUCKET_SIZE_LEDGERS,
        None,
    );
    assert_eq!(client.get_trust_score(&issuer), 30);

    advance_ledgers(
        &env,
        &client,
        &issuer,
        1000 + 128 * crate::trust_score::BUCKET_SIZE_LEDGERS,
        None,
    );
    assert_eq!(client.get_trust_score(&issuer), 40);
}

// -----------------------------------------------------------------------------
// 4. Decay is monotonic
// -----------------------------------------------------------------------------

#[test]
fn test_score_is_monotone_non_decreasing_over_ledger_advances() {
    let (env, client, issuer, counterparty) = setup_long_horizon();
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        1,
        CommitmentStatus::Breached,
    );

    let mut previous = client.get_trust_score(&issuer);
    assert_eq!(previous, 0);

    // 1, 2, 4, ..., 2048, 4096 buckets ahead.
    for buckets in [
        1u32, 2, 4, 8, 16, 32, 63, 64, 65, 128, 256, 512, 1024, 2048, 4096,
    ] {
        advance_ledgers(
            &env,
            &client,
            &issuer,
            1000 + buckets * crate::trust_score::BUCKET_SIZE_LEDGERS,
            None,
        );
        let current = client.get_trust_score(&issuer);
        assert!(
            current >= previous,
            "score regressed from {previous} to {current} at {buckets} buckets"
        );
        assert!(current <= 100);
        previous = current;
    }
    assert_eq!(previous, 50);
}

// -----------------------------------------------------------------------------
// 5. Success/failure weighting is deterministic
// -----------------------------------------------------------------------------

#[test]
fn test_fulfills_raise_score_to_cap() {
    let (env, client, issuer, _counterparty) = setup();
    for i in 0..5u8 {
        create_and_attest(
            &env,
            &client,
            &issuer,
            &Address::generate(&env),
            i,
            CommitmentStatus::Fulfilled,
        );
    }
    // 50 + 5 * 10 = 100.
    assert_eq!(client.get_trust_score(&issuer), 100);
}

#[test]
fn test_late_outcome_penalty_and_decay() {
    let (env, client, issuer, counterparty) = setup_long_horizon();
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        1,
        CommitmentStatus::Late,
    );

    assert_eq!(client.get_trust_score(&issuer), 40);

    advance_ledgers(
        &env,
        &client,
        &issuer,
        1000 + 64 * crate::trust_score::BUCKET_SIZE_LEDGERS,
        None,
    );
    assert_eq!(client.get_trust_score(&issuer), 45);

    advance_ledgers(
        &env,
        &client,
        &issuer,
        1000 + 2048 * crate::trust_score::BUCKET_SIZE_LEDGERS,
        None,
    );
    assert_eq!(client.get_trust_score(&issuer), 50);
}

#[test]
fn test_fulfilled_and_late_credits_cancel_symmetrically() {
    let (env, client, issuer, _counterparty) = setup();
    for i in 0..10u8 {
        create_and_attest(
            &env,
            &client,
            &issuer,
            &Address::generate(&env),
            i,
            CommitmentStatus::Fulfilled,
        );
    }
    for i in 10..20u8 {
        create_and_attest(
            &env,
            &client,
            &issuer,
            &Address::generate(&env),
            i,
            CommitmentStatus::Late,
        );
    }
    // 10 fulfills (+100) and 10 lates (-100) cancel on the baseline.
    assert_eq!(client.get_trust_score(&issuer), 50);
}

#[test]
fn test_score_is_deterministic_across_replays() {
    let (env1, client1, issuer1, counterparty1) = setup_long_horizon();
    let (env2, client2, issuer2, counterparty2) = setup_long_horizon();

    for (env, client, issuer, counterparty) in [
        (&env1, &client1, &issuer1, &counterparty1),
        (&env2, &client2, &issuer2, &counterparty2),
    ] {
        create_and_attest(
            env,
            client,
            issuer,
            counterparty,
            1,
            CommitmentStatus::Fulfilled,
        );
        create_and_attest(env, client, issuer, counterparty, 2, CommitmentStatus::Late);
        create_and_attest(
            env,
            client,
            issuer,
            counterparty,
            3,
            CommitmentStatus::Breached,
        );
    }

    for buckets in [0u32, 1, 64, 256, 2048] {
        advance_ledgers(
            &env1,
            &client1,
            &issuer1,
            1000 + buckets * crate::trust_score::BUCKET_SIZE_LEDGERS,
            None,
        );
        advance_ledgers(
            &env2,
            &client2,
            &issuer2,
            1000 + buckets * crate::trust_score::BUCKET_SIZE_LEDGERS,
            None,
        );
        let a = client1.get_trust_score(&issuer1);
        let b = client2.get_trust_score(&issuer2);
        assert_eq!(a, b, "score diverged at {buckets} buckets");
    }
}

// -----------------------------------------------------------------------------
// 6/7. Ledger exactly on and just before/after bucket boundaries
// -----------------------------------------------------------------------------

#[test]
fn test_bucket_boundary_semantics() {
    let (env, client, issuer, counterparty) = setup_long_horizon();

    // Attest at sequence 9,999 (bucket 0): the last ledger of bucket 0.
    env.ledger().with_mut(|l| {
        l.timestamp = 1000;
        l.sequence_number = 9_999;
    });
    let resolver = Address::generate(&env);
    let id = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[1u8; 32]), &2000, &100_000_000, &resolver);
    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&issuer, &id, &CommitmentStatus::Breached);
    let id2 = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[2u8; 32]), &2000, &100_000_000, &resolver);
    client.attest(&issuer, &id2, &CommitmentStatus::Fulfilled);

    // Just before the boundary, exactly on it, and just after: same bucket,
    // zero decay steps, identical score.
    for sequence in [9_999u32, 10_000, 10_001, 10_002] {
        env.ledger().with_mut(|l| l.sequence_number = sequence);
        assert_eq!(
            client.get_trust_score(&issuer),
            10,
            "score changed at sequence {sequence}"
        );
    }

    // 63 buckets later (9,999 + 63 * 10,000 = 639,999): still zero decay steps.
    advance_ledgers(&env, &client, &issuer, 639_999, None);
    assert_eq!(client.get_trust_score(&issuer), 10);

    // Exactly 64 buckets later (640,000): first decay step -> 30.
    advance_ledgers(&env, &client, &issuer, 640_000, None);
    assert_eq!(client.get_trust_score(&issuer), 30);
}

// -----------------------------------------------------------------------------
// 8. Very large ledger difference doesn't overflow
// -----------------------------------------------------------------------------

#[test]
fn test_huge_ledger_difference_saturates_without_panic() {
    let (env, client, issuer, counterparty) = setup_long_horizon();
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        1,
        CommitmentStatus::Breached,
    );
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        2,
        CommitmentStatus::Breached,
    );
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        3,
        CommitmentStatus::Breached,
    );

    // Sequence near u32::MAX: bucket delta ~428,856 -> decay steps capped at 32.
    // Stays below u32::MAX - 6,312,000: beyond that, the host's
    // `max_live_until_ledger = seq + max_entry_ttl - 1` overflows u32 when
    // the contract extends an entry's TTL during the jump.
    advance_ledgers(&env, &client, &issuer, u32::MAX - 6_400_000, None);
    assert_eq!(client.get_trust_score(&issuer), 50);
}

// -----------------------------------------------------------------------------
// 9. Maximum decay eventually reaches the minimum weight
// -----------------------------------------------------------------------------

#[test]
fn test_max_decay_reaches_minimum_weight() {
    let (env, client, issuer, counterparty) = setup_long_horizon();
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        1,
        CommitmentStatus::Breached,
    );
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        2,
        CommitmentStatus::Late,
    );
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        3,
        CommitmentStatus::Fulfilled,
    );

    // 32 decay steps zero out every weight: score returns to the baseline.
    advance_ledgers(
        &env,
        &client,
        &issuer,
        1000 + 2048 * crate::trust_score::BUCKET_SIZE_LEDGERS,
        None,
    );
    assert_eq!(client.get_trust_score(&issuer), 50);
}

// -----------------------------------------------------------------------------
// 10. get_trust_score doesn't iterate historical commitments
// -----------------------------------------------------------------------------

#[test]
fn test_query_correct_after_thousands_of_folded_buckets() {
    let (env, client, issuer, counterparty) = setup_long_horizon();

    // One breach per bucket for 1,000 consecutive buckets: every write folds
    // the previous bucket, so the stored state stays constant-size.
    let resolver = Address::generate(&env);
    for i in 0..1000u32 {
        env.ledger().with_mut(|l| {
            l.timestamp = 1000 + i as u64;
            l.sequence_number = 1000 + i * crate::trust_score::BUCKET_SIZE_LEDGERS;
        });
        let id = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[(i % 250) as u8; 32]), &2_000_000, &100_000_000, &resolver);
        client.attest(&issuer, &id, &CommitmentStatus::Breached);
    }

    // Immediately after the last write: many breaches, score at the floor.
    assert_eq!(client.get_trust_score(&issuer), 0);

    // 2048 buckets past the newest write: every breach fully decayed.
    advance_ledgers(
        &env,
        &client,
        &issuer,
        1000 + 3048 * crate::trust_score::BUCKET_SIZE_LEDGERS,
        None,
    );
    assert_eq!(client.get_trust_score(&issuer), 50);
}

// -----------------------------------------------------------------------------
// Write-path semantics: dispute retraction and resolution
// -----------------------------------------------------------------------------

#[test]
fn test_dispute_retracts_recent_breach_from_score() {
    let (env, client, issuer, counterparty, _arbitrator) = setup_with_arbitrator();

    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        1,
        CommitmentStatus::Breached,
    );
    assert_eq!(client.get_trust_score(&issuer), 0);

    // Dispute within the window: the breach is retracted from the trust history.
    env.ledger().with_mut(|l| l.timestamp = 1600);
    client.dispute(&counterparty, &1);
    assert_eq!(client.get_trust_score(&issuer), 50);
}

#[test]
fn test_dispute_retracts_aged_breach_from_score() {
    let (env, client, issuer, counterparty, _arbitrator) = setup_with_arbitrator();

    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        1,
        CommitmentStatus::Breached,
    );
    assert_eq!(client.get_trust_score(&issuer), 0);

    // Advance 64 buckets (the breach has folded into `aged`) but stay within
    // the timestamp-based dispute window. The commitment entry is kept alive
    // too: dispute reads it after the jump.
    advance_ledgers(
        &env,
        &client,
        &issuer,
        1000 + 64 * crate::trust_score::BUCKET_SIZE_LEDGERS,
        Some(1),
    );
    env.ledger().with_mut(|l| l.timestamp = 1600);
    client.dispute(&counterparty, &1);
    let s = client.get_trust_score(&issuer);
    assert_eq!(s, 50);
}

#[test]
fn test_resolve_dispute_applies_final_outcome_to_score() {
    let (env, client, issuer, counterparty, arbitrator) = setup_with_arbitrator();

    env.ledger().with_mut(|l| {
        l.timestamp = 1000;
        l.sequence_number = 1000;
    });
    let id = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[1u8; 32]), &2000, &100_000_000, &arbitrator);
    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&issuer, &id, &CommitmentStatus::Breached);
    assert_eq!(client.get_trust_score(&issuer), 0);

    advance_ledgers(
        &env,
        &client,
        &issuer,
        1000 + 64 * crate::trust_score::BUCKET_SIZE_LEDGERS,
        Some(1),
    );
    env.ledger().with_mut(|l| l.timestamp = 1600);
    client.dispute(&counterparty, &1);
    assert_eq!(client.get_trust_score(&issuer), 50);

    // Arbitrator overturns the breach: only the final outcome counts.
    env.ledger().with_mut(|l| l.timestamp = 1700);
    client.resolve_dispute(&arbitrator, &1, &CommitmentStatus::Fulfilled);
    assert_eq!(client.get_trust_score(&issuer), 60);
}

// -----------------------------------------------------------------------------
// Saturation bounds
// -----------------------------------------------------------------------------

#[test]
fn test_score_saturates_at_upper_and_lower_bounds() {
    let (env, client, issuer, _counterparty) = setup();

    for i in 0..100u8 {
        create_and_attest(
            &env,
            &client,
            &issuer,
            &Address::generate(&env),
            i,
            CommitmentStatus::Fulfilled,
        );
    }
    assert_eq!(client.get_trust_score(&issuer), 100);

    let (env2, client2, issuer2, _counterparty2) = setup();
    for i in 0..10u8 {
        create_and_attest(
            &env2,
            &client2,
            &issuer2,
            &Address::generate(&env2),
            i,
            CommitmentStatus::Breached,
        );
    }
    assert_eq!(client2.get_trust_score(&issuer2), 0);

    // A single fulfill can never push a large breach history above the floor.
    let (env3, client3, issuer3, counterparty3) = setup();
    for i in 0..10u8 {
        create_and_attest(
            &env3,
            &client3,
            &issuer3,
            &counterparty3,
            i,
            CommitmentStatus::Breached,
        );
    }
    create_and_attest(
        &env3,
        &client3,
        &issuer3,
        &counterparty3,
        99,
        CommitmentStatus::Fulfilled,
    );
    assert_eq!(client3.get_trust_score(&issuer3), 0);
}

#[test]
fn test_counterparty_without_history_scores_baseline() {
    let (env, client, issuer, counterparty) = setup();
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        1,
        CommitmentStatus::Fulfilled,
    );
    assert_eq!(client.get_trust_score(&issuer), 60);
    assert_eq!(client.get_trust_score(&counterparty), 50);
}
