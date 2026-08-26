import { describe, it, expect } from 'vitest';
import { stellarKeypairFromWeb3AuthPrivateKey } from './web3authDerive';

describe('web3auth Stellar key derivation (#214)', () => {
  it('derives a stable G… address from a fixed hex private key', () => {
    const hex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const a = stellarKeypairFromWeb3AuthPrivateKey(hex);
    const b = stellarKeypairFromWeb3AuthPrivateKey(`0x${hex}`);
    expect(a.publicKey().startsWith('G')).toBe(true);
    expect(a.publicKey()).toBe(b.publicKey());
    expect(a.canSign()).toBe(true);
  });

  it('rejects malformed keys', () => {
    expect(() => stellarKeypairFromWeb3AuthPrivateKey('deadbeef')).toThrow(/hex string/i);
  });
});
