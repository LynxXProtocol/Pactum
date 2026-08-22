#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Bytes, BytesN, Env,
};

#[contract]
pub struct MockWasmRuleset;

#[contractimpl]
impl MockWasmRuleset {
    pub fn validate_transition(
        _env: Env,
        _old_state_hash: BytesN<32>,
        _new_state_hash: BytesN<32>,
        state_data: Bytes,
        _old_balance_a: i128,
        _old_balance_b: i128,
        _new_balance_a: i128,
        _new_balance_b: i128,
    ) -> bool {
        // If state_data contains a single byte equal to 0, reject transition as invalid
        if state_data.len() > 0 && state_data.get(0).unwrap() == 0 {
            false
        } else {
            true
        }
    }
}

fn create_token_contract<'a>(
    e: &Env,
    admin: &Address,
) -> (token::Client<'a>, StellarAssetClient<'a>) {
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    (
        token::Client::new(e, &sac.address()),
        StellarAssetClient::new(e, &sac.address()),
    )
}

#[test]
fn test_cooperative_channel_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    let party_a = Address::generate(&env);
    let party_b = Address::generate(&env);
    let admin = Address::generate(&env);

    let (token_client, sac_client) = create_token_contract(&env, &admin);
    sac_client.mint(&party_a, &1000);
    sac_client.mint(&party_b, &1000);

    let ruleset_id = env.register(MockWasmRuleset, ());

    let channel_contract_id = env.register(StateChannelContract, ());
    let channel_client = StateChannelContractClient::new(&env, &channel_contract_id);

    let channel_id = channel_client.open_channel(
        &party_a,
        &party_b,
        &token_client.address,
        &500,
        &500,
        &3600,
        &ruleset_id,
    );

    assert_eq!(channel_id, 1);
    let channel = channel_client.get_channel(&channel_id);
    assert_eq!(channel.balance_a, 500);
    assert_eq!(channel.balance_b, 500);
    assert_eq!(channel.status, ChannelStatus::Open);
    assert_eq!(token_client.balance(&channel_contract_id), 1000);

    // Cooperative close
    channel_client.close_channel(&party_a, &channel_id);

    let closed_channel = channel_client.get_channel(&channel_id);
    assert_eq!(closed_channel.status, ChannelStatus::Closed);
    assert_eq!(token_client.balance(&party_a), 1000);
    assert_eq!(token_client.balance(&party_b), 1000);
}

#[test]
fn test_dispute_and_wasm_verification_valid_transition() {
    let env = Env::default();
    env.mock_all_auths();

    let party_a = Address::generate(&env);
    let party_b = Address::generate(&env);
    let admin = Address::generate(&env);

    let (token_client, sac_client) = create_token_contract(&env, &admin);
    sac_client.mint(&party_a, &1000);
    sac_client.mint(&party_b, &1000);

    let ruleset_id = env.register(MockWasmRuleset, ());
    let channel_contract_id = env.register(StateChannelContract, ());
    let channel_client = StateChannelContractClient::new(&env, &channel_contract_id);

    let channel_id = channel_client.open_channel(
        &party_a,
        &party_b,
        &token_client.address,
        &500,
        &500,
        &3600,
        &ruleset_id,
    );

    let state_hash = BytesN::from_array(&env, &[1u8; 32]);
    let proof = StateProof {
        channel_id,
        nonce: 1,
        balance_a: 700,
        balance_b: 300,
        state_hash: state_hash.clone(),
    };

    channel_client.dispute_channel(&party_a, &channel_id, &proof);

    let disputed_channel = channel_client.get_channel(&channel_id);
    assert_eq!(disputed_channel.status, ChannelStatus::Disputed);
    assert_eq!(disputed_channel.latest_nonce, 1);

    // Party B challenges Party A's dispute proof with valid state data
    let prior_hash = BytesN::from_array(&env, &[0u8; 32]);
    let mut state_data = Bytes::new(&env);
    state_data.push_back(1); // valid payload

    channel_client.verify_and_resolve_dispute(
        &party_b,
        &channel_id,
        &prior_hash,
        &500,
        &500,
        &state_data,
    );

    let verified_channel = channel_client.get_channel(&channel_id);
    assert_eq!(verified_channel.latest_balance_a, 700);
    assert_eq!(verified_channel.latest_balance_b, 300);
}

#[test]
fn test_dispute_and_wasm_slashing_invalid_transition() {
    let env = Env::default();
    env.mock_all_auths();

    let party_a = Address::generate(&env);
    let party_b = Address::generate(&env);
    let admin = Address::generate(&env);

    let (token_client, sac_client) = create_token_contract(&env, &admin);
    sac_client.mint(&party_a, &1000);
    sac_client.mint(&party_b, &1000);

    let ruleset_id = env.register(MockWasmRuleset, ());
    let channel_contract_id = env.register(StateChannelContract, ());
    let channel_client = StateChannelContractClient::new(&env, &channel_contract_id);

    let channel_id = channel_client.open_channel(
        &party_a,
        &party_b,
        &token_client.address,
        &500,
        &500,
        &3600,
        &ruleset_id,
    );

    let invalid_state_hash = BytesN::from_array(&env, &[9u8; 32]);
    let proof = StateProof {
        channel_id,
        nonce: 5,
        balance_a: 1000,
        balance_b: 0,
        state_hash: invalid_state_hash.clone(),
    };

    // Malicious Party A submits invalid dispute proof
    channel_client.dispute_channel(&party_a, &channel_id, &proof);

    // Party B challenges Party A's submission with invalid payload state_data = [0]
    let prior_hash = BytesN::from_array(&env, &[0u8; 32]);
    let mut invalid_state_data = Bytes::new(&env);
    invalid_state_data.push_back(0); // mock ruleset returns false for 0

    channel_client.verify_and_resolve_dispute(
        &party_b,
        &channel_id,
        &prior_hash,
        &500,
        &500,
        &invalid_state_data,
    );

    // Party A (offender) is slashed! Party B gets 100% of collateral (1000) + original uncommitted balance (500) = 1500
    assert_eq!(token_client.balance(&party_a), 500); // initial 1000 - 500 deposited, 0 awarded
    assert_eq!(token_client.balance(&party_b), 1500); // initial 1000 - 500 deposited + 1000 slashed collateral

    let slashed_channel = channel_client.get_channel(&channel_id);
    assert_eq!(slashed_channel.status, ChannelStatus::Closed);
    assert_eq!(slashed_channel.latest_balance_a, 0);
    assert_eq!(slashed_channel.latest_balance_b, 1000);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #13)")]
fn test_disputer_cannot_challenge_self() {
    let env = Env::default();
    env.mock_all_auths();

    let party_a = Address::generate(&env);
    let party_b = Address::generate(&env);
    let admin = Address::generate(&env);

    let (token_client, sac_client) = create_token_contract(&env, &admin);
    sac_client.mint(&party_a, &1000);
    sac_client.mint(&party_b, &1000);

    let ruleset_id = env.register(MockWasmRuleset, ());
    let channel_contract_id = env.register(StateChannelContract, ());
    let channel_client = StateChannelContractClient::new(&env, &channel_contract_id);

    let channel_id = channel_client.open_channel(
        &party_a,
        &party_b,
        &token_client.address,
        &500,
        &500,
        &3600,
        &ruleset_id,
    );

    let proof = StateProof {
        channel_id,
        nonce: 1,
        balance_a: 700,
        balance_b: 300,
        state_hash: BytesN::from_array(&env, &[1u8; 32]),
    };

    channel_client.dispute_channel(&party_a, &channel_id, &proof);

    let prior_hash = BytesN::from_array(&env, &[0u8; 32]);
    let mut invalid_state_data = Bytes::new(&env);
    invalid_state_data.push_back(0);

    // Party A (disputer) tries to challenge self to steal collateral — must panic with Error #13
    channel_client.verify_and_resolve_dispute(
        &party_a,
        &channel_id,
        &prior_hash,
        &500,
        &500,
        &invalid_state_data,
    );
}

#[test]
fn test_close_channel_after_dispute_timeout() {
    let env = Env::default();
    env.mock_all_auths();

    let party_a = Address::generate(&env);
    let party_b = Address::generate(&env);
    let admin = Address::generate(&env);

    let (token_client, sac_client) = create_token_contract(&env, &admin);
    sac_client.mint(&party_a, &1000);
    sac_client.mint(&party_b, &1000);

    let ruleset_id = env.register(MockWasmRuleset, ());
    let channel_contract_id = env.register(StateChannelContract, ());
    let channel_client = StateChannelContractClient::new(&env, &channel_contract_id);

    let dispute_window = 1000;
    let channel_id = channel_client.open_channel(
        &party_a,
        &party_b,
        &token_client.address,
        &500,
        &500,
        &dispute_window,
        &ruleset_id,
    );

    let proof = StateProof {
        channel_id,
        nonce: 2,
        balance_a: 600,
        balance_b: 400,
        state_hash: BytesN::from_array(&env, &[3u8; 32]),
    };

    channel_client.dispute_channel(&party_a, &channel_id, &proof);

    // Advance ledger timestamp beyond dispute window
    env.ledger().set_timestamp(dispute_window + 10);

    channel_client.close_channel(&party_b, &channel_id);

    assert_eq!(token_client.balance(&party_a), 1100); // 500 remaining + 600
    assert_eq!(token_client.balance(&party_b), 900); // 500 remaining + 400
}
