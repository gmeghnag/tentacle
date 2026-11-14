import { panelStep } from "../panels/registry.ts";
import type { KeyLayer, LayerStep } from "./contract.ts";
/**
 * The panel layers (docs/feat/app-decomposition.md S3, rewired in S7): `/sessions`,
 * then the tree panels (`/mcp`, `/skills`).
 *
 * Order is safety, not taste: the sessions panel's Esc must close the panel
 * rather than reach "Esc stops a running turn" below (S0 precedence pin), and a
 * mouse report must fall through BOTH (it is dispatched by the mouse layer).
 *
 * **S7: this file no longer decides anything.** Each panel kind's descriptor
 * (`panels/<kind>.ts`) declares the layer it claims keys on and its own decision,
 * so a NEW panel picks its layer by existing — the two layers below are just the
 * registry's two known layer names. The "act and pass" behaviours are the
 * descriptors' too and are unchanged:
 * - a non-panel key on an ARMED sessions row DISARMS it and then falls through,
 *   so the key still does its own job (the wheel cancels the delete and scrolls);
 * - a key neither panel claims falls through to the layers below (the mouse
 *   layer then swallows it behind a panel — "behind a panel nothing edits",
 *   the 14th layer's role).
 */

/**
 * 7. `/sessions`: every decision is `sessions-panel.ts`'s, executed by
 * `panels/sessions.ts`. Reads the CURRENT session id at key time (Review R3-1)
 * and never the palette.
 */
export const sessionsLayer: KeyLayer = {
  name: "sessions",
  step: (snap): LayerStep => panelStep(snap, "sessions"),
};

/** 8. The tree panels. Esc closes; a claimed action applies; anything else falls through. */
export const treeLayer: KeyLayer = {
  name: "tree",
  step: (snap): LayerStep => panelStep(snap, "tree"),
};
