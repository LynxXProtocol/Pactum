import { describe, it, expect } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import { PlumtreeEngine } from '../plumtreeEngine.ts';
import { PeerScoringManager } from '../peerScoring.ts';
import type { MeshProtocolMessage, SorobanIndexedEvent, GossipDataMessage } from '../types.ts';

describe('PlumtreeEngine', () => {
  function createEngine(localPeerId: string) {
    const sentMessages: { targetPeerId: string; message: MeshProtocolMessage }[] = [];
    const deliveredEvents: { event: SorobanIndexedEvent; senderId: string }[] = [];

    const scoring = new PeerScoringManager();
    const engine = new PlumtreeEngine(
      { localPeerId, targetEagerFanout: 2, minEagerFanout: 1, maxEagerFanout: 4 },
      scoring,
      (targetPeerId, message) => sentMessages.push({ targetPeerId, message }),
      (event, senderId) => deliveredEvents.push({ event, senderId }),
    );

    return { engine, scoring, sentMessages, deliveredEvents };
  }

  function createMockEvent(id: string = 'msg-1'): SorobanIndexedEvent {
    return {
      id,
      contractId: 'CA3D...PACTUM',
      topic: 'contract_invoked',
      xdrPayload: xdr.ScVal.scvSymbol('invoked').toXDR('base64'),
      ledgerSeq: 104520,
      txHash: '0xdeadbeef',
      timestamp: Date.now(),
      originPeerId: 'peer-alice',
    };
  }

  it('adds peers to eager and lazy overlays according to target fanout', () => {
    const { engine } = createEngine('node-a');

    engine.addPeer('node-b');
    engine.addPeer('node-c');
    engine.addPeer('node-d'); // exceeds targetEagerFanout of 2 -> added to lazy

    expect(engine.getEagerNeighbors()).toEqual(['node-b', 'node-c']);
    expect(engine.getLazyNeighbors()).toEqual(['node-d']);

    engine.destroy();
  });

  it('eagerly propagates novel messages to eager neighbors and delivers locally', () => {
    const { engine, sentMessages, deliveredEvents } = createEngine('node-a');
    engine.addPeer('node-b');
    engine.addPeer('node-c');

    const event = createMockEvent('msg-unique-1');
    const msg: GossipDataMessage = {
      type: 'GOSSIP_DATA',
      messageId: event.id,
      topic: event.topic,
      event,
      hopCount: 0,
      senderId: 'node-b',
      timestamp: Date.now(),
    };

    engine.handleMessage('node-b', msg);

    expect(deliveredEvents.length).toBe(1);
    expect(deliveredEvents[0].event.id).toBe('msg-unique-1');

    // Should forward to node-c (other eager peer)
    const forwarded = sentMessages.filter((s) => s.targetPeerId === 'node-c');
    expect(forwarded.length).toBe(1);
    expect(forwarded[0].message.type).toBe('GOSSIP_DATA');

    engine.destroy();
  });

  it('prunes eager peer upon receiving duplicate message', () => {
    const { engine, sentMessages } = createEngine('node-a');
    engine.addPeer('node-b');

    const event = createMockEvent('msg-dup-1');
    const msg: GossipDataMessage = {
      type: 'GOSSIP_DATA',
      messageId: event.id,
      topic: event.topic,
      event,
      hopCount: 0,
      senderId: 'node-b',
      timestamp: Date.now(),
    };

    // First arrival (novel)
    engine.handleMessage('node-b', msg);

    // Second arrival (duplicate)
    engine.handleMessage('node-b', msg);

    expect(engine.duplicatesPrunedCount).toBe(1);
    const pruneMsgs = sentMessages.filter(
      (s) => s.targetPeerId === 'node-b' && s.message.type === 'PRUNE',
    );
    expect(pruneMsgs.length).toBe(1);
    expect(engine.getLazyNeighbors().includes('node-b')).toBe(true);

    engine.destroy();
  });

  it('drops Byzantine messages and increments dropped metric', () => {
    const { engine, deliveredEvents } = createEngine('node-a');
    engine.addPeer('node-b');

    const byzantineEvent: SorobanIndexedEvent = {
      id: 'bad-msg',
      contractId: 'CA3D',
      topic: 'test',
      xdrPayload: 'not-base64!',
      ledgerSeq: -500,
      txHash: '0x123',
      timestamp: Date.now(),
      originPeerId: 'node-b',
    };

    const msg: GossipDataMessage = {
      type: 'GOSSIP_DATA',
      messageId: byzantineEvent.id,
      topic: byzantineEvent.topic,
      event: byzantineEvent,
      hopCount: 0,
      senderId: 'node-b',
      timestamp: Date.now(),
    };

    engine.handleMessage('node-b', msg);

    expect(deliveredEvents.length).toBe(0);
    expect(engine.byzantineDroppedCount).toBe(1);

    engine.destroy();
  });
});
