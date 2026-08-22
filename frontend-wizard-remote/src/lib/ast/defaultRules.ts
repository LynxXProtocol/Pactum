/**
 * Bundled, safe default rule sets.
 *
 * In production the frontend downloads the current {@link RuleSet} from the
 * smart contract / governance layer (see `useValidationRules`). This module
 * provides the fallback used when no remote rule set is configured or a download
 * fails, so the form always has a sane, working set of dynamic constraints.
 *
 * These are plain JSON-shaped objects — exactly what a governance payload looks
 * like on the wire — and they are compiled through the same untrusted-input path
 * as anything downloaded.
 */

import type { RuleSet } from './types';

/**
 * Dynamic constraints for the "create commitment" form. They deliberately layer
 * *on top of* the static Zod schema (which already enforces required fields, the
 * Stellar address format, and the basic future-date check): every rule is
 * guarded by `when: not(isBlank(field))` so that an empty field surfaces Zod's
 * structural error rather than a dynamic one.
 *
 * All values here (the 24-hour lead time, the 2035 horizon, the minimum terms
 * length, the banned placeholder words) are exactly the kind of thing governance
 * can retune without shipping new frontend code.
 */
export const DEFAULT_COMMITMENT_RULES: RuleSet = {
  version: 1,
  rules: [
    {
      id: 'due-at-min-lead-time',
      field: 'dueAt',
      message: 'Due date must be at least 24 hours from now.',
      when: { kind: 'not', operand: { kind: 'call', fn: 'isBlank', args: [{ kind: 'field', name: 'dueAt' }] } },
      assert: {
        kind: 'compare',
        op: '>=',
        left: { kind: 'call', fn: 'toDate', args: [{ kind: 'field', name: 'dueAt' }] },
        right: {
          kind: 'arith',
          op: '+',
          left: { kind: 'call', fn: 'now', args: [] },
          right: { kind: 'call', fn: 'hours', args: [{ kind: 'lit', value: 24 }] },
        },
      },
    },
    {
      id: 'due-at-max-horizon',
      field: 'dueAt',
      message: 'Due date must be before the year 2035.',
      when: { kind: 'not', operand: { kind: 'call', fn: 'isBlank', args: [{ kind: 'field', name: 'dueAt' }] } },
      assert: {
        kind: 'compare',
        op: '<',
        left: { kind: 'call', fn: 'toDate', args: [{ kind: 'field', name: 'dueAt' }] },
        right: { kind: 'call', fn: 'toDate', args: [{ kind: 'lit', value: '2035-01-01T00:00:00' }] },
      },
    },
    {
      id: 'terms-min-length',
      field: 'terms',
      message: 'Terms must be at least 10 characters of substance.',
      when: { kind: 'not', operand: { kind: 'call', fn: 'isBlank', args: [{ kind: 'field', name: 'terms' }] } },
      assert: {
        kind: 'compare',
        op: '>=',
        left: { kind: 'call', fn: 'len', args: [{ kind: 'call', fn: 'trim', args: [{ kind: 'field', name: 'terms' }] }] },
        right: { kind: 'lit', value: 10 },
      },
    },
    {
      id: 'terms-no-placeholders',
      field: 'terms',
      message: 'Terms must not contain placeholder text like TODO, TBD, or XXX.',
      when: { kind: 'not', operand: { kind: 'call', fn: 'isBlank', args: [{ kind: 'field', name: 'terms' }] } },
      assert: {
        kind: 'not',
        operand: {
          kind: 'match',
          value: { kind: 'field', name: 'terms' },
          pattern: '\\b(todo|tbd|xxx)\\b',
          flags: 'i',
        },
      },
    },
  ],
};

/**
 * The exact example from issue #155 — "Amount must be > 100 AND Date < 2027" —
 * expressed in the rule language. Illustrative only (the commitment form has no
 * `amount` / `date` fields); it documents the shape of a governance payload and
 * is exercised by the unit tests.
 */
export const EXAMPLE_AMOUNT_DATE_RULES: RuleSet = {
  version: 1,
  rules: [
    {
      id: 'amount-minimum',
      field: 'amount',
      message: 'Amount must be greater than 100.',
      assert: {
        kind: 'compare',
        op: '>',
        left: { kind: 'call', fn: 'toNumber', args: [{ kind: 'field', name: 'amount' }] },
        right: { kind: 'lit', value: 100 },
      },
    },
    {
      id: 'date-before-2027',
      field: 'date',
      message: 'Date must be before 2027.',
      assert: {
        kind: 'compare',
        op: '<',
        left: { kind: 'call', fn: 'toDate', args: [{ kind: 'field', name: 'date' }] },
        right: { kind: 'call', fn: 'toDate', args: [{ kind: 'lit', value: '2027-01-01T00:00:00' }] },
      },
    },
  ],
};
