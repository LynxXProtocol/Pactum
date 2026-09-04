/**
 * migration-validator.ts — Validates migration filename prefix uniqueness (Pactum #232).
 */

export interface MigrationValidationResult {
  valid: boolean;
  errors: string[];
  prefixMap: Map<string, string[]>;
  duplicates: Map<string, string[]>;
}

/**
 * Validates a list of migration filenames, ensuring all .sql files start with a
 * three-digit zero-padded numeric prefix and that no two files share the same prefix.
 */
export function validateMigrationPrefixList(files: string[]): MigrationValidationResult {
  const errors: string[] = [];
  const prefixMap = new Map<string, string[]>();
  const duplicates = new Map<string, string[]>();

  const sqlFiles = files.filter((f) => f.endsWith('.sql'));

  for (const file of sqlFiles) {
    const match = file.match(/^(\d{3})_/);
    if (!match) {
      errors.push(
        `Invalid migration filename format: '${file}'. Must start with a 3-digit zero-padded numeric prefix (e.g. 001_name.sql).`,
      );
      continue;
    }

    const prefix = match[1];
    const existing = prefixMap.get(prefix) || [];
    existing.push(file);
    prefixMap.set(prefix, existing);

    if (existing.length > 1) {
      duplicates.set(prefix, existing);
    }
  }

  for (const [prefix, colliding] of duplicates.entries()) {
    errors.push(`Duplicate migration prefix '${prefix}' shared by: ${colliding.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    prefixMap,
    duplicates,
  };
}
