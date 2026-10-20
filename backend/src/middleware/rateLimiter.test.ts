import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, RequestHandler, Response } from 'express';
import { createCommitmentLimiter } from './rateLimiter';

// Constructed to satisfy the limiter's Stellar address check (/^[GC][A-Z2-7]{55}$/)
// without depending on real checksums — the limiter only validates the shape.
// A distinct filler letter per test keeps each address in its own bucket, so the
// tests stay independent despite sharing the exported limiter's module-level store.
const address = (fill: string): string => `G${fill.repeat(55)}`;

const LIMIT = 10;

interface Invocation {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  nextCalled: boolean;
}

function invoke(
  handler: RequestHandler,
  { ip = '203.0.113.1', body }: { ip?: string; body?: unknown },
): Invocation {
  const result: Invocation = { statusCode: 200, headers: {}, body: undefined, nextCalled: false };

  const req = {
    headers: {},
    socket: { remoteAddress: ip },
    body,
  } as unknown as Request;

  const res = {
    set(field: string, value: string) {
      result.headers[field.toLowerCase()] = String(value);
      return this;
    },
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      result.body = payload;
      return this;
    },
  } as unknown as Response;

  handler(req, res, () => {
    result.nextCalled = true;
  });

  return result;
}

test('allows a Stellar address up to the per-hour limit', () => {
  const partyA = address('A');
  for (let i = 0; i < LIMIT; i += 1) {
    const res = invoke(createCommitmentLimiter, { body: { partyA } });
    assert.equal(res.nextCalled, true, `request ${i + 1} should pass`);
    assert.equal(res.statusCode, 200);
  }
});

test('blocks the request past the limit with 429 and a Retry-After header', () => {
  const partyA = address('B');
  for (let i = 0; i < LIMIT; i += 1) {
    invoke(createCommitmentLimiter, { body: { partyA } });
  }

  const blocked = invoke(createCommitmentLimiter, { body: { partyA } });

  assert.equal(blocked.nextCalled, false, 'over-limit request must not reach the handler');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['x-ratelimit-remaining'], '0');

  const retryAfter = Number(blocked.headers['retry-after']);
  assert.ok(
    Number.isInteger(retryAfter) && retryAfter > 0,
    'Retry-After must be a positive integer',
  );
  // The window is one hour; blocked immediately, a slot frees nearly an hour out.
  assert.ok(retryAfter <= 3600 && retryAfter > 3500, `unexpected Retry-After: ${retryAfter}`);
  assert.deepEqual(blocked.body, {
    error:
      'Too many commitments created for this address. A maximum of 10 per hour is allowed; please try again later.',
  });
});

test('limits each address independently', () => {
  const exhausted = address('C');
  const untouched = address('D');

  for (let i = 0; i < LIMIT; i += 1) {
    invoke(createCommitmentLimiter, { body: { partyA: exhausted } });
  }

  // `exhausted` is now over quota; `untouched` must be unaffected.
  assert.equal(invoke(createCommitmentLimiter, { body: { partyA: exhausted } }).statusCode, 429);

  const fresh = invoke(createCommitmentLimiter, { body: { partyA: untouched } });
  assert.equal(fresh.nextCalled, true);
  assert.equal(fresh.statusCode, 200);
});

test('falls back to per-IP limiting when no valid address is present', () => {
  const ip = '198.51.100.7';

  // A body with no partyA (unauthenticated probing) is bucketed by IP.
  for (let i = 0; i < LIMIT; i += 1) {
    const res = invoke(createCommitmentLimiter, { ip, body: {} });
    assert.equal(res.nextCalled, true, `probe ${i + 1} should pass`);
  }

  // A malformed partyA also falls back to the same IP bucket, which is now full.
  const blocked = invoke(createCommitmentLimiter, { ip, body: { partyA: 'not-an-address' } });
  assert.equal(blocked.statusCode, 429, 'the IP bucket should be exhausted regardless of body');

  // A different IP shares neither bucket.
  const otherIp = invoke(createCommitmentLimiter, { ip: '198.51.100.8', body: {} });
  assert.equal(otherIp.nextCalled, true);
});

test('re-admits an address once its window elapses', () => {
  const partyA = address('E');
  const realNow = Date.now;
  let clock = realNow();

  try {
    globalThis.Date.now = () => clock;

    for (let i = 0; i < LIMIT; i += 1) {
      invoke(createCommitmentLimiter, { body: { partyA } });
    }
    assert.equal(invoke(createCommitmentLimiter, { body: { partyA } }).statusCode, 429);

    // Advance past the one-hour window: the address should be admitted again.
    clock += 60 * 60 * 1000 + 1000;
    const afterWindow = invoke(createCommitmentLimiter, { body: { partyA } });
    assert.equal(afterWindow.nextCalled, true);
    assert.equal(afterWindow.statusCode, 200);
  } finally {
    globalThis.Date.now = realNow;
  }
});
