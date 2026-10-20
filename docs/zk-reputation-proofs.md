# Verifiable Reputation Export — zero-knowledge Trust Score threshold proofs

A Pactum user can prove to a third party — a DAO gating voting rights, a marketplace
gating a listing — that their Trust Score exceeds some threshold, **without revealing
the score and without revealing which Stellar address is theirs**.

The proof is generated entirely in the user's browser. Nothing secret is sent to the
Pactum backend, and the backend is never told which address a given proof is about.

- Circuit: [`zk/circuits/trust_threshold.circom`](../zk/circuits/trust_threshold.circom)
- Library: [`zk/src`](../zk/src)
- Tests: [`zk/test`](../zk/test)

---

## 1. What is being proven

> "There exists an address in reputation snapshot `root` whose Trust Score is strictly
> greater than `threshold`, and I know the private data behind it — proven for context
> `contextId`."

| Signal                        | Visibility          | Meaning                                                                        |
| ----------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `root`                        | **public**          | Merkle root of the reputation snapshot the claim is made against               |
| `threshold`                   | **public**          | The bar cleared (e.g. `800`)                                                   |
| `contextId`                   | **public**          | Verifier/session binding, so a proof for one DAO is not valid at another       |
| `aboveThreshold`              | **public (output)** | Always `1` — the circuit is unsatisfiable otherwise                            |
| `score`                       | _private_           | The exact Trust Score                                                          |
| `addrHi`, `addrLo`            | _private_           | The 32-byte ed25519 public key behind the `G...` address, as two 128-bit limbs |
| `pathElements`, `pathIndices` | _private_           | The Merkle authentication path, which would otherwise identify the leaf        |

Leaking any of the private signals defeats the feature, so the split is asserted in
tests rather than left to review: `circuit.test.ts` checks that exactly four public
signals are emitted and that the score is not among them.

---

## 2. The reputation snapshot

The registry contract stores only outcome counts per address
([`contracts/registry/src/reputation.rs`](../contracts/registry/src/reputation.rs)):
`fulfilled_count`, `late_count`, `breached_count`. There was no Trust Score and no
Merkle tree before this change; both are defined here.

**Trust Score** ([`zk/src/score.ts`](../zk/src/score.ts)) — a 0..1000 integer:

```
total = fulfilled + late + breached
score = total == 0 ? 0 : floor((fulfilled * 1000 + late * 500) / total)
```

An address with no settled commitments scores 0. Scoring an empty history as perfect
would let a freshly created address clear any threshold, which is the one failure mode
a reputation system cannot have. Integer floor division keeps the indexer and the
browser bit-identical; a single point of disagreement changes the leaf and invalidates
every proof.

**Tree** ([`zk/src/tree.ts`](../zk/src/tree.ts)) — a depth-16 Poseidon binary tree
(65,536 addresses per snapshot), one leaf per address:

```
leaf  = Poseidon(addrHi, addrLo, score)
node  = Poseidon(left, right)
```

Entries are sorted ascending by address, then padded to capacity with the empty leaf
`0`. The ordering is what lets two independent rebuilds of the same entry set agree
without the snapshot carrying explicit indices.

Poseidon rather than SHA-256/Keccak because the circuit recomputes one hash per level:
Poseidon costs a few hundred R1CS constraints, SHA-256 costs tens of thousands. At
depth 16 that is the difference between a circuit that proves in a browser tab and one
that does not. **The existing registry contract does not commit to a reputation tree at
all**, so there was no ZK-hostile hash to work around — but note the consequence in
§6: the snapshot root is currently produced by the indexer, not by the contract.

---

## 3. Browser-local proving flow (AC #3)

The privacy-critical step is **how the user obtains their Merkle path**. Asking the
backend "what is the path for `GABC…`?" would hand it the exact address the proof is
meant to hide, and would let it correlate that request with the proof it later sees.

So the backend must not answer that question. It publishes the **entire snapshot**, and
the browser derives its own path locally:

```
   Pactum indexer                      User's browser                    Verifier (DAO)
        │                                     │                                │
        │  GET /api/zk/snapshot               │                                │
        │◄────────────────────────────────────┤   (no address in the request)  │
        │  { root, depth, entries[] }         │                                │
        ├────────────────────────────────────►│                                │
        │                                     │ 1. rebuild tree locally        │
        │                                     │ 2. find own leaf index         │
        │                                     │ 3. read own path               │
        │                                     │ 4. groth16.fullProve(...)      │
        │                                     │                                │
        │                                     │  { proof, publicSignals }      │
        │                                     ├───────────────────────────────►│
        │                                     │                                │ verify
```

The snapshot response is identical for every caller, so the request itself carries no
information about who is asking. Everything after the download happens offline; the
address, the score and the path never leave the tab.

The snapshot file itself is produced by
[`zk/scripts/publish-snapshot.mjs`](../zk/scripts/publish-snapshot.mjs), which takes the
indexer's outcome counts and emits exactly the JSON shown above. Serving it over HTTP
is a one-line static route; §8 explains why that route is not in `backend/` yet.

```bash
node scripts/publish-snapshot.mjs counts.json snapshot.json
#   entries: 3 (capacity 65536)
#   root:    10104520719155325621983760922782806614057829659195131317450358052553319104185
```

```ts
import {
  buildPoseidonHash,
  buildSnapshot,
  findLeafIndex,
  merklePath,
  generateTrustThresholdProof,
} from '@pactum/zk-reputation';

// 1. Fetch the public snapshot. Note: no address is sent.
const snapshotData = await fetch('/api/zk/snapshot').then((r) => r.json());

// 2. Rebuild the tree in the browser and locate your own leaf.
const hash = await buildPoseidonHash();
const snapshot = buildSnapshot(hash, snapshotData.entries);
const index = findLeafIndex(snapshotData.entries, myAddress);
const path = merklePath(snapshot, index);

// 3. Prove. `wasm` and `zkey` are static assets fetched from any host.
const { proof, publicSignals } = await generateTrustThresholdProof(
  { address: myAddress, score: myScore, threshold: 800, contextId: 424242n, path },
  { wasm: '/zk/trust_threshold.wasm', zkey: '/zk/trust_threshold_final.zkey' },
);

// 4. Send only these two values to the DAO.
```

The user never types or uploads a secret key. The address alone is enough to build the
proof — the circuit proves knowledge of a leaf preimage, not control of the key (see
§5 for what that does and does not buy).

### Snapshot size

At depth 16 a full snapshot is at most 65,536 entries — roughly 4 MB of JSON, and the
in-browser rebuild is ~131,000 Poseidon hashes (a few seconds with the WASM backend).
For larger deployments the snapshot should be served as a compact binary and cached; a
"give me the path for my address" endpoint would be smaller but would destroy the
privacy property, so it is deliberately not offered.

---

## 4. Verification (AC #2): off-chain

Verification runs **off-chain**, via
[`verifyTrustThresholdProof`](../zk/src/verify.ts). This is one of the two options
AC #2 allows, and §6 explains why the on-chain option was not taken.

Checking the pairing equation is only half the job. A Groth16 proof asserts "these
public signals satisfy the circuit" — it says nothing about whether those signals are
the ones you care about. A verifier that calls `groth16.verify` and stops there will
accept a valid proof made against a stale root, with a threshold of `0`, or for a
different DAO. `verifyTrustThresholdProof` checks both halves:

```ts
const result = await verifyTrustThresholdProof({
  proof,
  publicSignals,
  verificationKey,
  expectedRoot: currentSnapshotRoot, // must be a snapshot you trust and consider fresh
  minThreshold: 800n, // proven threshold must be at least this
  expectedContextId: myDaoContextId, // must be bound to you
});
if (!result.valid) reject(result.reason);
```

It also refuses a proof whose `aboveThreshold` output is not `1` — belt and braces,
since the circuit already constrains it.

The same checks are available as a command, so a verifier can run one without writing
any code — [`zk/scripts/verify-proof.mjs`](../zk/scripts/verify-proof.mjs). All three
of `--root`, `--min-threshold` and `--context` are mandatory rather than optional,
because a verifier that omits them gets a green light on proofs it should refuse:

```bash
node scripts/verify-proof.mjs \
  --proof build/proof.json --public build/public.json \
  --vkey build/verification_key.json \
  --root 21410093271894211894845596911524635249692642074391825172857944299267266190964 \
  --min-threshold 800 --context 424242
# ACCEPTED
#   proven threshold: > 800
```

It exits `0` on acceptance, `1` on rejection (printing which check failed) and `2` on
bad usage.

`npm run demo` plays all three roles — indexer, browser, DAO — end to end, including a
replay attempt at a second DAO that is correctly refused.

---

## 5. Security properties

### What this achieves

- **Score secrecy.** The exact Trust Score is a private witness. A verifier learns only
  that it exceeds the threshold.
- **Address secrecy, within the snapshot.** The proof does not reveal which leaf was
  used. The anonymity set is every address in the snapshot.
- **Soundness of the comparison.** Both operands are range-checked to 32 bits with
  `Num2Bits` _before_ `GreaterThan` is applied. This is load-bearing: `GreaterThan(n)`
  works by inspecting the sign bit of `in[1] - in[0] + 2^n`, and an operand at or above
  `2^n` wraps the field modulus and can make a low score compare as high. A comparator
  applied directly to unchecked field elements is the classic soundness bug in circuits
  like this one; `circuit.test.ts` asserts that a `2^32` score is rejected.
- **Membership binding.** The score is committed inside the leaf, so a prover cannot
  keep a valid path and substitute a higher score — the leaf changes and inclusion
  fails. Tested.
- **Unsatisfiability below the threshold.** The circuit constrains `aboveThreshold === 1`
  rather than merely outputting the boolean. A circuit that only outputs it still
  produces a perfectly valid proof when the answer is `0`, and any verifier that forgets
  to read the public signal accepts it.
- **Path well-formedness.** Each `pathIndices[i]` is constrained to `{0, 1}`. An
  unconstrained direction bit would let a prover synthesise orderings that are neither
  of the two legitimate ones.
- **Context binding.** `contextId` is a public input forced into the constraint system,
  so a proof accepted by one verifier is not valid at another.

### What this does _not_ achieve

- **It does not prove control of the address.** The circuit proves knowledge of a leaf
  preimage — an address and a score. Every leaf preimage is _public_ (the snapshot is
  published), so **anyone can generate a proof for anyone else's high-scoring address.**
  This is the single most important limitation. The proof establishes "some address in
  this snapshot scores above the bar", not "_I_ am that address". Closing this requires
  proving an ed25519 signature over `contextId` inside the circuit — expensive in
  Circom — or a registration step in which the user commits `Poseidon(secret)` on-chain
  and proves knowledge of `secret`. Both are out of scope here.
- **No nullifier / no double-claim protection.** Deliberately omitted. The obvious
  construction, `nullifier = Poseidon(address, contextId)`, is _brute-forceable_: the
  set of addresses is public, so a verifier can hash every candidate against the
  published nullifier and recover exactly the address the proof was meant to hide.
  Publishing such a nullifier would defeat the whole feature. A sound nullifier needs
  the same secret-commitment machinery as the point above.
- **Anonymity is only as large as the qualifying set.** If three addresses in the
  snapshot clear 800, the proof narrows its author to those three. Verifiers should
  treat a high threshold on a small snapshot as near-identifying.
- **Snapshot freshness is the verifier's problem.** Nothing in the proof says the root
  is current. A user can keep proving against an old snapshot in which they scored well.
  Verifiers must pin `expectedRoot` to a snapshot they consider fresh; a root-with-
  expiry published on-chain would make this enforceable rather than advisory.
- **Trusted setup.** See below.
- **Unaudited.** The circuit, the tree construction and the verifier wiring have had no
  external cryptographic review. Do not use this to gate anything of value as-is.

### Trusted setup

Groth16 needs a per-circuit trusted setup. `zk/scripts/build-circuit.mjs` runs one with
**fixed, published entropy strings**, which makes local and CI builds reproducible —
and makes the resulting proving key **completely insecure for production**: the toxic
waste is in the repository, so anyone can forge a proof for any statement.

Before any real deployment: run a multi-party phase-1 ceremony (or start from a
published powers-of-tau file), run a multi-party phase-2 contribution over this
circuit's r1cs, apply a random beacon, and publish the transcript so contributors can
verify their contribution is included. The circuit is ~10k constraints, so the ceremony
is cheap; only the coordination is real work.

---

## 6. Why off-chain verification, and what on-chain would take

AC #2 allows either. Off-chain was chosen because of a curve mismatch, not because
Soroban is incapable:

- **Soroban exposes BLS12-381 only.** `soroban-sdk` 22.0.11 — the version this repo
  pins — provides `env.crypto().bls12_381()` with `g1_add`, `g1_msm`, `g2_add`,
  `g2_msm`, `pairing_check` and `Fr` arithmetic. That is _exactly_ the primitive set a
  Groth16 verifier needs, and it is genuinely usable.
- **Circom's ecosystem is BN254.** Soroban has no BN254 host functions, so an on-chain
  verifier would require moving the circuit to BLS12-381 (`circom -p bls12381`).
- **The blocker is Poseidon, not the pairing.** `circomlib`'s Poseidon round constants
  and MDS matrix were generated for the BN254 scalar field. Reusing those numbers over
  BLS12-381's field yields _a_ permutation, but not one whose security analysis carries
  over — the MDS property and the round count would have to be re-derived and
  re-justified. Shipping that quietly is precisely the "plausible-looking but silently
  insecure" outcome to avoid, so this change stays on BN254 with the standard,
  widely-reviewed parameters.

The migration path, if on-chain verification is wanted later:

1. Generate Poseidon parameters for the BLS12-381 scalar field with the reference Grain
   LFSR generator, validating the generator by reproducing circomlib's published BN254
   constants first.
2. Recompile with `circom -p bls12381`; snarkjs supports the curve
   (`powersoftau new bls12-381 …` was verified to work).
3. Write a `contracts/zk_verifier` Soroban contract implementing the Groth16 check
   `e(A, B) = e(α, β) · e(vk_x, γ) · e(C, δ)` — one `g1_msm` over the public inputs to
   build `vk_x`, then a single `pairing_check` over four pairs.
4. Budget the resource cost against Soroban's per-transaction limits before committing;
   `pairing_check` is the expensive host function here.

---

## 7. Performance

Measured on a 4-core container, depth 16, ~10k constraints:

| Step                            | Cost                                               |
| ------------------------------- | -------------------------------------------------- |
| Circuit compile + Groth16 setup | ~2 min (one-off, needs `circom`)                   |
| Proof generation                | **~1.0 s**                                         |
| Off-chain verification          | ~10 ms                                             |
| Proving key (`.zkey`)           | 6.5 MB — downloaded once by the browser, cacheable |
| Witness generator (`.wasm`)     | 2.2 MB                                             |
| Proof                           | ~800 bytes                                         |

Proving is fast enough to run inline in a browser tab without a worker, though a
verifier-facing UI should still use one to avoid blocking the main thread.

---

## 8. What is not included

- **HTTP endpoints in `backend/`.** The snapshot publisher and the verifier both ship
  as libraries plus runnable CLIs, but no Express route was added. The backend does not
  currently typecheck on `main` — `tsconfig.json` sets `moduleResolution: node`, which
  the pinned TypeScript 7 has removed, and `backend/src/routes/commitments.ts` imports
  `zod`, which is not in `backend/package.json`. Both are pre-existing and unrelated to
  this change. Adding routes on top of a package that cannot be compiled would mean
  shipping code that nobody, including CI, can verify. Wiring `GET /api/zk/snapshot`
  and `POST /api/zk/verify` is a small job once that is fixed; the request and response
  shapes are fully specified in §3 and §4.
- **A frontend proving UI.** `zk/src` is isomorphic and the flow is documented, but no
  React component was added to `frontend/`.
- **A Soroban verifier contract.** See §6 for the reasoning and the migration path.
- **A nullifier / double-claim guard.** See §5 for why a naive one is worse than none.

---

## 9. Building and testing

```bash
cd zk
npm install

# Unit tests (score, strkey, tree, verifier semantics) — no circom needed.
npm test

# Compile the circuit and run the Groth16 setup. Needs `circom` on PATH.
npm run build:circuit

# Full circuit suite: above/below threshold, boundary, invalid path, range checks.
npm run test:circuit

# End-to-end walkthrough of the whole flow.
npm run demo
```

`circom` is not on npm. Build it from source once:

```bash
git clone --depth 1 https://github.com/iden3/circom.git
cd circom && cargo build --release && cp target/release/circom ~/.local/bin/
```

The circuit tests **skip** when `build/` is absent rather than failing, so `npm test`
works on a machine without circom. CI builds the circuit so they actually run.
