/**
 * Tests for GET /commitments/export/:address?format=csv|pdf
 * (Issue #209 — CSV and PDF Export for Commitment History)
 *
 * Uses Node's built-in `node:test` runner (consistent with the rest of the
 * backend test suite) and mocks the database pool so no live DB is required.
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ── Stub pool before importing the router ─────────────────────────────────
// The export router imports `pool` from '../db/timescale'. We replace the
// module with a controllable stub so tests never touch a real database.

const VALID_ADDRESS = 'GAJKUMA6V4MJKQPFM4MXNMWQZX3CTMK2KMMCSZQPK5JXBZWBZM7S4C';

// A minimal fake commitment row that matches CommitmentOutcomeRow
const FAKE_ROW = {
  time: new Date('2024-01-15T10:00:00Z'),
  id: '42',
  partyA: VALID_ADDRESS,
  partyB: 'GB4UFBX57KE2RPEXB4NCPQHXL5UZL7HSFBVQ2YEZQDZ2DXR2X3CHHZX',
  status: 'completed',
  outcome: 'fulfilled',
  dueDate: new Date('2024-01-10T00:00:00Z'),
  completedAt: new Date('2024-01-10T08:00:00Z'),
  createdAt: new Date('2024-01-01T00:00:00Z'),
};

// ── Inline helpers (no express-test / supertest dependency) ───────────────

function makeRequest(
  server: http.Server,
  path: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const options = { hostname: '127.0.0.1', port: addr.port, path, method: 'GET' };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Dynamically import the route after we've set up module mocks ──────────
// We use a local Express app rather than starting the whole index.ts to keep
// the test isolated and fast.

let server: http.Server;

before(async () => {
  // Mock pool module (must happen before importing the route)
  mock.module('../db/timescale', {
    namedExports: {},
    defaultExport: {
      query: async () => ({ rows: [FAKE_ROW] }),
    },
  });

  // Dynamically import *after* mocking
  const express = (await import('express')).default;
  const { default: exportRouter } = await import('./export.js');

  const app = express();
  app.use('/commitments/export', exportRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
});

after(() => {
  server?.close();
  mock.restoreAll();
});

describe('GET /commitments/export/:address', () => {
  describe('input validation', () => {
    it('rejects an invalid address with 400', async () => {
      const { status, body } = await makeRequest(server, '/commitments/export/not-a-stellar-key');
      assert.equal(status, 400);
      const json = JSON.parse(body.toString());
      assert.equal(json.error, 'Bad Request');
    });

    it('rejects an unsupported format with 400', async () => {
      const { status, body } = await makeRequest(
        server,
        `/commitments/export/${VALID_ADDRESS}?format=xlsx`,
      );
      assert.equal(status, 400);
      const json = JSON.parse(body.toString());
      assert.equal(json.error, 'Bad Request');
    });
  });

  describe('CSV export', () => {
    it('returns 200 with text/csv content-type', async () => {
      const { status, headers } = await makeRequest(
        server,
        `/commitments/export/${VALID_ADDRESS}?format=csv`,
      );
      assert.equal(status, 200);
      assert.ok(
        headers['content-type']?.includes('text/csv'),
        `expected text/csv, got ${headers['content-type']}`,
      );
    });

    it('sets Content-Disposition attachment with .csv extension', async () => {
      const { headers } = await makeRequest(
        server,
        `/commitments/export/${VALID_ADDRESS}?format=csv`,
      );
      const disposition = headers['content-disposition'] ?? '';
      assert.ok(disposition.includes('attachment'), 'should be an attachment');
      assert.ok(disposition.includes('.csv'), 'filename should end in .csv');
    });

    it('body contains CSV header row', async () => {
      const { body } = await makeRequest(
        server,
        `/commitments/export/${VALID_ADDRESS}?format=csv`,
      );
      const text = body.toString();
      assert.ok(text.includes('ID'), 'CSV should contain ID column header');
      assert.ok(text.includes('Issuer'), 'CSV should contain Issuer column header');
      assert.ok(text.includes('Status'), 'CSV should contain Status column header');
    });

    it('defaults to CSV when format param is omitted', async () => {
      const { status, headers } = await makeRequest(
        server,
        `/commitments/export/${VALID_ADDRESS}`,
      );
      assert.equal(status, 200);
      assert.ok(headers['content-type']?.includes('text/csv'));
    });
  });

  describe('PDF export', () => {
    it('returns 200 with application/pdf content-type', async () => {
      const { status, headers } = await makeRequest(
        server,
        `/commitments/export/${VALID_ADDRESS}?format=pdf`,
      );
      assert.equal(status, 200);
      assert.ok(
        headers['content-type']?.includes('application/pdf'),
        `expected application/pdf, got ${headers['content-type']}`,
      );
    });

    it('sets Content-Disposition attachment with .pdf extension', async () => {
      const { headers } = await makeRequest(
        server,
        `/commitments/export/${VALID_ADDRESS}?format=pdf`,
      );
      const disposition = headers['content-disposition'] ?? '';
      assert.ok(disposition.includes('attachment'));
      assert.ok(disposition.includes('.pdf'));
    });

    it('body starts with PDF magic bytes (%PDF)', async () => {
      const { body } = await makeRequest(
        server,
        `/commitments/export/${VALID_ADDRESS}?format=pdf`,
      );
      assert.ok(
        body.slice(0, 4).toString() === '%PDF',
        `body should start with %PDF, got: ${body.slice(0, 4).toString()}`,
      );
    });
  });
});
