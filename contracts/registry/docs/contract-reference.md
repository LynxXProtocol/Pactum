# Registry Contract Reference

This document provides a comprehensive reference for all public functions, storage lifecycles, and configuration requirements of the Pactum Registry Contract.

## Contract Architecture
The registry is an immutable ledger for creating, tracking, and resolving on-chain commitments. The commitment lifecycle spans statuses from `Pending` up to `Fulfilled`, `Late`, `Breached`, and optionally `Disputed`.

## Milestones
A commitment carries a `milestone_count`. `create_commitment` sets it to `1`, which is the single-shot commitment the rest of this document describes; `create_milestone_commitment` splits the commitment into up to `MAX_MILESTONES` (256) partial attestations that share one commitment ID.

Milestones are attested in order, one at a time, and each one's outcome is stored under `DataKey::Milestone(id, index)`. The commitment itself stays `Pending` until either:

- a milestone is attested `Breached`, which resolves the whole commitment as `Breached` on the spot and blocks the remaining milestones; or
- the final milestone is attested, which resolves the commitment as `Late` if any milestone came in late and `Fulfilled` otherwise.

Reputation and the trust history are therefore updated exactly once per commitment, at resolution, with the aggregate outcome — never once per milestone. `attested_at` is stamped at the same moment, so the 7-day dispute window opens when the commitment resolves rather than at the first milestone.

Resolution reads the counters on the `Commitment` itself, never the per-milestone entries, so the `DataKey::Milestone` records are a queryable audit trail rather than load-bearing state and an expired one cannot change an outcome.

Records written before the milestone counters existed are migrated on read by `get_commitment_record`, the same path that backfills `resolver_address`: they become single-milestone commitments, already attested if they had resolved.

## Storage Lifecycle & TTL
Soroban implements a Time-To-Live (TTL) model for data storage. The registry contract automatically extends the TTL of active data to prevent unexpected expiration.
- **`TTL_THRESHOLD_LEDGERS`**: `241920` (Approx 14 days)
- **`TTL_EXTEND_LEDGERS`**: `518400` (Approx 30 days)

### Persistent Storage
- **Commitments**: Preserved indefinitely as long as they are queried via `get_commitment` or updated via attest/dispute. Extended up to 30 days upon each access. 
- **Milestones**: One entry per attested milestone, keyed by `(commitment id, milestone index)`. Written and extended to 30 days when the milestone is attested, and bumped again on each `get_milestone`.
- **Reputation**: Automatically extended to 30 days on each query or change. It must persist indefinitely as an immutable record of an issuer's reliability.
- **Trust History**: One entry per address (~52 bytes) holding the bucketed outcome history used by `get_trust_score`. Extended to 30 days on each query or change, mirroring the reputation bump-on-access pattern.

### Instance Storage
- **NextId & ArbitratorSet**: Extended to 30 days every time a new commitment is created or the arbitrator set is retrieved. A pre-multi-arbitrator deployment that stored a single `Arbitrator` address is lazily migrated into a one-member `ArbitratorSet` on first read.

### Dispute Vote Tallies
- **Votes**: One persistent entry per disputed, committee-routed commitment, holding the running tally of arbitrator votes plus the set of arbitrators that already voted. Written and extended to 30 days on every vote that does not yet reach a majority.

## Public Functions

### `initialize`
Initializes the contract with a committee of designated arbitrators. Can only be called once.
- **Parameters**: 
  - `env: Env`
  - `arbitrators: Vec<Address>`: The committee of mutually trusted arbitrators. Duplicates are dropped, and the set must not be empty.
- **Authorization**: Requires authorization from every distinct arbitrator in the set.
- **Panics**: `Error::AlreadyInitialized` if already initialized (including a legacy single-arbitrator deployment), `Error::EmptyArbitratorSet` if the set is empty.

### `get_arbitrators`
Retrieves the full set of designated arbitrators.
- **Parameters**: `env: Env`
- **Returns**: `Vec<Address>` — the arbitrator committee.
- **Panics**: `Error::NotInitialized` if the contract has not been initialized.

### `get_arbitrator`
Retrieves the first designated arbitrator.
- **Parameters**: `env: Env`
- **Returns**: `Address` — the first member of the arbitrator set. Kept for backwards compatibility; prefer `get_arbitrators`.
- **Panics**: `Error::NotInitialized` if the contract has not been initialized.

### `create_commitment`
Creates and registers a new ongoing commitment between an issuer and a counterparty.
- **Parameters**:
  - `env: Env`
  - `issuer: Address`: The address making the commitment.
  - `counterparty: Address`: The address to whom the commitment is owed.
  - `terms_hash: BytesN<32>`: Hash of the off-chain terms.
  - `due_at: u64`: Unix timestamp (seconds) when the commitment is due.
- **Authorization**: Requires authorization from `issuer`.
- **Returns**: `u64` (the unique identifier for the commitment).
- **Panics**: `Error::DueAtInPast` if `due_at` is in the past.

### `get_commitment`
Retrieves an existing commitment by its unique ID.
- **Parameters**: 
  - `env: Env`
  - `id: u64`
- **Returns**: `Commitment` struct containing full state details.
- **Panics**: `Error::CommitmentNotFound` if the ID does not exist.

### `attest`
Attests to the lifecycle status of a commitment.
- **Parameters**:
  - `env: Env`
  - `caller: Address`: The participant attesting the outcome (must be issuer or counterparty).
  - `id: u64`
  - `outcome: CommitmentStatus`: Must be `Fulfilled`, `Late`, or `Breached`.
- **Authorization**: Requires authorization from `caller`.
- **Panics**: `Error::Unauthorized` if the caller isn't participating, `Error::InvalidOutcome` if status is Pending/Disputed, `Error::AlreadyResolved` if no longer pending.

### `is_overdue`
Checks whether a commitment is overdue.
- **Parameters**:
  - `env: Env`
  - `id: u64`
- **Returns**: `bool` (True if the commitment is `Pending` and the ledger timestamp is greater than `due_at`).

### `dispute`
Raises a dispute on an attested commitment within the dispute window (7 days).
- **Parameters**:
  - `env: Env`
  - `caller: Address`: The participant raising the dispute.
  - `id: u64`
- **Authorization**: Requires authorization from `caller`.
- **Panics**: `Error::DisputeWindowExpired` if called after the 7-day dispute window, `Error::InvalidTransition` if the commitment is already disputed, not yet attested, or has already been resolved (see [Re-dispute prevention](#re-dispute-prevention-intentional-invariant) below).

### `resolve_dispute`
Resolves a disputed commitment to a final outcome.
- **Parameters**:
  - `env: Env`
  - `caller: Address`: The resolver or arbitrator casting the resolution/vote.
  - `id: u64`
  - `final_outcome: CommitmentStatus`: The final adjudicated outcome.
- **Authorization**: Requires authorization from `caller`.
- **Two paths**:
  - *Custom resolver* — a commitment whose `resolver_address` is outside the arbitrator committee is settled directly by that resolver in a single call (plugin delegation).
  - *Arbitrator committee* — naming an arbitrator as the `resolver_address` routes the dispute through the committee: each call records the calling arbitrator's vote under `DataKey::Votes(id)`, and the dispute finalizes only once the votes for one outcome **exceed half the arbitrator count**. No single arbitrator can settle the dispute alone.
- **Panics**: `Error::NotArbitrator` if the caller is neither the designated custom resolver nor a committee member eligible to vote, `Error::AlreadyVoted` if a committee member votes twice on the same dispute, `Error::InvalidTransition` if the commitment is not `Disputed`, `Error::InvalidOutcome` if `final_outcome` is `Pending` or `Disputed`.

#### Re-dispute prevention (intentional invariant)

On a ruling, `resolve_dispute` writes `commitment.attested_at = None` alongside the final status (see `contracts/registry/src/disputes.rs`). This is a deliberate invariant, not an omission:

- `resolve_dispute` sets `attested_at = None` after it applies the final outcome.
- `dispute()` requires `attested_at` to compute the window deadline (`deadline = attested_at + DISPUTE_WINDOW_SECONDS`); without it, the call panics with `Error::InvalidTransition`. Once cleared, a resolved commitment has no anchor from which to open a dispute window, so re-disputing it is *structurally* impossible — no party, and not even the arbitrator, can route it back into `Disputed`.
- This is intentional: after arbitration, the commitment is **permanently finalized**. `Disputed` is a single, one-shot lifecycle phase, and `attested_at` is only meaningful as the marker that opened the (one) dispute window.

> Integrators reading `dispute()` alone will not see why a resolved commitment can never be disputed again. Treat any commitment whose `status` is `Fulfilled`/`Late`/`Breached` **and** whose `attested_at` is `None` as final, regardless of how much of the nominal 7-day window remains.

### `get_reputation`
Retrieves the aggregate reputation for a given address.
- **Parameters**:
  - `env: Env`
  - `address: Address`: The address to query.
- **Returns**: `Reputation` struct (fulfilled, late, breached counts). Returns zeroed counts if the address has no history.

### `get_trust_score`
Retrieves the 0..=100 time-decayed trust score for a given address as an issuer.
- **Parameters**:
  - `env: Env`
  - `address: Address`: The address to query.
- **Returns**: `u32` trust score in the range 0..=100. An address with no history scores the neutral baseline of 50.
- **Decay model**: Outcomes are aggregated into buckets of 10,000 ledgers (≈13.9 hours). Each bucket of age is decayed by a stepwise integer shift with a half-life of 64 buckets (≈37 days); after 2048 buckets (32 steps, ≈3.2 years) an outcome's weight is zero. Score = `clamp(50 + 10·F − 10·L − 50·B, 0, 100)` over the decayed effective counts, so a recent breach tanks the score immediately while its impact mathematically degrades as the ledger advances.
- **Complexity**: O(1) — a single storage read plus constant integer math; no iteration over historical commitments. Updated on every `attest`, `dispute`, and `resolve_dispute`.

## TrustGate Cross-Contract Interface

Exposing `get_trust_score` (and the mutating `attest`/`resolve_dispute` functions) to external contracts opens the registry up to cross-contract composability, and with it, reentrancy risk: Soroban's authorization framework can invoke arbitrary contract code (a custom account's `__check_auth`) while resolving `require_auth`, giving an untrusted contract a window to call back into the registry before the original call has finished mutating state.

Two safeguards address this:

1. **A standard, typed interface (`contracts/registry/src/trust_gate.rs`)** — two `#[contractclient]`-generated clients that external contracts should depend on instead of the full `registry` crate:
   - `TrustGateReaderClient` — read-only, exposes only `get_trust_score`. Always safe to call.
   - `TrustGateWriterClient` — state-mutating, exposes `attest` and `resolve_dispute`. Kept strictly separate from the reader interface so integrators cannot reach for a mutating call while only intending to read a trust score.

   `RegistryContract` implements both underlying traits as plain (non-exported) Rust trait impls, so the compiler enforces that these published interfaces never drift out of sync with the contract's actual public API.

2. **A reentrancy guard (`contracts/registry/src/reentrancy.rs`)** — every state-mutating entry point (`initialize`, `create_commitment`, `attest`, `dispute`, `resolve_dispute`) calls a guard `enter()` before `require_auth` (and therefore before any possible callback into untrusted contract code), and `exit()` only after all state changes are committed. A nested call into any guarded function while another is already in progress fails immediately with `Error::ReentrantCall` instead of observing or corrupting half-updated state. This enforces the Checks-Effects-Interactions pattern contract-wide: the only "interaction" point (`require_auth`) is protected on both sides by the lock.

   The test suite includes a malicious mock, `AttackerGate` (`contracts/registry/src/attacker_gate.rs`), registered as a commitment's arbitrator. It implements `CustomAccountInterface` and attempts, from within `__check_auth`, to re-enter `resolve_dispute` for the same commitment before the legitimate call has applied its state changes. The attempt is rejected with `Error::ReentrantCall`, and the legitimate call completes exactly once with correct final state (see `test_reentrancy_attack_during_resolve_dispute_is_blocked` in `contracts/registry/src/test.rs`).

---

## Upgradeability and Governance

The registry upgrades **in place**: `update_current_contract_wasm` replaces the
executable while the contract ID and all storage survive, so integrating protocols keep
calling the same address. There is no proxy contract — Soroban has no `delegatecall`
and does not need one. In production the `upgrade_admin` is the Timelock contract, so
every upgrade passes a 7-day review window.

See [`docs/upgradeability.md`](../../../docs/upgradeability.md) for the full design
rationale, threat model, and operator runbook.

### `schema_version`
Retrieves the reputation storage schema version currently in force.
- **Parameters**:
  - `env: Env`
- **Returns**: `u32` — `1` for a contract that has never been upgraded, `2` after the Phase C upgrade.

### `get_upgrade_admin`
Retrieves the address permitted to upgrade this contract.
- **Parameters**:
  - `env: Env`
- **Returns**: `Option<Address>` — `None` if governance has not been installed.

### `init_upgrade_admin`
Installs the initial upgrade admin (the Timelock contract). Bootstrap path only; closes permanently once used.
- **Parameters**:
  - `env: Env`
  - `admin: Address`: The address to grant upgrade authority to.
- **Authorization**: Requires authorization from every arbitrator recorded by `initialize` — the whole committee must consent, so no single arbitrator can unilaterally install an upgrade admin they control.
- **Panics**: `Error::NotInitialized` if the contract has not been initialized, `Error::UpgradeAdminAlreadySet` if an upgrade admin is already installed.

### `set_upgrade_admin`
Transfers upgrade authority to a different address.
- **Parameters**:
  - `env: Env`
  - `new_admin: Address`
- **Authorization**: Requires authorization from the current upgrade admin — i.e. it must be proposed through the timelock and inherits the 7-day delay.
- **Panics**: `Error::UpgradeAdminNotSet` if no upgrade admin is installed.

### `upgrade`
Replaces the contract's executable and moves the storage schema forward, atomically. The contract ID and all stored state are preserved.
- **Parameters**:
  - `env: Env`
  - `new_wasm_hash: BytesN<32>`: Hash of an already-uploaded Wasm blob, pinned by the timelock at proposal time.
  - `new_schema_version: u32`: Schema version to move to in the same transaction. Pass the current version for a code-only release.
- **Authorization**: Requires authorization from the upgrade admin (the Timelock).
- **Panics**: `Error::UpgradeAdminNotSet` if governance is not installed, `Error::SchemaDowngrade` if the version is below the one in force, `Error::UnsupportedSchemaVersion` if it exceeds what the executable understands.

### `get_reputation_v2`
Retrieves the Attestor-enabled (V2) reputation for an address. Serves correct V2 data whether or not the row has physically been migrated.
- **Parameters**:
  - `env: Env`
  - `address: Address`
- **Returns**: `ReputationV2` — the three V1 counters plus `direct_count`, `attested_count`, `updated_at`, and `version`. Zeroed for an address with no history.

### `migration_pending`
Returns whether an address still holds a V1 row awaiting rewrite as V2.
- **Parameters**:
  - `env: Env`
  - `address: Address`
- **Returns**: `bool` — always `false` while the contract is on schema V1.

### `migrate_reputation_batch`
Rewrites a bounded batch of V1 reputation rows into the V2 layout.
- **Parameters**:
  - `env: Env`
  - `addresses: Vec<Address>`: At most 100 addresses.
- **Authorization**: None — permissionless. Migration is idempotent, cannot alter any counter's value, and the caller pays the fees.
- **Returns**: `u32` — how many rows were actually rewritten. Addresses already on V2, or never scored, count as zero.
- **Panics**: `Error::MigrationNotEnabled` if the contract is still on schema V1, `Error::BatchTooLarge` if the batch exceeds 100 addresses.
- **Note**: An *archived* entry is not readable as absent — touching one aborts the invocation. Restore such keys with `RestoreFootprint` before migrating them.

## Storage Schemas

### V1 (Phase B)
`ReputationKey::Reputation(Address)` → `Reputation { fulfilled_count, late_count, breached_count }`

### V2 (Phase C, Attestor-enabled)
`ReputationKey::ReputationV2(Address)` → `ReputationV2 { fulfilled_count, late_count, breached_count, direct_count, attested_count, updated_at, version }`

Migrating a V1 row copies the three counters verbatim, sets `direct_count` to their sum
(every Phase B outcome was recorded by a commitment party or the arbitrator) and
`attested_count` to `0` (no Attestor existed). `get_reputation` continues to return the
V1 struct under both schemas, so existing integrations need no changes.

Adding `ReputationV2` does not disturb existing entries: `#[contracttype]` encodes an
enum variant by name rather than by ordinal, so already-written `Reputation(addr)` keys
remain byte-identical.

## Optimistic Rollup Batch Roots (Issue #182)

High-frequency micro-commitments accumulate client-side into a Merkle batch. Only the
batch root is submitted on-chain via `submit_batch_root`, with an ordered cosigner set
that must meet the configured quorum. If the batch processor fails to post a root
covering a commitment within the challenge window, anyone may call `force_include`.

| Entrypoint | Role |
|------------|------|
| `configure_rollup` | Set quorum + challenge window (arbitrator) |
| `submit_batch_root` | Accept next sequential batch root + signer quorum |
| `last_batch_seq` / `get_batch_root` | Read accepted roots |
| `force_include` / `get_forced_inclusion` | Censorship / liveness fallback |

Frontend: `OptimisticRollupEngine` in `frontend/src/lib/optimisticEngine.ts` with
`MerkleAccumulator`, hook `useOptimisticRollup`, and `RollupStatusPanel` showing
**Pending rollup** vs **On-chain finalized**.
