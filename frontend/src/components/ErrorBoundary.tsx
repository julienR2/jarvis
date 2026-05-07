import { Component, type ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Jarvis] Uncaught UI error:', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className='min-h-screen flex items-center justify-center bg-bg px-4'>
        <div className='max-w-md w-full bg-surface border border-border rounded-2xl p-6 shadow-sm'>
          <div className='flex items-center gap-2 text-danger mb-3'>
            <AlertTriangle size={20} />
            <h2 className='font-semibold'>Something went wrong</h2>
          </div>
          <p className='text-sm text-text-muted mb-4'>
            The UI hit an unexpected error. Your conversations are safe — reload the page to recover.
          </p>
          <details className='text-xs text-text-muted mb-4'>
            <summary className='cursor-pointer hover:text-text-primary'>Technical details</summary>
            <pre className='mt-2 p-2 bg-bg rounded border border-border overflow-auto max-h-48'>
              {this.state.error.message}
              {'\n\n'}
              {this.state.error.stack}
            </pre>
          </details>
          <button
            onClick={() => window.location.reload()}
            className='w-full bg-accent text-white py-2 rounded-lg font-medium hover:bg-accent-hover transition-colors text-sm flex items-center justify-center gap-2'
          >
            <RotateCw size={14} /> Reload
          </button>
        </div>
      </div>
    )
  }
}
