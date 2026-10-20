import type React from 'react';

export interface ErrorDetails {
  error: Error;
  errorInfo?: React.ErrorInfo | Record<string, unknown>;
  timestamp: string;
  url: string;
  userAgent: string;
}

export type ErrorReporter = (details: ErrorDetails) => void;

const reporters: Set<ErrorReporter> = new Set();

/**
 * Register an error reporter (e.g. Sentry, Datadog, or custom analytics).
 * Returns an unsubscribe callback function.
 */
export function addErrorReporter(reporter: ErrorReporter): () => void {
  reporters.add(reporter);
  return () => {
    reporters.delete(reporter);
  };
}

/**
 * Remove a previously registered error reporter.
 */
export function removeErrorReporter(reporter: ErrorReporter): void {
  reporters.delete(reporter);
}

/**
 * Normalize and log an error to all registered reporters and console.
 */
export function reportError(
  error: unknown,
  errorInfo?: React.ErrorInfo | Record<string, unknown>,
): ErrorDetails {
  const normalizedError =
    error instanceof Error
      ? error
      : new Error(typeof error === 'string' ? error : 'An unknown error occurred');

  const details: ErrorDetails = {
    error: normalizedError,
    errorInfo,
    timestamp: new Date().toISOString(),
    url: typeof window !== 'undefined' ? window.location.href : '',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  };

  // Always log structured error in development and console
  if (typeof console !== 'undefined' && console.error) {
    console.error('[Pactum Error]', {
      message: normalizedError.message,
      name: normalizedError.name,
      stack: normalizedError.stack,
      componentStack:
        errorInfo && 'componentStack' in errorInfo
          ? (errorInfo as React.ErrorInfo).componentStack
          : undefined,
      timestamp: details.timestamp,
    });
  }

  // Dispatch to all registered external tracking tools
  reporters.forEach((reporter) => {
    try {
      reporter(details);
    } catch (reporterErr) {
      console.error('[Pactum ErrorReporter Failed]', reporterErr);
    }
  });

  return details;
}
