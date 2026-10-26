import { describe, expect, test } from "bun:test";
import { autoApproves, ownRequest } from "../src/permission-ui.ts";
import type { DisplayItem } from "../src/state.ts";
import {
  type SessionActivity,
  WARM_THRESHOLD,
  closedNotice,
  commitWarmed,
  historyAction,
  lostSlot,
  needsWarm,
  nextStep,
} from "../src/turn-feed.ts";

// docs/feat/tui-foreign-turns.md C2/C3/C6/C8: the pure decisions the App executes.

const turn: SessionActivity = {
  kind: "turn",
  turnId: "F",
  events: {
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
  },
  cancel: () => {},
};
const history = (reason: "compact" | "context_reset" | null): SessionActivity => ({
  kind: "history",
  messages: [],
  reason,
});

describe("nextStep (C2)", () => {
  test.each([
    [false, turn, "consume"],
    [true, turn, "hold"],
    [false, history(null), "history"],
    [true, history(null), "hold"],
    [true, history("compact"), "history"], // a compaction only adds a notice: never waits
    [true, history("context_reset"), "hold"], // appended after the run it follows
    [false, history("context_reset"), "history"],
    [false, { kind: "closed", reason: "closed" } as SessionActivity, "closed"],
    [true, { kind: "closed", reason: "deleted" } as SessionActivity, "closed"],
  ] as const)("inFlight=%p %o → %s", (inFlight, activity, step) => {
    expect(nextStep({ inFlight, activity })).toBe(step);
  });
});

describe("historyAction (C6, owner QR1)", () => {
  test("a compaction keeps the transcript: a notice unless mine; any other history replaces it", () => {
    expect(historyAction({ reason: "compact", ownCompaction: false })).toBe("notice");
    expect(historyAction({ reason: "compact", ownCompaction: true })).toBe("none");
    expect(historyAction({ reason: null, ownCompaction: false })).toBe("replace");
    expect(historyAction({ reason: null, ownCompaction: true })).toBe("replace");
  });

  test("a context reset keeps the transcript and APPENDS the new history (context-reset decision 9)", () => {
    expect(historyAction({ reason: "context_reset", ownCompaction: false })).toBe("append");
    expect(historyAction({ reason: "context_reset", ownCompaction: true })).toBe("append");
  });
});

describe("lostSlot (C3): by the error CODE, before anything streamed", () => {
  const inProgress = Object.assign(new Error("whatever text"), { code: -32004 });
  test("TurnInProgress before any event → lost; after an event, or another code → not", () => {
    expect(lostSlot(inProgress, false)).toBe(true);
    expect(lostSlot(inProgress, true)).toBe(false);
    expect(
      lostSlot(Object.assign(new Error("a turn is in progress"), { code: -32603 }), false),
    ).toBe(false);
    expect(lostSlot(new Error("TurnInProgress"), false)).toBe(false);
    expect(lostSlot(undefined, false)).toBe(false);
  });
});

describe("auto-accept answers only my own turns (C5, owner Q3)", () => {
  const tool = { tool: "shell", level: "ask", title: "t", input: {} } as const;
  test("autoApproves: never a foreign turn's request, never a hooks trust", () => {
    expect(autoApproves(tool)).toBe(true);
    expect(autoApproves(tool, false)).toBe(false);
    expect(autoApproves({ ...tool, kind: "hooks_trust" }, true)).toBe(false);
  });
  test("ownRequest: no session decides → mine; under one, only a turn it owns (none → not mine)", () => {
    const owns = (id: string) => id === "own";
    expect(ownRequest(undefined, undefined)).toBe(true);
    expect(ownRequest("own", owns)).toBe(true);
    expect(ownRequest("F", owns)).toBe(false);
    expect(ownRequest(undefined, owns)).toBe(false);
  });
});

describe("warm (C8)", () => {
  test("only past the threshold", () => {
    expect(needsWarm(WARM_THRESHOLD)).toBe(false);
    expect(needsWarm(WARM_THRESHOLD + 1)).toBe(true);
  });

  test("commitWarmed: the new history, then what was appended during the warm; a replaced transcript keeps nothing", () => {
    const a: DisplayItem = { kind: "user", text: "a" };
    const n1: DisplayItem = { kind: "assistant", text: "notice" };
    const h: DisplayItem = { kind: "user", text: "history" };
    expect(commitWarmed([a], [a, n1], [h])).toEqual([h, n1]);
    expect(commitWarmed([a], [a], [h])).toEqual([h]);
    expect(commitWarmed([a], [n1], [h])).toEqual([h]);
  });
});

describe("closedNotice (docs/feat/connect-sessions.md)", () => {
  test("says the next prompt starts a new session; only a closed one (listable runtime) offers /sessions", () => {
    expect(closedNotice("closed", true)).toBe(
      "_this session was closed on another device — what you type next starts a new session (/sessions to reopen it)_",
    );
    expect(closedNotice("closed")).toBe(
      "_this session was closed on another device — what you type next starts a new session_",
    );
    expect(closedNotice("deleted", true)).toBe(
      "_this session was deleted on another device — what you type next starts a new session_",
    );
  });
});
