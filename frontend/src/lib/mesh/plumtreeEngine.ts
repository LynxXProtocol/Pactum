import type {
  GossipDataMessage,
  IHaveMessage,
  GraftMessage,
  PruneMessage,
  MeshProtocolMessage,
  SorobanIndexedEvent,
} from './types.ts';
import { PeerScoringManager } from './peerScoring.ts';

export interface PlumtreeConfig {
  localPeerId: string;
  targetEagerFanout?: number;
  minEagerFanout?: number;
  maxEagerFanout?: number;
  iHaveIntervalMs?: number;
  graftTimeoutMs?: number;
  messageCacheTtlMs?: number;
}

export type SendMessageHandler = (targetPeerId: string, message: MeshProtocolMessage) => void;
export type MessageDeliveryHandler = (event: SorobanIndexedEvent, senderPeerId: string) => void;

export class PlumtreeEngine {
  public localPeerId: string;
  private eagerNeighbors: Set<string> = new Set();
  private lazyNeighbors: Set<string> = new Set();
  private seenMessages: Map<string, number> = new Map(); // messageId -> timestamp
  private graftTimers: Map<string, { timer: any; peerId: string }> = new Map(); // messageId -> timer info
  private pendingIHave: Set<string> = new Set(); // messageIds awaiting lazy broadcast
  private iHaveInterval: any = null;

  public scoring: PeerScoringManager;
  private sendMessage: SendMessageHandler;
  private onDeliver: MessageDeliveryHandler;
  private config: Required<PlumtreeConfig>;

  // Metrics
  public messagesReceivedCount: number = 0;
  public messagesRelayedCount: number = 0;
  public duplicatesPrunedCount: number = 0;
  public byzantineDroppedCount: number = 0;

  constructor(
    config: PlumtreeConfig,
    scoring: PeerScoringManager,
    sendMessage: SendMessageHandler,
    onDeliver: MessageDeliveryHandler,
  ) {
    this.localPeerId = config.localPeerId;
    this.scoring = scoring;
    this.sendMessage = sendMessage;
    this.onDeliver = onDeliver;

    this.config = {
      localPeerId: config.localPeerId,
      targetEagerFanout: config.targetEagerFanout ?? 4,
      minEagerFanout: config.minEagerFanout ?? 3,
      maxEagerFanout: config.maxEagerFanout ?? 6,
      iHaveIntervalMs: config.iHaveIntervalMs ?? 300,
      graftTimeoutMs: config.graftTimeoutMs ?? 150,
      messageCacheTtlMs: config.messageCacheTtlMs ?? 5 * 60 * 1000,
    };

    this.startIHaveLoop();
  }

  /**
   * Registers a newly connected peer into the lazy overlay.
   */
  public addPeer(peerId: string): void {
    if (peerId === this.localPeerId) return;

    if (this.eagerNeighbors.has(peerId) || this.lazyNeighbors.has(peerId)) {
      return;
    }

    // If we have fewer eager peers than target and peer is eligible, add as eager
    if (
      this.eagerNeighbors.size < this.config.targetEagerFanout &&
      this.scoring.isPeerEligibleForEagerGossip(peerId)
    ) {
      this.eagerNeighbors.add(peerId);
    } else {
      this.lazyNeighbors.add(peerId);
    }
  }

  /**
   * Removes a disconnected peer from all overlays.
   */
  public removePeer(peerId: string): void {
    this.eagerNeighbors.delete(peerId);
    this.lazyNeighbors.delete(peerId);

    // Rebalance eager fanout if below threshold
    this.rebalanceOverlays();
  }

  /**
   * Publishes a new locally-indexed Soroban event to the gossip mesh.
   */
  public publishEvent(event: SorobanIndexedEvent): void {
    const messageId = event.id;
    this.seenMessages.set(messageId, Date.now());

    const message: GossipDataMessage = {
      type: 'GOSSIP_DATA',
      messageId,
      topic: event.topic,
      event,
      hopCount: 0,
      senderId: this.localPeerId,
      timestamp: Date.now(),
    };

    // Eager push to all eager neighbors
    for (const peerId of this.eagerNeighbors) {
      if (this.scoring.isPeerEligibleForEagerGossip(peerId)) {
        this.sendMessage(peerId, message);
        this.messagesRelayedCount++;
      }
    }

    // Queue for lazy push
    this.pendingIHave.add(messageId);
  }

  /**
   * Ingests and processes an incoming protocol message.
   */
  public handleMessage(senderPeerId: string, message: MeshProtocolMessage): void {
    if (this.scoring.isPeerBanned(senderPeerId)) {
      return;
    }

    switch (message.type) {
      case 'GOSSIP_DATA':
        this.handleGossipData(senderPeerId, message);
        break;
      case 'IHAVE':
        this.handleIHave(senderPeerId, message);
        break;
      case 'GRAFT':
        this.handleGraft(senderPeerId, message);
        break;
      case 'PRUNE':
        this.handlePrune(senderPeerId, message);
        break;
      default:
        break;
    }
  }

  private handleGossipData(senderPeerId: string, msg: GossipDataMessage): void {
    this.messagesReceivedCount++;

    // 1. Validate event structure & cryptographic integrity
    const validation = this.scoring.validateSorobanEvent(msg.event);
    if (!validation.isValid) {
      this.byzantineDroppedCount++;
      this.scoring.recordInvalidMessage(senderPeerId, validation.isByzantine);
      return;
    }

    const isDuplicate = this.seenMessages.has(msg.messageId);

    // Cancel any active graft timer for this message
    const graftEntry = this.graftTimers.get(msg.messageId);
    if (graftEntry) {
      clearTimeout(graftEntry.timer);
      this.graftTimers.delete(msg.messageId);
    }

    if (!isDuplicate) {
      // Novel message
      this.seenMessages.set(msg.messageId, Date.now());
      this.scoring.recordValidMessage(senderPeerId);

      // Ensure sender is on eager overlay
      if (this.lazyNeighbors.has(senderPeerId)) {
        this.lazyNeighbors.delete(senderPeerId);
        this.eagerNeighbors.add(senderPeerId);
      }

      // Deliver to local application/indexer
      this.onDeliver(msg.event, senderPeerId);

      // Forward eagerly to other eager peers
      const forwardMsg: GossipDataMessage = {
        ...msg,
        hopCount: msg.hopCount + 1,
        senderId: this.localPeerId,
      };

      for (const peerId of this.eagerNeighbors) {
        if (peerId !== senderPeerId && this.scoring.isPeerEligibleForEagerGossip(peerId)) {
          this.sendMessage(peerId, forwardMsg);
          this.messagesRelayedCount++;
        }
      }

      // Enqueue for lazy announcement
      this.pendingIHave.add(msg.messageId);
    } else {
      // Duplicate message received via eager link -> Prune sender to optimize spanning tree
      this.scoring.recordDuplicateMessage(senderPeerId);
      this.duplicatesPrunedCount++;

      if (this.eagerNeighbors.has(senderPeerId)) {
        this.eagerNeighbors.delete(senderPeerId);
        this.lazyNeighbors.add(senderPeerId);

        const pruneMsg: PruneMessage = {
          type: 'PRUNE',
          senderId: this.localPeerId,
          timestamp: Date.now(),
        };
        this.sendMessage(senderPeerId, pruneMsg);
      }
    }
  }

  private handleIHave(senderPeerId: string, msg: IHaveMessage): void {
    for (const msgId of msg.messageIds) {
      if (!this.seenMessages.has(msgId) && !this.graftTimers.has(msgId)) {
        // Start a graft timer: if message is not received via eager links within timeout, send GRAFT
        const timer = setTimeout(() => {
          this.graftTimers.delete(msgId);
          if (!this.seenMessages.has(msgId)) {
            this.sendGraft(senderPeerId, msgId);
          }
        }, this.config.graftTimeoutMs);

        this.graftTimers.set(msgId, { timer, peerId: senderPeerId });
      }
    }
  }

  private handleGraft(senderPeerId: string, _msg: GraftMessage): void {
    // Promote sender from lazy to eager overlay
    this.lazyNeighbors.delete(senderPeerId);
    this.eagerNeighbors.add(senderPeerId);

    // If a specific message was requested, we could resend if available in cache
  }

  private handlePrune(senderPeerId: string, _msg: PruneMessage): void {
    // Demote peer to lazy overlay
    if (this.eagerNeighbors.has(senderPeerId)) {
      this.eagerNeighbors.delete(senderPeerId);
      this.lazyNeighbors.add(senderPeerId);
    }
  }

  private sendGraft(peerId: string, messageId?: string): void {
    // Promote to eager
    this.lazyNeighbors.delete(peerId);
    this.eagerNeighbors.add(peerId);

    const graftMsg: GraftMessage = {
      type: 'GRAFT',
      messageId,
      senderId: this.localPeerId,
      timestamp: Date.now(),
    };
    this.sendMessage(peerId, graftMsg);
  }

  private rebalanceOverlays(): void {
    if (this.eagerNeighbors.size < this.config.minEagerFanout && this.lazyNeighbors.size > 0) {
      const candidates = Array.from(this.lazyNeighbors).filter((p) =>
        this.scoring.isPeerEligibleForEagerGossip(p),
      );

      if (candidates.length > 0) {
        const promoted = candidates[Math.floor(Math.random() * candidates.length)];
        this.sendGraft(promoted);
      }
    }
  }

  private startIHaveLoop(): void {
    this.iHaveInterval = setInterval(() => {
      if (this.pendingIHave.size > 0 && this.lazyNeighbors.size > 0) {
        const messageIds = Array.from(this.pendingIHave);
        this.pendingIHave.clear();

        const iHaveMsg: IHaveMessage = {
          type: 'IHAVE',
          messageIds,
          senderId: this.localPeerId,
          timestamp: Date.now(),
        };

        for (const peerId of this.lazyNeighbors) {
          if (!this.scoring.isPeerBanned(peerId)) {
            this.sendMessage(peerId, iHaveMsg);
          }
        }
      }

      this.pruneOldCache();
    }, this.config.iHaveIntervalMs);

    if (this.iHaveInterval && typeof (this.iHaveInterval as any).unref === 'function') {
      (this.iHaveInterval as any).unref();
    }
  }

  private pruneOldCache(): void {
    const now = Date.now();
    for (const [msgId, timestamp] of this.seenMessages.entries()) {
      if (now - timestamp > this.config.messageCacheTtlMs) {
        this.seenMessages.delete(msgId);
      }
    }
  }

  public destroy(): void {
    if (this.iHaveInterval) {
      clearInterval(this.iHaveInterval);
      this.iHaveInterval = null;
    }
    for (const { timer } of this.graftTimers.values()) {
      clearTimeout(timer);
    }
    this.graftTimers.clear();
  }

  public getEagerNeighbors(): string[] {
    return Array.from(this.eagerNeighbors);
  }

  public getLazyNeighbors(): string[] {
    return Array.from(this.lazyNeighbors);
  }
}
