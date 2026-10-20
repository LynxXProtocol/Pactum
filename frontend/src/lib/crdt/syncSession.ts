import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';

import {
  type Attestation,
  type SessionIdentity,
  importSessionPublicKey,
  signFrame,
  verifyAttestation,
  verifyFrame,
} from './signing';

const FRAME_ATTEST = 0;
const FRAME_SYNC = 1;

/** One authenticated duplex byte pipe to a peer — a WebRTC data channel, or an in-memory pipe in tests. */
export interface PeerLink {
  send(bytes: Uint8Array): void;
  onMessage(handler: (bytes: Uint8Array) => void): () => void;
  onClose(handler: () => void): () => void;
}

export type RejectionReason =
  | 'invalid-attestation'
  | 'untrusted-sender'
  | 'bad-signature'
  | 'address-mismatch'
  | 'replayed'
  | 'malformed';

export interface RejectionInfo {
  reason: RejectionReason;
  address?: string;
}

export interface SyncSessionOptions {
  /** Injectable clock for tests; also seeds the monotonic send-sequence. */
  now?: () => number;
}

interface TrustedPeer {
  attestation: Attestation;
  publicKey: CryptoKey;
  lastSeq: number;
}

/**
 * Authenticated, transport-agnostic Yjs sync peer.
 *
 * Wraps one `PeerLink` and speaks the same y-protocols sync handshake as
 * the existing `BroadcastChannelProvider`: on connect it exchanges
 * pre-attested session-key certificates, then runs sync-step-1/2 so the two
 * Y.Docs converge deterministically via Yjs's own CRDT merge algorithm — no
 * central clock involved, and no partition or reconnect needs special-case
 * handling beyond "run step 1 again", because Yjs updates are idempotent
 * and commutative.
 *
 * Every frame after the handshake is authenticated against the sender's
 * attested session key and a strictly increasing sequence number, so a
 * forged or replayed delta is dropped before it ever reaches the document.
 */
export class SignedPeerSession {
  private readonly doc: Y.Doc;
  private readonly identity: SessionIdentity;
  private readonly attestation: Attestation;
  private readonly link: PeerLink;
  private readonly now: () => number;
  private trustedPeer: TrustedPeer | null = null;
  private sendSeq = 0;
  private destroyed = false;
  private readonly rejectionListeners = new Set<(info: RejectionInfo) => void>();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeClose: () => void;
  /** Serializes frame handling so an ATTEST is always fully applied before the
   *  next frame on the same link is processed — otherwise a SYNC frame that
   *  arrives right behind it could race the (async) key import and get
   *  dropped as untrusted with nothing left to retry it. */
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(
    doc: Y.Doc,
    identity: SessionIdentity,
    attestation: Attestation,
    link: PeerLink,
    options: SyncSessionOptions = {},
  ) {
    this.doc = doc;
    this.identity = identity;
    this.attestation = attestation;
    this.link = link;
    this.now = options.now ?? Date.now;

    this.doc.on('update', this.onDocUpdate);
    this.unsubscribeMessage = link.onMessage(this.onMessage);
    this.unsubscribeClose = link.onClose(() => this.destroy());

    this.sendAttestationFrame();
    this.sendSyncStep1();
  }

  /** Notified whenever an incoming frame is rejected (forged, replayed, untrusted, expired). */
  onRejected(listener: (info: RejectionInfo) => void): () => void {
    this.rejectionListeners.add(listener);
    return () => this.rejectionListeners.delete(listener);
  }

  get isTrusted(): boolean {
    return this.trustedPeer !== null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.doc.off('update', this.onDocUpdate);
    this.unsubscribeMessage();
    this.unsubscribeClose();
    this.rejectionListeners.clear();
  }

  private reject(info: RejectionInfo): void {
    for (const listener of this.rejectionListeners) listener(info);
  }

  private nextSeq(): number {
    this.sendSeq = Math.max(this.now(), this.sendSeq + 1);
    return this.sendSeq;
  }

  private sendAttestationFrame(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, FRAME_ATTEST);
    encoding.writeVarString(encoder, this.attestation.address);
    encoding.writeVarUint8Array(encoder, this.attestation.sessionPublicKeyRaw);
    encoding.writeVarUint(encoder, this.attestation.issuedAt);
    encoding.writeVarUint(encoder, this.attestation.expiresAt);
    encoding.writeVarUint8Array(encoder, this.attestation.walletSignature);
    this.link.send(encoding.toUint8Array(encoder));
  }

  private sendSyncStep1(): void {
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, this.doc);
    void this.sendSyncBytes(encoding.toUint8Array(encoder));
  }

  private async sendSyncBytes(yjsBytes: Uint8Array): Promise<void> {
    if (this.destroyed) return;
    const seq = this.nextSeq();
    const payloadEncoder = encoding.createEncoder();
    encoding.writeVarString(payloadEncoder, this.identity.address);
    encoding.writeVarUint(payloadEncoder, seq);
    encoding.writeVarUint8Array(payloadEncoder, yjsBytes);
    const signablePayload = encoding.toUint8Array(payloadEncoder);

    const signature = await signFrame(this.identity.keyPair.privateKey, signablePayload);
    if (this.destroyed) return;

    const frameEncoder = encoding.createEncoder();
    encoding.writeVarUint(frameEncoder, FRAME_SYNC);
    encoding.writeVarUint8Array(frameEncoder, signablePayload);
    encoding.writeVarUint8Array(frameEncoder, signature);
    this.link.send(encoding.toUint8Array(frameEncoder));
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this || this.destroyed) return;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    void this.sendSyncBytes(encoding.toUint8Array(encoder));
  };

  private onMessage = (bytes: Uint8Array): void => {
    if (this.destroyed) return;
    // Chain onto the queue rather than firing handlers concurrently, so frames
    // are fully processed in arrival order — see `messageQueue` above.
    this.messageQueue = this.messageQueue.then(() => this.processMessage(bytes));
  };

  private async processMessage(bytes: Uint8Array): Promise<void> {
    if (this.destroyed) return;
    try {
      const decoder = decoding.createDecoder(bytes);
      const kind = decoding.readVarUint(decoder);
      if (kind === FRAME_ATTEST) {
        await this.handleAttestFrame(decoder);
      } else if (kind === FRAME_SYNC) {
        await this.handleSyncFrame(decoder);
      }
    } catch {
      // Malformed/truncated frame (corrupt transport, hostile peer) — drop it,
      // never let a parse failure crash the session or reach the Y.Doc.
      this.reject({ reason: 'malformed' });
    }
  }

  private async handleAttestFrame(decoder: decoding.Decoder): Promise<void> {
    const address = decoding.readVarString(decoder);
    const sessionPublicKeyRaw = decoding.readVarUint8Array(decoder);
    const issuedAt = decoding.readVarUint(decoder);
    const expiresAt = decoding.readVarUint(decoder);
    const walletSignature = decoding.readVarUint8Array(decoder);
    const attestation: Attestation = {
      address,
      sessionPublicKeyRaw,
      issuedAt,
      expiresAt,
      walletSignature,
    };

    if (!verifyAttestation(attestation, this.now())) {
      this.reject({ reason: 'invalid-attestation', address });
      return;
    }

    const publicKey = await importSessionPublicKey(sessionPublicKeyRaw);
    if (this.destroyed) return;
    this.trustedPeer = { attestation, publicKey, lastSeq: -1 };
  }

  private async handleSyncFrame(decoder: decoding.Decoder): Promise<void> {
    const signablePayload = decoding.readVarUint8Array(decoder);
    const signature = decoding.readVarUint8Array(decoder);

    const peer = this.trustedPeer;
    if (!peer || !verifyAttestation(peer.attestation, this.now())) {
      this.reject({ reason: 'untrusted-sender' });
      return;
    }

    const validSignature = await verifyFrame(peer.publicKey, signablePayload, signature);
    if (!validSignature) {
      this.reject({ reason: 'bad-signature', address: peer.attestation.address });
      return;
    }
    if (this.destroyed) return;

    const payloadDecoder = decoding.createDecoder(signablePayload);
    const senderAddress = decoding.readVarString(payloadDecoder);
    const seq = decoding.readVarUint(payloadDecoder);
    const yjsBytes = decoding.readVarUint8Array(payloadDecoder);

    if (senderAddress !== peer.attestation.address) {
      this.reject({ reason: 'address-mismatch', address: senderAddress });
      return;
    }
    if (seq <= peer.lastSeq) {
      this.reject({ reason: 'replayed', address: senderAddress });
      return;
    }
    peer.lastSeq = seq;

    const replyEncoder = encoding.createEncoder();
    const yjsDecoder = decoding.createDecoder(yjsBytes);
    syncProtocol.readSyncMessage(yjsDecoder, replyEncoder, this.doc, this);

    if (encoding.length(replyEncoder) > 0) {
      void this.sendSyncBytes(encoding.toUint8Array(replyEncoder));
    }
  }
}
