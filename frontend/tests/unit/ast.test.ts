import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileRuleSet, LIMITS } from '../../src/lib/ast/compiler.ts';
import { createAstResolver, composeResolvers } from '../../src/lib/ast/resolver.ts';
import { AstValidationError } from '../../src/lib/ast/errors.ts';
import {
  DEFAULT_COMMITMENT_RULES,
  EXAMPLE_AMOUNT_DATE_RULES,
} from '../../src/lib/ast/defaultRules.ts';

// A fixed clock so `now()`-based rules are deterministic regardless of when/where
// the suite runs. 2026-06-15T12:00:00Z.
const FIXED_NOW = Date.parse('2026-06-15T12:00:00Z');

// Compile a single-rule set and evaluate its `assert`/`when` against `values`.
function evalRule(assert_, values, { when, now = FIXED_NOW } = {}) {
  const rule = { field: 'f', message: 'm', assert: assert_ };
  if (when !== undefined) rule.when = when;
  const compiled = compileRuleSet({ version: 1, rules: [rule] });
  return compiled.rules[0].test({ values, now });
}

// Convenience node builders.
const lit = (value) => ({ kind: 'lit', value });
const field = (name) => ({ kind: 'field', name });
const call = (fn, ...args) => ({ kind: 'call', fn, args });
const cmp = (op, left, right) => ({ kind: 'compare', op, left, right });

describe('compileRuleSet — validation of untrusted input', () => {
  it('accepts the bundled default and example rule sets', () => {
    assert.doesNotThrow(() => compileRuleSet(DEFAULT_COMMITMENT_RULES));
    assert.doesNotThrow(() => compileRuleSet(EXAMPLE_AMOUNT_DATE_RULES));
  });

  it('rejects non-object input', () => {
    for (const bad of [null, undefined, 42, 'x', [], true]) {
      assert.throws(() => compileRuleSet(bad), AstValidationError);
    }
  });

  it('rejects an unsupported version', () => {
    assert.throws(() => compileRuleSet({ version: 2, rules: [] }), AstValidationError);
  });

  it('rejects a non-array rules field', () => {
    assert.throws(() => compileRuleSet({ version: 1, rules: {} }), AstValidationError);
  });

  it('rejects more than MAX_RULES rules', () => {
    const rules = Array.from({ length: LIMITS.MAX_RULES + 1 }, () => ({
      field: 'f',
      message: 'm',
      assert: lit(true),
    }));
    assert.throws(() => compileRuleSet({ version: 1, rules }), AstValidationError);
  });

  it('rejects rules missing field / message / assert', () => {
    assert.throws(
      () => compileRuleSet({ version: 1, rules: [{ message: 'm', assert: lit(true) }] }),
      AstValidationError,
    );
    assert.throws(
      () => compileRuleSet({ version: 1, rules: [{ field: 'f', assert: lit(true) }] }),
      AstValidationError,
    );
    assert.throws(
      () => compileRuleSet({ version: 1, rules: [{ field: 'f', message: 'm' }] }),
      AstValidationError,
    );
  });

  it('rejects unknown expression kinds', () => {
    assert.throws(
      () => evalRule({ kind: 'danger', code: 'process.exit(1)' }, {}),
      AstValidationError,
    );
  });

  it('rejects unknown comparison and arithmetic operators', () => {
    assert.throws(
      () => evalRule({ kind: 'compare', op: '===', left: lit(1), right: lit(1) }, {}),
      AstValidationError,
    );
    assert.throws(
      () => evalRule({ kind: 'arith', op: '**', left: lit(1), right: lit(1) }, {}),
      AstValidationError,
    );
  });

  it('rejects unknown functions and wrong arity', () => {
    assert.throws(() => evalRule(call('evalString', lit('x')), {}), AstValidationError);
    assert.throws(() => evalRule({ kind: 'call', fn: 'len', args: [] }, {}), AstValidationError);
    assert.throws(
      () => evalRule({ kind: 'call', fn: 'now', args: [lit(1)] }, {}),
      AstValidationError,
    );
  });

  it('rejects reserved field-path segments (prototype-pollution guard)', () => {
    for (const name of ['__proto__', 'a.__proto__.b', 'constructor', 'x.prototype']) {
      assert.throws(() => evalRule(field(name), {}), AstValidationError);
    }
  });

  it('rejects field paths with invalid characters', () => {
    assert.throws(() => evalRule(field('a-b'), {}), AstValidationError);
    assert.throws(() => evalRule(field('a b'), {}), AstValidationError);
    assert.throws(() => evalRule(field(''), {}), AstValidationError);
  });

  it('enforces the nesting-depth limit', () => {
    let expr = lit(true);
    for (let i = 0; i < LIMITS.MAX_DEPTH + 5; i += 1) {
      expr = { kind: 'not', operand: expr };
    }
    assert.throws(() => evalRule(expr, {}), AstValidationError);
  });

  it('enforces the per-node operand limit', () => {
    const operands = Array.from({ length: LIMITS.MAX_OPERANDS + 1 }, () => lit(true));
    assert.throws(() => evalRule({ kind: 'and', operands }, {}), AstValidationError);
  });

  it('enforces the per-rule node budget', () => {
    // 100 branches × 10 leaves = ~1101 nodes, but each node stays within the
    // operand cap — so only the total-node budget can reject it.
    const operands = Array.from({ length: 100 }, () => ({
      kind: 'and',
      operands: Array.from({ length: 10 }, () => lit(true)),
    }));
    assert.throws(() => evalRule({ kind: 'and', operands }, {}), AstValidationError);
  });

  it('rejects invalid, overlong, or statefully-flagged regexes', () => {
    assert.throws(
      () => evalRule({ kind: 'match', value: field('x'), pattern: '(' }, {}),
      AstValidationError,
    );
    assert.throws(
      () => evalRule({ kind: 'match', value: field('x'), pattern: 'a', flags: 'g' }, {}),
      AstValidationError,
    );
    assert.throws(
      () =>
        evalRule(
          { kind: 'match', value: field('x'), pattern: 'a'.repeat(LIMITS.MAX_REGEX_LEN + 1) },
          {},
        ),
      AstValidationError,
    );
  });

  it('rejects catastrophic-backtracking regexes (ReDoS static guard)', () => {
    // Nested quantifiers (regex "star height" >= 2) are the exponential class;
    // these stay well under the length caps yet would hang the onChange resolver.
    // `[^]` / `[\s\S]` are JS "any char" classes — the scanner must count the
    // quantifier on them, not swallow the `]` as a class member.
    for (const pattern of [
      '(a+)+$',
      '(a*)*',
      '(a+)*',
      '((ab)+)+',
      '(\\d+)+$',
      '([^]+)+x',
      '([\\s\\S]+)+$',
    ]) {
      assert.throws(
        () => evalRule({ kind: 'match', value: field('x'), pattern }, {}),
        AstValidationError,
        `expected ${pattern} to be rejected`,
      );
    }
    // Oversized explicit repetition bounds are rejected too.
    assert.throws(
      () => evalRule({ kind: 'match', value: field('x'), pattern: 'a{1,100000}' }, {}),
      AstValidationError,
    );
    assert.throws(
      () =>
        evalRule(
          { kind: 'match', value: field('x'), pattern: `a{${LIMITS.MAX_REGEX_QUANTIFIER + 1}}` },
          {},
        ),
      AstValidationError,
    );
  });

  it('accepts safe single-level repetitions (no false positives on ordinary patterns)', () => {
    // Star height <= 1 is fine, including grouping, alternation, and bounded
    // repeats. `[]]+` is JS empty-class `[]` then a quantified literal `]`, and
    // `[^]` is the any-char class — both must parse to star height <= 1.
    for (const pattern of [
      '\\b(todo|tbd|xxx)\\b',
      '^G[A-Z0-9]{55}$',
      '(ab)+',
      '(?:foo|bar)+',
      'a{1,1000}',
      '\\d{3}-\\d{4}',
      '[]]+',
      '[^]',
    ]) {
      assert.doesNotThrow(
        () => evalRule({ kind: 'match', value: field('x'), pattern }, {}),
        `expected ${pattern} to be accepted`,
      );
    }
  });

  it('never uses eval — a string that looks like code is just a literal', () => {
    // The "code" is inert data; it is compared as a string and cannot execute.
    assert.equal(evalRule(cmp('==', field('note'), lit('2+2')), { note: '2+2' }), true);
    assert.equal(evalRule(cmp('==', field('note'), lit('4')), { note: '2+2' }), false);
  });
});

describe('evaluation semantics', () => {
  it('compares numbers numerically', () => {
    assert.equal(evalRule(cmp('>', lit(150), lit(100)), {}), true);
    assert.equal(evalRule(cmp('>', lit(50), lit(100)), {}), false);
    assert.equal(evalRule(cmp('<=', lit(100), lit(100)), {}), true);
  });

  it('compares strings lexicographically', () => {
    assert.equal(evalRule(cmp('<', lit('apple'), lit('banana')), {}), true);
    assert.equal(evalRule(cmp('>', lit('apple'), lit('banana')), {}), false);
  });

  it('treats mismatched types and null as not-orderable (predictable false, no throw)', () => {
    assert.equal(evalRule(cmp('>', lit('10'), lit(5)), {}), false); // string vs number
    assert.equal(evalRule(cmp('>', field('missing'), lit(5)), {}), false); // null vs number
    assert.equal(evalRule(cmp('<', field('missing'), lit(5)), {}), false);
  });

  it('implements == / != with strict, type-aware equality', () => {
    assert.equal(evalRule(cmp('==', lit(1), lit(1)), {}), true);
    assert.equal(evalRule(cmp('==', lit(1), lit('1')), {}), false);
    assert.equal(evalRule(cmp('!=', lit('a'), lit('b')), {}), true);
    assert.equal(evalRule(cmp('==', field('missing'), lit(null)), {}), true);
  });

  it('handles and / or / not with short-circuit semantics', () => {
    assert.equal(evalRule({ kind: 'and', operands: [lit(true), lit(true)] }, {}), true);
    assert.equal(evalRule({ kind: 'and', operands: [lit(true), lit(false)] }, {}), false);
    assert.equal(evalRule({ kind: 'and', operands: [] }, {}), true); // vacuous truth
    assert.equal(evalRule({ kind: 'or', operands: [lit(false), lit(true)] }, {}), true);
    assert.equal(evalRule({ kind: 'or', operands: [] }, {}), false);
    assert.equal(evalRule({ kind: 'not', operand: lit(false) }, {}), true);
  });

  it('evaluates arithmetic, with null on divide-by-zero / non-numeric', () => {
    assert.equal(
      evalRule(cmp('==', { kind: 'arith', op: '+', left: lit(2), right: lit(3) }, lit(5)), {}),
      true,
    );
    // 1 / 0 → null → comparison is not orderable → false (does not throw / Infinity)
    assert.equal(
      evalRule(cmp('>', { kind: 'arith', op: '/', left: lit(1), right: lit(0) }, lit(0)), {}),
      false,
    );
  });

  it('provides the whitelisted built-in functions', () => {
    assert.equal(evalRule(cmp('==', call('toNumber', lit('42')), lit(42)), {}), true);
    assert.equal(evalRule(cmp('==', call('toNumber', lit('abc')), lit(null)), {}), true); // unparseable → null
    assert.equal(
      evalRule(cmp('==', call('len', call('trim', field('s'))), lit(3)), { s: '  abc  ' }),
      true,
    );
    assert.equal(evalRule(cmp('==', call('lower', lit('AbC')), lit('abc')), {}), true);
    assert.equal(evalRule(cmp('==', call('upper', lit('AbC')), lit('ABC')), {}), true);
    assert.equal(evalRule(call('isBlank', field('missing')), {}), true);
    assert.equal(evalRule(call('isBlank', lit('   ')), {}), true);
    assert.equal(evalRule(call('isBlank', lit('x')), {}), false);
    assert.equal(evalRule(cmp('==', call('abs', lit(-7)), lit(7)), {}), true);
    assert.equal(evalRule(cmp('==', call('days', lit(2)), lit(172_800_000)), {}), true);
    assert.equal(evalRule(cmp('==', call('hours', lit(1)), lit(3_600_000)), {}), true);
  });

  it('resolves now() from the injected clock and supports date arithmetic', () => {
    assert.equal(evalRule(cmp('==', call('now'), lit(FIXED_NOW)), {}), true);
    // now() + 24h
    const plus24 = { kind: 'arith', op: '+', left: call('now'), right: call('hours', lit(24)) };
    assert.equal(evalRule(cmp('==', plus24, lit(FIXED_NOW + 86_400_000)), {}), true);
  });

  it('reads dotted field paths and only own properties', () => {
    assert.equal(evalRule(cmp('==', field('a.b'), lit('deep')), { a: { b: 'deep' } }), true);
    // inherited properties (e.g. toString) must not be readable → treated as null
    assert.equal(evalRule(cmp('==', field('toString'), lit(null)), {}), true);
  });

  it('implements `in` membership with strict equality', () => {
    const inSet = { kind: 'in', value: field('x'), set: [lit('a'), lit('b'), lit('c')] };
    assert.equal(evalRule(inSet, { x: 'b' }), true);
    assert.equal(evalRule(inSet, { x: 'z' }), false);
  });

  it('matches regexes and caps the input length (ReDoS guard)', () => {
    const m = { kind: 'match', value: field('x'), pattern: 'a', flags: 'i' };
    assert.equal(evalRule(m, { x: 'has an A' }), true);
    assert.equal(evalRule(m, { x: 'nope' }), false);
    // input longer than the cap is not matched, even if it contains the pattern
    assert.equal(evalRule(m, { x: 'a' + 'b'.repeat(LIMITS.MAX_MATCH_INPUT_LEN) }), false);
  });

  it('skips a rule whose `when` guard is falsy', () => {
    // assert is impossible (false), but the guard is off → rule passes anyway
    assert.equal(evalRule(lit(false), {}, { when: lit(false) }), true);
    assert.equal(evalRule(lit(false), {}, { when: lit(true) }), false);
  });
});

describe('issue #155 example — "Amount must be > 100 AND Date < 2027"', () => {
  const compiled = compileRuleSet(EXAMPLE_AMOUNT_DATE_RULES);
  const resolver = createAstResolver(compiled, { now: () => FIXED_NOW });

  it('passes when amount > 100 and date < 2027', () => {
    const res = resolver({ amount: '150', date: '2026-06-01' });
    assert.deepEqual(res.errors, {});
  });

  it('flags amount when it is not greater than 100', () => {
    const res = resolver({ amount: '50', date: '2026-06-01' });
    assert.equal(res.errors.amount?.message, 'Amount must be greater than 100.');
    assert.equal(res.errors.date, undefined);
  });

  it('flags the date when it is in 2027 or later', () => {
    const res = resolver({ amount: '150', date: '2028-06-01' });
    assert.equal(res.errors.date?.message, 'Date must be before 2027.');
    assert.equal(res.errors.amount, undefined);
  });

  it('evaluates the combined AND expression exactly as phrased', () => {
    const combined = {
      kind: 'and',
      operands: [
        cmp('>', call('toNumber', field('amount')), lit(100)),
        cmp('<', call('toDate', field('date')), call('toDate', lit('2027-01-01T00:00:00'))),
      ],
    };
    assert.equal(evalRule(combined, { amount: '150', date: '2026-06-01' }), true);
    assert.equal(evalRule(combined, { amount: '150', date: '2028-06-01' }), false);
    assert.equal(evalRule(combined, { amount: '50', date: '2026-06-01' }), false);
  });
});

describe('createAstResolver — react-hook-form shape', () => {
  const compiled = compileRuleSet(DEFAULT_COMMITMENT_RULES);
  const resolver = createAstResolver(compiled, { now: () => FIXED_NOW });

  it('returns the values and no errors when every rule passes', () => {
    const values = {
      counterparty: 'GABC',
      terms: 'Deliver the audited financial report by the deadline.',
      dueAt: '2026-06-30T12:00', // well beyond now + 24h and before 2035
    };
    const res = resolver(values);
    assert.deepEqual(res.errors, {});
    assert.deepEqual(res.values, values);
  });

  it('reports an error against the right field, with empty values', () => {
    const res = resolver({
      counterparty: 'GABC',
      terms: 'Deliver the audited financial report by the deadline.',
      dueAt: '2026-06-15T18:00', // < now + 24h → fails the lead-time rule
    });
    assert.equal(res.errors.dueAt?.message, 'Due date must be at least 24 hours from now.');
    assert.equal(res.errors.dueAt?.type, 'ast');
    assert.deepEqual(res.values, {});
  });

  it('shows only the first failing rule per field', () => {
    // "TODO ..." padded past 10 chars fails the placeholder rule; terms-min-length
    // (declared first) passes, so the placeholder message is the one shown.
    const res = resolver({
      counterparty: 'GABC',
      terms: 'Please handle the TODO before the deadline arrives.',
      dueAt: '2026-06-30T12:00',
    });
    assert.equal(
      res.errors.terms?.message,
      'Terms must not contain placeholder text like TODO, TBD, or XXX.',
    );
  });
});

describe('composeResolvers — layering AST rules on top of Zod', () => {
  it('lets an earlier resolver win a shared field and merges the rest', async () => {
    // A stand-in for zodResolver that flags `counterparty`.
    const zodLike = () => ({
      values: {},
      errors: { counterparty: { type: 'zod', message: 'Invalid address' } },
    });

    const astRules = compileRuleSet({
      version: 1,
      rules: [
        { field: 'counterparty', message: 'AST would also complain here', assert: lit(false) },
        { field: 'terms', message: 'Terms rejected by AST', assert: lit(false) },
      ],
    });
    const composed = composeResolvers(
      zodLike,
      createAstResolver(astRules, { now: () => FIXED_NOW }),
    );

    const res = await composed({ counterparty: 'x', terms: 'y' }, undefined, {});
    assert.equal(res.errors.counterparty?.message, 'Invalid address'); // Zod precedence
    assert.equal(res.errors.terms?.message, 'Terms rejected by AST'); // AST fills the rest
  });

  it('reports success only when all resolvers pass', async () => {
    const passA = (values) => ({ values, errors: {} });
    const passB = (values) => ({ values, errors: {} });
    const composed = composeResolvers(passA, passB);
    const values = { a: 1 };
    const res = await composed(values, undefined, {});
    assert.deepEqual(res.errors, {});
    assert.deepEqual(res.values, values);
  });
});

describe('performance — evaluation stays well under the 16ms typing budget', () => {
  it('evaluates a large (50-rule) governance set in < 16ms per keystroke', () => {
    // Synthesize a realistically large rule set: 50 fields, each with a
    // multi-node assert (arithmetic + comparison + boolean combinators).
    const rules = Array.from({ length: 50 }, (_, i) => ({
      field: `f${i}`,
      message: `f${i} out of range`,
      assert: {
        kind: 'and',
        operands: [
          cmp('>', call('toNumber', field(`f${i}`)), lit(-1000)),
          cmp('<', call('toNumber', field(`f${i}`)), lit(1000)),
          cmp(
            '<',
            { kind: 'arith', op: '+', left: call('now'), right: call('hours', lit(1)) },
            lit(FIXED_NOW + 7_200_000),
          ),
        ],
      },
    }));
    const compiled = compileRuleSet({ version: 1, rules });
    const resolver = createAstResolver(compiled, { now: () => FIXED_NOW });

    const values = {};
    for (let i = 0; i < 50; i += 1) values[`f${i}`] = String(i);

    // Warm up (let the JIT settle) so the measurement reflects steady state.
    for (let i = 0; i < 500; i += 1) resolver(values);

    const N = 5000;
    const samples = new Array(N);
    let total = 0;
    for (let i = 0; i < N; i += 1) {
      const t0 = performance.now();
      resolver(values);
      const dt = performance.now() - t0;
      samples[i] = dt;
      total += dt;
    }
    samples.sort((a, b) => a - b);
    const avg = total / N;
    const median = samples[Math.floor(N / 2)];
    const p99 = samples[Math.floor(N * 0.99)];
    const worst = samples[N - 1];

    console.log(
      `[ast perf] 50 rules × full pass over ${N} runs — ` +
        `avg ${(avg * 1000).toFixed(1)}µs, median ${(median * 1000).toFixed(1)}µs, ` +
        `p99 ${(p99 * 1000).toFixed(1)}µs, worst ${worst.toFixed(3)}ms`,
    );

    // The steady-state per-evaluation cost is what determines typing lag. We
    // assert only the 16ms acceptance criterion, on the average and median (both
    // GC-amortized / outlier-robust) rather than a single-sample maximum, which
    // in a garbage-collected VM captures unrelated GC pauses. The actual
    // microsecond figure is logged above rather than asserted: a tighter bound
    // (e.g. < 1ms) would flake under CPU contention on shared CI runners while
    // the product requirement still holds.
    assert.ok(avg < 16, `average eval was ${avg.toFixed(4)}ms (budget 16ms)`);
    assert.ok(median < 16, `median eval was ${median.toFixed(4)}ms (budget 16ms)`);
  });
});
