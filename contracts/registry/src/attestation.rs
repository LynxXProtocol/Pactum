//! Confirmation/oracle attestation logic

use crate::commitments::{Commitment, CommitmentStatus, DataKey};
use crate::errors::Error;
use crate::events;
use soroban_sdk::{panic_with_error, Address, Env};

/// Performs attestation on a commitment, resolving its status.
///
/// # Authorization
/// * Authorized caller: `caller` (via `require_auth`), which must be either the commitment's
///   `issuer` or `counterparty`.
/// * Why: Only the participating parties involved in the commitment are authorized to attest
///   to its outcome.
pub fn attest(env: &Env, caller: Address, id: u64, outcome: CommitmentStatus) {
    // 0. Enter the reentrancy guard before any external interaction (including
    //    the require_auth call below, which may invoke a custom account contract).
    crate::reentrancy::enter(env);

    // 1. Require authorization from the caller.
    caller.require_auth();

    // 2. Reject Pending or Disputed as an outcome value.
    if outcome == CommitmentStatus::Pending || outcome == CommitmentStatus::Disputed {
        panic_with_error!(env, Error::InvalidOutcome);
    }

    // 3. Load commitment from persistent storage (with legacy record migration).
    let mut commitment: Commitment = crate::commitments::get_commitment_record(env, id)
        .unwrap_or_else(|| panic_with_error!(env, Error::CommitmentNotFound));

    // 4. Verify caller is either issuer or counterparty.
    if caller != commitment.issuer && caller != commitment.counterparty {
        panic_with_error!(env, Error::Unauthorized);
    }

    // 5. Verify commitment is currently Pending.
    if commitment.status != CommitmentStatus::Pending {
        panic_with_error!(env, Error::AlreadyResolved);
    }

    // 6. Update status and attested_at timestamp.
    let now = env.ledger().timestamp();
    commitment.status = outcome;
    commitment.attested_at = Some(now);

    // 7. Save updated commitment to storage.
    env.storage()
        .persistent()
        .set(&DataKey::Commitment(id), &commitment);
    env.storage().persistent().extend_ttl(
        &DataKey::Commitment(id),
        crate::commitments::TTL_THRESHOLD_LEDGERS,
        crate::commitments::TTL_EXTEND_LEDGERS,
    );

    // 8. Update reputation (increment).
    crate::reputation::update_reputation(env, commitment.issuer.clone(), outcome, true);

    // 9. Update trust history (increment).
    crate::trust_score::update_trust_history(env, commitment.issuer.clone(), outcome, true);

    // 10. Emit commitment_attested event.
    events::commitment_attested(env, id, outcome);

    // 11. Release the reentrancy guard.
    crate::reentrancy::exit(env);
}

/// Returns true if the commitment is still Pending and current timestamp is past due_at.
pub fn is_overdue(env: &Env, id: u64) -> bool {
    let commitment: Commitment = crate::commitments::get_commitment_record(env, id)
        .unwrap_or_else(|| panic_with_error!(env, Error::CommitmentNotFound));

    commitment.status == CommitmentStatus::Pending && env.ledger().timestamp() > commitment.due_at
}
