#![no_std]
// The Soroban contract client generator mirrors every entrypoint argument onto
// the generated client methods; wide entrypoints (e.g. `create_commitment` with
// its attestor panel) would otherwise trip clippy's arg-count lint.
#![allow(clippy::too_many_arguments)]

pub mod attestation;
pub mod commitments;
pub mod disputes;
pub mod errors;
pub mod events;
pub mod fee_oracle;
mod pausable;
mod reentrancy;
pub mod reputation;
pub mod rollup;
pub mod staking;
pub mod trust_gate;
pub mod trust_score;
pub mod upgrade;
pub mod voting;

#[cfg(test)]
mod test_trust_score;

#[cfg(test)]
mod test_archival;

#[cfg(test)]
mod test;

#[cfg(test)]
mod test_staking;

#[cfg(test)]
mod test_upgrade;

#[cfg(test)]
mod attacker_gate;

#[cfg(test)]
mod demo;

#[cfg(test)]
mod test_voting;

pub use commitments::{Commitment, CommitmentStatus, DataKey, DISPUTE_WINDOW_SECONDS};
use errors::Error;
use soroban_sdk::{contract, contractimpl, panic_with_error, Address, BytesN, Env, Vec};
pub use rollup::{BatchRootRecord, ForcedInclusionRecord, MerkleNode};
pub use staking::AttestorStake;
pub use upgrade::{SCHEMA_VERSION_V1, SCHEMA_VERSION_V2};
pub use voting::VoteTally;

/// The Pactum Registry contract for recording and tracking recurring commitments.
#[contract]
pub struct RegistryContract;

#[contractimpl]
#[allow(clippy::too_many_arguments)]
impl RegistryContract {
    /// Initializes the contract with a committee of designated arbitrators.
    /// Can only be called once.
    ///
    /// Disputes on commitments that delegate to the committee are settled by a
    /// majority vote of this set rather than by a single point of trust.
    ///
    /// # Authorization
    /// * Authorized caller: every address in `arbitrators` (via `require_auth`).
    /// * Why: Requiring each designated arbitrator to authorize initialization
    ///   ensures that no address can be appointed to the committee without its
    ///   explicit consent.
    ///
    /// # Panics
    /// * Panics with `Error::AlreadyInitialized` if called more than once.
    /// * Panics with `Error::EmptyArbitratorSet` if `arbitrators` is empty.
    pub fn initialize(env: Env, arbitrators: Vec<Address>) {
        // A legacy single-arbitrator deployment recorded a bare Address under
        // DataKey::Arbitrator; either key means the contract is already live.
        if env.storage().instance().has(&DataKey::ArbitratorSet)
            || env.storage().instance().has(&DataKey::Arbitrator)
        {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }

        if arbitrators.is_empty() {
            panic_with_error!(&env, Error::EmptyArbitratorSet);
        }

        // Enter the reentrancy guard before any external interaction (including
        // the require_auth call below, which may invoke a custom account contract).
        reentrancy::enter(&env);

        // Deduplicate first (so no address authorizes twice in the same
        // invocation) and require every distinct arbitrator to consent to their
        // appointment. Deduplicating also keeps the majority threshold computed
        // over distinct members.
        let mut deduped = Vec::new(&env);
        for a in arbitrators.iter() {
            if !deduped.contains(&a) {
                deduped.push_back(a.clone());
            }
        }
        for a in deduped.iter() {
            a.require_auth();
        }
        env.storage()
            .instance()
            .set(&DataKey::ArbitratorSet, &deduped);

        env.storage().instance().extend_ttl(
            commitments::TTL_THRESHOLD_LEDGERS,
            commitments::TTL_EXTEND_LEDGERS,
        );

        // Release the reentrancy guard.
        reentrancy::exit(&env);
    }

    /// Retrieves the full set of designated arbitrators.
    ///
    /// # Panics
    /// * Panics with `Error::NotInitialized` if the contract has not been initialized.
    pub fn get_arbitrators(env: Env) -> Vec<Address> {
        let arbitrators = commitments::arbitrators(&env);

        env.storage().instance().extend_ttl(
            commitments::TTL_THRESHOLD_LEDGERS,
            commitments::TTL_EXTEND_LEDGERS,
        );

        arbitrators
    }

    /// Retrieves the first designated arbitrator.
    ///
    /// Kept for backwards compatibility with the original single-arbitrator
    /// interface; prefer [`RegistryContract::get_arbitrators`] for the full set.
    ///
    /// # Panics
    /// * Panics with `Error::NotInitialized` if the contract has not been initialized.
    pub fn get_arbitrator(env: Env) -> Address {
        let arbitrators = commitments::arbitrators(&env);

        env.storage().instance().extend_ttl(
            commitments::TTL_THRESHOLD_LEDGERS,
            commitments::TTL_EXTEND_LEDGERS,
        );

        arbitrators
            .first()
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
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
    /// * `attestors` - The panel of staked attestors that votes on disputes for
    ///   this commitment. Pass an empty vector to keep the single-resolver path.
    /// * `vote_threshold` - How many matching attestor votes are required to
    ///   resolve a dispute. Must be between 1 and `attestors.len()` when a panel
    ///   is configured, and zero when it is not.
    ///
    /// # Returns
    /// * `u64` - The unique identifier assigned to the created commitment.
    ///
    /// # Panics
    /// * Panics with `Error::DueAtInPast` if `due_at` is less than or equal to the current ledger timestamp.
    /// * Panics with `Error::ThresholdInvalid` if a threshold is set without a
    ///   panel, a panel is set without a threshold, or the threshold exceeds the
    ///   panel size.
    pub fn create_commitment(
        env: Env,
        issuer: Address,
        counterparty: Address,
        terms_hash: BytesN<32>,
        due_at: u64,
        resolver_address: Address,
        oracle: Option<Address>,
        schema_id: Option<u32>,
        attestors: Vec<Address>,
        vote_threshold: u32,
    ) -> u64 {
        // Fail fast if the protocol has been paused (emergency halt).
        pausable::require_not_paused(&env);

        commitments::create(
            &env,
            issuer,
            counterparty,
            terms_hash,
            due_at,
            resolver_address,
            1,
            oracle,
            schema_id,
            attestors,
            vote_threshold,
        )
    }

    /// Creates a commitment that is fulfilled across `milestone_count` partial
    /// attestations rather than a single one.
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
    /// * `resolver_address` - The address of the custom resolver delegated to resolve disputes.
    /// * `milestone_count` - How many milestones the commitment is split into.
    /// * `oracle` - Optional designated oracle for automated attestation.
    /// * `schema_id` - Optional identifier for the schema used to generate terms_hash.
    /// * `attestors` - The panel of staked attestors that votes on disputes for
    ///   this commitment. Pass an empty vector to keep the single-resolver path.
    /// * `vote_threshold` - How many matching attestor votes are required to
    ///   resolve a dispute. Must be between 1 and `attestors.len()` when a panel
    ///   is configured, and zero when it is not.
    ///
    /// # Returns
    /// * `u64` - The unique identifier assigned to the created commitment.
    ///
    /// # Panics
    /// * Panics with `Error::DueAtInPast` if `due_at` is less than or equal to the current ledger timestamp.
    /// * Panics with `Error::InvalidMilestoneCount` if `milestone_count` is zero or above
    ///   `commitments::MAX_MILESTONES`.
    /// * Panics with `Error::ThresholdInvalid` if a threshold is set without a
    ///   panel, a panel is set without a threshold, or the threshold exceeds the
    ///   panel size.
    pub fn create_milestone_commitment(
        env: Env,
        issuer: Address,
        counterparty: Address,
        terms_hash: BytesN<32>,
        due_at: u64,
        resolver_address: Address,
        milestone_count: u32,
        oracle: Option<Address>,
        schema_id: Option<u32>,
        attestors: Vec<Address>,
        vote_threshold: u32,
    ) -> u64 {
        // Fail fast if the protocol has been paused (emergency halt).
        pausable::require_not_paused(&env);

        commitments::create(
            &env,
            issuer,
            counterparty,
            terms_hash,
            due_at,
            resolver_address,
            milestone_count,
            oracle,
            schema_id,
            attestors,
            vote_threshold,
        )
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
        // Fail fast if the protocol has been paused (emergency halt).
        pausable::require_not_paused(&env);

        attestation::attest(&env, caller, id, outcome);
    }

    /// Attests a single milestone of a commitment.
    ///
    /// The commitment as a whole stays `Pending` until the final milestone is
    /// attested, at which point it becomes `Fulfilled`, or `Late` if any
    /// milestone came in late. A `Breached` milestone resolves the whole
    /// commitment as `Breached` immediately.
    ///
    /// # Authorization
    /// * Authorized caller: `caller` (via `require_auth`), which must be either the
    ///   commitment's `issuer` or `counterparty`.
    /// * Why: Only the participating parties involved in the commitment are authorized
    ///   to attest to its outcome.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `caller` - The address attesting to the milestone. Must authorize the call and be issuer or counterparty.
    /// * `id` - The unique identifier of the commitment to attest.
    /// * `milestone_index` - Zero-based index of the milestone. Milestones are attested in order.
    /// * `outcome` - The milestone status (`Fulfilled`, `Late`, or `Breached`).
    ///
    /// # Panics
    /// * Panics with `Error::CommitmentNotFound` if the commitment does not exist.
    /// * Panics with `Error::Unauthorized` if `caller` is neither `issuer` nor `counterparty`.
    /// * Panics with `Error::InvalidOutcome` if `outcome` is `CommitmentStatus::Pending` or `Disputed`.
    /// * Panics with `Error::AlreadyResolved` if the commitment is not currently `Pending`.
    /// * Panics with `Error::InvalidMilestoneIndex` if `milestone_index` is outside the commitment's range.
    /// * Panics with `Error::MilestoneAlreadyAttested` if that milestone was already attested.
    /// * Panics with `Error::MilestoneOutOfOrder` if an earlier milestone is still pending.
    pub fn attest_milestone(
        env: Env,
        caller: Address,
        id: u64,
        milestone_index: u32,
        outcome: CommitmentStatus,
    ) {
        // Fail fast if the protocol has been paused (emergency halt).
        pausable::require_not_paused(&env);

        attestation::attest_milestone(&env, caller, id, milestone_index, outcome);
    }

    /// Retrieves the attested outcome of a single milestone.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `id` - The unique identifier of the commitment.
    /// * `milestone_index` - Zero-based index of the milestone.
    ///
    /// # Returns
    /// * `Option<CommitmentStatus>` - The milestone's outcome, or `None` while it is pending.
    ///
    /// # Panics
    /// * Panics with `Error::CommitmentNotFound` if the commitment does not exist.
    /// * Panics with `Error::InvalidMilestoneIndex` if `milestone_index` is outside the commitment's range.
    pub fn get_milestone(env: Env, id: u64, milestone_index: u32) -> Option<CommitmentStatus> {
        attestation::get_milestone(&env, id, milestone_index)
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
        // Fail fast if the protocol has been paused (emergency halt).
        pausable::require_not_paused(&env);

        disputes::dispute(&env, caller, id);
    }

    /// Resolves a disputed commitment to a final outcome.
    ///
    /// A commitment whose `resolver_address` is a custom resolver outside the
    /// arbitrator committee is settled directly by that resolver. A commitment
    /// that names an arbitrator as its resolver is settled by majority vote of
    /// the committee: each call records the calling arbitrator's vote and the
    /// dispute only finalizes once the votes for an outcome exceed half the
    /// committee size.
    ///
    /// # Authorization
    /// * Authorized caller: `caller` (via `require_auth`), which must either be the
    ///   commitment's designated custom `resolver_address`, or a member of the
    ///   arbitrator committee for a committee-routed commitment.
    /// * Why: Dispute resolution authority is delegated either to the resolver
    ///   chosen at creation time, or to a majority of the mutually trusted
    ///   arbitrators — never a single point of trust.
    ///
    /// # Arguments
    /// * `env` - The Soroban execution environment.
    /// * `caller` - The resolver or arbitrator casting the vote/resolution. Must authorize the call.
    /// * `id` - The unique identifier of the disputed commitment.
    /// * `final_outcome` - The resolution status (`Fulfilled`, `Late`, or `Breached`).
    pub fn resolve_dispute(env: Env, caller: Address, id: u64, final_outcome: CommitmentStatus) {
        pausable::require_not_paused(&env);
        disputes::resolve_dispute(&env, caller, id, final_outcome);
    }

    /// Casts a single attestor's vote on a disputed, panel-governed commitment.
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
    pub fn cast_dispute_vote(env: Env, attestor: Address, id: u64, outcome: CommitmentStatus) {
        voting::cast_dispute_vote(&env, attestor, id, outcome);
    }

    /// Finalizes a disputed commitment whose attestor voting window elapsed
    /// without the threshold being reached. The commitment falls back to
    /// `Breached` and the panel's stakes are unlocked. Permissionless: anyone
    /// may finalize an expired dispute.
    ///
    /// # Panics
    /// * Panics with `Error::CommitmentNotFound` if no commitment has the given ID.
    /// * Panics with `Error::InvalidTransition` if the commitment is not `Disputed`
    ///   or has no voting panel configured.
    /// * Panics with `Error::VotesNotMet` if the voting window has not elapsed yet.
    pub fn check_dispute_timeout(env: Env, id: u64) {
        voting::check_dispute_timeout(&env, id);
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

    /// Returns whether the protocol is currently paused (emergency halt).
    ///
    /// Read functions remain fully operational while paused; only
    /// state-mutating entry points are halted.
    ///
    /// # Returns
    /// * `bool` - `true` if the protocol is currently paused.
    pub fn is_paused(env: Env) -> bool {
        pausable::is_paused(&env)
    }

    /// Pauses the protocol, halting every state-mutating entry point with
    /// `Error::ProtocolPaused` while leaving reads fully operational.
    ///
    /// This is the emergency kill-switch used in the event of a zero-day
    /// exploit. Admin lifecycle operations (`pause`, `unpause`, `upgrade`)
    /// are deliberately exempt so the admin can end the halt or deploy an
    /// emergency patch while the protocol is paused.
    ///
    /// # Authorization
    /// * Authorized caller: `admin` (via `require_auth`), a current member of
    ///   the designated arbitrator committee.
    /// * Why: Only the mutually trusted committee is authorized to trigger the
    ///   emergency halt.
    ///
    /// # Panics
    /// * Panics with `Error::NotInitialized` if the contract has not been initialized.
    /// * Panics with `Error::NotArbitrator` if `admin` is not on the committee.
    pub fn pause(env: Env, admin: Address) {
        // Enter the reentrancy guard before any external interaction (including
        // the require_auth call below, which may invoke a custom account contract).
        reentrancy::enter(&env);

        admin.require_auth();

        let committee = commitments::arbitrators(&env);
        if !committee.contains(admin.clone()) {
            panic_with_error!(&env, Error::NotArbitrator);
        }

        pausable::set_paused(&env, true);
        events::protocol_paused(&env);

        // Release the reentrancy guard.
        reentrancy::exit(&env);
    }

    /// Unpauses the protocol, restoring its state-mutating entry points.
    ///
    /// # Authorization
    /// * Authorized caller: `admin` (via `require_auth`), a current member of
    ///   the designated arbitrator committee.
    /// * Why: Only the mutually trusted committee is authorized to end the halt.
    ///
    /// # Panics
    /// * Panics with `Error::NotInitialized` if the contract has not been initialized.
    /// * Panics with `Error::NotArbitrator` if `admin` is not on the committee.
    pub fn unpause(env: Env, admin: Address) {
        // Enter the reentrancy guard before any external interaction (including
        // the require_auth call below, which may invoke a custom account contract).
        reentrancy::enter(&env);

        admin.require_auth();

        let committee = commitments::arbitrators(&env);
        if !committee.contains(admin.clone()) {
            panic_with_error!(&env, Error::NotArbitrator);
        }

        pausable::set_paused(&env, false);
        events::protocol_unpaused(&env);

        // Release the reentrancy guard.
        reentrancy::exit(&env);
    }

    // ---------------------------------------------------------------------
    // Upgradeability and governance
    //
    // Soroban upgrades a contract by replacing its executable in place; the
    // contract ID and all persistent storage survive. There is therefore no proxy
    // contract in this design — see `upgrade.rs` and `docs/upgradeability.md` for
    // why the EVM proxy/implementation split is neither available nor needed here.
    // ---------------------------------------------------------------------

    /// Retrieves the reputation storage schema version currently in force.
    ///
    /// Returns [`SCHEMA_VERSION_V1`] for a contract that has never been upgraded.
    pub fn schema_version(env: Env) -> u32 {
        upgrade::schema_version(&env)
    }

    /// Retrieves the address permitted to upgrade this contract, if one is installed.
    pub fn get_upgrade_admin(env: Env) -> Option<Address> {
        upgrade::upgrade_admin(&env)
    }

    /// Installs the initial upgrade admin — in production, the Timelock contract.
    ///
    /// # Authorization
    /// * Authorized caller: the `arbitrators` recorded by `initialize` (via `require_auth`).
    /// * Why: at bootstrap no upgrade admin exists yet to authorize its own creation,
    ///   and the arbitrator committee is the only authority the contract already trusts. The path
    ///   closes permanently once used; later changes go through `set_upgrade_admin`,
    ///   which only the timelock can call.
    ///
    /// # Panics
    /// * Panics with `Error::NotInitialized` if the contract has not been initialized.
    /// * Panics with `Error::UpgradeAdminAlreadySet` if an upgrade admin is installed.
    pub fn init_upgrade_admin(env: Env, admin: Address) {
        upgrade::init_upgrade_admin(&env, admin);
    }

    /// Transfers upgrade authority to a different address.
    ///
    /// # Authorization
    /// * Authorized caller: the current upgrade admin (via `require_auth`).
    /// * Why: rotating the owner of every future upgrade is as consequential as an
    ///   upgrade, so it is subject to the same timelocked authority and therefore to
    ///   the same 7-day public review window.
    ///
    /// # Panics
    /// * Panics with `Error::UpgradeAdminNotSet` if no upgrade admin is installed.
    pub fn set_upgrade_admin(env: Env, new_admin: Address) {
        upgrade::set_upgrade_admin(&env, new_admin);
    }

    /// Replaces this contract's executable and moves the storage schema forward,
    /// atomically and without changing the contract ID or touching stored state.
    ///
    /// # Authorization
    /// * Authorized caller: the upgrade admin (via `require_auth`) — the Timelock.
    /// * Why: this entrypoint can change the behaviour of every other entrypoint, so
    ///   it is restricted to the one authority that cannot act without a 7-day delay.
    ///
    /// # Arguments
    /// * `new_wasm_hash` - Hash of an already-uploaded Wasm blob. Pinned by the
    ///   timelock at proposal time, so the code reviewed during the delay is the code
    ///   that executes.
    /// * `new_schema_version` - Schema version to move to in the same transaction.
    ///   Pass the current version to swap the executable without a schema change.
    ///
    /// # Panics
    /// * Panics with `Error::UpgradeAdminNotSet` if no upgrade admin is installed.
    /// * Panics with `Error::SchemaDowngrade` if `new_schema_version` is below the
    ///   version currently in force.
    /// * Panics with `Error::UnsupportedSchemaVersion` if `new_schema_version` is
    ///   above what this executable understands.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>, new_schema_version: u32) {
        upgrade::upgrade(&env, new_wasm_hash, new_schema_version);
    }

    /// Retrieves the Attestor-enabled (V2) reputation for an address.
    ///
    /// Serves correct V2 data whether or not the address's row has physically been
    /// migrated, and reads as all-zero for an address that has never been scored.
    pub fn get_reputation_v2(env: Env, address: Address) -> reputation::ReputationV2 {
        reputation::get_reputation_v2(&env, address)
    }

    /// Returns true if `address` still holds a V1 row awaiting rewrite as V2.
    ///
    /// Always false while the contract is on schema V1.
    pub fn migration_pending(env: Env, address: Address) -> bool {
        reputation::migration_pending(&env, address)
    }

    /// Rewrites a bounded batch of V1 reputation rows into the V2 layout.
    ///
    /// # Authorization
    /// * Authorized caller: none — permissionless by design.
    /// * Why: migration is idempotent, cannot alter any counter's value, and the
    ///   caller pays the fees, so opening it prevents the DAO from being a liveness
    ///   bottleneck for the backlog.
    ///
    /// # Returns
    /// * `u32` - How many rows were actually rewritten. Addresses already on V2, and
    ///   addresses with no live row (never scored, or archived), count as zero.
    ///
    /// # Panics
    /// * Panics with `Error::MigrationNotEnabled` if the contract is still on schema V1.
    /// * Panics with `Error::BatchTooLarge` if the batch exceeds
    ///   `upgrade::MAX_MIGRATION_BATCH` addresses.
    pub fn migrate_reputation_batch(env: Env, addresses: Vec<Address>) -> u32 {
        // Fail fast if the protocol has been paused (emergency halt).
        pausable::require_not_paused(&env);

        reputation::migrate_reputation_batch(&env, addresses)
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
    /// * `Some(score)` — the trust score in the range 0..=100 (50 = neutral
    ///   baseline) when a live or absent (never-written) entry exists.
    /// * `None` — the trust-history entry for this address is currently
    ///   **archived** (Soroban state expiration).  Callers should submit a
    ///   `RestoreFootprint` + `restore_reputation(address)` transaction and
    ///   retry, rather than treating the missing value as a score of 0.
    pub fn get_trust_score(env: Env, address: Address) -> Option<u32> {
        trust_score::get_trust_score(&env, address)
    }

    /// Restores an archived reputation entry for `address` and extends its TTL.
    ///
    /// This function is **permissionless** — anyone (e.g. the indexer, a lending
    /// protocol, an end user) may call it to unarchive another address's data and
    /// pay the small restoration fee.
    ///
    /// The caller **must** include a `RestoreFootprint` Soroban host operation in
    /// the same transaction (listing the V2 reputation key, the legacy V1 key, and
    /// the trust-history key) so the host brings those ledger entries back into the
    /// live state before this contract function runs.  The SDK's `simulateTransaction`
    /// response includes the required `restoreFootprint` field when any of those keys
    /// are archived, so the restore transaction can be assembled automatically.
    ///
    /// # Arguments
    /// * `address` - The address whose reputation data should be restored.
    ///
    /// # Returns
    /// * `true`  — at least one live entry was found and its TTL extended to
    ///   [`commitments::TTL_EXTEND_LEDGERS`].
    /// * `false` — no live entry was found after restoration (either the address
    ///   was never scored or the `RestoreFootprint` operation was omitted).
    ///
    /// Emits a `reputation_restored` event so the indexer can update its TTL
    /// watchlist.
    pub fn restore_reputation(env: Env, address: Address) -> bool {
        reputation::restore_reputation(&env, address)
    }

    /// Extends the TTL of `address`'s trust-history entry so it does not archive.
    ///
    /// This is the lightweight alternative to `restore_reputation` when only the
    /// `TrustKey::TrustHistory` entry needs to be kept alive (e.g. the indexer has
    /// already bumped the reputation rows separately).
    ///
    /// Permissionless: anyone may call this. Returns `true` if a live entry was
    /// found and its TTL extended, `false` if the address has never been scored.
    pub fn restore_trust_history(env: Env, address: Address) -> bool {
        trust_score::restore_trust_history(&env, address)
    }

    // ---------------------------------------------------------------------
    // Attestor staking
    //
    // Phase 1 of the M-of-N cryptoeconomic arbitration network (Issue 86).
    // Attestors lock native Stellar tokens into the contract vault and can
    // withdraw them after a 14-day unbonding period. Voting and slashing
    // build on top of these entry points in later phases.
    // ---------------------------------------------------------------------

    /// Configures the token used for attestor staking.
    ///
    /// # Authorization
    /// * Authorized caller: the designated `arbitrator` (via `require_auth`).
    /// * Why: only the incumbent authority may bind the network to a staking asset.
    ///
    /// # Panics
    /// * Panics with `Error::NotArbitrator` if `caller` is not the arbitrator.
    /// * Panics with `Error::AlreadyInitialized` if a staking token is already set.
    pub fn set_staking_token(env: Env, caller: Address, token: Address) {
        staking::set_staking_token(&env, caller, token);
    }

    /// Configures the token used for dispute staking. One-time setup by arbitrator.
    ///
    /// # Authorization
    /// * Authorized caller: `caller` must be a member of the arbitrator set.
    ///
    /// # Panics
    /// * `Error::NotArbitrator` if caller is not in the arbitrator set.
    /// * `Error::AlreadyInitialized` if a dispute token is already configured.
    pub fn set_dispute_token(env: Env, caller: Address, token: Address) {
        caller.require_auth();
        let arbitrators = crate::commitments::arbitrators(&env);
        if !arbitrators.contains(&caller) {
            panic_with_error!(env, Error::NotArbitrator);
        }
        if env.storage().instance().has(&DataKey::DisputeToken) {
            panic_with_error!(env, Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::DisputeToken, &token);
        env.storage().instance().extend_ttl(
            commitments::TTL_THRESHOLD_LEDGERS,
            commitments::TTL_EXTEND_LEDGERS,
        );
    }

    /// Locks `amount` of the staking token from the attestor into the registry vault.
    ///
    /// # Authorization
    /// * Authorized caller: `attestor` (via `require_auth`).
    ///
    /// # Panics
    /// * Panics with `Error::ZeroAmount` if `amount` is zero or negative.
    /// * Panics with `Error::StakingTokenNotSet` if no staking token is configured.
    pub fn stake_attestor(env: Env, attestor: Address, amount: i128) {
        staking::stake_attestor(&env, attestor, amount);
    }

    /// Requests an unstake, starting the 14-day unbonding period.
    ///
    /// # Authorization
    /// * Authorized caller: `attestor` (via `require_auth`).
    ///
    /// # Panics
    /// * Panics with `Error::InsufficientStake` if the attestor has no stake.
    /// * Panics with `Error::UnbondingPending` if an unstake is already pending.
    /// * Panics with `Error::DisputeActive` if the attestor's stake is locked.
    pub fn request_unstake(env: Env, attestor: Address) {
        staking::request_unstake(&env, attestor);
    }

    /// Withdraws the full stake after the unbonding period has elapsed.
    ///
    /// # Authorization
    /// * Authorized caller: `attestor` (via `require_auth`).
    ///
    /// # Panics
    /// * Panics with `Error::InsufficientStake` if no unstake was requested.
    /// * Panics with `Error::UnbondingNotElapsed` if the unbonding period has not elapsed.
    /// * Panics with `Error::DisputeActive` if the attestor's stake is locked.
    pub fn finalize_unstake(env: Env, attestor: Address) {
        staking::finalize_unstake(&env, attestor);
    }

    /// Returns the staking record for an attestor (zeroed if it has never staked).
    pub fn get_stake_info(env: Env, attestor: Address) -> AttestorStake {
        staking::get_stake_info(&env, attestor)
    }

    // ---------------------------------------------------------------------
    // Optimistic rollup batch roots (Issue #182)
    //
    // Micro-commitments accumulate off-chain; only the Merkle batch root (and
    // a signer quorum) is submitted on-chain. Forced inclusion covers processor
    // failure or censorship after the challenge window.
    // ---------------------------------------------------------------------

    /// Configures rollup quorum threshold and challenge window (seconds).
    ///
    /// # Authorization
    /// * Authorized caller: a designated arbitrator.
    pub fn configure_rollup(env: Env, caller: Address, quorum: u32, challenge_secs: u64) {
        rollup::configure_rollup(&env, caller, quorum, challenge_secs);
    }

    /// Submits a batched Merkle state root with an ordered cosigner set.
    ///
    /// `batch_seq` must equal `last_batch_seq + 1`. Each distinct signer in
    /// `signers` (plus `submitter`) must authorize; the set must meet quorum.
    pub fn submit_batch_root(
        env: Env,
        submitter: Address,
        batch_root: BytesN<32>,
        batch_seq: u64,
        signers: Vec<Address>,
    ) {
        rollup::submit_batch_root(&env, submitter, batch_root, batch_seq, signers);
    }

    /// Returns the last accepted rollup batch sequence (0 if none).
    pub fn last_batch_seq(env: Env) -> u64 {
        rollup::last_batch_seq(&env)
    }

    /// Returns an accepted batch root record, if present.
    pub fn get_batch_root(env: Env, batch_seq: u64) -> Option<BatchRootRecord> {
        rollup::get_batch_root(&env, batch_seq)
    }

    /// Force-includes a micro-commitment leaf when the batch processor fails
    /// or censors within the challenge window.
    ///
    /// When `against_batch_seq` is set, `proof` must resolve to that batch root.
    /// When unset, inclusion is allowed only after the challenge window elapses
    /// and `expected_batch_seq` was never accepted.
    pub fn force_include(
        env: Env,
        submitter: Address,
        leaf_hash: BytesN<32>,
        sequence_id: u64,
        proof: Vec<MerkleNode>,
        against_batch_seq: Option<u64>,
        opened_at: u64,
        expected_batch_seq: u64,
    ) {
        rollup::force_include(
            &env,
            submitter,
            leaf_hash,
            sequence_id,
            proof,
            against_batch_seq,
            opened_at,
            expected_batch_seq,
        );
    }

    /// Returns a forced-inclusion record for `leaf_hash`, if any.
    pub fn get_forced_inclusion(env: Env, leaf_hash: BytesN<32>) -> Option<ForcedInclusionRecord> {
        rollup::get_forced_inclusion(&env, leaf_hash)
    }

    /// Records a new fee observation and updates the PID controller state.
    /// Anyone may call this; the oracle is permissionless by design.
    pub fn update_fee_oracle(env: Env, observed_fee: i128) -> fee_oracle::OracleState {
        reentrancy::enter(&env);
        let state = fee_oracle::update_oracle(&env, observed_fee);
        events::fee_oracle_updated(&env, state.recommended_fee, env.ledger().sequence());
        reentrancy::exit(&env);
        state
    }

    /// Returns the current recommended fee from the PID oracle.
    /// Returns OracleNotInitialized if no observations have been recorded yet.
    pub fn get_recommended_fee(env: Env) -> i128 {
        fee_oracle::get_recommended_fee(&env).unwrap_or_else(|e| panic_with_error!(&env, e))
    }
}
