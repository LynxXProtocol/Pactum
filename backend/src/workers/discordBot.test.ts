import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDiscordEmbed,
  buildSlackPayload,
  determineEventType,
  EventType,
  formatAddress,
  formatAmount,
  formatDate,
} from '../services/botNotificationService';
import { PactumBotWorker } from './discordBot';

const SAMPLE_ISSUER = 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
const SAMPLE_COUNTERPARTY = 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U';

test('formatAddress shortens long Stellar addresses correctly', () => {
  assert.equal(formatAddress(SAMPLE_ISSUER), 'GCFIRY...YOJR');
  assert.equal(formatAddress('GSHORT'), 'GSHORT');
  assert.equal(formatAddress(null), 'N/A');
  assert.equal(formatAddress(undefined), 'N/A');
});

test('formatAmount formats amounts and currencies correctly', () => {
  assert.equal(formatAmount(100, 'XLM'), '100.00 XLM');
  assert.equal(formatAmount('50.5', 'USDC'), '50.50 USDC');
  assert.equal(formatAmount(null), 'N/A');
  assert.equal(formatAmount('invalid'), 'N/A');
});

test('formatDate converts valid dates to UTC string', () => {
  const d = new Date('2026-08-28T12:00:00.000Z');
  assert.equal(formatDate(d), d.toUTCString());
  assert.equal(formatDate('2026-08-28T12:00:00.000Z'), d.toUTCString());
  assert.equal(formatDate(null), 'N/A');
  assert.equal(formatDate('invalid-date'), 'N/A');
});

test('determineEventType correctly classifies event types', () => {
  assert.equal(
    determineEventType({
      commitmentId: '1',
      partyA: SAMPLE_ISSUER,
      status: 'pending',
    }),
    EventType.CREATED,
  );

  assert.equal(
    determineEventType({
      commitmentId: '2',
      partyA: SAMPLE_ISSUER,
      status: 'disputed',
    }),
    EventType.DISPUTED,
  );

  assert.equal(
    determineEventType({
      commitmentId: '3',
      partyA: SAMPLE_ISSUER,
      status: 'completed',
      outcome: 'fulfilled',
    }),
    EventType.FULFILLED,
  );

  assert.equal(
    determineEventType({
      commitmentId: '4',
      partyA: SAMPLE_ISSUER,
      status: 'completed',
      outcome: 'late',
    }),
    EventType.LATE,
  );

  assert.equal(
    determineEventType({
      commitmentId: '5',
      partyA: SAMPLE_ISSUER,
      status: 'active',
      outcome: 'breached',
    }),
    EventType.BREACHED,
  );
});

test('buildDiscordEmbed generates rich embed for CREATED event', () => {
  const embed = buildDiscordEmbed({
    commitmentId: '101',
    partyA: SAMPLE_ISSUER,
    partyB: SAMPLE_COUNTERPARTY,
    amount: 250,
    currency: 'XLM',
    status: 'pending',
    template: 'RefundDeposit',
    dueDate: '2026-09-01T00:00:00.000Z',
  });

  const json = embed.toJSON();
  assert.equal(json.title, '📋 New Commitment Created • #101');
  assert.equal(json.color, 0x3498db);
  assert.ok(
    json.fields?.some((f) => f.name === 'Issuer (Party A)' && f.value.includes('GCFIRY...YOJR')),
  );
  assert.ok(
    json.fields?.some(
      (f) => f.name === 'Counterparty (Party B)' && f.value.includes('GCATS5...I55U'),
    ),
  );
  assert.ok(json.fields?.some((f) => f.name === 'Amount' && f.value === '250.00 XLM'));
  assert.ok(json.fields?.some((f) => f.name === 'Template' && f.value === 'RefundDeposit'));
});

test('buildDiscordEmbed generates rich embed for FULFILLED event', () => {
  const embed = buildDiscordEmbed({
    commitmentId: '102',
    partyA: SAMPLE_ISSUER,
    partyB: SAMPLE_COUNTERPARTY,
    amount: 500,
    currency: 'USDC',
    status: 'completed',
    outcome: 'fulfilled',
    completedAt: '2026-08-28T10:00:00.000Z',
  });

  const json = embed.toJSON();
  assert.equal(json.title, '✅ Commitment #102 FULFILLED');
  assert.equal(json.color, 0x2ecc71);
  assert.ok(
    json.fields?.some((f) => f.name === 'Outcome' && f.value.includes('Fulfilled (On Time)')),
  );
});

test('buildDiscordEmbed generates rich embed for DISPUTED event', () => {
  const embed = buildDiscordEmbed({
    commitmentId: '104',
    partyA: SAMPLE_ISSUER,
    partyB: SAMPLE_COUNTERPARTY,
    status: 'disputed',
    outcome: 'disputed',
  });

  const json = embed.toJSON();
  assert.equal(json.title, '⚠️ Commitment #104 has been DISPUTED');
  assert.equal(json.color, 0xe74c3c);
  assert.ok(json.fields?.some((f) => f.name === 'Status' && f.value.includes('DISPUTED')));
});

test('buildDiscordEmbed generates rich embed for LATE and BREACHED events', () => {
  const lateEmbed = buildDiscordEmbed({
    commitmentId: '105',
    partyA: SAMPLE_ISSUER,
    status: 'completed',
    outcome: 'late',
  }).toJSON();
  assert.equal(lateEmbed.title, '⏰ Commitment #105 Fulfilled LATE');
  assert.equal(lateEmbed.color, 0xf1c40f);

  const breachedEmbed = buildDiscordEmbed({
    commitmentId: '106',
    partyA: SAMPLE_ISSUER,
    status: 'active',
    outcome: 'breached',
  }).toJSON();
  assert.equal(breachedEmbed.title, '❌ Commitment #106 BREACHED');
  assert.equal(breachedEmbed.color, 0x992d22);
});

test('buildSlackPayload constructs valid Block Kit structure', () => {
  const payload = buildSlackPayload({
    commitmentId: '104',
    partyA: SAMPLE_ISSUER,
    partyB: SAMPLE_COUNTERPARTY,
    amount: 150,
    currency: 'XLM',
    status: 'disputed',
    outcome: 'disputed',
    template: 'SLAGuarantee',
  });

  assert.ok(payload.text.includes('Commitment #104 has been DISPUTED'));
  assert.ok(Array.isArray(payload.blocks));
  assert.equal(payload.blocks[0].type, 'header');
  assert.equal(payload.blocks[0].text.text, '⚠️ Commitment #104 has been DISPUTED');
  assert.equal(payload.blocks[1].type, 'section');
  assert.equal(payload.blocks[2].type, 'section');
  assert.ok(Array.isArray(payload.blocks[2].fields));
  assert.equal(payload.blocks[3].type, 'context');
});

test('PactumBotWorker polls database and processes events without duplicate broadcasts', async () => {
  const mockRows = [
    {
      time: new Date().toISOString(),
      commitmentId: '201',
      partyA: SAMPLE_ISSUER,
      partyB: SAMPLE_COUNTERPARTY,
      amount: 1000,
      currency: 'XLM',
      status: 'completed',
      outcome: 'fulfilled',
      dueDate: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
  ];

  const mockPool = {
    query: async (queryText: string) => {
      if (queryText.includes('commitment_outcomes')) {
        return { rows: mockRows };
      }
      return { rows: [] };
    },
  } as any;

  let broadcastCount = 0;
  const worker = new PactumBotWorker({
    pool: mockPool,
    pollIntervalMs: 1000,
    startTime: new Date(Date.now() - 10000),
  });

  // Mock broadcast method
  worker.broadcastNotification = async () => {
    broadcastCount++;
  };

  // First poll should process 1 event
  const firstCount = await worker.pollDatabase();
  assert.equal(firstCount, 1);
  assert.equal(broadcastCount, 1);

  // Second poll with same records in DB should not broadcast again (deduplication)
  const secondCount = await worker.pollDatabase();
  assert.equal(secondCount, 0);
  assert.equal(broadcastCount, 1);

  await worker.stop();
});
