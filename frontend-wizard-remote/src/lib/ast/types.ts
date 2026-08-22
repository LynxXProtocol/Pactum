/**
 * Type definitions for the AST-based form validation rules engine.
 *
 * The frontend downloads a JSON document (a {@link RuleSet}) describing the
 * *current* dynamic validation constraints — e.g. "amount must be > 100 AND the
 * due date must be before 2027". Because these rules originate off the local
 * codebase (from a smart contract / governance process), the JSON is treated as
 * **untrusted input**: it is structurally validated and compiled by
 * `compiler.ts` before it is ever evaluated, and the evaluator never uses
 * `eval`, `new Function`, or any other dynamic code execution.
 *
 * The language is a small, total, side-effect-free expression tree. Every node
 * evaluates to a {@link RuntimeValue}; the evaluator is designed so that normal
 * user input never throws (it returns predictable values instead), which keeps
 * the hot path fast enough to run on every keystroke (< 16ms budget).
 */

/** The only value types the evaluator produces or compares. */
export type RuntimeValue = string | number | boolean | null;

/** Comparison operators. Ordering ops require both sides to be the same comparable type. */
export type CompareOp = '==' | '!=' | '>' | '>=' | '<' | '<=';

/** Arithmetic operators, evaluated over numbers. A null/NaN operand yields null. */
export type ArithOp = '+' | '-' | '*' | '/' | '%';

/**
 * The whitelist of pure built-in functions callable from a `call` node.
 * Every function is total and free of side effects.
 *
 * - `now()`            → current time as epoch milliseconds (number)
 * - `toNumber(x)`      → x parsed as a number, or null if not parseable
 * - `toDate(x)`        → x (ISO string / epoch number) parsed to epoch ms, or null
 * - `len(x)`           → length of the string form of x (null → 0)
 * - `lower(x)`         → lowercased string form of x
 * - `upper(x)`         → uppercased string form of x
 * - `trim(x)`          → trimmed string form of x
 * - `isBlank(x)`       → true when x is null / "" / whitespace-only
 * - `abs(x)`           → absolute value (non-number → null)
 * - `days(n)`          → n days expressed in milliseconds
 * - `hours(n)`         → n hours expressed in milliseconds
 */
export type FnName =
  | 'now'
  | 'toNumber'
  | 'toDate'
  | 'len'
  | 'lower'
  | 'upper'
  | 'trim'
  | 'isBlank'
  | 'abs'
  | 'days'
  | 'hours';

/** A literal constant. */
export interface LiteralExpr {
  kind: 'lit';
  value: RuntimeValue;
}

/**
 * A reference to a form field, by (optionally dotted) path — e.g. `"amount"` or
 * `"milestones.0.due"`. Reserved segments (`__proto__`, `prototype`,
 * `constructor`) are rejected at compile time to prevent prototype pollution.
 */
export interface FieldExpr {
  kind: 'field';
  name: string;
}

/** Logical negation of the truthiness of `operand`. */
export interface NotExpr {
  kind: 'not';
  operand: Expr;
}

/** Logical conjunction. An empty operand list is vacuously `true`. */
export interface AndExpr {
  kind: 'and';
  operands: Expr[];
}

/** Logical disjunction. An empty operand list is `false`. */
export interface OrExpr {
  kind: 'or';
  operands: Expr[];
}

/** Comparison between two sub-expressions. */
export interface CompareExpr {
  kind: 'compare';
  op: CompareOp;
  left: Expr;
  right: Expr;
}

/** Numeric arithmetic between two sub-expressions. */
export interface ArithExpr {
  kind: 'arith';
  op: ArithOp;
  left: Expr;
  right: Expr;
}

/** Membership test: `true` when `value` strictly equals any element of `set`. */
export interface InExpr {
  kind: 'in';
  value: Expr;
  set: Expr[];
}

/**
 * Regular-expression test against the string form of `value`. The pattern is
 * compiled once (at rule-compile time); pattern and input lengths are bounded to
 * limit pathological (ReDoS) matching.
 */
export interface MatchExpr {
  kind: 'match';
  value: Expr;
  pattern: string;
  flags?: string;
}

/** A call to one of the whitelisted {@link FnName} built-ins. */
export interface CallExpr {
  kind: 'call';
  fn: FnName;
  args: Expr[];
}

/** The AST node union. Discriminated on `kind`. */
export type Expr =
  | LiteralExpr
  | FieldExpr
  | NotExpr
  | AndExpr
  | OrExpr
  | CompareExpr
  | ArithExpr
  | InExpr
  | MatchExpr
  | CallExpr;

/**
 * A single validation rule.
 *
 * The rule *passes* when `assert` evaluates truthy. If `when` is present, the
 * rule is only enforced when `when` is truthy (otherwise it is skipped). On
 * failure, `message` is reported as an error against the form field `field`.
 */
export interface Rule {
  /** The form field the error attaches to (dotted paths allowed). */
  field: string;
  /** Human-readable message shown when the rule fails. */
  message: string;
  /** Expression that must be truthy for the field to be considered valid. */
  assert: Expr;
  /** Optional guard: the rule is only enforced when this is truthy. */
  when?: Expr;
  /** Optional stable identifier, useful for debugging / telemetry. */
  id?: string;
}

/** A versioned collection of rules, as downloaded from governance. */
export interface RuleSet {
  version: 1;
  rules: Rule[];
}

/** Runtime context passed to every compiled node. */
export interface EvalContext {
  /** The form values under validation. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Epoch ms treated as "now" — injectable so evaluation is deterministic in tests. */
  readonly now: number;
}

/** A compiled expression: a closure produced by the compiler (no `eval`). */
export type CompiledExpr = (ctx: EvalContext) => RuntimeValue;

/** A single compiled rule. */
export interface CompiledRule {
  readonly field: string;
  readonly message: string;
  readonly id?: string;
  /** Returns true when the rule passes for the given context. */
  readonly test: (ctx: EvalContext) => boolean;
}

/** The output of {@link compileRuleSet}: an executable, validated rule set. */
export interface CompiledRuleSet {
  readonly version: 1;
  readonly rules: readonly CompiledRule[];
}
