# Byzantine Fault Tolerant (BFT) Gossip Protocol for Service Worker Mesh

## Overview

The **Pactum Service Worker Mesh** provides an in-browser, decentralized Peer-to-Peer (P2P) event dissemination layer over WebRTC Data Channels. By interconnecting client-side Service Workers into an epidemic gossip topology, newly indexed Soroban smart contract events are propagated instantly across user nodes, drastically reducing load on public Stellar RPC endpoints.

```text
                  ┌─────────────────────────────────────────┐
                  │          Soroban RPC Node               │
                  └────────────────────┬────────────────────┘
                                       │ (Initial Indexing)
                                       ▼
                         ┌───────────────────────────┐
                         │   Service Worker Node A   │
                         │   (Publisher / Indexer)   │
                         └───────┬───────────┬───────┘
                                 │           │
           Eager Spanning Tree   │           │   Lazy Announcement (IHAVE)
             (GOSSIP_DATA)       │           │
                                 ▼           ▼
                     ┌───────────────┐   ┌───────────────┐
                     │ Service Worker│   │ Service Worker│
                     │    Node B     │   │    Node C     │
                     └───────┬───────┘   └───────────────┘
                             │
                             ▼
                     ┌───────────────┐
                     │ Service Worker│
                     │    Node D     │
                     └───────────────┘
```

---

## Key Protocols & Architectural Components

### 1. Epidemic Routing (Plumtree Protocol)

The mesh uses a hybrid **Plumtree-style dual overlay**:

- **Eager Spanning Tree (`eagerNeighbors`)**: Low-latency spanning tree where novel `GOSSIP_DATA` messages are forwarded immediately to active peer connections. Target fanout is bounded ($D_{low} \le |E| \le D_{high}$) to avoid flooding browser resources.
- **Lazy Graph (`lazyNeighbors`)**: Passive graph where message IDs are batched into periodic `IHAVE` announcements. If a node detects a missing message from an `IHAVE` announcement, a timer triggers a `GRAFT` message to promote that link and fetch the payload.
- **Dynamic Optimization (`PRUNE`)**: If a node receives duplicate `GOSSIP_DATA` on an eager link, it sends a `PRUNE` message to demote the redundant link into the lazy graph, keeping tree depth and message amplification optimal.

### 2. Local Byzantine-Abuse Mitigation

Every node runs an autonomous `PeerScoringManager` maintaining local reputation across `[-100, +100]`:

- **Novel Valid Event**: `+5` points
- **Duplicate Message Delivery**: `-2` points (triggers `PRUNE`)
- **Malformed / Bad Schema Payload**: `-40` points
- **Byzantine Attack (Invalid XDR, negative ledger seq, skewed timestamps)**: `-80` points
- **Quarantine Threshold (`< -25`)**: Excluded from eager spanning tree.
- **Ban Threshold (`< -50`)**: Immediate WebRTC channel closure and local peer ban for 5 minutes (enforced in-memory locally without global ban propagation).
- **Score Decay**: Periodic decay (half-life) allows recovered peers to restore neutrality.

### 3. In-Browser WebRTC Mesh Transport

- **Browser-Friendly Constraints**: Connection pools capped at 8 active WebRTC connections per tab/worker to respect browser socket limits.
- **Serverless Signaling & PEX**: Local `BroadcastChannel` for tab-to-worker coordination; transitive Peer Exchange (`PEER_EXCHANGE`) across existing data channels allows decentralized network expansion without dedicated STUN/TURN clusters.
- **Liveness & Heartbeats**: Periodic `PING`/`PONG` round-trips measure latency and drop stale or unresponsive WebRTC connections.

### 4. Partition Resilience & Anti-Entropy Synchronization

- **Range-Based State Healing**: When network partitions heal or nodes reconnect after offline periods, `AntiEntropyManager` performs periodic range checkpoints $[L_{min}, L_{max}]$ with random active peers.
- **RPC Fallback Offload**: Missing ledger sequence ranges are requested and synced peer-to-peer before falling back to public RPC endpoints.

---

## File Structure

- `frontend/src/lib/mesh/types.ts`: Core protocol message definitions and interfaces.
- `frontend/src/lib/mesh/peerScoring.ts`: Byzantine scoring, validation, quarantine, and decay logic.
- `frontend/src/lib/mesh/plumtreeEngine.ts`: Dual-overlay eager/lazy epidemic broadcast engine.
- `frontend/src/lib/mesh/webrtcTransport.ts`: In-browser WebRTC connection lifecycle and signaling.
- `frontend/src/lib/mesh/antiEntropy.ts`: Partition reconciliation and ledger range sync.
- `frontend/src/lib/mesh/meshServiceWorker.ts`: Window-to-Worker coordinator.
- `frontend/public/sw-mesh.js`: Background Service Worker script.
- `frontend/src/hooks/useMeshNetwork.ts`: React integration hook.
- `frontend/src/components/MeshNetworkMonitor.tsx`: Live dashboard for mesh health and Byzantine mitigation metrics.
