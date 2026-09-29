import { Component, type ErrorInfo, type ReactNode } from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

/**
 * The last line of defence for the renderer. Without it, an exception while
 * drawing anything — an API answer in an unexpected shape, say — unmounts the
 * whole app and leaves an empty window with no way back but restarting it.
 * This shows what happened and a way to carry on instead. Playback, chat
 * connections and sign-ins live in the main process and are untouched; a
 * reload only redraws the window.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[renderer] A screen failed to draw:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="app-crash" role="alert">
        <h1>Something went wrong drawing this screen</h1>
        <p>
          VioletWire hit an error it did not expect. Reloading the window usually clears
          it; your settings and sign-ins are kept.
        </p>
        <div className="app-crash-actions">
          <button onClick={() => window.location.reload()} type="button">
            Reload VioletWire
          </button>
          <button onClick={() => this.setState({ error: null })} type="button">
            Try to carry on
          </button>
        </div>
        <details>
          <summary>What went wrong</summary>
          <pre>{error.stack ?? error.message}</pre>
        </details>
      </main>
    );
  }
}
