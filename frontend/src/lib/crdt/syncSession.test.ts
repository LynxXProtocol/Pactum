import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Keypair } from '@stellar/stellar-sdk';

import {
  attestSessionKey,
  createSessionIdentity,
  type Attestation,
  type SessionIdentity,
  type WalletSigner,
} from './signing';
import { SignedPeerSession, type PeerLink, type RejectionInfo } from './syncSession';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const HANDSHAKE_MS = 150;

function localSigner(keypair: Keypair): WalletSigner {
  return async (payload, address) => ({
    signatureBytes: keypair.signMessage(payload),
    signerAddress: address,
  });
}

interface Peer {
  address: string;
  identity: SessionIdentity;
  attestation: Attestation;
}

async function makePeer(ttlMs = 10 * 60_000): Promise<Peer> {
  const keypair = Keypair.random();
  const address = keypair.publicKey();
  const identity = await createSessionIdentity(address);
  const attestation = await attestSessionKey(identity, ttlMs, localSigner(keypair));
  return { address, identity, attestation };
}

/** In-memory network simulating a direct duplex link between two peers, with hooks to
 *  capture and manually redeliver frames (for replay/forgery tests). */
function createLinkPair() {
  const handlersA = new Set<(bytes: Uint8Array) => void>();
  const handlersB = new Set<(bytes: Uint8Array) => void>();
  const capturedAtoB: Uint8Array[] = [];

  // Real transports (WebRTC data channels, BroadcastChannel) never deliver
  // synchronously within the caller's own tick — always dispatch async here too,
  // otherwise "sender constructed before receiver subscribes" silently drops frames
  // in a way that could never happen against a real PeerLink.
  const linkA: PeerLink = {
    send: (bytes) => {
      capturedAtoB.push(bytes);
      queueMicrotask(() => handlersB.forEach((h) => h(bytes)));
    },
    onMessage: (h) => {
      handlersA.add(h);
      return () => handlersA.delete(h);
    },
    onClose: () => () => {},
  };
  const linkB: PeerLink = {
    send: (bytes) => queueMicrotask(() => handlersA.forEach((h) => h(bytes))),
    onMessage: (h) => {
      handlersB.add(h);
      return () => handlersB.delete(h);
    },
    onClose: () => () => {},
  };

  return {
    linkA,
    linkB,
    capturedAtoB,
    deliverToB: (bytes: Uint8Array) => queueMicrotask(() => handlersB.forEach((h) => h(bytes))),
  };
}

function itemsOf(doc: Y.Doc): Record<string, unknown> {
  return doc.getMap('items').toJSON();
}

function stateVectorsEqual(a: Y.Doc, b: Y.Doc): boolean {
  return (
    Array.from(Y.encodeStateVector(a)).join(',') === Array.from(Y.encodeStateVector(b)).join(',')
  );
}

describe('SignedPeerSession — multi-peer CRDT sync over an authenticated channel', () => {
  it('converges two peers that each had independent pre-connect edits', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.getMap('items').set('a', 1);
    docB.getMap('items').set('b', 2);

    const [peerA, peerB] = await Promise.all([makePeer(), makePeer()]);
    const { linkA, linkB } = createLinkPair();
    const sessionA = new SignedPeerSession(docA, peerA.identity, peerA.attestation, linkA);
    const sessionB = new SignedPeerSession(docB, peerB.identity, peerB.attestation, linkB);

    await wait(HANDSHAKE_MS);

    expect(itemsOf(docA)).toEqual({ a: 1, b: 2 });
    expect(itemsOf(docB)).toEqual({ a: 1, b: 2 });
    expect(stateVectorsEqual(docA, docB)).toBe(true);

    sessionA.destroy();
    sessionB.destroy();
  });

  it('reconciles concurrent edits to the same key after a partition, deterministically and without corruption', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const [peerA, peerB] = await Promise.all([makePeer(), makePeer()]);

    let { linkA, linkB } = createLinkPair();
    let sessionA = new SignedPeerSession(docA, peerA.identity, peerA.attestation, linkA);
    let sessionB = new SignedPeerSession(docB, peerB.identity, peerB.attestation, linkB);
    await wait(HANDSHAKE_MS);

    docA.getMap('items').set('shared', 'initial');
    await wait(HANDSHAKE_MS);
    expect(itemsOf(docB).shared).toBe('initial');

    // Partition: the underlying connection drops (mirrors an RTCPeerConnection
    // failure in webrtc.ts), tearing down both sessions.
    sessionA.destroy();
    sessionB.destroy();

    // Both sides mutate the SAME key, plus a key of their own, while split.
    docA.getMap('items').set('shared', 'from-a');
    docA.getMap('items').set('onlyA', 'x');
    docB.getMap('items').set('shared', 'from-b');
    docB.getMap('items').set('onlyB', 'y');

    // Reconnect: fresh link + fresh sessions, exactly as WebRTCProvider does on renegotiation.
    ({ linkA, linkB } = createLinkPair());
    sessionA = new SignedPeerSession(docA, peerA.identity, peerA.attestation, linkA);
    sessionB = new SignedPeerSession(docB, peerB.identity, peerB.attestation, linkB);
    await wait(HANDSHAKE_MS);

    const a = itemsOf(docA);
    const b = itemsOf(docB);
    expect(a).toEqual(b); // both sides picked the same winner — no split state, no corruption
    expect(['from-a', 'from-b']).toContain(a.shared);
    expect(a).toMatchObject({ onlyA: 'x', onlyB: 'y' });
    expect(stateVectorsEqual(docA, docB)).toBe(true);

    sessionA.destroy();
    sessionB.destroy();
  });

  it('converges three peers after a split-brain partition (A+B on one side, C isolated)', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const docC = new Y.Doc();
    const [peerA, peerB, peerC] = await Promise.all([makePeer(), makePeer(), makePeer()]);

    const ab = createLinkPair();
    const sessAB_A = new SignedPeerSession(docA, peerA.identity, peerA.attestation, ab.linkA);
    const sessAB_B = new SignedPeerSession(docB, peerB.identity, peerB.attestation, ab.linkB);
    await wait(HANDSHAKE_MS);

    // Split-brain: {A, B} stay connected to each other; C is isolated. Both sides
    // write the same key plus a key of their own.
    docA.getMap('items').set('k', 'ab-side');
    docB.getMap('items').set('onlyAB', true);
    docC.getMap('items').set('k', 'c-side');
    docC.getMap('items').set('onlyC', true);
    await wait(HANDSHAKE_MS);

    // Heal: connect C to A. Because every session relays any doc update it
    // didn't originate, B converges too via A — without a direct B-C link.
    const ac = createLinkPair();
    const sessAC_A = new SignedPeerSession(docA, peerA.identity, peerA.attestation, ac.linkA);
    const sessAC_C = new SignedPeerSession(docC, peerC.identity, peerC.attestation, ac.linkB);
    await wait(HANDSHAKE_MS);

    const a = itemsOf(docA);
    const b = itemsOf(docB);
    const c = itemsOf(docC);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).toMatchObject({ onlyAB: true, onlyC: true });
    expect(stateVectorsEqual(docA, docB)).toBe(true);
    expect(stateVectorsEqual(docB, docC)).toBe(true);

    [sessAB_A, sessAB_B, sessAC_A, sessAC_C].forEach((s) => s.destroy());
  });

  it('drops a sync frame whose signature was tampered with, without corrupting the doc', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const [peerA, peerB] = await Promise.all([makePeer(), makePeer()]);
    const { linkA, linkB, deliverToB } = createLinkPair();
    const rejections: RejectionInfo[] = [];

    const sessionA = new SignedPeerSession(docA, peerA.identity, peerA.attestation, linkA);
    const sessionB = new SignedPeerSession(docB, peerB.identity, peerB.attestation, linkB);
    sessionB.onRejected((info) => rejections.push(info));
    await wait(HANDSHAKE_MS); // let the attestation handshake complete so B trusts A

    // Intercept the next legitimate frame and flip the tail byte — part of the signature.
    const originalSend = linkA.send;
    let tampered = false;
    linkA.send = (bytes) => {
      if (!tampered) {
        tampered = true;
        const corrupted = new Uint8Array(bytes);
        corrupted[corrupted.length - 1] ^= 0xff;
        deliverToB(corrupted);
        return;
      }
      originalSend(bytes);
    };

    docA.getMap('items').set('x', 'should-be-rejected');
    await wait(HANDSHAKE_MS);

    expect(itemsOf(docB)).toEqual({});
    expect(rejections.some((r) => r.reason === 'bad-signature')).toBe(true);

    sessionA.destroy();
    sessionB.destroy();
  });

  it('drops a sync frame from a peer whose attestation never arrived', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const attacker = await makePeer();
    const peerB = await makePeer();
    const { linkA, linkB } = createLinkPair();
    const rejections: RejectionInfo[] = [];

    // Drop only the ATTEST frame (kind byte 0) in one direction: the attacker's
    // signed sync frames still arrive, but B never learns to trust their key —
    // e.g. an attacker who joins a data channel without ever presenting a
    // wallet-backed attestation.
    const originalSend = linkA.send;
    linkA.send = (bytes) => {
      if (bytes[0] === 0) return;
      originalSend(bytes);
    };

    const sessionA = new SignedPeerSession(docA, attacker.identity, attacker.attestation, linkA);
    const sessionB = new SignedPeerSession(docB, peerB.identity, peerB.attestation, linkB);
    sessionB.onRejected((info) => rejections.push(info));
    await wait(HANDSHAKE_MS);

    docA.getMap('items').set('x', 'should-be-rejected');
    await wait(HANDSHAKE_MS);

    expect(itemsOf(docB)).toEqual({});
    expect(rejections.some((r) => r.reason === 'untrusted-sender')).toBe(true);

    sessionA.destroy();
    sessionB.destroy();
  });

  it('ignores a malformed/garbage frame instead of throwing or corrupting the doc', async () => {
    const docB = new Y.Doc();
    const peerB = await makePeer();
    const { linkB, deliverToB } = createLinkPair();
    const rejections: RejectionInfo[] = [];

    const sessionB = new SignedPeerSession(docB, peerB.identity, peerB.attestation, linkB);
    sessionB.onRejected((info) => rejections.push(info));
    await wait(HANDSHAKE_MS);

    deliverToB(new Uint8Array([1, 255, 255, 255, 255, 255, 255, 255]));
    await wait(30);

    expect(itemsOf(docB)).toEqual({});
    expect(rejections.some((r) => r.reason === 'malformed')).toBe(true);

    sessionB.destroy();
  });

  it('drops a replayed sync frame', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const [peerA, peerB] = await Promise.all([makePeer(), makePeer()]);
    const { linkA, linkB, capturedAtoB, deliverToB } = createLinkPair();
    const rejections: RejectionInfo[] = [];

    const sessionA = new SignedPeerSession(docA, peerA.identity, peerA.attestation, linkA);
    const sessionB = new SignedPeerSession(docB, peerB.identity, peerB.attestation, linkB);
    sessionB.onRejected((info) => rejections.push(info));
    await wait(HANDSHAKE_MS);

    docA.getMap('items').set('k1', 'v1');
    await wait(HANDSHAKE_MS);
    expect(itemsOf(docB).k1).toBe('v1');

    const capturedFrame = capturedAtoB[capturedAtoB.length - 1];

    docA.getMap('items').set('k2', 'v2');
    await wait(HANDSHAKE_MS);
    expect(itemsOf(docB).k2).toBe('v2');

    // Replay the earlier, already-processed frame verbatim.
    deliverToB(capturedFrame);
    await wait(30);

    expect(rejections.some((r) => r.reason === 'replayed')).toBe(true);
    expect(itemsOf(docB)).toEqual({ k1: 'v1', k2: 'v2' });

    sessionA.destroy();
    sessionB.destroy();
  });

  it('rejects an already-expired attestation and never trusts that peer', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const expiredPeer = await makePeer(-1); // expiresAt already in the past
    const peerB = await makePeer();
    const { linkA, linkB } = createLinkPair();
    const rejections: RejectionInfo[] = [];

    const sessionA = new SignedPeerSession(
      docA,
      expiredPeer.identity,
      expiredPeer.attestation,
      linkA,
    );
    const sessionB = new SignedPeerSession(docB, peerB.identity, peerB.attestation, linkB);
    sessionB.onRejected((info) => rejections.push(info));
    await wait(HANDSHAKE_MS);

    expect(sessionB.isTrusted).toBe(false);
    expect(rejections.some((r) => r.reason === 'invalid-attestation')).toBe(true);

    docA.getMap('items').set('x', 'blocked');
    await wait(30);
    expect(itemsOf(docB)).toEqual({});

    sessionA.destroy();
    sessionB.destroy();
  });
});
