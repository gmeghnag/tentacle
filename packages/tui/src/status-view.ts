/**
 * The status bar's token figures (docs/fix/detach-live-followups.md F2, owner
 * OQ5). Pure. The agent reports usage only on a stream's `done`, so until THIS
 * TUI has applied one (a failed first turn, an attach, a `--resume`), nothing
 * was measured: the figures are unknown (`null`, rendered `–`), never a fake 0.
 * The first measured turn gives the real numbers.
 */
import type { DisplayState, TokenTotals } from "./state.ts";

export interface StatusTokens {
  /** The session totals this TUI measured; `null` until the first `usage`. */
  readonly totals: TokenTotals | null;
  /** The last measured prompt (the context fill); `null` until the first `usage`. */
  readonly context: number | null;
}

/** The count the daemon made at open (`session/context`): `exact` = the provider counted it. */
export interface ContextOpen {
  readonly used: number;
  readonly exact: boolean;
}

/**
 * What the ctx meter shows: the figure THIS TUI measured (a turn's usage) wins
 * and is exact; before that, the daemon's count at open (an estimate is
 * `approx`); with neither, unknown (`used: null`).
 */
export function contextShown(
  measured: number | null,
  open: ContextOpen | null,
): { used: number | null; approx: boolean } {
  if (measured !== null) {
    return { used: measured, approx: false };
  }
  return open === null ? { used: null, approx: false } : { used: open.used, approx: !open.exact };
}

/** The figures' last measured values live here; the pill model joins them below. */

/**
 * How long the pill celebrates a child that just ended (`✓ sa-1 done`), in ms
 * (owner: "the pill shows `✓ sa-1 done` for ~5 s, then the new counts").
 */
export const PILL_DONE_MS = 5_000;

/** What the pill shows, decided here (pure; `StatusBar.tsx` only paints it). */
export type PillView =
  /** Nothing in the background: NO pill, and the screen is exactly as before. */
  | { readonly kind: "none" }
  /**
   * The pill itself. `focus`: the input's DOWN has it (inverse/accent paint);
   * `open`: the dropdown is showing (the pill carries `▴`); otherwise `idle`.
   * `ask`: a child is waiting on a permission — the pill turns warning-coloured
   * and names it (`▲ sa-2 asks`), which is how the user knows WHO asks.
   * `done`: a child finished in the last `PILL_DONE_MS` (`✓ sa-1 done`).
   */
  | {
      readonly kind: "pill";
      readonly state: "idle" | "focus" | "open" | "ask" | "done";
      /** `2 agents` (with jobs, `2 agents · 1 shell` — see `PILL_COUNTS`). */
      readonly counts: string;
      /** The `▲ sa-2 asks` / `✓ sa-1 done` prefix, or `""`. */
      readonly notice: string;
      /** `""` when it would not fit: the pill never wraps a status line. */
      readonly hint: string;
    };

/** What the pill knows: the counts by kind, who asks, who just finished. */
export interface PillInput {
  /** Background sub-agents running now. */
  readonly agents: number;
  /** Running shell jobs (P6's feed; 0 today). */
  readonly jobs?: number;
  /** The child waiting on a permission, if any. */
  readonly askingId?: string | null;
  /** The child that just ended and when (ms); `null` when none is in its window. */
  readonly finished?: { readonly id: string; readonly at: number } | null;
  /** Now, for the `~5 s` window. */
  readonly now: number;
  /** The dock's focus (the pill is focused, or the dropdown is open). */
  readonly focus: "input" | "pill" | "dropdown" | "open";
  /** The columns left on the status line for the pill, hint included. */
  readonly width: number;
}

/**
 * The pill's words: `2 agents ↓` unfocused, ` 2 agents ⏎ ` focused, ` 2 agents ▴ `
 * with the dropdown open; `▲ sa-2 asks · 2 agents ↓` / `✓ sa-1 done · 1 agent ↓`.
 *
 * The hint (`enter open · esc back`) sits just LEFT of a focused pill and only
 * when the line is wide enough (the mockups: ≥ 90 columns); under that the pill's
 * own `⏎` is the hint, so nothing is lost and nothing is cut.
 */
export function pillView(input: PillInput): PillView {
  const jobs = input.jobs ?? 0;
  const total = input.agents + jobs;
  if (total <= 0) {
    return { kind: "none" };
  }
  // The counts by kind: a pill that says `3` for two agents and a shell hides
  // what is running; `1 agent` is singular (`2 agents`, `1 shell`).
  const agents = `${input.agents} ${input.agents === 1 ? "agent" : "agents"}`;
  const counts = jobs > 0 ? `${agents} · ${jobs} ${jobs === 1 ? "shell" : "shells"}` : agents;
  const asking = input.askingId ?? null;
  const finished =
    input.finished != null && input.now - input.finished.at < PILL_DONE_MS ? input.finished : null;
  // A child WAITING outranks one that finished: the ask is the thing to act on.
  const notice =
    asking !== null ? `▲ ${asking} asks` : finished !== null ? `✓ ${finished.id} done` : "";
  const state: "idle" | "focus" | "open" | "ask" | "done" =
    input.focus === "pill"
      ? "focus"
      : input.focus === "dropdown" || input.focus === "open"
        ? "open"
        : asking !== null
          ? "ask"
          : finished !== null
            ? "done"
            : "idle";
  return { kind: "pill", state, counts, notice, hint: pillHint(state, input.width) };
}

/** The key hint a FOCUSED pill shows, or `""` (it never crowds a narrow line). */
function pillHint(state: string, width: number): string {
  if (state !== "focus") {
    return "";
  }
  return width >= FOCUS_HINT_MIN_COLS ? "enter open · esc back" : "";
}

/** Below this many columns a focused pill's hint is dropped (the `⏎` says it). */
export const FOCUS_HINT_MIN_COLS = 70;

/** The pill's plain text, exactly as painted (the column range is measured on it). */
export function pillText(view: PillView): string {
  if (view.kind === "none") {
    return "";
  }
  const body =
    view.state === "focus" || view.state === "open"
      ? // Focused/open: the pill is a BUTTON, so its body is padded on both sides
        // and carries its own glyph (`⏎` = active, `▴` = the panel is showing).
        ` ${view.notice === "" ? "" : `${view.notice} · `}${view.counts} ${
          view.state === "open" ? "▴" : "⏎"
        } `
      : `${view.notice === "" ? "" : `${view.notice} · `}${view.counts} ↓`;
  return body;
}

export function statusTokens(
  state: Pick<DisplayState, "sessionTokens" | "lastTurnTokens">,
): StatusTokens {
  const last = state.lastTurnTokens;
  return last === null
    ? { totals: null, context: null }
    : { totals: state.sessionTokens, context: last.prompt };
}
