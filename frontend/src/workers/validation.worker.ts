import initWasm, {
  evaluate_ast_binary,
  validate_commitment_params,
} from '../wasm/pactum-validation/pactum_validation.js';
import wasmUrl from '../wasm/pactum-validation/pactum_validation_bg.wasm?url';

export interface ValidationRequest {
  type?: 'VALIDATE_COMMITMENT';
  id: string;
  dueAt: number;
  currentTime: number;
  milestoneCount: number;
}

export interface AstValidationRequest {
  type: 'EVALUATE_AST';
  id: string;
  ruleSetBinary: Uint8Array;
  values: Record<string, unknown>;
  now: number;
  gasLimit?: number;
  recordSteps?: boolean;
}

export type WorkerRequest = ValidationRequest | AstValidationRequest;

export interface ValidationResponse {
  id: string;
  isValid: boolean;
  error?: string;
  trace?: unknown;
}

let wasmInitialized = false;
let initPromise: Promise<void> | null = null;

async function ensureWasmInitialized(): Promise<void> {
  if (wasmInitialized) return;
  if (!initPromise) {
    initPromise = initWasm(wasmUrl)
      .then(() => {
        wasmInitialized = true;
      })
      .catch((err) => {
        initPromise = null;
        throw err;
      });
  }
  await initPromise;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  console.log('[DEBUG] Worker received:', req);
  try {
    await ensureWasmInitialized();
    console.log('[DEBUG] WASM initialized');

    if (req.type === 'EVALUATE_AST') {
      const { id, ruleSetBinary, values, now, gasLimit, recordSteps } = req;
      const contextJson = JSON.stringify({ values, now });
      const trace = evaluate_ast_binary(
        ruleSetBinary,
        contextJson,
        gasLimit ?? 100_000,
        recordSteps ?? false,
      ) as { valid?: boolean };
      const response: ValidationResponse = {
        id,
        isValid: trace?.valid === true,
        trace,
      };
      self.postMessage(response);
    } else {
      const { id, dueAt, currentTime, milestoneCount } = req;
      console.log('[DEBUG] Calling validate_commitment_params');
      validate_commitment_params(BigInt(dueAt), BigInt(currentTime), milestoneCount);
      const response: ValidationResponse = { id, isValid: true };
      console.log('[DEBUG] Worker success:', response);
      self.postMessage(response);
    }
  } catch (err: any) {
    console.log('[DEBUG] Worker error:', err);
    const errorMsg = typeof err === 'string' ? err : err?.message || 'WASM validation failed.';
    const response: ValidationResponse = { id: req.id, isValid: false, error: errorMsg };
    self.postMessage(response);
  }
};
