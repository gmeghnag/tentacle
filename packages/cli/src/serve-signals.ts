/**
 * How a plain `serve` ends on a signal (docs/fix/daemon-records-stale.md): the
 * first one stops it cleanly — record removed, session writes landed, store lock
 * released — and any later one exits at once (a hung disk must not trap the
 * user). SIGHUP is included: unhandled, closing the terminal kills the process
 * with no cleanup at all (D2).
 */

export const SERVE_STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type ServeStopSignal = (typeof SERVE_STOP_SIGNALS)[number];

const SIGNAL_NUMBER: Record<ServeStopSignal, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

export type ShutdownStep = { readonly kind: "stop" } | { readonly kind: "exit"; code: number };

/** What one more handled signal means, given whether a stop is already under way. */
export function shutdownStep(
  state: { readonly stopping: boolean },
  signal: ServeStopSignal,
): ShutdownStep {
  return state.stopping ? { kind: "exit", code: 128 + SIGNAL_NUMBER[signal] } : { kind: "stop" };
}

/** The part of `process` the wiring uses (injected by tests). */
export type SignalHost = Pick<NodeJS.Process, "on" | "off" | "exit">;

/**
 * Listen for the stop signals. `done` resolves once `stop` has settled, either
 * way. `dispose` removes exactly these listeners — the host may own others.
 */
export function awaitServeShutdown(
  host: SignalHost,
  stop: () => Promise<void>,
): { readonly done: Promise<void>; dispose(): void } {
  const state = { stopping: false };
  const listeners: [ServeStopSignal, () => void][] = [];
  const done = new Promise<void>((resolve) => {
    for (const signal of SERVE_STOP_SIGNALS) {
      const listener = (): void => {
        const step = shutdownStep(state, signal);
        if (step.kind === "exit") {
          host.exit(step.code);
          return;
        }
        state.stopping = true;
        void stop().then(resolve, () => resolve());
      };
      listeners.push([signal, listener]);
      host.on(signal, listener);
    }
  });
  return {
    done,
    dispose: () => {
      for (const [signal, listener] of listeners) {
        host.off(signal, listener);
      }
    },
  };
}
