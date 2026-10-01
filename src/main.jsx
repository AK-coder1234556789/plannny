import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// Global error logger to capture any browser-side runtime errors
window.addEventListener('error', (event) => {
  console.error('[Global Browser Error]:', event.error || event.message);
  try {
    fetch('/api/log-client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'uncaught-error',
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack,
      }),
    }).catch(() => {});
  } catch {}
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Global Unhandled Rejection]:', event.reason);
  try {
    fetch('/api/log-client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'unhandled-rejection',
        reason: event.reason instanceof Error ? event.reason.message : String(event.reason),
        stack: event.reason?.stack,
      }),
    }).catch(() => {});
  } catch {}
});

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="center">
          <div className="card login" style={{ maxWidth: 440 }}>
            <div className="logo" style={{ color: '#ef4444' }}>
              <i className="ti ti-alert-triangle" />
            </div>
            <h2>Something went wrong</h2>
            <p className="muted">
              {this.state.error?.message || 'An unexpected rendering error occurred.'}
            </p>
            <button
              className="pill"
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
            >
              Reload Planner
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
