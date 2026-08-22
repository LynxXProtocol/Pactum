#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error,
    token, Address, Bytes, BytesN, Env, Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    ChannelNotFound = 1,
    ChannelAlreadyClosed = 2,
    ChannelNotInDispute = 3,
    DisputeWindowActive = 4,
    DisputeWindowExpired = 5,
    Unauthorized = 6,
    InvalidNonce = 7,
    InvalidStateProof = 8,
    ZeroAmount = 9,
    InvalidConsensusRules = 10,
    InvalidStateTransition = 11,
    AlreadyDisputed = 12,
    DisputerCannotChallengeSelf = 13,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelStatus {
    Open,
    Disputed,
    Closed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Channel {
    pub id: u64,
    pub party_a: Address,
    pub party_b: Address,
    pub token: Address,
    pub balance_a: i128,
    pub balance_b: i128,
    pub ruleset_contract: Address,
    pub status: ChannelStatus,
    pub dispute_window: u64,
    pub dispute_started_at: u64,
    pub disputer: Option<Address>,
    pub latest_nonce: u64,
    pub latest_balance_a: i128,
    pub latest_balance_b: i128,
    pub latest_state_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StateProof {
    pub channel_id: u64,
    pub nonce: u64,
    pub balance_a: i128,
    pub balance_b: i128,
    pub state_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    NextChannelId,
    Channel(u64),
}

#[contractclient(name = "WasmConsensusRulesetClient")]
pub trait WasmConsensusRuleset {
    /// Validates an off-chain state transition against user-defined WASM consensus rules.
    /// Returns `true` if the state transition from `old_state_hash` to `new_state_hash`
    /// with state payload `state_data` and balance movement is valid according to the WASM ruleset.
    fn validate_transition(
        env: Env,
        old_state_hash: BytesN<32>,
        new_state_hash: BytesN<32>,
        state_data: Bytes,
        old_balance_a: i128,
        old_balance_b: i128,
        new_balance_a: i128,
        new_balance_b: i128,
    ) -> bool;
}

#[contract]
pub struct StateChannelContract;

#[contractimpl]
impl StateChannelContract {
    /// Opens a new L2 state channel with locked token collateral and assigned WASM consensus ruleset contract.
    pub fn open_channel(
        env: Env,
        party_a: Address,
        party_b: Address,
        token: Address,
        amount_a: i128,
        amount_b: i128,
        dispute_window: u64,
        ruleset_contract: Address,
    ) -> u64 {
        if amount_a <= 0 && amount_b <= 0 {
            panic_with_error!(&env, Error::ZeroAmount);
        }

        party_a.require_auth();
        party_b.require_auth();

        let client = token::Client::new(&env, &token);
        let contract_address = env.current_contract_address();

        if amount_a > 0 {
            client.transfer(&party_a, &contract_address, &amount_a);
        }
        if amount_b > 0 {
            client.transfer(&party_b, &contract_address, &amount_b);
        }

        let channel_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextChannelId)
            .unwrap_or(1);

        env.storage()
            .instance()
            .set(&DataKey::NextChannelId, &(channel_id + 1));

        let initial_state_hash = BytesN::from_array(&env, &[0u8; 32]);

        let channel = Channel {
            id: channel_id,
            party_a: party_a.clone(),
            party_b: party_b.clone(),
            token: token.clone(),
            balance_a: amount_a,
            balance_b: amount_b,
            ruleset_contract,
            status: ChannelStatus::Open,
            dispute_window,
            dispute_started_at: 0,
            disputer: None,
            latest_nonce: 0,
            latest_balance_a: amount_a,
            latest_balance_b: amount_b,
            latest_state_hash: initial_state_hash,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Channel(channel_id), &channel);

        env.events().publish(
            (Symbol::new(&env, "channel_opened"), channel_id),
            (party_a, party_b, amount_a, amount_b),
        );

        channel_id
    }

    /// Fetches details for a registered state channel.
    pub fn get_channel(env: Env, channel_id: u64) -> Channel {
        env.storage()
            .persistent()
            .get(&DataKey::Channel(channel_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::ChannelNotFound))
    }

    /// Submits a signed state proof to open or escalate a dispute challenge window.
    pub fn dispute_channel(env: Env, caller: Address, channel_id: u64, proof: StateProof) {
        caller.require_auth();

        let mut channel: Channel = env
            .storage()
            .persistent()
            .get(&DataKey::Channel(channel_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::ChannelNotFound));

        if channel.status == ChannelStatus::Closed {
            panic_with_error!(&env, Error::ChannelAlreadyClosed);
        }

        if caller != channel.party_a && caller != channel.party_b {
            panic_with_error!(&env, Error::Unauthorized);
        }

        if proof.channel_id != channel_id {
            panic_with_error!(&env, Error::InvalidStateProof);
        }

        if proof.nonce <= channel.latest_nonce {
            panic_with_error!(&env, Error::InvalidNonce);
        }

        // Conservation of balance check
        if proof.balance_a + proof.balance_b != channel.balance_a + channel.balance_b {
            panic_with_error!(&env, Error::InvalidStateProof);
        }

        let now = env.ledger().timestamp();

        // Check if existing dispute window expired
        if channel.status == ChannelStatus::Disputed
            && now >= channel.dispute_started_at + channel.dispute_window
        {
            panic_with_error!(&env, Error::DisputeWindowExpired);
        }

        channel.latest_nonce = proof.nonce;
        channel.latest_balance_a = proof.balance_a;
        channel.latest_balance_b = proof.balance_b;
        channel.latest_state_hash = proof.state_hash;
        channel.status = ChannelStatus::Disputed;
        channel.dispute_started_at = now;
        channel.disputer = Some(caller.clone());

        env.storage()
            .persistent()
            .set(&DataKey::Channel(channel_id), &channel);

        env.events().publish(
            (Symbol::new(&env, "channel_disputed"), channel_id),
            (caller, proof.nonce, proof.balance_a, proof.balance_b),
        );
    }

    /// Verifies off-chain state transitions against the custom WASM consensus ruleset.
    /// The challenge MUST verify the disputed state currently held in `channel.latest_*`.
    /// If `validate_transition` returns false, the disputer who submitted the invalid state proof is slashed,
    /// and 100% of collateral is awarded to `challenger`.
    pub fn verify_and_resolve_dispute(
        env: Env,
        challenger: Address,
        channel_id: u64,
        prior_state_hash: BytesN<32>,
        prior_balance_a: i128,
        prior_balance_b: i128,
        state_data: Bytes,
    ) {
        challenger.require_auth();

        let mut channel: Channel = env
            .storage()
            .persistent()
            .get(&DataKey::Channel(channel_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::ChannelNotFound));

        if channel.status != ChannelStatus::Disputed {
            panic_with_error!(&env, Error::ChannelNotInDispute);
        }

        if challenger != channel.party_a && challenger != channel.party_b {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let disputer = channel
            .disputer
            .clone()
            .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidStateProof));

        if challenger == disputer {
            panic_with_error!(&env, Error::DisputerCannotChallengeSelf);
        }

        let ruleset_client = WasmConsensusRulesetClient::new(&env, &channel.ruleset_contract);

        let is_valid = ruleset_client.validate_transition(
            &prior_state_hash,
            &channel.latest_state_hash,
            &state_data,
            &prior_balance_a,
            &prior_balance_b,
            &channel.latest_balance_a,
            &channel.latest_balance_b,
        );

        let token_client = token::Client::new(&env, &channel.token);
        let total_collateral = channel.balance_a + channel.balance_b;

        if !is_valid {
            // Slashing branch: disputer submitted an invalid state transition!
            // Slashing offender (disputer) and awarding 100% collateral to challenger.
            if total_collateral > 0 {
                token_client.transfer(
                    &env.current_contract_address(),
                    &challenger,
                    &total_collateral,
                );
            }

            channel.status = ChannelStatus::Closed;
            channel.latest_balance_a = if challenger == channel.party_a {
                total_collateral
            } else {
                0
            };
            channel.latest_balance_b = if challenger == channel.party_b {
                total_collateral
            } else {
                0
            };

            env.storage()
                .persistent()
                .set(&DataKey::Channel(channel_id), &channel);

            env.events().publish(
                (Symbol::new(&env, "offender_slashed"), channel_id),
                (disputer, challenger, total_collateral),
            );
        } else {
            // Valid transition branch: state transition passed WASM consensus rules verification
            env.events().publish(
                (Symbol::new(&env, "transition_verified"), channel_id),
                (challenger, channel.latest_nonce),
            );
        }
    }

    /// Closes the channel and distributes remaining locked collateral.
    /// Can be called cooperatively when both parties sign, or after dispute window expiration.
    pub fn close_channel(env: Env, caller: Address, channel_id: u64) {
        caller.require_auth();

        let mut channel: Channel = env
            .storage()
            .persistent()
            .get(&DataKey::Channel(channel_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::ChannelNotFound));

        if channel.status == ChannelStatus::Closed {
            panic_with_error!(&env, Error::ChannelAlreadyClosed);
        }

        if caller != channel.party_a && caller != channel.party_b {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let now = env.ledger().timestamp();

        if channel.status == ChannelStatus::Disputed {
            if now < channel.dispute_started_at + channel.dispute_window {
                panic_with_error!(&env, Error::DisputeWindowActive);
            }
        } else {
            // Cooperative close requires both signatures if not in dispute
            channel.party_a.require_auth();
            channel.party_b.require_auth();
        }

        let token_client = token::Client::new(&env, &channel.token);
        let contract_address = env.current_contract_address();

        if channel.latest_balance_a > 0 {
            token_client.transfer(&contract_address, &channel.party_a, &channel.latest_balance_a);
        }

        if channel.latest_balance_b > 0 {
            token_client.transfer(&contract_address, &channel.party_b, &channel.latest_balance_b);
        }

        channel.status = ChannelStatus::Closed;

        env.storage()
            .persistent()
            .set(&DataKey::Channel(channel_id), &channel);

        env.events().publish(
            (Symbol::new(&env, "channel_closed"), channel_id),
            (channel.latest_balance_a, channel.latest_balance_b),
        );
    }
}

#[cfg(test)]
mod test;
