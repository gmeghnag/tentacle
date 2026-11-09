import { describe, expect, test } from "bun:test";
import {
  CLEARED_ELSEWHERE_NOTICE,
  type ClearStep,
  clearCommandStep,
  clearErrorNotice,
  clearFailedNotice,
} from "../src/clear-command.ts";

// docs/feat/clear-keeps-jobs.md — T17: the pure decision behind `/clear`.

const base = { canClear: true, running: false, ownTurn: true, compacting: false, clearing: false };
const step = (over: Partial<typeof base>): ClearStep => clearCommandStep({ ...base, ...over });

describe("clearCommandStep", () => {
  test("idle: clear", () => {
    expect(step({})).toBe("clear");
  });

  test("a session without `clear` takes the legacy path, whatever else is going on", () => {
    expect(step({ canClear: false })).toBe("legacy");
    expect(step({ canClear: false, running: true, compacting: true, clearing: true })).toBe(
      "legacy",
    );
  });

  test("a clear already in flight is busy; a compaction blocks it", () => {
    expect(step({ clearing: true })).toBe("busy");
    expect(step({ clearing: true, running: true })).toBe("busy");
    expect(step({ compacting: true })).toBe("compacting");
  });

  test("an own running turn is stopped first; another device's turn is left to the daemon's refusal", () => {
    // Mutation: swap the `running` / `ownTurn` order → both rows below fail.
    expect(step({ running: true, ownTurn: true })).toBe("stop_then_clear");
    expect(step({ running: true, ownTurn: false })).toBe("clear");
  });
});

describe("notices", () => {
  test("the failure notice says the chat is still the same session", () => {
    expect(clearFailedNotice("a turn is already running")).toBe(
      "_/clear failed: a turn is already running — still in this session_",
    );
  });

  test("a dropped link is 'no answer' (the clear may have landed), any other error is 'still in this session'", () => {
    expect(clearErrorNotice("link dropped — the request was not retried")).toBe(
      "_/clear: no answer — the screen follows the daemon when the link is back_",
    );
    expect(clearErrorNotice("a turn is already running")).toBe(
      clearFailedNotice("a turn is already running"),
    );
  });

  test("the foreign-clear notice", () => {
    expect(CLEARED_ELSEWHERE_NOTICE).toBe("_the conversation was cleared on another device_");
  });
});
