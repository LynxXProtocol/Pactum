import { Component, type ReactNode, type ErrorInfo } from 'react';
import { reportError } from '../lib/errorReporting';
import { ErrorFallback, type ErrorFallbackProps } from './ErrorFallback';

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?:
    | ReactNode
    | ((props: {
        error: Error;
        resetErrorBoundary: () => void;
        errorInfo: ErrorInfo | null;
      }) => ReactNode);
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  onReset?: () => void;
  resetKeys?: Array<unknown>;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

const initialState: ErrorBoundaryState = {
  hasError: false,
  error: null,
  errorInfo: null,
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = initialState;
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });

    // Report to tracking tools & console
    reportError(error, errorInfo);

    // Call optional custom error handler in a safe block
    try {
      this.props.onError?.(error, errorInfo);
    } catch (callbackError) {
      reportError(callbackError, { context: 'ErrorBoundary.onError callback failed' });
    }
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    const { hasError } = this.state;
    const { resetKeys } = this.props;

    if (hasError) {
      const currentKeys = resetKeys ?? [];
      const previousKeys = prevProps.resetKeys ?? [];
      const hasKeyChanged =
        currentKeys.length !== previousKeys.length ||
        currentKeys.some((key, idx) => !Object.is(key, previousKeys[idx]));
      if (hasKeyChanged) {
        this.resetErrorBoundary();
      }
    }
  }

  resetErrorBoundary = (): void => {
    try {
      this.props.onReset?.();
    } catch (callbackError) {
      reportError(callbackError, { context: 'ErrorBoundary.onReset callback failed' });
    }
    this.setState(initialState);
  };

  render(): ReactNode {
    const { hasError, error, errorInfo } = this.state;
    const { children, fallback } = this.props;

    if (hasError && error) {
      if (typeof fallback === 'function') {
        return fallback({
          error,
          errorInfo,
          resetErrorBoundary: this.resetErrorBoundary,
        });
      }

      if (fallback) {
        return fallback;
      }

      return (
        <ErrorFallback
          error={error}
          errorInfo={errorInfo}
          resetErrorBoundary={this.resetErrorBoundary}
        />
      );
    }

    return children;
  }
}

export { ErrorFallback };
export type { ErrorFallbackProps };
