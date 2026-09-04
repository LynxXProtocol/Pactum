#![cfg(test)]

use super::*;
use crate::commitments::CommitmentStatus;
use crate::errors::Error;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{contracttype, Address, BytesN, Env};

fn setup_test() -> (
    Env,
    RegistryContractClient<'static>,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    let counterparty = Address::generate(&env);
    let resolver = Address::generate(&env);
    (env, client, issuer, counterparty, resolver)
}

#[test]
fn test_create_and_get_commitment_success() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);

    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let commitment_id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    assert_eq!(commitment_id, 1);

    let commitment = client.get_commitment(&commitment_id);
    assert_eq!(commitment.id, 1);
    assert_eq!(commitment.issuer, issuer);
    assert_eq!(commitment.counterparty, counterparty);
    assert_eq!(commitment.terms_hash, terms_hash);
    assert_eq!(commitment.due_at, due_at);
    assert_eq!(commitment.status, CommitmentStatus::Pending);
    assert_eq!(commitment.created_at, 1000);
    assert_eq!(commitment.resolver_address, resolver);
}

#[test]
#[should_panic]
fn test_create_commitment_requires_auth() {
    let env = Env::default();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    let counterparty = Address::generate(&env);
    let resolver = Address::generate(&env);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let due_at = 2000;

    client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
}

#[test]
fn test_create_commitment_fails_if_due_at_in_past() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);

    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 999;

    let res = client.try_create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    assert_eq!(res, Err(Ok(Error::DueAtInPast.into())));
}

#[test]
fn test_get_commitment_fails_for_nonexistent_id() {
    let (_env, client, _issuer, _counterparty, _resolver) = setup_test();

    let res = client.try_get_commitment(&999);
    assert_eq!(res, Err(Ok(Error::CommitmentNotFound.into())));
}

#[test]
fn test_sequential_unique_ids() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash1 = BytesN::from_array(&env, &[1u8; 32]);
    let terms_hash2 = BytesN::from_array(&env, &[2u8; 32]);

    let id1 = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash1,
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    let id2 = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash2,
        &3000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_ne!(id1, id2);

    let c1 = client.get_commitment(&id1);
    let c2 = client.get_commitment(&id2);

    assert_eq!(c1.id, 1);
    assert_eq!(c1.terms_hash, terms_hash1);
    assert_eq!(c2.id, 2);
    assert_eq!(c2.terms_hash, terms_hash2);
}

#[test]
fn test_attest_outcome_fulfilled() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Fulfilled);
    assert_eq!(commitment.attested_at, Some(1500));
}

#[test]
fn test_attest_outcome_late_by_counterparty() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    env.ledger().with_mut(|l| l.timestamp = 2500);
    client.attest(&counterparty, &id, &CommitmentStatus::Late);

    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Late);
    assert_eq!(commitment.attested_at, Some(2500));
}

#[test]
fn test_attest_outcome_breached() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    env.ledger().with_mut(|l| l.timestamp = 2100);
    client.attest(&issuer, &id, &CommitmentStatus::Breached);

    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Breached);
    assert_eq!(commitment.attested_at, Some(2100));
}

#[test]
fn test_attest_fails_if_not_pending() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    let res = client.try_attest(&issuer, &id, &CommitmentStatus::Late);
    assert_eq!(res, Err(Ok(Error::AlreadyResolved.into())));

    let res2 = client.try_attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(res2, Err(Ok(Error::AlreadyResolved.into())));

    let res3 = client.try_attest(&issuer, &id, &CommitmentStatus::Breached);
    assert_eq!(res3, Err(Ok(Error::AlreadyResolved.into())));
}

#[test]
#[should_panic]
fn test_attest_requires_auth() {
    let env = Env::default();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    let counterparty = Address::generate(&env);
    let resolver = Address::generate(&env);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let due_at = 2000;

    env.mock_all_auths();
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    env.mock_auths(&[]);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
}

#[test]
fn test_attest_fails_if_unauthorized_caller() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    let stranger = Address::generate(&env);
    let res = client.try_attest(&stranger, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::Unauthorized.into())));
}

#[test]
fn test_attest_fails_for_pending_outcome() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    let res = client.try_attest(&issuer, &id, &CommitmentStatus::Pending);
    assert_eq!(res, Err(Ok(Error::InvalidOutcome.into())));
}

#[test]
fn test_is_overdue_before_and_after_due_date() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    assert!(!client.is_overdue(&id));

    env.ledger().with_mut(|l| l.timestamp = 2000);
    assert!(!client.is_overdue(&id));

    env.ledger().with_mut(|l| l.timestamp = 2001);
    assert!(client.is_overdue(&id));

    client.attest(&issuer, &id, &CommitmentStatus::Late);
    assert!(!client.is_overdue(&id));
}

#[test]
fn test_is_overdue_fails_for_nonexistent_id() {
    let (_env, client, _issuer, _counterparty, _resolver) = setup_test();
    let res = client.try_is_overdue(&999);
    assert_eq!(res, Err(Ok(Error::CommitmentNotFound.into())));
}

#[test]
fn test_events_emitted() {
    use soroban_sdk::testutils::Events;
    use soroban_sdk::{symbol_short, FromVal, IntoVal, Val, Vec};

    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    let create_events = env.events().all();
    assert_eq!(create_events.len(), 1);
    let created_event = create_events.get(0).unwrap();
    let expected_created_topics: Vec<Val> = (
        symbol_short!("created"),
        issuer.clone(),
        counterparty.clone(),
        None::<Address>,
    )
        .into_val(&env);
    assert_eq!(created_event.0, client.address);
    assert_eq!(created_event.1, expected_created_topics);
    assert_eq!(
        <(u64, Option<u32>)>::from_val(&env, &created_event.2),
        (1u64, None)
    );

    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    let attest_events = env.events().all();
    assert_eq!(attest_events.len(), 1);
    let attested_event = attest_events.get(0).unwrap();
    let expected_attested_topics: Vec<Val> = (symbol_short!("attested"), 1u64).into_val(&env);
    assert_eq!(attested_event.0, client.address);
    assert_eq!(attested_event.1, expected_attested_topics);
    assert_eq!(
        CommitmentStatus::from_val(&env, &attested_event.2),
        CommitmentStatus::Fulfilled
    );
}

fn setup_test_with_arbitrator() -> (
    Env,
    RegistryContractClient<'static>,
    Address,
    Address,
    Address,
    Address,
) {
    let (env, client, issuer, counterparty, resolver) = setup_test();
    let arbitrator = Address::generate(&env);
    let admin = Address::generate(&env);
    client.initialize(&soroban_sdk::vec![&env, arbitrator.clone()], &admin);
    let token = env
        .register_stellar_asset_contract_v2(arbitrator.clone())
        .address();
    client.set_dispute_token(&arbitrator, &token);
    soroban_sdk::token::StellarAssetClient::new(&env, &token)
        .mint(&issuer, &(crate::commitments::DISPUTE_STAKE_AMOUNT * 10));
    soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(
        &counterparty,
        &(crate::commitments::DISPUTE_STAKE_AMOUNT * 10),
    );
    (env, client, issuer, counterparty, resolver, admin)
}

/// Initializes the contract with a committee of `count` fresh arbitrators and
/// returns the committee alongside the usual test fixtures.
fn setup_test_with_arbitrators(
    count: u32,
) -> (
    Env,
    RegistryContractClient<'static>,
    soroban_sdk::Vec<Address>,
    Address,
    Address,
    Address,
    Address,
) {
    let (env, client, issuer, counterparty, resolver) = setup_test();
    let mut arbitrators = soroban_sdk::Vec::new(&env);
    for _ in 0..count {
        arbitrators.push_back(Address::generate(&env));
    }
    let admin = Address::generate(&env);
    client.initialize(&arbitrators, &admin);
    if let Some(arb) = arbitrators.first() {
        let token = env
            .register_stellar_asset_contract_v2(arb.clone())
            .address();
        client.set_dispute_token(&arb, &token);
        soroban_sdk::token::StellarAssetClient::new(&env, &token)
            .mint(&issuer, &(crate::commitments::DISPUTE_STAKE_AMOUNT * 10));
        soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(
            &counterparty,
            &(crate::commitments::DISPUTE_STAKE_AMOUNT * 10),
        );
    }
    (
        env,
        client,
        arbitrators,
        issuer,
        counterparty,
        resolver,
        admin,
    )
}

#[test]
fn test_initialize_can_only_run_once() {
    let (env, client, _issuer, _counterparty, _resolver, _admin) = setup_test_with_arbitrator();
    let arbitrator = client.get_arbitrator();
    let admin = Address::generate(&env);
    let res = client.try_initialize(&soroban_sdk::vec![&env, arbitrator.clone()], &admin);
    assert_eq!(res, Err(Ok(Error::AlreadyInitialized.into())));
    assert_eq!(client.get_arbitrator(), arbitrator);
}

#[test]
fn test_initialize_rejects_an_empty_arbitrator_set() {
    let (env, client, _issuer, _counterparty, _resolver) = setup_test();
    let admin = Address::generate(&env);
    let res = client.try_initialize(&soroban_sdk::Vec::new(&env), &admin);
    assert_eq!(res, Err(Ok(Error::EmptyArbitratorSet.into())));
}

#[test]
fn test_initialize_stores_and_deduplicates_the_arbitrator_set() {
    let (env, client, _issuer, _counterparty, _resolver) = setup_test();

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);
    let admin = Address::generate(&env);
    let mut input = soroban_sdk::Vec::new(&env);
    input.push_back(a.clone());
    input.push_back(b.clone());
    input.push_back(a.clone()); // duplicate: must be dropped
    input.push_back(c.clone());

    client.initialize(&input, &admin);

    let expected = soroban_sdk::vec![&env, a.clone(), b.clone(), c.clone()];
    assert_eq!(client.get_arbitrators(), expected);
    // Backwards-compatible accessor returns the first member.
    assert_eq!(client.get_arbitrator(), a);
}

#[test]
fn test_get_arbitrators_fails_if_uninitialized() {
    let (_env, client, _issuer, _counterparty, _resolver) = setup_test();
    let res = client.try_get_arbitrators();
    assert_eq!(res, Err(Ok(Error::NotInitialized.into())));
}

#[test]
fn test_dispute_and_resolution_end_to_end() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Fulfilled);

    // Either party can dispute within the window
    env.ledger().with_mut(|l| l.timestamp = 1600);
    client.dispute(&counterparty, &id);

    let disputed_comm = client.get_commitment(&id);
    assert_eq!(disputed_comm.status, CommitmentStatus::Disputed);

    // Custom resolver resolves the dispute
    env.ledger().with_mut(|l| l.timestamp = 1700);
    client.resolve_dispute(&resolver, &id, &CommitmentStatus::Breached);

    let resolved_comm = client.get_commitment(&id);
    assert_eq!(resolved_comm.status, CommitmentStatus::Breached);
}

#[test]
fn test_dispute_fails_outside_dispute_window() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    // Advance timestamp beyond the dispute window (1500 + 604_800 = 606_300)
    env.ledger()
        .with_mut(|l| l.timestamp = 1500 + DISPUTE_WINDOW_SECONDS + 1);
    let res = client.try_dispute(&counterparty, &id);
    assert_eq!(res, Err(Ok(Error::DisputeWindowExpired.into())));
}

#[test]
fn test_dispute_succeeds_at_window_boundary() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    // Exactly at the boundary is allowed
    env.ledger()
        .with_mut(|l| l.timestamp = 1500 + DISPUTE_WINDOW_SECONDS);
    client.dispute(&counterparty, &id);
    let comm = client.get_commitment(&id);
    assert_eq!(comm.status, CommitmentStatus::Disputed);
}

#[test]
fn test_dispute_fails_if_caller_not_issuer_or_counterparty() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    let stranger = Address::generate(&env);
    let token: Address = env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .get(&crate::commitments::DataKey::DisputeToken)
            .unwrap()
    });
    soroban_sdk::token::StellarAssetClient::new(&env, &token)
        .mint(&stranger, &crate::commitments::DISPUTE_STAKE_AMOUNT);

    let res = client.try_dispute(&stranger, &id);
    assert_eq!(res, Err(Ok(Error::Unauthorized.into())));
}
#[test]
fn test_resolve_dispute_fails_if_caller_not_arbitrator() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    client.dispute(&counterparty, &id);

    let stranger = Address::generate(&env);
    let res = client.try_resolve_dispute(&stranger, &id, &CommitmentStatus::Breached);
    assert_eq!(res, Err(Ok(Error::NotArbitrator.into())));

    let res2 = client.try_resolve_dispute(&issuer, &id, &CommitmentStatus::Breached);
    assert_eq!(res2, Err(Ok(Error::NotArbitrator.into())));

    // Global contract arbitrator is also rejected when not the designated resolver
    let global_arbitrator = client.get_arbitrator();
    let res3 = client.try_resolve_dispute(&global_arbitrator, &id, &CommitmentStatus::Breached);
    assert_eq!(res3, Err(Ok(Error::NotArbitrator.into())));
}

#[test]
fn test_resolve_dispute_fails_if_commitment_not_disputed() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    // Pending -> resolve_dispute should fail
    let res = client.try_resolve_dispute(&resolver, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::InvalidTransition.into())));

    // Fulfilled -> resolve_dispute should fail
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    let res2 = client.try_resolve_dispute(&resolver, &id, &CommitmentStatus::Late);
    assert_eq!(res2, Err(Ok(Error::InvalidTransition.into())));
}

#[test]
fn test_resolve_dispute_rejects_invalid_final_outcome() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    client.dispute(&counterparty, &id);

    // Reject Pending
    let res1 = client.try_resolve_dispute(&resolver, &id, &CommitmentStatus::Pending);
    assert_eq!(res1, Err(Ok(Error::InvalidOutcome.into())));

    // Reject Disputed
    let res2 = client.try_resolve_dispute(&resolver, &id, &CommitmentStatus::Disputed);
    assert_eq!(res2, Err(Ok(Error::InvalidOutcome.into())));
}

// -----------------------------------------------------------------------------
// Multi-arbitrator majority-vote resolution (issue #11)
// -----------------------------------------------------------------------------

/// Creates an attested, disputed commitment whose resolver is `resolver`.
fn setup_disputed_commitment(
    env: &Env,
    client: &RegistryContractClient<'static>,
    issuer: &Address,
    counterparty: &Address,
    resolver: &Address,
) -> u64 {
    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.create_commitment(
        issuer,
        counterparty,
        &BytesN::from_array(env, &[1u8; 32]),
        &2000,
        resolver,
        &None,
        &None,
        &Vec::new(env),
        &0,
    );
    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(issuer, &id, &CommitmentStatus::Fulfilled);
    env.ledger().with_mut(|l| l.timestamp = 1600);
    client.dispute(counterparty, &id);
    id
}

#[test]
fn test_resolve_dispute_requires_a_majority_vote() {
    let (env, client, arbitrators, issuer, counterparty, _resolver, _admin) =
        setup_test_with_arbitrators(3);
    let arb0 = arbitrators.get(0).unwrap();
    let arb1 = arbitrators.get(1).unwrap();
    let arb2 = arbitrators.get(2).unwrap();

    // Naming an arbitrator as the resolver routes the dispute to the committee.
    let id = setup_disputed_commitment(&env, &client, &issuer, &counterparty, &arb0);

    // A single vote is not a majority of three (need > 3/2 = 1).
    client.resolve_dispute(&arb0, &id, &CommitmentStatus::Breached);
    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Disputed);

    // A second, agreeing arbitrator reaches the majority and finalizes.
    client.resolve_dispute(&arb1, &id, &CommitmentStatus::Breached);
    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Breached);
    assert_eq!(commitment.attested_at, None);

    // Reputation is applied exactly once, with the final majority outcome.
    let rep = client.get_reputation(&issuer);
    assert_eq!(rep.breached_count, 1);
    assert_eq!(rep.fulfilled_count, 0);

    // Once resolved, no further votes are accepted.
    let res = client.try_resolve_dispute(&arb2, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::InvalidTransition.into())));
}

#[test]
fn test_resolve_dispute_majority_wins_over_dissent() {
    let (env, client, arbitrators, issuer, counterparty, _resolver, _admin) =
        setup_test_with_arbitrators(3);
    let arb0 = arbitrators.get(0).unwrap();
    let arb1 = arbitrators.get(1).unwrap();
    let arb2 = arbitrators.get(2).unwrap();

    let id = setup_disputed_commitment(&env, &client, &issuer, &counterparty, &arb0);

    // One arbitrator votes Fulfilled, the other two vote Breached: Breached wins.
    client.resolve_dispute(&arb0, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(
        client.get_commitment(&id).status,
        CommitmentStatus::Disputed
    );

    client.resolve_dispute(&arb1, &id, &CommitmentStatus::Breached);
    assert_eq!(
        client.get_commitment(&id).status,
        CommitmentStatus::Disputed
    );

    client.resolve_dispute(&arb2, &id, &CommitmentStatus::Breached);
    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Breached);

    let rep = client.get_reputation(&issuer);
    assert_eq!(rep.breached_count, 1);
    assert_eq!(rep.fulfilled_count, 0);
}

#[test]
fn test_resolve_dispute_arbitrator_cannot_vote_twice() {
    let (env, client, arbitrators, issuer, counterparty, _resolver, _admin) =
        setup_test_with_arbitrators(3);
    let arb0 = arbitrators.get(0).unwrap();

    let id = setup_disputed_commitment(&env, &client, &issuer, &counterparty, &arb0);

    client.resolve_dispute(&arb0, &id, &CommitmentStatus::Breached);

    // The same arbitrator casting a second vote is rejected.
    let res = client.try_resolve_dispute(&arb0, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::AlreadyVoted.into())));

    // The dispute is still open for the other arbitrators.
    assert_eq!(
        client.get_commitment(&id).status,
        CommitmentStatus::Disputed
    );
}

#[test]
fn test_resolve_dispute_half_the_committee_is_not_enough() {
    let (env, client, arbitrators, issuer, counterparty, _resolver, _admin) =
        setup_test_with_arbitrators(2);
    let arb0 = arbitrators.get(0).unwrap();
    let arb1 = arbitrators.get(1).unwrap();

    let id = setup_disputed_commitment(&env, &client, &issuer, &counterparty, &arb0);

    // With two arbitrators, one vote is exactly half — not a majority.
    client.resolve_dispute(&arb0, &id, &CommitmentStatus::Late);
    assert_eq!(
        client.get_commitment(&id).status,
        CommitmentStatus::Disputed
    );

    // The second (and last) vote reaches unanimity and finalizes.
    client.resolve_dispute(&arb1, &id, &CommitmentStatus::Late);
    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Late);
    assert_eq!(client.get_reputation(&issuer).late_count, 1);
}

#[test]
fn test_resolve_dispute_single_arbitrator_finalizes_on_first_vote() {
    let (env, client, arbitrators, issuer, counterparty, _resolver, _admin) =
        setup_test_with_arbitrators(1);
    let arb0 = arbitrators.get(0).unwrap();

    let id = setup_disputed_commitment(&env, &client, &issuer, &counterparty, &arb0);

    // One arbitrator: the first vote already exceeds half (1 > 0).
    client.resolve_dispute(&arb0, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(
        client.get_commitment(&id).status,
        CommitmentStatus::Fulfilled
    );
}

#[test]
fn test_resolve_dispute_committee_cannot_vote_on_custom_resolver_commitment() {
    let (env, client, arbitrators, issuer, counterparty, _resolver, _admin) =
        setup_test_with_arbitrators(3);
    let arb0 = arbitrators.get(0).unwrap();

    // A custom resolver outside the committee keeps full control of its dispute.
    let custom_resolver = Address::generate(&env);
    let id = setup_disputed_commitment(&env, &client, &issuer, &counterparty, &custom_resolver);

    // No committee member may vote on it.
    let res = client.try_resolve_dispute(&arb0, &id, &CommitmentStatus::Breached);
    assert_eq!(res, Err(Ok(Error::NotArbitrator.into())));

    // The designated custom resolver still resolves it directly.
    client.resolve_dispute(&custom_resolver, &id, &CommitmentStatus::Breached);
    assert_eq!(
        client.get_commitment(&id).status,
        CommitmentStatus::Breached
    );
}

#[test]
fn test_dispute_fails_if_pending() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    let res = client.try_dispute(&issuer, &id);
    assert_eq!(res, Err(Ok(Error::InvalidTransition.into())));
}

#[test]
fn test_dispute_fails_if_already_disputed() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    client.dispute(&counterparty, &id);

    // Try disputing again while Disputed
    let res = client.try_dispute(&counterparty, &id);
    assert_eq!(res, Err(Ok(Error::InvalidTransition.into())));
}

#[test]
fn test_attest_fails_for_disputed_outcome() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    let res = client.try_attest(&issuer, &id, &CommitmentStatus::Disputed);
    assert_eq!(res, Err(Ok(Error::InvalidOutcome.into())));
}

#[test]
fn test_dispute_events_emitted() {
    use soroban_sdk::testutils::Events;
    use soroban_sdk::{symbol_short, FromVal, IntoVal, Val, Vec};

    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    client.dispute(&counterparty, &id);

    let all_events = env.events().all();
    let disputed_event = all_events.get(all_events.len() - 1).unwrap();
    let expected_disputed_topics: Vec<Val> = (symbol_short!("disputed"), 1u64).into_val(&env);
    assert_eq!(disputed_event.0, client.address);
    assert_eq!(disputed_event.1, expected_disputed_topics);
    assert_eq!(<()>::from_val(&env, &disputed_event.2), ());

    client.resolve_dispute(&resolver, &id, &CommitmentStatus::Late);

    let all_events_after = env.events().all();
    let resolved_event = all_events_after.get(all_events_after.len() - 1).unwrap();
    let expected_resolved_topics: Vec<Val> = (symbol_short!("resolved"), 1u64).into_val(&env);
    assert_eq!(resolved_event.0, client.address);
    assert_eq!(resolved_event.1, expected_resolved_topics);
    assert_eq!(
        CommitmentStatus::from_val(&env, &resolved_event.2),
        CommitmentStatus::Late
    );
}

#[test]
#[should_panic]
fn test_dispute_requires_auth() {
    let env = Env::default();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    let counterparty = Address::generate(&env);
    let resolver = Address::generate(&env);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    env.mock_all_auths();
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    env.mock_auths(&[]);
    client.dispute(&counterparty, &id);
}

#[test]
#[should_panic]
fn test_resolve_dispute_requires_auth() {
    let env = Env::default();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    let counterparty = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let resolver = Address::generate(&env);
    let admin = Address::generate(&env);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);

    env.mock_all_auths();
    client.initialize(&soroban_sdk::vec![&env, arbitrator.clone()], &admin);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    client.dispute(&counterparty, &id);

    env.mock_auths(&[]);
    client.resolve_dispute(&resolver, &id, &CommitmentStatus::Late);
}

#[test]
#[should_panic]
fn test_initialize_requires_auth() {
    let env = Env::default();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let arbitrator = Address::generate(&env);
    let admin = Address::generate(&env);

    client.initialize(&soroban_sdk::vec![&env, arbitrator.clone()], &admin);
}

// -----------------------------------------------------------------------------
// Phase 4 - Reputation Tests
// -----------------------------------------------------------------------------

#[test]
fn test_get_reputation_zeroed_for_new_address() {
    let (_env, client, _issuer, _counterparty, _resolver) = setup_test();
    let new_issuer = Address::generate(&_env);

    let rep = client.get_reputation(&new_issuer);
    assert_eq!(rep.fulfilled_count, 0);
    assert_eq!(rep.late_count, 0);
    assert_eq!(rep.breached_count, 0);
}

#[test]
fn test_reputation_increments_direct_attestation() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let due_at = 2000;

    // Create and fulfill first commitment
    let id1 = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[1u8; 32]),
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id1, &CommitmentStatus::Fulfilled);

    let rep1 = client.get_reputation(&issuer);
    assert_eq!(rep1.fulfilled_count, 1);
    assert_eq!(rep1.late_count, 0);
    assert_eq!(rep1.breached_count, 0);

    // Create and late second commitment
    let id2 = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[2u8; 32]),
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id2, &CommitmentStatus::Late);

    let rep2 = client.get_reputation(&issuer);
    assert_eq!(rep2.fulfilled_count, 1);
    assert_eq!(rep2.late_count, 1);
    assert_eq!(rep2.breached_count, 0);

    // Create and breach third commitment
    let id3 = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[3u8; 32]),
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id3, &CommitmentStatus::Breached);

    let rep3 = client.get_reputation(&issuer);
    assert_eq!(rep3.fulfilled_count, 1);
    assert_eq!(rep3.late_count, 1);
    assert_eq!(rep3.breached_count, 1);
}

#[test]
fn test_reputation_not_incremented_when_disputed() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    // Initial attestation increments it
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    let rep_before = client.get_reputation(&issuer);
    assert_eq!(rep_before.fulfilled_count, 1);

    // Dispute decrements it back to 0
    client.dispute(&counterparty, &id);
    let rep_after = client.get_reputation(&issuer);
    assert_eq!(rep_after.fulfilled_count, 0);
    assert_eq!(rep_after.late_count, 0);
    assert_eq!(rep_after.breached_count, 0);
}

#[test]
fn test_reputation_reflects_final_outcome_after_dispute() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[1u8; 32]),
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    // 1. Attest as Breached
    client.attest(&issuer, &id, &CommitmentStatus::Breached);
    let rep1 = client.get_reputation(&issuer);
    assert_eq!(rep1.breached_count, 1);

    // 2. Dispute
    client.dispute(&counterparty, &id);
    let rep2 = client.get_reputation(&issuer);
    assert_eq!(rep2.breached_count, 0); // Decr old outcome

    // 3. Resolve as Fulfilled
    client.resolve_dispute(&resolver, &id, &CommitmentStatus::Fulfilled);
    let rep3 = client.get_reputation(&issuer);

    // Most important check: ONLY final outcome is counted
    assert_eq!(rep3.fulfilled_count, 1);
    assert_eq!(rep3.breached_count, 0);
    assert_eq!(rep3.late_count, 0);
}

#[test]
fn test_reputation_aggregates_multiple_commitments() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);

    // Comm 1: Fulfilled (direct)
    let id1 = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[1u8; 32]),
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id1, &CommitmentStatus::Fulfilled);

    // Comm 2: Late (disputed, resolved as Late)
    let id2 = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[2u8; 32]),
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id2, &CommitmentStatus::Fulfilled); // Attested as Fulfilled initially
    client.dispute(&counterparty, &id2);
    client.resolve_dispute(&resolver, &id2, &CommitmentStatus::Late); // Overturned to Late

    // Comm 3: Breached (direct)
    let id3 = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[3u8; 32]),
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id3, &CommitmentStatus::Breached);

    // Comm 4: Fulfilled (direct)
    let id4 = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[4u8; 32]),
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id4, &CommitmentStatus::Fulfilled);

    let rep = client.get_reputation(&issuer);
    assert_eq!(rep.fulfilled_count, 2); // Comm 1, Comm 4
    assert_eq!(rep.late_count, 1); // Comm 2
    assert_eq!(rep.breached_count, 1); // Comm 3
}

// -----------------------------------------------------------------------------
// Phase 5 - Hardening & Edge Cases
// -----------------------------------------------------------------------------

#[test]
fn test_create_commitment_fails_if_due_at_is_current_timestamp() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 1000; // Exactly current timestamp

    let res = client.try_create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    assert_eq!(res, Err(Ok(Error::DueAtInPast.into())));
}

#[test]
fn test_dispute_fails_if_already_resolved() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    // Attest, dispute, resolve
    client.attest(&issuer, &id, &CommitmentStatus::Late);
    client.dispute(&counterparty, &id);
    client.resolve_dispute(&resolver, &id, &CommitmentStatus::Fulfilled);

    // Try disputing again after final resolution
    let res = client.try_dispute(&counterparty, &id);
    assert_eq!(res, Err(Ok(Error::InvalidTransition.into())));
}

#[test]
fn test_realistic_sequence() {
    // create -> attest late -> dispute -> resolve fulfilled -> verify reputation
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    env.ledger().with_mut(|l| l.timestamp = 2500); // Late
    client.attest(&issuer, &id, &CommitmentStatus::Late);

    let rep_after_attest = client.get_reputation(&issuer);
    assert_eq!(rep_after_attest.late_count, 1);

    client.dispute(&counterparty, &id);
    let rep_after_dispute = client.get_reputation(&issuer);
    assert_eq!(rep_after_dispute.late_count, 0); // Decremented

    client.resolve_dispute(&resolver, &id, &CommitmentStatus::Fulfilled);

    let rep_final = client.get_reputation(&issuer);
    assert_eq!(rep_final.fulfilled_count, 1);
    assert_eq!(rep_final.late_count, 0);
    assert_eq!(rep_final.breached_count, 0);

    let comm = client.get_commitment(&id);
    assert_eq!(comm.status, CommitmentStatus::Fulfilled);
}

// -----------------------------------------------------------------------------
// TrustGate Phase B - Reentrancy Hardening
// -----------------------------------------------------------------------------

#[test]
fn test_reentrancy_attack_during_resolve_dispute_is_blocked() {
    use crate::attacker_gate::{AttackerGate, AttackerGateClient};
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    use soroban_sdk::IntoVal;

    let (env, client, issuer, counterparty, _resolver) = setup_test();

    // Register the malicious mock as a real contract (not via mock_auths,
    // which would silently replace it with a no-op stand-in) so that its
    // __check_auth implementation is genuinely invoked.
    let attacker_id = env.register(AttackerGate, ());
    let attacker_client = AttackerGateClient::new(&env, &attacker_id);
    let admin = Address::generate(&env);

    client.initialize(&soroban_sdk::vec![&env, attacker_id.clone()], &admin);
    let token = env
        .register_stellar_asset_contract_v2(attacker_id.clone())
        .address();
    client.set_dispute_token(&attacker_id, &token);
    soroban_sdk::token::StellarAssetClient::new(&env, &token)
        .mint(&counterparty, &crate::commitments::DISPUTE_STAKE_AMOUNT);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[7u8; 32]),
        &2000,
        &attacker_id,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    client.dispute(&counterparty, &id);

    attacker_client.init(&client.address, &id);

    // Disable auth mocking and supply a real Address-credentialed auth entry
    // for the attacker, so the host actually invokes AttackerGate's
    // __check_auth instead of bypassing it (mocked auths never invoke a
    // custom account's __check_auth).
    env.set_auths(&[(&MockAuth {
        address: &attacker_id,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "resolve_dispute",
            args: (attacker_id.clone(), id, CommitmentStatus::Fulfilled).into_val(&env),
            sub_invokes: &[],
        },
    })
        .into()]);

    // Legitimate resolution by the arbitrator. Mid-flight, inside
    // __check_auth, AttackerGate attempts to re-enter resolve_dispute for
    // the same commitment to double-process it before the first call has
    // applied its state changes.
    client.resolve_dispute(&attacker_id, &id, &CommitmentStatus::Fulfilled);

    // The reentrant call must have been rejected by the reentrancy guard.
    assert!(
        attacker_client.reentry_was_blocked(),
        "diag_code={}",
        attacker_client.diag_code()
    );

    // The legitimate call must have completed exactly once, with correct
    // final state and no double-counted reputation.
    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Fulfilled);

    let rep = client.get_reputation(&issuer);
    assert_eq!(rep.fulfilled_count, 1);
    assert_eq!(rep.late_count, 0);
    assert_eq!(rep.breached_count, 0);
}

#[test]
fn test_reentrant_attest_call_is_rejected() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[1u8; 32]),
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    // Simulate a stuck guard (as if a nested call were already in progress)
    // and verify a top-level mutating call is rejected while it is locked.
    env.as_contract(&client.address, || {
        crate::reentrancy::enter(&env);
    });

    let res = client.try_attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::ReentrantCall.into())));

    env.as_contract(&client.address, || {
        crate::reentrancy::exit(&env);
    });

    // Once released, the call succeeds normally.
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Fulfilled);
}

#[test]
fn test_get_trust_score_reflects_outcomes() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);

    assert_eq!(client.get_trust_score(&issuer).unwrap(), 50);

    let id1 = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[1u8; 32]),
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id1, &CommitmentStatus::Fulfilled);
    assert_eq!(client.get_trust_score(&issuer).unwrap(), 60);

    let id2 = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[2u8; 32]),
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id2, &CommitmentStatus::Late);
    assert_eq!(client.get_trust_score(&issuer).unwrap(), 50);

    let id3 = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[3u8; 32]),
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id3, &CommitmentStatus::Breached);
    assert_eq!(client.get_trust_score(&issuer).unwrap(), 0);
}
// -----------------------------------------------------------------------------
// Pausable Protocol - Emergency Halt Tests
// -----------------------------------------------------------------------------

#[test]
fn test_pause_blocks_write_functions() {
    let (env, client, issuer, counterparty, resolver, admin) = setup_test_with_arbitrator();
    let arbitrator = client.get_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &soroban_sdk::Vec::new(&env),
        &0,
    );
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    client.pause(&admin);
    assert!(client.is_paused());

    // create_commitment reverts with ProtocolPaused
    let res = client.try_create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &3000,
        &resolver,
        &None,
        &None,
        &soroban_sdk::Vec::new(&env),
        &0,
    );
    assert_eq!(res, Err(Ok(Error::ProtocolPaused.into())));

    // attest reverts with ProtocolPaused
    let res = client.try_attest(&issuer, &id, &CommitmentStatus::Late);
    assert_eq!(res, Err(Ok(Error::ProtocolPaused.into())));

    // dispute reverts with ProtocolPaused
    let res = client.try_dispute(&counterparty, &id);
    assert_eq!(res, Err(Ok(Error::ProtocolPaused.into())));

    // resolve_dispute reverts with ProtocolPaused
    let res = client.try_resolve_dispute(&arbitrator, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::ProtocolPaused.into())));

    // State is unchanged while paused.
    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Fulfilled);
}

#[test]
fn test_read_functions_succeed_while_paused() {
    let (env, client, issuer, counterparty, resolver, admin) = setup_test_with_arbitrator();
    let arbitrator = client.get_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[1u8; 32]),
        &2000,
        &resolver,
        &None,
        &None,
        &soroban_sdk::Vec::new(&env),
        &0,
    );

    client.pause(&admin);

    // get_commitment continues to work.
    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.id, id);

    // get_reputation continues to work.
    let rep = client.get_reputation(&issuer);
    assert_eq!(rep.fulfilled_count, 0);
    assert_eq!(rep.late_count, 0);
    assert_eq!(rep.breached_count, 0);

    // get_trust_score continues to work.
    assert_eq!(client.get_trust_score(&issuer).unwrap(), 50);

    // get_arbitrator continues to work.
    assert_eq!(client.get_arbitrator(), arbitrator);

    // is_overdue continues to work.
    assert!(!client.is_overdue(&id));

    // is_paused reflects the paused state.
    assert!(client.is_paused());
}

#[test]
fn test_pause_requires_admin() {
    let (_env, client, _issuer, _counterparty, _resolver, admin) = setup_test_with_arbitrator();

    let stranger = Address::generate(&_env);
    let res = client.try_pause(&stranger);
    assert_eq!(res, Err(Ok(Error::NotAdmin.into())));

    let res = client.try_unpause(&stranger);
    assert_eq!(res, Err(Ok(Error::NotAdmin.into())));

    assert!(!client.is_paused());

    // Admin can pause
    client.pause(&admin);
    assert!(client.is_paused());

    // Admin can unpause
    client.unpause(&admin);
    assert!(!client.is_paused());
}

#[test]
fn test_pause_fails_if_not_initialized() {
    let (env, client, _issuer, _counterparty, _resolver) = setup_test();
    let admin = Address::generate(&env);

    let res = client.try_pause(&admin);
    assert_eq!(res, Err(Ok(Error::NotInitialized.into())));

    let res = client.try_unpause(&admin);
    assert_eq!(res, Err(Ok(Error::NotInitialized.into())));
}

#[test]
fn test_unpause_restores_write_functions() {
    let (env, client, issuer, counterparty, resolver, admin) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);

    client.pause(&admin);
    let res = client.try_create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &2000,
        &resolver,
        &None,
        &None,
        &soroban_sdk::Vec::new(&env),
        &0,
    );
    assert_eq!(res, Err(Ok(Error::ProtocolPaused.into())));

    client.unpause(&admin);
    assert!(!client.is_paused());

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &2000,
        &resolver,
        &None,
        &None,
        &soroban_sdk::Vec::new(&env),
        &0,
    );
    assert_eq!(id, 1);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Fulfilled);
}

#[test]
#[should_panic]
fn test_pause_requires_auth() {
    let env = Env::default();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let arbitrator = Address::generate(&env);
    let admin = Address::generate(&env);

    env.mock_all_auths();
    client.initialize(&soroban_sdk::vec![&env, arbitrator.clone()], &admin);

    env.mock_auths(&[]);
    client.pause(&admin);
}

#[test]
#[should_panic]
fn test_unpause_requires_auth() {
    let env = Env::default();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let arbitrator = Address::generate(&env);
    let admin = Address::generate(&env);

    env.mock_all_auths();
    client.initialize(&soroban_sdk::vec![&env, arbitrator.clone()], &admin);
    client.pause(&admin);

    env.mock_auths(&[]);
    client.unpause(&admin);
}

#[test]
fn test_pause_and_unpause_events_emitted() {
    use soroban_sdk::testutils::Events;
    use soroban_sdk::{symbol_short, IntoVal, Val, Vec};

    let (env, client, _issuer, _counterparty, _resolver, admin) = setup_test_with_arbitrator();

    client.pause(&admin);

    let events_after_pause = env.events().all();
    let paused_event = events_after_pause
        .get(events_after_pause.len() - 1)
        .unwrap();
    let expected_paused_topics: Vec<Val> = (symbol_short!("paused"),).into_val(&env);
    assert_eq!(paused_event.1, expected_paused_topics);

    client.unpause(&admin);

    let events_after_unpause = env.events().all();
    let unpaused_event = events_after_unpause
        .get(events_after_unpause.len() - 1)
        .unwrap();
    let expected_unpaused_topics: Vec<Val> = (symbol_short!("unpaused"),).into_val(&env);
    assert_eq!(unpaused_event.1, expected_unpaused_topics);
}

#[test]
fn test_admin_lifecycle_operations_exempt_from_pause() {
    let (env, client, _issuer, _counterparty, _resolver, admin) = setup_test_with_arbitrator();

    client.pause(&admin);
    assert!(client.is_paused());

    // upgrade is an admin lifecycle operation exempt from the pause: with no
    // upgrade admin installed it is still rejected by the admin gate
    // (UpgradeAdminNotSet), not by the pause gate (ProtocolPaused).
    let mock_wasm_hash = BytesN::from_array(&env, &[2u8; 32]);
    let res = client.try_upgrade(&mock_wasm_hash, &SCHEMA_VERSION_V1);
    assert_eq!(res, Err(Ok(Error::UpgradeAdminNotSet.into())));

    // pause/unpause remain callable by the admin while paused.
    client.pause(&admin);
    assert!(client.is_paused());
    client.unpause(&admin);
    assert!(!client.is_paused());
}

#[test]
fn test_custom_resolver_delegation() {
    let (env, client, issuer, counterparty, _default_resolver, _admin) =
        setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[9u8; 32]);
    let due_at = 2000;

    // Designate a custom resolver address
    let custom_resolver = Address::generate(&env);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &custom_resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    let comm = client.get_commitment(&id);
    assert_eq!(comm.resolver_address, custom_resolver);

    // Attest and dispute
    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    client.dispute(&counterparty, &id);

    // Global arbitrator cannot resolve when a custom resolver is assigned
    let global_arbitrator = client.get_arbitrator();
    let res_arb = client.try_resolve_dispute(&global_arbitrator, &id, &CommitmentStatus::Breached);
    assert_eq!(res_arb, Err(Ok(Error::NotArbitrator.into())));

    // Custom resolver successfully resolves
    client.resolve_dispute(&custom_resolver, &id, &CommitmentStatus::Breached);
    let resolved = client.get_commitment(&id);
    assert_eq!(resolved.status, CommitmentStatus::Breached);
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct PreOracleCommitment {
    id: u64,
    issuer: Address,
    counterparty: Address,
    terms_hash: BytesN<32>,
    due_at: u64,
    status: CommitmentStatus,
    created_at: u64,
    attested_at: Option<u64>,
}

#[test]
fn test_legacy_commitment_storage_migration() {
    let (env, client, issuer, counterparty, _default_resolver, _admin) =
        setup_test_with_arbitrator();

    // Directly seed a LegacyCommitment in persistent storage (simulating pre-upgrade storage)
    let arbitrator = client.get_arbitrator();
    let legacy_id = 99u64;
    let legacy_comm = PreOracleCommitment {
        id: legacy_id,
        issuer: issuer.clone(),
        counterparty: counterparty.clone(),
        terms_hash: BytesN::from_array(&env, &[5u8; 32]),
        due_at: 2000,
        status: CommitmentStatus::Fulfilled,
        created_at: 1000,
        attested_at: Some(1500),
    };

    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&commitments::DataKey::Commitment(legacy_id), &legacy_comm);
    });

    // Reading via get_commitment migrates the legacy record and assigns fallback arbitrator as resolver
    let migrated = client.get_commitment(&legacy_id);
    assert_eq!(migrated.id, legacy_id);
    assert_eq!(migrated.resolver_address, arbitrator);
    assert_eq!(migrated.status, CommitmentStatus::Fulfilled);
    assert_eq!(migrated.oracle, None);
    assert_eq!(migrated.schema_id, None);

    // Raising a dispute on the migrated commitment works and resolves with the fallback arbitrator
    env.ledger().with_mut(|l| l.timestamp = 1600);
    client.dispute(&counterparty, &legacy_id);
    client.resolve_dispute(&arbitrator, &legacy_id, &CommitmentStatus::Breached);

    let final_comm = client.get_commitment(&legacy_id);
    assert_eq!(final_comm.status, CommitmentStatus::Breached);
}

/// Shape of a record written after milestone support landed but before
/// attestor-panel voting (`attestors` / `vote_threshold`) was added.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct PreAttestorVotingCommitment {
    id: u64,
    issuer: Address,
    counterparty: Address,
    terms_hash: BytesN<32>,
    due_at: u64,
    status: CommitmentStatus,
    created_at: u64,
    attested_at: Option<u64>,
    resolver_address: Address,
    milestone_count: u32,
    milestones_attested: u32,
    late_milestones: u32,
    oracle: Option<Address>,
    schema_id: Option<u32>,
}

#[test]
fn test_mid_tier_milestone_commitment_migration_preserves_counters() {
    let (env, client, issuer, counterparty, resolver, _admin) = setup_test_with_arbitrator();

    let mid_id = 77u64;
    let mid_comm = PreAttestorVotingCommitment {
        id: mid_id,
        issuer: issuer.clone(),
        counterparty: counterparty.clone(),
        terms_hash: BytesN::from_array(&env, &[6u8; 32]),
        due_at: 2000,
        status: CommitmentStatus::Pending,
        created_at: 1000,
        attested_at: None,
        resolver_address: resolver.clone(),
        milestone_count: 3,
        milestones_attested: 1,
        late_milestones: 0,
        oracle: None,
        schema_id: None,
    };

    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&commitments::DataKey::Commitment(mid_id), &mid_comm);
    });

    // The real milestone counters must survive migration rather than being
    // collapsed to a single already-resolved milestone.
    let migrated = client.get_commitment(&mid_id);
    assert_eq!(migrated.id, mid_id);
    assert_eq!(migrated.resolver_address, resolver);
    assert_eq!(migrated.milestone_count(), 3);
    assert_eq!(migrated.milestones_attested(), 1);
    assert_eq!(migrated.late_milestones(), 0);
    assert!(migrated.attestors.is_empty());
    assert_eq!(migrated.vote_threshold(), 0);

    // The commitment stays usable: the next milestone can still be attested.
    client.attest_milestone(&issuer, &mid_id, &1, &CommitmentStatus::Fulfilled);
    assert_eq!(client.get_commitment(&mid_id).milestones_attested(), 2);
}

#[test]
fn test_legacy_commitment_migration_fails_if_uninitialized() {
    // Set up uninitialized contract
    let (env, client, issuer, counterparty, _resolver) = setup_test();

    let legacy_id = 101u64;
    let legacy_comm = PreOracleCommitment {
        id: legacy_id,
        issuer: issuer.clone(),
        counterparty: counterparty.clone(),
        terms_hash: BytesN::from_array(&env, &[7u8; 32]),
        due_at: 2000,
        status: CommitmentStatus::Fulfilled,
        created_at: 1000,
        attested_at: Some(1500),
    };

    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&commitments::DataKey::Commitment(legacy_id), &legacy_comm);
    });

    // Reading legacy commitment without an initialized arbitrator fails with NotInitialized
    let res = client.try_get_commitment(&legacy_id);
    assert_eq!(res, Err(Ok(Error::NotInitialized.into())));
}

#[test]
fn test_legacy_commitment_migration_fails_if_payload_id_mismatch() {
    let (env, client, issuer, counterparty, _resolver, _admin) = setup_test_with_arbitrator();

    let storage_key_id = 200u64;
    let payload_id = 999u64; // Inconsistent with storage key
    let legacy_comm = PreOracleCommitment {
        id: payload_id,
        issuer: issuer.clone(),
        counterparty: counterparty.clone(),
        terms_hash: BytesN::from_array(&env, &[8u8; 32]),
        due_at: 2000,
        status: CommitmentStatus::Pending,
        created_at: 1000,
        attested_at: None,
    };

    env.as_contract(&client.address, || {
        env.storage().persistent().set(
            &commitments::DataKey::Commitment(storage_key_id),
            &legacy_comm,
        );
    });

    let res = client.try_get_commitment(&storage_key_id);
    assert_eq!(res, Err(Ok(Error::CommitmentNotFound.into())));
}

fn setup_milestone_commitment(
    milestone_count: u32,
) -> (Env, RegistryContractClient<'static>, Address, Address, u64) {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[7u8; 32]);
    let id = client.create_milestone_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &2000,
        &resolver,
        &milestone_count,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    (env, client, issuer, counterparty, id)
}

#[test]
fn test_create_commitment_defaults_to_a_single_milestone() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.milestone_count(), 1);
}

#[test]
fn test_create_milestone_commitment_rejects_zero_milestones() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);

    let res = client.try_create_milestone_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &2000,
        &resolver,
        &0,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    assert_eq!(res, Err(Ok(Error::InvalidMilestoneCount.into())));
}

#[test]
fn test_create_milestone_commitment_rejects_more_than_max_milestones() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let too_many = crate::commitments::MAX_MILESTONES + 1;

    let res = client.try_create_milestone_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &2000,
        &resolver,
        &too_many,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    assert_eq!(res, Err(Ok(Error::InvalidMilestoneCount.into())));
}

#[test]
fn test_commitment_stays_pending_until_the_final_milestone() {
    let (_env, client, issuer, _counterparty, id) = setup_milestone_commitment(3);

    client.attest_milestone(&issuer, &id, &0, &CommitmentStatus::Fulfilled);
    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Pending);
    assert_eq!(commitment.milestones_attested(), 1);
    assert_eq!(commitment.attested_at, None);

    client.attest_milestone(&issuer, &id, &1, &CommitmentStatus::Fulfilled);
    assert_eq!(client.get_commitment(&id).status, CommitmentStatus::Pending);

    client.attest_milestone(&issuer, &id, &2, &CommitmentStatus::Fulfilled);
    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Fulfilled);
    assert_eq!(commitment.milestones_attested(), 3);
    assert_eq!(commitment.attested_at, Some(1000));
}

#[test]
fn test_create_milestone_commitment_initializes_counters() {
    let (_env, client, _issuer, _counterparty, id) = setup_milestone_commitment(4);

    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.milestone_count(), 4);
    assert_eq!(commitment.milestones_attested(), 0);
    assert_eq!(commitment.late_milestones(), 0);
    assert_eq!(commitment.status, CommitmentStatus::Pending);
}

#[test]
fn test_commitment_resolves_late_when_any_milestone_is_late() {
    let (_env, client, issuer, counterparty, id) = setup_milestone_commitment(3);

    client.attest_milestone(&issuer, &id, &0, &CommitmentStatus::Fulfilled);
    client.attest_milestone(&counterparty, &id, &1, &CommitmentStatus::Late);
    client.attest_milestone(&issuer, &id, &2, &CommitmentStatus::Fulfilled);

    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Late);
    assert_eq!(commitment.late_milestones(), 1);
    assert_eq!(client.get_reputation(&issuer).late_count, 1);
    assert_eq!(client.get_reputation(&issuer).fulfilled_count, 0);
}

#[test]
fn test_breached_milestone_resolves_the_commitment_immediately() {
    let (_env, client, issuer, _counterparty, id) = setup_milestone_commitment(4);

    client.attest_milestone(&issuer, &id, &0, &CommitmentStatus::Fulfilled);
    client.attest_milestone(&issuer, &id, &1, &CommitmentStatus::Breached);

    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Breached);
    assert_eq!(commitment.milestones_attested(), 2);
    assert_eq!(commitment.attested_at, Some(1000));
    assert_eq!(client.get_reputation(&issuer).breached_count, 1);

    let res = client.try_attest_milestone(&issuer, &id, &2, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::AlreadyResolved.into())));
}

#[test]
fn test_attest_walks_milestones_in_order_without_an_index() {
    let (_env, client, issuer, _counterparty, id) = setup_milestone_commitment(3);

    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(client.get_commitment(&id).status, CommitmentStatus::Pending);

    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(
        client.get_commitment(&id).status,
        CommitmentStatus::Fulfilled
    );
}

#[test]
fn test_attest_milestone_rejects_an_out_of_range_index() {
    let (_env, client, issuer, _counterparty, id) = setup_milestone_commitment(2);

    let res = client.try_attest_milestone(&issuer, &id, &2, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::InvalidMilestoneIndex.into())));
}

#[test]
fn test_attest_milestone_rejects_an_already_attested_index() {
    let (_env, client, issuer, _counterparty, id) = setup_milestone_commitment(3);

    client.attest_milestone(&issuer, &id, &0, &CommitmentStatus::Fulfilled);

    let res = client.try_attest_milestone(&issuer, &id, &0, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::MilestoneAlreadyAttested.into())));
}

#[test]
fn test_attest_milestone_rejects_an_out_of_order_index() {
    let (_env, client, issuer, _counterparty, id) = setup_milestone_commitment(3);

    let res = client.try_attest_milestone(&issuer, &id, &1, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::MilestoneOutOfOrder.into())));
}

#[test]
fn test_attest_milestone_rejects_an_unauthorized_caller() {
    let (env, client, _issuer, _counterparty, id) = setup_milestone_commitment(2);

    let stranger = Address::generate(&env);
    let res = client.try_attest_milestone(&stranger, &id, &0, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::Unauthorized.into())));
}

#[test]
fn test_get_milestone_returns_recorded_outcomes() {
    let (_env, client, issuer, _counterparty, id) = setup_milestone_commitment(3);

    assert_eq!(client.get_milestone(&id, &0), None);

    client.attest_milestone(&issuer, &id, &0, &CommitmentStatus::Fulfilled);
    client.attest_milestone(&issuer, &id, &1, &CommitmentStatus::Late);

    assert_eq!(
        client.get_milestone(&id, &0),
        Some(CommitmentStatus::Fulfilled)
    );
    assert_eq!(client.get_milestone(&id, &1), Some(CommitmentStatus::Late));
    assert_eq!(client.get_milestone(&id, &2), None);
}

#[test]
fn test_get_milestone_falls_back_to_legacy_persistent_storage() {
    let (_env, client, _issuer, _counterparty, id) = setup_milestone_commitment(2);

    // Simulate a milestone outcome written before Milestone records moved
    // from Persistent to Temporary storage.
    _env.as_contract(&client.address, || {
        _env.storage().persistent().set(
            &commitments::DataKey::Milestone(id, 0),
            &CommitmentStatus::Fulfilled,
        );
    });

    assert_eq!(
        client.get_milestone(&id, &0),
        Some(CommitmentStatus::Fulfilled)
    );
}

#[test]
fn test_get_milestone_rejects_an_out_of_range_index() {
    let (_env, client, _issuer, _counterparty, id) = setup_milestone_commitment(2);

    let res = client.try_get_milestone(&id, &5);
    assert_eq!(res, Err(Ok(Error::InvalidMilestoneIndex.into())));
}

#[test]
fn test_get_milestone_extends_the_milestone_ttl() {
    use soroban_sdk::testutils::storage::Temporary as _;

    let (env, client, issuer, _counterparty, id) = setup_milestone_commitment(2);

    client.attest_milestone(&issuer, &id, &0, &CommitmentStatus::Fulfilled);

    let key = crate::commitments::DataKey::Milestone(id, 0);
    let ttl = || env.as_contract(&client.address, || env.storage().temporary().get_ttl(&key));

    // Age the entry past the bump threshold without letting it expire.
    let aged_by =
        crate::commitments::TTL_EXTEND_LEDGERS - crate::commitments::TTL_THRESHOLD_LEDGERS + 10_000;
    env.ledger().with_mut(|l| l.sequence_number += aged_by);
    assert!(ttl() < crate::commitments::TTL_THRESHOLD_LEDGERS);

    assert_eq!(
        client.get_milestone(&id, &0),
        Some(CommitmentStatus::Fulfilled)
    );
    assert_eq!(ttl(), crate::commitments::TTL_EXTEND_LEDGERS);
}

#[test]
fn test_reputation_counts_a_milestone_commitment_once() {
    let (_env, client, issuer, _counterparty, id) = setup_milestone_commitment(3);

    client.attest_milestone(&issuer, &id, &0, &CommitmentStatus::Fulfilled);
    client.attest_milestone(&issuer, &id, &1, &CommitmentStatus::Fulfilled);
    assert_eq!(client.get_reputation(&issuer).fulfilled_count, 0);

    client.attest_milestone(&issuer, &id, &2, &CommitmentStatus::Fulfilled);
    let reputation = client.get_reputation(&issuer);
    assert_eq!(reputation.fulfilled_count, 1);
    assert_eq!(reputation.late_count, 0);
    assert_eq!(reputation.breached_count, 0);
}

#[test]
fn test_milestone_attested_events_emitted() {
    use soroban_sdk::testutils::Events;
    use soroban_sdk::{symbol_short, FromVal, IntoVal, Val, Vec};

    let (env, client, issuer, _counterparty, id) = setup_milestone_commitment(2);

    client.attest_milestone(&issuer, &id, &0, &CommitmentStatus::Late);

    let events = env.events().all();
    assert_eq!(events.len(), 1);
    let milestone_event = events.get(0).unwrap();
    let expected_topics: Vec<Val> = (symbol_short!("milestone"), id).into_val(&env);
    assert_eq!(milestone_event.0, client.address);
    assert_eq!(milestone_event.1, expected_topics);
    assert_eq!(
        <(u32, CommitmentStatus)>::from_val(&env, &milestone_event.2),
        (0u32, CommitmentStatus::Late)
    );

    client.attest_milestone(&issuer, &id, &1, &CommitmentStatus::Fulfilled);

    let events = env.events().all();
    assert_eq!(events.len(), 2);
    assert_eq!(
        <(u32, CommitmentStatus)>::from_val(&env, &events.get(0).unwrap().2),
        (1u32, CommitmentStatus::Fulfilled)
    );

    let attested_event = events.get(1).unwrap();
    let expected_attested_topics: Vec<Val> = (symbol_short!("attested"), id).into_val(&env);
    assert_eq!(attested_event.1, expected_attested_topics);
    assert_eq!(
        CommitmentStatus::from_val(&env, &attested_event.2),
        CommitmentStatus::Late
    );
}

#[test]
fn test_single_milestone_commitment_emits_no_milestone_event() {
    use soroban_sdk::testutils::Events;

    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    assert_eq!(env.events().all().len(), 1);
}

#[test]
fn test_oracle_attest_success() {
    let (env, client, issuer, counterparty, resolver) = setup_test();
    let oracle = Address::generate(&env);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &Some(oracle.clone()),
        &Some(123),
        &Vec::new(&env),
        &0,
    );

    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&oracle, &id, &CommitmentStatus::Fulfilled);

    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Fulfilled);
    assert_eq!(commitment.attested_at, Some(1500));
}

#[test]
fn test_oracle_attest_unauthorized() {
    let (env, client, issuer, counterparty, resolver) = setup_test();
    let oracle = Address::generate(&env);
    let stranger = Address::generate(&env);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &Some(oracle),
        &Some(123),
        &Vec::new(&env),
        &0,
    );

    let res = client.try_attest(&stranger, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::Unauthorized.into())));
}

#[test]
fn test_oracle_vs_manual_conflict_oracle_first() {
    let (env, client, issuer, counterparty, resolver) = setup_test();
    let oracle = Address::generate(&env);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &Some(oracle.clone()),
        &Some(123),
        &Vec::new(&env),
        &0,
    );

    // Oracle attests first
    client.attest(&oracle, &id, &CommitmentStatus::Fulfilled);

    // Issuer attempts to attest
    let res = client.try_attest(&issuer, &id, &CommitmentStatus::Late);
    assert_eq!(res, Err(Ok(Error::AlreadyResolved.into())));
}

#[test]
fn test_oracle_vs_manual_conflict_manual_first() {
    let (env, client, issuer, counterparty, resolver) = setup_test();
    let oracle = Address::generate(&env);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &Some(oracle.clone()),
        &Some(123),
        &Vec::new(&env),
        &0,
    );

    // Issuer attests first
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    // Oracle attempts to attest
    let res = client.try_attest(&oracle, &id, &CommitmentStatus::Late);
    assert_eq!(res, Err(Ok(Error::AlreadyResolved.into())));
}

#[test]
fn test_legacy_attestation_without_oracle() {
    let (env, client, issuer, counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    // Create commitment without oracle
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );

    let oracle = Address::generate(&env);
    let res = client.try_attest(&oracle, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::Unauthorized.into())));

    // Verify parties can still attest
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Fulfilled);
}

// -----------------------------------------------------------------------------
// Gas/storage-footprint benchmark (issue #16)
// -----------------------------------------------------------------------------
//
// Prints the metered CPU instructions and ledger write bytes for
// `create_commitment` and `attest` under the bitpacked `Commitment.counters`
// layout. Run with:
//
//   cargo test -p registry gas_benchmark -- --nocapture
#[test]
fn gas_benchmark_create_and_attest() {
    extern crate std;
    use std::println;

    let (env, client, issuer, counterparty, resolver) = setup_test();
    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);

    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    let create_res = env.cost_estimate().resources();
    let create_fee = env.cost_estimate().fee();
    println!(
        "create_commitment: instructions={} write_bytes={} mem_bytes={} total_fee={}",
        create_res.instructions, create_res.write_bytes, create_res.mem_bytes, create_fee.total
    );

    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    let attest_res = env.cost_estimate().resources();
    let attest_fee = env.cost_estimate().fee();
    println!(
        "attest: instructions={} write_bytes={} mem_bytes={} total_fee={}",
        attest_res.instructions, attest_res.write_bytes, attest_res.mem_bytes, attest_fee.total
    );
}

// -----------------------------------------------------------------------------
// Dispute slashing / stake escrow (Issue #15)
// -----------------------------------------------------------------------------

#[test]
fn test_dispute_requires_stake_transfer() {
    use soroban_sdk::token::{StellarAssetClient, TokenClient};

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    let counterparty = Address::generate(&env);
    let resolver = Address::generate(&env);
    let arbitrator = Address::generate(&env);

    let admin = Address::generate(&env);
    client.initialize(&soroban_sdk::vec![&env, arbitrator.clone()], &admin);

    // Register a Stellar asset and configure it as the dispute token.
    let token = env
        .register_stellar_asset_contract_v2(arbitrator.clone())
        .address();
    client.set_dispute_token(&arbitrator, &token);

    // Mint dispute stake to the issuer (who will raise the dispute).
    StellarAssetClient::new(&env, &token).mint(&issuer, &crate::commitments::DISPUTE_STAKE_AMOUNT);

    // Create and attest a commitment.
    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    // Raise a dispute — this should transfer the stake to the contract.
    env.ledger().with_mut(|l| l.timestamp = 1600);
    client.dispute(&issuer, &id);

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(
        token_client.balance(&client.address),
        crate::commitments::DISPUTE_STAKE_AMOUNT
    );
    assert_eq!(token_client.balance(&issuer), 0);
}

#[test]
fn test_dispute_stake_released_to_winner_on_resolution() {
    use soroban_sdk::token::{StellarAssetClient, TokenClient};

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    let counterparty = Address::generate(&env);
    let resolver = Address::generate(&env);
    let arbitrator = Address::generate(&env);
    let admin = Address::generate(&env);

    client.initialize(&soroban_sdk::vec![&env, arbitrator.clone()], &admin);

    let token = env
        .register_stellar_asset_contract_v2(arbitrator.clone())
        .address();
    client.set_dispute_token(&arbitrator, &token);

    // Mint tokens to counterparty (who will dispute).
    StellarAssetClient::new(&env, &token)
        .mint(&counterparty, &crate::commitments::DISPUTE_STAKE_AMOUNT);

    // Create, attest, dispute.
    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    env.ledger().with_mut(|l| l.timestamp = 1600);
    client.dispute(&counterparty, &id);

    // Resolve as Fulfilled — issuer wins and receives the stake.
    env.ledger().with_mut(|l| l.timestamp = 1700);
    client.resolve_dispute(&resolver, &id, &CommitmentStatus::Fulfilled);

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(
        token_client.balance(&issuer),
        crate::commitments::DISPUTE_STAKE_AMOUNT
    );
    assert_eq!(token_client.balance(&client.address), 0);
}

#[test]
fn test_dispute_fails_without_dispute_token_set() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    let counterparty = Address::generate(&env);
    let resolver = Address::generate(&env);
    let admin = Address::generate(&env);
    let arbitrator = Address::generate(&env);

    client.initialize(&soroban_sdk::vec![&env, arbitrator.clone()], &admin);

    // Do NOT call set_dispute_token.

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &2000,
        &resolver,
        &None,
        &None,
        &Vec::new(&env),
        &0,
    );
    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    // Dispute should fail because no dispute token is configured.
    env.ledger().with_mut(|l| l.timestamp = 1600);
    let res = client.try_dispute(&counterparty, &id);
    assert_eq!(res, Err(Ok(Error::DisputeTokenNotSet.into())));
}

// -----------------------------------------------------------------------------
// Batch Commitment Creation Tests (Issue #17)
// -----------------------------------------------------------------------------

#[test]
fn test_batch_create_commitments_success() {
    let (env, client, _issuer, _counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);

    let issuer1 = Address::generate(&env);
    let issuer2 = Address::generate(&env);
    let counterparty = Address::generate(&env);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);

    let params = soroban_sdk::vec![
        &env,
        commitments::CommitmentParams {
            issuer: issuer1.clone(),
            counterparty: counterparty.clone(),
            terms_hash: terms_hash.clone(),
            due_at: 2000,
            resolver_address: resolver.clone(),
            oracle: None,
            schema_id: None,
            attestors: Vec::new(&env),
            vote_threshold: 0,
        },
        commitments::CommitmentParams {
            issuer: issuer2.clone(),
            counterparty: counterparty.clone(),
            terms_hash: terms_hash.clone(),
            due_at: 3000,
            resolver_address: resolver.clone(),
            oracle: None,
            schema_id: None,
            attestors: Vec::new(&env),
            vote_threshold: 0,
        },
    ];

    env.mock_all_auths();
    let ids = client.batch_create_commitments(&params);

    assert_eq!(ids.len(), 2);
    assert_eq!(ids.get(0).unwrap(), 1);
    assert_eq!(ids.get(1).unwrap(), 2);
}

#[test]
fn test_batch_create_commitments_fails_when_batch_too_large() {
    let (env, client, _issuer, _counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);

    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let mut params = soroban_sdk::Vec::new(&env);

    for i in 0..51 {
        let issuer = Address::generate(&env);
        let counterparty = Address::generate(&env);
        params.push_back(commitments::CommitmentParams {
            issuer,
            counterparty,
            terms_hash: terms_hash.clone(),
            due_at: 2000 + i as u64,
            resolver_address: resolver.clone(),
            oracle: None,
            schema_id: None,
            attestors: Vec::new(&env),
            vote_threshold: 0,
        });
    }

    env.mock_all_auths();
    let res = client.try_batch_create_commitments(&params);
    assert_eq!(res, Err(Ok(Error::BatchTooLarge.into())));
}

#[test]
fn test_batch_create_commitments_fails_if_any_due_at_in_past() {
    let (env, client, _issuer, _counterparty, resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);

    let issuer1 = Address::generate(&env);
    let issuer2 = Address::generate(&env);
    let counterparty = Address::generate(&env);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);

    let params = soroban_sdk::vec![
        &env,
        commitments::CommitmentParams {
            issuer: issuer1.clone(),
            counterparty: counterparty.clone(),
            terms_hash: terms_hash.clone(),
            due_at: 2000,
            resolver_address: resolver.clone(),
            oracle: None,
            schema_id: None,
            attestors: Vec::new(&env),
            vote_threshold: 0,
        },
        commitments::CommitmentParams {
            issuer: issuer2.clone(),
            counterparty: counterparty.clone(),
            terms_hash: terms_hash.clone(),
            due_at: 500,
            resolver_address: resolver.clone(),
            oracle: None,
            schema_id: None,
            attestors: Vec::new(&env),
            vote_threshold: 0,
        },
    ];

    env.mock_all_auths();
    let res = client.try_batch_create_commitments(&params);
    assert_eq!(res, Err(Ok(Error::DueAtInPast.into())));
}

#[test]
fn test_batch_create_commitments_handles_empty_batch() {
    let (env, client, _issuer, _counterparty, _resolver) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);

    let empty_params = soroban_sdk::Vec::new(&env);
    env.mock_all_auths();

    let ids = client.batch_create_commitments(&empty_params);
    assert_eq!(ids.len(), 0);
}

#[test]
fn test_registry_error_discriminants_unique() {
    let errors: &[Error] = &[
        Error::DueAtInPast,
        Error::CommitmentNotFound,
        Error::AlreadyResolved,
        Error::Unauthorized,
        Error::InvalidOutcome,
        Error::AlreadyInitialized,
        Error::NotArbitrator,
        Error::DisputeWindowExpired,
        Error::InvalidTransition,
        Error::NotInitialized,
        Error::NotAuthorized,
        Error::Overflow,
        Error::ReentrantCall,
        Error::UpgradeAdminNotSet,
        Error::UpgradeAdminAlreadySet,
        Error::SchemaDowngrade,
        Error::UnsupportedSchemaVersion,
        Error::MigrationNotEnabled,
        Error::BatchTooLarge,
        Error::InvalidMilestoneCount,
        Error::InvalidMilestoneIndex,
        Error::MilestoneAlreadyAttested,
        Error::MilestoneOutOfOrder,
        Error::EmptyArbitratorSet,
        Error::AlreadyVoted,
        Error::InsufficientStake,
        Error::UnbondingPending,
        Error::UnbondingNotElapsed,
        Error::DisputeActive,
        Error::StakingTokenNotSet,
        Error::ZeroAmount,
        Error::NotAttestor,
        Error::AttestorAlreadyVoted,
        Error::ThresholdInvalid,
        Error::VotingClosed,
        Error::VotesNotMet,
        Error::UseVotingResolution,
        Error::ProtocolPaused,
        Error::ReputationArchived,
        Error::DisputeTokenNotSet,
        Error::InvalidDisputeStakeAmount,
        Error::RollupChallengePending,
        Error::RollupProofInvalid,
        Error::OracleNotInitialized,
        Error::NotAdmin,
        Error::AdminAlreadySet,
        Error::InvalidRangeProof,
    ];

    let mut seen = [false; 100];
    let mut count = 0;
    for err in errors {
        let code = *err as usize;
        assert!(code > 0 && code < 100, "Error code out of range: {}", code);
        assert!(!seen[code], "Duplicate error discriminant value: {}", code);
        seen[code] = true;
        count += 1;
    }
    assert_eq!(count, 47);
}

