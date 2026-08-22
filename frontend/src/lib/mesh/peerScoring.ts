import type { PeerReputation, SorobanIndexedEvent } from './types.ts';
import { xdr } from '@stellar/stellar-sdk';

export interface PeerScoringConfig {
  initialScore?: number;
  validMessageReward?: number;
  duplicateMessagePenalty?: number;
  invalidMessagePenalty?: number;
  byzantineAttackPenalty?: number;
  quarantineThreshold?: number;
  banThreshold?: number;
  banDurationMs?: number;
  decayIntervalMs?: number;
  decayFactor?: number;
}

export class PeerScoringManager {
  private reputations: Map<string, PeerReputation> = new Map();
  private config: Required<PeerScoringConfig>;

  constructor(config?: PeerScoringConfig) {
    this.config = {
      initialScore: config?.initialScore ?? 0,
      validMessageReward: config?.validMessageReward ?? 5,
      duplicateMessagePenalty: config?.duplicateMessagePenalty ?? 2,
      invalidMessagePenalty: config?.invalidMessagePenalty ?? 40,
      byzantineAttackPenalty: config?.byzantineAttackPenalty ?? 80,
      quarantineThreshold: config?.quarantineThreshold ?? -25,
      banThreshold: config?.banThreshold ?? -50,
      banDurationMs: config?.banDurationMs ?? 5 * 60 * 1000, // 5 min ban
      decayIntervalMs: config?.decayIntervalMs ?? 60 * 1000, // 1 min decay
      decayFactor: config?.decayFactor ?? 0.95, // 5% decay towards 0
    };
  }

  /**
   * Retrieves or initializes reputation record for a peer.
   */
  public getReputation(peerId: string): PeerReputation {
    const existing = this.reputations.get(peerId);
    const now = Date.now();

    if (!existing) {
      const rep: PeerReputation = {
        peerId,
        score: this.config.initialScore,
        validMessagesDelivered: 0,
        duplicateMessages: 0,
        invalidMessages: 0,
        lastActive: now,
        isQuarantined: false,
        isBanned: false,
      };
      this.reputations.set(peerId, rep);
      return rep;
    }

    // Check if ban has expired
    if (existing.isBanned && existing.banExpiry && now >= existing.banExpiry) {
      existing.isBanned = false;
      existing.isQuarantined = false;
      existing.score = this.config.quarantineThreshold + 5;
      delete existing.banExpiry;
    }

    return existing;
  }

  /**
   * Records a valid, novel message delivery from a peer.
   */
  public recordValidMessage(peerId: string): void {
    const rep = this.getReputation(peerId);
    rep.validMessagesDelivered += 1;
    rep.lastActive = Date.now();
    this.adjustScore(rep, this.config.validMessageReward);
  }

  /**
   * Records a duplicate message delivery (subtle penalty, prompts PRUNE).
   */
  public recordDuplicateMessage(peerId: string): void {
    const rep = this.getReputation(peerId);
    rep.duplicateMessages += 1;
    rep.lastActive = Date.now();
    this.adjustScore(rep, -this.config.duplicateMessagePenalty);
  }

  /**
   * Records an invalid / malformed message from a peer.
   */
  public recordInvalidMessage(peerId: string, isByzantineAttack: boolean = false): void {
    const rep = this.getReputation(peerId);
    rep.invalidMessages += 1;
    rep.lastActive = Date.now();
    const penalty = isByzantineAttack
      ? this.config.byzantineAttackPenalty
      : this.config.invalidMessagePenalty;
    this.adjustScore(rep, -penalty);
  }

  /**
   * Validates a Soroban indexed event against Byzantine faults.
   */
  public validateSorobanEvent(event: SorobanIndexedEvent): {
    isValid: boolean;
    isByzantine: boolean;
    reason?: string;
  } {
    if (!event.id || !event.contractId || !event.topic || !event.xdrPayload) {
      return { isValid: false, isByzantine: false, reason: 'Missing mandatory event fields' };
    }

    if (typeof event.ledgerSeq !== 'number' || event.ledgerSeq <= 0) {
      return {
        isValid: false,
        isByzantine: true,
        reason: 'Invalid or non-positive ledger sequence',
      };
    }

    // Verify timestamp within reasonable clock skew (e.g. 10 minutes)
    const now = Date.now();
    const skew = Math.abs(now - event.timestamp);
    if (skew > 10 * 60 * 1000) {
      return {
        isValid: false,
        isByzantine: true,
        reason: 'Event timestamp skewed beyond acceptable boundary',
      };
    }

    // Verify valid Soroban XDR structure (either ScVal or ContractEvent)
    try {
      xdr.ScVal.fromXDR(event.xdrPayload, 'base64');
    } catch {
      try {
        xdr.ContractEvent.fromXDR(event.xdrPayload, 'base64');
      } catch {
        return {
          isValid: false,
          isByzantine: true,
          reason: 'Malformed or invalid Soroban XDR structure',
        };
      }
    }

    return { isValid: true, isByzantine: false };
  }

  /**
   * Decays all peer scores periodically towards 0 to allow recovery.
   */
  public decayScores(): void {
    for (const rep of this.reputations.values()) {
      if (!rep.isBanned) {
        rep.score = Math.round(rep.score * this.config.decayFactor * 100) / 100;
        this.updateFlags(rep);
      }
    }
  }

  /**
   * Returns whether a peer is allowed to participate in eager gossip.
   */
  public isPeerEligibleForEagerGossip(peerId: string): boolean {
    const rep = this.getReputation(peerId);
    return !rep.isBanned && !rep.isQuarantined;
  }

  /**
   * Returns whether a connection should be actively terminated due to ban.
   */
  public isPeerBanned(peerId: string): boolean {
    const rep = this.getReputation(peerId);
    return rep.isBanned;
  }

  private adjustScore(rep: PeerReputation, delta: number): void {
    rep.score = Math.max(-100, Math.min(100, rep.score + delta));
    this.updateFlags(rep);
  }

  private updateFlags(rep: PeerReputation): void {
    if (rep.score <= this.config.banThreshold) {
      rep.isBanned = true;
      rep.isQuarantined = true;
      rep.banExpiry = Date.now() + this.config.banDurationMs;
    } else if (rep.score <= this.config.quarantineThreshold) {
      rep.isQuarantined = true;
      rep.isBanned = false;
    } else {
      rep.isQuarantined = false;
      rep.isBanned = false;
    }
  }
}
