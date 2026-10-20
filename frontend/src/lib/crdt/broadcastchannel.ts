import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';

/**
 * BroadcastChannelProvider synchronizes a Y.Doc across browser tabs of the
 * same origin using the native BroadcastChannel API.
 *
 * It implements the standard Yjs connection-provider contract (connect,
 * disconnect, destroy, doc, sync events) and speaks the Yjs sync protocol
 * (step 1 / step 2 / update) defined in `y-protocols/sync`. Document
 * updates are broadcast over the channel and any Yjs-aware peer — including
 * the IndexedDB persistence layer attached to the same doc — merges them
 * deterministically thanks to the CRDT properties of Yjs.
 */

const MESSAGE_SYNC = 0;

interface BroadcastChannelMessage {
  pub: number;
  msg: Uint8Array;
}

type ProviderListener = (...args: unknown[]) => void;

export class BroadcastChannelProvider {
  doc: Y.Doc;

  readonly roomname: string;

  private channel: BroadcastChannel | null = null;

  private connected = false;

  private sendState = { pub: 0 };

  private lastReceivedPub = 0;

  private listeners = new Map<string, Set<ProviderListener>>();

  constructor(roomname: string, doc: Y.Doc) {
    this.roomname = roomname;
    this.doc = doc;
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

  /**
   * Broadcast an encoded sync-protocol message to every other tab.
   */
  private broadcast(encoder: encoding.Encoder): void {
    if (!this.channel) return;
    this.sendState.pub++;
    const message: BroadcastChannelMessage = {
      pub: this.sendState.pub,
      msg: encoding.toUint8Array(encoder),
    };
    this.channel.postMessage(message);
  }

  /**
   * Send the current state vector (sync step 1) so peers can reply with the
   * missing differences (sync step 2).
   */
  sync(): void {
    if (!this.connected) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.broadcast(encoder);
  }

  private broadcastUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== this) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoder);
    }
  };

  private onMessage = (event: MessageEvent<BroadcastChannelMessage>): void => {
    const message = event.data;
    if (!message || !(message.msg instanceof Uint8Array)) return;
    if (message.pub === this.lastReceivedPub) return;
    this.lastReceivedPub = message.pub;

    const decoder = decoding.createDecoder(message.msg);
    const messageType = decoding.readVarUint(decoder);

    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      // `readSyncMessage` fills the encoder with a sync step 2 response only
      // when a peer requested a diff (step 1); broadcast it back if present.
      if (encoding.length(encoder) > 1) {
        this.broadcast(encoder);
      }
    }
  };

  connect(): void {
    if (this.connected || this.channel) return;
    this.channel = new BroadcastChannel(this.roomname);
    this.channel.onmessage = this.onMessage;
    this.doc.on('update', this.broadcastUpdate);
    this.connected = true;
    this.emit('status', { status: 'connected' });
    this.sync();
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.doc.off('update', this.broadcastUpdate);
    this.channel?.close();
    this.channel = null;
    this.emit('status', { status: 'disconnected' });
  }

  destroy(): void {
    this.disconnect();
    this.listeners.clear();
  }
}
