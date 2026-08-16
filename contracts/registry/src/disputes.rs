//! Dispute handling and resolution logic (Phase 3)

use crate::commitments::{Commitment, CommitmentStatus, DataKey, DISPUTE_WINDOW_SECONDS};
use crate::errors::Error;
use crate::events;
use soroban_sdk::{panic_with_error, Address, Env};

/// Raises a dispute on an attested commitment within the dispute window.
///
/// # Authorization
/// * Authorized caller: `caller` (via `require_auth`), which must be either the commitment's
///   `issuer` or `counterparty`.
/// * Why: Only the participating parties to the commitment have standing to contest
///   an attested outcome and initiate a dispute.
pub fn dispute(env: &Env, caller: Address, id: u64) {
    // 0. Enter the reentrancy guard before any external interaction (including
    //    the require_auth call below, which may invoke a custom account contract).
    crate::reentrancy::enter(env);

    // 1. Require authorization from the caller.
    caller.require_auth();

    // 2. Load commitment from persistent storage (with legacy record migration).
    let mut commitment: Commitment = crate::commitments::get_commitment_record(env, id)
        .unwrap_or_else(|| panic_with_error!(env, Error::CommitmentNotFound));

    // 3. Verify caller is either issuer or counterparty.
    if caller != commitment.issuer && caller != commitment.counterparty {
        panic_with_error!(env, Error::Unauthorized);
    }

    // 4. Verify commitment is currently Fulfilled, Late, or Breached (i.e. already attested).
    match commitment.status {
        CommitmentStatus::Fulfilled | CommitmentStatus::Late | CommitmentStatus::Breached => {}
        _ => panic_with_error!(env, Error::InvalidTransition),
    }

    // 5. Verify the dispute is raised within the dispute window.
    let attested_at = commitment
        .attested_at
        .unwrap_or_else(|| panic_with_error!(env, Error::InvalidTransition));
    let now = env.ledger().timestamp();
    let deadline = attested_at.saturating_add(DISPUTE_WINDOW_SECONDS);

    if now > deadline {
        panic_with_error!(env, Error::DisputeWindowExpired);
    }

    // 6. Store old status for reputation adjustment.
    let old_status = commitment.status;

    // 7. Transition status to Disputed.
    commitment.status = CommitmentStatus::Disputed;

    // 8. Save updated commitment to storage.
    env.storage()
        .persistent()
        .set(&DataKey::Commitment(id), &commitment);
    env.storage().persistent().extend_ttl(
        &DataKey::Commitment(id),
        crate::commitments::TTL_THRESHOLD_LEDGERS,
        crate::commitments::TTL_EXTEND_LEDGERS,
    );

    // 9. Update reputation (decrement previous outcome).
    crate::reputation::update_reputation(env, commitment.issuer.clone(), old_status, false);

    // 10. Update trust history (decrement previous outcome).
    crate::trust_score::update_trust_history(env, commitment.issuer.clone(), old_status, false);

    // 11. Emit commitment_disputed event.
    events::commitment_disputed(env, id);

    // 12. Release the reentrancy guard.
    crate::reentrancy::exit(env);
}

/// Resolves a disputed commitment to a final outcome.
///
/// # Authorization
/// * Authorized caller: `caller` (via `require_auth`), which must exactly match
///   the commitment's designated `resolver_address`.
/// * Why: Dispute resolution authority is delegated strictly to the custom resolver
///   address chosen for this commitment at creation time.
pub fn resolve_dispute(
    env: &Env,
    caller: Address,
    id: u64,
    final_outcome: CommitmentStatus,
) {
    // 0. Enter the reentrancy guard before any external interaction (including
    //    the require_auth call below, which may invoke a custom account contract).
    crate::reentrancy::enter(env);

    // 1. Require authorization from the caller.
    caller.require_auth();

    // 2. Reject Pending or Disputed as final_outcome. Must be Fulfilled, Late, or Breached.
    match final_outcome {
        CommitmentStatus::Fulfilled | CommitmentStatus::Late | CommitmentStatus::Breached => {}
        _ => panic_with_error!(env, Error::InvalidOutcome),
    }

    // 3. Load commitment from persistent storage (with legacy record migration).
    let mut commitment: Commitment = crate::commitments::get_commitment_record(env, id)
        .unwrap_or_else(|| panic_with_error!(env, Error::CommitmentNotFound));

    // 4. Verify caller matches the commitment's designated resolver_address exactly.
    if caller != commitment.resolver_address {
        panic_with_error!(env, Error::NotArbitrator);
    }

    // 5. Verify commitment is currently Disputed.
    if commitment.status != CommitmentStatus::Disputed {
        panic_with_error!(env, Error::InvalidTransition);
    }

    // 6. Update status to final_outcome and clear attested_at to prevent re-dispute.
    commitment.status = final_outcome;
    commitment.attested_at = None;

    // 7. Save updated commitment to storage.
    env.storage()
        .persistent()
        .set(&DataKey::Commitment(id), &commitment);
    env.storage().persistent().extend_ttl(
        &DataKey::Commitment(id),
        crate::commitments::TTL_THRESHOLD_LEDGERS,
        crate::commitments::TTL_EXTEND_LEDGERS,
    );

    // 8. Update reputation (increment with final outcome).
    crate::reputation::update_reputation(env, commitment.issuer.clone(), final_outcome, true);

    // 9. Update trust history (increment with final outcome).
    crate::trust_score::update_trust_history(env, commitment.issuer.clone(), final_outcome, true);

    // 10. Emit dispute_resolved event.
    events::dispute_resolved(env, id, final_outcome);

    // 11. Automatically process escrow refund release if this is a Refund Guarantee commitment.
    crate::templates::refund::process_refund_release(env, &commitment);

    // 12. Release the reentrancy guard.
    crate::reentrancy::exit(env);
}
