/**
 * Pure parsing of SGR (1006) mouse reports from terminal input.
 *
 * A report is `ESC [ < btn ; x ; y (M|m)` — `M` on press/motion, `m` on
 * release. Ink strips the leading ESC before `useInput` sees the data, and a
 * fast wheel or drag coalesces several reports into one chunk, so a single
 * `useInput` call may carry zero, one, or many reports, optionally ending in a
 * half-delivered one. Parsing them all here keeps no report byte from leaking
 * into the text input.
 */

export interface MouseReport {
  /** SGR button code: bit 64 = wheel (65 = wheel down), bit 32 = motion/drag. */
  readonly btn: number;
  /** 1-based column from the report. */
  readonly x: number;
  /** 1-based row from the report. */
  readonly y: number;
  /** `true` for `M` (press/motion), `false` for `m` (release). */
  readonly press: boolean;
}

// A complete report. The ESC is optional: Ink strips the first one, but a
// coalesced chunk keeps the ESC that separates consecutive reports.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal escape sequences
const REPORT_G = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;

// A non-empty, still-incomplete prefix of a report that a later chunk may
// complete (e.g. "[", "[<", "[<65", "[<65;16", "[<65;16;20"). Never a complete
// report, since it stops before the trailing M/m.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches partial escape sequences
const PREFIX_RE = /^\x1b?(\[(<\d*(;\d*(;\d*)?)?)?)?$/;

export interface SplitMouse {
  readonly reports: readonly MouseReport[];
  /** The input with every complete report removed, in order. */
  readonly rest: string;
}

/** Extract every complete mouse report, returning them plus the leftover text. */
export function splitMouseReports(data: string): SplitMouse {
  const reports: MouseReport[] = [];
  const rest = data.replace(REPORT_G, (_full, b, x, y, mm) => {
    reports.push({ btn: Number(b), x: Number(x), y: Number(y), press: mm === "M" });
    return "";
  });
  return { reports, rest };
}

/** Whether `data` is a non-empty, incomplete prefix of a mouse report. */
export function isMousePrefix(data: string): boolean {
  return data !== "" && PREFIX_RE.test(data);
}
