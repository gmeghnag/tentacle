/**
 * Terminal lifecycle: entering/leaving the alternate screen (+ mouse reporting
 * and bracketed paste) and — crucially — restoring it on *every* way the process
 * can end.
 *
 * `process.once("exit")` fires on a normal/`process.exit()` teardown but NOT on
 * a delivered SIGINT/SIGTERM, so a `kill` (or an editor/CI stopping the process)
 * would otherwise leave the terminal stuck on the alt-screen with `?1000h/?1006h`
 * mouse reporting and `?2004h` paste mode still on — a wrecked shell. We restore
 * on the signals too, then re-exit with the conventional `128 + signum` code.
 *
 * Pure of Ink/React and driven through an injected `ProcessLike`, so it unit-tests
 * without a real TTY or real signals.
 */

// Enter: alternate screen + SGR mouse reporting + bracketed paste. 1000 = button
// events (incl. the wheel), 1002 = also report motion while a button is down
// (drag → text selection), 1006 = extended SGR coordinates, 2004 = wrap pasted
// text in \e[200~ … \e[201~ so a paste is never mistaken for typed control keys.
export const ENTER_FULLSCREEN = "\x1b[?1049h\x1b[H\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h";
// Leave: the exact inverse.
export const LEAVE_FULLSCREEN = "\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l";

/** The slice of `process` this module needs; a fake stands in for it in tests. */
export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code?: number): void;
}

const SIGNAL_EXIT: Readonly<Record<string, number>> = { SIGINT: 130, SIGTERM: 143 };

/**
 * Put the terminal back the way a TUI found it (docs/feat/tui-light-theme.md,
 * Review LOW 5). Pure of Ink: every effect is injected, so the "what" is tested
 * without a TTY (`run.test.ts`), and `startTui` only calls it.
 *
 * Two independent things can be left on:
 *   - the alternate screen / mouse reporting / bracketed paste, when the TUI ran
 *     fullscreen (`LEAVE_FULLSCREEN` is the exact inverse of `ENTER_FULLSCREEN`);
 *   - RAW mode, when the background probe timed out — it deliberately stays raw so
 *     a late reply is never echoed, and Ink's own unmount normally turns it off.
 *     A mount that throws never gets there, so this path must cook the tty itself.
 */
export interface RestoreTarget {
  readonly write: (text: string) => void;
  readonly setRawMode?: ((enabled: boolean) => unknown) | undefined;
}

export function restoreTerminalOnExit(
  target: RestoreTarget,
  state: { readonly fullscreen: boolean; readonly probeWasLate: boolean },
): void {
  if (state.fullscreen) {
    target.write(LEAVE_FULLSCREEN);
  }
  if (state.probeWasLate) {
    try {
      target.setRawMode?.(false);
    } catch {
      // Already gone (a closed pty): nothing left to restore.
    }
  }
}

/**
 * Wire `restore` to normal exit and to SIGINT/SIGTERM. `restore` runs at most
 * once however the process ends. On a signal it runs, then the process exits
 * `128 + signum`. Returns a teardown that removes every listener this installed.
 */
export function installTerminalRestore(proc: ProcessLike, restore: () => void): () => void {
  let restored = false;
  const runOnce = (): void => {
    if (!restored) {
      restored = true;
      restore();
    }
  };
  const onExit = (): void => runOnce();
  const makeSignalHandler =
    (code: number): (() => void) =>
    () => {
      runOnce();
      proc.exit(code);
    };
  const signalHandlers = Object.entries(SIGNAL_EXIT).map(
    ([signal, code]) => [signal, makeSignalHandler(code)] as const,
  );

  proc.on("exit", onExit);
  for (const [signal, handler] of signalHandlers) {
    proc.on(signal, handler);
  }
  return () => {
    proc.off("exit", onExit);
    for (const [signal, handler] of signalHandlers) {
      proc.off(signal, handler);
    }
  };
}
