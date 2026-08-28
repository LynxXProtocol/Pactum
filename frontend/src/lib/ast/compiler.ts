/**
 * Validator + compiler for the AST rules engine.
 *
 * The downloaded {@link RuleSet} JSON is untrusted, so `compileRuleSet` performs
 * two jobs before anything is ever evaluated:
 *
 *  1. **Validation** — every node is checked against the language: known `kind`,
 *     correct operand shapes/arities, whitelisted function names, valid regex,
 *     and a set of hard {@link LIMITS} (node count, depth, operand count, string
 *     / regex / message lengths, reserved field segments). Anything off-language
 *     throws {@link AstValidationError}; callers fall back to safe defaults.
 *
 *  2. **Compilation to closures** — each validated node is turned into a small
 *     JavaScript closure that captures its already-compiled children. There is
 *     **no `eval` / `new Function`**; dispatch on `kind` happens once, at compile
 *     time, not on every keystroke. The resulting closure tree evaluates in
 *     microseconds, comfortably inside the < 16ms typing-lag budget.
 *
 * The runtime is intentionally *total*: for ordinary form input the evaluator
 * returns predictable values (e.g. an out-of-range comparison is simply `false`)
 * rather than throwing, so the hot path never pays for exception handling.
 */

import type {
  ArithOp,
  CompareOp,
  CompiledExpr,
  CompiledRule,
  CompiledRuleSet,
  FnName,
  RuntimeValue,
} from './types.ts';
import { AstValidationError } from './errors.ts';

/** Hard safety limits applied while compiling untrusted rule sets. */
export const LIMITS = Object.freeze({
  /** Maximum number of rules in a single rule set. */
  MAX_RULES: 200,
  /** Maximum AST nodes per rule (assert + when combined). */
  MAX_NODES_PER_RULE: 500,
  /** Maximum nesting depth of a single expression. */
  MAX_DEPTH: 64,
  /** Maximum operand/argument/set count for a single node. */
  MAX_OPERANDS: 100,
  /** Maximum length of a string literal. */
  MAX_STRING_LITERAL_LEN: 4096,
  /** Maximum length of a rule's message. */
  MAX_MESSAGE_LEN: 512,
  /** Maximum length of a regular-expression pattern. */
  MAX_REGEX_LEN: 512,
  /** Maximum explicit `{n,m}` repetition bound allowed in a regex. */
  MAX_REGEX_QUANTIFIER: 1000,
  /** Maximum number of segments in a dotted field path. */
  MAX_FIELD_PATH_SEGMENTS: 16,
  /** Inputs longer than this are not matched against a regex (ReDoS guard). */
  MAX_MATCH_INPUT_LEN: 8192,
} as const);

const COMPARE_OPS: ReadonlySet<CompareOp> = new Set(['==', '!=', '>', '>=', '<', '<=']);
const ARITH_OPS: ReadonlySet<ArithOp> = new Set(['+', '-', '*', '/', '%']);
const ALLOWED_REGEX_FLAGS = /^[imsu]*$/;

/** Field path segments that could lead to prototype pollution. */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);
const FIELD_SEGMENT_RE = /^[A-Za-z0-9_]+$/;

// ─────────────────────────────────────────────────────────────────────────────
// Runtime value helpers (pure, total — never throw on ordinary input)
// ─────────────────────────────────────────────────────────────────────────────

function stringify(value: RuntimeValue): string {
  if (value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

/** Coerce a value to a number for arithmetic / ordered comparison; non-numeric → NaN. */
function asNumber(value: RuntimeValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? NaN : Number(trimmed);
  }
  return NaN;
}

/** Truthiness used by `and`/`or`/`not` and by rule pass/fail. `null` is falsy. */
function truthy(value: RuntimeValue): boolean {
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  return value.length > 0;
}

/** Strict-ish equality: differing types are never equal; `NaN` equals nothing. */
function equals(a: RuntimeValue, b: RuntimeValue): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  return a === b;
}

/** Returns -1 / 0 / 1, or `null` when the two values are not orderable. */
function order(a: RuntimeValue, b: RuntimeValue): number | null {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return null;
}

function applyCompare(op: CompareOp, a: RuntimeValue, b: RuntimeValue): boolean {
  if (op === '==') return equals(a, b);
  if (op === '!=') return !equals(a, b);
  const cmp = order(a, b);
  if (cmp === null) return false; // incomparable → predictable false, never throws
  switch (op) {
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
  }
}

function applyArith(op: ArithOp, a: RuntimeValue, b: RuntimeValue): RuntimeValue {
  const x = asNumber(a);
  const y = asNumber(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  switch (op) {
    case '+':
      return x + y;
    case '-':
      return x - y;
    case '*':
      return x * y;
    case '/':
      return y === 0 ? null : x / y;
    case '%':
      return y === 0 ? null : x % y;
  }
}

/** Implementations of the whitelisted unary built-ins. `now` is handled inline. */
const UNARY_FNS: Readonly<Record<Exclude<FnName, 'now'>, (v: RuntimeValue) => RuntimeValue>> =
  Object.freeze({
    toNumber: (v) => {
      const n = asNumber(v);
      return Number.isNaN(n) ? null : n;
    },
    toDate: (v) => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v === 'string') {
        const ms = Date.parse(v);
        return Number.isNaN(ms) ? null : ms;
      }
      return null;
    },
    len: (v) => stringify(v).length,
    lower: (v) => stringify(v).toLowerCase(),
    upper: (v) => stringify(v).toUpperCase(),
    trim: (v) => stringify(v).trim(),
    isBlank: (v) => (v === null ? true : stringify(v).trim().length === 0),
    abs: (v) => {
      const n = asNumber(v);
      return Number.isNaN(n) ? null : Math.abs(n);
    },
    days: (v) => {
      const n = asNumber(v);
      return Number.isNaN(n) ? null : n * 86_400_000;
    },
    hours: (v) => {
      const n = asNumber(v);
      return Number.isNaN(n) ? null : n * 3_600_000;
    },
  });

/** Arity of each built-in. Everything except `now` takes exactly one argument. */
const FN_ARITY: Readonly<Record<FnName, number>> = Object.freeze({
  now: 0,
  toNumber: 1,
  toDate: 1,
  len: 1,
  lower: 1,
  upper: 1,
  trim: 1,
  isBlank: 1,
  abs: 1,
  days: 1,
  hours: 1,
});

/** Normalize an arbitrary form-field value into a scalar {@link RuntimeValue}. */
function normalizeFieldValue(value: unknown): RuntimeValue {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean' || t === 'number') return value as RuntimeValue;
  if (t === 'bigint') return Number(value as bigint);
  return null; // objects / arrays / functions / symbols are not comparable scalars
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural validation helpers
// ─────────────────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertValidFieldPath(name: unknown, path: string): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new AstValidationError('field path must be a non-empty string', path);
  }
  const segments = name.split('.');
  if (segments.length > LIMITS.MAX_FIELD_PATH_SEGMENTS) {
    throw new AstValidationError('field path has too many segments', path);
  }
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new AstValidationError('field path has an empty segment', path);
    }
    if (RESERVED_SEGMENTS.has(segment)) {
      throw new AstValidationError(`field path segment "${segment}" is reserved`, path);
    }
    if (!FIELD_SEGMENT_RE.test(segment)) {
      throw new AstValidationError(`field path segment "${segment}" has invalid characters`, path);
    }
  }
}

interface Budget {
  nodes: number;
}

/**
 * Conservative static guard against exponential regex backtracking (ReDoS).
 *
 * Length caps alone do **not** prevent catastrophic backtracking — e.g. `(a+)+$`
 * runs in exponential time on a short, non-matching input while staying well
 * under both the pattern- and input-length limits, and `RegExp.test` runs
 * synchronously on the `onChange` hot path. This walks the (already syntactically
 * valid) pattern and rejects the dominant exponential class: a repetition
 * quantifier applied to a sub-expression that itself contains a repetition —
 * i.e. a regex "star height" >= 2. That is the same core guarantee the
 * well-known `safe-regex` heuristic provides. It also caps explicit `{n,m}`
 * repetition bounds so a single quantifier cannot request unbounded work.
 *
 * This is deliberately conservative, not a formal guarantee: it targets the
 * severe, most common nested-quantifier blowups, not every possible polynomial
 * case (e.g. overlapping alternation such as `(a|a)*`, which `safe-regex` also
 * misses). Combined with the pattern/input length caps and the fact that rule
 * sets are governance-controlled, it removes the practical ReDoS risk. Callers
 * that need a hard guarantee should move matching to a linear-time engine (RE2)
 * or a worker with a deadline.
 */
function assertSafeRegexPattern(pattern: string, path: string): void {
  const n = pattern.length;
  let i = 0;

  const consumeLazy = (): void => {
    // A trailing `?` makes a quantifier lazy; it changes match order, not the
    // backtracking blowup, so treat it identically.
    if (i < n && pattern[i] === '?') i += 1;
  };

  // Attempts to consume a `{n}` / `{n,}` / `{n,m}` quantifier at `i`. Returns
  // whether it repeats the atom >= 2 times, or null if `{` is a literal here.
  const tryBraceQuantifier = (): { repeats: boolean } | null => {
    let j = i + 1;
    let minStr = '';
    while (j < n && pattern[j] >= '0' && pattern[j] <= '9') minStr += pattern[j++];
    if (minStr === '') return null; // not a quantifier — `{` is a literal
    let hasComma = false;
    let maxStr = '';
    if (j < n && pattern[j] === ',') {
      hasComma = true;
      j += 1;
      while (j < n && pattern[j] >= '0' && pattern[j] <= '9') maxStr += pattern[j++];
    }
    if (j >= n || pattern[j] !== '}') return null; // not a valid quantifier
    const min = Number(minStr);
    const max = hasComma ? (maxStr === '' ? Infinity : Number(maxStr)) : min;
    if (
      min > LIMITS.MAX_REGEX_QUANTIFIER ||
      (Number.isFinite(max) && max > LIMITS.MAX_REGEX_QUANTIFIER)
    ) {
      throw new AstValidationError('regex repetition bound is too large', path);
    }
    i = j + 1; // consume through `}`
    return { repeats: !Number.isFinite(max) || max >= 2 };
  };

  const skipCharClass = (): void => {
    i += 1; // consume `[`
    if (i < n && pattern[i] === '^') i += 1;
    // In JavaScript a `]` immediately after `[` or `[^` closes the class (`[]`
    // is empty, `[^]` is any char); a literal `]` must be escaped (`[\]]`). So
    // the first unescaped `]` always terminates the class.
    while (i < n && pattern[i] !== ']') {
      i += pattern[i] === '\\' ? 2 : 1;
    }
    if (i < n) i += 1; // consume closing `]`
  };

  const skipGroupPrefix = (): void => {
    if (i < n && pattern[i] === '?') {
      i += 1;
      const c = pattern[i];
      if (c === ':' || c === '=' || c === '!') {
        i += 1;
      } else if (c === '<') {
        i += 1;
        if (pattern[i] === '=' || pattern[i] === '!') {
          i += 1; // lookbehind
        } else {
          while (i < n && pattern[i] !== '>') i += 1; // named group (?<name>…)
          if (i < n) i += 1;
        }
      }
    }
  };

  // Each of these returns the star height of the sub-expression it consumes.
  const parseAtom = (): number => {
    const c = pattern[i];
    if (c === '\\') {
      i += 2; // escape: the pattern is valid, so a following char exists
      return 0;
    }
    if (c === '[') {
      skipCharClass();
      return 0;
    }
    if (c === '(') {
      i += 1;
      skipGroupPrefix();
      const h = parseAlternation();
      if (i < n && pattern[i] === ')') i += 1;
      return h; // a group by itself does not raise star height
    }
    i += 1; // any other single char (literal, `.`, `^`, `$`, or a literal `{`)
    return 0;
  };

  const parseQuantified = (): number => {
    const atomHeight = parseAtom();
    if (i < n) {
      const c = pattern[i];
      if (c === '*' || c === '+') {
        i += 1;
        consumeLazy();
        return atomHeight + 1;
      }
      if (c === '?') {
        i += 1;
        consumeLazy();
        return atomHeight; // 0-or-1 is not a repetition
      }
      if (c === '{') {
        const q = tryBraceQuantifier();
        if (q) {
          consumeLazy();
          return q.repeats ? atomHeight + 1 : atomHeight;
        }
      }
    }
    return atomHeight;
  };

  function parseConcatenation(): number {
    let height = 0;
    while (i < n && pattern[i] !== '|' && pattern[i] !== ')') {
      height = Math.max(height, parseQuantified());
    }
    return height;
  }

  function parseAlternation(): number {
    let height = parseConcatenation();
    while (i < n && pattern[i] === '|') {
      i += 1;
      height = Math.max(height, parseConcatenation());
    }
    return height;
  }

  const starHeight = parseAlternation();
  if (starHeight >= 2) {
    throw new AstValidationError(
      'regex may be vulnerable to catastrophic backtracking (nested quantifiers)',
      path,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Expression compiler (validate + compile-to-closures)
// ─────────────────────────────────────────────────────────────────────────────

function compileField(name: string, path: string): CompiledExpr {
  assertValidFieldPath(name, path);
  const segments = name.split('.');
  return (ctx) => {
    let current: unknown = ctx.values;
    for (const segment of segments) {
      if (current === null || typeof current !== 'object') return null;
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return null;
      current = (current as Record<string, unknown>)[segment];
    }
    return normalizeFieldValue(current);
  };
}

function compileOperandList(
  nodes: unknown,
  path: string,
  depth: number,
  budget: Budget,
): CompiledExpr[] {
  if (!Array.isArray(nodes)) {
    throw new AstValidationError('expected an array of operands', path);
  }
  if (nodes.length > LIMITS.MAX_OPERANDS) {
    throw new AstValidationError('too many operands', path);
  }
  return nodes.map((node, i) => compileExpr(node, `${path}[${i}]`, depth, budget));
}

function compileExpr(node: unknown, path: string, depth: number, budget: Budget): CompiledExpr {
  budget.nodes += 1;
  if (budget.nodes > LIMITS.MAX_NODES_PER_RULE) {
    throw new AstValidationError('rule is too large (node budget exceeded)', path);
  }
  if (depth > LIMITS.MAX_DEPTH) {
    throw new AstValidationError('expression is nested too deeply', path);
  }
  if (!isPlainObject(node)) {
    throw new AstValidationError('expression node must be an object', path);
  }

  const kind = node.kind;
  if (typeof kind !== 'string') {
    throw new AstValidationError('expression node is missing a string "kind"', path);
  }

  const childDepth = depth + 1;

  switch (kind) {
    case 'lit': {
      const value = node.value;
      if (
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        throw new AstValidationError('literal must be string, number, boolean, or null', path);
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new AstValidationError('literal number must be finite', path);
      }
      if (typeof value === 'string' && value.length > LIMITS.MAX_STRING_LITERAL_LEN) {
        throw new AstValidationError('string literal is too long', path);
      }
      const literal = value as RuntimeValue;
      return () => literal;
    }

    case 'field': {
      return compileField(node.name as string, `${path}.name`);
    }

    case 'not': {
      const operand = compileExpr(node.operand, `${path}.operand`, childDepth, budget);
      return (ctx) => !truthy(operand(ctx));
    }

    case 'and': {
      const operands = compileOperandList(node.operands, `${path}.operands`, childDepth, budget);
      return (ctx) => {
        for (const fn of operands) {
          if (!truthy(fn(ctx))) return false;
        }
        return true;
      };
    }

    case 'or': {
      const operands = compileOperandList(node.operands, `${path}.operands`, childDepth, budget);
      return (ctx) => {
        for (const fn of operands) {
          if (truthy(fn(ctx))) return true;
        }
        return false;
      };
    }

    case 'compare': {
      const op = node.op;
      if (typeof op !== 'string' || !COMPARE_OPS.has(op as CompareOp)) {
        throw new AstValidationError(`unknown comparison operator "${String(op)}"`, `${path}.op`);
      }
      const left = compileExpr(node.left, `${path}.left`, childDepth, budget);
      const right = compileExpr(node.right, `${path}.right`, childDepth, budget);
      const cmp = op as CompareOp;
      return (ctx) => applyCompare(cmp, left(ctx), right(ctx));
    }

    case 'arith': {
      const op = node.op;
      if (typeof op !== 'string' || !ARITH_OPS.has(op as ArithOp)) {
        throw new AstValidationError(`unknown arithmetic operator "${String(op)}"`, `${path}.op`);
      }
      const left = compileExpr(node.left, `${path}.left`, childDepth, budget);
      const right = compileExpr(node.right, `${path}.right`, childDepth, budget);
      const arith = op as ArithOp;
      return (ctx) => applyArith(arith, left(ctx), right(ctx));
    }

    case 'in': {
      const value = compileExpr(node.value, `${path}.value`, childDepth, budget);
      const set = compileOperandList(node.set, `${path}.set`, childDepth, budget);
      return (ctx) => {
        const v = value(ctx);
        for (const fn of set) {
          if (equals(v, fn(ctx))) return true;
        }
        return false;
      };
    }

    case 'match': {
      const pattern = node.pattern;
      if (typeof pattern !== 'string') {
        throw new AstValidationError('match pattern must be a string', `${path}.pattern`);
      }
      if (pattern.length > LIMITS.MAX_REGEX_LEN) {
        throw new AstValidationError('match pattern is too long', `${path}.pattern`);
      }
      const flags = node.flags;
      if (flags !== undefined && (typeof flags !== 'string' || !ALLOWED_REGEX_FLAGS.test(flags))) {
        // `g`/`y` are rejected: they make RegExp.test stateful across calls.
        throw new AstValidationError('match flags may only contain i, m, s, u', `${path}.flags`);
      }
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, typeof flags === 'string' ? flags : '');
      } catch (err) {
        throw new AstValidationError(
          `invalid regular expression: ${(err as Error).message}`,
          `${path}.pattern`,
        );
      }
      // Length caps alone do not stop catastrophic backtracking; reject
      // exponential-backtracking patterns before they can run on the hot path.
      assertSafeRegexPattern(pattern, `${path}.pattern`);
      const value = compileExpr(node.value, `${path}.value`, childDepth, budget);
      return (ctx) => {
        const s = stringify(value(ctx));
        if (s.length > LIMITS.MAX_MATCH_INPUT_LEN) return false;
        return regex.test(s);
      };
    }

    case 'call': {
      const fn = node.fn;
      if (typeof fn !== 'string' || !Object.prototype.hasOwnProperty.call(FN_ARITY, fn)) {
        throw new AstValidationError(`unknown function "${String(fn)}"`, `${path}.fn`);
      }
      const fnName = fn as FnName;
      const args = node.args;
      if (!Array.isArray(args)) {
        throw new AstValidationError('call args must be an array', `${path}.args`);
      }
      if (args.length !== FN_ARITY[fnName]) {
        throw new AstValidationError(
          `function "${fnName}" expects ${FN_ARITY[fnName]} argument(s), got ${args.length}`,
          `${path}.args`,
        );
      }
      if (fnName === 'now') {
        return (ctx) => ctx.now;
      }
      const arg = compileExpr(args[0], `${path}.args[0]`, childDepth, budget);
      const impl = UNARY_FNS[fnName];
      return (ctx) => impl(arg(ctx));
    }

    default:
      throw new AstValidationError(`unknown expression kind "${kind}"`, path);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule / rule-set compiler
// ─────────────────────────────────────────────────────────────────────────────

function compileRule(rule: unknown, path: string): CompiledRule {
  if (!isPlainObject(rule)) {
    throw new AstValidationError('rule must be an object', path);
  }

  assertValidFieldPath(rule.field, `${path}.field`);
  const field = rule.field;

  const message = rule.message;
  if (typeof message !== 'string' || message.length === 0) {
    throw new AstValidationError('rule message must be a non-empty string', `${path}.message`);
  }
  if (message.length > LIMITS.MAX_MESSAGE_LEN) {
    throw new AstValidationError('rule message is too long', `${path}.message`);
  }

  const id = rule.id;
  if (id !== undefined && typeof id !== 'string') {
    throw new AstValidationError('rule id must be a string when present', `${path}.id`);
  }

  if (!('assert' in rule)) {
    throw new AstValidationError('rule is missing "assert"', path);
  }

  // assert and when share one node budget so a single rule can never blow up.
  const budget: Budget = { nodes: 0 };
  const assertFn = compileExpr(rule.assert, `${path}.assert`, 0, budget);
  const whenFn = rule.when === undefined ? null : compileExpr(rule.when, `${path}.when`, 0, budget);

  const test = whenFn
    ? (ctx: Parameters<CompiledExpr>[0]): boolean => !truthy(whenFn(ctx)) || truthy(assertFn(ctx))
    : (ctx: Parameters<CompiledExpr>[0]): boolean => truthy(assertFn(ctx));

  return id === undefined
    ? { field: field as string, message, test }
    : { field: field as string, message, id: id as string, test };
}

/**
 * Validate and compile an untrusted rule-set document into an executable
 * {@link CompiledRuleSet}. Throws {@link AstValidationError} on any malformed or
 * out-of-limit input; the caller is expected to fall back to safe defaults.
 */
export function compileRuleSet(input: unknown): CompiledRuleSet {
  if (!isPlainObject(input)) {
    throw new AstValidationError('rule set must be an object', '');
  }
  if (input.version !== 1) {
    throw new AstValidationError('unsupported rule set version (expected 1)', 'version');
  }
  const rules = input.rules;
  if (!Array.isArray(rules)) {
    throw new AstValidationError('rules must be an array', 'rules');
  }
  if (rules.length > LIMITS.MAX_RULES) {
    throw new AstValidationError('too many rules', 'rules');
  }
  const compiled = rules.map((rule, i) => compileRule(rule, `rules[${i}]`));
  return { version: 1, rules: compiled };
}
