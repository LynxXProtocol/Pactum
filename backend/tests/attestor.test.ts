import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { startIntegrationDatabase, stopIntegrationDatabase, IntegrationDatabase } from './setup';
import { computeReliability } from '../src/attestor/reliability';
import { PostgresAttestorRepository } from '../src/attestor/repository';
import pool from '../src/db/timescale';

describe('computeReliability (unit)', () => {
  it('returns all zeros when never assigned', () => {
    const r = computeReliability({ totalAssigned: 0, votesCast: 0, overturned: 0 });
    assert.equal(r.reliabilityScore, 0);
    assert.equal(r.uptimeRatio, 0);
    assert.equal(r.accuracyRatio, 0);
  });

  it('penalises an attestor who never votes', () => {
    // Assigned to 2 disputes, voted in 0 -> uptime 0, reliability 0.
    const r = computeReliability({ totalAssigned: 2, votesCast: 0, overturned: 0 });
    assert.equal(r.uptimeRatio, 0);
    assert.equal(r.successfulResolutionsRatio, 0);
    assert.equal(r.reliabilityScore, 0);
  });

  it('full marks when every vote aligned with the final outcome', () => {
    const r = computeReliability({ totalAssigned: 4, votesCast: 4, overturned: 0 });
    assert.equal(r.uptimeRatio, 1);
    assert.equal(r.accuracyRatio, 1);
    assert.equal(r.reliabilityScore, 1);
  });

  it('combines uptime and accuracy into the reliability score', () => {
    // Assigned 4, voted in 3 (uptime .75). Of 3 votes, 1 overturned (accuracy .667).
    // reliability = (3-1)/4 = 0.5
    const r = computeReliability({ totalAssigned: 4, votesCast: 3, overturned: 1 });
    assert.equal(r.uptimeRatio, 0.75);
    assert.equal(r.accuracyRatio, 2 / 3);
    assert.equal(r.reliabilityScore, 0.5);
  });

  it('applies the accuracy weight', () => {
    const r = computeReliability({ totalAssigned: 4, votesCast: 3, overturned: 1 }, 2);
    assert.equal(r.reliabilityScore, 1); // 0.5 * 2 clamped to 1
  });

  it('never returns values outside [0,1]', () => {
    const r = computeReliability({ totalAssigned: 1, votesCast: 0, overturned: 5 });
    assert.ok(r.reliabilityScore >= 0 && r.reliabilityScore <= 1);
  });
});

describe('Attestor repository (integration)', () => {
  let db: IntegrationDatabase;
  let repository: PostgresAttestorRepository;
  let originalQuery: any;

  const A = 'GBLDEY4S2X2WFTX6FYX4M4YZ276M2E4N5J5QO2E3B5Z5O5N5P5R5S';
  const B = 'GCLDEY4S2X2WFTX6FYX4M4YZ276M2E4N5J5QO2E3B5Z5O5N5P5R5T';
  const C = 'GDODEY4S2X2WFTX6FYX4M4YZ276M2E4N5J5QO2E3B5Z5O5N5P5R5U';

  before(async () => {
    db = await startIntegrationDatabase();
    originalQuery = pool.query;
    pool.query = db.pool.query.bind(db.pool);
    repository = new PostgresAttestorRepository(db.pool);
  });

  after(async () => {
    pool.query = originalQuery;
    await stopIntegrationDatabase(db);
  });

  it('projects assignments, votes and outcomes into a reliability score', async () => {
    await repository.insertAssignments('1', [A, B]);
    await repository.insertAssignments('2', [A, B]);
    await repository.insertAttestorVote({ commitmentId: '1', attestor: A, outcome: 'fulfilled', ledgerSequence: 10 });
    await repository.insertAttestorVote({ commitmentId: '2', attestor: A, outcome: 'breached', ledgerSequence: 11 });
    // A voted fulfilled on #1, but #1 resolved to breached => A overturned once.
    await repository.insertDisputeOutcome({ commitmentId: '1', finalOutcome: 'breached', resolutionType: 'voteres' });
    await repository.insertDisputeOutcome({ commitmentId: '2', finalOutcome: 'breached', resolutionType: 'voteres' });

    const rel = await repository.getReliability(A);
    assert.ok(rel, 'reliability row should exist for A');
    assert.equal(rel!.totalAssigned, 2);
    assert.equal(rel!.votesCast, 2);
    assert.equal(rel!.overturned, 1);
    // reliability = (2-1)/2 = 0.5
    assert.equal(rel!.reliabilityScore, 0.5);
    assert.equal(rel!.uptimeRatio, 1);
    assert.equal(rel!.accuracyRatio, 0.5);
  });

  it('ranks available attestors by reliability within fee/domain filters', async () => {
    // Make A available with fee 10 and domain "defi".
    await repository.upsertRegistryStake(A, '1000');
    await repository.registerAttestor({ attestor: A, fee: 10, domains: ['defi'], active: true });

    // B available, higher fee, lower reliability.
    await repository.insertAssignments('3', [B]);
    await repository.insertAttestorVote({ commitmentId: '3', attestor: B, outcome: 'fulfilled', ledgerSequence: 12 });
    await repository.insertDisputeOutcome({ commitmentId: '3', finalOutcome: 'fulfilled', resolutionType: 'voteres' });
    await repository.upsertRegistryStake(B, '1000');
    await repository.registerAttestor({ attestor: B, fee: 50, domains: ['defi'], active: true });

    // C inactive -> excluded from discovery.
    await repository.upsertRegistryStake(C, '1000');
    await repository.registerAttestor({ attestor: C, fee: 1, domains: ['defi'], active: false });

    const defi = await repository.discoverAttestors({ domain: 'defi' });
    const addresses = defi.map((d) => d.attestor);
    assert.ok(addresses.includes(A));
    assert.ok(addresses.includes(B));
    assert.ok(!addresses.includes(C), 'inactive attestor must be excluded');

    // A (score 0.5) should outrank B (score 1.0?) -- recompute: B voted once, matched => 1.0,
    // so B outranks A. Assert ordering by reliability desc.
    assert.equal(defi[0].attestor, B);
    assert.equal(defi[0].reliabilityScore, 1);

    // Fee filter excludes B (fee 50), leaving only A.
    const cheap = await repository.discoverAttestors({ domain: 'defi', maxFee: 20 });
    assert.deepEqual(cheap.map((d) => d.attestor), [A]);
  });
});
