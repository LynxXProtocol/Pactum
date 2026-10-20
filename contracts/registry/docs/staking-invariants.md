# Attestor Staking Invariants

## Phase 1: Staking Foundation (Issue 86)

This document formalizes the basic invariants that the attestor staking vault maintains.

### Core Invariant: Balance Consistency

**For every attestor address `A`:**

```
recorded_stake(A) == total_amount_deposited(A) - total_amount_withdrawn(A) - total_amount_slashed(A)
```

Where:

- `recorded_stake(A)` is the value of `AttestorStake.staked` stored in persistent storage
- `total_amount_deposited(A)` is the cumulative sum of all successful `stake_attestor` calls for `A`
- `total_amount_withdrawn(A)` is the cumulative sum of all successful `finalize_unstake` calls for `A`
- `total_amount_slashed(A)` is the cumulative sum of all slashing penalties applied to `A` (Phase 2)

### Invariant 1: Stake Increments Only on Successful Transfer

The implementation MUST NOT increase `AttestorStake.staked` without a corresponding successful token transfer from the attestor to the contract vault.

**Implementation guarantee:**

- `stake_attestor` follows the CEI (Checks-Effects-Interactions) pattern
- Storage update precedes the external token transfer
- Reentrancy guard prevents observation of intermediate state
- Overflow protection ensures stake addition cannot wrap

**Code reference:** `contracts/registry/src/staking.rs:144-174`

```rust
// 4. Update accounting before the external transfer (CEI)
let mut stake = load_stake(env, &attestor);
stake.staked = stake
    .staked
    .checked_add(amount)  // Overflow protection
    .unwrap_or_else(|| panic_with_error!(env, Error::Overflow));
save_stake(env, &attestor, &stake);

// 5. Transfer the asset from the attestor into the contract vault
let client = TokenClient::new(env, &token);
client.transfer(&attestor, &env.current_contract_address(), &amount);
```

### Invariant 2: Stake Decrements Only on Successful Transfer or Slashing

The implementation MUST NOT decrease `AttestorStake.staked` except:

1. During `finalize_unstake` after successful token transfer back to the attestor, OR
2. During `slash` when a dispute resolves against the attestor (Phase 2)

**Implementation guarantee:**

- `finalize_unstake` removes the storage record before the external transfer
- If the transfer fails, the transaction reverts and the record remains
- Only the voting phase can invoke `slash`, and only for attestors on losing outcomes

**Code reference:** `contracts/registry/src/staking.rs:219-254`

### Invariant 3: Unbonding Period Enforcement

An attestor CANNOT withdraw staked funds until `UNBONDING_PERIOD_SECONDS` (14 days) has elapsed after calling `request_unstake`.

**Implementation guarantee:**

- `request_unstake` sets `unbonding_until = now + UNBONDING_PERIOD_SECONDS`
- `finalize_unstake` requires `now >= unbonding_until`
- Ledger timestamp is monotonic and cannot be manipulated by the caller

**Code reference:** `contracts/registry/src/staking.rs:16-17, 176-216, 219-254`

```rust
pub const UNBONDING_PERIOD_SECONDS: u64 = 14 * 24 * 60 * 60; // 1,209,600 seconds
```

### Invariant 4: Locked Stake is Immutable

When `AttestorStake.locked == true`, the attestor CANNOT:

- Request a new unstake (`request_unstake` panics with `Error::DisputeActive`)
- Finalize a pending unstake (`finalize_unstake` panics with `Error::DisputeActive`)

**Implementation guarantee:**

- The `locked` flag is set by the voting phase when the attestor joins an active dispute panel
- Both unstaking functions explicitly check the flag before proceeding
- The lock is only cleared by the voting phase after the dispute resolves

**Code reference:** `contracts/registry/src/staking.rs:176-216, 219-254`

### Invariant 5: Zero-Value Rejection

The contract MUST reject stake deposits where `amount <= 0`.

**Implementation guarantee:**

- `stake_attestor` checks `amount <= 0` and panics with `Error::ZeroAmount`

**Code reference:** `contracts/registry/src/staking.rs:152-155`

### Invariant 6: Reentrancy Protection

All state-mutating staking functions are protected against reentrancy attacks.

**Implementation guarantee:**

- Each function enters the reentrancy guard before any external interaction (including `require_auth`)
- The guard is released only after the function completes
- Nested calls to any protected function panic with `Error::ReentrantCall`

**Code reference:** `contracts/registry/src/staking.rs:146-148, 178-180, 221-223`

### Invariant 7: Token Balance Consistency

The contract's balance of the staking token MUST equal or exceed the sum of all recorded stakes.

```
token_balance(contract_vault) >= sum_for_all_A(recorded_stake(A))
```

**Notes:**

- The `>=` (not strict `==`) accounts for potential direct transfers or slashed funds awaiting distribution
- Phase 2 (slashing and distribution) will maintain this invariant while distributing forfeited stakes

### Out of Scope for Phase 1

The following invariants are deferred to Phase 2 (voting and slashing):

- **Slashing invariant**: When an attestor votes for a losing outcome, exactly X% of their stake is forfeited
- **Distribution invariant**: Slashed funds are distributed to the injured party and honest validators according to the protocol specification
- **Vote-stake coupling**: Only attestors with positive stake can cast votes

### Verification

These invariants are verified through:

1. **Unit tests**: `contracts/registry/src/test_staking.rs` (7 tests, all passing)
2. **Integration tests**: `contracts/registry/src/test_voting.rs` (tests stake-locked voting behavior)
3. **Static analysis**: Rust type system prevents unsigned underflow; `checked_add` prevents overflow

**Test execution:**

```bash
cargo test --lib test_staking
# Result: ok. 7 passed; 0 failed; 0 ignored; 0 measured
```

### Security Considerations

1. **Integer Overflow**: All arithmetic uses `checked_add` / `checked_sub` / `checked_mul` / `checked_div`
2. **Reentrancy**: Guarded by `reentrancy::enter` / `reentrancy::exit`
3. **Authorization**: Every mutating call requires `attestor.require_auth()`
4. **CEI Pattern**: Storage updates precede external calls to prevent inconsistent state observation
5. **Token Transfer Failures**: If `TokenClient.transfer` fails, the entire transaction reverts

### Future Work (Phase 2)

The next phase will extend these invariants to cover:

- Cryptoeconomic incentives for honest attestor behavior
- Slashing mechanics for malicious or incorrect votes
- Distribution of forfeited stakes to injured parties
- Super-majority threshold requirements for dispute resolution

---

**Last Updated:** Implementation complete as of Issue 86 Phase 1  
**Soroban SDK Version:** 22.0.0  
**Contract:** `registry` (Pactum Registry Contract)
