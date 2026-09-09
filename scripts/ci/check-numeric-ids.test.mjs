import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  extractContractErrorEnums,
  validateContractErrors,
  validateMigrationPrefixes,
} from './check-numeric-ids.mjs';

describe('Numeric ID Collision Guard Tooling (Pactum #232)', () => {
  it('should verify all real repository contract errors have unique discriminants', () => {
    const result = validateContractErrors();
    assert.equal(
      result.valid,
      true,
      `Contract error collisions detected: ${result.errors.join('; ')}`,
    );
    assert.equal(result.errors.length, 0);
    assert.ok(result.totalEnums >= 3, `Expected >=3 enums, found ${result.totalEnums}`);
    assert.ok(result.totalVariants >= 70, `Expected >=70 variants, found ${result.totalVariants}`);
  });

  it('should verify all real repository migrations have unique prefixes', () => {
    const result = validateMigrationPrefixes();
    assert.equal(result.valid, true, `Migration collisions detected: ${result.errors.join('; ')}`);
    assert.equal(result.errors.length, 0);
    assert.ok(
      result.totalMigrations >= 11,
      `Expected >=11 migrations, found ${result.totalMigrations}`,
    );
    assert.equal(result.maxPrefix, 11);
  });

  it('should detect duplicate discriminant values in a contract error enum', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pactum-err-test-'));
    const testFile = path.join(tempDir, 'errors.rs');

    const syntheticRust = `
use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TestError {
    First = 1,
    Second = 2,
    CollidingSecond = 2,
    Third = 3,
}
`;
    fs.writeFileSync(testFile, syntheticRust, 'utf8');

    try {
      const enums = extractContractErrorEnums(testFile);
      assert.equal(enums.length, 1);
      assert.equal(enums[0].variants.length, 4);

      // Now run validateContractErrors targeting this temp directory
      const result = validateContractErrors(tempDir);
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((err) =>
          err.includes("Duplicate discriminant value 2 in enum 'TestError'"),
        ),
        'Expected collision error for discriminant 2',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should detect duplicate migration prefixes in a directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pactum-mig-test-'));

    try {
      fs.writeFileSync(path.join(tempDir, '001_initial.sql'), '-- test', 'utf8');
      fs.writeFileSync(path.join(tempDir, '002_users.sql'), '-- test', 'utf8');
      fs.writeFileSync(path.join(tempDir, '002_profiles.sql'), '-- test', 'utf8');

      const result = validateMigrationPrefixes(tempDir);
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((err) =>
          err.includes("Duplicate migration prefix '002' shared by 2 files"),
        ),
        'Expected collision error for prefix 002',
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
