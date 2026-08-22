pragma circom 2.1.5;

include "circomlib/circuits/poseidon.circom";

template CommitmentHash() {
    signal input  issuer_hash;       // H(issuer_stellar_address)
    signal input  counterparty_hash; // H(counterparty_stellar_address)
    signal input  terms_hash;        // terms_hash field from create_commitment
    signal input  due_at;            // Unix timestamp

    signal output commitment_id;

    component h = Poseidon(4);
    h.inputs[0] <== issuer_hash;
    h.inputs[1] <== counterparty_hash;
    h.inputs[2] <== terms_hash;
    h.inputs[3] <== due_at;

    commitment_id <== h.out;
}
