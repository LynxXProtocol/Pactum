# Upgrade and migration scripts

Operator tooling for the Pactum upgrade path. The full runbook — including what an
integrating protocol should check during the review window — is in
[`docs/upgradeability.md`](../../docs/upgradeability.md).

Every script supports **`--dry-run`**, which prints the exact `stellar` invocations
without submitting anything. Use it before every real run.

| Script                  | Who runs it        | What it does                                                                                                                    |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `propose-upgrade.sh`    | DAO admin          | Builds the artifact, prints its SHA-256, uploads it, and queues a proposal that pins the Wasm hash. **Starts the 7-day clock.** |
| `verify-proposal.sh`    | Anyone (read-only) | Reads a queued proposal and compares the pinned hash against a locally reproduced build. This is the integrator's tool.         |
| `execute-upgrade.sh`    | DAO admin          | Applies a matured proposal. One transaction: the schema version moves and the executable is replaced.                           |
| `migrate-reputation.sh` | Anyone             | Drains the V1→V2 migration backlog in bounded batches. Permissionless and idempotent.                                           |

## Configuration

```bash
export NETWORK=testnet      # stellar CLI network name
export SOURCE=dao-key       # stellar CLI key name to sign with
export TIMELOCK_ID=C...     # the Timelock contract
export REGISTRY_ID=C...     # the Registry contract
```

`verify-proposal.sh` needs only `NETWORK`, `SOURCE`, and `TIMELOCK_ID`;
`migrate-reputation.sh` needs only `NETWORK`, `SOURCE`, and `REGISTRY_ID`.

## Requirements

The [`stellar` CLI](https://github.com/stellar/stellar-cli) on `PATH`, with the network
and signing keys already configured. `--dry-run` works without it.

These scripts submit transactions to a live network and are therefore not exercised by
CI; their argument handling and batching logic are exercised via `--dry-run`.

## A note on migration

Running `migrate-reputation.sh` is storage hygiene, not a correctness requirement. The
upgrade transaction atomically switches the storage schema, and reads are served under
V2 semantics from that instant whether or not a given row has physically been rewritten
— un-migrated rows are projected up on the fly, and any row that is written to migrates
itself. This script just drains the backlog on a schedule instead of leaving rows in
the old layout indefinitely.

If a batch fails, the usual cause is an archived entry: an archived persistent entry is
not readable as absent, so touching one aborts the whole invocation. The script retries
the batch address-by-address to isolate the offenders into `<addresses-file>.failed`.
Restore those keys with `stellar contract restore` and re-run against that file.
