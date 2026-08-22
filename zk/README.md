# ZK Circuits for Pactum Fraud Proofs

This directory contains the Circom circuits designed for the Pactum fraud proof system.

**IMPORTANT ARCHITECTURAL NOTE:**
The current on-chain verifier (`contracts/fraud_verifier`) uses **native Poseidon Merkle recomputation** instead of verifying ZK proofs. Since all dispute inputs (commitments, siblings, and path bits) are public, zero-knowledge provides no cryptographic utility for the current optimistic rollup dispute flow, and native Soroban hashing is significantly cheaper in instruction budget (saving ~30x overhead vs a PLONK verifier).

### Why keep these circuits?
These circuits are retained as the **future ZK path**. When the rollup introduces private state or scalable validity proofs, these circuits provide the foundation.
To ensure the transition remains compatible, the on-chain native verification strictly uses the **Poseidon hash** (via `light-poseidon-nostd`) mirroring the behavior of `circomlibjs` byte-for-byte.

### CI compilation
The CI job strictly compiles these circuits (`npm install -g circom`) on every push to ensure they remain valid and do not bitrot, even though their `.wasm` and `.zkey` artifacts are currently bypassed in the active dispute resolution flow.

### Cross-Check Testing
The `test/crosscheck.test.ts` file spawns a Rust helper binary (`hash_helper.rs`) compiled from the Soroban contract's workspace. It proves cryptographically that the TypeScript Merkle builder and the Rust on-chain contract compute identical domain tags, bit orientations, and hashes for the same inputs.
