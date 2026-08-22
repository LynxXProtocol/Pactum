import { Keypair } from '@stellar/stellar-sdk';
import * as buffer from 'lib0/buffer';

import { signPayloadWithFreighter } from '@/lib/crypto';

/**
 * Authenticates WebRTC CRDT sync peers.
 *
 * A Freighter wallet popup per keystroke would be unusable, so each browser
 * tab mints an ephemeral ECDSA P-256 "session key" and gets it attested
 * *once* per session: the wallet signs a payload binding the session public
 * key to the Stellar address (Ed25519, verified via the same `Keypair` the
 * rest of the app already uses for on-chain signatures — no new crypto
 * dependency). Every CRDT delta afterwards is signed with the fast session
 * key and checked against that attestation, so a forged delta or a peer
 * that never attested is rejected before it touches the Y.Doc.
 */

const ATTEST_PREFIX = 'PACTUM_SYNC_ATTEST_V1';
const SESSION_KEY_ALGO = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALGO = { name: 'ECDSA', hash: 'SHA-256' } as const;

export type WalletSigner = typeof signPayloadWithFreighter;

export interface SessionIdentity {
  address: string;
  keyPair: CryptoKeyPair;
  publicKeyRaw: Uint8Array;
}

export interface Attestation {
  address: string;
  sessionPublicKeyRaw: Uint8Array;
  issuedAt: number;
  expiresAt: number;
  walletSignature: Uint8Array;
}

/** Generates the per-tab ECDSA session key used to sign every sync frame. */
export async function createSessionIdentity(address: string): Promise<SessionIdentity> {
  const keyPair = await crypto.subtle.generateKey(SESSION_KEY_ALGO, false, ['sign', 'verify']);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return { address, keyPair, publicKeyRaw };
}

function attestationPayload(
  address: string,
  sessionPublicKeyRaw: Uint8Array,
  issuedAt: number,
  expiresAt: number,
): string {
  return `${ATTEST_PREFIX}:${address}:${buffer.toBase64UrlEncoded(sessionPublicKeyRaw)}:${issuedAt}:${expiresAt}`;
}

/** Prompts the wallet once to bind this tab's session key to `identity.address`. */
export async function attestSessionKey(
  identity: SessionIdentity,
  ttlMs: number,
  signer: WalletSigner = signPayloadWithFreighter,
): Promise<Attestation> {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;
  const payload = attestationPayload(identity.address, identity.publicKeyRaw, issuedAt, expiresAt);
  const { signatureBytes } = await signer(payload, identity.address);
  return {
    address: identity.address,
    sessionPublicKeyRaw: identity.publicKeyRaw,
    issuedAt,
    expiresAt,
    walletSignature: signatureBytes,
  };
}

/** Verifies a peer's attestation came from their wallet and hasn't expired. Does not throw. */
export function verifyAttestation(attestation: Attestation, now = Date.now()): boolean {
  if (now < attestation.issuedAt || now > attestation.expiresAt) return false;
  try {
    const payload = attestationPayload(
      attestation.address,
      attestation.sessionPublicKeyRaw,
      attestation.issuedAt,
      attestation.expiresAt,
    );
    const pub = Keypair.fromPublicKey(attestation.address);
    // `verifyMessage` (SEP-53) accepts Uint8Array data and signature at runtime.
    // The typed adapter isolates the BufferSource -> SDK parameter compatibility.
    const signature = attestation.walletSignature as unknown as Parameters<
      typeof pub.verifyMessage
    >[1];
    return pub.verifyMessage(payload, signature);
  } catch {
    return false;
  }
}

export async function importSessionPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  // WebCrypto's BufferSource type doesn't accept a Uint8Array whose buffer is typed as the
  // broader ArrayBufferLike (which includes SharedArrayBuffer) — it's the same shape at
  // runtime, this is purely a TS lib.dom.d.ts type-parameter mismatch.
  return crypto.subtle.importKey('raw', raw as unknown as BufferSource, SESSION_KEY_ALGO, false, [
    'verify',
  ]);
}

/** Signs one outgoing sync frame with the tab's fast session key. */
export async function signFrame(privateKey: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign(SIGN_ALGO, privateKey, bytes as BufferSource);
  return new Uint8Array(sig);
}

/** Verifies an incoming sync frame against the sender's attested session key. */
export async function verifyFrame(
  publicKey: CryptoKey,
  bytes: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      SIGN_ALGO,
      publicKey,
      signature as BufferSource,
      bytes as BufferSource,
    );
  } catch {
    return false;
  }
}
