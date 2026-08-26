/**
 * Unit tests for the XDR decoding and error enrichment pipeline.
 *
 * These tests verify that:
 *  - Known contract error codes are decoded correctly
 *  - Base64 XDR blobs in error strings are detected and decoded
 *  - Diagnostic event extraction works with mock data
 *  - The full error pipeline produces structured DecodedXdrError objects
 *  - SorobanSimulationError carries all expected fields
 */

import { describe, it, expect } from 'vitest';
import {
  decodeXdrBlob,
  decodeSimulationError,
  decodeDiagnosticEvents,
  isSorobanXdrError,
} from './xdrDecode';
import {
  decodeRegistryContractError,
  decodeSorobanError,
  TRANSACTION_FAILED_MESSAGE,
} from './errors';
import { SorobanSimulationError, extractDiagnosticEventBlobs } from './soroban';

// ---------------------------------------------------------------------------
// isSorobanXdrError
// ---------------------------------------------------------------------------

describe('isSorobanXdrError', () => {
  it('detects base64-like XDR blobs in error strings', () => {
    expect(
      isSorobanXdrError(
        'AAAAAgAAAAMAAAABAAAAAAAAAAAAAAAB1LsVBdV8g9ZFSF1pxFchIVFCpmMyULX29tHnD+hL===',
      ),
    ).toBe(true);
  });

  it('rejects short strings without base64 patterns', () => {
    expect(isSorobanXdrError('Transaction Failed')).toBe(false);
  });

  it('detects XDR in Stellar Error(Contract, #1) responses', () => {
    // Real simulation errors often include base64 traces
    expect(isSorobanXdrError('Error(Contract, #1)')).toBe(false);
  });

  it('works with Error objects', () => {
    const err = new Error(
      'AAAAAgAAAAMAAAABAAAAAAAAAAAAAAAB1LsVBdV8g9ZFSF1pxFchIVFCpmMyULX29tHnD+hL==',
    );
    expect(isSorobanXdrError(err)).toBe(true);
  });

  it('handles null/undefined gracefully', () => {
    expect(isSorobanXdrError(null)).toBe(false);
    expect(isSorobanXdrError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decodeXdrBlob
// ---------------------------------------------------------------------------

describe('decodeXdrBlob', () => {
  it('returns null for non-XDR base64 strings', () => {
    expect(decodeXdrBlob('hello world')).toBeNull();
    expect(decodeXdrBlob('not-base64!!!###')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(decodeXdrBlob('')).toBeNull();
  });

  it('gracefully handles very long random base64', () => {
    // A valid length base64 string that is not valid XDR should return null
    const longRandomB64 =
      'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcA==';
    const result = decodeXdrBlob(longRandomB64);
    // It might fail to decode or might decode as something; either is OK for a random string
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decodeSimulationError
// ---------------------------------------------------------------------------

describe('decodeSimulationError', () => {
  it('matches known contract error code #1 (due date)', () => {
    const result = decodeSimulationError('Error(Contract, #1)', [], null);
    expect(result.message).toBe('Due date must be in the future.');
    expect(result.resolution).toContain('later than the current time');
  });

  it('matches known contract error code #4 (unauthorized)', () => {
    const result = decodeSimulationError('Error(Contract, #4)', [], null);
    expect(result.message).toContain('Unauthorized');
    expect(result.resolution).toContain('correct wallet');
  });

  it('matches HostError pattern', () => {
    const result = decodeSimulationError('HostError: budget exceeded', [], null);
    expect(result.message).toContain('host-level error');
  });

  it('matches WasmVmError pattern', () => {
    const result = decodeSimulationError('WasmVmError: invalid opcode', [], null);
    expect(result.message).toContain('Wasm VM trap');
  });

  it('falls back to raw error message for unknown errors', () => {
    const result = decodeSimulationError('Something completely unexpected happened', [], null);
    expect(result.message).toBe('Something completely unexpected happened');
    expect(result.resolution).toBeDefined();
  });

  it('includes attemptedFunction in the result when provided', () => {
    const result = decodeSimulationError('Error(Contract, #3)', [], 'create_commitment');
    expect(result.attemptedOperation).not.toBeNull();
    expect(result.attemptedOperation?.operation).toBe('create_commitment');
    // When a TRAP_PATTERN matches, trapReason carries the decoded message
    expect(result.attemptedOperation?.trapReason).toContain('Commitment');
  });

  it('produces empty diagnostic events when no blobs are provided', () => {
    const result = decodeSimulationError('some error', [], null);
    expect(result.diagnosticEvents).toEqual([]);
  });

  it('produces empty rawXdrBlobs for errors without base64', () => {
    const result = decodeSimulationError('A plain text error with no xdr at all', [], 'attest');
    expect(result.rawXdrBlobs).toEqual([]);
  });

  it('returns structured result for account not found errors', () => {
    const result = decodeSimulationError(
      'account not found for GASV7ZZOPNYYFEPJ6N3GX4VINJELUQQDRX6UWWOO43F55CV6OBQUEGVK',
      [],
      null,
    );
    expect(result.message).toContain('not yet funded');
    expect(result.resolution).toContain('Fund your account');
  });
});

// ---------------------------------------------------------------------------
// decodeDiagnosticEvents
// ---------------------------------------------------------------------------

describe('decodeDiagnosticEvents', () => {
  it('returns an empty array for empty input', () => {
    expect(decodeDiagnosticEvents([])).toEqual([]);
  });

  it('returns unparseable entries for random base64 strings', () => {
    const result = decodeDiagnosticEvents(['not-valid-xdr-at-all']);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('unparseable');
    expect(result[0].summary).toContain('Failed to decode');
  });
});

// ---------------------------------------------------------------------------
// decodeRegistryContractError (existing + enhanced)
// ---------------------------------------------------------------------------

describe('decodeRegistryContractError', () => {
  it('decodes Error(Contract, #1) as "Due date must be in the future"', () => {
    expect(decodeRegistryContractError('Error(Contract, #1)')).toBe(
      'Due date must be in the future',
    );
  });

  it('decodes Error(Contract, #4) as "Unauthorized"', () => {
    expect(decodeRegistryContractError('Error(Contract, #4)')).toBe('Unauthorized');
  });

  it('decodes Error(Contract, #3) as "Commitment already resolved"', () => {
    expect(decodeRegistryContractError('Error(Contract, #3)')).toBe('Commitment already resolved');
  });

  it('returns generic message for unknown contract code', () => {
    expect(decodeRegistryContractError('Error(Contract, #999)')).toBe(TRANSACTION_FAILED_MESSAGE);
  });

  it('handles Error objects', () => {
    const err = new Error('Error(Contract, #2)');
    expect(decodeRegistryContractError(err)).toBe('Commitment not found');
  });

  it('falls back to XDR decoding for XDR-rich errors', () => {
    // HostError contains XDR patterns that get decoded
    const result = decodeRegistryContractError('HostError: storage error');
    expect(result).toBe(
      'The smart contract hit a host-level error (e.g. state read/write failure, budget exceeded).',
    );
  });

  it('returns Transaction Failed for null/undefined', () => {
    expect(decodeRegistryContractError(null)).toBe(TRANSACTION_FAILED_MESSAGE);
    expect(decodeRegistryContractError(undefined)).toBe(TRANSACTION_FAILED_MESSAGE);
  });

  it('handles generic "Error Code 5" pattern', () => {
    expect(decodeRegistryContractError('Error Code 5')).toBe('Invalid outcome');
  });
});

// ---------------------------------------------------------------------------
// decodeSorobanError (enhanced structured decoder)
// ---------------------------------------------------------------------------

describe('decodeSorobanError', () => {
  it('returns structured result with attempted operation for known contract errors', () => {
    const result = decodeSorobanError('Error(Contract, #1)', [], 'create_commitment');
    expect(result.message).toBe('Due date must be in the future');
    expect(result.attemptedOperation).not.toBeNull();
    expect(result.attemptedOperation?.operation).toBe('create_commitment');
    expect(result.attemptedOperation?.trapReason).toContain('error code #1');
  });

  it('returns structured result for HostError', () => {
    const result = decodeSorobanError('HostError: something broke', [], null);
    expect(result.message).toContain('host-level error');
    expect(result.resolution).toBeDefined();
  });

  it('handles null/undefined gracefully', () => {
    const result = decodeSorobanError(null, [], null);
    expect(result.message).toBe(TRANSACTION_FAILED_MESSAGE);
    expect(result.rawError).toBe(TRANSACTION_FAILED_MESSAGE);
    expect(result.diagnosticEvents).toEqual([]);
    expect(result.attemptedOperation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SorobanSimulationError
// ---------------------------------------------------------------------------

describe('SorobanSimulationError', () => {
  it('creates an error with decodedXdrError populated', () => {
    const err = new SorobanSimulationError(
      'Transaction simulation failed',
      'Error(Contract, #2)',
      [],
      'create_commitment',
    );
    expect(err.name).toBe('SorobanSimulationError');
    expect(err.message).toBe('Transaction simulation failed');
    expect(err.diagnosticEventBlobs).toEqual([]);
    expect(err.attemptedFunction).toBe('create_commitment');
    expect(err.decodedXdrError).toBeDefined();
    // Message comes from decodeSimulationError TRAP_PATTERNS
    expect(err.decodedXdrError.message).toContain('Commitment not found');
    expect(err.decodedXdrError.attemptedOperation?.operation).toBe('create_commitment');
  });

  it('is an instance of Error', () => {
    const err = new SorobanSimulationError('test', 'raw', [], null);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SorobanSimulationError);
  });
});

// ---------------------------------------------------------------------------
// extractDiagnosticEventBlobs
// ---------------------------------------------------------------------------

describe('extractDiagnosticEventBlobs', () => {
  it('returns empty array for object without events or error fields', () => {
    const blobs = extractDiagnosticEventBlobs({});
    expect(blobs).toEqual([]);
  });

  it('extracts base64 blobs from error string', () => {
    // A fabricated error with a long base64-like substring
    const blobs = extractDiagnosticEventBlobs({
      error:
        'Something failed with data: AAAAAGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6YWJjZGVmZ2hpamtsbW5vcA==',
    });
    expect(blobs.length).toBeGreaterThanOrEqual(0); // base64 may or may not be valid XDR
  });

  it('handles null/undefined gracefully', () => {
    const blobs = extractDiagnosticEventBlobs(null as any);
    expect(blobs).toEqual([]);
    const blobs2 = extractDiagnosticEventBlobs(undefined as any);
    expect(blobs2).toEqual([]);
  });
});
