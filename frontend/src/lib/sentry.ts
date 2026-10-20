import { browserTracingIntegration, captureException, init, withScope } from '@sentry/react';

/**
 * Sentry frontend integration (Issue #210).
 *
 * Sentry is only initialised when a DSN is configured via `VITE_SENTRY_DSN`
 * (see frontend/.env.example). This keeps development and CI behaviour
 * identical to before — no telemetry, no network calls, no behaviour change —
 * while giving production deployments professional crash reporting, React
 * component crash capture, unhandled promise rejection capture and tracing.
 *
 * Sensitive values (Stellar wallet/contract addresses and 64-char hex
 * hashes) are scrubbed before any event is sent to Sentry.
 */

/**
 * Matches sensitive PII-like strings that should never leave the browser:
 *
 * - 56-char Stellar addresses: Ed25519 public keys (`G…`), contract IDs
 *   (`C…`) and secret keys (`S…`).
 * - 69-char M-prefixed **muxed** account addresses (`M…`), which embed a base
 *   64-bit memo ID on top of the underlying `G` public key.
 * - 64-char hex strings: transaction / commitment / proof hashes.
 *
 * All use the base32 alphabet (`A-Z2-7`) and are word-bounded so only
 * standalone tokens are replaced.
 */
const SENSITIVE_RE = /\b(?:[GCS][A-Z2-7]{55}|M[A-Z2-7]{68}|[0-9a-fA-F]{64})\b/g;
const REDACTED = '[REDACTED]';

let enabled = false;

/** Replaces every sensitive token in a string with {@link REDACTED}. */
function scrubString(value: string): string {
  return value.replace(SENSITIVE_RE, REDACTED);
}

/** Recursively scrubs sensitive tokens out of a scalar, array or object value. */
function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubValue(entry);
    }
    return out;
  }
  return value;
}

/**
 * beforeSend hook: scrubs wallet addresses (including muxed `M…` addresses),
 * contract IDs and transaction / commitment hashes out of every event (its
 * message, exception values and any attached `extra` context) before it leaves
 * the browser. Exported so the redaction behaviour can be unit-tested.
 */
export function scrubEvent(event: any, _hint: any): any {
  if (typeof event.message === 'string') {
    event.message = scrubString(event.message);
  }
  if (event.extra) {
    event.extra = scrubValue(event.extra);
  }
  if (event.exception?.values) {
    const values = event.exception.values as Array<Record<string, any>>;
    for (const entry of values) {
      if (typeof entry.value === 'string') {
        entry.value = scrubString(entry.value);
      }
    }
  }
  return event;
}

/** DSN read from the Vite environment, or an empty string when unset. */
export function sentryDsn(): string {
  return import.meta.env.VITE_SENTRY_DSN ?? '';
}

/**
 * Initialise Sentry. Safe to call in every environment — it is a no-op (and
 * returns `false`) when no DSN is configured or when the browser APIs Sentry
 * needs are unavailable. Call this once, at the React entry point, before the
 * tree is rendered.
 */
export function initSentry(): boolean {
  const dsn = sentryDsn();
  if (!dsn || typeof window === 'undefined') {
    return false;
  }
  try {
    init({
      dsn,
      environment: import.meta.env.MODE,
      release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
      integrations: [browserTracingIntegration()],
      tracesSampleRate: 0.2,
      beforeSend: scrubEvent,
    });
    enabled = true;
  } catch {
    enabled = false;
  }
  return enabled;
}

/** True once Sentry has been successfully initialised. */
export function isSentryEnabled(): boolean {
  return enabled;
}

/**
 * Report a Soroban RPC failure (timeout / node exhaustion / network error) to
 * Sentry with lightweight, non-sensitive context. No-op when Sentry is not
 * enabled, and fully defensive — telemetry never breaks the calling code.
 */
export function captureSorobanRpcError(error: unknown, context?: Record<string, unknown>): void {
  if (!enabled) {
    return;
  }
  try {
    withScope((scope) => {
      if (context) {
        for (const [key, value] of Object.entries(context)) {
          scope.setExtra(key, scrubValue(value));
        }
      }
      captureException(error);
    });
  } catch {
    // ignore — error reporting must never break the application
  }
}
