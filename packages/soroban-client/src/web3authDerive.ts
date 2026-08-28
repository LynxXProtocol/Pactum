/**
 * Pure Stellar key derivation from a Web3Auth secp256k1 private key hex.
 * Kept separate from the modal SDK so unit tests stay lightweight.
 */
import { Keypair } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { getED25519Key } from '@toruslabs/openlogin-ed25519';

export function stellarKeypairFromWeb3AuthPrivateKey(hexPrivateKey: string): Keypair {
  const normalized = hexPrivateKey.startsWith('0x') ? hexPrivateKey.slice(2) : hexPrivateKey;
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length < 64) {
    throw new Error('Web3Auth private key must be a hex string of at least 32 bytes.');
  }
  const { sk } = getED25519Key(normalized.padStart(64, '0'));
  const seed = Buffer.from(sk).subarray(0, 32);
  return Keypair.fromRawEd25519Seed(seed);
}
