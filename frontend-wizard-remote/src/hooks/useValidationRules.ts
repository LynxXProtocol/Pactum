import { useEffect, useMemo, useState } from 'react';

import {
  compileRuleSet,
  DEFAULT_COMMITMENT_RULES,
  type CompiledRuleSet,
  type RuleSet,
} from '../lib/ast';

/**
 * Loads the dynamic validation {@link RuleSet} and compiles it for use with
 * react-hook-form.
 *
 * The rule set is a JSON document that, in production, is published by the smart
 * contract / governance layer and fetched at runtime — so validation constraints
 * can change without redeploying the frontend. This hook models that flow while
 * staying robust:
 *
 * - If `VITE_VALIDATION_RULES_URL` (or a custom `fetchRuleSet`) is configured, it
 *   downloads and compiles the remote rules.
 * - If nothing is configured, it uses the bundled {@link DEFAULT_COMMITMENT_RULES}.
 * - If a download or compile ever fails, it logs and falls back to the bundled
 *   rules — a bad or unreachable governance payload can never brick the form.
 *
 * Compilation happens once per rule set (memoized / on load), not per keystroke,
 * which is what keeps evaluation inside the sub-16ms typing budget.
 */

/** Where the currently active rule set came from. */
export type ValidationRulesStatus = 'default' | 'loading' | 'remote' | 'error';

export interface UseValidationRulesResult {
  /** The compiled rules to hand to `createAstResolver`. */
  compiled: CompiledRuleSet;
  /** Provenance of the active rule set. */
  status: ValidationRulesStatus;
  /** Human-readable reason the remote rules were rejected, if any. */
  error: string | null;
}

export interface UseValidationRulesOptions {
  /** Override the bundled fallback rule set. */
  fallback?: RuleSet;
  /** Custom loader; defaults to fetching `VITE_VALIDATION_RULES_URL` when set. */
  fetchRuleSet?: (signal: AbortSignal) => Promise<unknown>;
}

const EMPTY_COMPILED: CompiledRuleSet = { version: 1, rules: [] };

function safeCompile(input: unknown, label: string): CompiledRuleSet {
  try {
    return compileRuleSet(input);
  } catch (err) {
    // The bundled defaults are trusted, so this only fires on a programming
    // error; degrade to "no dynamic rules" rather than throwing during render.
    console.error(`[useValidationRules] could not compile ${label} rule set:`, err);
    return EMPTY_COMPILED;
  }
}

function createUrlLoader(url: string): (signal: AbortSignal) => Promise<unknown> {
  return async (signal) => {
    const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`rule set request failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  };
}

export function useValidationRules(
  options: UseValidationRulesOptions = {},
): UseValidationRulesResult {
  const { fallback, fetchRuleSet } = options;

  const fallbackCompiled = useMemo(
    () => safeCompile(fallback ?? DEFAULT_COMMITMENT_RULES, 'fallback'),
    [fallback],
  );

  const remoteUrl = import.meta.env.VITE_VALIDATION_RULES_URL as string | undefined;
  const loader = useMemo(() => {
    if (fetchRuleSet) return fetchRuleSet;
    if (remoteUrl) return createUrlLoader(remoteUrl);
    return null;
  }, [fetchRuleSet, remoteUrl]);

  const [state, setState] = useState<UseValidationRulesResult>(() => ({
    compiled: fallbackCompiled,
    status: 'default',
    error: null,
  }));

  useEffect(() => {
    if (!loader) {
      setState({ compiled: fallbackCompiled, status: 'default', error: null });
      return;
    }

    const controller = new AbortController();
    let active = true;
    setState({ compiled: fallbackCompiled, status: 'loading', error: null });

    loader(controller.signal)
      .then((payload) => {
        if (!active) return;
        try {
          const compiled = compileRuleSet(payload);
          setState({ compiled, status: 'remote', error: null });
        } catch (err) {
          console.error('[useValidationRules] downloaded rule set is invalid; using fallback:', err);
          setState({
            compiled: fallbackCompiled,
            status: 'error',
            error: err instanceof Error ? err.message : 'invalid rule set',
          });
        }
      })
      .catch((err) => {
        if (!active || controller.signal.aborted) return;
        console.error('[useValidationRules] failed to download rule set; using fallback:', err);
        setState({
          compiled: fallbackCompiled,
          status: 'error',
          error: err instanceof Error ? err.message : 'download failed',
        });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [loader, fallbackCompiled]);

  return state;
}
