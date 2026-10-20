# Timelock Contract Reference

The DAO-owned gate on every Pactum contract upgrade. Reference for its public
functions, storage lifecycle, and governance parameters.

For the design rationale, threat model, and operator runbook see
[`docs/upgradeability.md`](../../../docs/upgradeability.md).

## Contract Architecture

The timelock is installed as the registry's `upgrade_admin`. An upgrade therefore
requires: `queue` by the admin (which pins the exact Wasm hash), at least 7 days of
ledger time, then `execute` by the admin before the grace period lapses. Throughout
the delay the proposal is public and cancellable by the guardian.

There is no proxy contract. Soroban upgrades in place, so what the timelock owns is the
_authority to trigger_ that in-place swap, not a dispatch layer.

## Governance Parameters

| Constant               | Value               | Notes                                                                                                                                                                           |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIN_DELAY_SECONDS`    | `604800` (7 days)   | A compile-time constant. `initialize` and `set_delay` both refuse anything below it, so the review window cannot be shortened by the admin, by a compromised key, or by a vote. |
| `MAX_DELAY_SECONDS`    | `7776000` (90 days) | Stops a typo from parking governance indefinitely.                                                                                                                              |
| `GRACE_PERIOD_SECONDS` | `1209600` (14 days) | How long after `eta` a matured proposal stays executable.                                                                                                                       |

## Roles

- **Admin** — queues and executes proposals, and may cancel its own. The DAO.
- **Guardian** — cancels proposals (the veto), and co-signs role rotation. Cannot queue
  or execute anything.

Rotating either role requires **both** signatures. Rotating the admin bumps an epoch
counter that invalidates every queued proposal.

## Storage Lifecycle & TTL

Matches the registry's conventions: `TTL_THRESHOLD_LEDGERS` = `241920` (~14 days),
`TTL_EXTEND_LEDGERS` = `518400` (~30 days).

- **Instance**: `Admin`, `Guardian`, `Delay`, `AdminEpoch`, `NextProposalId`. Extended on every state-changing call.
- **Persistent**: `Proposal(id)`. Extended on write and on `get_proposal`.

## Proposal Actions

A closed set, deliberately — a generic call-anything timelock would let a compromised
admin queue calls to entrypoints nobody reviewed this mechanism for, and would make
static review of a queued proposal much harder.

- `Upgrade(BytesN<32>, u32)` — replace the target's executable with the given Wasm hash and move it to the given schema version, atomically.
- `SetUpgradeAdmin(Address)` — hand the target's upgrade authority to a different address.

## Public Functions

### `initialize`

Initializes the timelock. Can only be called once.

- **Parameters**: `env: Env`, `admin: Address`, `guardian: Address`, `delay_seconds: u64`
- **Authorization**: Requires authorization from **both** `admin` and `guardian`.
- **Panics**: `Error::AlreadyInitialized`, `Error::DelayTooShort` if below 7 days, `Error::DelayTooLong` if above 90 days.

### `queue`

Queues a governance action against a target, starting the delay. Pins the Wasm hash.

- **Parameters**: `env: Env`, `proposer: Address`, `target: Address`, `action: ProposalAction`, `description_hash: BytesN<32>`
- **Authorization**: Requires authorization from `proposer`, which must be the stored admin.
- **Returns**: `u64` — the new proposal's id.
- **Panics**: `Error::NotAdmin`, `Error::InvalidSchemaVersion` if an `Upgrade` names schema version 0, `Error::Overflow`.

### `cancel`

Cancels a queued proposal. Terminal.

- **Parameters**: `env: Env`, `caller: Address`, `id: u64`
- **Authorization**: Requires authorization from `caller`, which must be the admin or the guardian.
- **Panics**: `Error::NotAdminOrGuardian`, `Error::ProposalNotFound`, `Error::ProposalNotQueued`.

### `execute`

Executes a matured proposal against its target. The proposal is marked `Executed` before the cross-contract call, so a re-entrant target cannot replay it.

- **Parameters**: `env: Env`, `caller: Address`, `id: u64`
- **Authorization**: Requires authorization from `caller`, which must be the stored admin.
- **Panics**: `Error::NotAdmin`, `Error::ProposalNotFound`, `Error::ProposalNotQueued`, `Error::ProposalStale` if the admin rotated after queueing, `Error::TimelockNotElapsed` if the `eta` has not been reached, `Error::ProposalExpired` if the grace period has lapsed.

### `transfer_admin`

Rotates the admin and bumps the admin epoch, invalidating every queued proposal.

- **Parameters**: `env: Env`, `new_admin: Address`
- **Authorization**: Requires authorization from **both** the current admin and the guardian.
- **Panics**: `Error::NotInitialized`, `Error::Overflow`.

### `transfer_guardian`

Rotates the guardian. Does not bump the admin epoch, so queued proposals survive.

- **Parameters**: `env: Env`, `new_guardian: Address`
- **Authorization**: Requires authorization from **both** the admin and the current guardian.

### `set_delay`

Changes the delay applied to proposals queued from now on. Already-queued proposals keep the `eta` they were given, so this cannot pull a pending upgrade forward.

- **Parameters**: `env: Env`, `new_delay_seconds: u64`
- **Authorization**: Requires authorization from the admin.
- **Panics**: `Error::DelayTooShort`, `Error::DelayTooLong`.

### `get_proposal`

Retrieves a proposal by id.

- **Parameters**: `env: Env`, `id: u64`
- **Returns**: `Proposal`
- **Panics**: `Error::ProposalNotFound`.

### `is_executable`

Returns whether the proposal is queued, current for the admin epoch, past its `eta`, and inside its grace period.

- **Parameters**: `env: Env`, `id: u64`
- **Returns**: `bool`
- **Panics**: `Error::ProposalNotFound`.

### `get_admin` / `get_guardian` / `get_delay` / `get_admin_epoch`

Read the corresponding stored value.

- **Panics**: `Error::NotInitialized` if the contract has not been initialized.

### `min_delay`

Returns the enforced minimum delay. A constant, identical for every deployment of this executable — read it to confirm the 7-day floor rather than trusting the configured delay.

- **Returns**: `u64` (`604800`).

## Events

| Topic       | Payload              | Emitted when                                                                                          |
| ----------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `tl_init`   | delay                | The timelock is initialized                                                                           |
| `queued`    | the full `Proposal`  | A proposal is queued — carries the pinned Wasm hash and `eta`, so indexers can alert at proposal time |
| `cancelled` | canceller            | A proposal is vetoed or withdrawn                                                                     |
| `executed`  | the `ProposalAction` | A proposal executes                                                                                   |
| `tl_state`  | `ProposalState`      | Any lifecycle transition                                                                              |
| `tl_admin`  | new epoch            | Admin rotation                                                                                        |
| `tl_guard`  | new guardian         | Guardian rotation                                                                                     |
| `tl_delay`  | `(old, new)`         | Delay change                                                                                          |
