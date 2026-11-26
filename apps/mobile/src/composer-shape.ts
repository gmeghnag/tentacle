/**
 * The composer's SHAPE (docs/feat/mobile-composer-compact.md, owner OD1–OD3 +
 * orchestrator D1–D5): the field is ONE row at rest — `+`, the hint and the mic —
 * and today's two rows while it is focused or HOLDS something. Pure and
 * React-free (AGENTS §7): `Composer.tsx` only branches on what this returns, so
 * the whole truth table is tested without a simulator.
 *
 * The rules, and nothing else:
 * - **open** iff the field has the focus (the person tapped it) OR it holds
 *   something (OD3): a draft that is not `""` (whitespace counts — it is the
 *   person's text, D1), any attachment chip whatever its state, a dictation in
 *   any non-idle mic state (`preparing` is asking permission or downloading the
 *   model), or a pending message being edited (the banner above the field);
 * - the **resting row draws no dead control** (OD2): the send slot is drawn
 *   unless its face is the dimmed ↑ (`up-dim`, `sendSlot`'s "nothing to send"),
 *   so ■ Stop, ↑ and the clock stay exactly as they are — and ■ Stop does NOT
 *   open the field (D3);
 * - the open shape is TODAY, unchanged (D2), dimmed ↑ included;
 * - a compact row that carries the ⇥ Send now pill shows NO hint (D4): the pill
 *   is an action and a hint that needs ~128 pt would wrap on a 402 pt phone.
 */
import type { SendSlot } from "./composer.ts";
import type { MicButton } from "./dictation.ts";

export type ComposerShape = "compact" | "open";

export interface ComposerShapeInput {
  /** The field has the focus (the component's onFocus/onBlur, keyed by fieldKey). */
  readonly focused: boolean;
  readonly draft: string;
  /** Attachment chips on screen, any state. */
  readonly attachments: number;
  readonly mic: MicButton;
  /** A pending message is being edited (the banner above the field). */
  readonly editing: boolean;
  /** The slot's face (`sendSlot`). */
  readonly slot: SendSlot;
  /** Send now is offered (`sendNowOffered`). */
  readonly sendNow: boolean;
  /** The hint the screen would show (`SessionScreen`'s placeholder chain). */
  readonly placeholder: string;
}

export interface ComposerShapeView {
  readonly shape: ComposerShape;
  /** Draw the send slot? false only for the dimmed ↑ on a compact row (OD2). */
  readonly slotShown: boolean;
  /** The hint to draw: "" on a compact row that carries the Send now pill (D4). */
  readonly placeholder: string;
}

/** Whether the field holds something that keeps it open (OD3, D1). */
export function composerHolds(
  input: Pick<ComposerShapeInput, "draft" | "attachments" | "mic" | "editing">,
): boolean {
  return (
    input.draft !== "" ||
    input.attachments > 0 ||
    input.mic === "preparing" ||
    input.mic === "listening" ||
    input.mic === "finalizing" ||
    input.editing
  );
}

/** The shape to draw, the slot to show and the hint to write (the whole rule). */
export function composerShape(input: ComposerShapeInput): ComposerShapeView {
  if (input.focused || composerHolds(input)) {
    return { shape: "open", slotShown: true, placeholder: input.placeholder };
  }
  return {
    shape: "compact",
    slotShown: input.slot !== "up-dim",
    placeholder: input.sendNow ? "" : input.placeholder,
  };
}
