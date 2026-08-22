use soroban_sdk::{contracttype, Address, BytesN, Vec};

/// A Merkle inclusion proof for a commitment leaf in a batch tree.
/// Contains the sibling hashes and path bits needed to recompute the root.
/// BATCH_DEPTH = 10 (max 1024 commitments per batch).
#[contracttype]
#[derive(Clone)]
pub struct MerkleProof {
    /// Sibling node hashes at each tree level (length = BATCH_DEPTH)
    pub siblings: Vec<BytesN<32>>,
    /// Left/right orientation at each level: 0 = current is left, 1 = current is right
    pub path_bits: Vec<u32>,
}

/// The four commitment fields used to compute the leaf hash.
/// Matches the fields stored in the registry contract.
#[contracttype]
#[derive(Clone)]
pub struct CommitmentData {
    pub issuer: Address,
    pub counterparty: Address,
    pub terms_hash: BytesN<32>,
    pub due_at: u64,
}

/// Stored sequencer info (for slashing)
#[contracttype]
pub struct SequencerRecord {
    pub address: Address,
    pub stake: i128, // XLM staked (in stroops)
    pub slashed: bool,
}

#[contracttype]
pub enum DataKey {
    Sequencer,
    Batch(u32),          // ledger_seq -> claimed_batch_root: BytesN<32>
    Challenge(u32, u32), // (ledger_seq, leaf_pos) -> bool (deduplication)
    FraudFlag(u32),      // ledger_seq -> bool (readable by #182 rollup engine)
}

pub const BATCH_DEPTH: u32 = 10;
pub const FRAUD_PROVEN_TOPIC: soroban_sdk::Symbol = soroban_sdk::symbol_short!("Slashing");
