/**
 * The detail's **skeleton** as layout boxes (docs/feat/agent-workflows.md slice 8;
 * spec `docs/feat/agent-workflows/transition.html` variant A: "le righe del
 * dettaglio come segnaposto grigi che luccicano, già nelle posizioni finali").
 *
 * The failure this exists to prevent is the one in the plan's table — "detail data
 * late → skeleton holds the final layout; no reflow". So the module is written the
 * other way round from a placeholder kit: the boxes come from the LOADED view's own
 * layout, not from a hand-drawn approximation. `skeletonLayout(view)` takes the
 * detail view the screen is about to render and returns one bar per piece of text
 * it will hold; a test asserts the two layouts' boxes are equal, which is exactly
 * "nothing moves when the data lands".
 *
 * The bars are ROWS, not guesses about glyph widths: a bar spans its row's full
 * content width whatever the text turns out to say, so a long reason and a short
 * one occupy the same box. Width variation inside a bar (`widthFraction`) is only
 * the last line's ragged end, the detail that makes a skeleton read as text rather
 * than as a table.
 *
 * Pure and React-free (AGENTS §7).
 */
import { oneLine } from "./activity.ts";
import { type TextStyleToken, typography } from "./theme.ts";

/** How a bar behaves: `pulse` shimmers in place, `still` fades in once and holds. */
export type BarMotion = "pulse" | "still";

export interface SkeletonBar {
  readonly key: string;
  /** Its top-left box, in the same coordinate space the loaded rows use. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  /** The bar's own width, when it is shorter than its box (a ragged last line). */
  readonly widthFraction: number;
  readonly motion: BarMotion;
}

/** The vertical rhythm of a detail: the same numbers the loaded rows are laid out with. */
export const DETAIL = {
  inset: 16,
  /** The hero header (the pill the graph's node morphs into) and its gap to the rows. */
  heroHeight: 68,
  heroGap: 14,
  /** One `key · value` row's height and the gap between two. */
  rowHeight: 20,
  rowGap: 8,
  /** A block's (kv list, log) height above its first row. */
  blockGap: 16,
  /** The action row's height. */
  actionHeight: 44,
  /** A bar is the text's line height, a hair shorter than the box it sits in. */
  barTrim: 4,
  barRadius: 4,
} as const;

/** The sections a detail view is built from, in the order the screen draws them. */
export interface DetailBlocks {
  /** `key · value` pairs: Stato, Tipo, Modello, Dove, Prompt, Token, Durata, Ramo. */
  readonly kv: readonly (readonly [string, string])[];
  /** Free log/reason text, already split into lines. */
  readonly log: readonly string[];
  /** How many buttons the action row holds (0 → no row). */
  readonly actions: number;
}

/** The loaded layout's own boxes, for the test (and the renderer) to compare against. */
export interface DetailBox {
  readonly key: string;
  readonly section: "hero" | "kv" | "log" | "actions";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function lineHeightOf(token: TextStyleToken): number {
  return token.lineHeight;
}

/** Where the content column starts and how wide it is, inside a detail of `width`. */
function content(width: number): { readonly x: number; readonly width: number } {
  return { x: DETAIL.inset, width: Math.max(0, width - DETAIL.inset * 2) };
}

/**
 * The LOADED detail's boxes: one per piece of text, in the order it is drawn. The
 * skeleton derives from this (below), so the two cannot drift — a new row type
 * added here appears in both, and a test compares them box by box.
 */
export function detailLayout(view: DetailBlocks, width: number): readonly DetailBox[] {
  const area = content(width);
  const boxes: DetailBox[] = [];
  let y = DETAIL.inset;
  boxes.push({
    key: "hero",
    section: "hero",
    x: area.x,
    y,
    width: area.width,
    height: DETAIL.heroHeight,
  });
  y += DETAIL.heroHeight + DETAIL.heroGap + DETAIL.blockGap;

  view.kv.forEach(([label], i) => {
    boxes.push({
      key: `kv-${label}-${i}`,
      section: "kv",
      x: area.x,
      y,
      width: area.width,
      height: DETAIL.rowHeight,
    });
    y += DETAIL.rowHeight + DETAIL.rowGap;
  });

  if (view.log.length > 0) {
    y += DETAIL.blockGap;
    view.log.forEach((_line, i) => {
      boxes.push({
        key: `log-${i}`,
        section: "log",
        x: area.x,
        y,
        // A log line is drawn in the mono token: its box is that line's height.
        width: area.width,
        height: lineHeightOf(typography.mono),
      });
      y += lineHeightOf(typography.mono);
    });
  }

  if (view.actions > 0) {
    y += DETAIL.blockGap;
    boxes.push({
      key: "actions",
      section: "actions",
      x: area.x,
      y,
      width: area.width,
      height: DETAIL.actionHeight,
    });
  }
  return boxes;
}

/** The total height a detail needs, so the screen can reserve it before data lands. */
export function detailHeight(view: DetailBlocks, width: number): number {
  const boxes = detailLayout(view, width);
  const last = boxes[boxes.length - 1];
  return (last === undefined ? DETAIL.inset : last.y + last.height) + DETAIL.inset;
}

/**
 * The last-line fraction: a text block's final line is shorter than its box, so a
 * skeleton's last bar is too. Deterministic from the block's own length — never
 * `Math.random`, which would re-shimmer differently on every render.
 */
export function raggedFraction(lineCount: number): number {
  // A short block ends near its half, a long one near its full width: the tail is
  // what carries the "text ends here" cue, not a decorative wobble.
  return lineCount <= 1 ? 0.55 : lineCount <= 3 ? 0.72 : 0.88;
}

/**
 * What the skeleton draws for a detail that has NOT loaded: the same boxes, with a
 * bar in each, and its bars' motion from Reduce Motion (owner's rule: Reduce
 * Motion → a STATIC skeleton, never no skeleton — the layout still has to hold).
 */
export function skeletonBars(
  view: DetailBlocks,
  width: number,
  reduceMotion: boolean,
): readonly SkeletonBar[] {
  return skeletonFromLayout(detailLayout(view, width), {
    motion: reduceMotion ? "still" : "pulse",
    logLines: view.log.length,
  });
}

/** Whether the shimmer runs at all: Reduce Motion stills it, it never removes it. */
export function skeletonMotion(reduceMotion: boolean): BarMotion {
  return reduceMotion ? "still" : "pulse";
}

function skeletonFromLayout(
  boxes: readonly DetailBox[],
  opts: { readonly motion: BarMotion; readonly logLines: number },
): readonly SkeletonBar[] {
  return boxes.map((box, i) => {
    const isText = box.section === "log" || box.section === "kv";
    const last = i === boxes.length - 1;
    // A bar leaves the loaded box's own padding: the trim makes it read as a line
    // of type rather than a filled panel, and never changes the box it lives in.
    const inset = isText ? DETAIL.barTrim / 2 : 0;
    return {
      key: `bar-${box.key}`,
      x: box.x,
      y: box.y + inset,
      width: box.width,
      height: Math.max(6, box.height - inset * 2),
      // A pill bar is fully rounded (it stands in for the hero/pill), a text bar is
      // the type's own corner (`barRadius`).
      radius: box.section === "hero" ? box.height / 2 : DETAIL.barRadius,
      widthFraction: last && box.section === "log" ? raggedFraction(opts.logLines) : isText ? 1 : 1,
      motion: box.section === "actions" ? "still" : opts.motion,
    };
  });
}

/**
 * A block's text, split for the log area: one plain line each (untrusted text from
 * a pod is flattened, §7), blank lines kept as one space so the rhythm holds.
 */
export function logLines(text: string | undefined): readonly string[] {
  if (text === undefined || text === "") {
    return [];
  }
  return text.split("\n").map((line) => {
    const flat = oneLine(line);
    return flat === "" ? " " : flat;
  });
}

/**
 * The detail's blocks from a step row: the ONE place the kv list is decided, so the
 * skeleton and the loaded view can never list different rows. Every optional field
 * that is absent is ABSENT (not an empty value), exactly as the mockup's
 * `rows.filter(Boolean)` does.
 */
export function detailBlocks(
  step: {
    readonly id: string;
    readonly kind: string;
    readonly state: string;
    readonly model?: string;
    readonly where: string;
    readonly attempt: number;
    readonly round: number;
    readonly maxRound?: number;
    readonly reason?: string;
    readonly durationMs?: number;
  },
  kindWord: (kind: string) => string,
  stateWord: (state: string) => string,
  actionCount: number,
): DetailBlocks {
  const kv: (readonly [string, string])[] = [
    ["Stato", stateWord(step.state)],
    ["Tipo", kindWord(step.kind)],
  ];
  if (step.model !== undefined) {
    kv.push(["Modello", oneLine(step.model)]);
  }
  if (step.where !== "") {
    kv.push(["Dove", oneLine(step.where)]);
  }
  if (step.attempt > 0) {
    kv.push(["Tentativi", `${step.attempt + 1}`]);
  }
  if (step.maxRound !== undefined) {
    kv.push(["Giro", `${Math.max(1, step.round)} di ${step.maxRound}`]);
  }
  if (step.durationMs !== undefined) {
    kv.push(["Durata", `${Math.round(step.durationMs / 100) / 10}s`]);
  }
  return { kv, log: logLines(step.reason), actions: actionCount };
}
