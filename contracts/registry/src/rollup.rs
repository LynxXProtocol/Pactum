//! Optimistic rollup batch-root submission and forced inclusion (Issue #182).
//!
//! Micro-commitments accumulate off-chain into a Merkle batch root. Only the
//! root (plus a signer quorum) crosses onto Soroban. If a batch processor fails
//! to finalize within the challenge window, any holder may `force_include` their
//! leaf with a Merkle proof (or a direct payload when no root was ever posted).

use crate::commitments::{DataKey, TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use crate::errors::Error;
use crate::events;
use crate::pausable;
use crate::reentrancy;
use soroban_sdk::{
    contracttype, panic_with_error, Address, Bytes, BytesN, Env, Vec,
};

/// Default challenge window: 1 hour in seconds.
pub const DEFAULT_CHALLENGE_WINDOW_SECS: u64 = 60 * 60;

/// Maximum number of cosigners accepted with a batch root submission.
pub const MAX_BATCH_SIGNERS: u32 = 32;

/// Maximum Merkle proof depth accepted by `force_include`.
pub const MAX_PROOF_DEPTH: u32 = 32;

/// On-chain record of an accepted rollup batch root.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchRootRecord {
    pub root: BytesN<32>,
    pub batch_seq: u64,
    pub submitted_at: u64,
    pub submitter: Address,
}

/// A single forced-inclusion of a micro-commitment leaf.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForcedInclusionRecord {
    pub leaf_hash: BytesN<32>,
    pub sequence_id: u64,
    pub included_at: u64,
    pub submitter: Address,
    pub against_root: Option<BytesN<32>>,
}

/// One node on a Merkle audit path.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MerkleNode {
    pub sibling: BytesN<32>,
    /// `true` when the sibling is to the right of the running hash.
    pub is_right: bool,
}

/// Rollup-specific storage keys (appended to [`DataKey`] via dedicated keys here
/// so existing commitment discriminants stay stable).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RollupKey {
    /// Last accepted batch sequence number (instance).
    LastBatchSeq,
    /// Persistent batch root by sequence.
    BatchRoot(u64),
    /// Quorum threshold for batch-root cosigners (instance). `0` means submitter-only.
    QuorumThreshold,
    /// Challenge window length in seconds (instance).
    ChallengeWindowSecs,
    /// Forced inclusion by leaf hash.
    ForcedInclusion(BytesN<32>),
    /// Earliest open batch timestamp used for challenge checks (instance).
    OpenBatchOpenedAt,
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

fn bump_persistent(env: &Env, key: &RollupKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Returns the last accepted batch sequence (0 if none).
pub fn last_batch_seq(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&RollupKey::LastBatchSeq)
        .unwrap_or(0u64)
}

/// Returns the configured cosigner quorum (default 1 = submitter alone).
pub fn quorum_threshold(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&RollupKey::QuorumThreshold)
        .unwrap_or(1u32)
}

/// Returns the challenge window in seconds.
pub fn challenge_window_secs(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&RollupKey::ChallengeWindowSecs)
        .unwrap_or(DEFAULT_CHALLENGE_WINDOW_SECS)
}

/// Admin configuration for rollup quorum / challenge window. Arbitrator-gated.
pub fn configure_rollup(env: &Env, caller: Address, quorum: u32, challenge_secs: u64) {
    pausable::require_not_paused(env);
    require_arbitrator(env, &caller);
    caller.require_auth();

    if quorum == 0 || quorum > MAX_BATCH_SIGNERS {
        panic_with_error!(env, Error::BatchTooLarge);
    }
    if challenge_secs == 0 {
        panic_with_error!(env, Error::InvalidTransition);
    }

    reentrancy::enter(env);
    env.storage()
        .instance()
        .set(&RollupKey::QuorumThreshold, &quorum);
    env.storage()
        .instance()
        .set(&RollupKey::ChallengeWindowSecs, &challenge_secs);
    bump_instance(env);
    reentrancy::exit(env);
}

/// Submit a batched Merkle state root with an ordered signer set.
///
/// Each address in `signers` must authorize the invocation (`require_auth`).
/// The set must meet the configured quorum. `batch_seq` must equal
/// `last_batch_seq + 1`.
pub fn submit_batch_root(
    env: &Env,
    submitter: Address,
    batch_root: BytesN<32>,
    batch_seq: u64,
    signers: Vec<Address>,
) {
    pausable::require_not_paused(env);
    submitter.require_auth();

    let expected = last_batch_seq(env).checked_add(1).unwrap_or_else(|| {
        panic_with_error!(env, Error::Overflow);
    });
    if batch_seq != expected {
        panic_with_error!(env, Error::InvalidTransition);
    }

    if signers.len() > MAX_BATCH_SIGNERS {
        panic_with_error!(env, Error::BatchTooLarge);
    }

    let mut auth_count: u32 = 0;
    let mut seen = Vec::new(env);
    // Submitter always counts toward quorum.
    seen.push_back(submitter.clone());
    auth_count = auth_count.saturating_add(1);

    for signer in signers.iter() {
        if seen.contains(&signer) {
            continue;
        }
        signer.require_auth();
        seen.push_back(signer.clone());
        auth_count = auth_count.saturating_add(1);
    }

    let threshold = quorum_threshold(env);
    if auth_count < threshold {
        panic_with_error!(env, Error::VotesNotMet);
    }

    let now = env.ledger().timestamp();
    reentrancy::enter(env);

    let record = BatchRootRecord {
        root: batch_root.clone(),
        batch_seq,
        submitted_at: now,
        submitter: submitter.clone(),
    };

    let key = RollupKey::BatchRoot(batch_seq);
    env.storage().persistent().set(&key, &record);
    bump_persistent(env, &key);

    env.storage()
        .instance()
        .set(&RollupKey::LastBatchSeq, &batch_seq);
    bump_instance(env);

    events::batch_root_submitted(env, &batch_root, batch_seq, &submitter, now);
    reentrancy::exit(env);
}

/// Fetch a previously accepted batch root record.
pub fn get_batch_root(env: &Env, batch_seq: u64) -> Option<BatchRootRecord> {
    let key = RollupKey::BatchRoot(batch_seq);
    let record: Option<BatchRootRecord> = env.storage().persistent().get(&key);
    if record.is_some() {
        bump_persistent(env, &key);
    }
    record
}

/// Force-include a micro-commitment leaf when the batch processor is late/censored.
///
/// If `against_batch_seq` is set, the Merkle proof must resolve to that batch's
/// accepted root. If unset, inclusion is allowed only after the challenge window
/// has elapsed since `opened_at` (caller-supplied commitment creation time) and
/// no covering root has been accepted for `expected_batch_seq`.
pub fn force_include(
    env: &Env,
    submitter: Address,
    leaf_hash: BytesN<32>,
    sequence_id: u64,
    proof: Vec<MerkleNode>,
    against_batch_seq: Option<u64>,
    opened_at: u64,
    expected_batch_seq: u64,
) {
    pausable::require_not_paused(env);
    submitter.require_auth();

    if proof.len() > MAX_PROOF_DEPTH {
        panic_with_error!(env, Error::BatchTooLarge);
    }

    let existing_key = RollupKey::ForcedInclusion(leaf_hash.clone());
    if env.storage().persistent().has(&existing_key) {
        panic_with_error!(env, Error::AlreadyResolved);
    }

    let now = env.ledger().timestamp();
    let against_root = match against_batch_seq {
        Some(seq) => {
            let record = get_batch_root(env, seq).unwrap_or_else(|| {
                panic_with_error!(env, Error::CommitmentNotFound);
            });
            let computed = compute_merkle_root(env, &leaf_hash, &proof);
            if computed != record.root {
                panic_with_error!(env, Error::RollupProofInvalid);
            }
            Some(record.root)
        }
        None => {
            let window = challenge_window_secs(env);
            let deadline = opened_at.checked_add(window).unwrap_or_else(|| {
                panic_with_error!(env, Error::Overflow);
            });
            if now < deadline {
                panic_with_error!(env, Error::RollupChallengePending);
            }
            // Reject if the expected batch was actually accepted (processor not censored).
            if get_batch_root(env, expected_batch_seq).is_some() {
                panic_with_error!(env, Error::AlreadyResolved);
            }
            None
        }
    };

    reentrancy::enter(env);
    let record = ForcedInclusionRecord {
        leaf_hash: leaf_hash.clone(),
        sequence_id,
        included_at: now,
        submitter: submitter.clone(),
        against_root: against_root.clone(),
    };
    env.storage().persistent().set(&existing_key, &record);
    bump_persistent(env, &existing_key);
    bump_instance(env);

    events::forced_inclusion(env, &leaf_hash, sequence_id, &submitter, now);
    reentrancy::exit(env);
}

/// Returns a forced-inclusion record if one exists for `leaf_hash`.
pub fn get_forced_inclusion(env: &Env, leaf_hash: BytesN<32>) -> Option<ForcedInclusionRecord> {
    let key = RollupKey::ForcedInclusion(leaf_hash);
    let record: Option<ForcedInclusionRecord> = env.storage().persistent().get(&key);
    if record.is_some() {
        bump_persistent(env, &key);
    }
    record
}

fn compute_merkle_root(env: &Env, leaf: &BytesN<32>, proof: &Vec<MerkleNode>) -> BytesN<32> {
    let mut current = leaf.clone();
    for i in 0..proof.len() {
        let node = proof.get(i).unwrap();
        let left = if node.is_right {
            current.clone()
        } else {
            node.sibling.clone()
        };
        let right = if node.is_right {
            node.sibling.clone()
        } else {
            current.clone()
        };
        let mut packed = Bytes::new(env);
        packed.append(&Bytes::from(left));
        packed.append(&Bytes::from(right));
        let digest = env.crypto().sha256(&packed);
        current = BytesN::<32>::from_array(env, &digest.to_array());
    }
    current
}

fn require_arbitrator(env: &Env, caller: &Address) {
    // Prefer the committee set; fall back to legacy single arbitrator.
    if env.storage().instance().has(&DataKey::ArbitratorSet) {
        let set: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::ArbitratorSet)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
        if !set.contains(caller) {
            panic_with_error!(env, Error::NotArbitrator);
        }
        return;
    }
    if env.storage().instance().has(&DataKey::Arbitrator) {
        let arb: Address = env
            .storage()
            .instance()
            .get(&DataKey::Arbitrator)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
        if &arb != caller {
            panic_with_error!(env, Error::NotArbitrator);
        }
        return;
    }
    panic_with_error!(env, Error::NotInitialized);
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, BytesN, Env, Vec};

    fn setup() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let arb = Address::generate(&env);
        // Minimal arbitrator bootstrap via DataKey so configure/submit work.
        let mut set = Vec::new(&env);
        set.push_back(arb.clone());
        env.storage()
            .instance()
            .set(&DataKey::ArbitratorSet, &set);
        (env, arb)
    }

    #[test]
    fn submit_batch_root_advances_sequence() {
        let (env, arb) = setup();
        let root = BytesN::from_array(&env, &[7u8; 32]);
        let signers = Vec::new(&env);
        submit_batch_root(&env, arb.clone(), root.clone(), 1, signers);
        assert_eq!(last_batch_seq(&env), 1);
        let record = get_batch_root(&env, 1).expect("root stored");
        assert_eq!(record.root, root);
        assert_eq!(record.batch_seq, 1);
    }

    #[test]
    #[should_panic]
    fn rejects_out_of_order_batch_seq() {
        let (env, arb) = setup();
        let root = BytesN::from_array(&env, &[1u8; 32]);
        submit_batch_root(&env, arb, root, 2, Vec::new(&env));
    }
}
