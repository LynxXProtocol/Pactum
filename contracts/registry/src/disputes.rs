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

    // 2. Load commitment from persistent storage.
    let mut commitment: Commitment = env
        .storage()
        .persistent()
        .get(&DataKey::Commitment(id))
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

    // 6. Store old status, the disputed-from status, and the disputing party
    //    so that resolve_dispute can assess whether the dispute was justified.
    let old_status = commitment.status;
    commitment.disputed_from = Some(old_status as u32);
    commitment.disputed_by = Some(caller.clone());

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
/// * Authorized caller: `arbitrator` (via `require_auth`), which must exactly match
///   the designated arbitrator address stored at contract initialization.
/// * Why: Only the mutually trusted, designated arbitrator is authorized to adjudicate
///   and resolve contested commitments.
pub fn resolve_dispute(
    env: &Env,
    arbitrator: Address,
    id: u64,
    final_outcome: CommitmentStatus,
) {
    // 0. Enter the reentrancy guard before any external interaction (including
    //    the require_auth call below, which may invoke a custom account contract).
    crate::reentrancy::enter(env);

    // 1. Require authorization from the arbitrator.
    arbitrator.require_auth();

    // 2. Verify caller matches the stored arbitrator address exactly.
    let stored_arbitrator: Address = env
        .storage()
        .instance()
        .get(&DataKey::Arbitrator)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
    if arbitrator != stored_arbitrator {
        panic_with_error!(env, Error::NotArbitrator);
    }

    // 3. Reject Pending or Disputed as final_outcome. Must be Fulfilled, Late, or Breached.
    match final_outcome {
        CommitmentStatus::Fulfilled | CommitmentStatus::Late | CommitmentStatus::Breached => {}
        _ => panic_with_error!(env, Error::InvalidOutcome),
    }

    // 4. Load commitment from persistent storage.
    let mut commitment: Commitment = env
        .storage()
        .persistent()
        .get(&DataKey::Commitment(id))
        .unwrap_or_else(|| panic_with_error!(env, Error::CommitmentNotFound));

    // 5. Verify commitment is currently Disputed.
    if commitment.status != CommitmentStatus::Disputed {
        panic_with_error!(env, Error::InvalidTransition);
    }

    // 6. Determine whether the dispute was raised by the counterparty on a
    //    fairly-attested commitment: it is frivolous (ruled against the
    //    counterparty) when the final outcome matches the original attested
    //    status recorded when the dispute was raised.
    let dispute_raised_by_counterparty =
        commitment.disputed_by == Some(commitment.counterparty.clone());
    let dispute_upheld = commitment.disputed_from == Some(final_outcome as u32);

    // 7. Update status to final_outcome and clear attested_at to prevent re-dispute.
    commitment.status = final_outcome;
    commitment.attested_at = None;

    // 8. Save updated commitment to storage.
    env.storage()
        .persistent()
        .set(&DataKey::Commitment(id), &commitment);
    env.storage().persistent().extend_ttl(
        &DataKey::Commitment(id),
        crate::commitments::TTL_THRESHOLD_LEDGERS,
        crate::commitments::TTL_EXTEND_LEDGERS,
    );

    // 9. Update reputation (increment with final outcome).
    crate::reputation::update_reputation(env, commitment.issuer.clone(), final_outcome, true);

    // 10. Record a frivolous counterparty dispute when the arbitrator rules
    //     against the counterparty (final outcome matches the original
    //     attestation), giving counterparty-side disputes an on-chain cost.
    if dispute_raised_by_counterparty && dispute_upheld {
        crate::reputation::increment_counterparty_disputes_raised(
            env,
            commitment.counterparty.clone(),
        );
    }

    // 11. Update trust history (increment with final outcome).
    crate::trust_score::update_trust_history(env, commitment.issuer.clone(), final_outcome, true);

    // 12. Emit dispute_resolved event.
    events::dispute_resolved(env, id, final_outcome);

    // 13. Release the reentrancy guard.
    crate::reentrancy::exit(env);
}
