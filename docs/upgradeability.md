# Upgradeability and Governance

How Pactum changes its contract logic without changing its address, and how a DAO,
a guardian, and integrating protocols each control that process.

- [Why there is no proxy contract](#why-there-is-no-proxy-contract)
- [Architecture](#architecture)
- [Storage schemas: V1 and V2](#storage-schemas-v1-and-v2)
- [Migration: what is atomic and what is not](#migration-what-is-atomic-and-what-is-not)
- [State archival](#state-archival)
- [Runbook: proposing and executing an upgrade](#runbook-proposing-and-executing-an-upgrade)
- [Runbook: reviewing an upgrade as an integrator](#runbook-reviewing-an-upgrade-as-an-integrator)
- [Threat model](#threat-model)
- [Known constraints](#known-constraints)

---

## Why there is no proxy contract

The requirement is that integrating protocols keep calling one address while the logic
behind it can change. On EVM that requires a proxy: storage lives in the proxy, logic
lives in an implementation contract, and `delegatecall` joins them.

**Soroban has no `delegatecall`, and does not need one.** A Soroban contract replaces
its own executable in place:

```rust
env.deployer().update_current_contract_wasm(new_wasm_hash);
```

The contract ID and every instance and persistent storage entry are preserved; only the
code changes. That is precisely the property a proxy is built to obtain, delivered by
the platform. Pactum therefore implements the native mechanism and puts a timelock in
front of it, rather than building an EVM-shaped proxy that Soroban would have to
emulate without the primitive that makes it work.

What the timelock owns, then, is not "the proxy" but **the authority to trigger the
in-place upgrade**: it is installed as the registry's `upgrade_admin`, and
`RegistryContract::upgrade` requires that address's authorization. The security
property is the same one the proxy arrangement provides — nobody can change the logic
behind a stable address without passing a 7-day delay — with materially fewer moving
parts and no dispatch overhead on every call.

Verified against `soroban-sdk 22.0.11` (`soroban-env-host 22.1.3`), the version this
repository targets.

## Architecture

```
        DAO (admin)                      guardian
             │                               │
   queue ────┤                               ├──── cancel (veto)
   execute ──┤                               │
             ▼                               ▼
      ┌──────────────────────────────────────────────┐
      │  TimelockContract                            │
      │    · MIN_DELAY = 7 days (a constant)         │
      │    · proposals pin the Wasm hash at queue    │
      │    · admin epoch invalidates stale proposals │
      └──────────────────────┬───────────────────────┘
                             │ upgrade(wasm_hash, schema_version)
                             │ set_upgrade_admin(new_admin)
                             ▼
      ┌──────────────────────────────────────────────┐
      │  RegistryContract   (address never changes)  │
      │    · upgrade_admin == the Timelock           │
      │    · update_current_contract_wasm(...)       │
      │    · storage preserved across the swap       │
      └──────────────────────────────────────────────┘
```

| Crate             | Path                        | Role                                                                                                    |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `registry`        | `contracts/registry`        | The Pactum registry, plus `upgrade.rs` and the V1→V2 migration                                          |
| `timelock`        | `contracts/timelock`        | Governance gate that owns the registry's upgrade path                                                   |
| `upgrade-fixture` | `contracts/upgrade-fixture` | **Test-only.** A second binary to upgrade _to_, so tests exercise a real executable swap. Not deployed. |

Operator scripts live in `contracts/scripts/`. Every one supports `--dry-run`, which
prints the exact `stellar` invocations without submitting anything.

## Storage schemas: V1 and V2

**V1** (Phase B) is the layout Pactum ships with today:

```rust
struct Reputation { fulfilled_count: u32, late_count: u32, breached_count: u32 }
// key: ReputationKey::Reputation(Address)
```

**V2** (Phase C, Attestor-enabled) keeps those three counters byte-for-byte and adds
the distinction Attestors introduce — _how_ a piece of history was established:

```rust
struct ReputationV2 {
    fulfilled_count: u32,     // carried over unchanged
    late_count: u32,          // carried over unchanged
    breached_count: u32,      // carried over unchanged
    direct_count: u64,        // outcomes established by a party or the arbitrator
    attested_count: u64,      // outcomes corroborated by a registered Attestor
    updated_at: u64,
    version: u32,
}
// key: ReputationKey::ReputationV2(Address)
```

The V1 → V2 mapping is:

| V2 field                                          | Value when migrating a V1 row | Why                                                                                              |
| ------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `fulfilled_count`, `late_count`, `breached_count` | copied verbatim               | Trust Scores must not move across an upgrade                                                     |
| `direct_count`                                    | `fulfilled + late + breached` | Every Phase B outcome was recorded by a commitment party or the arbitrator — no Attestor existed |
| `attested_count`                                  | `0`                           | There was no Attestor to corroborate anything                                                    |
| `updated_at`                                      | migration timestamp           |                                                                                                  |
| `version`                                         | `2`                           |                                                                                                  |

`direct_count` is `u64` rather than `u32` so the sum of three saturated `u32` counters
stays exact instead of clamping.

**Adding `ReputationV2` cannot disturb existing entries.** `#[contracttype]` encodes an
enum variant by its _name_, not by an ordinal — the host's own diagnostics render the
key as `[Reputation, <address>]` — so adding a variant leaves every already-written
`Reputation(addr)` key byte-identical. The `upgrade-fixture` crate re-declares these
types from scratch and reads registry-written entries in the tests, which checks this
across two independently compiled binaries rather than assuming it.

## Migration: what is atomic and what is not

The acceptance criterion asks for migration "during the atomic upgrade transaction".
Taken literally — iterate every stored reputation row and rewrite it inside the upgrade
invocation — that is a design that works only while the contract is empty. The cost
would be proportional to the number of addresses Pactum has ever scored, and would
exceed Soroban's per-transaction resource limits well before Pactum is interesting.

So the atomicity is placed where it is both achievable and load-bearing:

**Atomic (one invocation, one transaction):** `upgrade(wasm_hash, schema_version)`
records the new schema version _and_ swaps the executable. Either both land or neither
does. From the instant that transaction commits, every read is served under V2
semantics — there is no window in which some callers see V1 rules and others see V2.

**Not atomic, and deliberately so:** the physical rewrite of individual rows, which
happens by two complementary routes:

1. **Lazily.** `update_reputation` rewrites a row in the V2 layout before mutating it,
   so any address that is written to migrates itself with no operator involvement.
2. **In bounded batches.** `migrate_reputation_batch(addresses)` accepts up to 100
   addresses so a DAO — or anyone — can drain the backlog on a schedule.

**Callers cannot observe the difference.** `get_reputation_v2` projects an un-migrated
V1 row up to the V2 shape on the fly, and `get_reputation` keeps returning the original
three-counter struct in both schemas, so the indexer and the JS SDK need no changes.
Draining the backlog is a storage-hygiene task, not a correctness requirement.

`migrate_reputation_batch` is **permissionless**. It is idempotent, cannot change any
counter's value, and the caller pays the fees, so leaving it open means an integrator
can migrate addresses it cares about without waiting on the DAO. There is no state
reachable this way that an ordinary write would not reach anyway.

Migration is **one-way**: the V1 entry is removed once the V2 entry is written, so the
row is stored once and no stale V1 value can ever be served. Recovery from a bad
upgrade is therefore _forward_ — queue a corrected executable — not a revert to a
V1-only binary, which would read migrated addresses as all-zero.

## State archival

A persistent entry whose TTL lapses is archived, and **an archived entry is not
readable as absent**. Touching one aborts the invocation; on the network the
transaction is rejected before the contract runs at all, because every key an
invocation reads must be live and in its footprint. This was confirmed against the
SDK's test host, not assumed — `test_archived_row_aborts_the_invocation` pins it, and
will fail if a future SDK changes the behaviour.

Two consequences:

- A `None` on a storage read means "never written", and only that. The contract cannot
  detect, skip, or heal an archived row.
- A migration batch containing an archived address **fails as a unit**.
  `migrate-reputation.sh` handles this by retrying the batch address-by-address to
  isolate the offenders and writing them to `<addresses-file>.failed`. Restore those
  keys with `stellar contract restore` (durability `persistent`, key = the ScVal
  encoding of `ReputationKey::Reputation(<address>)`), then re-run the script against
  the failed list.

The contract never fabricates history: an address with no live row is left alone rather
than written as an all-zero V2 row, so a later restore-then-migrate still recovers the
true counters.

## Runbook: proposing and executing an upgrade

Set once:

```bash
export NETWORK=testnet
export SOURCE=dao-key          # the timelock's admin
export TIMELOCK_ID=C...
export REGISTRY_ID=C...
```

**Day 0 — publish and propose.**

```bash
# Publish the rationale first: the diff, the audit, the vote record.
DESC_HASH=$(sha256sum upgrade-rationale.md | cut -d' ' -f1)

cd contracts/scripts
./propose-upgrade.sh 2 "$DESC_HASH" --dry-run   # review the transaction
./propose-upgrade.sh 2 "$DESC_HASH"
```

This builds the artifact, prints its SHA-256, uploads it, and queues a proposal that
**pins the Wasm hash**. Nothing about the registry's behaviour changes. Announce the
proposal id and the rationale document.

Pass the _current_ schema version for a code-only bug-fix release; pass `2` for the
Phase C upgrade that moves the reputation schema.

**Days 0–7 — review.** The proposal is public and fully specified. Integrators verify
it (next section). If anything is wrong, the guardian vetoes:

```bash
stellar contract invoke --id "$TIMELOCK_ID" --source guardian-key --network "$NETWORK" \
  -- cancel --caller guardian-key --id <proposal-id>
```

Cancellation is terminal. A corrected proposal is a new proposal with a fresh 7 days.

**Day 7 — execute.**

```bash
./execute-upgrade.sh <proposal-id> --dry-run
./execute-upgrade.sh <proposal-id>
```

One transaction: the schema version moves and the executable is replaced. The registry
answers at the same address it always has.

The proposal stays executable for a 14-day grace period. After that it expires and must
be re-queued — an approval should not be able to sit dormant and fire against a
protocol that has moved on.

**Day 7+ — drain the migration backlog.** Optional, and safe to run at any pace:

```bash
# One G... address per line; build it from the indexer's issuer list.
./migrate-reputation.sh issuers.txt --batch-size 25
```

### Rotating governance

Handing the registry's upgrade authority to a different timelock goes through the same
7-day window, as a `SetUpgradeAdmin` proposal:

```bash
stellar contract invoke --id "$TIMELOCK_ID" --source "$SOURCE" --network "$NETWORK" \
  -- queue --proposer "$SOURCE" --target "$REGISTRY_ID" \
     --action '{"SetUpgradeAdmin":["C<new-timelock>"]}' \
     --description_hash <sha256>
```

Rotating the timelock's _own_ admin is immediate but requires **both** the current
admin and the guardian to sign, and bumps an epoch counter that invalidates every
queued proposal. A departing administration's in-flight upgrades do not execute under
new management; anything still wanted must be re-queued, restarting the full 7 days.

## Runbook: reviewing an upgrade as an integrator

You depend on Pactum's Trust Scores. An upgrade can change what they mean. The 7-day
window is yours.

```bash
export NETWORK=testnet TIMELOCK_ID=C... SOURCE=any-funded-key

# 1. Build the published source yourself.
git checkout <the-tag-the-DAO-published>
make -C contracts build

# 2. Compare it against what is actually queued.
cd contracts/scripts
./verify-proposal.sh <proposal-id> \
  --wasm ../target/wasm32-unknown-unknown/release/registry.wasm
```

Check, in order:

1. **The pinned Wasm hash matches your local build.** If it does not, the code that
   will execute is not the code you were shown. Nothing else on this list matters.
2. **`description_hash` matches the rationale document** the DAO published.
3. **The schema version in the action matches** what that source expects.
4. **`eta - queued_at >= 604800`.** (`min_delay` is a constant in the timelock's
   executable, not a stored setting, so this cannot be configured away — but confirm
   the timelock you are looking at is the one the registry actually answers to:
   `get_upgrade_admin` on the registry.)

**Opting out.** You have the whole window. In descending order of leverage:

- Ask the guardian to cancel, publicly, with your reasoning.
- Pin your integration to the current behaviour: cache the Trust Scores you rely on, or
  read `schema_version()` and refuse to advance past a version you have not reviewed.
- Stop reading Pactum until you are satisfied. Because the address never changes, there
  is no migration for you to perform if you later resume — but equally, there is no
  "old address" still running the code you audited. That is the trade the in-place
  model makes, and it is why the review window exists.

Subscribe to the timelock's `queued` event to be alerted at proposal time rather than
at execution time. It carries the full proposal, including the pinned hash and the eta.

## Threat model

### Defended

| Threat                                  | Defence                                                                                                                                                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Admin key compromise**                | An attacker with the admin key cannot upgrade anything for 7 days, cannot shorten that delay (`MIN_DELAY_SECONDS` is a compile-time constant with no setter path below it), and can be cut off by the guardian cancelling the proposal. |
| **Bait-and-switch on reviewed code**    | The Wasm hash is stored in the proposal at queue time and read from nowhere else at execution. Queueing different bytes creates a _new_ proposal with its own full delay; it cannot re-point one already under review.                  |
| **Replay of an executed upgrade**       | State moves to `Executed` _before_ the cross-contract call (checks-effects-interactions), and the transition is one-way. A re-entrant target cannot execute the same proposal twice.                                                    |
| **Stale authority**                     | Every proposal is pinned to an admin epoch. Rotating the admin bumps the epoch and invalidates all in-flight proposals at once, so an ejected admin's queued decisions cannot execute under new management.                             |
| **Hostile takeover via admin rotation** | Rotating the admin requires the current admin _and_ the guardian. A compromised admin key alone cannot hand governance to an attacker.                                                                                                  |
| **Zombie proposals**                    | A matured proposal expires 14 days after its eta and must be re-queued.                                                                                                                                                                 |
| **Re-initialization after upgrade**     | `initialize` and `init_upgrade_admin` are both single-shot and guarded. The bootstrap path for installing the upgrade admin closes permanently once used; every later change requires the timelock.                                     |
| **Schema rollback**                     | `upgrade` rejects a schema version below the one in force, so an upgrade cannot silently reinterpret V2 rows as V1.                                                                                                                     |
| **Unreviewed governance rotation**      | Moving the registry's upgrade authority is itself a timelocked proposal, subject to the same 7 days and the same veto.                                                                                                                  |

### Out of scope

- **A malicious but validly-approved upgrade.** If the admin, the guardian and seven
  days of public review all pass a hostile executable, it executes. The defence is
  social — reproducible builds, published diffs, integrators who actually check — and
  this contract exists to buy the time for it, not to replace it.
- **A bricking upgrade.** New Wasm that omits an `upgrade` entrypoint ends the
  registry's upgradeability permanently. This cannot be caught on-chain: Soroban
  applies the new executable only _after_ the invoking call returns, so there is no
  same-transaction post-upgrade self-check to write. It is a review-time obligation.
  The same applies to handing `set_upgrade_admin` an address that cannot use it.
- **Guardian griefing.** A malicious guardian can cancel every proposal and freeze
  upgrades indefinitely. That is the accepted cost of giving it a veto; it cannot queue
  or execute anything, so it can stall Pactum but not change it.
- **Governance vote integrity.** Whatever process elects the admin is upstream of these
  contracts, which only record a `description_hash` pointing at it.
- **Key custody.** Multisig, hardware, and quorum policy for the admin and guardian
  addresses are deployment concerns.
- **Arbitrator compromise.** Unchanged by this work; the arbitrator resolves disputes
  and, before governance is installed, performs the one-time `init_upgrade_admin`.

## Known constraints

**Migration cannot be literally atomic at scale.** Covered above. The schema switch is
atomic; the row rewrites are lazy and batched. If a future requirement genuinely needs
every row rewritten before any V2 read is served, the shape would be a migration guard
that blocks normal operation until a batched drain completes — at the cost of taking
Pactum offline for the duration. That is a worse trade for a reputation registry, where
stale-but-correct reads are strictly better than no reads.

**No same-transaction post-upgrade verification.** `update_current_contract_wasm` takes
effect only after the invocation returns, so the upgrade transaction cannot call into
the new executable to check that it works. This is why `upgrade` takes the target
schema version as an argument instead of delegating to a `migrate()` function shipped
in the new Wasm: anything that must happen atomically with the swap has to exist in the
_outgoing_ executable.

**Toolchain: the release artifact must be built with a Rust that emits MVP WebAssembly.**
`soroban-env-host 22.1.3`, pinned by `soroban-sdk 22.0.11`, rejects the reference-types
encoding that Rust ≥ 1.82 emits by default (`reference-types not enabled: zero byte
expected`), and `-C target-feature=-reference-types` is not honoured on current stable.
This is a property of the repository's existing SDK pin, not of the upgrade work, but
it matters more here than elsewhere: a Wasm blob the network will not load is a Wasm
blob that cannot be upgraded to. **Verify that any artifact you propose actually loads
before queueing it** — the 7-day window is the place to catch this. Resolving it means
moving to a `soroban-sdk` whose host supports the newer encoding, which is out of scope
for this change.

The upgrade tests work around this by upgrading to `upgrade-fixture`, a binary small
enough to avoid the offending construct, which is enough to exercise a genuine
executable swap end to end.
