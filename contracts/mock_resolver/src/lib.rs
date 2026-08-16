#![no_std]

use registry::errors::Error;
use registry::{CommitmentStatus, RegistryContractClient};
use soroban_sdk::{contract, contractimpl, contracttype, panic_with_error, Address, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MockResolverDataKey {
    Controller,
}

/// A secondary mock resolver contract used to test cross-contract dispute resolution delegation.
#[contract]
pub struct MockResolver;

#[contractimpl]
impl MockResolver {
    /// Initializes the MockResolver with a designated controller address.
    pub fn init(env: Env, controller: Address) {
        if env
            .storage()
            .instance()
            .has(&MockResolverDataKey::Controller)
        {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        controller.require_auth();
        env.storage()
            .instance()
            .set(&MockResolverDataKey::Controller, &controller);
    }

    /// Retrieves the designated controller address.
    pub fn get_controller(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&MockResolverDataKey::Controller)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
    }

    /// Resolves a dispute on the target registry contract.
    ///
    /// The caller must authenticate as the designated resolver controller. The MockResolver
    /// then performs the cross-contract invocation to the registry contract using its own address,
    /// fulfilling the registry's resolver authorization check.
    pub fn resolve_dispute(
        env: Env,
        caller: Address,
        registry: Address,
        commitment_id: u64,
        outcome: CommitmentStatus,
    ) {
        caller.require_auth();
        let controller = Self::get_controller(env.clone());
        if caller != controller {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let registry_client = RegistryContractClient::new(&env, &registry);
        let self_address = env.current_contract_address();
        registry_client.resolve_dispute(&self_address, &commitment_id, &outcome);
    }
}

#[cfg(test)]
mod test;
