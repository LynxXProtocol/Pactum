import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Options } from 'tsup';

/**
 * After the browser build succeeds, fail if any emitted bundle references a
 * forbidden Node.js builtin (fs/crypto) — those don't exist in browsers.
 *
 * This runs in-process rather than as a `node -e "..."` shell string: the
 * previous string form mangled its own regex escapes once the shell processed
 * it, so tsup crashed at parse time on every platform. The check logic is
 * unchanged.
 */
async function assertBrowserBundleHasNoNodeBuiltins(): Promise<void> {
  const forbidden = ['fs', 'crypto'];

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = join(dir, entry.name);
      return entry.isDirectory() ? walk(entryPath) : [entryPath];
    });

  const bundles = walk(join(process.cwd(), 'dist', 'browser')).filter((file) =>
    /\.(?:mjs|js)$/.test(file),
  );

  for (const file of bundles) {
    const bundle = readFileSync(file, 'utf8');
    for (const builtin of forbidden) {
      const patterns = [
        new RegExp(`(?:node:)?${builtin}`, 'u'),
        new RegExp(`require\\(['"](?:node:)?${builtin}['"]\\)`, 'u'),
        new RegExp(`from ['"](?:node:)?${builtin}['"]`, 'u'),
      ];
      if (patterns.some((pattern) => pattern.test(bundle))) {
        throw new Error(`Browser bundle ${file} contains forbidden Node.js builtin: ${builtin}`);
      }
    }
  }
}

const shared: Options = {
  entry: ['src/index.ts'],
  clean: false,
  dts: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
};

export default defineConfig([
  {
    ...shared,
    clean: true,
    platform: 'node',
    target: 'node20',
    format: ['cjs', 'esm'],
    outDir: 'dist',
    outExtension({ format }) {
      return { js: format === 'cjs' ? '.cjs' : '.mjs' };
    },
  },
  {
    ...shared,
    platform: 'browser',
    target: ['es2020'],
    format: ['esm'],
    outDir: 'dist/browser',
    onSuccess: assertBrowserBundleHasNoNodeBuiltins,
    outExtension() {
      return { js: '.mjs' };
    },
  },
]);
