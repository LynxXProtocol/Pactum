import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { rpc } from '@stellar/stellar-sdk';
import {
  RetryableRpcError,
  RpcPoolExhaustedError,
  SorobanRpcPool,
  isRetryableError,
  type SorobanRpcNodeStats,
} from './sorobanRpcPool';
import { resolveSorobanRpcUrls, getOrCreatePool } from './soroban';

// ── Fake rpc.Server helpers ──────────────────────────────────────────────

interface FakeServer {
  calls: number;
  callOrder: string[];
  getHealth?: () => Promise<unknown>;
  getLatestLedger?: () => Promise<unknown>;
  sendTransaction?: () => Promise<unknown>;
}

function makeFakeServer(
  url: string,
  callOrder: string[],
  behavior: {
    getHealth?: () => Promise<unknown>;
    getLatestLedger?: () => Promise<unknown>;
    sendTransaction?: () => Promise<unknown>;
  },
): FakeServer {
  const server: FakeServer = { calls: 0, callOrder, ...behavior };
  const originalGetHealth = server.getHealth?.bind(server);
  if (originalGetHealth) {
    server.getHealth = async () => {
      server.calls += 1;
      server.callOrder.push(url);
      return originalGetHealth();
    };
  }
  const originalSend = server.sendTransaction?.bind(server);
  if (originalSend) {
    server.sendTransaction = async () => {
      server.calls += 1;
      server.callOrder.push(url);
      return originalSend();
    };
  }
  const originalLedger = server.getLatestLedger?.bind(server);
  if (originalLedger) {
    server.getLatestLedger = async () => {
      server.calls += 1;
      server.callOrder.push(url);
      return originalLedger();
    };
  }
  return server;
}

function httpError(status: number, message = 'Request failed with status code ' + status): Error {
  return Object.assign(new Error(message), { response: { status, data: {} } });
}

function healthy(): { status: 'healthy' } {
  return { status: 'healthy' };
}

function makePool(
  fakes: Record<string, FakeServer>,
  options: ConstructorParameters<typeof SorobanRpcPool>[1] = {},
): SorobanRpcPool {
  return new SorobanRpcPool(Object.keys(fakes), {
    ...options,
    serverFactory: (url) => fakes[url] as unknown as rpc.Server,
  });
}

// ── isRetryableError classification ──────────────────────────────────────

describe('isRetryableError', () => {
  it('treats HTTP 429 as retryable', () => {
    expect(isRetryableError(httpError(429))).toBe(true);
  });

  it('treats HTTP 5xx as retryable', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isRetryableError(httpError(status))).toBe(true);
    }
  });

  it('treats other HTTP 4xx as non-retryable', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableError(httpError(status))).toBe(false);
    }
  });

  it('treats JSON-RPC server errors as retryable', () => {
    expect(isRetryableError({ code: -32000, message: 'internal error' })).toBe(true);
    expect(isRetryableError({ code: -32005, message: 'limit exceeded' })).toBe(true);
    expect(isRetryableError({ code: -32603, message: 'internal error' })).toBe(true);
  });

  it('treats JSON-RPC request errors as non-retryable', () => {
    expect(isRetryableError({ code: -32602, message: 'invalid params' })).toBe(false);
    expect(isRetryableError({ code: -32601, message: 'method not found' })).toBe(false);
  });

  it('treats network-level failures as retryable', () => {
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableError(new Error('network error'))).toBe(true);
    expect(isRetryableError(new Error('connect ECONNREFUSED 127.0.0.1:8000'))).toBe(true);
    expect(isRetryableError(new Error('timeout of 15000ms exceeded'))).toBe(true);
  });

  it('treats plain application errors as non-retryable', () => {
    expect(isRetryableError(new Error('Simulation failed: Error(Contract, #1)'))).toBe(false);
    expect(isRetryableError('boom')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError(42)).toBe(false);
  });

  it('treats RetryableRpcError as retryable', () => {
    expect(isRetryableError(new RetryableRpcError('overloaded'))).toBe(true);
  });
});

// ── Pool rotation & fallback ─────────────────────────────────────────────

describe('SorobanRpcPool', () => {
  let callOrder: string[];

  beforeEach(() => {
    callOrder = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects an empty endpoint list', () => {
    expect(() => new SorobanRpcPool([])).toThrow(/at least one/);
  });

  it('returns the result from the healthiest node on the first attempt', async () => {
    const fakes = {
      a: makeFakeServer('a', callOrder, { getHealth: () => Promise.resolve(healthy()) }),
    };
    const pool = makePool(fakes);
    await expect(pool.getHealth()).resolves.toEqual({ status: 'healthy' });
    expect(callOrder).toEqual(['a']);
    const stats = pool.getStats();
    expect(stats[0].totalSuccesses).toBe(1);
    expect(stats[0].totalFailures).toBe(0);
  });

  it('rotates to the next node when the primary returns 429', async () => {
    const fakes = {
      a: makeFakeServer('a', callOrder, {
        getHealth: () => Promise.reject(httpError(429)),
      }),
      b: makeFakeServer('b', callOrder, { getHealth: () => Promise.resolve(healthy()) }),
    };
    const pool = makePool(fakes);
    await expect(pool.getHealth()).resolves.toEqual({ status: 'healthy' });
    expect(callOrder).toEqual(['a', 'b']);

    const stats = pool.getStats();
    const a = stats.find((s) => s.url === 'a')!;
    const b = stats.find((s) => s.url === 'b')!;
    expect(a.totalFailures).toBe(1);
    expect(a.score).toBeLessThan(100);
    expect(b.totalSuccesses).toBe(1);
    expect(pool.preferredUrl).toBe('b');
  });

  it('rotates to the next node when the primary returns a 5xx server error', async () => {
    const fakes = {
      a: makeFakeServer('a', callOrder, { getHealth: () => Promise.reject(httpError(503)) }),
      b: makeFakeServer('b', callOrder, { getHealth: () => Promise.resolve(healthy()) }),
    };
    const pool = makePool(fakes);
    await expect(pool.getHealth()).resolves.toEqual({ status: 'healthy' });
    expect(callOrder).toEqual(['a', 'b']);
  });

  it('rotates on raw network failures (no HTTP response)', async () => {
    const fakes = {
      a: makeFakeServer('a', callOrder, {
        getHealth: () => Promise.reject(new TypeError('fetch failed')),
      }),
      b: makeFakeServer('b', callOrder, { getHealth: () => Promise.resolve(healthy()) }),
    };
    const pool = makePool(fakes);
    await expect(pool.getHealth()).resolves.toEqual({ status: 'healthy' });
    expect(callOrder).toEqual(['a', 'b']);
  });

  it('does NOT rotate on non-retryable (application-level) errors', async () => {
    const fakes = {
      a: makeFakeServer('a', callOrder, {
        getHealth: () => Promise.reject(new Error('simulation failed')),
      }),
      b: makeFakeServer('b', callOrder, { getHealth: () => Promise.resolve(healthy()) }),
    };
    const pool = makePool(fakes);
    await expect(pool.getHealth()).rejects.toThrow('simulation failed');
    // Node b must never have been contacted.
    expect(callOrder).toEqual(['a']);
    expect(fakes.b.calls).toBe(0);
  });

  it('throws RpcPoolExhaustedError when every node fails with a retryable error', async () => {
    const fakes = {
      a: makeFakeServer('a', callOrder, { getHealth: () => Promise.reject(httpError(429)) }),
      b: makeFakeServer('b', callOrder, { getHealth: () => Promise.reject(httpError(500)) }),
    };
    const pool = makePool(fakes);
    const error = await pool.getHealth().catch((e) => e);
    expect(error).toBeInstanceOf(RpcPoolExhaustedError);
    expect(error.message).toContain('All 2 configured Soroban RPC node(s) failed');
    expect(error.nodeStats).toHaveLength(2);
    expect(error.lastError).toBeDefined();
    expect(callOrder).toEqual(['a', 'b']);
  });

  it('respects maxAttempts', async () => {
    const fakes = {
      a: makeFakeServer('a', callOrder, { getHealth: () => Promise.reject(httpError(429)) }),
      b: makeFakeServer('b', callOrder, { getHealth: () => Promise.reject(httpError(429)) }),
      c: makeFakeServer('c', callOrder, { getHealth: () => Promise.resolve(healthy()) }),
    };
    const pool = makePool(fakes, { maxAttempts: 2 });
    await expect(pool.getHealth()).rejects.toBeInstanceOf(RpcPoolExhaustedError);
    expect(callOrder).toEqual(['a', 'b']);
    expect(fakes.c.calls).toBe(0);
  });

  it('rotates on sendTransaction TRY_AGAIN_LATER', async () => {
    const pending = {
      status: 'PENDING',
      hash: '0xabc',
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    };
    const fakes = {
      a: makeFakeServer('a', callOrder, {
        sendTransaction: () =>
          Promise.resolve({
            status: 'TRY_AGAIN_LATER',
            hash: '0xabc',
            latestLedger: 1,
            latestLedgerCloseTime: 1,
          }),
      }),
      b: makeFakeServer('b', callOrder, { sendTransaction: () => Promise.resolve(pending) }),
    };
    const pool = makePool(fakes);
    await expect(pool.sendTransaction({} as never)).resolves.toEqual(pending);
    expect(callOrder).toEqual(['a', 'b']);
  });

  it('invokes onFallback with node info when rotating', async () => {
    const onFallback = vi.fn();
    const fakes = {
      a: makeFakeServer('a', callOrder, { getHealth: () => Promise.reject(httpError(429)) }),
      b: makeFakeServer('b', callOrder, { getHealth: () => Promise.resolve(healthy()) }),
      c: makeFakeServer('c', callOrder, { getHealth: () => Promise.resolve(healthy()) }),
    };
    const pool = makePool(fakes, { onFallback });
    await pool.getHealth();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith({
      url: 'a',
      error: expect.any(Error),
      attempt: 1,
      remaining: 2,
    });
  });

  it('routes subsequent traffic to the most performant node (health scoring + cooldown)', async () => {
    const fakes = {
      a: makeFakeServer('a', callOrder, { getHealth: () => Promise.reject(httpError(429)) }),
      b: makeFakeServer('b', callOrder, { getHealth: () => Promise.resolve(healthy()) }),
    };
    const pool = makePool(fakes, { cooldownMs: 30_000 });

    // First call: a fails (429), b succeeds → a is penalised and put in cooldown.
    await pool.getHealth();
    expect(pool.preferredUrl).toBe('b');
    const aStatsAfterFirst = pool.getStats().find((s) => s.url === 'a')!;
    expect(aStatsAfterFirst.cooldownUntil).toBeGreaterThan(Date.now());

    // Second call: a is cooling down, so b must be attempted first.
    await pool.getHealth();
    const attempts = callOrder.slice(2);
    expect(attempts[0]).toBe('b');
    expect(attempts).not.toContain('a');
  });

  it('recovers a node after it starts succeeding again', async () => {
    let aFails = true;
    let bFails = false;
    const fakes = {
      a: makeFakeServer('a', callOrder, {
        getHealth: () => (aFails ? Promise.reject(httpError(429)) : Promise.resolve(healthy())),
      }),
      b: makeFakeServer('b', callOrder, {
        getHealth: () => (bFails ? Promise.reject(httpError(500)) : Promise.resolve(healthy())),
      }),
    };
    const pool = makePool(fakes, { cooldownMs: 0 });

    // 1) a fails → penalised; b answers and becomes the preferred node.
    await pool.getHealth();
    let aStats = pool.getStats().find((s) => s.url === 'a')!;
    expect(aStats.score).toBe(75); // 100 - failurePenalty
    expect(pool.preferredUrl).toBe('b');

    // 2) b goes down → traffic shifts to a, which has recovered, and its
    //    health score climbs back up on success.
    aFails = false;
    bFails = true;
    await pool.getHealth();
    aStats = pool.getStats().find((s) => s.url === 'a')!;
    expect(aStats.totalSuccesses).toBe(1);
    expect(aStats.score).toBe(77); // 75 + successBonus
    expect(pool.preferredUrl).toBe('a');
  });

  it('getLatestLedger delegates through the pool', async () => {
    const ledger = { id: '0xdead', sequence: 12345 };
    const fakes = {
      a: makeFakeServer('a', callOrder, {
        getLatestLedger: () => Promise.resolve(ledger),
      }),
    };
    const pool = makePool(fakes);
    await expect(pool.getLatestLedger()).resolves.toEqual(ledger);
    expect(callOrder).toEqual(['a']);
  });

  it('exposes node stats via getStats and preferredUrl', async () => {
    const fakes = {
      a: makeFakeServer('a', callOrder, { getHealth: () => Promise.reject(httpError(429)) }),
      b: makeFakeServer('b', callOrder, { getHealth: () => Promise.resolve(healthy()) }),
    };
    const pool = makePool(fakes);
    await pool.getHealth();
    const stats: SorobanRpcNodeStats[] = pool.getStats();
    expect(stats).toHaveLength(2);
    // Ordered by preference: b first.
    expect(stats[0].url).toBe('b');
    expect(stats[0].totalSuccesses).toBe(1);
    expect(stats[1].url).toBe('a');
    expect(stats[1].totalFailures).toBe(1);
    expect(stats[1].lastError).toContain('status code 429');
  });

  it('checkHealth proactively probes all nodes without throwing', async () => {
    const fakes = {
      a: makeFakeServer('a', callOrder, { getHealth: () => Promise.reject(httpError(500)) }),
      b: makeFakeServer('b', callOrder, { getHealth: () => Promise.resolve(healthy()) }),
    };
    const pool = makePool(fakes);
    const stats = await pool.checkHealth();
    expect(stats.find((s) => s.url === 'a')!.totalFailures).toBe(1);
    expect(stats.find((s) => s.url === 'b')!.totalSuccesses).toBe(1);
  });
});

// ── resolveSorobanRpcUrls ────────────────────────────────────────────────

describe('resolveSorobanRpcUrls', () => {
  it('prefers an explicit rpcUrls array', () => {
    expect(resolveSorobanRpcUrls(['https://one.example', 'https://two.example'])).toEqual([
      'https://one.example',
      'https://two.example',
    ]);
  });

  it('falls back to the legacy single rpcUrl', () => {
    expect(resolveSorobanRpcUrls(undefined, 'https://single.example')).toEqual([
      'https://single.example',
    ]);
  });

  it('prefers rpcUrls over rpcUrl', () => {
    expect(resolveSorobanRpcUrls(['https://one.example'], 'https://single.example')).toEqual([
      'https://one.example',
    ]);
  });

  it('returns defaults when nothing is provided', () => {
    expect(resolveSorobanRpcUrls()).toEqual(['https://soroban-testnet.stellar.org']);
  });

  it('deduplicates and trims entries', () => {
    expect(
      resolveSorobanRpcUrls([
        ' https://one.example ',
        'https://one.example',
        'https://two.example',
      ]),
    ).toEqual(['https://one.example', 'https://two.example']);
  });
});

// ── Integration through the real SDK fetch client ────────────────────────

describe('SorobanRpcPool (SDK fetch-client integration)', () => {
  interface Route {
    url: string;
    status?: number;
    body?: unknown;
    networkError?: boolean;
  }

  let fetchedUrls: string[];

  function stubFetch(routes: Route[]): void {
    fetchedUrls = [];
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      fetchedUrls.push(url);
      const route = routes.find((r) => url.startsWith(r.url));
      if (!route) {
        return new Response(JSON.stringify({ error: 'no route' }), { status: 404 });
      }
      if (route.networkError) {
        throw new TypeError('fetch failed');
      }
      return new Response(JSON.stringify(route.body ?? { error: 'empty route' }), {
        status: route.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  const healthyRpc = (method: string): unknown => ({
    jsonrpc: '2.0',
    id: 1,
    result: method === 'getHealth' ? { status: 'healthy' } : null,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails over from a rate-limited node to a healthy node', async () => {
    stubFetch([
      { url: 'http://node-a', status: 429, body: { error: 'rate limited' } },
      { url: 'http://node-b', body: healthyRpc('getHealth') },
    ]);
    const pool = new SorobanRpcPool(['http://node-a', 'http://node-b'], {
      allowHttp: true,
      timeout: 5_000,
    });

    await expect(pool.getHealth()).resolves.toEqual({ status: 'healthy' });
    const stats = pool.getStats();
    expect(stats[0].url).toBe('http://node-b');
    expect(stats[0].totalSuccesses).toBe(1);
    expect(stats[1].totalFailures).toBe(1);
    expect(fetchedUrls[0]).toContain('node-a');
    expect(fetchedUrls[1]).toContain('node-b');
  });

  it('fails over from a 5xx node and a broken node to a healthy node', async () => {
    stubFetch([
      { url: 'http://node-a', networkError: true },
      { url: 'http://node-b', status: 500, body: { error: 'boom' } },
      { url: 'http://node-c', body: healthyRpc('getHealth') },
    ]);
    const pool = new SorobanRpcPool(['http://node-a', 'http://node-b', 'http://node-c'], {
      allowHttp: true,
      timeout: 5_000,
    });

    await expect(pool.getHealth()).resolves.toEqual({ status: 'healthy' });
    const stats = pool.getStats();
    expect(stats.find((s) => s.url === 'http://node-a')!.totalFailures).toBeGreaterThanOrEqual(1);
    expect(stats.find((s) => s.url === 'http://node-b')!.totalFailures).toBeGreaterThanOrEqual(1);
    expect(stats.find((s) => s.url === 'http://node-c')!.totalSuccesses).toBe(1);
  });

  it('surfaces the error when every node is broken', async () => {
    stubFetch([
      { url: 'http://node-a', status: 429, body: { error: 'rate limited' } },
      { url: 'http://node-b', status: 500, body: { error: 'boom' } },
    ]);
    const pool = new SorobanRpcPool(['http://node-a', 'http://node-b'], {
      allowHttp: true,
      timeout: 5_000,
    });

    await expect(pool.getHealth()).rejects.toBeInstanceOf(RpcPoolExhaustedError);
  });
});

// ── getOrCreatePool: cached pools + per-call status listeners ───────────

describe('getOrCreatePool (caching and status listeners)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(routes: Array<{ url: string; status: number; body?: unknown }>): void {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      const route = routes.find((r) => url.startsWith(r.url));
      if (!route) {
        return new Response(JSON.stringify({ error: 'no route' }), { status: 404 });
      }
      return new Response(JSON.stringify(route.body ?? { error: 'boom' }), {
        status: route.status,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  const healthyRpc = (): unknown => ({
    jsonrpc: '2.0',
    id: 1,
    result: { status: 'healthy' },
  });

  it('reuses the same pool instance for the same URL set', () => {
    const a = getOrCreatePool(['http://node-a', 'http://node-b']);
    const b = getOrCreatePool(['http://node-b', 'http://node-a']);
    expect(a).toBe(b);
  });

  it('invokes the per-call status listener when the pool fails over', async () => {
    stubFetch([
      { url: 'http://node-a', status: 429, body: { error: 'rate limited' } },
      { url: 'http://node-b', status: 200, body: healthyRpc() },
    ]);
    const onStatusUpdate = vi.fn();
    const pool = getOrCreatePool(['http://node-a', 'http://node-b'], onStatusUpdate);

    // node-a rate-limits, so the pool retries on node-b and notifies the listener.
    await expect(pool.getHealth()).resolves.toEqual({ status: 'healthy' });
    expect(onStatusUpdate).toHaveBeenCalled();
    expect(onStatusUpdate.mock.calls[0][0]).toMatch(/RPC node unavailable/);
  });
});
