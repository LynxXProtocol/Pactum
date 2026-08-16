#![cfg(test)]

use super::*;
use crate::commitments::CommitmentStatus;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, BytesN, Env};

fn setup() -> (Env, RegistryContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    (env, client, issuer)
}

#[test]
fn test_sybil_wash_trading_resistance_single_counterparty() {
    let (env, client, issuer) = setup();
    let accomplice = Address::generate(&env);

    // Initial baseline score
    assert_eq!(client.get_trust_score(&issuer), 50);

    // Malicious actor attempts 10 micro-commitments (0 amount) with 1 accomplice
    let resolver = Address::generate(&env);
    for i in 0..10u64 {
        env.ledger().with_mut(|l| {
            l.timestamp = 1000 + i;
            l.sequence_number = 1000 + (i as u32) * 10;
        });
        let terms = BytesN::from_array(&env, &[(i as u8); 32]);
        let id = client.create_commitment(&issuer, &accomplice, &terms, &(2000 + i), &0, &resolver);
        client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    }

    let wash_score = client.get_trust_score(&issuer);
    // With severe pair discount (1/k^2), wash_score should remain heavily suppressed (<= 67).
    assert!(wash_score <= 67, "Wash score was {}, expected <= 67", wash_score);
}

#[test]
fn test_diverse_high_value_commitments_increase_score() {
    let (env, client, issuer) = setup();

    // Honest user transacts with 5 distinct counterparties with 100 XLM each (1_000_000_000 stroops)
    let resolver = Address::generate(&env);
    for i in 0..5u64 {
        let counterparty = Address::generate(&env);
        env.ledger().with_mut(|l| {
            l.timestamp = 1000 + i;
            l.sequence_number = 1000 + (i as u32) * 10;
        });
        let terms = BytesN::from_array(&env, &[(i as u8); 32]);
        let id = client.create_commitment(&issuer, &counterparty, &terms, &(2000 + i), &1_000_000_000, &resolver);
        client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    }

    let honest_score = client.get_trust_score(&issuer);
    // Honest user transacting with 5 unique counterparties achieves high trust score (>= 80).
    assert!(honest_score >= 80, "Honest score was {}, expected >= 80", honest_score);
}

#[test]
fn test_value_weighting_micro_vs_macro() {
    let (env, client, issuer) = setup();
    let counterparty1 = Address::generate(&env);
    let counterparty2 = Address::generate(&env);
    let resolver = Address::generate(&env);

    // Micro commitment (0 stroops)
    let terms1 = BytesN::from_array(&env, &[1u8; 32]);
    let id1 = client.create_commitment(&issuer, &counterparty1, &terms1, &2000, &0, &resolver);
    client.attest(&issuer, &id1, &CommitmentStatus::Fulfilled);
    let score_micro = client.get_trust_score(&issuer);

    // High value commitment (1,000 XLM = 10_000_000_000 stroops) with second counterparty
    let terms2 = BytesN::from_array(&env, &[2u8; 32]);
    let id2 = client.create_commitment(&issuer, &counterparty2, &terms2, &2000, &10_000_000_000, &resolver);
    client.attest(&issuer, &id2, &CommitmentStatus::Fulfilled);
    let score_macro = client.get_trust_score(&issuer);

    assert!(score_macro > score_micro + 10, "Score macro {} should be significantly higher than score micro {}", score_macro, score_micro);
}
