/**
 * The key router's contract (docs/feat/app-decomposition.md S3, Fable H3).
 *
 * Ink calls EVERY active `useInput` listener for one chunk
 * (`ink/build/hooks/use-input.js:89`, `internal_eventEmitter.on('input', …)`;
 * `handleData` returns nothing anyone consumes — no stop-propagation), so key
 * precedence can only be one ORDERED decision inside one handler. `routeKey`
 * (`route.ts`) is that single ordered walk over the layer list
 * (`layers.ts`); the App keeps the ONE `useInput` and only executes what the
 * walk decided.
 *
 * A layer is not "first claimer wins": five of today's layers ACT and PASS
 * (the chord writes its state then lets the key through; the sessions panel
 * disarms and falls through; the dock applies `step.state` on `pass`; the mouse
 * layer hands a restored `[` to line editing; and behind a panel nothing edits
 * — the 14th layer's role, `mouse-stream.ts`'s `swallowBehindPanel`). So a
 * layer returns `{ effects, verdict, carry }`:
 *
 * - `effects` are DATA (never closures), so a layer is pure and unit-testable;
 *   `execute.ts` applies them through the App's narrow host port.
 * - `verdict: "consumed"` stops the walk; `"pass"` continues to the next layer,
 *   its effects already collected.
 * - `carry` is text a passing layer hands to the NEXT consumer (today only the
 *   mouse layer produces one — a restored `[` — and its consumer is line
 *   editing, which is not a layer). An empty carry is the norm.
 */
import type { Key } from "ink";
import type { KeyEffect } from "./effects.ts";
import type { KeySnapshot } from "./snapshot.ts";

/** `consumed` stops the walk; `pass` lets the next layer see the same chunk. */
export type KeyVerdict = "consumed" | "pass";

/** One layer's answer for one chunk. */
export interface LayerStep {
  /** What the App must do, in order. Data only — `execute.ts` runs it. */
  readonly effects: readonly KeyEffect[];
  readonly verdict: KeyVerdict;
  /** Text carried to the next consumer (a restored `[`); `""` when none. */
  readonly carry: string;
}

/** A step that does not act and does not stop the walk. */
export const NOTHING: LayerStep = { effects: [], verdict: "pass", carry: "" };

/** A step that took the chunk with these effects. */
export function consumed(...effects: readonly KeyEffect[]): LayerStep {
  return { effects, verdict: "consumed", carry: "" };
}

/** A step that acted but still lets the key through (the five pass-and-act sites). */
export function passThrough(...effects: readonly KeyEffect[]): LayerStep {
  return { effects, verdict: "pass", carry: "" };
}

/**
 * The layers, IN PRECEDENCE ORDER — the order is the safety property, and the
 * names below are the same names `layers.ts` lists and `route.test.ts` pins.
 */
export type KeyLayerName =
  | "shiftTab"
  | "quitConfirm"
  | "artifactConfirm"
  | "chord"
  | "permission"
  | "ctrlC"
  | "paste"
  | "voice"
  | "sessions"
  | "tree"
  | "dock"
  | "escUpload"
  | "escAbort"
  | "expandAll"
  | "palette"
  | "mouse";

/** One entry of the ordered list: a name and its pure decision. */
export interface KeyLayer {
  readonly name: KeyLayerName;
  /** Pure: reads only the snapshot, never a module or a global. */
  readonly step: (snap: KeySnapshot) => LayerStep;
}

/** What the router hands back for one chunk. */
export interface KeyRoute {
  /** Every effect of every layer the chunk touched, in layer order. */
  readonly effects: readonly KeyEffect[];
  /** The walk's verdict; `pass` means line editing gets the chunk. */
  readonly verdict: KeyVerdict;
  /** The carry from the last passing layer (the mouse layer's restored `[`). */
  readonly carry: string;
  /** The layer that stopped the walk, for tests and debugging; null on `pass`. */
  readonly stoppedAt: KeyLayerName | null;
}

// Re-exported so a layer file needs one import for the contract and the types
// it reads, and `route.ts` needs one for `Key` in its signature.
export type { Key, KeyEffect, KeySnapshot };
