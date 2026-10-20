import { ErrorBoundary } from '@sentry/react';
import type { ReactNode } from 'react';
import { isSentryEnabled } from '../lib/sentry';

interface SentryErrorBoundaryProps {
  children: ReactNode;
}

/**
 * Wraps part of the app in a Sentry Error Boundary so a React component crash
 * is captured and surfaced to Sentry instead of white-screening the UI (Issue
 * #210). When Sentry is not enabled (no DSN configured) this renders its
 * children directly, so behaviour is identical to before — it is a strict
 * no-op wrapper in development/CI.
 */
export function SentryErrorBoundary({ children }: SentryErrorBoundaryProps) {
  if (!isSentryEnabled()) {
    return <>{children}</>;
  }
  return (
    <ErrorBoundary
      fallback={
        <div className="sentry-fallback" role="alert">
          <h2>Something went wrong</h2>
          <p>An unexpected error occurred. Reload to continue.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
}

export default SentryErrorBoundary;
