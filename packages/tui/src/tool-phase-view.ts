/**
 * A tool row's phase in its round (docs/feat/parallel-tools.md): pure, no
 * React. A call approved in a parallel group but not started yet is `queued`
 * — `◌ <tool> <arg> · queued`, dim, no spinner, no body — until its
 * `running` signal (then the normal blinking bullet) or its result.
 */
import type { ToolStatus } from "./state.ts";

/** The queued row's glyph (in place of the bullet). */
export const QUEUED_GLYPH = "◌";
/** The queued row's suffix after the subtitle. */
export const QUEUED_SUFFIX = "· queued";

/**
 * A row's status after a phase signal: `queued` moves a running row to
 * queued, `running` a queued row to running. A settled row (`ok`/`error`)
 * never moves; a repeated or stale signal changes nothing.
 */
export function nextToolStatus(current: ToolStatus, phase: "queued" | "running"): ToolStatus {
  if (phase === "queued" && current === "running") {
    return "queued";
  }
  if (phase === "running" && current === "queued") {
    return "running";
  }
  return current;
}

/** The parts of a queued row's header, from the row's title (`toolTitle`). */
export function queuedRow(title: { readonly label: string; readonly subtitle: string }): {
  readonly glyph: string;
  readonly label: string;
  readonly subtitle: string;
  readonly suffix: string;
} {
  return {
    glyph: QUEUED_GLYPH,
    label: title.label,
    subtitle: title.subtitle,
    suffix: QUEUED_SUFFIX,
  };
}
