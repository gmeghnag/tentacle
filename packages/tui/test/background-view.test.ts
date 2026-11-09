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
  sameIds,
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

describe("LOW-4: an unchanged report does not re-render the App", () => {
  test("sameIds: the same ids in the same order, whatever the rows' other fields", () => {
    expect(sameIds(undefined, undefined)).toBe(true);
    expect(sameIds([], [])).toBe(true);
    expect(sameIds(undefined, [])).toBe(false);
    expect(sameIds([row(1)], undefined)).toBe(false);
    expect(sameIds([row(1), row(2)], [row(1), row(2)])).toBe(true);
    // A NEW array with the same ids is still "nothing to redraw" (the frame
    // sends a fresh array every time); only the ids matter to this TUI.
    expect(sameIds([{ id: "sa-1" }], [{ id: "sa-1" }])).toBe(true);
    // A different id, order or count is a change.
    expect(sameIds([row(1), row(2)], [row(2), row(1)])).toBe(false);
    expect(sameIds([row(1)], [row(2)])).toBe(false);
    expect(sameIds([row(1)], [row(1), row(2)])).toBe(false);
  });
});
