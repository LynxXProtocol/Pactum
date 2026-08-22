/**
 * `@/lib/ast` — a safe, sandboxed AST rules engine for dynamic form validation.
 *
 * Public surface:
 * - Types describing the rule language ({@link Expr}, {@link Rule}, {@link RuleSet}).
 * - {@link compileRuleSet} — validate + compile untrusted JSON into an executable form.
 * - {@link createAstResolver} / {@link composeResolvers} — react-hook-form integration.
 * - {@link DEFAULT_COMMITMENT_RULES} — bundled fallback rules.
 *
 * See `README.md` in this directory for the language reference and safety model.
 */

export type {
  ArithOp,
  CompareOp,
  CompiledExpr,
  CompiledRule,
  CompiledRuleSet,
  EvalContext,
  Expr,
  FnName,
  Rule,
  RuleSet,
  RuntimeValue,
} from './types';

export { AstValidationError, AstEvaluationError } from './errors';
export { compileRuleSet, LIMITS } from './compiler';
export { createAstResolver, composeResolvers } from './resolver';
export type { AstResolverOptions } from './resolver';
export { DEFAULT_COMMITMENT_RULES, EXAMPLE_AMOUNT_DATE_RULES } from './defaultRules';
