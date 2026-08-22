# Pactum

**An on-chain registry for recurring commitments — and a public, verifiable record of who keeps their word.**

Pactum lets any two parties register a real-world commitment on Stellar — a refund promise, an uptime guarantee, a milestone check-in, a recurring report — and tracks whether it was fulfilled on time, late, or broken. Every commitment becomes part of a public, queryable compliance history for the addresses involved.

[![Soroban](https://img.shields.io/badge/Soroban-Smart%20Contracts-7D00FF)](https://soroban.stellar.org)
[![Network](https://img.shields.io/badge/Network-Stellar%20Testnet-08B5E5)](https://stellar.org)
[![License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)
[![CI](https://github.com/amankoli09/Pactum/actions/workflows/ci.yml/badge.svg)](https://github.com/amankoli09/Pactum/actions/workflows/ci.yml)

---

## The problem

Escrow contracts handle *one-time* deals — money goes in, money comes out once conditions are met. But a lot of real commitments aren't one-time payments at all:

- A landlord promising to return a deposit within 30 days of move-out
- An API provider guaranteeing 99.9% uptime this quarter
- A freelancer committing to weekly milestone updates
- A DAO grantee promising monthly progress reports

There's currently no simple, general-purpose way to record these kinds of ongoing promises on-chain, or to see — trustlessly — whether someone has a track record of actually keeping them.

## What Pactum does

Pactum is a lightweight registry, not a payment or custody system. It doesn't hold funds. It records **who promised what to whom, by when — and whether they delivered.**

```
 create_commitment(issuer, counterparty, terms, due_at)
              │
              ▼
     ┌──────────────────┐
     │  Registry          │   on-chain source of truth
     │  Contract          │   (Soroban, Rust)
     └────────┬──────────┘
              │ events
              ▼
     ┌──────────────────┐
     │  Indexer            │   watches events, aggregates
     │  (backend)           │   per-address compliance history
     └────────┬──────────┘
              │
              ▼
     ┌──────────────────┐
     │  REST API            │   GET /reputation/GABC...
     │  + JS SDK             │   → { fulfilled: 14, late: 2, breached: 1 }
     └──────────────────┘
```

1. **Create** — either party (or both) registers a commitment: what's promised, to whom, and the due date.
2. **Attest** — when the due date arrives, the commitment is marked fulfilled, either by mutual confirmation, a designated oracle, or the counterparty's sign-off.
3. **Dispute** — if the parties disagree on whether it was met, the commitment is flagged as disputed rather than silently resolved either way.
4. **Aggregate** — the backend indexes every commitment's outcome into a per-address compliance history — a real record built from timestamped, on-chain events instead of subjective star ratings.

---

## Project structure

```
pactum/
├── contracts/registry/          # Soroban smart contract (Rust)
├── contracts/timelock/          # DAO-owned 7-day timelock gating contract upgrades
├── contracts/scripts/           # Upgrade proposal, review, execution & migration scripts
├── backend/                     # REST API + on-chain event indexer (TypeScript)
├── zk/                          # Zero-knowledge Trust Score threshold proofs (Circom + snarkjs)
├── sdk/js/                      # Lightweight JS/TS SDK for dApp integration
├── evm/                         # Pactum EVM Oracle: cross-chain trust score bridge PoC (Solidity)
├── frontend/                    # Host web app (Module Federation container)
├── frontend-dashboard-remote/   # Reputation Dashboard, an independently deployed remote module
├── frontend-wizard-remote/      # Create Commitment Wizard, an independently deployed remote module
├── docs/                        # Architecture, contract & API reference, integration guide
└── examples/                     # Minimal integration demo
```

The registry is upgradeable in place: its logic can be replaced while its address and
all stored Trust Scores are preserved, and every upgrade must pass a 7-day public
review window enforced by the timelock. See
[`docs/upgradeability.md`](./docs/upgradeability.md).

See [`docs/module-federation.md`](./docs/module-federation.md) for how the frontend's host/remote micro-frontend split works.

See [`docs/architecture.md`](./docs/architecture.md) for the full breakdown.

---

## Tech stack

| Layer | Technology |
|---|---|
| Smart contract | Rust + Soroban SDK |
| Contract network | Stellar Testnet |
| Backend API | Node.js + TypeScript + Express |
| Indexer | Soroban RPC event listener |
| Database | PostgreSQL + TimescaleDB (time-series analytics) |
| Cache | Redis (optional read cache for reputation lookups) |
| SDK | TypeScript, published as `@pactum/sdk` |
| ZK proofs | Circom 2 + snarkjs (Groth16 over BN254) |
| Testing | Cargo test (contract) · Jest (backend) · `node --test` (zk) |
| CI/CD | GitHub Actions |

---

## Contract interface (early draft)

| Method | Kind | Description |
|---|---|---|
| `create_commitment(issuer, counterparty, terms_hash, due_at)` | write | Register a new commitment between two addresses |
| `create_milestone_commitment(issuer, counterparty, terms_hash, due_at, resolver, milestone_count)` | write | Register a commitment fulfilled across several milestones |
| `attest(commitment_id, outcome)` | write | Mark the next pending milestone fulfilled, late, or breached — resolving the commitment if it is the last one |
| `attest_milestone(commitment_id, milestone_index, outcome)` | write | Mark one milestone of a commitment; the commitment resolves on the last one |
| `get_milestone(commitment_id, milestone_index)` | read | Fetch a single milestone's outcome, or nothing while it is pending |
| `dispute(commitment_id, reason)` | write | Flag a commitment as contested rather than resolved |
| `resolve_dispute(commitment_id, outcome)` | write | Designated arbitrator/oracle settles a disputed commitment |
| `get_commitment(commitment_id)` | read | Fetch a single commitment's details and status |
| `get_reputation(address)` | read | Aggregate fulfilled / late / breached counts for an address |

Full spec lives in [`docs/contract-reference.md`](./docs/contract-reference.md) as the contract develops.

## Production Deployment

The contract is currently deployed on the Stellar Testnet for testing and integration.

| Contract | Network | Contract ID | Explorer |
|----------|---------|-------------|----------|
| Registry | Testnet | `CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E` | [Stellar Expert](https://stellar.expert/explorer/testnet/contract/CBADTVTJ6IN332HIKZ7LWUYMYTLPZYCEBV3X2HS47VHR5UDBHQ3GAA7E) |

### Example Transactions

- **Initialize Contract**: [`2b9cc1afa24a3bc9a8412e045cc8c23b8d2fc3e83899ae7e3b7b8ba2b1a40552`](https://stellar.expert/explorer/testnet/tx/2b9cc1afa24a3bc9a8412e045cc8c23b8d2fc3e83899ae7e3b7b8ba2b1a40552)
- **Create Commitment**: [`5cfdc977deb9c5e16be8127611dcbcd7df6a4d67706dec082eee464af1ae34fc`](https://stellar.expert/explorer/testnet/tx/5cfdc977deb9c5e16be8127611dcbcd7df6a4d67706dec082eee464af1ae34fc)
- **Attest Commitment**: [`6e73137635796cd1786c8a6feec8365c92751f514669a3b9a907e27420088890`](https://stellar.expert/explorer/testnet/tx/6e73137635796cd1786c8a6feec8365c92751f514669a3b9a907e27420088890)

---

## Getting started (local dev)

**Prerequisites:** Rust + Cargo, `soroban-cli`, Node.js 18+, PostgreSQL, Docker (for TimescaleDB)

```bash
# 1. Clone
git clone https://github.com/<your-username>/pactum.git
cd pactum

# 2. Build & test the contract
cd contracts && cargo test

# 3. Set up TimescaleDB (for time-series analytics)
docker run -d \
  --name pactum-timescaledb \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=pactum_timeseries \
  timescale/timescaledb:latest-pg16

# 4. Set up the backend
cd ../backend
npm install
cp .env.example .env      # fill in DATABASE_URL, SOROBAN_RPC_URL, TIMESCALEDB_* config, etc.
npm run build
npm run migrate:timescale  # Run TimescaleDB migrations
npm run dev

# 5. Start analytics worker (optional, for background data processing)
npm run analytics:worker
```

### Running the whole stack with Docker

**Prerequisites:** Docker with Compose v2.

```bash
docker compose up --build
```

That boots TimescaleDB, the backend (which applies `backend/src/db/migrations/*.sql` on startup) and an nginx-served frontend build.

| Service | URL | Override |
|---|---|---|
| Frontend | http://localhost | `FRONTEND_PORT` |
| Backend | http://localhost:3000 | `BACKEND_PORT` |
| TimescaleDB | `localhost:5432` | `TIMESCALEDB_PORT` |

The frontend is built to call the API on its own origin, and nginx proxies `/api`, `/reputation`, `/commitments` and `/health` to the backend container. Database credentials and Soroban settings come from the same `TIMESCALEDB_*` / `SOROBAN_*` variables as `backend/.env.example`; set them in a root `.env` to override the defaults.

---

## Roadmap

- [ ] Core registry contract — create / attest / dispute / resolve
- [ ] Per-address reputation aggregation
- [ ] Oracle-based auto-attestation for measurable commitments (e.g. uptime feeds)
- [x] Milestone-based commitments — partial attestations against one commitment ID
- [ ] Commitment templates (refund, SLA, recurring report, milestone check-in)
- [x] Public reputation lookup API
- [ ] JS/TS SDK (`@pactum/sdk`)
- [ ] Marketplace integration example (check a counterparty's history before a deal)
- [ ] Rate limiting & spam-commitment protections
- [x] Dashboard endpoint (commitments created/fulfilled over time)
- [x] Verifiable reputation export — prove `Trust Score > threshold` in zero knowledge
      ([`docs/zk-reputation-proofs.md`](./docs/zk-reputation-proofs.md))

Open an issue if you'd like to pick up any of these — contributions welcome.

### Reputation cache

`docker compose up --build` starts a six-node Redis Cluster (three primaries and
three replicas), the API, and the finality-aware indexer. `GET
/reputation/:address` uses cache-aside reads under `trust_score:<address>` and
falls back to the latest TimescaleDB snapshot if Redis is unavailable. Finalized
ledger commits synchronously refresh every affected address before the indexer
advances.

Run `npm run load:reputation` from `backend/` against a warmed local stack to
enforce the 10,000 req/s and P99 <15ms SLO. Set `LOAD_TEST_URL`,
`LOAD_TEST_CONNECTIONS`, or `LOAD_TEST_DURATION_SECONDS` to tune the run.

---

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for local setup, coding conventions, and how to submit a pull request.

## Security

Found a vulnerability? Please see [`SECURITY.md`](./SECURITY.md) for responsible disclosure.

## License

MIT — see [`LICENSE`](./LICENSE).
