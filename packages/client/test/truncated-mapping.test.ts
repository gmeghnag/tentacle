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
  test("a cut reply keeps its reason AND the loop's `retrying`", () => {
    for (const reason of ["length", "cut"] as const) {
      for (const retrying of [true, false]) {
        const update: SessionUpdate = { type: "truncated_reply", reason, retrying };
        expect(frame(update)).toEqual(update);
        expect(updateToEvent(update, new Map())).toEqual({
          type: "truncated_reply",
          reason,
          retrying,
        });
      }
    }
  });

  test("an older daemon that omits `retrying` never promises a re-ask", () => {
    // The field is new and optional (a display kind: free to add). A client must
    // not re-derive it from the reason — that guess is the bug (Review MEDIUM-2)
    // — so the absent case is the conservative `false`.
    expect(updateToEvent({ type: "truncated_reply", reason: "length" }, new Map())).toEqual({
      type: "truncated_reply",
      reason: "length",
      retrying: false,
    });
  });

  test("an empty turn maps to its own event", () => {
    expect(updateToEvent({ type: "empty_turn" }, new Map())).toEqual({ type: "empty_turn" });
  });
});
