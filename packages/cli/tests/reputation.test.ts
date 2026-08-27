import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  createReputationCommand,
  calculateTrustScore,
  formatTrustScoreBadge,
} from '../src/commands/reputation.js';

vi.mock('@pactum/sdk', () => {
  return {
    PactumClient: vi.fn().mockImplementation(() => {
      return {
        getReputation: vi.fn().mockResolvedValue({
          fulfilledCount: 10n,
          lateCount: 2n,
          breachedCount: 1n,
        }),
      };
    }),
  };
});

describe('Pactum CLI Reputation Command', () => {
  let logSpy: any;
  let errSpy: any;
  let originalExitCode: number | undefined;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('calculates trust score correctly', () => {
    expect(calculateTrustScore(0, 0, 0)).toBe(50); // neutral
    expect(calculateTrustScore(10, 0, 0)).toBe(100);
    expect(calculateTrustScore(0, 0, 10)).toBe(0);
    expect(calculateTrustScore(8, 2, 0)).toBe(90);
  });

  it('formats badges appropriately', () => {
    expect(formatTrustScoreBadge(95)).toContain('High Trust');
    expect(formatTrustScoreBadge(60)).toContain('Neutral / Fair');
    expect(formatTrustScoreBadge(30)).toContain('Low Trust');
  });

  it('queries on-chain reputation and outputs JSON format', async () => {
    const keypair = Keypair.random();
    const address = keypair.publicKey();

    const cmd = createReputationCommand();
    await cmd.parseAsync(['node', 'test', 'get', address, '--json']);

    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.address).toBe(address);
    expect(parsed.reputation.fulfilled).toBe(10);
    expect(parsed.reputation.late).toBe(2);
    expect(parsed.reputation.breached).toBe(1);
    expect(parsed.score).toBe(85);
  });

  it('rejects an invalid stellar public address', async () => {
    const cmd = createReputationCommand();
    await cmd.parseAsync(['node', 'test', 'get', 'GBAD_NOT_VALID_STELLAR_ADDRESS', '--json']);

    expect(process.exitCode).toBe(1);
    const errOutput = errSpy.mock.calls[0][0];
    expect(errOutput).toContain('Invalid Stellar public key');
  });
});
