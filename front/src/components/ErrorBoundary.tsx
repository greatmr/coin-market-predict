// Keeps a crash in one part of a page (a chart, an iframe panel, a malformed record) from taking the
// whole dashboard down: the part shows what failed and can be retried. Route-level failures are
// caught by RouteError (react-router errorElement).
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router';

interface Props {
  /** Shown in the message, e.g. "The live chart". */
  label?: string;
  children: ReactNode;
  /** Resets the boundary when any of these change (e.g. the coin id). */
  resetKeys?: unknown[];
}
interface State {
  error: Error | null;
  keys: unknown[] | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, keys: this.props.resetKeys };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    const changed =
      (props.resetKeys?.length ?? 0) !== (state.keys?.length ?? 0) ||
      (props.resetKeys ?? []).some((k, i) => !Object.is(k, state.keys?.[i]));
    return changed ? { error: null, keys: props.resetKeys } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.label ?? 'A panel'} failed to render`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel crash" role="alert">
        <p>
          <b>{this.props.label ?? 'This part of the page'} could not be shown.</b>{' '}
          <span className="muted small">{this.state.error.message}</span>
        </p>
        <div className="row-actions">
          <button
            type="button"
            className="btn small"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}

/** errorElement for routes: a failed page keeps the rest of the app usable. */
export function RouteError() {
  const err = useRouteError();
  const navigate = useNavigate();
  const message = isRouteErrorResponse(err)
    ? `${err.status} ${err.statusText}`
    : err instanceof Error
      ? err.message
      : String(err);
  if (!isRouteErrorResponse(err)) console.error(err);
  return (
    <div className="panel crash" role="alert">
      <h2>This page could not be shown</h2>
      <p className="muted small">{message}</p>
      <div className="row-actions">
        <button type="button" className="btn" onClick={() => navigate(0)}>
          Reload
        </button>
        <button type="button" className="btn" onClick={() => navigate('/')}>
          Go to the overview
        </button>
      </div>
    </div>
  );
}
