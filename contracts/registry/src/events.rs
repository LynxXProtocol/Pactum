use crate::commitments::CommitmentStatus;
use crate::reputation::ReputationV2;
use soroban_sdk::{symbol_short, Address, BytesN, Env};

/// Publishes an event when a new commitment is created.
pub fn commitment_created(env: &Env, id: u64, issuer: &Address, counterparty: &Address) {
    env.events().publish(
        (
            symbol_short!("created"),
            issuer.clone(),
            counterparty.clone(),
        ),
        id,
    );
}

/// Publishes an event when a commitment status is attested.
pub fn commitment_attested(env: &Env, id: u64, status: CommitmentStatus) {
    env.events()
        .publish((symbol_short!("attested"), id), status);
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
