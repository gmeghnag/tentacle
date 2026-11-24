/**
 * docs/feat/workflow-editor.md D8 — what a GESTURE in the editor means (slice 7a).
 *
 * `workflow-edit-graph.ts` (D6) answers "what is at this point"; this answers the
 * next question, the one the screen would otherwise have to branch on: given what
 * was tapped (or where a `✗` port was released) and what is armed right now, what
 * does the draft do, and what stays armed. Pure and React-free (AGENTS §7), so the
 * arm-then-tap path, the drag path, the long-press menu and the three strings the
 * header and the bar show are testable with no renderer and no simulator
 * (`apps/mobile/test/workflow-edit-actions.test.ts`). `screens/WorkflowEdit.tsx`
 * maps an intent onto elements, and decides nothing.
 *
 * Two rules earn their keep here:
 * - **one rule for both gestures.** D6 requires the one-handed path (tap the `✗`,
 *   then tap the step) and the drag to agree, so a release point goes through
 *   `dropTargetAt` and a tap on a step goes through the SAME accept/refuse: both
 *   answer `saveFail`, and `setFailTarget`'s own refusal ("itself — use Retry") is
 *   the sentence the bar shows. A drop on the port's own step is therefore refused
 *   by the ONE place that knows why, never by a second copy of the wording here.
 * - **an armed port is a state, not a mode.** Anything that is not a step — a
 *   `＋`, a label, the canvas itself — disarms it, so a stray tap can never leave
 *   the NEXT tap meaning something else.
 */
import { type DraftPrompts, type InsertAt, type WorkflowDraft, deleteStep } from "@tentacle/core";
import type { EditGeometry, EditLabel, EditTarget } from "./workflow-edit-graph.ts";
import { dropTargetAt, hitContains } from "./workflow-edit-graph.ts";

/**
 * What the draft does next. `insert` and `open` are REPORTED, never dropped: the
 * kind picker and the step sheet are slice 7b's, and an intent the screen cannot
 * finish yet is still one name for it rather than a branch that grows in a view.
 */
export type EditIntent =
  | { readonly kind: "none" }
  /** The `＋` on an edge (or at the end): the kind picker, then `insertStep`. */
  | { readonly kind: "insert"; readonly at: InsertAt }
  /** A step, or a label on its edge: the step sheet opens that step. */
  | { readonly kind: "open"; readonly id: string; readonly which?: EditLabel["which"] }
  /** A `✗` drop: `setFailTarget(id, target)`, whose refusal is the core's own. */
  | { readonly kind: "saveFail"; readonly id: string; readonly target: string }
  | { readonly kind: "duplicate"; readonly id: string }
  | { readonly kind: "move"; readonly id: string; readonly by: number }
  | { readonly kind: "remove"; readonly id: string };

/** A gesture's whole answer: the intent, and what stays armed after it. */
export interface GestureResult {
  /** The step whose `✗` port is armed now (`null` = nothing). */
  readonly armed: string | null;
  readonly intent: EditIntent;
}

const NOTHING: EditIntent = { kind: "none" };

/**
 * A tap on the canvas. In the mockup's one order (`editTargetAt` already ranked
 * the hit): a `＋` inserts, a `✗` port arms itself, a step taken while a port is
 * armed IS the drop, and anything else — a step with nothing armed, a label, the
 * canvas — puts an armed port down.
 */
export function tapIntent(armed: string | null, target: EditTarget | null): GestureResult {
  if (target === null) {
    // The canvas: an armed port is simply put down, so the next tap is a tap again.
    return { armed: null, intent: NOTHING };
  }
  switch (target.kind) {
    case "plus":
      return { armed: null, intent: { kind: "insert", at: target.insertAt } };
    case "port":
      // A re-tap of the armed port is the same arm: it never toggles itself off.
      return { armed: target.id, intent: NOTHING };
    case "node":
      return armed === null
        ? { armed: null, intent: { kind: "open", id: target.id } }
        : { armed: null, intent: { kind: "saveFail", id: armed, target: target.id } };
    case "label":
      // A label opens the step the edge leaves, on that edge's own field (7b).
      return { armed: null, intent: { kind: "open", id: target.id, which: target.which } };
  }
}

/**
 * A `✗` port released at `(x, y)`: `dropTargetAt`'s answer decides, so the drag
 * and the tap path can never disagree. Nothing under the point is a put-down.
 */
export function dragIntent(
  geometry: EditGeometry,
  portId: string,
  x: number,
  y: number,
): GestureResult {
  const target = dropTargetAt(geometry, portId, x, y);
  if (target === null) {
    // Released over nothing: the port is put down and nothing changes.
    return { armed: null, intent: NOTHING };
  }
  // `"self"` included on purpose: the core refuses it with its own words.
  return { armed: null, intent: { kind: "saveFail", id: portId, target } };
}

/**
 * A `✗` port's ONE release handler, from a touch measured INSIDE the port's own
 * view (`locationX`/`locationY`): the port is drawn at its hit box, so the
 * addition to the drawing's space happens here, where a test can see it.
 *
 * A release inside the port's hit box is the one-handed TAP (arm it, D6); anywhere
 * else is a drag, resolved by `dropTargetAt`. One handler, so one gesture can
 * never be both — which two handlers on one `Pressable` would silently produce.
 */
export function portRelease(
  armed: string | null,
  geometry: EditGeometry,
  portId: string,
  locationX: number,
  locationY: number,
): GestureResult {
  const port = geometry.ports.find((candidate) => candidate.id === portId);
  if (port === undefined) {
    return { armed: null, intent: NOTHING };
  }
  const x = port.hit.x + locationX;
  const y = port.hit.y + locationY;
  if (hitContains(port.hit, x, y)) {
    // A slight move inside its own box is still a tap: only leaving it is a drag.
    return tapIntent(armed, { kind: "port", id: portId });
  }
  return dragIntent(geometry, portId, x, y);
}

/**
 * What a long-press menu row does to the draft. Every one of these completes with
 * no sheet at all (the two that open one report `open`/`insert`).
 */
export type MenuIntent = Exclude<EditIntent, { readonly kind: "none" | "saveFail" }>;

/** One row of the long-press menu. */
export interface EditMenuItem {
  readonly label: string;
  /** Glyph AND word: the owner is colour-blind, so never meaning by hue alone. */
  readonly glyph: string;
  /** Nothing to do (`Move up` on the first step): dimmed, never hidden. */
  readonly off: boolean;
  readonly destructive?: boolean;
  readonly intent: MenuIntent;
}

export interface EditMenu {
  readonly items: readonly EditMenuItem[];
  /** Written under Delete, BEFORE it happens (`deleteStep`'s `dangling`). */
  readonly note: string | null;
}

/**
 * The long-press menu on a step (D8's own list): Open / Insert after / Duplicate /
 * Move up / Move down / Delete. The moves are dimmed at the ends of the list, and
 * Delete is last, destructive, with the references it will break written under it.
 */
export function editMenuModel(input: {
  readonly id: string;
  /** `deleteStep`'s `dangling`: the steps still pointing at this one. */
  readonly dangling: readonly string[];
  /** The step's index in the file's `steps:` and that array's length. */
  readonly index: number;
  readonly count: number;
}): EditMenu {
  const n = input.dangling.length;
  return {
    items: [
      { label: "Open", glyph: "→", off: false, intent: { kind: "open", id: input.id } },
      {
        label: "Insert after",
        glyph: "+",
        off: false,
        intent: { kind: "insert", at: { after: input.id } },
      },
      { label: "Duplicate", glyph: "⧉", off: false, intent: { kind: "duplicate", id: input.id } },
      {
        label: "Move up",
        glyph: "↑",
        off: input.index <= 0,
        intent: { kind: "move", id: input.id, by: -1 },
      },
      {
        label: "Move down",
        glyph: "↓",
        off: input.index >= input.count - 1,
        intent: { kind: "move", id: input.id, by: 1 },
      },
      {
        label: "Delete",
        glyph: "⌫",
        off: false,
        destructive: true,
        intent: { kind: "remove", id: input.id },
      },
    ],
    note:
      n === 0
        ? null
        : `${n} ${n === 1 ? "link points" : "links point"} here: ${input.dangling.join(", ")}`,
  };
}

/** The undo toast after a delete: "Deleted gate" (the mockup's wording). */
export function deletedToast(id: string): string {
  return `Deleted ${id}`;
}

/** A draft's `steps:` as mappings; a structurally broken draft has none. */
function stepsOf(draft: WorkflowDraft): readonly Readonly<Record<string, unknown>>[] {
  const steps = draft.steps;
  return Array.isArray(steps) ? (steps as Readonly<Record<string, unknown>>[]) : [];
}

/**
 * How many steps the bar counts. `editGeometry` draws one pill per step PLUS a
 * ghost pill per reference that names no step, so the count is the `steps:` array
 * itself — "Valid · 2 steps" must never claim a third pill is a step.
 */
export function drawnSteps(draft: WorkflowDraft): number {
  return stepsOf(draft).length;
}

/**
 * Everything `editMenuModel` needs, read from the draft: the step's position in
 * `steps:` (the moves' ends) and `deleteStep`'s own `dangling` — the exact steps
 * that still point at it, so the note under Delete is what the operation will
 * report, never a second count here.
 *
 * The delete runs on a THROWAWAY draft inside the core (every op is pure and
 * immutable), so reading `dangling` before the person confirms cannot touch the
 * draft on screen.
 */
export function menuInputs(input: {
  readonly draft: WorkflowDraft;
  readonly prompts: DraftPrompts;
  readonly id: string;
}): { readonly dangling: readonly string[]; readonly index: number; readonly count: number } {
  const steps = stepsOf(input.draft);
  const index = steps.findIndex((step) => step.id === input.id);
  const removed = deleteStep(input.draft, input.id, input.prompts);
  return { dangling: removed.dangling ?? [], index, count: steps.length };
}

/**
 * A long-press menu ROW picked. The menu is not the canvas: its rows are
 * commands, none of them a place to drop a `✗`, so the arm is put down — and it
 * must be, because `armed` is a step id and a row can DELETE that step. Keeping
 * the arm through it leaves a `✗` aimed at a step that no longer exists: the
 * next tap on any step is then read as a drop on the gone id, the step never
 * opens, and the bar shows `no step "gate"` instead. One rule, here, so every
 * menu row answers it the same way.
 */
export function menuGesture(intent: EditIntent): GestureResult {
  return { armed: null, intent };
}

/**
 * What an intent needs from the caller — exactly the `WorkflowEditController`
 * methods the gestures reach, so the screen hands its controller in and decides
 * nothing itself (AGENTS §7). `insert` and `open` belong to slice 7b's sheets: a
 * caller that has no sheet yet leaves them out, and the intent is reported up
 * rather than guessed at.
 */
export interface EditActions {
  readonly insert?: (at: InsertAt) => void;
  readonly open?: (id: string, which?: EditLabel["which"]) => void;
  readonly duplicate: (id: string) => void;
  readonly move: (id: string, by: number) => void;
  readonly remove: (id: string) => void;
  /** `setFailTarget`: `"self"` included, so the core's own refusal is the sentence. */
  readonly setFail: (id: string, target: string) => void;
}

/**
 * Carry an intent out: one controller call per intent, or nothing. `insert` and
 * `open` are the only two that can be absent (no sheet yet); a `move` on a row
 * the menu dimmed never reaches here, so the guard is the menu's.
 */
export function applyIntent(actions: EditActions, intent: EditIntent): void {
  switch (intent.kind) {
    case "none":
      return;
    case "insert":
      actions.insert?.(intent.at);
      return;
    case "open":
      actions.open?.(intent.id, intent.which);
      return;
    case "duplicate":
      actions.duplicate(intent.id);
      return;
    case "move":
      actions.move(intent.id, intent.by);
      return;
    case "remove":
      actions.remove(intent.id);
      return;
    case "saveFail":
      actions.setFail(intent.id, intent.target);
  }
}

/**
 * The header's second line: what the draft on screen IS, in the mockup's words.
 * Review and the write say "nothing written yet"; a landed save names its version.
 */
export function draftCaption(input: {
  /** `EditState.kind`: only `reviewing`/`saving`/`saved` read differently. */
  readonly phase: string;
  /** The version a landed save reported (`state.saved`), or null. */
  readonly savedVersion: number | null;
}): string {
  if (input.phase === "reviewing" || input.phase === "saving") {
    return "nothing written yet";
  }
  if (input.phase === "saved" && input.savedVersion !== null) {
    return `v${input.savedVersion} · saved`;
  }
  return "Draft · not saved";
}

/**
 * The bottom bar's one line: why Save is off (the first problem, verbatim, with
 * its YAML path), else the draft's state in words.
 */
export function barLine(input: {
  readonly saveOff: string | null;
  readonly steps: number;
}): string {
  if (input.saveOff !== null) {
    return input.saveOff;
  }
  return `Valid · ${input.steps} ${input.steps === 1 ? "step" : "steps"}`;
}
