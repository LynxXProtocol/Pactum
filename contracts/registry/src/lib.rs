#![no_std]

pub mod attestation;
pub mod commitments;
pub mod disputes;
pub mod errors;
pub mod events;
mod reentrancy;
pub mod reputation;
pub mod templates;
pub mod trust_gate;
pub mod trust_score;

#[cfg(test)]
mod test_trust_score;

#[cfg(test)]
mod test;

#[cfg(test)]
mod attacker_gate;

#[cfg(test)]
mod demo;

pub use commitments::{Commitment, CommitmentStatus, DataKey, DISPUTE_WINDOW_SECONDS};
pub use templates::refund::RefundEscrow;
use errors::Error;
use soroban_sdk::{contract, contractimpl, panic_with_error, Address, BytesN, Env};

/// The Pactum Registry contract for recording and tracking recurring commitments.
#[contract]
pub struct RegistryContract;

#[contractimpl]
impl RegistryContract {
    /// Initializes the contract with a designated arbitrator address.
    /// Can only be called once.
    ///
    /// # Authorization
    /// * Authorized caller: `arbitrator` (via `require_auth`).
    /// * Why: Requiring the designated arbitrator to authorize initialization ensures
    ///   that an address cannot be appointed as arbitrator without its explicit consent.
    ///
    /// # Panics
    /// * Panics with `Error::AlreadyInitialized` if called more than once.
    pub fn initialize(env: Env, arbitrator: Address) {
        if env.storage().instance().has(&DataKey::Arbitrator) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }

        // Enter the reentrancy guard before any external interaction (including
        // the require_auth call below, which may invoke a custom account contract).
        reentrancy::enter(&env);

        arbitrator.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::Arbitrator, &arbitrator);

        env.storage().instance().extend_ttl(
            commitments::TTL_THRESHOLD_LEDGERS,
            commitments::TTL_EXTEND_LEDGERS,
        );

        // Release the reentrancy guard.
        reentrancy::exit(&env);
    }

    /// Retrieves the designated arbitrator address.
    ///
    /// # Panics
    /// * Panics with `Error::NotInitialized` if the contract has not been initialized.
    pub fn get_arbitrator(env: Env) -> Address {
        let arbitrator = env
            .storage()
            .instance()
            .get(&DataKey::Arbitrator)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));

        env.storage().instance().extend_ttl(
            commitments::TTL_THRESHOLD_LEDGERS,
            commitments::TTL_EXTEND_LEDGERS,
        );

        arbitrator
    }

    /// Creates and registers a new ongoing commitment between an issuer and a counterparty.
    ///
    /// # Authorization
    /// * Authorized caller: `issuer` (via `require_auth`).
    /// * Why: Only the party issuing (promising) the commitment should be able to create
    ///   and bind themselves to a new commitment on-chain.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `issuer` - The address making the commitment. Must authorize the call.
    /// * `counterparty` - The address to whom the commitment is owed.
    /// * `terms_hash` - A 32-byte hash representing the off-chain terms of the commitment.
    /// * `due_at` - Unix timestamp (seconds) when the commitment is due. Must be in the future.
    /// * `resolver_address` - The address of the custom resolver delegated to resolve disputes for this commitment.
    ///
    /// # Returns
    /// * `u64` - The unique identifier assigned to the created commitment.
    ///
    /// # Panics
    /// * Panics with `Error::DueAtInPast` if `due_at` is less than or equal to the current ledger timestamp.
    pub fn create_commitment(
        env: Env,
        issuer: Address,
        counterparty: Address,
        terms_hash: BytesN<32>,
        due_at: u64,
        resolver_address: Address,
    ) -> u64 {
        // 0. Enter the reentrancy guard before any external interaction (including
        //    the require_auth call below, which may invoke a custom account contract).
        reentrancy::enter(&env);

        // 1. Require authorization from the issuer.
        issuer.require_auth();

        // 2. Create commitment record via shared helper.
        let id = commitments::create_commitment_record(
            &env,
            issuer,
            counterparty,
            terms_hash,
            due_at,
            resolver_address,
        );

        // 3. Release the reentrancy guard.
        reentrancy::exit(&env);

        id
    }

    /// Retrieves an existing commitment by its unique ID.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `id` - The unique identifier of the commitment to retrieve.
    ///
    /// # Returns
    /// * `Commitment` - The commitment details and status.
    ///
    /// # Panics
    /// * Panics with `Error::CommitmentNotFound` if the ID does not exist in storage.
    pub fn get_commitment(env: Env, id: u64) -> Commitment {
        let commitment = commitments::get_commitment_record(&env, id)
            .unwrap_or_else(|| panic_with_error!(&env, Error::CommitmentNotFound));

        env.storage().persistent().extend_ttl(
            &DataKey::Commitment(id),
            commitments::TTL_THRESHOLD_LEDGERS,
            commitments::TTL_EXTEND_LEDGERS,
        );

        commitment
    }

    /// Explicitly migrates a legacy commitment record to include resolver_address.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `id` - The unique identifier of the commitment to migrate.
    ///
    /// # Returns
    /// * `Commitment` - The migrated commitment.
    pub fn migrate_commitment(env: Env, id: u64) -> Commitment {
        Self::get_commitment(env, id)
    }

    /// Creates and registers a specialized Refund Guarantee commitment with locked token escrow.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `issuer` - The address making the commitment and locking funds in escrow. Must authorize.
    /// * `counterparty` - The beneficiary entitled to refund if breached.
    /// * `terms_hash` - 32-byte hash of the terms agreement.
    /// * `due_at` - Unix timestamp (seconds) when the commitment is due. Must be in future.
    /// * `resolver_address` - The designated custom resolver for dispute adjudication.
    /// * `token` - Token contract address to lock in escrow.
    /// * `amount` - Amount of tokens to lock in escrow (must be > 0).
    ///
    /// # Returns
    /// * `u64` - The unique identifier assigned to the created commitment.
    #[allow(clippy::too_many_arguments)]
    pub fn create_refund_commitment(
        env: Env,
        issuer: Address,
        counterparty: Address,
        terms_hash: BytesN<32>,
        due_at: u64,
        resolver_address: Address,
        token: Address,
        amount: i128,
    ) -> u64 {
        templates::refund::create_refund_commitment(
            &env,
            issuer,
            counterparty,
            terms_hash,
            due_at,
            resolver_address,
            token,
            amount,
        )
    }

    /// Retrieves the refund escrow configuration for a commitment, if one exists.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `commitment_id` - The commitment identifier.
    ///
    /// # Returns
    /// * `Option<RefundEscrow>` - The escrow details if present.
    pub fn get_refund_escrow(env: Env, commitment_id: u64) -> Option<RefundEscrow> {
        templates::refund::get_refund_escrow(&env, commitment_id)
    }

    /// Explicitly releases escrow funds for a resolved commitment if not already released.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `commitment_id` - The commitment identifier.
    pub fn release_refund(env: Env, commitment_id: u64) {
        templates::refund::release_refund(&env, commitment_id);
    }


    /// Attests to the lifecycle status of a commitment.
    ///
    /// # Authorization
    /// * Authorized caller: `caller` (via `require_auth`), which must be either the
    ///   commitment's `issuer` or `counterparty`.
    /// * Why: Only the participating parties involved in the commitment are authorized
    ///   to attest to its outcome.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `caller` - The address attesting to the commitment. Must authorize the call and be issuer or counterparty.
    /// * `id` - The unique identifier of the commitment to attest.
    /// * `outcome` - The new lifecycle status (`Fulfilled`, `Late`, or `Breached`).
    ///
    /// # Panics
    /// * Panics with `Error::CommitmentNotFound` if the commitment does not exist.
    /// * Panics with `Error::Unauthorized` if `caller` is neither `issuer` nor `counterparty`.
    /// * Panics with `Error::InvalidOutcome` if `outcome` is `CommitmentStatus::Pending` or `Disputed`.
    /// * Panics with `Error::AlreadyResolved` if the commitment is not currently `Pending`.
    pub fn attest(env: Env, caller: Address, id: u64, outcome: CommitmentStatus) {
        attestation::attest(&env, caller, id, outcome);
    }

    /// Checks whether a commitment is overdue.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `id` - The unique identifier of the commitment to check.
    ///
    /// # Returns
    /// * `bool` - True if the commitment is still `Pending` and the ledger timestamp is greater than `due_at`.
    ///
    /// # Panics
    /// * Panics with `Error::CommitmentNotFound` if the commitment does not exist.
    pub fn is_overdue(env: Env, id: u64) -> bool {
        attestation::is_overdue(&env, id)
    }

    /// Raises a dispute on an attested commitment within the dispute window.
    ///
    /// # Authorization
    /// * Authorized caller: `caller` (via `require_auth`), which must be either the
    ///   commitment's `issuer` or `counterparty`.
    /// * Why: Only the participating parties to the commitment have standing to contest
    ///   an attested outcome and initiate a dispute.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `caller` - The address initiating the dispute. Must authorize the call.
    /// * `id` - The unique identifier of the commitment to dispute.
    pub fn dispute(env: Env, caller: Address, id: u64) {
        disputes::dispute(&env, caller, id);
    }

    /// Resolves a disputed commitment to a final outcome.
    ///
    /// # Authorization
    /// * Authorized caller: `caller` (via `require_auth`), which must exactly match
    ///   the commitment's designated `resolver_address`.
    /// * Why: Dispute resolution authority is delegated strictly to the custom resolver
    ///   address chosen for this commitment at creation time.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `caller` - The designated resolver address resolving the dispute. Must authorize the call.
    /// * `id` - The unique identifier of the disputed commitment.
    /// * `final_outcome` - The resolution status (`Fulfilled`, `Late`, or `Breached`).
    pub fn resolve_dispute(
        env: Env,
        caller: Address,
        id: u64,
        final_outcome: CommitmentStatus,
    ) {
        disputes::resolve_dispute(&env, caller, id, final_outcome);
    }

    /// Retrieves the aggregate reputation for a given address.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `address` - The address to query.
    ///
    /// # Returns
    /// * `Reputation` - The accumulated fulfilled, late, and breached counts for the address as an issuer.
    pub fn get_reputation(env: Env, address: Address) -> reputation::Reputation {
        reputation::get_reputation(&env, address)
    }

    /// Retrieves the 0..=100 trust score for a given address as an issuer.
    ///
    /// The score weights recent outcomes more heavily than old ones via an
    /// integer, ledger-bucket-based decay curve (half-life of 64 buckets of
    /// 10,000 ledgers each, full decay after ~3.2 years). Outcomes are
    /// aggregated per bucket so this runs in O(1) storage reads.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `address` - The address to query.
    ///
    /// # Returns
    /// * `u32` - The trust score in the range 0..=100 (50 = neutral baseline).
    pub fn get_trust_score(env: Env, address: Address) -> u32 {
        trust_score::get_trust_score(&env, address)
    }
    /// Upgrades the contract to a new WASM binary.
    ///
    /// # Authorization
    /// * Authorized caller: `arbitrator` (via `require_auth`), which must exactly match
    ///   the designated arbitrator address stored at contract initialization.
    /// * Why: Only the designated arbitrator (admin) is authorized to upgrade the contract
    ///   to fix bugs or add features post-launch.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `arbitrator` - The designated arbitrator address initiating the upgrade. Must authorize the call.
    /// * `new_wasm_hash` - The 32-byte hash of the new WASM binary to deploy.
    ///
    /// # Panics
    /// * Panics with `Error::NotInitialized` if the contract has not been initialized.
    /// * Panics with `Error::NotArbitrator` if the caller is not the designated arbitrator.
    pub fn upgrade(env: Env, arbitrator: Address, new_wasm_hash: BytesN<32>) {
        // Verify the caller is the designated arbitrator
        let stored_arbitrator: Address = env
            .storage()
            .instance()
            .get(&DataKey::Arbitrator)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));

        if stored_arbitrator != arbitrator {
            panic_with_error!(&env, Error::NotArbitrator);
        }

        arbitrator.require_auth();

        // Upgrade the contract to the new WASM binary
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}
