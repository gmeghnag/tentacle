/**
 * The laptop's reverse mapping for the two new notices
 * (docs/fix/truncated-reply-silent.md): a daemon-side `truncated_reply` /
 * `empty_turn` must reach the TUI's reducer as the SAME `AgentEvent`, or the
 * notice exists on the wire and nowhere on screen — the exact bug this task
 * fixes, one layer up. Covers a remote (`connect`/`serve`) and a pod session.
 *
 * RED before the fix: `updateToEvent` had no arm for either kind.
 */
import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@tentacle/protocol";
import { updateToEvent } from "../src/mapping.ts";

const frame = (update: SessionUpdate) => update;

describe("client: SessionUpdate → AgentEvent", () => {
  test("a cut reply keeps its reason", () => {
    for (const reason of ["length", "cut"] as const) {
      const update: SessionUpdate = { type: "truncated_reply", reason };
      expect(frame(update)).toEqual(update);
      expect(updateToEvent(update, new Map())).toEqual({ type: "truncated_reply", reason });
    }
  });

  test("an empty turn maps to its own event", () => {
    expect(updateToEvent({ type: "empty_turn" }, new Map())).toEqual({ type: "empty_turn" });
  });
});
