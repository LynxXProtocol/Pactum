/**
 * Incremental Merkle accumulator for optimistic rollup batches.
 * Leaves use double-SHA256 to resist second-preimage attacks against the batch root.
 * Odd nodes are duplicated (Bitcoin-style). Proofs are cached at insertion time.
 */

import { sha256 } from './sha256.ts';

export type Hex32 = string;

export interface MerkleProofNode {
  sibling: Hex32;
  /** True when the sibling sits to the right of the running hash. */
  isRight: boolean;
}

export interface AccumulatorLeaf {
  index: number;
  leafHash: Hex32;
  proof: MerkleProofNode[];
}

function toHex(bytes: Uint8Array): Hex32 {
  let out = '0x';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length !== 64 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`Expected 32-byte hex, got ${hex}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(64);
  combined.set(left, 0);
  combined.set(right, 32);
  return sha256(combined);
}

/** Collision-resistant leaf: SHA256(SHA256(commitment_bytes)). */
export function doubleSha256Leaf(commitmentBytes: Uint8Array): Uint8Array {
  return sha256(sha256(commitmentBytes));
}

export function doubleSha256LeafHex(commitmentBytes: Uint8Array): Hex32 {
  return toHex(doubleSha256Leaf(commitmentBytes));
}

/**
 * Builds (or rebuilds) a full binary Merkle tree over an ordered leaf set.
 * Used internally after each insertion; callers use the incremental API.
 */
export function computeRootFromLeaves(leafHexes: Hex32[]): Hex32 {
  if (leafHexes.length === 0) {
    throw new Error('Merkle accumulator requires at least one leaf');
  }
  let layer = leafHexes.map(fromHex);
  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!;
      const right = i + 1 < layer.length ? layer[i + 1]! : left;
      next.push(hashPair(left, right));
    }
    layer = next;
  }
  return toHex(layer[0]!);
}

export function verifyMerkleProof(leafHex: Hex32, proof: MerkleProofNode[], expectedRoot: Hex32): boolean {
  let current = fromHex(leafHex);
  for (const node of proof) {
    const sibling = fromHex(node.sibling);
    current = node.isRight ? hashPair(current, sibling) : hashPair(sibling, current);
  }
  return toHex(current) === expectedRoot.toLowerCase() || toHex(current) === expectedRoot;
}

/**
 * Incremental Merkle tree: append leaves, maintain root, cache per-leaf proofs.
 */
export class MerkleAccumulator {
  private leaves: Uint8Array[] = [];
  private layers: Uint8Array[][] = [[]];
  private proofCache = new Map<number, MerkleProofNode[]>();

  get size(): number {
    return this.leaves.length;
  }

  getRoot(): Hex32 | null {
    if (this.leaves.length === 0) return null;
    const top = this.layers[this.layers.length - 1]!;
    return toHex(top[0]!);
  }

  getLeaf(index: number): AccumulatorLeaf | undefined {
    if (index < 0 || index >= this.leaves.length) return undefined;
    return {
      index,
      leafHash: toHex(this.leaves[index]!),
      proof: this.proofCache.get(index) ?? this.buildProof(index),
    };
  }

  getAllLeaves(): AccumulatorLeaf[] {
    return this.leaves.map((_, i) => this.getLeaf(i)!);
  }

  /** Append a pre-hashed leaf (already double-SHA256). Returns index + cached proof. */
  appendLeafHash(leafHash: Uint8Array | Hex32): AccumulatorLeaf {
    const leaf = typeof leafHash === 'string' ? fromHex(leafHash) : leafHash;
    if (leaf.length !== 32) throw new Error('Leaf hash must be 32 bytes');
    const index = this.leaves.length;
    this.leaves.push(leaf);
    this.rebuild();
    const proof = this.buildProof(index);
    this.proofCache.set(index, proof);
    // Re-cache all proofs — tree shape may have changed for earlier leaves.
    for (let i = 0; i < this.leaves.length; i++) {
      this.proofCache.set(i, this.buildProof(i));
    }
    return { index, leafHash: toHex(leaf), proof: this.proofCache.get(index)! };
  }

  /** Hash commitment bytes with double-SHA256 and append. */
  appendCommitment(commitmentBytes: Uint8Array): AccumulatorLeaf {
    return this.appendLeafHash(doubleSha256Leaf(commitmentBytes));
  }

  clear(): void {
    this.leaves = [];
    this.layers = [[]];
    this.proofCache.clear();
  }

  private rebuild(): void {
    this.layers = [this.leaves.map((l) => l)];
    let current = this.layers[0]!;
    while (current.length > 1) {
      const next: Uint8Array[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i]!;
        const right = i + 1 < current.length ? current[i + 1]! : left;
        next.push(hashPair(left, right));
      }
      this.layers.push(next);
      current = next;
    }
  }

  private buildProof(index: number): MerkleProofNode[] {
    const proof: MerkleProofNode[] = [];
    let currentIndex = index;
    for (let level = 0; level < this.layers.length - 1; level++) {
      const layer = this.layers[level]!;
      const isRight = currentIndex % 2 === 0;
      const siblingIndex = isRight
        ? currentIndex + 1 < layer.length
          ? currentIndex + 1
          : currentIndex
        : currentIndex - 1;
      proof.push({
        sibling: toHex(layer[siblingIndex]!),
        isRight,
      });
      currentIndex = Math.floor(currentIndex / 2);
    }
    return proof;
  }
}
