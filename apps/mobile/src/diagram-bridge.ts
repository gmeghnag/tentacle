/**
 * The phone's diagram bridge validator (docs/feat/model-diagrams.md D5/T5.2):
 * the ONE message the hidden mermaid renderer may send back, reduced to a value
 * the app can trust — or dropped.
 *
 * Why it exists: mermaid runs model (and pod) text. A mermaid XSS inside the
 * hidden renderer could post messages of its own, so an answer is untrusted
 * ARRIVAL: it must carry an id the app asked for, and exactly the driver's shape
 * — one `ok: true` variant with an SVG and its size, or one `ok: false` variant
 * with a line and a sentence. Anything else (an extra key, a NaN dimension, an
 * oversize SVG, a control byte in a sentence that ends up on screen) is dropped
 * and the row shows the source instead.
 *
 * What this does NOT do: sanitise the SVG's markup. The display WebView is inert
 * (`javaScriptEnabled={false}`, no bridge) under `artifactCsp()` (D6), so even a
 * `<script>` inside an accepted SVG never executes.
 *
 * Pure: no React, no I/O.
 */

/** The SVG cap: an accepted `svg` longer than this (in BYTES) is dropped. */
export const DIAGRAM_SVG_MAX_BYTES = 512 * 1024;

/** A rendered size is finite and inside `(0, 20000]` points. */
export const DIAGRAM_DIM_MAX = 20000;

/** A refusal's line is a sane integer (the source's own cap is 400 lines). */
export const DIAGRAM_LINE_MAX = 10_000;

/** A refusal's sentence is one capped line, never a whole mermaid stack. */
export const DIAGRAM_MESSAGE_MAX = 300;

/** C0/C1 controls: a sentence reaches the screen, so it never carries one. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** What an accepted answer is: a drawn SVG with its size, or a refusal. */
export type DiagramReply =
  | {
      readonly ok: true;
      /** The id the app asked with (it correlates a stale answer). */
      readonly id: string;
      readonly svg: string;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly ok: false;
      readonly id: string;
      /** 1-based line in the source, `0` when the renderer could not name one. */
      readonly line: number;
      readonly message: string;
    };

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Does this object carry exactly `keys` (no extra, none missing)? */
function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

/** An SVG we can hand to an inert `html` document: one closed `<svg>` root. */
function isSvg(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!/^<svg[\s>]/i.test(trimmed) || !/<\/svg>$/i.test(trimmed)) return false;
  return encoder.encode(trimmed).byteLength <= DIAGRAM_SVG_MAX_BYTES;
}

/** A dimension inside `(0, max]`, finite (NaN and ±Infinity are not numbers here). */
function isDim(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= DIAGRAM_DIM_MAX
  );
}

/** A sentence stripped of control bytes and cut to {@link DIAGRAM_MESSAGE_MAX}. */
function cleanMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(CONTROLS, " ").trim();
  if (clean === "") return null;
  if (clean.length <= DIAGRAM_MESSAGE_MAX) return clean;
  return `${clean.slice(0, DIAGRAM_MESSAGE_MAX - 1)}…`;
}

/**
 * The renderer's message as a trusted value, or `null` when it is not one of the
 * two shapes the driver promises for an id in `asked`.
 */
export function parseDiagramReply(raw: unknown, asked: ReadonlySet<string>): DiagramReply | null {
  if (!isRecord(raw)) return null;
  const { id, ok } = raw;
  if (typeof id !== "string" || !asked.has(id)) return null;
  if (ok === true) {
    if (!hasExactly(raw, ["id", "ok", "svg", "w", "h"])) return null;
    const { svg, w, h } = raw;
    if (!isSvg(svg) || !isDim(w) || !isDim(h)) return null;
    return { ok: true, id, svg: svg.trim(), width: w, height: h };
  }
  if (ok === false) {
    if (!hasExactly(raw, ["id", "ok", "line", "message"])) return null;
    const { line, message } = raw;
    if (
      typeof line !== "number" ||
      !Number.isInteger(line) ||
      line < 0 ||
      line > DIAGRAM_LINE_MAX
    ) {
      return null;
    }
    const text = cleanMessage(message);
    if (text === null) return null;
    return { ok: false, id, line, message: text };
  }
  return null;
}
