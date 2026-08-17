#![cfg(test)]

use super::*;
use crate::commitments::CommitmentStatus;
use crate::errors::Error;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, BytesN, Env};

fn setup_test() -> (Env, RegistryContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    let counterparty = Address::generate(&env);
    (env, client, issuer, counterparty)
}

#[test]
fn test_create_and_get_commitment_success() {
    let (env, client, issuer, counterparty) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);

    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let commitment_id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);
    assert_eq!(commitment_id, 1);

    let commitment = client.get_commitment(&commitment_id);
    assert_eq!(commitment.id, 1);
    assert_eq!(commitment.issuer, issuer);
    assert_eq!(commitment.counterparty, counterparty);
    assert_eq!(commitment.terms_hash, terms_hash);
    assert_eq!(commitment.due_at, due_at);
    assert_eq!(commitment.status, CommitmentStatus::Pending);
    assert_eq!(commitment.created_at, 1000);
}

#[test]
#[should_panic]
fn test_create_commitment_requires_auth() {
    let env = Env::default();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let issuer = Address::generate(&env);
    let counterparty = Address::generate(&env);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let due_at = 2000;

    client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);
}

#[test]
fn test_create_commitment_fails_if_due_at_in_past() {
    let (env, client, issuer, counterparty) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);

    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 999;

    let res = client.try_create_commitment(&issuer, &counterparty, &terms_hash, &due_at);
    assert_eq!(res, Err(Ok(Error::DueAtInPast.into())));
}

#[test]
fn test_get_commitment_fails_for_nonexistent_id() {
    let (_env, client, _issuer, _counterparty) = setup_test();

    let res = client.try_get_commitment(&999);
    assert_eq!(res, Err(Ok(Error::CommitmentNotFound.into())));
}

#[test]
fn test_sequential_unique_ids() {
    let (env, client, issuer, counterparty) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash1 = BytesN::from_array(&env, &[1u8; 32]);
    let terms_hash2 = BytesN::from_array(&env, &[2u8; 32]);

    let id1 = client.create_commitment(&issuer, &counterparty, &terms_hash1, &2000);
    let id2 = client.create_commitment(&issuer, &counterparty, &terms_hash2, &3000);

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
    let (env, client, issuer, counterparty) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Fulfilled);
    assert_eq!(commitment.attested_at, Some(1500));
}

#[test]
fn test_attest_outcome_late_by_counterparty() {
    let (env, client, issuer, counterparty) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

    env.ledger().with_mut(|l| l.timestamp = 2500);
    client.attest(&counterparty, &id, &CommitmentStatus::Late);

    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Late);
    assert_eq!(commitment.attested_at, Some(2500));
}

#[test]
fn test_attest_outcome_breached() {
    let (env, client, issuer, counterparty) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

    env.ledger().with_mut(|l| l.timestamp = 2100);
    client.attest(&issuer, &id, &CommitmentStatus::Breached);

    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Breached);
    assert_eq!(commitment.attested_at, Some(2100));
}

#[test]
fn test_attest_fails_if_not_pending() {
    let (env, client, issuer, counterparty) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

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
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let due_at = 2000;

    env.mock_all_auths();
    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

    env.mock_auths(&[]);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
}

#[test]
fn test_attest_fails_if_unauthorized_caller() {
    let (env, client, issuer, counterparty) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

    let stranger = Address::generate(&env);
    let res = client.try_attest(&stranger, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::Unauthorized.into())));
}

#[test]
fn test_attest_fails_for_pending_outcome() {
    let (env, client, issuer, counterparty) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

    let res = client.try_attest(&issuer, &id, &CommitmentStatus::Pending);
    assert_eq!(res, Err(Ok(Error::InvalidOutcome.into())));
}

#[test]
fn test_is_overdue_before_and_after_due_date() {
    let (env, client, issuer, counterparty) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

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
    let (_env, client, _issuer, _counterparty) = setup_test();
    let res = client.try_is_overdue(&999);
    assert_eq!(res, Err(Ok(Error::CommitmentNotFound.into())));
}

#[test]
fn test_events_emitted() {
    use soroban_sdk::testutils::Events;
    use soroban_sdk::{symbol_short, FromVal, IntoVal, Val, Vec};

    let (env, client, issuer, counterparty) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

    let create_events = env.events().all();
    assert_eq!(create_events.len(), 1);
    let created_event = create_events.get(0).unwrap();
    let expected_created_topics: Vec<Val> = (
        symbol_short!("created"),
        issuer.clone(),
        counterparty.clone(),
    )
        .into_val(&env);
    assert_eq!(created_event.0, client.address);
    assert_eq!(created_event.1, expected_created_topics);
    assert_eq!(u64::from_val(&env, &created_event.2), 1u64);

    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    let attest_events = env.events().all();
    assert_eq!(attest_events.len(), 1);
    let attested_event = attest_events.get(0).unwrap();
    let expected_attested_topics: Vec<Val> =
        (symbol_short!("attested"), 1u64).into_val(&env);
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
) {
    let (env, client, issuer, counterparty) = setup_test();
    let arbitrator = Address::generate(&env);
    client.initialize(&arbitrator);
    (env, client, issuer, counterparty, arbitrator)
}

#[test]
fn test_initialize_can_only_run_once() {
    let (_env, client, _issuer, _counterparty, arbitrator) = setup_test_with_arbitrator();
    let res = client.try_initialize(&arbitrator);
    assert_eq!(res, Err(Ok(Error::AlreadyInitialized.into())));
    assert_eq!(client.get_arbitrator(), arbitrator);
}

#[test]
fn test_dispute_and_resolution_end_to_end() {
    let (env, client, issuer, counterparty, arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    let commitment = client.get_commitment(&id);
    assert_eq!(commitment.status, CommitmentStatus::Fulfilled);

    // Either party can dispute within the window
    env.ledger().with_mut(|l| l.timestamp = 1600);
    client.dispute(&counterparty, &id);

    let disputed_comm = client.get_commitment(&id);
    assert_eq!(disputed_comm.status, CommitmentStatus::Disputed);

    // Arbitrator resolves the dispute
    env.ledger().with_mut(|l| l.timestamp = 1700);
    client.resolve_dispute(&arbitrator, &id, &CommitmentStatus::Breached);

    let resolved_comm = client.get_commitment(&id);
    assert_eq!(resolved_comm.status, CommitmentStatus::Breached);
}

#[test]
fn test_dispute_fails_outside_dispute_window() {
    let (env, client, issuer, counterparty, _arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    // Advance timestamp beyond the dispute window (1500 + 604_800 = 606_300)
    env.ledger().with_mut(|l| l.timestamp = 1500 + DISPUTE_WINDOW_SECONDS + 1);
    let res = client.try_dispute(&counterparty, &id);
    assert_eq!(res, Err(Ok(Error::DisputeWindowExpired.into())));
}

#[test]
fn test_dispute_succeeds_at_window_boundary() {
    let (env, client, issuer, counterparty, _arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

    env.ledger().with_mut(|l| l.timestamp = 1500);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    // Exactly at the boundary is allowed
    env.ledger().with_mut(|l| l.timestamp = 1500 + DISPUTE_WINDOW_SECONDS);
    client.dispute(&counterparty, &id);
    let comm = client.get_commitment(&id);
    assert_eq!(comm.status, CommitmentStatus::Disputed);
}

#[test]
fn test_dispute_fails_if_caller_not_issuer_or_counterparty() {
    let (env, client, issuer, counterparty, _arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    let stranger = Address::generate(&env);
    let res = client.try_dispute(&stranger, &id);
    assert_eq!(res, Err(Ok(Error::Unauthorized.into())));
}

#[test]
fn test_resolve_dispute_fails_if_caller_not_arbitrator() {
    let (env, client, issuer, counterparty, _arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    client.dispute(&counterparty, &id);

    let stranger = Address::generate(&env);
    let res = client.try_resolve_dispute(&stranger, &id, &CommitmentStatus::Breached);
    assert_eq!(res, Err(Ok(Error::NotArbitrator.into())));

    let res2 = client.try_resolve_dispute(&issuer, &id, &CommitmentStatus::Breached);
    assert_eq!(res2, Err(Ok(Error::NotArbitrator.into())));
}

#[test]
fn test_resolve_dispute_fails_if_commitment_not_disputed() {
    let (env, client, issuer, counterparty, arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

    // Pending -> resolve_dispute should fail
    let res = client.try_resolve_dispute(&arbitrator, &id, &CommitmentStatus::Fulfilled);
    assert_eq!(res, Err(Ok(Error::InvalidTransition.into())));

    // Fulfilled -> resolve_dispute should fail
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    let res2 = client.try_resolve_dispute(&arbitrator, &id, &CommitmentStatus::Late);
    assert_eq!(res2, Err(Ok(Error::InvalidTransition.into())));
}

#[test]
fn test_resolve_dispute_rejects_invalid_final_outcome() {
    let (env, client, issuer, counterparty, arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    client.dispute(&counterparty, &id);

    // Reject Pending
    let res1 = client.try_resolve_dispute(&arbitrator, &id, &CommitmentStatus::Pending);
    assert_eq!(res1, Err(Ok(Error::InvalidOutcome.into())));

    // Reject Disputed
    let res2 = client.try_resolve_dispute(&arbitrator, &id, &CommitmentStatus::Disputed);
    assert_eq!(res2, Err(Ok(Error::InvalidOutcome.into())));
}

#[test]
fn test_dispute_fails_if_pending() {
    let (env, client, issuer, counterparty, _arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

    let res = client.try_dispute(&issuer, &id);
    assert_eq!(res, Err(Ok(Error::InvalidTransition.into())));
}

#[test]
fn test_dispute_fails_if_already_disputed() {
    let (env, client, issuer, counterparty, _arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    client.dispute(&counterparty, &id);

    // Try disputing again while Disputed
    let res = client.try_dispute(&counterparty, &id);
    assert_eq!(res, Err(Ok(Error::InvalidTransition.into())));
}

#[test]
fn test_attest_fails_for_disputed_outcome() {
    let (env, client, issuer, counterparty) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);

    let res = client.try_attest(&issuer, &id, &CommitmentStatus::Disputed);
    assert_eq!(res, Err(Ok(Error::InvalidOutcome.into())));
}

#[test]
fn test_dispute_events_emitted() {
    use soroban_sdk::testutils::Events;
    use soroban_sdk::{symbol_short, FromVal, IntoVal, Val, Vec};

    let (env, client, issuer, counterparty, arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    client.dispute(&counterparty, &id);

    let all_events = env.events().all();
    let disputed_event = all_events.get(all_events.len() - 1).unwrap();
    let expected_disputed_topics: Vec<Val> =
        (symbol_short!("disputed"), 1u64).into_val(&env);
    assert_eq!(disputed_event.0, client.address);
    assert_eq!(disputed_event.1, expected_disputed_topics);
    assert_eq!(<()>::from_val(&env, &disputed_event.2), ());


    client.resolve_dispute(&arbitrator, &id, &CommitmentStatus::Late);

    let all_events_after = env.events().all();
    let resolved_event = all_events_after.get(all_events_after.len() - 1).unwrap();
    let expected_resolved_topics: Vec<Val> =
        (symbol_short!("resolved"), 1u64).into_val(&env);
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
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);

    env.mock_all_auths();
    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &2000);
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
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);

    env.mock_all_auths();
    client.initialize(&arbitrator);
    let id = client.create_commitment(&issuer, &counterparty, &terms_hash, &2000);
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);
    client.dispute(&counterparty, &id);

    env.mock_auths(&[]);
    client.resolve_dispute(&arbitrator, &id, &CommitmentStatus::Late);
}

#[test]
#[should_panic]
fn test_initialize_requires_auth() {
    let env = Env::default();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let arbitrator = Address::generate(&env);

    client.initialize(&arbitrator);
}

// -----------------------------------------------------------------------------
// Phase 4 - Reputation Tests
// -----------------------------------------------------------------------------

#[test]
fn test_get_reputation_zeroed_for_new_address() {
    let (env, client, _issuer, _counterparty) = setup_test();
    let new_issuer = Address::generate(&env);

    let rep = client.get_reputation(&new_issuer);
    assert_eq!(rep.fulfilled_count, 0);
    assert_eq!(rep.late_count, 0);
    assert_eq!(rep.breached_count, 0);
}

#[test]
fn test_reputation_increments_direct_attestation() {
    let (env, client, issuer, counterparty) = setup_test();
    
    env.ledger().with_mut(|l| l.timestamp = 1000);
    let due_at = 2000;
    
    // Create and fulfill first commitment
    let id1 = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[1u8; 32]), &due_at);
    client.attest(&issuer, &id1, &CommitmentStatus::Fulfilled);
    
    let rep1 = client.get_reputation(&issuer);
    assert_eq!(rep1.fulfilled_count, 1);
    assert_eq!(rep1.late_count, 0);
    assert_eq!(rep1.breached_count, 0);
    
    // Create and late second commitment
    let id2 = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[2u8; 32]), &due_at);
    client.attest(&issuer, &id2, &CommitmentStatus::Late);
    
    let rep2 = client.get_reputation(&issuer);
    assert_eq!(rep2.fulfilled_count, 1);
    assert_eq!(rep2.late_count, 1);
    assert_eq!(rep2.breached_count, 0);
    
    // Create and breach third commitment
    let id3 = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[3u8; 32]), &due_at);
    client.attest(&issuer, &id3, &CommitmentStatus::Breached);
    
    let rep3 = client.get_reputation(&issuer);
    assert_eq!(rep3.fulfilled_count, 1);
    assert_eq!(rep3.late_count, 1);
    assert_eq!(rep3.breached_count, 1);
}

#[test]
fn test_reputation_not_incremented_when_disputed() {
    let (env, client, issuer, counterparty, _arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[1u8; 32]), &2000);
    
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
    let (env, client, issuer, counterparty, arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[1u8; 32]), &2000);
    
    // 1. Attest as Breached
    client.attest(&issuer, &id, &CommitmentStatus::Breached);
    let rep1 = client.get_reputation(&issuer);
    assert_eq!(rep1.breached_count, 1);
    
    // 2. Dispute
    client.dispute(&counterparty, &id);
    let rep2 = client.get_reputation(&issuer);
    assert_eq!(rep2.breached_count, 0); // Decr old outcome
    
    // 3. Resolve as Fulfilled
    client.resolve_dispute(&arbitrator, &id, &CommitmentStatus::Fulfilled);
    let rep3 = client.get_reputation(&issuer);
    
    // Most important check: ONLY final outcome is counted
    assert_eq!(rep3.fulfilled_count, 1);
    assert_eq!(rep3.breached_count, 0);
    assert_eq!(rep3.late_count, 0);
}

#[test]
fn test_reputation_aggregates_multiple_commitments() {
    let (env, client, issuer, counterparty, arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    
    // Comm 1: Fulfilled (direct)
    let id1 = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[1u8; 32]), &2000);
    client.attest(&issuer, &id1, &CommitmentStatus::Fulfilled);
    
    // Comm 2: Late (disputed, resolved as Late)
    let id2 = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[2u8; 32]), &2000);
    client.attest(&issuer, &id2, &CommitmentStatus::Fulfilled); // Attested as Fulfilled initially
    client.dispute(&counterparty, &id2);
    client.resolve_dispute(&arbitrator, &id2, &CommitmentStatus::Late); // Overturned to Late
    
    // Comm 3: Breached (direct)
    let id3 = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[3u8; 32]), &2000);
    client.attest(&issuer, &id3, &CommitmentStatus::Breached);
    
    // Comm 4: Fulfilled (direct)
    let id4 = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[4u8; 32]), &2000);
    client.attest(&issuer, &id4, &CommitmentStatus::Fulfilled);
    
    let rep = client.get_reputation(&issuer);
    assert_eq!(rep.fulfilled_count, 2); // Comm 1, Comm 4
    assert_eq!(rep.late_count, 1);      // Comm 2
    assert_eq!(rep.breached_count, 1);  // Comm 3
}

// -----------------------------------------------------------------------------
// Issue #9 - Counterparty-side Reputation Tracking
// -----------------------------------------------------------------------------

#[test]
fn test_counterparty_frivolous_dispute_increments_counter() {
    let (env, client, issuer, counterparty, arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[1u8; 32]),
        &2000,
    );

    // Fairly attested as Fulfilled by the issuer.
    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    // Counterparty disputes; the arbitrator upholds the original attestation.
    client.dispute(&counterparty, &id);
    client.resolve_dispute(&arbitrator, &id, &CommitmentStatus::Fulfilled);

    let rep = client.get_reputation(&counterparty);
    assert_eq!(rep.counterparty_disputes_raised, 1);

    // Issuer-side stats are unaffected by the new counterparty counter.
    let issuer_rep = client.get_reputation(&issuer);
    assert_eq!(issuer_rep.counterparty_disputes_raised, 0);
    assert_eq!(issuer_rep.fulfilled_count, 1);
}

#[test]
fn test_counterparty_justified_dispute_does_not_increment() {
    let (env, client, issuer, counterparty, arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[1u8; 32]),
        &2000,
    );

    // Attested as Breached, but the counterparty successfully contests it.
    client.attest(&issuer, &id, &CommitmentStatus::Breached);
    client.dispute(&counterparty, &id);
    client.resolve_dispute(&arbitrator, &id, &CommitmentStatus::Fulfilled);

    let rep = client.get_reputation(&counterparty);
    assert_eq!(rep.counterparty_disputes_raised, 0);
}

#[test]
fn test_issuer_raised_dispute_does_not_count_against_counterparty() {
    let (env, client, issuer, counterparty, arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[1u8; 32]),
        &2000,
    );

    client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    // The issuer (not the counterparty) raises the dispute.
    client.dispute(&issuer, &id);
    client.resolve_dispute(&arbitrator, &id, &CommitmentStatus::Fulfilled);

    let rep = client.get_reputation(&counterparty);
    assert_eq!(rep.counterparty_disputes_raised, 0);
}

// -----------------------------------------------------------------------------
// Phase 5 - Hardening & Edge Cases
// -----------------------------------------------------------------------------

#[test]
fn test_create_commitment_fails_if_due_at_is_current_timestamp() {
    let (env, client, issuer, counterparty) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 1000; // Exactly current timestamp

    let res = client.try_create_commitment(&issuer, &counterparty, &terms_hash, &due_at);
    assert_eq!(res, Err(Ok(Error::DueAtInPast.into())));
}

#[test]
fn test_dispute_fails_if_already_resolved() {
    let (env, client, issuer, counterparty, arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[1u8; 32]), &2000);
    
    // Attest, dispute, resolve
    client.attest(&issuer, &id, &CommitmentStatus::Late);
    client.dispute(&counterparty, &id);
    client.resolve_dispute(&arbitrator, &id, &CommitmentStatus::Fulfilled);

    // Try disputing again after final resolution
    let res = client.try_dispute(&counterparty, &id);
    
    // We expect this to fail.
    // However, if the current contract logic allows a second dispute because `attested_at` is still within the window,
    // we need to fix the contract. Let's see if the test passes with an error. 
    // Wait, the test expects an error. The user requirement:
    // "repeated dispute attempts on an already-resolved dispute"
    assert_eq!(res, Err(Ok(Error::InvalidTransition.into())));
}

#[test]
fn test_realistic_sequence() {
    // create -> attest late -> dispute -> resolve fulfilled -> verify reputation
    let (env, client, issuer, counterparty, arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.create_commitment(&issuer, &counterparty, &BytesN::from_array(&env, &[1u8; 32]), &2000);
    
    env.ledger().with_mut(|l| l.timestamp = 2500); // Late
    client.attest(&issuer, &id, &CommitmentStatus::Late);
    
    let rep_after_attest = client.get_reputation(&issuer);
    assert_eq!(rep_after_attest.late_count, 1);
    
    client.dispute(&counterparty, &id);
    let rep_after_dispute = client.get_reputation(&issuer);
    assert_eq!(rep_after_dispute.late_count, 0); // Decremented
    
    client.resolve_dispute(&arbitrator, &id, &CommitmentStatus::Fulfilled);
    
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

    let (env, client, issuer, counterparty) = setup_test();

    // Register the malicious mock as a real contract (not via mock_auths,
    // which would silently replace it with a no-op stand-in) so that its
    // __check_auth implementation is genuinely invoked.
    let attacker_id = env.register(AttackerGate, ());
    let attacker_client = AttackerGateClient::new(&env, &attacker_id);

    client.initialize(&attacker_id);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[7u8; 32]),
        &2000,
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
    let (env, client, issuer, counterparty) = setup_test();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[1u8; 32]),
        &2000,
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
    let (env, client, issuer, counterparty, arbitrator) = setup_test_with_arbitrator();

    env.ledger().with_mut(|l| l.timestamp = 1000);

    assert_eq!(client.get_trust_score(&issuer), 50);

    let id1 = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[1u8; 32]),
        &2000,
    );
    client.attest(&issuer, &id1, &CommitmentStatus::Fulfilled);
    assert_eq!(client.get_trust_score(&issuer), 60);

    let id2 = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[2u8; 32]),
        &2000,
    );
    client.attest(&issuer, &id2, &CommitmentStatus::Late);
    assert_eq!(client.get_trust_score(&issuer), 50);

    let id3 = client.create_commitment(
        &issuer,
        &counterparty,
        &BytesN::from_array(&env, &[3u8; 32]),
        &2000,
    );
    client.attest(&issuer, &id3, &CommitmentStatus::Breached);
    assert_eq!(client.get_trust_score(&issuer), 0);

    let _ = arbitrator;
}
// Phase 6 - Contract Upgrade Tests
// -----------------------------------------------------------------------------

#[test]
fn test_upgrade_requires_arbitrator() {
    let (env, client, _issuer, _counterparty, _arbitrator) = setup_test_with_arbitrator();

    // Use a mock WASM hash for testing authorization logic
    let mock_wasm_hash = BytesN::from_array(&env, &[2u8; 32]);
    
    // Should fail when called by non-arbitrator
    let stranger = Address::generate(&env);
    let res = client.try_upgrade(&stranger, &mock_wasm_hash);
    assert_eq!(res, Err(Ok(Error::NotArbitrator.into())));
    
    // Note: We cannot test the successful upgrade path without valid WASM bytes.
    // The Soroban SDK requires actual WASM binary format for upload_contract_wasm.
    // The authorization logic is verified by the failure test above.
}

#[test]
fn test_upgrade_fails_if_not_initialized() {
    let (env, client, _issuer, _counterparty) = setup_test();
    let arbitrator = Address::generate(&env);
    
    // Use a mock WASM hash for testing
    let mock_wasm_hash = BytesN::from_array(&env, &[2u8; 32]);
    
    let res = client.try_upgrade(&arbitrator, &mock_wasm_hash);
    assert_eq!(res, Err(Ok(Error::NotInitialized.into())));
}

#[test]
#[should_panic]
fn test_upgrade_requires_auth() {
    let env = Env::default();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let arbitrator = Address::generate(&env);

    env.mock_all_auths();
    client.initialize(&arbitrator);

    // Use a mock WASM hash for testing
    let mock_wasm_hash = BytesN::from_array(&env, &[2u8; 32]);

    env.mock_auths(&[]);
    client.upgrade(&arbitrator, &mock_wasm_hash);
}

#[test]
fn test_upgrade_authorization_logic() {
    let (env, client, issuer, counterparty, _arbitrator) = setup_test_with_arbitrator();

    // Create some state to verify the upgrade function checks authorization
    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    let id1 = client.create_commitment(&issuer, &counterparty, &terms_hash, &due_at);
    client.attest(&issuer, &id1, &CommitmentStatus::Fulfilled);

    // Verify that non-arbitrator cannot upgrade
    let stranger = Address::generate(&env);
    let mock_wasm_hash = BytesN::from_array(&env, &[2u8; 32]);
    let res = client.try_upgrade(&stranger, &mock_wasm_hash);
    assert_eq!(res, Err(Ok(Error::NotArbitrator.into())));
    
    // Verify that the state remains unchanged after failed upgrade attempt
    let comm = client.get_commitment(&id1);
    assert_eq!(comm.status, CommitmentStatus::Fulfilled);
    assert_eq!(comm.id, id1);
}
