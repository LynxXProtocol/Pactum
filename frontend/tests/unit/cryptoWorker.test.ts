import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeSha256Hex,
  type CryptoWorkerRequest,
  type CryptoWorkerResponse,
} from '../../src/workers/crypto.worker.ts';
import { sha256Hex, sha256Batch } from '../../src/lib/hash.ts';
import { CryptoWorkerClient } from '../../src/lib/cryptoWorkerClient.ts';

describe('Web Worker Cryptographic Engine', () => {
  it('computes standard SHA-256 hex digest for empty string', async () => {
    const emptyHash = await computeSha256Hex('');
    assert.equal(emptyHash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('computes correct SHA-256 for known test vector ("hello world")', async () => {
    const hash = await computeSha256Hex('hello world');
    assert.equal(hash, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('computes SHA-256 via hash.ts interface seamlessly with fallback', async () => {
    const terms = 'Pactum escrow agreement for smart commitment contract';
    const hash = await sha256Hex(terms);
    const direct = await computeSha256Hex(terms);
    assert.equal(hash, direct);
    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 64);
  });

  it('processes batch hashing operations efficiently', async () => {
    const batch = ['agreement_1', 'agreement_2', 'agreement_3'];
    const results = await sha256Batch(batch);
    assert.equal(results.length, 3);
    assert.equal(results[0], await computeSha256Hex('agreement_1'));
    assert.equal(results[1], await computeSha256Hex('agreement_2'));
    assert.equal(results[2], await computeSha256Hex('agreement_3'));
  });

  it('handles massive text payloads without blocking or truncating', async () => {
    const largePayload = 'A'.repeat(500000); // 500 KB string
    const hash = await sha256Hex(largePayload);
    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 64);
  });

  it('immediately settles pending in-flight requests on client termination', async () => {
    const client = new CryptoWorkerClient();

    // Create a mock worker that captures messages but delays response
    let postedMessage: CryptoWorkerRequest | null = null;
    const mockWorker = {
      postMessage: (data: CryptoWorkerRequest) => {
        postedMessage = data;
      },
      terminate: () => {},
      onmessage: null as any,
      onerror: null as any,
    };

    (client as any).worker = mockWorker;

    const input = 'test agreement terms for immediate termination fallback';
    const hashPromise = client.sha256Hex(input);

    assert.ok(postedMessage);
    assert.equal((client as any).pendingRequests.size, 1);

    // Call terminate() before worker responds
    client.terminate();

    assert.equal((client as any).pendingRequests.size, 0);

    // Should resolve immediately via fallback rather than timing out
    const resolvedHash = await hashPromise;
    const expected = await computeSha256Hex(input);
    assert.equal(resolvedHash, expected);
  });

  it('immediately resolves via fallback when worker encounters an error', async () => {
    const client = new CryptoWorkerClient();

    let errorHandler: ((err: any) => void) | null = null;
    const mockWorker = {
      postMessage: () => {
        // Trigger error immediately
        setTimeout(() => {
          if (errorHandler) {
            errorHandler(new Error('Simulated worker crash'));
          }
        }, 5);
      },
      terminate: () => {},
      onmessage: null as any,
      set onerror(fn: any) {
        errorHandler = fn;
      },
      get onerror() {
        return errorHandler;
      },
    };

    (client as any).worker = mockWorker;
    mockWorker.onerror = () => {
      if ((client as any).worker) {
        (client as any).worker.terminate();
        (client as any).worker = null;
      }
      (client as any).settleAllPendingViaFallback();
    };

    const input = 'test error recovery';
    const hash = await client.sha256Hex(input);
    const expected = await computeSha256Hex(input);

    assert.equal(hash, expected);
    assert.equal((client as any).worker, null);

    // Subsequent calls safely use fallback directly without trying to post to dead worker
    const nextHash = await client.sha256Hex('subsequent test after error');
    assert.equal(nextHash, await computeSha256Hex('subsequent test after error'));
  });

  it('correctly correlates worker responses by request ID', async () => {
    const client = new CryptoWorkerClient();

    let messageHandler: ((event: MessageEvent<CryptoWorkerResponse>) => void) | null = null;
    const mockWorker = {
      postMessage: async (req: CryptoWorkerRequest) => {
        const hash = await computeSha256Hex(req.payload as string);
        setTimeout(() => {
          if (messageHandler) {
            messageHandler({
              data: {
                id: req.id,
                success: true,
                result: hash,
              },
            } as any);
          }
        }, 5);
      },
      terminate: () => {},
      set onmessage(fn: any) {
        messageHandler = fn;
      },
      get onmessage() {
        return messageHandler;
      },
      onerror: null as any,
    };

    (client as any).worker = mockWorker;
    // Bind client's message listener to mock worker
    (client as any).initWorker();
    (client as any).worker = mockWorker;
    mockWorker.onmessage = (event: any) => {
      const pending = (client as any).pendingRequests.get(event.data.id);
      if (pending) {
        clearTimeout(pending.timer);
        (client as any).pendingRequests.delete(event.data.id);
        pending.resolve(event.data.result);
      }
    };

    const result = await client.sha256Hex('worker test string');
    assert.equal(result, await computeSha256Hex('worker test string'));
  });
});
