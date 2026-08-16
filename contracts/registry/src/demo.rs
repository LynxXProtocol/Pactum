#![cfg(test)]

//! Interactive time-decay demo for the issue #54 video walkthrough.
//!
//! Run with:
//!
//! ```text
//! cargo test -p registry demo -- --nocapture
//! ```
//!
//! Drives the contract through its public interface on the in-process
//! Soroban host (the same contract, same code, same math as the testnet
//! deployment) and prints a score table as the simulated ledger advances.

use super::*;
use crate::commitments::CommitmentStatus;
use crate::trust_score::BUCKET_SIZE_LEDGERS;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, BytesN, Env};

extern crate std;
use std::println;

fn setup() -> (Env, RegistryContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    let counterparty = Address::generate(&env);
    (env, client, issuer, counterparty)
}

fn create_and_attest(
    env: &Env,
    client: &RegistryContractClient<'static>,
    issuer: &Address,
    counterparty: &Address,
    terms: u8,
    outcome: CommitmentStatus,
) -> u64 {
    env.ledger().with_mut(|l| {
        l.timestamp = 1000;
        l.sequence_number = 1000;
    });
    let resolver = Address::generate(env);
    let id = client.create_commitment(
        issuer,
        counterparty,
        &BytesN::from_array(env, &[terms; 32]),
        &2000,
        &100_000_000,
        &resolver,
    );
    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(issuer, &id, &outcome);
    id
}

/// Advances the ledger in chunks, keeping the contract instance and the
/// issuer's trust history alive (bump-on-access), exactly like production use.
fn advance_ledgers(
    env: &Env,
    client: &RegistryContractClient<'static>,
    issuer: &Address,
    target_seq: u32,
) {
    const CHUNK: u32 = 200_000;
    let mut seq = env.ledger().get().sequence_number;
    while seq < target_seq {
        let next = seq.saturating_add(CHUNK).min(target_seq);
        env.ledger().with_mut(|l| l.sequence_number = next);
        client.get_arbitrator();
        client.get_trust_score(issuer);
        client.get_reputation(issuer);
        seq = next;
    }
}

fn buckets_ledgers(buckets: u32) -> u32 {
    1000 + buckets * BUCKET_SIZE_LEDGERS
}

#[test]
fn demo_time_decay_table() {
    let (env, client, issuer, counterparty) = setup();
    let arbitrator = Address::generate(&env);
    client.initialize(&arbitrator);

    println!();
    println!("=== Pactum Registry: ledger-based time-decay trust score ===");
    println!("(in-process Soroban host, same contract as the testnet deployment)");
    println!();

    println!("[1] Baseline - an address with no history scores 50:");
    let stranger = Address::generate(&env);
    println!("    get_trust_score(no history)           = {}", client.get_trust_score(&stranger));

    println!();
    println!("[2] A breach just happened:");
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        1,
        CommitmentStatus::Breached,
    );
    println!("    get_trust_score(issuer)               = {}   (50 - 50, clamped)", client.get_trust_score(&issuer));
    println!("    get_reputation(issuer)                = {:?}", client.get_reputation(&issuer));

    println!();
    println!("[3] Ledger advances decay the breach's impact (bucket = 10,000 ledgers):");
    for (buckets, expected) in [
        (0u32, 0u32),
        (64, 25),
        (128, 37),
        (192, 43),
        (256, 46),
        (320, 48),
        (384, 49),
        (2048, 50),
    ] {
        if buckets > 0 {
            advance_ledgers(&env, &client, &issuer, buckets_ledgers(buckets));
        }
        let score = client.get_trust_score(&issuer);
        println!(
            "    +{:>5} buckets ({:>10} ledgers) -> score {}   (expected {})",
            buckets,
            buckets * BUCKET_SIZE_LEDGERS,
            score,
            expected,
        );
    }

    println!();
    println!("[4] The breach is never erased - reputation persists forever:");
    println!("    get_reputation(issuer)                = {:?}", client.get_reputation(&issuer));

    println!();
    println!("[5] A fresh breach still tanks the score immediately:");
    create_and_attest(
        &env,
        &client,
        &issuer,
        &counterparty,
        2,
        CommitmentStatus::Breached,
    );
    println!("    get_trust_score(issuer)               = {}", client.get_trust_score(&issuer));

    println!();
    println!("[6] Mixed history (1 fulfilled + 1 breach) also recovers:");
    let (env2, client2, issuer2, counterparty2) = setup();
    let arbitrator2 = Address::generate(&env2);
    client2.initialize(&arbitrator2);
    create_and_attest(
        &env2,
        &client2,
        &issuer2,
        &counterparty2,
        1,
        CommitmentStatus::Fulfilled,
    );
    create_and_attest(
        &env2,
        &client2,
        &issuer2,
        &counterparty2,
        2,
        CommitmentStatus::Breached,
    );
    println!("    same bucket                          -> {}", client2.get_trust_score(&issuer2));
    advance_ledgers(&env2, &client2, &issuer2, buckets_ledgers(64));
    println!("    +64 buckets (640,000 ledgers)        -> {}", client2.get_trust_score(&issuer2));
    advance_ledgers(&env2, &client2, &issuer2, buckets_ledgers(128));
    println!("    +128 buckets (1,280,000 ledgers)     -> {}", client2.get_trust_score(&issuer2));
    println!();
}