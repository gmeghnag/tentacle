/**
 * The voice strip's view-model (docs/feat/voice-dictation.md §5): everything the
 * one-line strip says, computed as DATA so it is unit-testable and the component
 * only draws. Presentation lives here only as far as "which glyphs, how wide";
 * the decisions (is it listening, what is the level, is there a partial) are the
 * reducer's.
 *
 * §6 gotcha respected by the component, not here: a blank row is rendered `" "`.
 */

/** Rows the strip occupies when it is drawn (`App` sizes the viewport). */
export const VOICE_STRIP_ROWS = 2;

/** The meter's glyph ladder, quiet → loud. */
const BARS = ["", "▁", "▁▃", "▁▃▅", "▁▃▅▇"] as const;

/** The width in cells of `s` as the strip measures it (code points, not bytes). */
function cells(s: string): number {
  return [...s].length;
}

/** Cut `s` to `width` cells, ending in an ellipsis when it had to be cut. */
function clip(s: string, width: number): string {
  if (width <= 0) return "";
  if (cells(s) <= width) return s;
  const kept = [...s].slice(0, Math.max(0, width - 1)).join("");
  return `${kept}…`;
}

/** `mm:ss`, truncated (never rounded up: no `0:01` before a second has passed). */
export function elapsedLabel(audioMs: number): string {
  const total = Math.max(0, Math.floor(audioMs / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins)}:${String(secs).padStart(2, "0")}`;
}

/**
 * dBFS → the meter's ladder. The thresholds are the ones V0's smoke logs showed
 * for speech (−35…−15 dBFS peaks) over a −74 dBFS ambient floor, so the meter
 * moves across the range a real voice actually occupies.
 */
export function meterFor(dbfs: number | null): string {
  if (dbfs === null) return "";
  if (dbfs < -60) return BARS[0];
  if (dbfs < -45) return BARS[1];
  if (dbfs < -30) return BARS[2];
  if (dbfs < -15) return BARS[3];
  return BARS[4];
}

/** What the strip shows, or null when it draws nothing at all. */
export interface VoiceStripView {
  /** The one status line, already clipped to the terminal width. */
  readonly text: string;
  /** The dimmed partial preview, already clipped; `""` when there is none. */
  readonly partial: string;
  /** The meter's bars; `""` outside `listening`. */
  readonly meter: string;
  /** The language tag incl. brackets, e.g. `[it]`; `""` when unknown. */
  readonly langTag: string;
}

/**
 * The strip, or `null` when there is nothing to say. Null — not an empty text —
 * because the App must NOT reserve rows for a strip that is not drawn, or every
 * frame while idle would carry two blank lines (AGENTS §6's Ink gotcha).
 */
export function voiceStripView(
  model: {
    readonly phase: "idle" | "starting" | "listening" | "transcribing" | "off";
    readonly audioMs: number;
    readonly dbfs: number | null;
    readonly partial: string;
    readonly lang: string | null;
  },
  { columns }: { readonly columns: number; readonly appName?: string },
): VoiceStripView | null {
  if (model.phase === "idle" || model.phase === "off") return null;

  const meter = model.phase === "listening" ? meterFor(model.dbfs) : "";
  const langTag = model.lang === null ? "" : `[${model.lang}]`;
  const word =
    model.phase === "starting"
      ? "starting"
      : model.phase === "transcribing"
        ? "transcribing"
        : "listening";

  const parts = [`● ${word}`];
  if (model.phase !== "starting") parts.push(elapsedLabel(model.audioMs));
  if (meter !== "") parts.push(meter);
  if (langTag !== "") parts.push(langTag);

  const text = clip(parts.join(" "), columns);
  // The partial gets whatever is left below the status line; a blank preview is
  // `""` and the COMPONENT renders it as `" "` (never an empty <Text>).
  const partial = model.partial === "" ? "" : clip(model.partial, columns);

  return { text, partial, meter, langTag };
}
