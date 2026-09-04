#!/usr/bin/env node
/**
 * check-numeric-ids.mjs — CI guard against colliding numeric IDs.
 *
 * Enforces two invariant classes across the Pactum repository:
 * 1. Soroban contract error discriminants (#[contracterror] / #[repr(u32)])
 *    must have unique integer values within each enum.
 * 2. Database migration SQL files in backend/src/db/migrations/ must have
 *    unique, zero-padded 3-digit numeric prefixes (e.g. 001_, 002_, ...)
 *    to preserve strict, deterministic migration ordering.
 *
 * Resolves Pactum Issue #232.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Parses a Rust source file and finds all #[contracterror] or #[repr(u32)] enum discriminants.
 *
 * @param {string} filePath - Absolute path to .rs file
 * @returns {Array<{ enumName: string, filePath: string, variants: Array<{ name: string, value: number, line: number }> }>}
 */
export function extractContractErrorEnums(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const enums = [];

  let inContractError = false;
  let currentEnum = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNum = i + 1;
    // Strip single-line comments
    const code = rawLine.replace(/\/\/.*$/, '').trim();

    if (!code) continue;

    if (
      code.includes('#[contracterror]') ||
      code.includes('#[repr(u32)]') ||
      code.includes('#[repr(i32)]')
    ) {
      inContractError = true;
    }

    // Match enum declaration e.g. "pub enum Error {" or "enum RegistryError"
    const enumMatch = code.match(/(?:pub\s+)?enum\s+([A-Za-z0-9_]+)/);
    if (enumMatch && (inContractError || braceDepth === 0)) {
      currentEnum = {
        enumName: enumMatch[1],
        filePath,
        variants: [],
      };
      inContractError = false;
      if (code.includes('{')) {
        braceDepth += (code.match(/\{/g) || []).length;
        braceDepth -= (code.match(/\}/g) || []).length;
      }
      continue;
    }

    if (currentEnum) {
      const opens = (code.match(/\{/g) || []).length;
      const closes = (code.match(/\}/g) || []).length;
      braceDepth += opens;
      braceDepth -= closes;

      // Match variant with explicit discriminant e.g. "DueAtInPast = 1," or "Unauthorized = 2"
      const variantMatch = code.match(/^([A-Za-z0-9_]+)\s*=\s*(\d+)/);
      if (variantMatch) {
        currentEnum.variants.push({
          name: variantMatch[1],
          value: parseInt(variantMatch[2], 10),
          line: lineNum,
        });
      }

      if (braceDepth <= 0) {
        if (currentEnum.variants.length > 0) {
          enums.push(currentEnum);
        }
        currentEnum = null;
        braceDepth = 0;
      }
    }
  }

  return enums;
}

/**
 * Validates all contract error discriminants across the given contracts directory.
 *
 * @param {string} contractsDir - Directory containing Soroban contracts
 * @returns {{ valid: boolean, errors: string[], totalEnums: number, totalVariants: number }}
 */
export function validateContractErrors(contractsDir = path.join(REPO_ROOT, 'contracts')) {
  const errors = [];
  let totalEnums = 0;
  let totalVariants = 0;

  function walkRs(dir) {
    if (!fs.existsSync(dir)) return [];
    let results = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const full = path.join(dir, file);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (file !== 'target' && file !== '.git') {
          results = results.concat(walkRs(full));
        }
      } else if (file.endsWith('.rs')) {
        results.push(full);
      }
    }
    return results;
  }

  const rsFiles = walkRs(contractsDir);

  for (const file of rsFiles) {
    const fileEnums = extractContractErrorEnums(file);
    for (const e of fileEnums) {
      totalEnums++;
      totalVariants += e.variants.length;

      const seenValues = new Map();
      const seenNames = new Map();

      for (const variant of e.variants) {
        const relPath = path.relative(REPO_ROOT, e.filePath).replace(/\\/g, '/');

        // Check duplicate name
        if (seenNames.has(variant.name)) {
          const prev = seenNames.get(variant.name);
          errors.push(
            `Duplicate variant name '${variant.name}' in enum '${e.enumName}' (${relPath}:${variant.line} and ${relPath}:${prev.line})`,
          );
        } else {
          seenNames.set(variant.name, variant);
        }

        // Check duplicate discriminant value
        if (seenValues.has(variant.value)) {
          const prev = seenValues.get(variant.value);
          errors.push(
            `Duplicate discriminant value ${variant.value} in enum '${e.enumName}' (${relPath}): ` +
              `'${variant.name}' (line ${variant.line}) collides with '${prev.name}' (line ${prev.line})`,
          );
        } else {
          seenValues.set(variant.value, variant);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    totalEnums,
    totalVariants,
  };
}

/**
 * Validates that database migrations have unique, strictly sequential numeric prefixes.
 *
 * @param {string} migrationsDir - Directory containing migration .sql files
 * @returns {{ valid: boolean, errors: string[], totalMigrations: number, maxPrefix: number }}
 */
export function validateMigrationPrefixes(
  migrationsDir = path.join(REPO_ROOT, 'backend', 'src', 'db', 'migrations'),
) {
  const errors = [];
  if (!fs.existsSync(migrationsDir)) {
    return { valid: true, errors: [], totalMigrations: 0, maxPrefix: 0 };
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const prefixMap = new Map();
  let maxPrefix = 0;

  for (const file of files) {
    const match = file.match(/^(\d+)_/);
    if (!match) {
      errors.push(
        `Invalid migration filename format: '${file}'. Migration files must start with a numeric prefix (e.g. 001_name.sql).`,
      );
      continue;
    }

    const prefixStr = match[1];
    const prefixNum = parseInt(prefixStr, 10);
    maxPrefix = Math.max(maxPrefix, prefixNum);

    if (prefixMap.has(prefixStr)) {
      const existing = prefixMap.get(prefixStr);
      existing.push(file);
    } else {
      prefixMap.set(prefixStr, [file]);
    }
  }

  // Check collisions
  for (const [prefix, collidingFiles] of prefixMap.entries()) {
    if (collidingFiles.length > 1) {
      errors.push(
        `Duplicate migration prefix '${prefix}' shared by ${collidingFiles.length} files:\n` +
          collidingFiles.map((f) => `    - ${f}`).join('\n'),
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    totalMigrations: files.length,
    maxPrefix,
  };
}

/**
 * Main validation CLI entrypoint.
 */
export function run() {
  const args = process.argv.slice(2);
  const contractsOnly = args.includes('--contracts-only');
  const migrationsOnly = args.includes('--migrations-only');

  console.log('================================================================================');
  console.log('🔍 PACTUM NUMERIC ID COLLISION GUARD (Issue #232)');
  console.log('================================================================================');

  let hasFailures = false;

  if (!migrationsOnly) {
    const contractResult = validateContractErrors();
    if (!contractResult.valid) {
      hasFailures = true;
      console.error('\n❌ CONTRACT ERROR DISCRIMINANT COLLISIONS DETECTED:');
      for (const err of contractResult.errors) {
        console.error(`  • ${err}`);
      }
    } else {
      console.log(
        `\n✅ Contract errors: ${contractResult.totalEnums} enums with ${contractResult.totalVariants} variants verified. No collisions.`,
      );
    }
  }

  if (!contractsOnly) {
    const migrationResult = validateMigrationPrefixes();
    if (!migrationResult.valid) {
      hasFailures = true;
      console.error('\n❌ DATABASE MIGRATION PREFIX COLLISIONS DETECTED:');
      for (const err of migrationResult.errors) {
        console.error(`  • ${err}`);
      }
    } else {
      console.log(
        `\n✅ Database migrations: ${migrationResult.totalMigrations} migrations (max prefix ${String(migrationResult.maxPrefix).padStart(3, '0')}) verified. All prefixes unique.`,
      );
    }
  }

  console.log('\n================================================================================');
  if (hasFailures) {
    console.error(
      '💥 FAILED: Numeric ID collisions detected. Please resolve duplicates before merging.',
    );
    process.exit(1);
  } else {
    console.log('🎉 PASSED: All contract error discriminants and migration prefixes are unique.');
    process.exit(0);
  }
}

// Execute if run directly from CLI
if (
  process.argv[1] &&
  (process.argv[1] === __filename || process.argv[1].endsWith('check-numeric-ids.mjs'))
) {
  run();
}
