/**
 * Progress rendering for the pod binary transfer (F4.e).
 *
 * Two presentation modes, chosen by whether stdout is a terminal:
 *   - **interactive** (TTY): the transfer bar is the text of a single
 *     spinner line (see `status-line.ts`), repainted in place — a
 *     `docker pull`-style bar with a live spinner. Driven from
 *     `pod-binary.ts` via an `onStatus` callback.
 *   - **piped** (log / CI / test): one line per ~10% bucket crossed, so a
 *     captured transcript stays readable (no `\r`). That is `TransferProgress`.
 *
 * `renderBar` / `mb` are the pure presenters shared by both modes.
 */

/** One MB (base-2, matching the binary's byte count). */
const MB = 1048576;

/** Format a byte count as MB with one decimal (`89.0`). */
export function mb(bytes: number): string {
  return (bytes / MB).toFixed(1);
}

/**
 * Render the bar for `written`/`total` at a given width, e.g.
 * `▓▓▓░░░░ 33% 29.6/89.0 MB`. The filled+empty cells always sum to `width`,
 * and the percentage/bytes clamp to 100%.
 */
export function renderBar(written: number, total: number, width = 24): string {
  const frac = total > 0 ? Math.min(1, written / total) : 0;
  const filled = Math.round(frac * width);
  const bar = "▓".repeat(filled) + "░".repeat(width - filled);
  const pct = Math.min(100, Math.floor(frac * 100));
  return `${bar} ${pct}% ${mb(written)}/${mb(total)} MB`;
}

export interface TransferProgressOptions {
  /** Total bytes being transferred (known up front). */
  readonly total: number;
  /** The output sink (the caller's `log`). */
  readonly write: (text: string) => void;
  /** Line prefix, e.g. `[pod p-abc123] transfer `. */
  readonly prefix?: string;
  /** Bar width in cells. Default 24. */
  readonly width?: number;
}

/**
 * A **piped** progress reporter: one line per ~10% bucket crossed (first at
 * ≥10%, or immediately at 100%). Feed it `update(written)` calls (the
 * transfer's `onProgress`), then `finish()` once the transfer is done. A tiny
 * transfer that never crosses a bucket logs nothing.
 */
export class TransferProgress {
  private readonly total: number;
  private readonly write: (text: string) => void;
  private readonly prefix: string;
  private readonly width: number;
  private lastBucket = -1;
  private done = false;

  constructor(options: TransferProgressOptions) {
    this.total = options.total;
    this.write = options.write;
    this.prefix = options.prefix ?? "";
    this.width = options.width ?? 24;
  }

  update(written: number): void {
    if (this.done) {
      return;
    }
    const complete = written >= this.total && this.total > 0;
    const pct = this.total > 0 ? Math.min(100, Math.floor((written / this.total) * 100)) : 100;
    const bucket = Math.floor(pct / 10);
    // First line at ≥10% (or immediately at 100%), then one per bucket.
    if (bucket > this.lastBucket && (bucket >= 1 || complete)) {
      this.lastBucket = bucket;
      this.write(`${this.prefix}${renderBar(written, this.total, this.width)}\n`);
      if (complete) {
        this.done = true;
      }
    }
  }

  /** Mark the transfer complete (idempotent; no output for the piped mode). */
  finish(): void {
    this.done = true;
  }
}
