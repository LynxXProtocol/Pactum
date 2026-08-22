pragma circom 2.1.5;

include "circomlib/circuits/poseidon.circom";

template BatchMerkleVerify(DEPTH) {
    signal input  leaf;
    signal input  root;             // asserted to equal the recomputed root
    signal input  siblings[DEPTH];
    signal input  path_bits[DEPTH]; // 0=left, 1=right

    component hashes[DEPTH];
    signal cur[DEPTH + 1];
    cur[0] <== leaf;

    signal diff[DEPTH];
    for (var i = 0; i < DEPTH; i++) {
        hashes[i] = Poseidon(2);
        diff[i] <== siblings[i] - cur[i];
        hashes[i].inputs[0] <== cur[i] + path_bits[i] * diff[i];
        hashes[i].inputs[1] <== siblings[i] - path_bits[i] * diff[i];
        cur[i + 1] <== hashes[i].out;
    }

    cur[DEPTH] === root; // hard constraint
}
