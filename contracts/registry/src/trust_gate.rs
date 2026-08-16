//! TrustGate: standard, reentrancy-safe cross-contract interface (Phase B).
//!
//! External contracts that want to compose with the registry should not
//! depend on the whole `registry` crate; they should depend on a small,
//! typed interface instead. This module publishes that interface as two
//! deliberately separate `#[contractclient]` traits:
//!
//! * [`TrustGateReader`] — read-only. `get_trust_score` performs no storage
//!   writes, so it is always safe to call, including mid-transaction while a
//!   registry mutation is in progress. This is the interface most external
//!   contracts should import.
//! * [`TrustGateWriter`] — state-mutating. `attest` and `resolve_dispute` are
//!   both guarded by the registry's internal reentrancy lock (see
//!   `reentrancy.rs`): a nested call into either function while a guarded
//!   registry call is already in progress fails fast with
//!   `Error::ReentrantCall` instead of corrupting state.
//!
//! `RegistryContract` implements both traits below (as plain Rust trait
//! impls, not re-exported contract entry points) purely so the compiler
//! enforces that these published interfaces never drift out of sync with
//! the contract's actual public API.

use crate::commitments::CommitmentStatus;
use crate::RegistryContract;
use soroban_sdk::{contractclient, Address, Env};

/// Read-only cross-contract interface for querying an address's trust score.
#[contractclient(name = "TrustGateReaderClient")]
pub trait TrustGateReader {
    fn get_trust_score(env: Env, address: Address) -> u32;
}

/// State-mutating cross-contract interface, kept strictly separate from
/// [`TrustGateReader`] so integrators cannot accidentally reach for a
/// mutating call while only intending to read a trust score.
#[contractclient(name = "TrustGateWriterClient")]
pub trait TrustGateWriter {
    fn attest(env: Env, caller: Address, id: u64, outcome: CommitmentStatus);
    fn resolve_dispute(env: Env, caller: Address, id: u64, final_outcome: CommitmentStatus);
}

impl TrustGateReader for RegistryContract {
    fn get_trust_score(env: Env, address: Address) -> u32 {
        RegistryContract::get_trust_score(env, address)
    }
}

impl TrustGateWriter for RegistryContract {
    fn attest(env: Env, caller: Address, id: u64, outcome: CommitmentStatus) {
        RegistryContract::attest(env, caller, id, outcome)
    }

    fn resolve_dispute(env: Env, caller: Address, id: u64, final_outcome: CommitmentStatus) {
        RegistryContract::resolve_dispute(env, caller, id, final_outcome)
    }
}
