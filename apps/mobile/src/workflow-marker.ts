/**
 * The run view's MARKERS (docs/fix/workflows-ux.md D4, slice S6a): how one phase
 * of `workflow-run-graph.ts`'s shared projection is drawn — the soft tinted disc,
 * the glyph in ink on it, and the word beside it. Pure and React-free (AGENTS §7),
 * so the owner's rule "every state stays distinguishable without colour" is a
 * TEST (`workflow-marker.test.ts`), not a promise: the pairs are checked for a
 * differing glyph or ring, and a differing word.
 *
 * The owner's (ii) tinta, from `.tentacle/mockups/workflow-run-view/markers-v2.html`
 * (colours: the `wr*` tokens in `theme.ts`): a soft circle body per phase with
 * the glyph carrying the contrast, the glyph at ~½ of the disc.
 *
 * Two looks are deliberately NOT glyphs:
 * - `later` (not yet) is a plain soft-grey disc — the owner, explicitly: no ○ and
 *   no dots. `unknown` shares that disc, because a word this build does not know
 *   must not be given a shape it might not have.
 * - `skipped` (not run) is a ring of dots and the `.forward.2` chevron: "there is
 *   nothing here", drawn as an outline rather than a body, plus the word.
 */
import type { WorkflowPhase } from "@tentacle/client";
import { type Palette, size } from "./theme.ts";
import type { IconName } from "./ui/Icon.tsx";

/** How a phase is drawn: `symbol` null = no glyph (the owner's plain disc). */
export interface MarkerLook {
  /** The SF Symbol, or `null` for a body with no glyph. */
  readonly symbol: IconName | null;
  /** The disc's body; `null` = no body at all (a ring is drawn instead). */
  readonly soft: string | null;
  /** The glyph's ink, and the ring's colour where there is no body. */
  readonly ink: string;
  /** A dotted outline instead of a solid one — the "nothing here" shape. */
  readonly ring?: "dotted";
  /** The word a reader is given, whatever the wire called it. */
  readonly word: string;
}

/**
 * The phase → look table. The words are the ones D2's projection uses (`done`,
 * `not run`, `needs approval`, …), because the marker sits beside that word in
 * every surface (pill, rail, hero) and two spellings for one state would read as
 * two states. An `approve` step's own wording ("approved", "denied") and a
 * verdict's ("passed") are the CALLER's, from `WorkflowStepView.word` — see
 * `markerFor`.
 */
export function markerLook(phase: WorkflowPhase, palette: Palette): MarkerLook {
  switch (phase) {
    case "ok":
      return {
        symbol: "checkmark",
        soft: palette.wrOkSoft,
        ink: palette.wrOkInk,
        word: "done",
      };
    case "error":
      return {
        symbol: "multiply",
        soft: palette.wrFailSoft,
        ink: palette.wrFailInk,
        word: "failed",
      };
    case "running":
      return {
        symbol: "play.fill",
        soft: palette.wrRunSoft,
        ink: palette.wrRunInk,
        word: "running",
      };
    case "ask":
      return {
        symbol: "questionmark",
        soft: palette.wrAskSoft,
        ink: palette.wrAskInk,
        word: "needs approval",
      };
    case "later":
      // The owner: no glyph, no ring — a plain soft disc says "not yet".
      return { symbol: null, soft: palette.wrWaitSoft, ink: palette.wrWaitInk, word: "not yet" };
    case "skipped":
      return {
        symbol: "chevron.forward.2",
        soft: null,
        ink: palette.wrSkipInk,
        ring: "dotted",
        word: "not run",
      };
    case "stopped":
      return {
        symbol: "stop.fill",
        soft: palette.wrWaitSoft,
        ink: palette.wrWaitInk,
        word: "stopped",
      };
    default:
      // An unknown wire word: the plain disc, and the word EXACTLY as it arrived.
      return { symbol: null, soft: palette.wrWaitSoft, ink: palette.wrWaitInk, word: "" };
  }
}

/**
 * The look of one projected step: the phase's marker, worded with the step's OWN
 * word where D2 gave it a more specific one — an `approve` step is "approved" or
 * "denied", a review that passed is "passed", and an unknown state keeps the wire's
 * spelling verbatim (never relabelled into a phase this build happens to know).
 */
export function markerFor(
  step: { readonly phase: WorkflowPhase; readonly word: string },
  palette: Palette,
): MarkerLook {
  const look = markerLook(step.phase, palette);
  const word = step.word === "" ? look.word : step.word;
  return { ...look, word };
}

/**
 * The drawn sizes, per surface (D4): 26 pt in a pill (0.6 × the 44 pt pill, the
 * mockup's `--wr-node-badge`), 18 pt in the B rail, 32 pt in the detail hero. The
 * GLYPH is `WR_GLYPH` × the disc — the mockup's 0.54, "SF ink ≈ half the circle".
 */
export const MARKER_SIZE = {
  pill: Math.round(size.touch * 0.6),
  rail: 18,
  hero: 32,
} as const;

/** The glyph's point size per disc diameter: the mockup's `--wr-glyph`. */
export const WR_GLYPH = 0.54;
