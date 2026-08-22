//! M-of-N attestor voting (Issue 86, Phase 2).
//!
//! A commitment configured with an attestor panel and a vote threshold settles
//! disputes by panel vote instead of single-resolver fiat. Every panel member
//! has staked funds at risk: while the dispute is active their stake is
//! locked, and when the dispute resolves to an outcome they voted against,
//! 10% of their stake is slashed (the forfeited amount stays in the vault).
//! If the voting window elapses without the threshold being met, the dispute
//! falls back to `Breached` and the panel is released.

use crate::commitments::{
    get_commitment_record, Commitment, CommitmentStatus, DataKey, TTL_EXTEND_LEDGERS,
    TTL_THRESHOLD_LEDGERS,
};
use crate::errors::Error;
use crate::events;
use soroban_sdk::{contracttype, panic_with_error, Address, Env};

/// The window in seconds during which panel attestors may cast votes on a
/// disputed commitment (7 days = 604,800 seconds). Anchored at the
/// attestation timestamp that preceded the dispute.
pub const ATTESTOR_VOTE_TIMEOUT_SECONDS: u64 = 7 * 24 * 60 * 60;

/// Slash rate for dissenting panel voters. Sourced from `economics` so the
/// Issue #192 formal proofs discharge the same constant the contract uses.
pub const SLASH_PERCENT: u64 = crate::economics::SLASH_PERCENT_OF_STAKE;

/// The running tally of votes cast on a disputed commitment.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteTally {
    /// Votes for `Fulfilled`.
    pub fulfilled: u32,
    /// Votes for `Late`.
    pub late: u32,
    /// Votes for `Breached`.
    pub breached: u32,
}

/// Loads the vote tally for a disputed commitment, defaulting to zeroes.
fn load_tally(env: &Env, id: u64) -> VoteTally {
    env.storage()
        .persistent()
        .get(&DataKey::DisputeTally(id))
        .unwrap_or(VoteTally {
            fulfilled: 0,
            late: 0,
            breached: 0,
        })
}

/// Persists the vote tally and extends its TTL.
fn save_tally(env: &Env, id: u64, tally: &VoteTally) {
    env.storage()
        .persistent()
        .set(&DataKey::DisputeTally(id), tally);
    env.storage().persistent().extend_ttl(
        &DataKey::DisputeTally(id),
        TTL_THRESHOLD_LEDGERS,
        TTL_EXTEND_LEDGERS,
    );
}

/// Persists a single attestor's vote and extends its TTL.
fn save_vote(env: &Env, id: u64, attestor: &Address, outcome: CommitmentStatus) {
    env.storage()
        .persistent()
        .set(&DataKey::VoteRecord(id, attestor.clone()), &outcome);
    env.storage().persistent().extend_ttl(
        &DataKey::VoteRecord(id, attestor.clone()),
        TTL_THRESHOLD_LEDGERS,
        TTL_EXTEND_LEDGERS,
    );
}

/// Writes the final outcome onto the commitment, clears `attested_at` to
/// prevent re-dispute, and updates reputation and trust history to match.
fn persist_outcome(env: &Env, id: u64, commitment: &mut Commitment, outcome: CommitmentStatus) {
    commitment.status = outcome;
    commitment.attested_at = None;
    env.storage()
        .persistent()
        .set(&DataKey::Commitment(id), commitment);
    env.storage().persistent().extend_ttl(
        &DataKey::Commitment(id),
        TTL_THRESHOLD_LEDGERS,
        TTL_EXTEND_LEDGERS,
    );
    crate::reputation::update_reputation(env, commitment.issuer.clone(), outcome, true);
    crate::trust_score::update_trust_history(env, commitment.issuer.clone(), outcome, true);
}

/// Releases every panel attestor's stake lock and clears the vote ledger for
/// the commitment. When `slash_dissenters` is set, attestors who voted for an
/// outcome other than `winning` are slashed `SLASH_PERCENT` of their stake
/// first.
fn unlock_panel_and_clear(
    env: &Env,
    id: u64,
    commitment: &Commitment,
    slash_dissenters: bool,
    winning: CommitmentStatus,
) {
    for attestor in commitment.attestors.iter() {
        let voted: Option<CommitmentStatus> = env
            .storage()
            .persistent()
            .get(&DataKey::VoteRecord(id, attestor.clone()));
        let cast_a_vote = voted.is_some();
        let voted_with_winner = matches!(voted, Some(v) if v == winning);
        if crate::economics::should_slash_attestor(slash_dissenters, cast_a_vote, voted_with_winner)
            == crate::economics::SlashDecision::Slash
        {
            crate::staking::slash(env, &attestor, SLASH_PERCENT);
        }
        crate::staking::set_locked(env, &attestor, false);
        env.storage()
            .persistent()
            .remove(&DataKey::VoteRecord(id, attestor));
    }
    env.storage()
        .persistent()
        .remove(&DataKey::DisputeTally(id));
}

/// Casts a single attestor's vote on a disputed commitment.
///
/// # Authorization
/// * Authorized caller: `attestor` (via `require_auth`), a member of the
///   commitment's voting panel who holds staked funds locked by the dispute.
/// * Why: Panel membership plus at-stake funds give attestors skin in the
///   game; their stake is slashed if they vote for a losing outcome.
///
/// # Panics
/// * Panics with `Error::CommitmentNotFound` if no commitment has the given ID.
/// * Panics with `Error::InvalidTransition` if the commitment is not `Disputed`
///   or has no voting panel configured.
/// * Panics with `Error::VotingClosed` if the voting window has elapsed.
/// * Panics with `Error::NotAttestor` if the caller is not on the panel.
/// * Panics with `Error::InsufficientStake` if the caller holds no stake.
/// * Panics with `Error::DisputeActive` if the caller's stake is not locked.
/// * Panics with `Error::AttestorAlreadyVoted` if the caller already voted.
/// * Panics with `Error::InvalidOutcome` if `outcome` is not a final status.
pub fn cast_dispute_vote(env: &Env, attestor: Address, id: u64, outcome: CommitmentStatus) {
    // 0. Enter the reentrancy guard before any external interaction (including
    //    the require_auth call below, which may invoke a custom account contract).
    crate::reentrancy::enter(env);

    // 1. Require authorization from the attestor.
    attestor.require_auth();

    // 2. Load commitment from persistent storage (with legacy record migration).
    let mut commitment: Commitment = get_commitment_record(env, id)
        .unwrap_or_else(|| panic_with_error!(env, Error::CommitmentNotFound));

    // 3. Only a disputed, panel-governed commitment is votable.
    if commitment.status != CommitmentStatus::Disputed {
        panic_with_error!(env, Error::InvalidTransition);
    }
    if commitment.vote_threshold() == 0 {
        panic_with_error!(env, Error::InvalidTransition);
    }

    // 4. The vote must be one of the final outcomes.
    match outcome {
        CommitmentStatus::Fulfilled | CommitmentStatus::Late | CommitmentStatus::Breached => {}
        _ => panic_with_error!(env, Error::InvalidOutcome),
    }

    // 5. Reject votes cast after the window closes.
    let now = env.ledger().timestamp();
    let attested_at = commitment.attested_at.unwrap_or(commitment.created_at);
    let deadline = attested_at.saturating_add(ATTESTOR_VOTE_TIMEOUT_SECONDS);
    if now > deadline {
        panic_with_error!(env, Error::VotingClosed);
    }

    // 6. The caller must be on the panel, staked, and locked by the dispute.
    if !commitment.attestors.contains(attestor.clone()) {
        panic_with_error!(env, Error::NotAttestor);
    }
    let stake = crate::staking::load_stake(env, &attestor);
    if stake.staked <= 0 {
        panic_with_error!(env, Error::InsufficientStake);
    }
    if !stake.locked {
        panic_with_error!(env, Error::DisputeActive);
    }

    // 7. One vote per attestor per dispute.
    if env
        .storage()
        .persistent()
        .has(&DataKey::VoteRecord(id, attestor.clone()))
    {
        panic_with_error!(env, Error::AttestorAlreadyVoted);
    }

    // 8. Record the vote and update the tally.
    let mut tally = load_tally(env, id);
    let votes = match outcome {
        CommitmentStatus::Fulfilled => {
            tally.fulfilled += 1;
            tally.fulfilled
        }
        CommitmentStatus::Late => {
            tally.late += 1;
            tally.late
        }
        CommitmentStatus::Breached => {
            tally.breached += 1;
            tally.breached
        }
        _ => unreachable!(),
    };
    save_tally(env, id, &tally);
    save_vote(env, id, &attestor, outcome);
    events::attestor_vote_cast(env, id, &attestor, outcome);

    // 9. The first outcome to reach the threshold wins: resolve the dispute,
    //    unlock the panel, and slash dissenting voters.
    if votes >= commitment.vote_threshold() {
        persist_outcome(env, id, &mut commitment, outcome);
        unlock_panel_and_clear(env, id, &commitment, true, outcome);
        events::commitment_resolved(env, id, outcome);
    }

    // 10. Release the reentrancy guard.
    crate::reentrancy::exit(env);
}

/// Finalizes a disputed commitment whose voting window elapsed without the
/// threshold being reached. The commitment falls back to `Breached`, the
/// panel's stakes are unlocked, and the vote ledger is cleared. Permissionless:
/// anyone may finalize an expired dispute.
///
/// # Panics
/// * Panics with `Error::CommitmentNotFound` if no commitment has the given ID.
/// * Panics with `Error::InvalidTransition` if the commitment is not `Disputed`
///   or has no voting panel configured.
/// * Panics with `Error::VotesNotMet` if the voting window has not elapsed yet.
pub fn check_dispute_timeout(env: &Env, id: u64) {
    // 0. Enter the reentrancy guard; this function mutates state.
    crate::reentrancy::enter(env);

    // 1. Load commitment from persistent storage (with legacy record migration).
    let mut commitment: Commitment = get_commitment_record(env, id)
        .unwrap_or_else(|| panic_with_error!(env, Error::CommitmentNotFound));

    // 2. Only a disputed, panel-governed commitment can time out.
    if commitment.status != CommitmentStatus::Disputed {
        panic_with_error!(env, Error::InvalidTransition);
    }
    if commitment.vote_threshold() == 0 {
        panic_with_error!(env, Error::InvalidTransition);
    }

    // 3. The window must have fully elapsed; otherwise the threshold may
    //    still be reached.
    let now = env.ledger().timestamp();
    let attested_at = commitment.attested_at.unwrap_or(commitment.created_at);
    let deadline = attested_at.saturating_add(ATTESTOR_VOTE_TIMEOUT_SECONDS);
    if now <= deadline {
        panic_with_error!(env, Error::VotesNotMet);
    }

    // 4. Fall back to Breached, release the panel, and clear the vote ledger.
    persist_outcome(env, id, &mut commitment, CommitmentStatus::Breached);
    unlock_panel_and_clear(env, id, &commitment, false, CommitmentStatus::Breached);
    events::commitment_fallback(env, id, CommitmentStatus::Breached);

    // 5. Release the reentrancy guard.
    crate::reentrancy::exit(env);
}
