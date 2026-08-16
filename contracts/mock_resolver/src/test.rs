#![cfg(test)]

use super::*;
use registry::errors::Error;
use registry::RegistryContract;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, BytesN, Env};

fn setup_env() -> (
    Env,
    RegistryContractClient<'static>,
    MockResolverClient<'static>,
    Address,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    let registry_id = env.register(RegistryContract, ());
    let registry_client = RegistryContractClient::new(&env, &registry_id);

    let resolver_id = env.register(MockResolver, ());
    let resolver_client = MockResolverClient::new(&env, &resolver_id);

    let arbitrator = Address::generate(&env);
    registry_client.initialize(&arbitrator);

    let controller = Address::generate(&env);
    resolver_client.init(&controller);

    let issuer = Address::generate(&env);
    let counterparty = Address::generate(&env);

    (
        env,
        registry_client,
        resolver_client,
        registry_id,
        controller,
        issuer,
        counterparty,
    )
}

#[test]
fn test_mock_resolver_cross_contract_dispute_resolution() {
    let (env, registry_client, resolver_client, registry_id, controller, issuer, counterparty) =
        setup_env();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[1u8; 32]);
    let due_at = 2000;

    // 1. Create commitment with MockResolver as the delegated resolver_address
    let id = registry_client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &100_000_000,
        &resolver_client.address,
    );

    let commitment = registry_client.get_commitment(&id);
    assert_eq!(commitment.resolver_address, resolver_client.address);
    assert_eq!(commitment.status, CommitmentStatus::Pending);

    // 2. Attest commitment
    env.ledger().with_mut(|l| l.timestamp = 1500);
    registry_client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    // 3. Counterparty raises dispute
    env.ledger().with_mut(|l| l.timestamp = 1600);
    registry_client.dispute(&counterparty, &id);

    let disputed_comm = registry_client.get_commitment(&id);
    assert_eq!(disputed_comm.status, CommitmentStatus::Disputed);

    // 4. Unauthorized caller directly on registry fails
    let stranger = Address::generate(&env);
    let res = registry_client.try_resolve_dispute(&stranger, &id, &CommitmentStatus::Breached);
    assert_eq!(res, Err(Ok(Error::NotArbitrator.into())));

    // 5. Unauthorized caller on MockResolver fails (controller authorization required)
    let res_mock_unauthorized = resolver_client.try_resolve_dispute(
        &stranger,
        &registry_id,
        &id,
        &CommitmentStatus::Breached,
    );
    assert_eq!(res_mock_unauthorized, Err(Ok(Error::Unauthorized.into())));

    // 6. Authorized controller resolving via MockResolver succeeds
    env.ledger().with_mut(|l| l.timestamp = 1700);
    resolver_client.resolve_dispute(
        &controller,
        &registry_id,
        &id,
        &CommitmentStatus::Breached,
    );

    let resolved_comm = registry_client.get_commitment(&id);
    assert_eq!(resolved_comm.status, CommitmentStatus::Breached);

    let rep = registry_client.get_reputation(&issuer);
    assert_eq!(rep.breached_count, 1);
    assert_eq!(rep.fulfilled_count, 0);
}

#[test]
fn test_mock_resolver_rejected_if_not_designated_resolver() {
    let (env, registry_client, resolver_client, registry_id, controller, issuer, counterparty) =
        setup_env();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let terms_hash = BytesN::from_array(&env, &[2u8; 32]);
    let due_at = 2000;

    // Create commitment with a different address as resolver
    let other_resolver = Address::generate(&env);
    let id = registry_client.create_commitment(
        &issuer,
        &counterparty,
        &terms_hash,
        &due_at,
        &100_000_000,
        &other_resolver,
    );

    env.ledger().with_mut(|l| l.timestamp = 1500);
    registry_client.attest(&issuer, &id, &CommitmentStatus::Fulfilled);

    env.ledger().with_mut(|l| l.timestamp = 1600);
    registry_client.dispute(&counterparty, &id);

    // MockResolver attempts to resolve a commitment it was not assigned to -> fails with NotArbitrator
    let res = resolver_client.try_resolve_dispute(
        &controller,
        &registry_id,
        &id,
        &CommitmentStatus::Breached,
    );
    assert_eq!(res, Err(Ok(Error::NotArbitrator.into())));
}
