use crate::commitments::CommitmentStatus;
use crate::reputation::ReputationV2;
use soroban_sdk::{symbol_short, Address, BytesN, Env};

/// Publishes an event when a new commitment is created.
pub fn commitment_created(
    env: &Env,
    id: u64,
    issuer: &Address,
    counterparty: &Address,
    oracle: &Option<Address>,
    schema_id: Option<u32>,
) {
    env.events().publish(
        (
            symbol_short!("created"),
            issuer.clone(),
            counterparty.clone(),
            oracle.clone(),
        ),
        (id, schema_id),
    );
}

/// Publishes an event when a commitment status is attested.
pub fn commitment_attested(env: &Env, id: u64, status: CommitmentStatus) {
    env.events()
        .publish((symbol_short!("attested"), id), status);
}

/// Publishes an event when a single milestone of a multi-milestone commitment
/// is attested. The commitment as a whole stays `Pending` until the final
/// milestone lands, at which point `commitment_attested` also fires.
pub fn milestone_attested(env: &Env, id: u64, milestone_index: u32, status: CommitmentStatus) {
    env.events()
        .publish((symbol_short!("milestone"), id), (milestone_index, status));
}

/// Publishes an event when a commitment is disputed by a party.
pub fn commitment_disputed(env: &Env, id: u64) {
    env.events().publish((symbol_short!("disputed"), id), ());
}

/// Publishes an event when a dispute on a commitment is resolved by the arbitrator.
pub fn dispute_resolved(env: &Env, id: u64, final_outcome: CommitmentStatus) {
    env.events()
        .publish((symbol_short!("resolved"), id), final_outcome);
}

/// Publishes an event when an arbitrator casts a vote on a committee-routed
/// dispute that has not yet reached a majority.
///
/// The data payload carries the voted outcome, the running tally for that
/// outcome, and how many votes are needed to finalize.
pub fn arbitrator_vote_cast(
    env: &Env,
    id: u64,
    voter: &Address,
    outcome: CommitmentStatus,
    votes_for: u32,
    votes_needed: u32,
) {
    env.events().publish(
        (symbol_short!("vote"), id, voter.clone()),
        (outcome, votes_for, votes_needed),
    );
}

/// Publishes an event when a panel attestor casts a vote on a disputed commitment.
pub fn attestor_vote_cast(env: &Env, id: u64, attestor: &Address, outcome: CommitmentStatus) {
    env.events()
        .publish((symbol_short!("votecast"), id, attestor.clone()), outcome);
}

/// Publishes an event when attestor voting resolves a disputed commitment to a final outcome.
pub fn commitment_resolved(env: &Env, id: u64, final_outcome: CommitmentStatus) {
    env.events()
        .publish((symbol_short!("voteres"), id), final_outcome);
}

/// Publishes an event when an unresolved dispute falls back to `Breached` after
/// the attestor voting window elapses without reaching the threshold.
pub fn commitment_fallback(env: &Env, id: u64, fallback_outcome: CommitmentStatus) {
    env.events()
        .publish((symbol_short!("votefall"), id), fallback_outcome);
}
pub fn protocol_paused(env: &Env) {
    let topics = (symbol_short!("paused"),);
    env.events().publish(topics, ());
}

pub fn protocol_unpaused(env: &Env) {
    let topics = (symbol_short!("unpaused"),);
    env.events().publish(topics, ());
}

/// Publishes an event when the contract's executable is replaced.
///
/// Emitted by the *outgoing* executable, before the swap takes effect, so the log
/// entry is produced by the code reviewers audited during the timelock window.
pub fn upgraded(
    env: &Env,
    new_wasm_hash: &BytesN<32>,
    old_schema_version: u32,
    new_schema_version: u32,
) {
    env.events().publish(
        (symbol_short!("upgraded"), new_wasm_hash.clone()),
        (old_schema_version, new_schema_version),
    );
}

/// Publishes an event when upgrade authority moves to a different address.
///
/// `old` is `None` only for the one-time bootstrap installation.
pub fn upgrade_admin_changed(env: &Env, old: Option<&Address>, new: &Address) {
    env.events()
        .publish((symbol_short!("upgadmin"), new.clone()), old.cloned());
}

/// Publishes an event when an address's reputation row is rewritten from V1 to V2.
pub fn reputation_migrated(env: &Env, address: &Address, migrated: &ReputationV2) {
    env.events().publish(
        (symbol_short!("repmigr"), address.clone()),
        migrated.clone(),
    );
}

/// Publishes an event when an archived reputation (or trust-history) entry is
/// successfully restored by a permissionless caller.
///
/// The `restored_v2` flag is `true` when a V2 reputation row was found after
/// restoration, and `false` when only a legacy V1 row (or trust-history entry)
/// was present.  Indexers can use this to update their TTL watchlists.
pub fn reputation_restored(env: &Env, address: &Address, restored_v2: bool) {
    env.events()
        .publish((symbol_short!("reprstr"), address.clone()), restored_v2);
}

/// Publishes an event when an attestor stakes tokens into the registry vault.
pub fn staked(env: &Env, attestor: &Address, amount: i128) {
    env.events()
        .publish((symbol_short!("staked"), attestor.clone()), amount);
}

/// Publishes an event when an attestor requests an unstake, starting the unbonding period.
pub fn unstake_requested(env: &Env, attestor: &Address, unbonding_until: u64) {
    env.events().publish(
        (symbol_short!("unbndreq"), attestor.clone()),
        unbonding_until,
    );
}

/// Publishes an event when an attestor withdraws their stake after the unbonding period.
pub fn unstaked(env: &Env, attestor: &Address, amount: i128) {
    env.events()
        .publish((symbol_short!("unstaked"), attestor.clone()), amount);
}

/// Publishes when a rollup batch Merkle root is accepted on-chain.
pub fn batch_root_submitted(
    env: &Env,
    root: &BytesN<32>,
    batch_seq: u64,
    submitter: &Address,
    submitted_at: u64,
) {
    env.events().publish(
        (symbol_short!("batchrt"), submitter.clone(), batch_seq),
        (root.clone(), submitted_at),
    );
}

/// Publishes when a micro-commitment is force-included outside the batch path.
pub fn forced_inclusion(
    env: &Env,
    leaf_hash: &BytesN<32>,
    sequence_id: u64,
    submitter: &Address,
    included_at: u64,
) {
    env.events().publish(
        (symbol_short!("forcein"), submitter.clone(), sequence_id),
        (leaf_hash.clone(), included_at),
    );
}

/// Publishes an event when the fee oracle updates its recommendation.
pub fn fee_oracle_updated(env: &Env, recommended_fee: i128, ledger: u32) {
    env.events()
        .publish((symbol_short!("fee_upd"), ledger), recommended_fee);
}
