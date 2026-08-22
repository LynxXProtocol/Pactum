/**
 * Error types for the AST rules engine.
 *
 * A clean split between the two phases:
 * - {@link AstValidationError} is thrown by the *compiler* when the downloaded
 *   JSON is malformed, exceeds a safety limit, or references something outside
 *   the language (unknown node kind, non-whitelisted function, bad regex …).
 *   Callers should catch this and fall back to safe defaults.
 * - {@link AstEvaluationError} is reserved for unexpected *runtime* faults. The
 *   evaluator is intentionally total for ordinary input (it returns predictable
 *   values rather than throwing), so this should essentially never surface in
 *   practice — it exists so that a genuine bug is loud rather than silent.
 */

/** The JSON path to the offending node, e.g. `rules[2].assert.left`. */
export type AstPath = string;

/** Thrown while validating / compiling an untrusted {@link RuleSet}. */
export class AstValidationError extends Error {
  readonly path: AstPath;

  constructor(message: string, path: AstPath = '') {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'AstValidationError';
    this.path = path;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, AstValidationError.prototype);
  }
}

/** Thrown for an unexpected fault while evaluating a compiled rule. */
export class AstEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AstEvaluationError';
    Object.setPrototypeOf(this, AstEvaluationError.prototype);
  }
}
