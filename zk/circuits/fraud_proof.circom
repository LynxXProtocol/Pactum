pragma circom 2.1.5;

include "./commitment_hash.circom";
include "./batch_merkle.circom";

// BATCH_DEPTH = ceil(log2(max_commitments_per_batch))
// For max 1024 per batch: BATCH_DEPTH = 10
template FraudProof(BATCH_DEPTH) {

    // ── Public inputs ─────────────────────────────────────────────────
    signal input  claimed_batch_root;     // what sequencer submitted on-chain
    signal input  correct_batch_root;     // what this circuit computes (the truth)

    // ── Private inputs (witness) ──────────────────────────────────────
    // One commitment from the batch being disputed
    signal input  issuer_hash;
    signal input  counterparty_hash;
    signal input  terms_hash;
    signal input  due_at;

    // Its position in the batch Merkle tree
    signal input  leaf_pos;               // unused in constraint but part of witness semantics
    signal input  siblings[BATCH_DEPTH];
    signal input  path_bits[BATCH_DEPTH];

    // ── Compute commitment_id ─────────────────────────────────────────
    component ch = CommitmentHash();
    ch.issuer_hash        <== issuer_hash;
    ch.counterparty_hash  <== counterparty_hash;
    ch.terms_hash         <== terms_hash;
    ch.due_at             <== due_at;

    // ── Verify Merkle path → correct_batch_root ───────────────────────
    component mt = BatchMerkleVerify(BATCH_DEPTH);
    mt.leaf        <== ch.commitment_id;
    mt.root        <== correct_batch_root; // circuit verifies this
    for (var i = 0; i < BATCH_DEPTH; i++) {
        mt.siblings[i]  <== siblings[i];
        mt.path_bits[i] <== path_bits[i];
    }

    // ── Wire claimed root in as public signal (mismatch check on-chain) ─
    signal claimed_sink;
    claimed_sink <== claimed_batch_root * 1;
}

component main {
    public [claimed_batch_root, correct_batch_root]
} = FraudProof(10);
