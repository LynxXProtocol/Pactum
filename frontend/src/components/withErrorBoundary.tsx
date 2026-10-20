import type { ComponentType, FC } from 'react';
import { ErrorBoundary, type ErrorBoundaryProps } from './ErrorBoundary';

/**
 * High-order component to wrap any component with an ErrorBoundary.
 */
export function withErrorBoundary<P extends object>(
  WrappedComponent: ComponentType<P>,
  errorBoundaryProps?: Omit<ErrorBoundaryProps, 'children'>,
): FC<P> {
  const ComponentWithErrorBoundary: FC<P> = (props) => (
    <ErrorBoundary {...errorBoundaryProps}>
      <WrappedComponent {...props} />
    </ErrorBoundary>
  );

  ComponentWithErrorBoundary.displayName = `WithErrorBoundary(${
    WrappedComponent.displayName ?? 'Component'
  })`;

  return ComponentWithErrorBoundary;
}
