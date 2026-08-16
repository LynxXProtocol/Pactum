use soroban_sdk::{contracttype, Address, BytesN, Map, Symbol, TryFromVal, TryIntoVal, Val};

/// The default dispute window in seconds (7 days = 604,800 seconds).
/// A party may raise a dispute within this duration after an attestation occurs.
pub const DISPUTE_WINDOW_SECONDS: u64 = 7 * 24 * 60 * 60;

/// The threshold in ledgers below which we extend the TTL. (Approx 14 days at 5s/ledger = 241,920)
pub const TTL_THRESHOLD_LEDGERS: u32 = 14 * 17280;

/// The amount in ledgers to extend the TTL to. (Approx 30 days at 5s/ledger = 518,400)
pub const TTL_EXTEND_LEDGERS: u32 = 30 * 17280;

/// Represents the current lifecycle state of a commitment.
///
/// # Variants
/// * `Pending` - The commitment has been created and is awaiting fulfillment or breach.
/// * `Fulfilled` - The commitment was successfully fulfilled.
/// * `Late` - The commitment was fulfilled after the due date.
/// * `Breached` - The commitment was breached or defaulted upon.
/// * `Disputed` - The commitment outcome is disputed by one of the parties.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitmentStatus {
    /// Commitment has been created and is awaiting fulfillment or breach.
    Pending,
    /// Commitment was successfully fulfilled.
    Fulfilled,
    /// Commitment was fulfilled after the due date.
    Late,
    /// Commitment was breached or defaulted upon.
    Breached,
    /// Commitment outcome is disputed by one of the parties.
    Disputed,
}

/// A registered recurring or ongoing commitment between two parties on Stellar.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Commitment {
    /// Unique identifier for this commitment.
    pub id: u64,
    /// The party making the commitment.
    pub issuer: Address,
    /// The party the commitment is owed to.
    pub counterparty: Address,
    /// Hash of the off-chain terms/description.
    pub terms_hash: BytesN<32>,
    /// Unix timestamp (seconds) when the commitment is due.
    pub due_at: u64,
    /// Current lifecycle status of the commitment.
    pub status: CommitmentStatus,
    /// Unix timestamp (seconds) when the commitment was created.
    pub created_at: u64,
    /// Unix timestamp (seconds) when the commitment was attested, if it has been attested.
    pub attested_at: Option<u64>,
    /// The address of the custom resolver delegated to resolve disputes for this commitment.
    pub resolver_address: Address,
}

/// Legacy representation of a Commitment prior to custom resolver support.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyCommitment {
    /// Unique identifier for this commitment.
    pub id: u64,
    /// The party making the commitment.
    pub issuer: Address,
    /// The party the commitment is owed to.
    pub counterparty: Address,
    /// Hash of the off-chain terms/description.
    pub terms_hash: BytesN<32>,
    /// Unix timestamp (seconds) when the commitment is due.
    pub due_at: u64,
    /// Current lifecycle status of the commitment.
    pub status: CommitmentStatus,
    /// Unix timestamp (seconds) when the commitment was created.
    pub created_at: u64,
    /// Unix timestamp (seconds) when the commitment was attested, if it has been attested.
    pub attested_at: Option<u64>,
}

/// Storage keys used for persisting commitments and contract state.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Persistent storage key for a Commitment by its unique ID.
    Commitment(u64),
    /// Instance storage key for the incrementing counter of IDs.
    NextId,
    /// Instance storage key for the designated Arbitrator address.
    Arbitrator,
    /// Persistent storage key for a RefundEscrow configuration by commitment ID.
    RefundEscrow(u64),
}

/// Internal helper to assign the next ID, build and persist a Commitment, extend TTL, and emit event.
pub fn create_commitment_record(
    env: &soroban_sdk::Env,
    issuer: Address,
    counterparty: Address,
    terms_hash: BytesN<32>,
    due_at: u64,
    resolver_address: Address,
) -> u64 {
    let now = env.ledger().timestamp();
    if due_at <= now {
        soroban_sdk::panic_with_error!(env, crate::errors::Error::DueAtInPast);
    }

    let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
    let next_id = id
        .checked_add(1)
        .unwrap_or_else(|| soroban_sdk::panic_with_error!(env, crate::errors::Error::Overflow));
    env.storage().instance().set(&DataKey::NextId, &next_id);
    env.storage().instance().extend_ttl(
        TTL_THRESHOLD_LEDGERS,
        TTL_EXTEND_LEDGERS,
    );

    let commitment = Commitment {
        id,
        issuer: issuer.clone(),
        counterparty: counterparty.clone(),
        terms_hash,
        due_at,
        status: CommitmentStatus::Pending,
        created_at: now,
        attested_at: None,
        resolver_address,
    };

    env.storage()
        .persistent()
        .set(&DataKey::Commitment(id), &commitment);
    env.storage().persistent().extend_ttl(
        &DataKey::Commitment(id),
        TTL_THRESHOLD_LEDGERS,
        TTL_EXTEND_LEDGERS,
    );

    crate::events::commitment_created(env, id, &issuer, &counterparty);

    id
}

/// Reads a commitment from persistent storage without mutating storage, transparently
/// interpreting legacy records in-memory with the arbitrator as fallback resolver.
pub fn read_commitment_record(env: &soroban_sdk::Env, id: u64) -> Option<Commitment> {
    let val: Val = env
        .storage()
        .persistent()
        .get(&DataKey::Commitment(id))?;

    let map = Map::<Symbol, Val>::try_from_val(env, &val).ok()?;
    let resolver_sym = Symbol::new(env, "resolver_address");

    if map.contains_key(resolver_sym) {
        return Commitment::try_from_val(env, &val).ok();
    }

    // Legacy record without resolver_address: parse fields individually in-memory
    let stored_id: u64 = map.get(Symbol::new(env, "id"))?.try_into_val(env).ok()?;
    if stored_id != id {
        return None;
    }
    let issuer: Address = map.get(Symbol::new(env, "issuer"))?.try_into_val(env).ok()?;
    let counterparty: Address = map.get(Symbol::new(env, "counterparty"))?.try_into_val(env).ok()?;
    let terms_hash: BytesN<32> = map.get(Symbol::new(env, "terms_hash"))?.try_into_val(env).ok()?;
    let due_at: u64 = map.get(Symbol::new(env, "due_at"))?.try_into_val(env).ok()?;
    let status: CommitmentStatus = map.get(Symbol::new(env, "status"))?.try_into_val(env).ok()?;
    let created_at: u64 = map.get(Symbol::new(env, "created_at"))?.try_into_val(env).ok()?;
    let attested_at: Option<u64> = match map.get(Symbol::new(env, "attested_at")) {
        Some(v) => v.try_into_val(env).ok()?,
        None => None,
    };

    let fallback_resolver = env
        .storage()
        .instance()
        .get::<DataKey, Address>(&DataKey::Arbitrator)
        .unwrap_or_else(|| soroban_sdk::panic_with_error!(env, crate::errors::Error::NotInitialized));

    Some(Commitment {
        id,
        issuer,
        counterparty,
        terms_hash,
        due_at,
        status,
        created_at,
        attested_at,
        resolver_address: fallback_resolver,
    })
}

/// Loads a commitment from persistent storage, transparently migrating legacy records
/// that were stored before `resolver_address` was added. Legacy records inherit the
/// contract's designated arbitrator address as their fallback `resolver_address`.
pub fn get_commitment_record(env: &soroban_sdk::Env, id: u64) -> Option<Commitment> {
    let commitment = read_commitment_record(env, id)?;

    // Persist migrated format if needed
    let val: Option<Val> = env.storage().persistent().get(&DataKey::Commitment(id));
    if let Some(v) = val {
        if let Ok(map) = Map::<Symbol, Val>::try_from_val(env, &v) {
            if !map.contains_key(Symbol::new(env, "resolver_address")) {
                env.storage()
                    .persistent()
                    .set(&DataKey::Commitment(id), &commitment);
            }
        }
    }

    Some(commitment)
}



