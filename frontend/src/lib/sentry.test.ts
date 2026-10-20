import { describe, it, expect } from 'vitest';
import { scrubEvent } from './sentry';

// Canonical-shaped Stellar identifiers (base32 alphabet A-Z2-7). The scrub
// regex is pattern-based, so these only need to be well-formed strings, not
// checksummed real addresses.
const G_ADDRESS = `G${'A'.repeat(55)}`;
const C_CONTRACT = `C${'B'.repeat(55)}`;
const M_MUXED = `M${'C'.repeat(68)}`;
const HEX_HASH = 'ab'.repeat(32);

describe('scrubEvent', () => {
  it('redacts muxed M-addresses, G/C/S addresses and hex hashes in event.message', () => {
    const event: any = {
      message: `failed for ${M_MUXED} / ${G_ADDRESS} / ${C_CONTRACT} / ${HEX_HASH}`,
    };
    const scrubbed = scrubEvent(event, undefined);
    expect(scrubbed.message).toBe(`failed for [REDACTED] / [REDACTED] / [REDACTED] / [REDACTED]`);
  });

  it('redacts muxed M-addresses in exception.values', () => {
    const event: any = {
      exception: {
        values: [{ value: `wallet ${M_MUXED} failed` }],
      },
    };
    const scrubbed = scrubEvent(event, undefined);
    expect(scrubbed.exception.values[0].value).toBe('wallet [REDACTED] failed');
  });

  it('redacts sensitive values in a nested extra object', () => {
    const event: any = {
      extra: {
        address: M_MUXED,
        issuer: G_ADDRESS,
        hashes: [HEX_HASH, { commitmentHash: HEX_HASH }],
        safe: 'keep-me',
      },
    };
    const scrubbed = scrubEvent(event, undefined);
    expect(scrubbed.extra.address).toBe('[REDACTED]');
    expect(scrubbed.extra.issuer).toBe('[REDACTED]');
    expect(scrubbed.extra.hashes).toEqual(['[REDACTED]', { commitmentHash: '[REDACTED]' }]);
    expect(scrubbed.extra.safe).toBe('keep-me');
  });

  it('leaves non-sensitive messages untouched', () => {
    const event: any = { message: 'all good here' };
    const scrubbed = scrubEvent(event, undefined);
    expect(scrubbed.message).toBe('all good here');
  });
});
