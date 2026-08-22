import { createHash } from 'node:crypto';
import { MerkleProofNode } from '../schemas/stateProof';

export function sha256(buffer: Buffer): Buffer {
  return createHash('sha256').update(buffer).digest();
}

export function sha256Hex(buffer: Buffer): string {
  return `0x${sha256(buffer).toString('hex')}`;
}

/**
 * Double-SHA256. Used for aggregation-tree leaves so a second-preimage on a
 * single SHA-256 compression cannot be swapped in as a batch commitment.
 */
export function doubleSha256(buffer: Buffer): Buffer {
  return sha256(sha256(buffer));
}

export function hashPair(left: Buffer, right: Buffer): Buffer {
  return sha256(Buffer.concat([left, right]));
}

export interface CompactMultiProof {
  /** Leaf hashes being proven, in the order of `indices`. */
  leaves: string[];
  /** Original leaf indices in the tree (same order as `leaves`). */
  indices: number[];
  /** Per-leaf audit paths against the same root. */
  proofs: MerkleProofNode[][];
  root: string;
}

/**
 * Standard Merkle Tree implementation for Stellar/Soroban contract data state proofs.
 * Odd nodes are duplicated (Bitcoin-style) so every layer has a well-defined pair.
 */
export class MerkleTree {
  private leaves: Buffer[];
  private layers: Buffer[][];

  constructor(leaves: Buffer[]) {
    if (leaves.length === 0) {
      throw new Error('MerkleTree requires at least one leaf');
    }
    this.leaves = leaves.map(l => Buffer.from(l));
    this.layers = [this.leaves];
    this.buildTree();
  }

  private buildTree(): void {
    let currentLayer = this.layers[0];
    while (currentLayer.length > 1) {
      const nextLayer: Buffer[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        const right = i + 1 < currentLayer.length ? currentLayer[i + 1] : currentLayer[i];
        nextLayer.push(hashPair(left, right));
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  public getLeafCount(): number {
    return this.leaves.length;
  }

  public getRoot(): Buffer {
    return this.layers[this.layers.length - 1][0];
  }

  public getRootHex(): string {
    return `0x${this.getRoot().toString('hex')}`;
  }

  /**
   * Generates an audit path (proof) for a given leaf index.
   */
  public getProof(index: number): MerkleProofNode[] {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error(`Leaf index ${index} out of bounds [0, ${this.leaves.length - 1}]`);
    }

    const proof: MerkleProofNode[] = [];
    let currentIndex = index;

    for (let level = 0; level < this.layers.length - 1; level++) {
      const layer = this.layers[level];
      const isRight = currentIndex % 2 === 0;
      const siblingIndex = isRight
        ? (currentIndex + 1 < layer.length ? currentIndex + 1 : currentIndex)
        : currentIndex - 1;

      const sibling = layer[siblingIndex];
      proof.push({
        sibling: `0x${sibling.toString('hex')}`,
        isRight,
      });

      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  /**
   * Multi-proof: audit path for every requested leaf against the same root.
   * Individual state transitions stay independently verifiable without the rest of the batch.
   */
  public getMultiProof(indices: number[]): MerkleProofNode[][] {
    return indices.map((index) => this.getProof(index));
  }

  /** Audit path for every leaf in index order. */
  public getAllProofs(): MerkleProofNode[][] {
    return this.leaves.map((_, index) => this.getProof(index));
  }

  /**
   * Compact multi-proof bundle: leaves + per-leaf paths + shared root.
   */
  public getCompactMultiProof(indices: number[]): CompactMultiProof {
    const unique = [...new Set(indices)];
    return {
      leaves: unique.map((index) => `0x${this.leaves[index].toString('hex')}`),
      indices: unique,
      proofs: this.getMultiProof(unique),
      root: this.getRootHex(),
    };
  }

  /**
   * Cryptographically verifies a proof against a known Merkle root.
   */
  public static verify(
    leaf: Buffer,
    proof: MerkleProofNode[],
    expectedRoot: Buffer
  ): boolean {
    let current: Buffer = Buffer.from(leaf);

    for (const node of proof) {
      const sibling = Buffer.from(node.sibling.replace(/^0x/, ''), 'hex');
      if (node.isRight) {
        current = Buffer.from(hashPair(current, sibling));
      } else {
        current = Buffer.from(hashPair(sibling, current));
      }
    }

    return current.equals(expectedRoot);
  }

  /**
   * Verifies many (leaf, proof) pairs against one root. Fails closed on the first mismatch.
   */
  public static verifyMultiProof(
    leaves: Buffer[],
    proofs: MerkleProofNode[][],
    expectedRoot: Buffer
  ): boolean {
    if (leaves.length === 0 || leaves.length !== proofs.length) {
      return false;
    }
    return leaves.every((leaf, i) => MerkleTree.verify(leaf, proofs[i], expectedRoot));
  }

  /**
   * Reconstructs the Merkle root from an ordered leaf set using the same odd-leaf
   * duplication rule as the constructor. Used on-chain to verify a full batch without
   * shipping per-entry audit paths.
   */
  public static computeRootFromLeaves(leaves: Buffer[]): Buffer {
    return new MerkleTree(leaves).getRoot();
  }
}
