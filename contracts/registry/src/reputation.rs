//! Per-address compliance score aggregation (Phase 4)

use crate::commitments::CommitmentStatus;
use soroban_sdk::{contracttype, Address, Env};

/// Represents the aggregate reputation of an address.
///
/// The `fulfilled_count`, `late_count`, and `breached_count` fields reflect an
/// address's role as `issuer` (the party who made the commitment).
/// `counterparty_disputes_raised` counts how often the address, acting as a
/// counterparty, raised a dispute on a fairly-attested commitment (i.e., a
/// dispute the arbitrator ruled against them).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reputation {
    pub fulfilled_count: u32,
    pub late_count: u32,
    pub breached_count: u32,
    /// Number of frivolous disputes raised by this address as a counterparty.
    pub counterparty_disputes_raised: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReputationKey {
    Reputation(Address),
}

/// Helper function to get the reputation for an address.
pub fn get_reputation(env: &Env, address: Address) -> Reputation {
    let rep = env.storage()
        .persistent()
        .get(&ReputationKey::Reputation(address.clone()))
        .unwrap_or(Reputation {
            fulfilled_count: 0,
            late_count: 0,
            breached_count: 0,
        });

    if env.storage().persistent().has(&ReputationKey::Reputation(address.clone())) {
        env.storage().persistent().extend_ttl(
            &ReputationKey::Reputation(address),
            crate::commitments::TTL_THRESHOLD_LEDGERS,
            crate::commitments::TTL_EXTEND_LEDGERS,
        );
    }
    
    rep
}

/// Helper function to update the reputation for an address.
/// `increment` is true when adding an outcome (e.g., in `attest` or `resolve_dispute`),
/// and false when removing an outcome (e.g., when a dispute is raised).
pub fn update_reputation(
    env: &Env,
    issuer: Address,
    outcome: CommitmentStatus,
    increment: bool,
) {
    let mut rep = get_reputation(env, issuer.clone());

    match outcome {
        CommitmentStatus::Fulfilled => {
            if increment {
                rep.fulfilled_count = rep.fulfilled_count.saturating_add(1);
            } else {
                rep.fulfilled_count = rep.fulfilled_count.saturating_sub(1);
            }
        }
        CommitmentStatus::Late => {
            if increment {
                rep.late_count = rep.late_count.saturating_add(1);
            } else {
                rep.late_count = rep.late_count.saturating_sub(1);
            }
        }
        CommitmentStatus::Breached => {
            if increment {
                rep.breached_count = rep.breached_count.saturating_add(1);
            } else {
                rep.breached_count = rep.breached_count.saturating_sub(1);
            }
        }
        _ => {}
    }

    env.storage()
        .persistent()
        .set(&ReputationKey::Reputation(issuer.clone()), &rep);
    
    env.storage().persistent().extend_ttl(
        &ReputationKey::Reputation(issuer),
        crate::commitments::TTL_THRESHOLD_LEDGERS,
        crate::commitments::TTL_EXTEND_LEDGERS,
    );
}
