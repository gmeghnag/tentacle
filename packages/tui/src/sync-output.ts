/**
 * DEC synchronized output (mode 2026) around every Ink write
 * (docs/fix/tui-redraw-flash.md).
 *
 * Ink 5 writes each frame as ONE `stdout.write(eraseLines(n) + frame)`: erase the
 * whole screen, then draw it all again. A terminal that paints between the erase
 * and the redraw shows a blank or half-drawn screen for one refresh: the flash.
 * Bracketing each write in BSU … ESU makes a mode-2026 terminal hold its paint
 * until the frame is complete; a terminal without mode 2026 ignores both.
 *
 * The wrapper adds no write of its own: BSU and ESU travel in the SAME string as
 * Ink's chunk, so no "sync left open" state can outlive a write.
 */

/** Begin Synchronized Update (DECSET 2026). */
export const BSU = "\x1b[?2026h";
/** End Synchronized Update (DECRST 2026). */
export const ESU = "\x1b[?2026l";

type Listener = (...args: unknown[]) => void;

/** The subset of a TTY write stream that Ink (and `App`, via `useStdout`) reads. */
export interface SyncStream {
  write(chunk: unknown, ...rest: unknown[]): boolean;
  readonly columns?: number;
  readonly rows?: number;
  readonly isTTY?: boolean;
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
  once(event: string, listener: Listener): unknown;
  addListener(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
}

/**
 * A delegating view of `stream` whose non-empty string writes are each one
 * synchronized update. `columns`/`rows`/`isTTY` are LIVE getters (a copied value
 * would freeze the layout on resize), and listeners go to `stream` itself, so
 * its `resize` events reach Ink and `App` unchanged.
 */
export function synchronizedStdout(stream: SyncStream): SyncStream {
  const wrapper: SyncStream = {
    write: (chunk, ...rest) =>
      typeof chunk === "string" && chunk.length > 0
        ? stream.write(BSU + chunk + ESU, ...rest)
        : stream.write(chunk, ...rest),
    get columns() {
      return stream.columns;
    },
    get rows() {
      return stream.rows;
    },
    get isTTY() {
      return stream.isTTY;
    },
    on: (event, listener) => {
      stream.on(event, listener);
      return wrapper;
    },
    off: (event, listener) => {
      stream.off(event, listener);
      return wrapper;
    },
    once: (event, listener) => {
      stream.once(event, listener);
      return wrapper;
    },
    addListener: (event, listener) => {
      stream.addListener(event, listener);
      return wrapper;
    },
    removeListener: (event, listener) => {
      stream.removeListener(event, listener);
      return wrapper;
    },
  };
  return wrapper;
}
