/**
 * The pure key router (docs/feat/app-decomposition.md S3, Fable H3): ONE
 * ordered walk over the layer list, for ONE input chunk.
 *
 * It is not "first claimer wins". A layer returns `{effects, verdict, carry}`;
 * the walk runs EVERY layer's effects up to (and including) the first one that
 * CONSUMES, so the five act-and-pass sites keep working: the chord writes its
 * state and the key goes on, the sessions panel disarms and the key goes on,
 * the dock applies its state and the key goes through to line editing.
 *
 * `stoppedAt` names the consumer, which makes a precedence bug legible in a test
 * ("Esc stopped at `sessions`, not at `escAbort`") instead of a frame diff.
 *
 * No React, no Ink, no module state: the whole precedence order is testable as
 * data (`route.test.ts`), which is the point of the slice.
 */
import type { KeyLayer, KeyRoute, KeySnapshot } from "./contract.ts";

/**
 * Walk `layers` in order for one chunk. Effects accumulate in layer order; the
 * first `consumed` stops the walk; `carry` is the last non-empty carry seen (a
 * passing layer's restored `[`, handed to line editing).
 */
export function routeKey(snap: KeySnapshot, layers: readonly KeyLayer[]): KeyRoute {
  const effects: KeyRoute["effects"][number][] = [];
  let carry = "";
  for (const layer of layers) {
    const step = layer.step(snap);
    effects.push(...step.effects);
    if (step.carry !== "") {
      carry = step.carry;
    }
    if (step.verdict === "consumed") {
      return { effects, verdict: "consumed", carry, stoppedAt: layer.name };
    }
  }
  // Nothing consumed it: line editing gets the chunk, with any carry.
  return { effects, verdict: "pass", carry, stoppedAt: null };
}
