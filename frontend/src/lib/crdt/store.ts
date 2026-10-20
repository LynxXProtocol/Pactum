import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';

import type { Commitment, Reputation } from '@/lib/api';
import { BroadcastChannelProvider } from './broadcastchannel';
import { mergeCommitmentsFromCanonical, mergeReputationsFromCanonical } from './merge';
import type { CanonicalState, StoredCommitment, StoredReputation } from './types';
import { WebRTCProvider, type WebRTCProviderOptions } from './webrtc';

/** Room used by both the IndexedDB persistence and the BroadcastChannel provider. */
export const SYNC_ROOM = 'pactum-cache-v1';

/** Transaction origins used to keep the store and React Query in sync without feedback loops. */
export const ORIGIN_CANONICAL = 'pactum:crdt:canonical';
export const ORIGIN_LOCAL = 'pactum:crdt:local';

/**
 * CRDT-backed offline cache for the Pactum frontend.
 *
 * The entire local cache is wrapped in a single Yjs document (`commitments`
 * and `reputations` as nested Y.Maps). The document is persisted to
 * IndexedDB via `y-indexeddb` and synchronised across browser tabs in
 * real time via a BroadcastChannel provider.
 *
 * Network state is never applied blindly: it flows through the canonical
 * merge strategy, which preserves offline (pending) edits that have not yet
 * been acknowledged by the backend.
 */
class SyncStore {
  private readonly doc = new Y.Doc();

  private readonly broadcastProvider: BroadcastChannelProvider | null;

  private readonly commitmentsMap = this.doc.getMap<Y.Map<unknown>>('commitments');

  private readonly reputationMap = this.doc.getMap<Y.Map<unknown>>('reputations');

  private readonly readyPromise: Promise<void>;

  private online = typeof navigator !== 'undefined' ? navigator.onLine : true;

  private webrtcProvider: WebRTCProvider | null = null;

  constructor() {
    let persistence: IndexeddbPersistence | null = null;
    try {
      persistence = new IndexeddbPersistence(SYNC_ROOM, this.doc);
    } catch (err) {
      console.warn('[CRDT] IndexedDB persistence unavailable; using in-memory cache.', err);
    }

    if (typeof BroadcastChannel !== 'undefined') {
      this.broadcastProvider = new BroadcastChannelProvider(SYNC_ROOM, this.doc);
      this.broadcastProvider.connect();
    } else {
      this.broadcastProvider = null;
    }

    this.readyPromise = persistence
      ? persistence.whenSynced.then(() => this.broadcastProvider?.sync())
      : Promise.resolve();
  }

  /** Resolves once the persisted IndexedDB state has been loaded. */
  get ready(): Promise<void> {
    return this.readyPromise;
  }

  get isOnline(): boolean {
    return this.online;
  }

  setOnline(): void {
    this.online = true;
  }

  setOffline(): void {
    this.online = false;
  }

  /**
   * Opt-in peer-to-peer sync: connects a WebRTC mesh over this same Y.Doc so
   * counterparties can reconcile CRDT state directly with each other, even
   * when the Soroban RPC or indexer backend is completely unreachable.
   * Requires one wallet popup (to attest this tab's session key) — call once
   * per session, e.g. when a wallet address becomes available. Failure
   * (no WebRTC, wallet rejects the signature, etc.) is logged and otherwise
   * ignored: peer sync is additive, not required for the app to function.
   */
  connectPeerSync(address: string, options?: WebRTCProviderOptions): void {
    if (this.webrtcProvider || typeof RTCPeerConnection === 'undefined') return;
    const provider = new WebRTCProvider(SYNC_ROOM, this.doc, address, options);
    this.webrtcProvider = provider;
    provider.connect().catch((err) => {
      console.warn('[CRDT] WebRTC peer sync unavailable.', err);
      if (this.webrtcProvider === provider) this.webrtcProvider = null;
    });
  }

  disconnectPeerSync(): void {
    this.webrtcProvider?.destroy();
    this.webrtcProvider = null;
  }

  private toYMap(record: object): Y.Map<unknown> {
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(record)) {
      map.set(key, value as unknown);
    }
    return map;
  }

  private readStoredCommitments(): StoredCommitment[] {
    const out: StoredCommitment[] = [];
    this.commitmentsMap.forEach((record) => {
      if (record instanceof Y.Map) out.push(record.toJSON() as unknown as StoredCommitment);
    });
    return out;
  }

  private readStoredReputations(): StoredReputation[] {
    const out: StoredReputation[] = [];
    this.reputationMap.forEach((record) => {
      if (record instanceof Y.Map) out.push(record.toJSON() as unknown as StoredReputation);
    });
    return out;
  }

  /**
   * Reconcile the store against canonical backend state. Records marked as
   * `pending` (locally created/edited while offline) are preserved; the
   * backend wins for every other record.
   */
  mergeCanonical(state: CanonicalState): void {
    this.doc.transact(() => {
      if (state.commitments) {
        const merged = mergeCommitmentsFromCanonical(
          this.readStoredCommitments(),
          state.commitments,
        );
        this.applyCommitmentMerge(merged);
      }
      if (state.reputations) {
        const merged = mergeReputationsFromCanonical(
          this.readStoredReputations(),
          state.reputations,
        );
        this.applyReputationMerge(merged);
      }
    }, ORIGIN_CANONICAL);
  }

  /**
   * Mark a commitment as locally edited/created while offline. Used by write
   * paths so the canonical merge never overwrites an unacknowledged change.
   */
  markCommitmentPending(commitment: Commitment): void {
    this.doc.transact(() => {
      const record: StoredCommitment = {
        ...commitment,
        outcome: commitment.outcome ?? null,
        updatedAt: Date.now(),
        pending: true,
      };
      this.commitmentsMap.set(String(commitment.id), this.toYMap(record));
    }, ORIGIN_LOCAL);
  }

  readCommitments(): Commitment[] {
    return this.readStoredCommitments().map(
      ({ updatedAt: _updatedAt, pending: _pending, ...c }) => c,
    );
  }

  readReputation(address: string): Reputation | undefined {
    const record = this.reputationMap.get(address);
    if (!(record instanceof Y.Map)) return undefined;
    return record.toJSON() as unknown as Reputation;
  }

  observeCommitments(listener: (commitments: Commitment[]) => void): () => void {
    const handler = () => listener(this.readCommitments());
    this.commitmentsMap.observeDeep(handler);
    return () => this.commitmentsMap.unobserveDeep(handler);
  }

  observeReputation(listener: (reputations: Reputation[]) => void): () => void {
    const handler = () => listener(this.readReputations());
    this.reputationMap.observeDeep(handler);
    return () => this.reputationMap.unobserveDeep(handler);
  }

  private readReputations(): Reputation[] {
    return this.readStoredReputations().map(({ updatedAt: _updatedAt, ...r }) => r);
  }

  private applyCommitmentMerge(merged: StoredCommitment[]): void {
    const next = new Map(merged.map((c) => [String(c.id), c]));
    const stale = new Set<string>();

    this.commitmentsMap.forEach((_record, key) => stale.add(key));

    for (const [key, record] of next) {
      stale.delete(key);
      const existing = this.commitmentsMap.get(key);
      if (
        existing instanceof Y.Map &&
        JSON.stringify(existing.toJSON()) === JSON.stringify(record)
      ) {
        continue;
      }
      this.commitmentsMap.set(key, this.toYMap(record));
    }

    for (const key of stale) {
      this.commitmentsMap.delete(key);
    }
  }

  private applyReputationMerge(merged: StoredReputation[]): void {
    const next = new Map(merged.map((r) => [r.address, r]));
    const stale = new Set<string>();

    this.reputationMap.forEach((_record, key) => stale.add(key));

    for (const [key, record] of next) {
      stale.delete(key);
      const existing = this.reputationMap.get(key);
      if (
        existing instanceof Y.Map &&
        JSON.stringify(existing.toJSON()) === JSON.stringify(record)
      ) {
        continue;
      }
      this.reputationMap.set(key, this.toYMap(record));
    }

    for (const key of stale) {
      this.reputationMap.delete(key);
    }
  }
}

/** Application-wide singleton. */
export const syncStore = new SyncStore();
