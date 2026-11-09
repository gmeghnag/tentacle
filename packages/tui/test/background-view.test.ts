/**
 * 6a-2 TUI half (docs/feat/subagent-background-ui.md Design 6): the count on the
 * status line and the quit confirmation. Pure modules, so the behaviour is
 * tested here and the components only paint what they return.
 */
import { describe, expect, test } from "bun:test";
import {
  type BackgroundAgentRow,
  backgroundCount,
  backgroundNames,
  backgroundSuffix,
} from "../src/background-view.ts";

const row = (i: number): BackgroundAgentRow => ({ id: `sa-${i}` });

describe("T49: the status line's count", () => {
  test("the count is the list's length; no rows is no suffix at all", () => {
    expect(backgroundCount([])).toBe(0);
    expect(backgroundCount([row(1)])).toBe(1);
    expect(backgroundCount([row(1), row(2)])).toBe(2);
    expect(backgroundSuffix(0)).toBe("");
    expect(backgroundSuffix(1)).toBe(" · 1 sub-agent");
    expect(backgroundSuffix(2)).toBe(" · 2 sub-agents");
  });

  test("the ids, in launch order, for the quit confirmation", () => {
    expect(backgroundNames(undefined)).toEqual([]);
    expect(backgroundNames([row(1), row(2)])).toEqual(["sa-1", "sa-2"]);
  });

  test("an unreported list (an older daemon) is no suffix, not zero", () => {
    // `undefined` means "the daemon does not report them": showing `0
    // sub-agents` would be a claim, and showing nothing is honest.
    expect(backgroundCount(undefined)).toBe(0);
    expect(backgroundSuffix(backgroundCount(undefined))).toBe("");
  });
});
