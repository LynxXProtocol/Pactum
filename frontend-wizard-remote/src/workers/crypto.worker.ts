/// <reference lib="webworker" />

export interface CryptoWorkerRequest {
  id: string;
  type: "sha256" | "sha256Batch";
  payload: string | string[];
}

export interface CryptoWorkerResponse {
  id: string;
  success: boolean;
  result?: string | string[];
  error?: string;
  executionTimeMs?: number;
}

export async function computeSha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Self message handler for Web Worker execution
if (typeof self !== "undefined" && typeof (self as any).postMessage === "function") {
  self.onmessage = async (event: MessageEvent<CryptoWorkerRequest>) => {
    const { id, type, payload } = event.data;
    const start = performance.now();

    try {
      if (type === "sha256" && typeof payload === "string") {
        const hash = await computeSha256Hex(payload);
        const response: CryptoWorkerResponse = {
          id,
          success: true,
          result: hash,
          executionTimeMs: performance.now() - start,
        };
        self.postMessage(response);
      } else if (type === "sha256Batch" && Array.isArray(payload)) {
        const results = await Promise.all(payload.map((item) => computeSha256Hex(item)));
        const response: CryptoWorkerResponse = {
          id,
          success: true,
          result: results,
          executionTimeMs: performance.now() - start,
        };
        self.postMessage(response);
      } else {
        throw new Error(`Unsupported crypto worker request type: ${type}`);
      }
    } catch (err) {
      const response: CryptoWorkerResponse = {
        id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        executionTimeMs: performance.now() - start,
      };
      self.postMessage(response);
    }
  };
}
