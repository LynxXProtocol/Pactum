/**
 * Client-side Soroban XDR decoding & human-readable diffing utilities.
 *
 * When a smart contract transaction traps or fails during simulation, Soroban
 * returns raw XDR (often base64-encoded). This module decodes those payloads
 * into human-readable descriptions of what the contract attempted and exactly
 * which assertion, state read, or execution step caused the trap.
 *
 * @see https://github.com/LynxXProtocol/Pactum/issues/144
 */

import { xdr, scValToNative } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DecodedDiagnosticEvent {
  /** The raw event type discriminator (e.g. "contract", "diagnostic") */
  type: string;
  /** For contract events: the contract ID the event was emitted from */
  contractId?: string;
  /** Decoded topic list (ScVal → native), if present */
  topics: unknown[];
  /** Decoded event data (ScVal → native), if present */
  data: unknown;
  /** Human-readable summary of this diagnostic event */
  summary: string;
  /** Whether this event occurred inside a successful contract call */
  inSuccessfulContractCall: boolean;
}

export interface DecodedXdrError {
  /** The top-level human-readable error message */
  message: string;
  /** The original raw error string from the RPC */
  rawError: string;
  /** Any diagnostic events decoded from the simulation failure */
  diagnosticEvents: DecodedDiagnosticEvent[];
  /** A structured "diff" showing what the contract attempted */
  attemptedOperation: AttemptedOperation | null;
  /** Suggested resolution guidance */
  resolution: string | null;
  /** The raw base64 XDR blobs (for debugging) */
  rawXdrBlobs: string[];
}

export interface AttemptedOperation {
  /** High-level operation name (e.g. "create_commitment", "attest") */
  operation: string;
  /** Arguments passed to the function (decoded ScVals → native) */
  arguments: Record<string, unknown>;
  /** Which step in execution caused the failure */
  failedAt: string;
  /** The specific condition that triggered the trap */
  trapReason: string;
}

// ---------------------------------------------------------------------------
// Known operation signatures & error mappings
// ---------------------------------------------------------------------------

/**
 * Maps from function names to human-readable argument names.
 * When decoding the invocation footprint, we can label each arg.
 */
const KNOWN_FUNCTION_ARGS: Record<string, string[]> = {
  create_commitment: ['issuer', 'counterparty', 'termsHash', 'dueAt'],
  attest: ['commitmentId', 'outcome'],
  dispute: ['commitmentId', 'reason'],
  resolve_dispute: ['commitmentId', 'outcome'],
  init: [],
  get_reputation: ['address'],
  get_commitment: ['commitmentId'],
};

/**
 * Maps from known contract assertion failure patterns to human-readable
 * descriptions. These are derived from the contract's error codes and
 * common Soroban host function failure modes.
 */
const TRAP_PATTERNS: Array<{
  pattern: RegExp;
  message: string;
  resolution: string;
}> = [
  {
    pattern: /Error\(Contract,\s*#1\)/i,
    message: 'Due date must be in the future.',
    resolution: 'Select a due date that is later than the current time.',
  },
  {
    pattern: /Error\(Contract,\s*#2\)/i,
    message: 'Commitment not found.',
    resolution: 'Verify the commitment ID exists before attempting this action.',
  },
  {
    pattern: /Error\(Contract,\s*#3\)/i,
    message: 'Commitment has already been resolved.',
    resolution: 'No further action is needed — this commitment is closed.',
  },
  {
    pattern: /Error\(Contract,\s*#4\)/i,
    message: 'Unauthorized — you are not permitted to perform this action.',
    resolution:
      'Confirm you are using the correct wallet address that is authorized for this commitment.',
  },
  {
    pattern: /HostError/i,
    message:
      'The smart contract hit a host-level error (e.g. state read/write failure, budget exceeded).',
    resolution:
      'This is usually a transient network issue. Try the transaction again in a few seconds.',
  },
  {
    pattern: /WasmVmError|InvalidAction/i,
    message: 'The contract execution encountered a Wasm VM trap.',
    resolution:
      'This may indicate a bug in the contract or an invalid input. Check the transaction parameters.',
  },
  {
    pattern: /InternalError/i,
    message: 'An internal Soroban RPC error occurred.',
    resolution: 'The RPC server may be experiencing issues. Retry in a few minutes.',
  },
  {
    pattern: /InsufficientRefundableFee/i,
    message:
      'Insufficient refundable fee — the transaction needs more XLM to cover resource costs.',
    resolution: 'Fund your wallet with additional Testnet XLM and try again.',
  },
  {
    pattern: /account.*not found|404.*account/i,
    message: 'Your wallet account is not yet funded on the Stellar network.',
    resolution:
      'Fund your account with Testnet XLM using the "Fund Testnet XLM" button or Stellar Friendbot.',
  },
  {
    pattern: /StaleFootprint|footprint.*expired/i,
    message: 'The transaction footprint has expired — ledger state has changed since simulation.',
    resolution: 'This is a transient issue. Simply retry the transaction and it should succeed.',
  },
];

// ---------------------------------------------------------------------------
// XDR Decoding Helpers
// ---------------------------------------------------------------------------

/**
 * Safely decode a base64-encoded XDR blob to an xdr type.
 * Returns null on any decode failure.
 */
function tryDecodeXdr<T>(base64: string, decode: (b64: string) => T): T | null {
  try {
    return decode(base64);
  } catch {
    return null;
  }
}

/**
 * Attempt to decode a ScVal from base64, returning null on failure.
 */
function decodeScVal(base64: string): xdr.ScVal | null {
  return tryDecodeXdr(base64, (b64) => xdr.ScVal.fromXDR(b64, 'base64'));
}

/**
 * Decode a DiagnosticEvent from base64, returning null on failure.
 */
function decodeDiagnosticEvent(base64: string): xdr.DiagnosticEvent | null {
  return tryDecodeXdr(base64, (b64) => xdr.DiagnosticEvent.fromXDR(b64, 'base64'));
}

/**
 * Decode a TransactionResult from base64, returning null on failure.
 */
function decodeTransactionResult(base64: string): xdr.TransactionResult | null {
  return tryDecodeXdr(base64, (b64) => xdr.TransactionResult.fromXDR(b64, 'base64'));
}

/**
 * Decode a TransactionEnvelope from base64, returning null on failure.
 */
function decodeTransactionEnvelope(base64: string): xdr.TransactionEnvelope | null {
  return tryDecodeXdr(base64, (b64) => xdr.TransactionEnvelope.fromXDR(b64, 'base64'));
}

/**
 * Decode a TransactionMeta from base64, returning null on failure.
 */
function decodeTransactionMeta(base64: string): xdr.TransactionMeta | null {
  return tryDecodeXdr(base64, (b64) => xdr.TransactionMeta.fromXDR(b64, 'base64'));
}

/**
 * Safely convert an ScVal to a native JavaScript value.
 */
function safeScValToNative(scv: xdr.ScVal): unknown {
  try {
    return scValToNative(scv);
  } catch {
    return `[unparseable ScVal: ${scv.switch().name}]`;
  }
}

/**
 * Build a human-readable summary of a single diagnostic event.
 */
function summarizeDiagnosticEvent(event: xdr.DiagnosticEvent): {
  summary: string;
  type: string;
  contractId?: string;
  topics: unknown[];
  data: unknown;
} {
  try {
    // DiagnosticEvent is a union: the `event` accessor gives the inner event
    const inner = (event as any).event?.();
    if (!inner) {
      return {
        summary: 'Unknown diagnostic event',
        type: 'unknown',
        topics: [],
        data: null,
      };
    }

    // Try to get the contract event from diagnostic
    const contractEvent = (inner as any).contractEvent?.() ?? inner;

    // Extract contract ID if present
    const contractId =
      contractEvent.contractId?.()?.contractId?.()?.toString?.() ??
      contractEvent.contractId?.toString?.() ??
      undefined;

    // Extract topics
    let topics: unknown[] = [];
    try {
      const topicsArr = contractEvent.body?.()?.v0?.()?.topics?.();
      if (Array.isArray(topicsArr)) {
        topics = topicsArr.map(safeScValToNative);
      }
    } catch {
      // no topics
    }

    // Extract data value
    let data: unknown = null;
    try {
      const dataVal = contractEvent.body?.()?.v0?.()?.data;
      if (dataVal) {
        data = safeScValToNative(dataVal);
      }
    } catch {
      // no data
    }

    // Build summary from topics + data
    const eventType = contractEvent.type?.()?.switch?.()?.name ?? 'contract';
    const topicStr =
      topics.length > 0
        ? topics.map((t) => (typeof t === 'string' ? t : JSON.stringify(t))).join(' → ')
        : 'no topics';

    return {
      summary: `[${eventType}] ${topicStr}${data ? ` = ${JSON.stringify(data)}` : ''}`,
      type: eventType,
      contractId,
      topics,
      data,
    };
  } catch {
    return {
      summary: 'Failed to decode diagnostic event',
      type: 'error',
      topics: [],
      data: null,
    };
  }
}

/**
 * Given a smart contract method name, produce human-readable argument labels.
 */
function labelFunctionArgs(functionName: string, args: unknown[]): Record<string, unknown> {
  const labels = KNOWN_FUNCTION_ARGS[functionName] ?? [];
  const result: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const label = labels[i] ?? `arg${i}`;
    result[label] = args[i];
  }
  return result;
}

/**
 * Attempt to extract the invoked function name and arguments from
 * decoded diagnostic events.
 */
function extractAttemptedOperation(events: xdr.DiagnosticEvent[]): AttemptedOperation | null {
  // Walk through events looking for contract invocations
  const invocationTopics = new Map<string, { topics: unknown[]; data: unknown }>();

  for (const event of events) {
    try {
      const inner = (event as any).event?.();
      if (!inner) continue;

      const contractEvent = inner.contractEvent?.() ?? inner;
      const topicsArr = contractEvent.body?.()?.v0?.()?.topics?.();
      if (!Array.isArray(topicsArr) || topicsArr.length === 0) continue;

      const nativeTopics = topicsArr.map(safeScValToNative);
      const functionName = String(nativeTopics[0] ?? '');

      // Known Soroban functions often emit their name as the first topic
      if (functionName in KNOWN_FUNCTION_ARGS) {
        const dataVal = contractEvent.body?.()?.v0?.()?.data;
        invocationTopics.set(functionName, {
          topics: nativeTopics.slice(1), // remaining topics after function name
          data: dataVal ? safeScValToNative(dataVal) : null,
        });
      }
    } catch {
      // skip unparseable events
    }
  }

  if (invocationTopics.size === 0) return null;

  // Prefer the most specific function we can identify
  const preferred = [
    'create_commitment',
    'attest',
    'dispute',
    'resolve_dispute',
    'init',
    'get_reputation',
    'get_commitment',
  ];
  let bestFn = '';
  for (const fn of preferred) {
    if (invocationTopics.has(fn)) {
      bestFn = fn;
      break;
    }
  }
  if (!bestFn) {
    // Take the first one
    bestFn = invocationTopics.keys().next().value ?? '';
  }

  const entry = invocationTopics.get(bestFn)!;

  return {
    operation: bestFn,
    arguments: labelFunctionArgs(bestFn, entry.topics),
    failedAt: `${bestFn} execution`,
    trapReason: 'The contract rejected the invocation during simulation.',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decode a base64-encoded XDR blob into a human-readable description.
 * This is the main entry point for decoding arbitrary XDR from Soroban errors.
 *
 * @param base64Xdr - The base64-encoded XDR string to decode
 * @returns A human-readable description, or null if decoding failed
 */
export function decodeXdrBlob(base64Xdr: string): string | null {
  // Try TransactionResult first
  const txResult = decodeTransactionResult(base64Xdr);
  if (txResult) {
    try {
      const resultCode = txResult.result?.()?.switch?.()?.name ?? 'unknown';
      return `Transaction result: ${resultCode}`;
    } catch {
      return 'Decoded TransactionResult (details unavailable)';
    }
  }

  // Try DiagnosticEvent
  const diagEvent = decodeDiagnosticEvent(base64Xdr);
  if (diagEvent) {
    const summary = summarizeDiagnosticEvent(diagEvent);
    return summary.summary;
  }

  // Try ScVal
  const scVal = decodeScVal(base64Xdr);
  if (scVal) {
    const native = safeScValToNative(scVal);
    return `ScVal: ${typeof native === 'string' ? native : JSON.stringify(native)}`;
  }

  // Try TransactionMeta
  const meta = decodeTransactionMeta(base64Xdr);
  if (meta) {
    try {
      const version = String(meta.switch?.() ?? 'unknown');
      return `Transaction meta (v${version})`;
    } catch {
      return 'Decoded TransactionMeta (details unavailable)';
    }
  }

  // Try TransactionEnvelope
  const envelope = decodeTransactionEnvelope(base64Xdr);
  if (envelope) {
    return 'Decoded TransactionEnvelope';
  }

  return null;
}

/**
 * Decode an array of base64-encoded diagnostic events from a failed simulation.
 *
 * @param eventBlobs - Array of base64-encoded diagnostic event XDR strings
 * @returns Array of decoded events with human-readable summaries
 */
export function decodeDiagnosticEvents(eventBlobs: string[]): DecodedDiagnosticEvent[] {
  return eventBlobs
    .map((blob) => {
      const rawEvent = decodeDiagnosticEvent(blob);
      if (!rawEvent) {
        return {
          type: 'unparseable',
          topics: [],
          data: null,
          summary: `Failed to decode event from XDR blob (${blob.substring(0, 20)}...)`,
          inSuccessfulContractCall: false,
        };
      }

      const summary = summarizeDiagnosticEvent(rawEvent);
      return {
        type: summary.type,
        contractId: summary.contractId,
        topics: summary.topics,
        data: summary.data,
        summary: summary.summary,
        inSuccessfulContractCall: (rawEvent as any).inSuccessfulContractCall?.() ?? false,
      };
    })
    .filter(Boolean);
}

/**
 * Decode a full simulation error into a structured, human-readable
 * {@link DecodedXdrError} object.
 *
 * This is the primary function to call when a Soroban simulation fails.
 *
 * @param errorMessage - The raw error string from the simulation response
 * @param diagnosticEventBlobs - Optional base64-encoded diagnostic events
 * @param attemptedFunction - Optional hint about which function was invoked
 * @returns A structured error with human-readable details
 */
export function decodeSimulationError(
  errorMessage: string,
  diagnosticEventBlobs: string[] = [],
  attemptedFunction: string | null = null,
): DecodedXdrError {
  // Step 1: Check for known trap patterns
  let matchedMessage: string | null = null;
  let matchedResolution: string | null = null;

  for (const trap of TRAP_PATTERNS) {
    if (trap.pattern.test(errorMessage)) {
      matchedMessage = trap.message;
      matchedResolution = trap.resolution;
      break;
    }
  }

  // Step 2: Decode any diagnostic events
  const decodedEvents = decodeDiagnosticEvents(diagnosticEventBlobs);

  // Step 3: Try to extract the attempted operation from diagnostic events
  const rawEvents = diagnosticEventBlobs
    .map((b) => decodeDiagnosticEvent(b))
    .filter((e): e is xdr.DiagnosticEvent => e !== null);

  let attemptedOperation = extractAttemptedOperation(rawEvents);

  // If no operation extracted from events but we have a function hint, create one
  if (!attemptedOperation && attemptedFunction) {
    attemptedOperation = {
      operation: attemptedFunction,
      arguments: {},
      failedAt: `${attemptedFunction} execution`,
      trapReason: matchedMessage ?? 'The contract rejected the invocation during simulation.',
    };
  }

  // Step 4: Build resolution guidance
  let resolution = matchedResolution;
  if (!resolution) {
    if (attemptedOperation) {
      resolution = `The "${attemptedOperation.operation}" invocation failed during simulation. Review the parameters and try again.`;
    } else {
      resolution =
        'Check your wallet balance, network connection, and transaction parameters. Retrying often resolves transient simulation errors.';
    }
  }

  // Step 5: Build the final message
  let message = matchedMessage;
  if (!message) {
    // Try to extract XDR blobs from the error message itself
    const xdrBlobMatch = errorMessage.match(/[A-Za-z0-9+/]{20,}={0,2}/g);
    if (xdrBlobMatch) {
      for (const blob of xdrBlobMatch) {
        const decoded = decodeXdrBlob(blob);
        if (decoded) {
          message = decoded;
          break;
        }
      }
    }
    if (!message) {
      message = errorMessage || 'An unknown error occurred during transaction simulation.';
    }
  }

  // Collect raw XDR blobs from the error message for debugging
  const rawXdrBlobs: string[] = [];
  const blobMatches = errorMessage.match(/[A-Za-z0-9+/]{40,}={0,2}/g);
  if (blobMatches) {
    rawXdrBlobs.push(...blobMatches.filter((b) => decodeXdrBlob(b) !== null));
  }

  return {
    message,
    rawError: errorMessage,
    diagnosticEvents: decodedEvents,
    attemptedOperation,
    resolution,
    rawXdrBlobs,
  };
}

/**
 * Determine if an error object is likely to contain decodable Soroban XDR.
 * This is a lightweight check — we look for base64-like blobs in the error.
 */
export function isSorobanXdrError(error: unknown): boolean {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  // Base64 patterns are long alphanumeric strings with optional padding
  return /[A-Za-z0-9+/]{40,}={0,2}/.test(message);
}
