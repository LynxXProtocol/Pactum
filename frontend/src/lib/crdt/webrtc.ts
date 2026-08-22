import * as Y from 'yjs';

import {
  type Attestation,
  type SessionIdentity,
  type WalletSigner,
  attestSessionKey,
  createSessionIdentity,
} from './signing';
import { SignedPeerSession, type PeerLink, type RejectionInfo } from './syncSession';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const DATA_CHANNEL_LABEL = 'pactum-sync';

export interface SignalingMessage {
  from: string;
  to?: string;
  type: 'announce' | 'offer' | 'answer' | 'ice' | 'bye';
  payload?: unknown;
}

/** The rendezvous point peers use to exchange SDP/ICE before a direct WebRTC link exists. */
export interface SignalingChannel {
  send(message: SignalingMessage): void;
  onMessage(handler: (message: SignalingMessage) => void): () => void;
  close(): void;
}

/**
 * Same-origin signaling via the native BroadcastChannel API — zero backend
 * dependency, so peer discovery keeps working even when the Soroban RPC or
 * indexer is unreachable. It only reaches peers on the same browser/origin
 * (other tabs, or a shared profile), which is enough for local dev and
 * demos. To discover peers across machines, implement `SignalingChannel`
 * over a WebSocket relay — same three methods, no other code changes.
 * ponytail: same-origin ceiling; swap in a WS SignalingChannel when peers need to span machines.
 */
export class BroadcastChannelSignaling implements SignalingChannel {
  private readonly channel: BroadcastChannel;

  constructor(room: string) {
    this.channel = new BroadcastChannel(`pactum-webrtc-signal-${room}`);
  }

  send(message: SignalingMessage): void {
    this.channel.postMessage(message);
  }

  onMessage(handler: (message: SignalingMessage) => void): () => void {
    const listener = (event: MessageEvent<SignalingMessage>) => handler(event.data);
    this.channel.addEventListener('message', listener);
    return () => this.channel.removeEventListener('message', listener);
  }

  close(): void {
    this.channel.close();
  }
}

export interface WebRTCProviderOptions {
  signaling?: SignalingChannel;
  attestationTtlMs?: number;
  signer?: WalletSigner;
  iceServers?: RTCIceServer[];
  now?: () => number;
}

type ProviderListener = (...args: unknown[]) => void;

interface PeerConnectionEntry {
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  session: SignedPeerSession | null;
}

function channelToPeerLink(channel: RTCDataChannel): PeerLink {
  const messageHandlers = new Set<(bytes: Uint8Array) => void>();
  const closeHandlers = new Set<() => void>();
  channel.binaryType = 'arraybuffer';

  channel.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(event.data);
      for (const handler of messageHandlers) handler(bytes);
    }
  });
  channel.addEventListener('close', () => {
    for (const handler of closeHandlers) handler();
  });

  return {
    send(bytes) {
      // Same runtime shape as RTCDataChannel.send's ArrayBufferView<ArrayBuffer> overload
      // expects — this is a TS lib.dom.d.ts type-parameter mismatch, not a real incompatibility.
      if (channel.readyState === 'open') channel.send(bytes as ArrayBufferView<ArrayBuffer>);
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
  };
}

/**
 * WebRTC mesh provider for the CRDT store: one `RTCPeerConnection` + ordered
 * `RTCDataChannel` per discovered peer, each wrapped in a `SignedPeerSession`
 * so every delta is authenticated and replay-checked before it reaches the
 * Y.Doc. Implements the same connect/disconnect/destroy/on/off contract as
 * `BroadcastChannelProvider` so it plugs into `SyncStore` the same way.
 *
 * Reconnection is automatic and needs no special-case recovery logic: a
 * torn-down peer connection is simply removed, and the next `announce` from
 * that peer (or from us) starts a fresh `RTCPeerConnection` whose
 * `SignedPeerSession` runs sync-step-1 again — Yjs's CRDT merge reconciles
 * whatever each side did while partitioned.
 */
export class WebRTCProvider {
  readonly doc: Y.Doc;

  private readonly address: string;
  private readonly roomname: string;
  private readonly peerId = crypto.randomUUID();
  private readonly options: WebRTCProviderOptions;
  private readonly connections = new Map<string, PeerConnectionEntry>();
  private readonly listeners = new Map<string, Set<ProviderListener>>();

  private signaling: SignalingChannel | null = null;
  private identity: SessionIdentity | null = null;
  private attestation: Attestation | null = null;
  private connected = false;
  private unsubscribeSignaling: (() => void) | null = null;

  constructor(roomname: string, doc: Y.Doc, address: string, options: WebRTCProviderOptions = {}) {
    this.roomname = roomname;
    this.doc = doc;
    this.address = address;
    this.options = options;
  }

  on(event: string, listener: ProviderListener): void {
    const set = this.listeners.get(event) ?? new Set<ProviderListener>();
    set.add(listener);
    this.listeners.set(event, set);
  }

  off(event: string, listener: ProviderListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }

  get peerCount(): number {
    return this.connections.size;
  }

  /** One wallet popup to attest this tab's session key, then joins the signaling room. */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;

    this.identity = await createSessionIdentity(this.address);
    this.attestation = await attestSessionKey(
      this.identity,
      this.options.attestationTtlMs ?? 10 * 60_000,
      this.options.signer,
    );

    this.signaling = this.options.signaling ?? new BroadcastChannelSignaling(this.roomname);
    this.unsubscribeSignaling = this.signaling.onMessage(this.onSignal);
    this.signaling.send({ from: this.peerId, type: 'announce' });
    this.emit('status', { status: 'connected' });
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;

    this.signaling?.send({ from: this.peerId, type: 'bye' });
    for (const entry of this.connections.values()) this.teardownPeer(entry);
    this.connections.clear();

    this.unsubscribeSignaling?.();
    this.unsubscribeSignaling = null;
    this.signaling?.close();
    this.signaling = null;

    this.emit('status', { status: 'disconnected' });
  }

  destroy(): void {
    this.disconnect();
    this.listeners.clear();
  }

  private onSignal = (message: SignalingMessage): void => {
    if (!this.connected || message.from === this.peerId) return;
    if (message.to && message.to !== this.peerId) return;

    switch (message.type) {
      case 'announce':
        this.handleAnnounce(message.from);
        break;
      case 'offer':
        void this.handleOffer(message.from, message.payload as RTCSessionDescriptionInit);
        break;
      case 'answer':
        void this.handleAnswer(message.from, message.payload as RTCSessionDescriptionInit);
        break;
      case 'ice':
        void this.handleIce(message.from, message.payload as RTCIceCandidateInit);
        break;
      case 'bye':
        this.handlePeerGone(message.from);
        break;
    }
  };

  private handleAnnounce(peerId: string): void {
    if (this.connections.has(peerId)) return;
    // Let a newly-joined peer learn about us too, without waiting for its own broadcast to loop back.
    this.signaling?.send({ from: this.peerId, to: peerId, type: 'announce' });
    // Glare-free initiator selection: the lexicographically smaller peer id always offers,
    // so both sides never race to send an offer at the same time.
    if (this.peerId < peerId) {
      void this.initiateOffer(peerId);
    } else {
      this.ensurePeerConnection(peerId);
    }
  }

  private async initiateOffer(peerId: string): Promise<void> {
    const pc = this.ensurePeerConnection(peerId);
    const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    this.wireDataChannel(peerId, channel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling?.send({ from: this.peerId, to: peerId, type: 'offer', payload: offer });
  }

  private async handleOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.ensurePeerConnection(peerId);
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.signaling?.send({ from: this.peerId, to: peerId, type: 'answer', payload: answer });
  }

  private async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const entry = this.connections.get(peerId);
    if (!entry) return;
    await entry.pc.setRemoteDescription(answer);
  }

  private async handleIce(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const entry = this.connections.get(peerId);
    if (!entry) return;
    try {
      await entry.pc.addIceCandidate(candidate);
    } catch {
      // Candidate arrived for a connection that already tore down; safe to drop.
    }
  }

  private ensurePeerConnection(peerId: string): RTCPeerConnection {
    const existing = this.connections.get(peerId);
    if (existing) return existing.pc;

    const pc = new RTCPeerConnection({
      iceServers: this.options.iceServers ?? DEFAULT_ICE_SERVERS,
    });
    const entry: PeerConnectionEntry = { pc, channel: null, session: null };
    this.connections.set(peerId, entry);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling?.send({
          from: this.peerId,
          to: peerId,
          type: 'ice',
          payload: event.candidate.toJSON(),
        });
      }
    };
    pc.ondatachannel = (event) => this.wireDataChannel(peerId, event.channel);
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this.handlePeerGone(peerId);
      }
    };

    return pc;
  }

  private wireDataChannel(peerId: string, channel: RTCDataChannel): void {
    const entry = this.connections.get(peerId);
    if (!entry) return;
    entry.channel = channel;

    channel.addEventListener('open', () => {
      if (!this.identity || !this.attestation) return;
      const session = new SignedPeerSession(
        this.doc,
        this.identity,
        this.attestation,
        channelToPeerLink(channel),
        {
          now: this.options.now,
        },
      );
      session.onRejected((info: RejectionInfo) => this.emit('peer-rejected', { peerId, ...info }));
      entry.session = session;
      this.emit('peer-connected', { peerId });
    });
  }

  private handlePeerGone(peerId: string): void {
    const entry = this.connections.get(peerId);
    if (!entry) return;
    this.teardownPeer(entry);
    this.connections.delete(peerId);
    this.emit('peer-disconnected', { peerId });
  }

  private teardownPeer(entry: PeerConnectionEntry): void {
    entry.session?.destroy();
    entry.channel?.close();
    entry.pc.close();
  }
}
