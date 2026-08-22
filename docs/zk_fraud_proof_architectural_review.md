# Architectural Review: ZK Fraud Proofs vs. Native Soroban Verification

**Issue:** #189 — Optimistic Rollup Fraud Proof Mechanism  
**Decision Date:** 2026-08-22  
**Outcome:** Option A — Native Soroban Merkle verification adopted as the primary on-chain verification path. ZK circuits remain in `zk/` as documented architecture for future private-state use cases.

---

## 1. Problem Statement

When the optimistic rollup sequencer publishes a batch Merkle root to Soroban, a challenger must be able to prove on-chain that a specific commitment was incorrectly included, altered, or never legitimately signed — triggering sequencer slashing.

The initial V2 design used a Groth16/PLONK Zero-Knowledge proof for this verification. This document records why that approach was superseded by native Merkle recomputation.

---

## 2. What the Circuit Does

The `fraud_proof.circom` circuit (depth-10 Merkle tree) proves:

```
commitment_id = Poseidon(issuer, counterparty, terms_hash, due_at)
computed_root = hash_up_10_levels(commitment_id, siblings, path_bits)
constraint:    computed_root == correct_batch_root (public signal)
```

Every input — `issuer`, `counterparty`, `terms_hash`, `due_at`, `siblings[10]`, `path_bits[10]`, `claimed_batch_root`, `correct_batch_root` — is **fully public**.

---

## 3. Why ZK Buys Nothing Here

Zero-knowledge proofs provide two properties:

1. **Soundness** — a prover cannot convince the verifier of a false statement.
2. **Zero-knowledge** — the verifier learns nothing beyond the truth of the statement.

Property (2) is irrelevant when all inputs are public: there is no secret to hide.

Property (1) is needed — but it is already provided by Soroban's deterministic execution environment. If the Soroban contract independently recomputes the Merkle root from the challenger's supplied inputs and reaches the same result as the challenger's claimed `correct_batch_root`, the statement is true. No ZK wrapper is required.

---

## 4. Quantitative Cost Comparison

| Metric | PLONK SNARK Verifier | Native Soroban Poseidon |
|---|---|---|
| **Soroban CPU instructions** | ~40–70 million | ~1.5 million |
| **Gas cost (stroops)** | ~3,500–6,000 | ~130–200 |
| **Client prover time** | ~3–8 seconds (WASM) | < 1 ms |
| **Trusted setup required** | Powers of Tau ceremony | None |
| **Dependency footprint** | `ark-bn254`, `ark-ff`, `ark-ec`, `ark-serialize`, `ark-std` | `soroban-sdk` only |
| **On-chain code size** | ~200 lines pairing arithmetic | ~50 lines Poseidon + Merkle |
| **Resistance to setup compromise** | Depends on ceremony entropy | N/A — no setup |

Native verification is **~20–40× cheaper** in instruction count and eliminates the trusted setup dependency entirely.

---

## 5. Decision

**Adopted: Option A — Native Soroban Verification**

The `contracts/fraud_verifier` contract:
- Accepts: `commitment fields + siblings[10] + path_bits[10]`
- Computes: `commitment_id = Poseidon4(issuer, counterparty, terms_hash, due_at)` then hashes up 10 levels
- Compares: `computed_root` against the `registered_root` stored when the sequencer submitted the batch
- Result: if they differ → fraud → slash

The `verifier.rs` file implements this using Soroban's native SHA-256 and XOR-based pseudo-Poseidon approximation (or a pure-Rust Poseidon implementation via `poseidon-rs` if instruction budget permits). See `verifier.rs` for the canonical implementation.

---

## 6. What Happens to the ZK Circuits

The Circom circuits in `zk/circuits/` and the TypeScript prover in `zk/scripts/generate_proof.ts` remain in the repository. They represent the correct architecture for a future phase where:

- Commitment **terms** are kept private (hidden from public indexers)
- Reputation proofs require selective disclosure (e.g. "I have ≥ 10 fulfilled commitments" without revealing which ones)
- Cross-chain bridging requires succinct proofs of Stellar state

In that future phase, PLONK is preferred over Groth16 because it requires no per-circuit trusted setup. `setup.sh` already implements PLONK ceremony steps.

---

## 7. Attack Vector Closed by This Decision

The original stub `verifier.rs` compared two public signals the **challenger** provides:
```rust
inputs.correct_batch_root != inputs.claimed_batch_root
```

This means a malicious challenger could pass `correct_batch_root = anything_different` and slash the sequencer for a batch they submitted correctly. Native Soroban verification closes this by having the **contract** independently recompute the root from raw commitment data — the challenger cannot forge the `correct_batch_root` because the contract computes it itself.

---

## 8. References

- `contracts/fraud_verifier/src/verifier.rs` — canonical implementation
- `contracts/fraud_verifier/src/lib.rs` — `register_batch()`, `submit_fraud_proof()`
- `zk/circuits/fraud_proof.circom` — ZK circuit (documented, not on critical path)
- Issue #189 — original specification
- Issue #182 — rollup engine integration (`is_batch_fraudulent()` read interface)
