/**
 * Repaint only the rows that changed (docs/fix/tui-line-diff-render.md).
 *
 * Ink 5 writes every frame as ONE `stdout.write(eraseLines(n) + body)`: erase the
 * whole frame bottom-up, then draw all of it again. A terminal without DEC mode
 * 2026 (Terminal.app, …) paints that erase-then-draw window: the flash. While
 * "Thinking…" only one row changes per tick.
 *
 * `lineDiffStdout` recognizes that write and replaces it with "move to each
 * changed row, erase it, write it", then parks the cursor where Ink believes it
 * is (column 1 of the frame's last line), so Ink's NEXT write — recognized or
 * not — lands exactly as it would have.
 *
 * Rule: when in doubt, emit Ink's bytes and forget the previous frame. Anything
 * not recognized (a clear-terminal frame, `log.clear()`, a `useStdout().write`,
 * a non-string, a size change, a height change, a row leaving SGR open, any
 * escape other than SGR) passes through verbatim; the worst case is exactly
 * Ink's behaviour for one frame. The wrapper adds no write of its own.
 *
 * The parsing and the diff are pure; `lineDiffStdout` is the thin stateful shell.
 */
import type { SyncStream } from "./sync-output.ts";

/** The kill switch: `TENTACLE_TUI_FULL_REDRAW=1` keeps Ink's full-frame writes. */
export const FULL_REDRAW_ENV = "TENTACLE_TUI_FULL_REDRAW";

/** Whether `startTui` wraps stdout in `lineDiffStdout` (off only via the kill switch). */
export function lineDiffEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[FULL_REDRAW_ENV] !== "1";
}

/** `ansi-escapes` 7.3.0 `eraseLines(n)`, the copy Ink 5.0.1 resolves (pinned by a test). */
export function eraseLines(count: number): string {
  let clear = "";
  for (let i = 0; i < count; i++) clear += `\x1b[2K${i < count - 1 ? "\x1b[1A" : ""}`;
  if (count) clear += "\x1b[G";
  return clear;
}

/** A recognized Ink frame write: the lines it erased, then the body split on `"\n"`. */
export interface FrameWrite {
  erased: number;
  /** The body's rows; the last one is the empty piece after the trailing `"\n"`. */
  rows: string[];
}

const ERASE_PREFIX = /^(?:(?:\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G)?/;
const SGR = /\x1b\[([0-9;:]*)m/g;
// Any control byte except "\t" and "\n", once SGR sequences are removed.
const FORBIDDEN = /[\x00-\x08\x0b-\x1f\x7f]/;

/**
 * The rows of `chunk` iff it is exactly Ink's `eraseLines(n) + body`: `body`
 * ends in `"\n"` and carries no escape other than SGR and no control byte other
 * than `"\t"`/`"\n"`. Otherwise `null`.
 */
export function parseFrameWrite(chunk: string): FrameWrite | null {
  const prefix = ERASE_PREFIX.exec(chunk)?.[0] ?? "";
  const erased = prefix.split("\x1b[2K").length - 1;
  if (prefix !== eraseLines(erased)) return null;
  const body = chunk.slice(prefix.length);
  if (!body.endsWith("\n")) return null;
  if (FORBIDDEN.test(body.replace(SGR, ""))) return null;
  return { erased, rows: body.split("\n") };
}

/** SGR parameter (not a reset, not in CLOSES) → the attribute class it opens. */
function sgrClass(param: string): string {
  const head = param.split(":")[0] ?? "";
  const n = Number(head);
  if (n === 1 || n === 2) return "intensity";
  if (n === 4 || n === 21) return "underline";
  if (n === 5 || n === 6) return "blink";
  if ((n >= 30 && n <= 38) || (n >= 90 && n <= 97)) return "fg";
  if ((n >= 40 && n <= 48) || (n >= 100 && n <= 107)) return "bg";
  const plain: Record<number, string> = {
    3: "italic",
    7: "inverse",
    8: "hidden",
    9: "strike",
    53: "overline",
    58: "ulcolor",
  };
  return plain[n] ?? `unknown:${head}`;
}

const CLOSES: Record<string, string> = {
  "22": "intensity",
  "23": "italic",
  "24": "underline",
  "25": "blink",
  "27": "inverse",
  "28": "hidden",
  "29": "strike",
  "39": "fg",
  "49": "bg",
  "55": "overline",
  "59": "ulcolor",
};

/**
 * Whether `row` ends with an SGR attribute still open. Conservative: an
 * unrecognized code counts as open until a full reset.
 */
export function sgrOpenAtEnd(row: string): boolean {
  const open = new Set<string>();
  for (const m of row.matchAll(SGR)) {
    const params = (m[1] ?? "").split(";");
    for (let i = 0; i < params.length; i++) {
      const p = params[i] ?? "";
      const n = Number(p);
      if (p === "" || n === 0) {
        open.clear();
        continue;
      }
      const closed = p === "4:0" ? "underline" : CLOSES[p];
      if (closed) {
        open.delete(closed);
        continue;
      }
      open.add(sgrClass(p));
      // 38/48/58;5;n and 38/48/58;2;r;g;b carry their colour as extra params.
      if (n === 38 || n === 48 || n === 58) {
        const mode = params[i + 1];
        i += mode === "5" ? 2 : mode === "2" ? 4 : 0;
      }
    }
  }
  return open.size > 0;
}

const up = (d: number) => (d > 0 ? `\x1b[${d}A` : "");
const down = (d: number) => (d > 0 ? `\x1b[${d}B` : "");

/**
 * The bytes that turn the screen showing `prev` into `next`, starting and ending
 * with the cursor at column 1 of the frame's last line (`prev.length - 1`),
 * where Ink leaves it. Relative moves only: the anchor stays Ink's.
 *
 * `null` (= write Ink's own bytes) when the heights differ, or when a row of
 * either frame leaves SGR open (a row would then inherit a neighbour's colour,
 * which a per-row repaint cannot reproduce). `""` when nothing changed.
 */
export function diffFrame(prev: readonly string[], next: readonly string[]): string | null {
  if (prev.length !== next.length) return null;
  if (prev.some(sgrOpenAtEnd) || next.some(sgrOpenAtEnd)) return null;
  const last = next.length - 1;
  let cursor = last;
  let out = "";
  for (let i = 0; i < next.length; i++) {
    const row = next[i] ?? "";
    if (row === prev[i]) continue;
    out += `${cursor > i ? up(cursor - i) : down(i - cursor)}\r\x1b[2K${row}`;
    cursor = i;
  }
  if (out === "") return "";
  return `${out}${down(last - cursor)}\r`;
}

/**
 * A delegating view of `stream` whose Ink frame writes repaint only the changed
 * rows. Same shape as `synchronizedStdout`: LIVE `columns`/`rows`/`isTTY`
 * getters, listeners on `stream` itself. Ink must write to it DIRECTLY, and it
 * writes to `synchronizedStdout`: `lineDiffStdout(synchronizedStdout(stdout))`,
 * so it parses Ink's raw frame and each diff is still one synchronized update.
 */
export function lineDiffStdout(stream: SyncStream): SyncStream {
  // The last frame on screen (rows as Ink wrote them) and the size it was drawn at.
  let prev: string[] | null = null;
  let size = "";
  const wrapper: SyncStream = {
    write: (chunk, ...rest) => {
      const frame = typeof chunk === "string" && chunk.length > 0 ? parseFrameWrite(chunk) : null;
      if (!frame) {
        prev = null;
        return stream.write(chunk, ...rest);
      }
      const now = `${stream.columns}x${stream.rows}`;
      // Ink erases exactly the frame we recorded, at the same size ⇒ the frame's
      // top line is ours: rewrite only what differs.
      if (prev && size === now && frame.erased === prev.length) {
        const diff = diffFrame(prev, frame.rows);
        if (diff !== null) {
          prev = frame.rows;
          return stream.write(diff, ...rest);
        }
      }
      prev = frame.rows;
      size = now;
      return stream.write(chunk, ...rest);
    },
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
