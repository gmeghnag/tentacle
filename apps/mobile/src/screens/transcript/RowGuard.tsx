/**
 * The error boundary around ONE transcript row (docs/fix/mobile-crash-ibm-chart.md).
 * In a release build an uncaught render error aborts the app, and a session
 * re-opens on the same rows — so one row that cannot be drawn became a crash
 * loop. Here it becomes `fallback`, and `onError` hears of it once.
 *
 * It imports only `react` (no React Native) so its contract is unit-tested
 * (`row-guard.test.ts`); what the fallback looks like is the caller's.
 * A failed row stays failed while `resetKey` is unchanged: retrying on every
 * transcript update would throw and log again each time. A new `resetKey` (the
 * row's content changed — a streamed or `replace`d row) retries once.
 */
import { Component, type ReactNode } from "react";

interface RowGuardProps {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
  readonly onError?: (error: unknown) => void;
  /** Identity of the content: a change clears a failure (compared with `!==`). */
  readonly resetKey?: unknown;
}

interface RowGuardState {
  readonly failed: boolean;
  readonly resetKey: unknown;
}

export class RowGuard extends Component<RowGuardProps, RowGuardState> {
  override state: RowGuardState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(
    props: RowGuardProps,
    state: RowGuardState,
  ): Partial<RowGuardState> | null {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }

  static getDerivedStateFromError(): Partial<RowGuardState> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
