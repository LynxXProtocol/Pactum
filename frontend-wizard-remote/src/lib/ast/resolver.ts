/**
 * react-hook-form integration for the AST rules engine.
 *
 * `createAstResolver` turns a {@link CompiledRuleSet} into a react-hook-form
 * `Resolver`. `composeResolvers` runs several resolvers in sequence and merges
 * their errors, which lets the dynamic AST rules sit *on top of* the existing
 * static Zod schema instead of replacing it: Zod keeps enforcing structure
 * (required fields, address format), and governance-controlled AST rules add the
 * dynamic constraints. When two resolvers flag the same field, the earlier one
 * (Zod) wins, so a field's structural error is never masked by a dynamic one.
 */

import type { FieldValues, Resolver, ResolverResult } from 'react-hook-form';
import type { CompiledRuleSet, EvalContext } from './types';

/** A single react-hook-form field error object. */
interface FieldErrorLike {
  type: string;
  message: string;
}

const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/** Safely assign a (possibly dotted) field error into a nested errors object; first write wins. */
function setFieldError(
  errors: Record<string, unknown>,
  path: string,
  error: FieldErrorLike,
): void {
  const segments = path.split('.');
  let cursor = errors;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (RESERVED_SEGMENTS.has(segment)) return;
    const existing = cursor[segment];
    if (typeof existing !== 'object' || existing === null) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1];
  if (RESERVED_SEGMENTS.has(leaf)) return;
  if (!(leaf in cursor)) {
    cursor[leaf] = error;
  }
}

/** Options for {@link createAstResolver}. */
export interface AstResolverOptions {
  /** Clock used for `now()` in rules. Injectable for deterministic tests. */
  now?: () => number;
}

/**
 * Build a react-hook-form `Resolver` from a compiled rule set. Each rule that
 * fails contributes one error, attributed to its `field`. The first failing rule
 * per field wins (react-hook-form surfaces a single error per field).
 */
export function createAstResolver<TFieldValues extends FieldValues = FieldValues>(
  compiled: CompiledRuleSet,
  options: AstResolverOptions = {},
): Resolver<TFieldValues> {
  const clock = options.now ?? (() => Date.now());

  return (values) => {
    const ctx: EvalContext = {
      values: values as Record<string, unknown>,
      now: clock(),
    };

    const errors: Record<string, unknown> = {};
    const claimed = new Set<string>();

    for (const rule of compiled.rules) {
      if (claimed.has(rule.field)) continue;

      let passed: boolean;
      try {
        passed = rule.test(ctx);
      } catch {
        // The evaluator is designed to be total, but if a rule ever throws we
        // fail open (treat it as satisfied) so a single bad rule cannot brick
        // the entire form for every user.
        passed = true;
      }

      if (!passed) {
        setFieldError(errors, rule.field, { type: 'ast', message: rule.message });
        claimed.add(rule.field);
      }
    }

    const result =
      claimed.size > 0 ? { values: {}, errors } : { values, errors: {} };
    return result as ResolverResult<TFieldValues>;
  };
}

/**
 * Compose multiple resolvers into one. Resolvers run in order; errors are merged
 * by top-level field key with **earlier resolvers taking precedence**, so a
 * static (Zod) error on a field suppresses a later dynamic (AST) error on the
 * same field. The composed resolver reports success only when every resolver
 * passes.
 */
export function composeResolvers<TFieldValues extends FieldValues = FieldValues>(
  ...resolvers: Array<Resolver<TFieldValues>>
): Resolver<TFieldValues> {
  return async (values, context, options) => {
    const mergedErrors: Record<string, unknown> = {};
    const claimed = new Set<string>();

    for (const resolver of resolvers) {
      const result = await resolver(values, context, options);
      const errs = result.errors as Record<string, unknown>;
      for (const key of Object.keys(errs)) {
        if (claimed.has(key)) continue;
        mergedErrors[key] = errs[key];
        claimed.add(key);
      }
    }

    const result =
      claimed.size > 0 ? { values: {}, errors: mergedErrors } : { values, errors: {} };
    return result as ResolverResult<TFieldValues>;
  };
}
