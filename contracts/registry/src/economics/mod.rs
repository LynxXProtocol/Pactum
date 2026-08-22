//! Pure economic math for dispute slashing and vault accounting (Issue #192).
//!
//! These modules intentionally have **no** Soroban `Env` dependency so SMT
//! solvers (Kani) and ordinary unit tests can exhaustively check invariants
//! without modelling the host. The production staking vault calls into this
//! code for slash arithmetic.

#![forbid(unsafe_code)]

mod policy;
mod slash;
mod vault;

pub use policy::{
    should_slash_attestor, SlashDecision, SLASH_PERCENT_BPS, SLASH_PERCENT_OF_STAKE,
};
pub use slash::{apply_slash_accounting, slash_cut, SlashCut};
pub use vault::{
    vault_covers_recorded_stakes, VaultSnapshot, MAX_MODELLED_ATTESTORS,
};

#[cfg(test)]
mod tests;

#[cfg(kani)]
mod proofs;
