import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';

import {
  attestSessionKey,
  createSessionIdentity,
  verifyAttestation,
  type WalletSigner,
} from './signing';

function localSigner(keypair: Keypair): WalletSigner {
  return async (payload, address) => ({
    signatureBytes: keypair.signMessage(payload),
    signerAddress: address,
  });
}

describe('session key attestation', () => {
  it('verifies a freshly-attested session key', async () => {
    const keypair = Keypair.random();
    const identity = await createSessionIdentity(keypair.publicKey());
    const attestation = await attestSessionKey(identity, 60_000, localSigner(keypair));
    expect(verifyAttestation(attestation)).toBe(true);
  });

  it('rejects an attestation whose wallet signature was tampered with', async () => {
    const keypair = Keypair.random();
    const identity = await createSessionIdentity(keypair.publicKey());
    const attestation = await attestSessionKey(identity, 60_000, localSigner(keypair));
    attestation.walletSignature[0] ^= 0xff;
    expect(verifyAttestation(attestation)).toBe(false);
  });

  it('rejects an attestation bound to a session key it was not signed for', async () => {
    const keypair = Keypair.random();
    const identity = await createSessionIdentity(keypair.publicKey());
    const attestation = await attestSessionKey(identity, 60_000, localSigner(keypair));
    const otherIdentity = await createSessionIdentity(keypair.publicKey());
    expect(
      verifyAttestation({ ...attestation, sessionPublicKeyRaw: otherIdentity.publicKeyRaw }),
    ).toBe(false);
  });

  it('rejects an expired attestation', async () => {
    const keypair = Keypair.random();
    const identity = await createSessionIdentity(keypair.publicKey());
    const attestation = await attestSessionKey(identity, -1, localSigner(keypair));
    expect(verifyAttestation(attestation)).toBe(false);
  });

  it('rejects an attestation claiming an address the signer does not control', async () => {
    const keypair = Keypair.random();
    const impostor = Keypair.random();
    // Attacker signs a payload naming impostor's address, but with their OWN key —
    // they don't hold impostor's private key.
    const identity = await createSessionIdentity(impostor.publicKey());
    const attestation = await attestSessionKey(identity, 60_000, localSigner(keypair));
    expect(verifyAttestation(attestation)).toBe(false);
  });

  it('rejects an attestation with an empty signature', async () => {
    const keypair = Keypair.random();
    const identity = await createSessionIdentity(keypair.publicKey());
    const attestation = await attestSessionKey(identity, 60_000, localSigner(keypair));
    expect(verifyAttestation({ ...attestation, walletSignature: new Uint8Array(0) })).toBe(false);
  });

  it('rejects an attestation with a truncated signature', async () => {
    const keypair = Keypair.random();
    const identity = await createSessionIdentity(keypair.publicKey());
    const attestation = await attestSessionKey(identity, 60_000, localSigner(keypair));
    expect(
      verifyAttestation({
        ...attestation,
        walletSignature: attestation.walletSignature.slice(0, 16),
      }),
    ).toBe(false);
  });

  it('rejects an attestation with arbitrary garbage signature bytes', async () => {
    const keypair = Keypair.random();
    const identity = await createSessionIdentity(keypair.publicKey());
    const attestation = await attestSessionKey(identity, 60_000, localSigner(keypair));
    const garbage = new Uint8Array(64).fill(0xaa);
    expect(verifyAttestation({ ...attestation, walletSignature: garbage })).toBe(false);
  });
});
