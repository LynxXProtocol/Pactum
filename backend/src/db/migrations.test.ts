import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { calculateMigrationChecksum } from './timescale';
import { validateMigrationPrefixList } from './migration-validator';

describe('Immutable Database Migration Tooling (Pactum #125)', () => {
  it('should compute consistent SHA-256 checksums for migration SQL files', () => {
    const sql1 = 'CREATE TABLE test_table (id SERIAL PRIMARY KEY, name VARCHAR(255));';
    const sql2 = 'CREATE TABLE test_table (id SERIAL PRIMARY KEY, name VARCHAR(255));';
    const sql3 = 'CREATE TABLE test_table (id SERIAL PRIMARY KEY, name VARCHAR(100));';

    const hash1 = calculateMigrationChecksum(sql1);
    const hash2 = calculateMigrationChecksum(sql2);
    const hash3 = calculateMigrationChecksum(sql3);

    assert.equal(hash1, hash2);
    assert.notEqual(hash1, hash3);
    assert.equal(hash1.length, 64);
  });

  it('should ignore outer whitespace differences during checksum calculation', () => {
    const rawSql = 'CREATE TABLE users (id INT);';
    const paddedSql = '  \n CREATE TABLE users (id INT);\n\t ';

    assert.equal(calculateMigrationChecksum(rawSql), calculateMigrationChecksum(paddedSql));
  });
});

describe('Migration Prefix Collision Guard (Pactum #232)', () => {
  it('should verify that all live migrations in migrations/ have unique sequential prefixes', () => {
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir).filter((f: string) => f.endsWith('.sql'));

    const result = validateMigrationPrefixList(files);
    assert.equal(
      result.valid,
      true,
      `Live migrations contain collisions or invalid format: ${result.errors.join('; ')}`,
    );
    assert.equal(result.duplicates.size, 0);
    assert.ok(files.length >= 11, `Expected at least 11 migrations, found ${files.length}`);
  });

  it('should detect duplicate numeric prefixes across multiple migration files', () => {
    const collidingList = [
      '001_initial.sql',
      '002_users.sql',
      '005_commitment_index.sql',
      '005_he_reputation.sql',
      '006_encrypted.sql',
    ];

    const result = validateMigrationPrefixList(collidingList);
    assert.equal(result.valid, false);
    assert.equal(result.duplicates.has('005'), true);
    assert.equal(result.duplicates.get('005')?.length, 2);
    assert.ok(
      result.errors.some((err: string) => err.includes("Duplicate migration prefix '005'")),
    );
  });

  it('should reject migrations lacking valid 3-digit numeric prefix', () => {
    const invalidList = ['001_initial.sql', 'bad_migration_name.sql', '42_two_digits.sql'];

    const result = validateMigrationPrefixList(invalidList);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((err: string) => err.includes('bad_migration_name.sql')));
    assert.ok(result.errors.some((err: string) => err.includes('42_two_digits.sql')));
  });

  it('should pass cleanly for strictly unique prefixes', () => {
    const validList = ['001_a.sql', '002_b.sql', '003_c.sql', '004_d.sql'];

    const result = validateMigrationPrefixList(validList);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.duplicates.size, 0);
  });
});
