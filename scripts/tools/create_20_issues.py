#!/usr/bin/env python3
import subprocess
import json
import time

REPO = "LynxXProtocol/Pactum"

issues = [
    {
        "title": "feat(contracts): Implement Time-Weighted Average Reputation (TWAR) Segment Tree in Soroban Registry",
        "labels": ["High", "core-contract", "smart-contracts", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
To prevent flash-loan-style manipulation and sybil attacks against Attestor Reputation scores, Pactum requires a Time-Weighted Average Reputation (TWAR) system. Simple on-chain iteration over historical ledger sequences exceeds Soroban gas and CPU instruction metering limits.

We need an updatable Segment Tree (or Fenwick / Binary Indexed Tree) built natively in the Soroban `registry` contract that allows $O(\log n)$ updates upon milestone settlements and $O(\log n)$ historical range queries.

### 🛠 Technical Specifications & Complexity
1. **Packed Ledger Storage**: Pack tree nodes into contiguous byte slices (`Bytes`) within Soroban instance storage to minimize ledger read/write foot-print and entry overhead.
2. **Mathematical Decay Function**: Incorporate an exponential half-life time-decay function so older reputation settlements progressively lose influence without needing retroactive writes.
3. **Bounded Memory & Gas Limits**: Tree updates must execute within Soroban's strict CPU budget without rebalancing overhead.

### 📂 Target Files to Change
- `contracts/registry/src/reputation.rs`
- `contracts/registry/src/storage.rs`
- `contracts/registry/src/test_trust_score.rs`

### ✅ Acceptance Criteria
- [ ] Implement `TWARSegmentTree` struct supporting point updates and range aggregation queries.
- [ ] Implement half-life decay calculation based on ledger sequence delta.
- [ ] Gas benchmarks demonstrating $< 150,000$ Soroban CPU instructions per update.
- [ ] Unit tests covering edge cases: sequential updates, multi-year ledger jumps, and counter overflow/underflow.
"""
    },
    {
        "title": "feat(frontend): Attestor Staking, Dispute Resolution & Slashing Management Interface",
        "labels": ["High", "frontend", "economic-design", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
`contracts/registry/src/staking.rs` implements a cryptoeconomic staking vault (`stake_attestor`, 14-day `request_unstake`/`finalize_unstake` unbonding cycles, panel lockouts, and slashing of dissenting voters). However, this entire system is unreachable from the client web apps. The wizard currently forces a zero attestor panel and single-resolver dispute resolution.

### 🛠 Technical Specifications & Complexity
1. **Staking Dashboard**: Dedicated view allowing users to register as attestors, deposit native collateral, view locked status, and trigger the 14-day unbonding queue.
2. **Wizard Dispute Committee Config**: In `frontend-wizard-remote`, allow commitment creators to choose M-of-N decentralized dispute resolution by picking active staked attestors and configuring quorum thresholds.
3. **Voting & Resolution UI**: Provide a dispute panel view where selected attestors cast cryptographic votes, display slashing penalties for malicious dissenters, and execute final payouts.

### 📂 Target Files to Change
- `frontend-wizard-remote/src/CreateCommitmentWizard.tsx`
- `frontend-dashboard-remote/src/ReputationDashboard.tsx`
- `frontend/src/components/AttestorStakingModal.tsx` (new)
- `frontend/src/lib/soroban.ts`

### ✅ Acceptance Criteria
- [ ] Users can stake, request unstake, and view unbonding countdowns in the UI.
- [ ] Commitment creation wizard allows toggling between Single Resolver and M-of-N Attestor Staking panels.
- [ ] Attestors can review open disputes and submit dispute verdicts.
- [ ] Slashing events are clearly reflected with updated collateral balances.
- [ ] End-to-end Playwright tests verifying the staking, commitment creation, and voting lifecycle.
"""
    },
    {
        "title": "refactor(monorepo): Extract Shared @pactum/soroban-client Internal Workspace Package",
        "labels": ["High", "architecture", "frontend", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
The Module Federation architecture (`frontend/`, `frontend-dashboard-remote/`, and `frontend-wizard-remote/`) currently maintains three duplicated, drifting copies of `soroban.ts` (778, 574, and 363 lines respectively). This caused parameter mismatch bugs in preflight simulation and creates ongoing drift risk across wallet adapters, RPC failover, and XDR decoding.

### 🛠 Technical Specifications & Complexity
1. **New Workspace Member**: Create `packages/soroban-client/` and register it in root `package.json` workspaces.
2. **Unified Client Surface**: Extract RPC pooling, transaction builder, wallet adapters (Freighter, Albedo, Ledger, Web3Auth), error decoding, and preflight simulation into the package.
3. **Module Federation Sharing**: Configure Vite Module Federation plugin to share `@pactum/soroban-client` as a shared singleton runtime dependency to avoid bundling duplicate instances.

### 📂 Target Files to Change
- `package.json`
- `packages/soroban-client/` (new package)
- `frontend/package.json` & `frontend/vite.config.ts`
- `frontend-dashboard-remote/package.json` & `frontend-dashboard-remote/vite.config.ts`
- `frontend-wizard-remote/package.json` & `frontend-wizard-remote/vite.config.ts`

### ✅ Acceptance Criteria
- [ ] `packages/soroban-client` successfully builds with `tsup` emitting ESM and DTS declarations.
- [ ] Redundant `src/lib/soroban.ts` files removed from `frontend/`, `frontend-dashboard-remote/`, and `frontend-wizard-remote/`.
- [ ] All 3 apps consume `@pactum/soroban-client` via `workspace:*`.
- [ ] Host and remote builds pass without runtime singleton conflicts or duplicate chunk warnings.
- [ ] Unit tests for RPC pooling and transaction parsing moved into `packages/soroban-client/tests/`.
"""
    },
    {
        "title": "feat(crypto): Zero-Knowledge Recursive SNARK Batching for Multi-Outcome Reputation Proofs",
        "labels": ["High", "zk-proofs", "cryptography", "difficulty: very hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
Pactum currently verifies individual Trust Score threshold proofs via Groth16. When evaluating counterparty portfolios with multiple historical commitments, submitting discrete proofs results in linear on-chain verification costs and high RPC network roundtrips.

We require a recursive or batched zero-knowledge proof circuit that aggregates $k$ independent reputation outcomes into a single compact Groth16 proof while keeping cryptographic soundness.

### 🛠 Technical Specifications & Complexity
1. **Circom Circuit Aggregator**: Design `batch_reputation_verifier.circom` that takes $k$ Merkle inclusion proofs and proves cumulative trust score validity against a shared state root.
2. **Poseidon Tree Accumulator**: Implement in-circuit tree folding using 4-ary Poseidon hashing to maximize constraint efficiency.
3. **Contract Verification Engine**: Update `contracts/fraud_verifier` or registry verification hook to accept and verify unified batch proofs within Soroban computation boundaries.

### 📂 Target Files to Change
- `zk/circuits/batch_reputation.circom` (new)
- `zk/src/prove.ts`
- `zk/src/verify.ts`
- `contracts/fraud_verifier/src/lib.rs`

### ✅ Acceptance Criteria
- [ ] Circom circuit compiles under $< 80,000$ R1CS constraints for $k=8$ batched entries.
- [ ] Prover generates a unified Groth16 proof in $< 10$ seconds on modern client hardware.
- [ ] Tampering with any individual score, address, or Merkle path causes verification failure.
- [ ] Comprehensive test suite comparing discrete vs batched proof generation and verification.
"""
    },
    {
        "title": "feat(oracle): Distributed Threshold Signature Scheme (FROST / TSS) for Automated Oracle Relayer",
        "labels": ["High", "backend", "cryptography", "oracle-integration", "difficulty: very hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
The Zero-Trust Oracle currently depends on an off-chain relayer service (`backend/src/workers/crossChainRelayer.ts`) to aggregate state proofs and broadcast them to EVM destination contracts. This introduces a single point of failure and centralized trust assumption.

We need to implement a decentralized Threshold Signature Scheme (TSS) using FROST (Flexible Round-Optimized Schnorr Threshold) / threshold ECDSA.

### 🛠 Technical Specifications & Complexity
1. **Distributed Key Generation (DKG)**: Implement Pedersen-VSS or Feldman-VSS based distributed key generation between attestor nodes without a central trusted dealer.
2. **Two-Round Signing Protocol**: Coordinate $t$-of-$n$ signature generation over peer-to-peer WebSocket / libp2p channels, tolerating network latency and up to $n-t$ offline nodes.
3. **On-Chain Signature Verification**: Emit a single SECP256k1 signature verifiable by EVM `PactumTrustOracle.sol` or Soroban Ed25519 threshold verifiers.

### 📂 Target Files to Change
- `backend/src/crypto/tss/` (new module)
- `backend/src/workers/crossChainRelayer.ts`
- `evm/contracts/PactumTrustOracle.sol`

### ✅ Acceptance Criteria
- [ ] Asynchronous DKG protocol executes and yields valid shared public key across 5 participating nodes.
- [ ] 3-of-5 threshold signing generates valid signature even when 2 nodes fail to respond.
- [ ] Malicious or invalid shares are detected and culprit nodes identified for slashing.
- [ ] Automated integration test proving end-to-end state relay to EVM testnet using TSS signature.
"""
    },
    {
        "title": "feat(frontend): Multi-Signature Transaction Coordinator UI with Partially-Signed XDR Sharing",
        "labels": ["High", "frontend", "web3-integration", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
Enterprise and institutional users requiring multi-party authorization cannot use Pactum, as the frontend currently assumes a single user signature per commitment lifecycle event. We need a multi-signature transaction coordination interface.

### 🛠 Technical Specifications & Complexity
1. **Partial XDR Parsing & Inspection**: Decode incomplete Stellar transaction envelopes, displaying already-collected signers, required remaining signatures, and decoded operation parameters.
2. **Shareable State & Links**: Allow partial envelopes to be exported as URL payloads (compressed with LZ-string/base64), downloadable `.xdr` files, or QR codes for mobile signers.
3. **Threshold Detection & Submission**: Automatically detect when the required weight threshold is satisfied and submit the final transaction to the Soroban RPC pool.

### 📂 Target Files to Change
- `frontend/src/components/MultiSigCoordinatorModal.tsx` (new)
- `frontend/src/lib/xdrDecode.ts`
- `frontend/src/lib/sorobanTxHelpers.ts`
- `frontend/src/hooks/useMultiSig.ts` (new)

### ✅ Acceptance Criteria
- [ ] Interface decodes and visualizes partial signers and threshold weights (e.g., "Weight 10/20 reached").
- [ ] First signer can sign with Freighter/Ledger and copy an encrypted coordination link.
- [ ] Second signer opening the link can review decoded parameters and append their signature.
- [ ] Auto-submission occurs immediately upon reaching threshold, with clear explorer link.
"""
    },
    {
        "title": "feat(frontend): Client-Side SPV Header Verification and Cuckoo Filter WASM Integration",
        "labels": ["High", "frontend", "cryptography", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
To achieve zero-trust client operation, web clients should not blindly rely on the Soroban RPC node for account state and commitment existence. Clients should verify Stellar ledger header chains and Merkle proofs directly in the browser via Simplified Payment Verification (SPV).

### 🛠 Technical Specifications & Complexity
1. **Rust-to-WASM Cuckoo Filter**: Implement a memory-bounded, zero-allocation Cuckoo Filter in Rust compiled via `wasm-pack` for fast commitment existence verification.
2. **Ledger Header Verifier**: Parse XDR ledger headers, verify ed25519 validator signatures, and validate SHA256 bucket list hashes in a Web Worker to avoid blocking UI rendering.
3. **SPV State Manager**: Connect local indexer queries with cryptographic proof validation.

### 📂 Target Files to Change
- `contracts/validation/` (or new `contracts/spv_verifier/`)
- `frontend/src/wasm/pactum-validation/`
- `frontend/src/workers/validation.worker.ts`
- `frontend/src/lib/localIndexer/rpcClient.ts`

### ✅ Acceptance Criteria
- [ ] WASM module evaluates inclusion proofs in $< 5$ms on client CPU.
- [ ] Worker streams and verifies continuous ledger headers without UI lag.
- [ ] Simulated malicious RPC responses (spoofed balances or tampered commitments) are flagged and blocked with warning banners.
"""
    },
    {
        "title": "feat(contracts): Dynamic Fee Elasticity & Gas-Targeting Pricing Engine for Soroban State Channels",
        "labels": ["High", "core-contract", "economic-design", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
High-throughput state channels (`contracts/state_channel`) require an automated, economically sound dispute fee mechanism. During periods of ledger congestion, static dispute collateral and settlement fees expose participants to griefing attacks where disputers are priced out of timely challenge windows.

### 🛠 Technical Specifications & Complexity
1. **EIP-1559 Style Adaptive Fee**: Implement an on-chain moving average gas target that dynamically scales dispute bond collateral based on recent Soroban resource consumption and dispute frequency.
2. **Exponential Decay Window**: Dispute challenge time windows should dynamically lengthen if base network fees spike beyond historical variance to prevent censorship attacks.
3. **Slashing Rebates**: Accrue dynamic fees into a protocol security reserve, offering proportional rebates to honest challengers.

### 📂 Target Files to Change
- `contracts/state_channel/src/lib.rs`
- `contracts/state_channel/src/storage.rs`
- `contracts/state_channel/src/test.rs`

### ✅ Acceptance Criteria
- [ ] Dispute bond scales up smoothly during consecutive dispute events and decays toward base fee when quiet.
- [ ] Dispute window automatically adjusts when block base fee exceeds threshold.
- [ ] Contract unit tests verifying resistance to sandwich attacks and griefing simulations.
"""
    },
    {
        "title": "feat(backend): TimescaleDB Continuous Aggregates and Real-time Hypertable Ingestion for Finality Indexer",
        "labels": ["High", "backend", "infrastructure", "optimization", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
As the volume of indexed Soroban ledger events grows, querying historical commitment volume, resolution durations, and attestor reliability over arbitrary time ranges creates heavy database load. `007_continuous_aggregates.sql` is partially configured, but real-time hypertable refreshes and backfill pipelines are incomplete.

### 🛠 Technical Specifications & Complexity
1. **Hypertable Continuous Aggregates**: Define 1-hour, 1-day, and 1-week continuous aggregates over `commitment_events` and `attestor_votes`.
2. **Real-time Materialized Views**: Enable TimescaleDB real-time aggregate querying so queries seamlessly blend materialized chunks with incoming raw unaggregated rows.
3. **Background Worker Optimization**: Streamline `backend/src/workers/analyticsWorker.ts` to coordinate hypertable policies, retention compression (`pg_partman`), and cache invalidation.

### 📂 Target Files to Change
- `backend/src/db/migrations/012_timescale_continuous_aggregates.sql` (new)
- `backend/src/workers/analyticsWorker.ts`
- `backend/src/routes/commitments.ts`

### ✅ Acceptance Criteria
- [ ] Migration runs cleanly in ephemeral TimescaleDB containers without schema conflicts.
- [ ] Analytical endpoint response times drop by $> 80\%$ on datasets $> 500,000$ events.
- [ ] Real-time aggregates instantly include the latest uncompressed ledger events.
"""
    },
    {
        "title": "feat(frontend): WebRTC P2P Mesh Network Anti-Entropy Gossip and Byzantine Peer Slashing",
        "labels": ["High", "frontend", "architecture", "security", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
The browser WebRTC mesh (`frontend/src/lib/mesh/`) uses a Plumtree epidemic broadcast tree to distribute peer state without centralized servers. However, malicious or partitioned peers can flood invalid state frames, withhold sync trees, or introduce Sybil routing loops.

### 🛠 Technical Specifications & Complexity
1. **Anti-Entropy Merkle Exchanges**: Periodically exchange root digests between peer subsets to reconcile dropped messages and patch tree partitions.
2. **Byzantine Peer Scoring & Slashing**: Score peers based on gossip validity, delivery latency, and duplicate ratio. Automatically blacklist and disconnect peers whose behavior score drops below cutoff.
3. **Service Worker Mesh Gateway**: Integrate `public/sw-mesh.js` to persist mesh connections across client page navigation and background tab throttling.

### 📂 Target Files to Change
- `frontend/src/lib/mesh/antiEntropy.ts`
- `frontend/src/lib/mesh/peerScoring.ts`
- `frontend/src/lib/mesh/plumtreeEngine.ts`
- `frontend/public/sw-mesh.js`

### ✅ Acceptance Criteria
- [ ] Partitions heal automatically through periodic anti-entropy exchanges within 3 rounds.
- [ ] Malformed message injection triggers immediate peer disconnection and local blacklist.
- [ ] Vitest unit test suite validating Byzantine fault resistance under 30% malicious peer ratio.
"""
    },
    {
        "title": "feat(contracts): Zero-Knowledge Fraud Proof Interactive Dispute Protocol in Soroban",
        "labels": ["High", "core-contract", "zk-proofs", "security", "difficulty: very hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
`contracts/fraud_verifier` provides base proof verification, but lacks an interactive bisection challenge protocol. When an optimistic state transition is challenged, generating a single full-execution ZK proof in the browser can be computation-heavy for large state transitions.

### 🛠 Technical Specifications & Complexity
1. **Interactive Bisection Game**: Implement an on-chain bisection game where challenger and sequencer alternate submitting state root hashes to narrow down the dispute to a single invalid instruction step in $O(\log N)$ turns.
2. **Single-Instruction ZK Proof Execution**: Verify the single contested step using `zk/circuits/FraudProof.circom` on-chain in Soroban, slashing the dishonest party upon resolution.
3. **Timeout Enforcement**: Enforce turn-based chess clocks to penalize stalling adversaries.

### 📂 Target Files to Change
- `contracts/fraud_verifier/src/lib.rs`
- `contracts/fraud_verifier/src/bisection.rs` (new)
- `zk/circuits/FraudProof.circom`

### ✅ Acceptance Criteria
- [ ] Bisection game converges from $N=1024$ steps to a single step in $\le 10$ on-chain rounds.
- [ ] Fraudulent sequencer is reliably slashed when submitting an incorrect intermediate hash.
- [ ] Timeout clock correctly awards victory if an adversary fails to submit their turn within deadline.
"""
    },
    {
        "title": "feat(backend): Bulletproofs Range Proof Verification for Encrypted Private Feedback Aggregation",
        "labels": ["High", "backend", "cryptography", "security", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
`backend/src/crypto/bulletproof.ts` contains base Pedersen commitments and Schnorr-style range proofs for rating integers in $[1, 5]$. We need to expand this into a production-ready non-interactive zero-knowledge Range Proof (Bulletproofs over secp256k1/ed25519) to verify arbitrary numerical ratings and transaction sizes without revealing underlying amounts.

### 🛠 Technical Specifications & Complexity
1. **Inner-Product Argument**: Implement the logarithmic-size Inner Product Argument algorithm for range proofs $[0, 2^n - 1]$ ($n=32, 64$).
2. **Batch Verification**: Implement multi-exponentiation techniques (Bos-Coster / Straus algorithm) to verify batches of range proofs simultaneously in a single operation.
3. **API Integration**: Integrate range proof verification middleware into the feedback submission routes.

### 📂 Target Files to Change
- `backend/src/crypto/bulletproof.ts`
- `backend/src/crypto/paillier.ts`
- `backend/src/routes/reputation.ts`

### ✅ Acceptance Criteria
- [ ] Generates and verifies $64$-bit range proofs with compact proof size ($< 1$ KB).
- [ ] Batch verification of 100 proofs runs in $< 50$ms.
- [ ] Out-of-range values or tampered commitments fail verification with explicit error types.
"""
    },
    {
        "title": "feat(evm): EVM Trust Bridge Destination Layer with Cross-Chain Fraud Proof Verification",
        "labels": ["High", "oracle-integration", "smart-contracts", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
The EVM contracts (`evm/contracts/PactumTrustOracle.sol` and `PactumZeroTrustOracle.sol`) currently store verified Stellar ledger headers and Merkle leaves. However, the EVM layer needs a cross-chain challenge mechanism where optimistic score updates can be contested on Ethereum/Base if an attestation is fraudulent.

### 🛠 Technical Specifications & Complexity
1. **Optimistic Window**: Add a configurable challenge window (e.g., 24 hours) during which proposed score updates can be contested by bonding ETH.
2. **On-Chain Merkle Disproval**: Challenger submits proof demonstrating that a relayed commitment outcome conflicts with a canonical Stellar ledger header.
3. **Collateral Slashing & Payout**: Dishonest relayers lose their bond, distributing rewards to the successful challenger.

### 📂 Target Files to Change
- `evm/contracts/PactumTrustOracle.sol`
- `evm/contracts/PactumZeroTrustOracle.sol`
- `evm/test/PactumTrustOracle.test.js`

### ✅ Acceptance Criteria
- [ ] Optimistic updates are locked until challenge period expires.
- [ ] Challenger can submit contradictory Merkle proof to cancel the pending update and claim relayer bond.
- [ ] Full Hardhat test suite verifying happy path, challenge success, and invalid challenge rejection.
"""
    },
    {
        "title": "feat(contracts): Decentralized Attestor VRF-Based Panel Selection for Dispute Committees",
        "labels": ["High", "core-contract", "security", "cryptography", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
Selecting dispute attestors directly from the registry can result in targeted collusion or briberies if parties can predict which attestors will be assigned to a commitment's dispute panel. Attestor panel selection must be pseudorandom, deterministic, and unpredictable prior to dispute declaration.

### 🛠 Technical Specifications & Complexity
1. **Verifiable Random Function (VRF) Seed**: Derive committee entropy using Stellar ledger hash history and dispute declaration parameters.
2. **Stake-Weighted Selection**: Sample $M$ unique attestors from the registry's active staked pool proportional to their staked balance without bias.
3. **Commitment Panel Assignment**: Bind the selected committee cryptographically to the commitment dispute record in contract storage.

### 📂 Target Files to Change
- `contracts/registry/src/staking.rs`
- `contracts/registry/src/commitments.rs`
- `contracts/registry/src/test_voting.rs`

### ✅ Acceptance Criteria
- [ ] Panel selection produces uniform distribution proportional to stake weights.
- [ ] Committee selection cannot be manipulated or predicted before dispute block sequence.
- [ ] Unit tests proving zero duplicate attestors in a selected panel.
"""
    },
    {
        "title": "feat(frontend): Offline-First CRDT Merkle DAG Conflict Resolution with Cryptographic Signatures",
        "labels": ["High", "frontend", "architecture", "cryptography", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
The offline-first CRDT layer (`frontend/src/lib/crdt/`) provides decentralized data synchronization across browser tabs and devices. To protect against state tampering and unauthorized mutations when syncing asynchronously, all Merkle DAG nodes must carry ed25519 cryptographic signatures and vector clock provenance.

### 🛠 Technical Specifications & Complexity
1. **Cryptographically Signed Nodes**: Sign each CRDT update with the participant's active wallet/session key prior to insertion into the DAG.
2. **Causal Pruning & Compaction**: Compact historical tombstone operations and prune saturated vector clocks while preserving causal consistency.
3. **Partition Reconciliation**: Reconcile divergent branches via 3-way merge rules without loss of valid milestones.

### 📂 Target Files to Change
- `frontend/src/lib/crdt/merkleDAG.ts`
- `frontend/src/lib/crdt/secureVectorClock.ts`
- `frontend/src/lib/crdt/byzantineHealer.ts`

### ✅ Acceptance Criteria
- [ ] Nodes with invalid or mismatched cryptographic signatures are rejected.
- [ ] DAG compaction reduces storage overhead by $\ge 60\%$ while maintaining linearizable state.
- [ ] Vitest test suite reproducing network partition and verifying automatic merge convergence.
"""
    },
    {
        "title": "feat(cli): Comprehensive Automated Integration Test Harness and Soroban Sandbox Runner for @pactum/cli",
        "labels": ["High", "testing", "e2e", "infrastructure", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
The `@pactum/cli` terminal tool (`packages/cli`) provides commands for authentication, commitment lifecycle, and reputation queries. While unit tests exist, there is no end-to-end integration test runner that spins up a local Soroban sandbox, executes CLI commands via child processes, and asserts state changes against local RPC.

### 🛠 Technical Specifications & Complexity
1. **Ephemeral Sandbox Harness**: Write a test harness that boots a local `stellar-quickstart` container or leverages mock RPC to execute live CLI commands.
2. **Full Lifecycle Scenarios**: Automate end-to-end testing of `pactum auth init`, `pactum commitments create`, `pactum commitments attest`, and `pactum reputation get`.
3. **Terminal Output Assertions**: Validate structured CLI output, interactive prompts, and error codes.

### 📂 Target Files to Change
- `packages/cli/tests/e2e.test.ts` (new)
- `packages/cli/package.json`
- `.github/workflows/ci.yml`

### ✅ Acceptance Criteria
- [ ] Automated CLI integration suite runs in CI without timeouts or flaky hangs.
- [ ] CLI correctly manages config storage in temp directories during test runs.
- [ ] Validates CLI handling of contract errors, network disconnects, and invalid seed phrases.
"""
    },
    {
        "title": "feat(contracts): Timelock Governance Multi-Stage Veto and Emergency Circuit Breakers",
        "labels": ["High", "core-contract", "security", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
The `timelock` contract (`contracts/timelock`) handles upgrade proposals with a minimum 7-day delay. To safeguard protocol assets during zero-day vulnerabilities or malicious upgrade attempts, the timelock requires a multi-stage veto mechanism and emergency circuit breaker.

### 🛠 Technical Specifications & Complexity
1. **Guardian Multi-Sig Veto**: Allow designated guardian addresses to cancel queued proposals or pause contract dispatch in an emergency without administrative keys.
2. **Circuit Breaker Rate Limiter**: Enforce global caps on contract upgrades and state migrations per epoch (e.g., maximum 1 migration per 30-day window).
3. **Graceful Post-Pause Unwinding**: Implement time-decayed recovery after an emergency pause to prevent perpetual governance deadlocks.

### 📂 Target Files to Change
- `contracts/timelock/src/lib.rs`
- `contracts/timelock/src/test.rs`
- `docs/upgradeability.md`

### ✅ Acceptance Criteria
- [ ] Guardian can veto and purge malicious queued proposal prior to ETA execution.
- [ ] Circuit breaker restricts upgrades to at most 1 per epoch.
- [ ] Exhaustive Soroban unit tests covering guardian vetoes, rate limiting, and pause recovery.
"""
    },
    {
        "title": "feat(backend): Distributed Rate Limiting & Sliding Window Token Bucket with Redis Cluster",
        "labels": ["High", "backend", "infrastructure", "security", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
The backend API handles public commitment queries, indexer events, and analytics. The current in-memory rate limiter does not synchronize across multi-container instances in production clusters, making the API vulnerable to coordinated DDoS and database exhaustion.

### 🛠 Technical Specifications & Complexity
1. **Redis Sliding Window Rate Limiter**: Implement a Redis Lua script executing an atomic sliding window log/token bucket algorithm.
2. **Tiered Limits**: Differentiate between anonymous public endpoints, registered attestor WebSocket streams, and internal relayers.
3. **Graceful Degradation**: Fall back to in-memory local token bucket if Redis cluster experiences connectivity failover.

### 📂 Target Files to Change
- `backend/src/middleware/rateLimiter.ts`
- `backend/src/middleware/rateLimiter.test.ts`
- `backend/src/index.ts`

### ✅ Acceptance Criteria
- [ ] Redis Lua script executes in $< 1$ms and guarantees atomicity under high concurrent concurrency (tested with `autocannon`).
- [ ] Rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`) returned on all responses.
- [ ] Unit & integration tests simulating Redis outages and verifying zero downtime fallback.
"""
    },
    {
        "title": "feat(frontend): Preflight Simulation & Predictive Gas Estimation Modal for Complex Multi-Op Contracts",
        "labels": ["High", "frontend", "web3-integration", "optimization", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
Submitting complex Soroban transactions (creating commitments with custom validation rules, attestor panels, and encrypted terms) without preflight estimation can lead to unexpected transaction failure and wasted network fees. Users need an informative preflight simulation modal.

### 🛠 Technical Specifications & Complexity
1. **RPC Preflight Simulation**: Execute `simulateTransaction` on Soroban RPC before requesting wallet signature, parsing predicted CPU/memory costs and resource fees.
2. **Storage Footprint Analysis**: Calculate persistent vs temporary ledger entry read/write counts and display storage deposit requirements.
3. **Simulation Diff Preview**: Visual display showing anticipated state changes, balance changes, and risk warnings.

### 📂 Target Files to Change
- `frontend/src/components/PreflightSimulationModal.tsx` (new)
- `frontend/src/hooks/usePreflightSimulation.ts` (new)
- `frontend-wizard-remote/src/CreateCommitmentWizard.tsx`

### ✅ Acceptance Criteria
- [ ] Preflight modal renders accurate CPU instructions, resource fees, and projected outcome.
- [ ] Prevents submission and warns user if preflight indicates contract revert or insufficient balance.
- [ ] Smooth animated UI with clear breakdown of fee components.
"""
    },
    {
        "title": "feat(sdk): High-Resilience RPC Failover, Health Score Tracking, and Speculative Retries in @pactum/sdk",
        "labels": ["High", "architecture", "infrastructure", "optimization", "difficulty: hard", "GrantFox OSS", "Maybe Rewarded"],
        "body": """### 📌 Problem Description
The JavaScript SDK (`sdk/js`) interacts with Soroban RPC nodes for fetching state, events, and submitting transactions. Currently, RPC failures require manual handling by downstream developers. The SDK requires an enterprise-grade RPC connection pool with health score tracking and speculative retries.

### 🛠 Technical Specifications & Complexity
1. **Dynamic Health Scoring**: Track latency, success rate, and rate-limiting responses (429s) across multiple configured RPC nodes using an exponentially weighted moving average (EWMA).
2. **Speculative Hedged Requests**: For idempotent queries (fetching account state, commitments), send speculative backup requests to a secondary node if primary doesn't reply within 95th percentile latency.
3. **Automated Reconnect & Failover**: Transparently failover without bubbling network errors to consumer applications.

### 📂 Target Files to Change
- `sdk/js/src/client.ts`
- `sdk/js/src/networks.ts`
- `sdk/js/tests/rpcPool.test.ts` (new)

### ✅ Acceptance Criteria
- [ ] SDK accepts array of RPC endpoints and automatically routes queries to highest-scoring node.
- [ ] Hedged requests reduce p99 query latency by $> 30\%$ under simulated packet loss.
- [ ] Complete Vitest test suite testing node failover, rate-limit recovery, and exponential backoff.
"""
    }
]

print(f"Creating {len(issues)} issues...")
for i, item in enumerate(issues, start=1):
    title = item["title"]
    labels = ",".join(item["labels"])
    body = item["body"]
    
    with open("temp_issue_body.md", "w") as f:
        f.write(body)
        
    cmd = [
        "gh", "issue", "create",
        "--repo", REPO,
        "--title", title,
        "--body-file", "temp_issue_body.md",
        "--label", labels
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode == 0:
        print(f"[{i}/20] Successfully created: {title} -> {res.stdout.strip()}")
    else:
        print(f"[{i}/20] Failed to create: {title}\nError: {res.stderr}")
    time.sleep(1)

import os
if os.path.exists("temp_issue_body.md"):
    os.remove("temp_issue_body.md")
