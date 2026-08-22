import { cryptoWorkerClient } from './cryptoWorkerClient.ts';

/**
 * Computes the SHA-256 hex digest of the input string.
 * Offloads computation to a dedicated Web Worker to ensure 60fps main-thread responsiveness.
 */
export async function sha256Hex(input: string): Promise<string> {
  return cryptoWorkerClient.sha256Hex(input);
}

/**
 * Computes SHA-256 hex digests for a batch of strings via the Web Worker.
 */
export async function sha256Batch(inputs: string[]): Promise<string[]> {
  return cryptoWorkerClient.sha256Batch(inputs);
}
