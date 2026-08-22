use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use light_poseidon_nostd::{Poseidon, PoseidonHasher};
use soroban_sdk::{BytesN, Env, Vec};

use crate::types::{CommitmentData, DataKey, MerkleProof, BATCH_DEPTH};

/// Helper to convert a byte slice into an `Fr` element.
/// In Circom, values are often BigInts. For our hashing, we take the bytes,
/// treat them as a big-endian integer, and convert to Fr.
fn bytes_to_fr(bytes: &[u8]) -> Fr {
    Fr::from_be_bytes_mod_order(bytes)
}

/// Helper to convert an `Fr` element to `BytesN<32>`.
fn fr_to_bytes32(env: &Env, fr: Fr) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    let rep = fr.into_bigint();
    // ark-ff BigInteger::to_bytes_le is available. But circom uses little-endian or big-endian?
    // Wait, the cross-check test needs to be deterministic. We will use big-endian.
    let be_bytes = rep.to_bytes_be();
    bytes.copy_from_slice(&be_bytes);
    BytesN::from_array(env, &bytes)
}

/// Computes a Poseidon hash of two inputs (e.g. for Merkle tree nodes).
fn hash2(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> BytesN<32> {
    let mut poseidon = Poseidon::<Fr>::new_circom(2).unwrap();
    let inputs = alloc::vec![
        bytes_to_fr(&left.to_array()),
        bytes_to_fr(&right.to_array())
    ];
    let hash = poseidon.hash(&inputs).unwrap();
    fr_to_bytes32(env, hash)
}

/// Converts a Soroban `Address` to a stable 32-byte representation by
/// serialising the strkey encoding via XDR and SHA-256-hashing it,
/// then converting that to a field element for Poseidon.
fn address_to_fr(env: &Env, addr: &soroban_sdk::Address) -> Fr {
    // XDR-serialise the address into raw bytes
    use soroban_sdk::xdr::ToXdr;
    let xdr_bytes = addr.clone().to_xdr(env);
    let hash: BytesN<32> = env.crypto().sha256(&xdr_bytes).into();
    bytes_to_fr(&hash.to_array())
}

/// Computes the Poseidon hash for a commitment leaf.
/// 4 inputs: issuer, counterparty, terms_hash, due_at.
fn commitment_leaf(env: &Env, commitment: &CommitmentData) -> BytesN<32> {
    let mut poseidon = Poseidon::<Fr>::new_circom(4).unwrap();
    let issuer_fr = address_to_fr(env, &commitment.issuer);
    let cp_fr = address_to_fr(env, &commitment.counterparty);
    let terms_fr = bytes_to_fr(&commitment.terms_hash.to_array());
    let due_at_fr = Fr::from(commitment.due_at);
    
    let inputs = alloc::vec![issuer_fr, cp_fr, terms_fr, due_at_fr];
    let hash = poseidon.hash(&inputs).unwrap();
    fr_to_bytes32(env, hash)
}

/// Recomputes the Merkle root from a commitment leaf and its authentication path.
fn recompute_root(
    env: &Env,
    leaf: BytesN<32>,
    siblings: &Vec<BytesN<32>>,
    path_bits: &Vec<u32>,
) -> BytesN<32> {
    assert_eq!(
        siblings.len(),
        BATCH_DEPTH,
        "siblings length must equal BATCH_DEPTH"
    );
    assert_eq!(
        path_bits.len(),
        BATCH_DEPTH,
        "path_bits length must equal BATCH_DEPTH"
    );

    let mut current = leaf;
    for i in 0..BATCH_DEPTH {
        let sibling = siblings.get(i).unwrap();
        let bit = path_bits.get(i).unwrap();
        current = if bit == 0 {
            hash2(env, &current, &sibling) // current is left child
        } else {
            hash2(env, &sibling, &current) // current is right child
        };
    }
    current
}

/// Determines whether a fraud proof is valid by independently recomputing
/// the Merkle root from the supplied commitment data and authentication path,
/// then comparing against the root the sequencer registered on-chain.
///
/// # Security properties
/// - `registered_root` is fetched directly from persistent storage, not from caller input.
/// - The challenger cannot forge `correct_root`: the contract computes it itself.
pub fn verify_merkle_fraud(
    env: &Env,
    batch_ledger_seq: u32,
    commitment: &CommitmentData,
    proof: &MerkleProof,
) -> bool {
    // SECURITY FIX: Fetch the registered root from storage, NOT from caller.
    // If the batch doesn't exist, this panics and rejects the challenge.
    let registered_root: BytesN<32> = env
        .storage()
        .persistent()
        .get(&DataKey::Batch(batch_ledger_seq))
        .expect("Batch not registered");

    let leaf = commitment_leaf(env, commitment);
    let recomputed = recompute_root(env, leaf, &proof.siblings, &proof.path_bits);
    
    &recomputed != &registered_root
}
