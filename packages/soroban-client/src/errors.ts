import { decodeSimulationError, isSorobanXdrError } from './xdrDecode';
import type { DecodedXdrError, DecodedDiagnosticEvent } from './xdrDecode';

export type { DecodedXdrError, DecodedDiagnosticEvent };

export const TRANSACTION_FAILED_MESSAGE = 'Transaction Failed' as const;

const REGISTRY_CONTRACT_ERROR_MESSAGES: Readonly<Record<number, string>> = Object.freeze({
  1: 'Due date must be in the future',
  2: 'Commitment not found',
  3: 'Commitment already resolved',
  4: 'Unauthorized',
  5: 'Invalid outcome',
  6: 'Contract already initialized',
  7: 'Not arbitrator',
  8: 'Dispute window expired',
  9: 'Invalid transition',
  10: 'Contract not initialized',
  11: 'Not authorized',
  12: 'Overflow',
  13: 'Reentrant call',
  14: 'Upgrade admin not set',
  15: 'Upgrade admin already set',
  16: 'Schema downgrade',
  17: 'Unsupported schema version',
  18: 'Migration not enabled',
  19: 'Batch too large',
  20: 'Invalid milestone count',
  21: 'Invalid milestone index',
  22: 'Milestone already attested',
  23: 'Milestone out of order',
  24: 'Empty arbitrator set',
  25: 'Already voted',
  26: 'Insufficient stake',
  27: 'Unbonding pending',
  28: 'Unbonding not elapsed',
  29: 'Dispute active',
  30: 'Staking token not set',
  31: 'Zero amount',
  32: 'Not attestor',
  33: 'Attestor already voted',
  34: 'Threshold invalid',
  35: 'Voting closed',
  36: 'Votes not met',
  37: 'Use voting resolution',
  38: 'Protocol paused',
});

const CONTRACT_ERROR_PATTERN = /Error\(Contract,\s*#(\d+)\)/i;
const GENERIC_ERROR_CODE_PATTERN = /Error\s+Code\s+(\d+)/i;

function extractRegistryErrorCode(source: string): number | null {
  const contractMatch = CONTRACT_ERROR_PATTERN.exec(source);
  if (contractMatch?.[1] !== undefined) {
    return Number.parseInt(contractMatch[1], 10);
  }

  const genericMatch = GENERIC_ERROR_CODE_PATTERN.exec(source);
  if (genericMatch?.[1] !== undefined) {
    return Number.parseInt(genericMatch[1], 10);
  }

  return null;
}

function errorToSource(error: unknown): string | null {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return null;
}

/**
 * Primary error decoder for contract invocation failures.
 *
 * This function is the main entry point used by UI components to translate
 * any Soroban-related error into a human-readable message. It tries several
 * strategies in order:
 *
 * 1. Registry contract error codes (e.g. `Error(Contract, #1)`)
 * 2. XDR-based decoding of diagnostic events and footprints
 * 3. Generic error pattern matching
 * 4. Fallback to a generic "Transaction Failed" message
 *
 * @param error - The error to decode (string, Error, or unknown)
 * @returns A human-readable error string for display in toasts, modals, etc.
 */
export function decodeRegistryContractError(error: unknown): string {
  const source = errorToSource(error);
  if (source === null) {
    return TRANSACTION_FAILED_MESSAGE;
  }

  // Strategy 1: Direct contract error code match
  const code = extractRegistryErrorCode(source);
  if (code !== null && Number.isInteger(code)) {
    if (Object.hasOwn(REGISTRY_CONTRACT_ERROR_MESSAGES, code)) {
      return REGISTRY_CONTRACT_ERROR_MESSAGES[code];
    }
  }

  // Strategy 2: Try XDR-based decoding for errors that contain
  // either base64 blobs OR known Soroban trap patterns (HostError, etc.).
  if (
    isSorobanXdrError(source) ||
    /HostError|WasmVmError|InvalidAction|InternalError|InsufficientRefundableFee|StaleFootprint/i.test(
      source,
    )
  ) {
    try {
      const decoded = decodeSimulationError(source);
      if (decoded && decoded.message && decoded.message !== source) {
        return decoded.message;
      }
    } catch {
      // XDR decode failed, fall through to generic handling
    }
  }

  // Strategy 3: If we matched a contract code but it's unknown, fall through
  // to generic "Transaction Failed" rather than exposing raw error details.
  if (code !== null) {
    return TRANSACTION_FAILED_MESSAGE;
  }

  return TRANSACTION_FAILED_MESSAGE;
}

/**
 * Enhanced version that returns structured error information including
 * diagnostic events, attempted operation details, and resolution guidance.
 *
 * Use this when you need richer error data for display in a modal/dialog
 * rather than a simple toast message.
 *
 * @param error - The error to decode
 * @param diagnosticEventBlobs - Optional base64-encoded diagnostic events from simulation
 * @param attemptedFunction - Optional hint about which function was invoked
 * @returns A structured error object with details suitable for modal display
 */
export function decodeSorobanError(
  error: unknown,
  diagnosticEventBlobs: string[] = [],
  attemptedFunction: string | null = null,
): DecodedXdrError {
  const source = errorToSource(error);

  // If we have a simple contract error code, build a concise XDR error
  if (source) {
    const code = extractRegistryErrorCode(source);
    if (code !== null && Number.isInteger(code)) {
      const message = Object.hasOwn(REGISTRY_CONTRACT_ERROR_MESSAGES, code)
        ? REGISTRY_CONTRACT_ERROR_MESSAGES[code]
        : TRANSACTION_FAILED_MESSAGE;

      return {
        message,
        rawError: source,
        diagnosticEvents: [],
        attemptedOperation: attemptedFunction
          ? {
              operation: attemptedFunction,
              arguments: {},
              failedAt: `${attemptedFunction} execution`,
              trapReason: `The contract returned error code #${code}: ${message}`,
            }
          : null,
        resolution: 'Check your transaction parameters and try again.',
        rawXdrBlobs: [],
      };
    }
  }

  // Full XDR-based decoding
  const errorMessage = source ?? TRANSACTION_FAILED_MESSAGE;
  return decodeSimulationError(errorMessage, diagnosticEventBlobs, attemptedFunction);
}

/**
 * Sanitize an error message to ensure no sensitive data (tokens, keys, etc.)
 * is exposed to the UI.
 */
export function sanitizeErrorMessage(message: string): string {
  // Strip potential base64-encoded sensitive tokens
  let sanitized = message;
  // Remove any Stellar secret keys (S-prefixed base58)
  sanitized = sanitized.replace(/S[A-Za-z0-9]{55}/g, '[REDACTED_SECRET]');
  // Remove long hex strings (potential API keys / hashes of secrets)
  sanitized = sanitized.replace(/[0-9a-fA-F]{64,}/g, '[REDACTED_HEX]');
  return sanitized;
}
