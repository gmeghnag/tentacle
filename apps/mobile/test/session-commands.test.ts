/**
 * The Commands sheet's view-model (docs/feat/mobile-hub-commands.md C2 item 11):
 * availability per (turn, link, compacting, ended, last prompt), Clear's inline
 * confirm, and the rows a handle without compact/clear leaves out (P6).
 */
import { describe, expect, test } from "bun:test";
import {
  CLEARING,
  COMPACTED_DONE,
  COMPACTING,
  type CommandId,
  type CommandState,
  type CommandsInput,
  FIELD_NOT_EMPTY,
  NOTHING_TO_RETRY,
  NOT_CONNECTED,
  SESSION_ENDED,
  WAITS_FOR_TURN,
  clearConfirm,
  commandRows,
} from "../src/session-commands.ts";

const base: CommandsInput = {
  link: "up",
  turnRunning: false,
  ended: false,
  compacting: false,
  compacted: false,
  compactFailed: null,
  clearing: false,
  confirmClear: false,
  lastPrompt: "map the repo",
  fieldBusy: false,
  autoAccept: false,
  canCompact: true,
  canClear: true,
};

function states(input: Partial<CommandsInput>): Record<CommandId, CommandState> {
  return Object.fromEntries(
    commandRows({ ...base, ...input }).map((row) => [row.id, row.state]),
  ) as Record<CommandId, CommandState>;
}

const dim = (reason: string): CommandState => ({ kind: "dimmed", reason });
const ready: CommandState = { kind: "ready" };

describe("commandRows — availability", () => {
  test("idle and connected: every command ready, in the mockup's order", () => {
    expect(commandRows(base).map((r) => r.id)).toEqual([
      "compact",
      "clear",
      "rename",
      "retry",
      "autoAccept",
    ]);
    expect(states({})).toEqual({
      compact: ready,
      clear: ready,
      rename: ready,
      retry: ready,
      autoAccept: { kind: "toggle", on: false },
    });
  });
  test("a running turn dims the turn-bound three with the reason; Rename and Auto-accept stay", () => {
    const s = states({ turnRunning: true, autoAccept: true });
    expect(s.compact).toEqual(dim(WAITS_FOR_TURN));
    expect(s.clear).toEqual(dim(WAITS_FOR_TURN));
    expect(s.retry).toEqual(dim(WAITS_FOR_TURN));
    expect(s.rename).toEqual(ready);
    expect(s.autoAccept).toEqual({ kind: "toggle", on: true });
  });
  test("a dead link says Not connected (over a turn)", () => {
    const s = states({ link: "down", turnRunning: true });
    expect(s.compact).toEqual(dim(NOT_CONNECTED));
    expect(s.clear).toEqual(dim(NOT_CONNECTED));
    expect(s.retry).toEqual(dim(NOT_CONNECTED));
  });
  test("while compacting: Compact is running, Clear and Retry say Compacting…", () => {
    const s = states({ compacting: true });
    expect(s.compact).toEqual({ kind: "running" });
    expect(s.clear).toEqual(dim(COMPACTING));
    expect(s.retry).toEqual(dim(COMPACTING));
  });
  test("while clearing: Clear is running, Compact and Retry say Clearing…", () => {
    const s = states({ clearing: true });
    expect(s.clear).toEqual({ kind: "running" });
    expect(s.compact).toEqual(dim(CLEARING));
    expect(s.retry).toEqual(dim(CLEARING));
  });
  test("an ended session dims everything turn-bound", () => {
    const s = states({ ended: true });
    expect(s.compact).toEqual(dim(SESSION_ENDED));
    expect(s.retry).toEqual(dim(SESSION_ENDED));
  });
  test("Retry: no earlier prompt → Nothing to retry; a busy field → says so", () => {
    expect(states({ lastPrompt: null }).retry).toEqual(dim(NOTHING_TO_RETRY));
    expect(states({ lastPrompt: "  " }).retry).toEqual(dim(NOTHING_TO_RETRY));
    expect(states({ fieldBusy: true }).retry).toEqual(dim(FIELD_NOT_EMPTY));
  });
  test("Compact's settled states: Compacted ✓ in the window, the ▲ text after a failure", () => {
    expect(states({ compacted: true }).compact).toEqual({ kind: "done", text: COMPACTED_DONE });
    expect(states({ compactFailed: "Compact failed: x" }).compact).toEqual({
      kind: "failed",
      text: "Compact failed: x",
    });
  });
  test("Clear's armed confirm is the row's own state", () => {
    expect(states({ confirmClear: true }).clear).toEqual({ kind: "confirming" });
    // A turn starting is dimming, not a silent confirm left on screen.
    expect(states({ confirmClear: true, turnRunning: true }).clear).toEqual(dim(WAITS_FOR_TURN));
  });
  test("a handle without compact/clear has no such rows (P6), never a dead one", () => {
    const ids = commandRows({ ...base, canCompact: false, canClear: false }).map((r) => r.id);
    expect(ids).toEqual(["rename", "retry", "autoAccept"]);
  });
});

describe("clearConfirm", () => {
  test("arm → confirm runs once and disarms", () => {
    const armed = clearConfirm(false, "arm");
    expect(armed).toEqual({ armed: true, run: false });
    expect(clearConfirm(armed.armed, "confirm")).toEqual({ armed: false, run: true });
  });
  test("arm → cancel runs nothing", () => {
    expect(clearConfirm(true, "cancel")).toEqual({ armed: false, run: false });
  });
  test("a confirm that was never armed runs nothing", () => {
    expect(clearConfirm(false, "confirm")).toEqual({ armed: false, run: false });
  });
  test("a turn start or a link drop disarms it", () => {
    expect(clearConfirm(true, "turn_started")).toEqual({ armed: false, run: false });
    expect(clearConfirm(true, "link_down")).toEqual({ armed: false, run: false });
  });
});
