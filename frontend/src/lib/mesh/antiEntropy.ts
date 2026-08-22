import type {
  SorobanIndexedEvent,
  AntiEntropyReqMessage,
  AntiEntropyRespMessage,
} from './types.ts';
import { WebRtcMeshTransport } from './webrtcTransport.ts';

export interface AntiEntropyConfig {
  syncIntervalMs?: number;
  maxEventsPerSync?: number;
}

export class AntiEntropyManager {
  private transport: WebRtcMeshTransport;
  private localEvents: Map<string, SorobanIndexedEvent> = new Map();
  private ledgerSeqIndex: Map<number, SorobanIndexedEvent[]> = new Map();
  private syncInterval: any = null;
  private maxEventsPerSync: number;

  constructor(transport: WebRtcMeshTransport, config: AntiEntropyConfig = {}) {
    this.transport = transport;
    this.maxEventsPerSync = config.maxEventsPerSync ?? 100;
    this.startPeriodicSync(config.syncIntervalMs ?? 45000);
  }

  /**
   * Ingests a new local event into the indexed storage.
   */
  public recordEvent(event: SorobanIndexedEvent): void {
    this.localEvents.set(event.id, event);

    const existing = this.ledgerSeqIndex.get(event.ledgerSeq) || [];
    existing.push(event);
    this.ledgerSeqIndex.set(event.ledgerSeq, existing);
  }

  /**
   * Responds to an incoming anti-entropy request.
   */
  public handleSyncRequest(req: AntiEntropyReqMessage): AntiEntropyRespMessage {
    const matchedEvents: SorobanIndexedEvent[] = [];
    const from = Number(req.fromLedger);
    const to = Number(req.toLedger);

    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
      return {
        type: 'ANTI_ENTROPY_RESP',
        events: [],
        senderId: this.transport.localPeerId,
        timestamp: Date.now(),
      };
    }

    const sequences = Array.from(this.ledgerSeqIndex.keys())
      .filter((seq) => seq >= from && seq <= to)
      .sort((a, b) => a - b);

    for (const seq of sequences) {
      const events = this.ledgerSeqIndex.get(seq) ?? [];
      for (const event of events) {
        if (matchedEvents.length >= this.maxEventsPerSync) {
          return {
            type: 'ANTI_ENTROPY_RESP',
            events: matchedEvents,
            senderId: this.transport.localPeerId,
            timestamp: Date.now(),
          };
        }
        matchedEvents.push(event);
      }
    }

    return {
      type: 'ANTI_ENTROPY_RESP',
      events: matchedEvents,
      senderId: this.transport.localPeerId,
      timestamp: Date.now(),
    };
  }

  /**
   * Initiates anti-entropy reconciliation with a random active peer.
   */
  public triggerSyncWithPeer(peerId: string, fromLedger: number, toLedger: number): void {
    const req: AntiEntropyReqMessage = {
      type: 'ANTI_ENTROPY_REQ',
      fromLedger,
      toLedger,
      senderId: this.transport.localPeerId,
      timestamp: Date.now(),
    };

    this.transport.sendToPeer(peerId, req);
  }

  private startPeriodicSync(intervalMs: number): void {
    this.syncInterval = setInterval(() => {
      const activePeers = this.transport.getActivePeers();
      if (activePeers.length === 0) return;

      const randomPeer = activePeers[Math.floor(Math.random() * activePeers.length)];
      const sequences = Array.from(this.ledgerSeqIndex.keys());
      const maxSeq = sequences.length > 0 ? Math.max(...sequences) : 1;
      const minSeq = Math.max(1, maxSeq - 20);

      this.triggerSyncWithPeer(randomPeer, minSeq, maxSeq);
    }, intervalMs);

    if (this.syncInterval && typeof (this.syncInterval as any).unref === 'function') {
      (this.syncInterval as any).unref();
    }
  }

  public destroy(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }
}
