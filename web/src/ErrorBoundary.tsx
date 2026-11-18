import { Component, type ReactNode } from "react";

/** Shows the error and a reload button instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main>
        <div className="banner">
          <strong>PR Dashboard hit an error:</strong> {this.state.error.message}
          <p>If you just rebuilt or updated the app, restart the server (<code>pnpm start</code>), then reload.</p>
          <button className="button" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </main>
    );
  }
}
