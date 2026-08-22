# Formal Verification — Dispute Slashing (Issue #192)

This package extracts **pure** slash / vault / policy math from the Soroban
registry so SMT solvers can prove economic invariants without modelling the
full host.

## What is proved

| Invariant | Module | Tool |
|-----------|--------|------|
| Slash cut is bounded (`0 ≤ cut ≤ stake`) and conserves mass | `economics/slash.rs` | Unit tests + Kani |
| Slash does **not** drain vault tokens (forfeit stays in vault) | `economics/slash.rs` | Unit tests + Kani |
| Weak TVL: `vault_tokens ≥ Σ recorded_stake` after slash | `economics/vault.rs` | Unit tests + Kani |
| Only dissenting voters are slashed; timeout spares everyone | `economics/policy.rs` | Unit tests + Kani |

Production `staking::slash` calls `economics::slash_cut`, so the proved
arithmetic is the same path the contract uses.

## Snappy checks (default CI)

```bash
cargo test -p registry economics::
```

These are host-free and finish in seconds. They run as part of normal
`cargo test -p registry` / Contract CI.

## Bounded model checking (Kani) — optional

Kani is **not** installed or invoked by default PR workflows (avoids CI
failures when the solver toolchain is absent). Run locally or via the
manual workflow:

```bash
cargo install --locked kani-verifier
cargo kani setup
cd contracts && cargo kani -p registry --tests
```

GitHub: **Actions → Formal Verification (Kani) → Run workflow**.

## Why not whole-contract Kani / Certora first

Soroban `Env`, auth, and storage are a poor first target for BMC. Issue #192
asks for mathematical certainty on **economic** invariants (TVL, slash ratio,
state-policy). Extracting the pure cores gives that certainty without state
explosion. Creusot / Certora can layer later on the same APIs.
