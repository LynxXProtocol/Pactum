# Cross-Chain Reputation Bridging Standard

Status: **design draft + proof of concept** (tracking issue #74). This document specifies how a
Soroban-native Pactum trust score is bridged to EVM chains (Ethereum, Arbitrum, ...) via a
generic cross-chain messaging network, and how the destination-chain contract verifies and
consumes it. A minimal Solidity proof of concept implementing the destination side against a
mocked messaging layer lives in [`evm/`](../evm).

## 1. Problem

`contracts/registry` computes a trust score for a Stellar address from its on-chain commitment
history (`get_trust_score`, see [`contract-reference.md`](./contract-reference.md)). That score is
only queryable by calling into the Soroban contract — useful for Stellar-native consumers, but
invisible to an EVM contract on Ethereum or Arbitrum that wants to gate on a counterparty's Pactum
history (e.g. an EVM escrow requiring a minimum trust score before releasing funds).

Soroban and EVM chains cannot call each other directly. Bridging the score requires:

1. An off-chain component that watches Stellar for score-relevant events and knows the current
   canonical score.
2. A cross-chain messaging network that transports a message from Stellar to the EVM chain and
   gives the destination chain a way to verify the message wasn't forged or tampered with.
3. A destination-chain contract — the **Pactum EVM Oracle** — that receives, verifies, and caches
   those scores so other EVM contracts can read them cheaply and synchronously.

This is a **push, cache-and-serve** design, not a request/response oracle: nothing on the EVM
side ever blocks waiting for a live answer from Stellar. Consumers read the most recently bridged
score, together with the metadata needed to decide for themselves whether it's fresh enough to
trust.

## 2. Actors

```
 Stellar Registry Contract          Relayer            Messaging Network        Pactum EVM Oracle
 (contracts/registry, source              │              (Chainlink CCIP /              │
  of truth for trust scores)              │               LayerZero / etc.,              │
         │                                │               provider-agnostic)             │
         │  attested / disputed /         │                       │                      │
         │  resolved events               │                       │                      │
         ├───────────────────────────────>│                       │                      │
         │                                │  batch TrustScoreUpdateMessage                │
         │                                ├──────────────────────>│                      │
         │                                │                       │  verified delivery   │
         │                                │                       ├─────────────────────>│
         │                                │                       │                      │  updates
         │                                │                       │                      │  TrustScore
         │                                │                       │                      │  mapping
                                                                                            │
                                                                                    EVM consumer
                                                                                    contracts read
                                                                                    getTrustScore()
```

- **Stellar Registry Contract** — existing, unmodified source of truth. No bridge-specific code
  needed on the Soroban side; the relayer reads state via the existing public `get_trust_score`
  / `get_reputation` and the `attested` / `disputed` / `resolved` events already emitted by
  `contracts/registry/src/events.rs`.
- **Relayer** — an off-chain service (a natural extension of the existing
  `backend/src/workers/oracle.ts` worker pattern) that watches those events, accumulates the
  addresses whose score changed, and periodically submits a batched update through the messaging
  network's send API.
- **Messaging network** — any generic cross-chain messaging provider (Chainlink CCIP, LayerZero,
  Wormhole, ...). It is responsible for transporting the payload and providing the destination
  chain with a way to authenticate _who sent it and from where_ (DON signatures, DVN attestations,
  guardian signatures — provider-specific, and deliberately out of scope for this contract). The
  architecture is written against the generic capability every major messaging network provides —
  "deliver this payload to this destination contract, and let the destination contract find out
  which registered source chain/contract it came from" — so a provider can be swapped without
  changing the Oracle's application-level logic.
- **Pactum EVM Oracle** — the contract this issue delivers. Receives messages from the trusted
  messaging endpoint only, re-validates them at the application level, and stores the latest score
  per Stellar address.
- **Consumers** — any EVM contract reading `getTrustScore(bytes32 stellarAddress)`.

## 3. Message format

Stellar addresses (accounts `G...` and contracts `C...`) are 32-byte StrKey-encoded values, so
they map naturally onto Solidity's `bytes32`. The trust score itself is a signed `i64` on the
Soroban side (see `reputation::get_trust_score`); everything else in the message exists to let the
destination chain authenticate and order updates without trusting the relayer.

```solidity
struct TrustScoreEntry {
    bytes32 stellarAddress;   // raw Stellar account/contract id (StrKey payload, not the ASCII string)
    int64   score;            // weighted trust score, mirrors registry::get_trust_score
    uint32  fulfilledCount;
    uint32  lateCount;
    uint32  breachedCount;
    uint64  sourceLedgerSeq;  // Stellar ledger sequence the score was computed at
}

struct TrustScoreBatch {
    uint8              version;          // message schema version (this doc describes v1)
    bytes32            registryId;       // Soroban registry contract id this batch originated from
    uint64             batchNonce;       // monotonically increasing per registryId; replay protection
    uint64             batchTimestamp;   // unix time the relayer built the batch; staleness checks
    TrustScoreEntry[]  entries;          // 1..MAX_BATCH_SIZE updates
}
```

`TrustScoreEntry` is sized to pack into a single 32-byte storage slot on the destination
(`int64` + 3×`uint32` + `uint64` = 28 bytes), so applying one entry costs one warm/cold `SSTORE`
rather than several.

The batch is ABI-encoded and passed as the opaque `bytes payload` of the underlying messaging
network's send/receive call — this is the common shape of both LayerZero (`bytes _message`) and
Chainlink CCIP (`Client.EVMTokenAmount[]`-free `data` field), so the same encoded payload works
under either without changing the Oracle's decode logic.

## 4. Batching

The relayer does not submit one cross-chain message per score change. It accumulates changed
addresses over a window (time-boxed, e.g. every 5 minutes, or size-boxed at `MAX_BATCH_SIZE`
entries, whichever comes first) and submits one `TrustScoreBatch` per window.

This matters because on every major messaging network the dominant cost of a cross-chain message
is a **fixed per-message fee** (DON/DVN verification and destination-chain base execution cost),
largely independent of payload size up to a point. Batching amortizes that fixed cost across N
score updates instead of paying it N times. `MAX_BATCH_SIZE` (proof of concept default: 50) bounds
the destination-chain gas of processing one message so it stays predictable regardless of how many
addresses changed in a window.

`batchNonce` increments per **batch**, not per entry — cheap replay protection at the granularity
that actually matters, without per-entry bookkeeping.

## 5. Verification model (destination chain)

Two independent layers, deliberately not collapsed into one:

**Layer 1 — transport authenticity**, delegated to the messaging network. The Oracle's receive
entry point is restricted to the trusted endpoint contract for the configured provider
(`onlyEndpoint` — the standard LayerZero `Endpoint`/CCIP `Router` pattern), and the endpoint call
must declare a source chain id and source (peer) contract address that match an owner-configured
allow-list. This is the same "OApp/peer" model both LayerZero and CCIP already enforce; the Oracle
simply checks it rather than re-implementing DON/DVN verification itself.

**Layer 2 — application-level integrity**, enforced by the Oracle regardless of what layer 1
already guarantees (defense in depth — the Oracle does not assume the transport layer is
infallible or that its own configuration is never misapplied):

| Check                                                                             | Rejects                                                                                                                                  |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `version` is a supported schema version                                           | Payloads from an incompatible future/past schema                                                                                         |
| `registryId` matches the single allow-listed Soroban registry contract id         | A relayer (compromised or misconfigured) relaying scores that didn't originate from the real registry                                    |
| `batchNonce > lastNonce[registryId]`                                              | Replay of an already-applied batch                                                                                                       |
| `batchTimestamp` within an owner-configured staleness window of `block.timestamp` | A very old batch delivered late (e.g. after a long relayer/network outage) from silently overwriting current data                        |
| `sourceLedgerSeq > lastLedgerSeq[stellarAddress]`, checked **per address**        | Two batches delivered out of order (possible with a multi-relayer setup) from letting an older score clobber a newer one already applied |

Layer 2's nonce/timestamp/ledger-seq checks exist even though the messaging network typically
already provides its own replay protection (LayerZero enforces per-path nonces at the endpoint;
CCIP dedupes by message id) — the Oracle does not want its correctness to depend solely on a
specific provider's guarantees, since the provider is a pluggable, swappable dependency.

## 6. Gas cost minimization

- **Batching** (§4) amortizes the messaging network's fixed per-message fee, which otherwise
  dominates cost.
- **Packed wire format** — a `TrustScoreEntry` (score + 3 counts + ledger seq) is sized to fit a
  single 32-byte slot (28 bytes), so decoding and applying one entry's core data touches one
  `SSTORE`-equivalent instead of several; `updatedAt` is appended on-chain in a second slot.
- **Coarse-grained events by default** — the Oracle emits one `TrustScoreBatchUpdated` event per
  batch; per-entry `TrustScoreUpdated` events are opt-in (`emitDetailedEvents`, owner-configurable)
  since indexed event data is a meaningful chunk of a batch's gas cost and most consumers only need
  to read current state via `getTrustScore`, not index history on-chain.
- **Opaque bytes payload** — the messaging layer transports one ABI-encoded `bytes` blob rather
  than a typed argument list, keeping the calldata shape independent of the specific provider's
  send/receive signature and letting the relayer choose the most compact encoding off-chain.

## 7. Failure modes

- **Relayer downtime / censorship.** The Oracle is a read-through cache of Stellar state, not a
  source of truth — worst case is staleness, not an incorrect but confidently-served score.
  `getTrustScore` returns `updatedAt`/`sourceLedgerSeq` alongside the score precisely so consumers
  can apply their own staleness policy (`isStale(addr, maxAge)`) instead of the Oracle silently
  deciding what "too old" means for every consumer.
- **Stellar reorgs.** Not a concern the Oracle needs to defend against: Stellar has instant
  ledger finality (no probabilistic reorg window), so the relayer only needs to relay after ledger
  close, unlike bridges sourcing from probabilistic-finality chains.
- **Compromised relayer.** The Oracle never trusts a relayer directly — only the messaging
  network's endpoint, which requires DON/DVN-style multi-party attestation before it will deliver
  anything. A single compromised relayer key cannot post a fabricated score.
- **Schema evolution.** The `version` field plus an owner-gated supported-version set lets the
  message format evolve without breaking already-deployed consumers that only understand old
  fields.

## 8. Pactum EVM Oracle interface

```solidity
interface IPactumTrustOracle {
    struct TrustScore {
        int64  score;
        uint32 fulfilledCount;
        uint32 lateCount;
        uint32 breachedCount;
        uint64 sourceLedgerSeq;
        uint64 updatedAt; // block.timestamp of last applied update
    }

    function getTrustScore(bytes32 stellarAddress) external view returns (TrustScore memory);
    function isStale(bytes32 stellarAddress, uint256 maxAge) external view returns (bool);

    event TrustScoreBatchUpdated(bytes32 indexed registryId, uint64 batchNonce, uint256 entryCount);
    event TrustScoreUpdated(bytes32 indexed stellarAddress, int64 score, uint64 sourceLedgerSeq);
}
```

## 9. Proof of concept

[`evm/`](../evm) implements the destination side end to end against a **mocked** messaging layer
(`MockMessagingEndpoint`), so the security model above can be exercised without depending on a
live Chainlink or LayerZero deployment:

- `evm/contracts/PactumZeroTrustOracle.sol` — the Zero-Trust Oracle with optimistic challenge
  periods, bonded fraud proof submission, automated fault recovery, and slashing.
- `evm/contracts/PactumTrustOracle.sol` — the direct-apply baseline Oracle implementation.
- `evm/contracts/mocks/MockMessagingEndpoint.sol` — stands in for a verified LayerZero/CCIP
  endpoint: only _it_ is allowed to call the Oracle's receive function, mirroring the real
  `onlyEndpoint` restriction, while letting tests drive delivery directly instead of standing up a
  real messaging network.
- `evm/test/PactumZeroTrustOracle.test.js` — exercises challenge periods, bonded challenges, fraud
  proof verification, relayer/challenger slashing, reorg fault recovery, and stake management.
- `backend/src/workers/crossChainRelayer.ts` — off-chain relayer service with automated challenge
  detection, cryptographic overriding state proof generation, and reorg recovery.

See [`evm/README.md`](../evm/README.md) for how to run tests and deployment instructions.
