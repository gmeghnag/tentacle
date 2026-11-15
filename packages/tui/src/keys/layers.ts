/**
 * The ONE ordered layer list (docs/feat/app-decomposition.md S3, Owner Q2).
 *
 * Precedence is a safety property, so it lives in exactly one readable place.
 * A new binding is a layer module plus one line in `PURE_LAYERS` — never an edit
 * inside a neighbour's body.
 *
 * **Why the mouse layer is the router's CONTINUATION, not an entry in the walk.**
 * Thirteen layers are pure functions of `KeySnapshot`, so `routeKey` can walk
 * them as data and return their effects for the App to apply. The mouse layer is
 * not: it owns state a per-event function cannot (`useMouse`: the partial-report
 * ref, its 100 ms timer, the click recogniser — S4), and `handleChunk` APPLIES
 * its own effects as it decides. Walking it inside `routeKey` would run the mouse
 * hook's effects BEFORE the earlier layers' collected effects were applied, so a
 * report could read a `dockRef`/`panel` the key path had already changed inline
 * today. It therefore runs after `executeEffects`, exactly where the inline
 * handler had its mouse block: last, and only when nothing above consumed.
 *
 * `LAYER_ORDER` still names all 15 — it is the documented precedence, the thing a
 * review reads and a test pins; `PURE_LAYERS` is the walkable 14.
 */
import type { KeyLayer, KeyLayerName, KeySnapshot } from "./contract.ts";
import { ctrlCLayer, pasteLayer, permissionLayer } from "./layer-dialog.ts";
import {
  dockLayer,
  escAbortLayer,
  escUploadLayer,
  expandAllLayer,
  paletteLayer,
} from "./layer-dock.ts";
import { sessionsLayer, treeLayer } from "./layer-panels.ts";
import { chordLayer, quitConfirmLayer, shiftTabLayer } from "./layer-precedence.ts";
import { voiceKeyLayer } from "./layer-voice.ts";

/** The mouse layer's verdict, as `useMouse.handleChunk` already returns it. */
export type MouseRun = (snap: KeySnapshot) => "consumed" | "pass";

/**
 * The fourteen PURE layers, in precedence order (1–14 of 15). This array IS the
 * precedence: `routeKey` walks it in order and stops at the first `consumed`.
 */
export const PURE_LAYERS: readonly KeyLayer[] = [
  shiftTabLayer,
  quitConfirmLayer,
  chordLayer,
  permissionLayer,
  ctrlCLayer,
  pasteLayer,
  voiceKeyLayer,
  sessionsLayer,
  treeLayer,
  dockLayer,
  escUploadLayer,
  escAbortLayer,
  expandAllLayer,
  paletteLayer,
];

/**
 * The documented order of all 15 layers, as names: what a review reads and what
 * `route.test.ts` pins (a test asserts `PURE_LAYERS` is this list minus the last
 * entry, so the two can never drift apart).
 */
export const LAYER_ORDER: readonly KeyLayerName[] = [
  "shiftTab",
  "quitConfirm",
  "chord",
  "permission",
  "ctrlC",
  "paste",
  "voice",
  "sessions",
  "tree",
  "dock",
  "escUpload",
  "escAbort",
  "expandAll",
  "palette",
  "mouse",
];
