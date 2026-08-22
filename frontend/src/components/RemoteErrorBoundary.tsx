import { Component, type ErrorInfo, type ReactNode } from 'react'

interface RemoteErrorBoundaryProps {
  /** Human-readable name of the remote module being loaded, shown in the fallback UI. */
  remoteName: string
  children: ReactNode
}

interface RemoteErrorBoundaryState {
  error: Error | null
}

/**
 * Catches failures loading or rendering a federated remote module (network failure, the remote's
 * dev server not running, a version mismatch in a shared dependency, ...) so one remote going
 * down degrades gracefully instead of white-screening the whole host application.
 */
export class RemoteErrorBoundary extends Component<RemoteErrorBoundaryProps, RemoteErrorBoundaryState> {
  state: RemoteErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RemoteErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[remote:${this.props.remoteName}] failed to load`, error, info.componentStack)
  }

  private retry = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      return (
        <div className="inline-alert warning" role="alert">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2L1 14h14L8 2z" /><path d="M8 6v4M8 11.5v.5" />
          </svg>
          <div>
            <strong>{this.props.remoteName}</strong> module failed to load. It may be
            unavailable or still deploying.
            <div style={{ marginTop: '8px' }}>
              <button className="btn btn-secondary btn-sm" onClick={this.retry}>
                Retry
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default RemoteErrorBoundary
