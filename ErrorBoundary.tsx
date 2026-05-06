import * as React from 'react';

interface Props { children: React.ReactNode }
interface State { hasError: boolean; message: string }

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err.message };
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="m-6 p-6 bg-red-50 border border-red-300 rounded-xl text-red-800">
          <h2 className="font-bold text-lg mb-2">Something went wrong</h2>
          <pre className="text-sm whitespace-pre-wrap">{this.state.message}</pre>
          <button
            onClick={() => this.setState({ hasError: false, message: '' })}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
