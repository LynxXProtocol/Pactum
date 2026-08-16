//! Refund Guarantee Commitment Template
//!
//! Provides an escrow mechanism for marketplace transactions where an issuer locks funds in escrow.
//! If the commitment is fulfilled or late, funds are automatically returned to the issuer.
//! If the commitment is breached, funds are automatically forwarded to the counterparty as a refund.

use crate::commitments::{
    Commitment, CommitmentStatus, DataKey, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS,
};
use crate::errors::Error;
use crate::events;
use soroban_sdk::{contracttype, panic_with_error, token, Address, BytesN, Env};

/// Escrow record for a Refund Guarantee commitment.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefundEscrow {
    /// Unique identifier for the associated commitment.
    pub commitment_id: u64,
    /// The token address held in escrow.
    pub token: Address,
    /// The amount of tokens locked in escrow.
    pub amount: i128,
    /// Whether the escrowed tokens have already been released.
    pub is_released: bool,
}

/// Creates a new Refund Guarantee commitment and locks the specified token amount in escrow.
///
/// # Authorization
/// * Authorized caller: `issuer` (via `require_auth` in token transfer and commitment creation).
///
/// # Arguments
/// * `env` - The Soroban execution environment.
/// * `issuer` - The address offering the refund guarantee. Must authorize the token lock.
/// * `counterparty` - The beneficiary/buyer entitled to the refund upon breach.
/// * `terms_hash` - 32-byte hash of the terms agreement.
/// * `due_at` - Timestamp when the commitment is due.
/// * `resolver_address` - The designated custom resolver for dispute adjudication.
/// * `token` - The contract address of the token to lock in escrow.
/// * `amount` - The amount of tokens to lock. Must be greater than 0.
///
/// # Returns
/// * `u64` - The unique identifier of the created commitment.
#[allow(clippy::too_many_arguments)]
pub fn create_refund_commitment(
    env: &Env,
    issuer: Address,
    counterparty: Address,
    terms_hash: BytesN<32>,
    due_at: u64,
    resolver_address: Address,
    token: Address,
    amount: i128,
) -> u64 {
    // 0. Reentrancy guard
    crate::reentrancy::enter(env);

    // 1. Require authorization from the issuer on the root invocation
    issuer.require_auth();

    // 2. Validate escrow amount
    if amount <= 0 {
        panic_with_error!(env, Error::InvalidAmount);
    }

    // 3. Lock funds from the issuer into the registry contract escrow
    let contract_address = env.current_contract_address();
    let token_client = token::Client::new(env, &token);
    token_client.transfer(&issuer, &contract_address, &amount);

    // 4. Create base commitment record using shared internal helper
    let id = crate::commitments::create_commitment_record(
        env,
        issuer.clone(),
        counterparty,
        terms_hash,
        due_at,
        resolver_address,
    );

    // 5. Persist escrow state
    let escrow = RefundEscrow {
        commitment_id: id,
        token: token.clone(),
        amount,
        is_released: false,
    };

    env.storage()
        .persistent()
        .set(&DataKey::RefundEscrow(id), &escrow);
    env.storage().persistent().extend_ttl(
        &DataKey::RefundEscrow(id),
        TTL_THRESHOLD_LEDGERS,
        TTL_EXTEND_LEDGERS,
    );

    events::escrow_locked(env, id, &token, &issuer, amount);

    // 6. Release reentrancy guard
    crate::reentrancy::exit(env);

    id
}

/// Retrieves the refund escrow configuration for a commitment, if one exists.
pub fn get_refund_escrow(env: &Env, commitment_id: u64) -> Option<RefundEscrow> {
    let escrow: Option<RefundEscrow> = env
        .storage()
        .persistent()
        .get(&DataKey::RefundEscrow(commitment_id));

    if escrow.is_some() {
        env.storage().persistent().extend_ttl(
            &DataKey::RefundEscrow(commitment_id),
            TTL_THRESHOLD_LEDGERS,
            TTL_EXTEND_LEDGERS,
        );
    }

    escrow
}

/// Private helper to settle escrow tokens to the appropriate recipient and emit the release event.
fn settle_escrow(env: &Env, commitment: &Commitment, mut escrow: RefundEscrow) {
    let recipient = match commitment.status {
        CommitmentStatus::Fulfilled | CommitmentStatus::Late => commitment.issuer.clone(),
        CommitmentStatus::Breached => commitment.counterparty.clone(),
        _ => panic_with_error!(env, Error::CommitmentNotResolved),
    };

    escrow.is_released = true;
    env.storage()
        .persistent()
        .set(&DataKey::RefundEscrow(commitment.id), &escrow);

    let contract_address = env.current_contract_address();
    let token_client = token::Client::new(env, &escrow.token);
    token_client.transfer(&contract_address, &recipient, &escrow.amount);

    events::escrow_released(
        env,
        commitment.id,
        &recipient,
        escrow.amount,
        commitment.status,
    );
}

/// Processes automatic release of escrow funds when a commitment is resolved by a custom resolver.
///
/// Returns `true` if an escrow existed and was successfully settled, `false` otherwise.
pub fn process_refund_release(env: &Env, commitment: &Commitment) -> bool {
    let escrow = match get_refund_escrow(env, commitment.id) {
        Some(e) => e,
        None => return false,
    };

    if escrow.is_released {
        return false;
    }

    match commitment.status {
        CommitmentStatus::Fulfilled | CommitmentStatus::Late | CommitmentStatus::Breached => {}
        _ => return false,
    }

    settle_escrow(env, commitment, escrow);
    true
}

/// Explicitly releases escrow funds for a resolved commitment if not already released.
pub fn release_refund(env: &Env, commitment_id: u64) {
    crate::reentrancy::enter(env);

    let commitment = crate::commitments::get_commitment_record(env, commitment_id)
        .unwrap_or_else(|| panic_with_error!(env, Error::CommitmentNotFound));

    match commitment.status {
        CommitmentStatus::Fulfilled | CommitmentStatus::Late | CommitmentStatus::Breached => {}
        _ => panic_with_error!(env, Error::CommitmentNotResolved),
    }

    let attested_at = commitment
        .attested_at
        .unwrap_or_else(|| panic_with_error!(env, Error::CommitmentNotResolved));
    let now = env.ledger().timestamp();
    let deadline = attested_at.saturating_add(crate::commitments::DISPUTE_WINDOW_SECONDS);

    if now <= deadline {
        panic_with_error!(env, Error::DisputeWindowActive);
    }

    let escrow = get_refund_escrow(env, commitment_id)
        .unwrap_or_else(|| panic_with_error!(env, Error::EscrowNotFound));

    if escrow.is_released {
        panic_with_error!(env, Error::EscrowAlreadyReleased);
    }

    settle_escrow(env, &commitment, escrow);

    crate::reentrancy::exit(env);
}
