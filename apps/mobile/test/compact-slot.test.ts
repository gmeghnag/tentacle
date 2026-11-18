/**
 * The phone's compaction slot and outcome lines (docs/feat/mobile-hub-commands.md
 * C2 item 10): the footer's priority, the 3 s boundary, and every settle's line.
 */
import { describe, expect, test } from "bun:test";
import { DROPPED_NOT_RETRIED } from "@tentacle/client";
import { DomainErrorCode, JsonRpcErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import {
  CHAT_CLEARED,
  CHAT_CLEARED_KEPT,
  CLEAR_LINK_DROPPED,
  COMPACTED_SHOWN_MS,
  COMPACTION_CANCELLED,
  COMPACT_LINK_DROPPED,
  NOTHING_TO_CLEAR,
  clearOutcome,
  compactOutcome,
  slotView,
} from "../src/compact-slot.ts";

const idle = { running: false, compactingSince: null, compactedAt: null, now: 10_000 };

describe("slotView — the footer's priority", () => {
  test("a running turn outranks my compaction and a lingering Compacted ✓", () => {
    expect(slotView({ ...idle, running: true, compactingSince: 9_000 })).toBeNull();
    expect(slotView({ ...idle, running: true, compactedAt: 9_999 })).toBeNull();
  });
  test("my compaction shows Compacting… from when it began, over a stale Compacted ✓", () => {
    expect(slotView({ ...idle, compactingSince: 9_000, compactedAt: 9_500 })).toEqual({
      kind: "compacting",
      since: 9_000,
    });
  });
  test("Compacted ✓ lasts COMPACTED_SHOWN_MS, exclusive: 2999 shown, 3000 gone", () => {
    expect(COMPACTED_SHOWN_MS).toBe(3_000);
    expect(slotView({ ...idle, compactedAt: 10_000 - 2_999 })).toEqual({ kind: "compacted" });
    expect(slotView({ ...idle, compactedAt: 10_000 - 3_000 })).toBeNull();
  });
  test("nothing at all is no slot", () => {
    expect(slotView(idle)).toBeNull();
  });
});

describe("compactOutcome — the line a settle leaves", () => {
  test("success writes NO line (the slot and the separator say it)", () => {
    expect(compactOutcome({ ok: true })).toBeNull();
  });
  test("Cancelled is news (◇), never a failure", () => {
    const error = new RpcError(DomainErrorCode.Cancelled, "compaction cancelled");
    expect(compactOutcome({ ok: false, error })).toEqual({ text: COMPACTION_CANCELLED });
  });
  test("TurnInProgress is a ▲ with the daemon's own words", () => {
    const error = new RpcError(DomainErrorCode.TurnInProgress, "a turn is already running");
    expect(compactOutcome({ ok: false, error })).toEqual({
      text: "Compact failed: a turn is already running",
      level: "warn",
    });
  });
  test("CompactInProgress says another device is compacting", () => {
    const error = new RpcError(DomainErrorCode.CompactInProgress, "a compaction is running");
    expect(compactOutcome({ ok: false, error })).toEqual({
      text: "Compact failed: another device is compacting",
      level: "warn",
    });
  });
  test("an older daemon's MethodNotFound lands in the ▲ branch, honest not silent", () => {
    const error = new RpcError(JsonRpcErrorCode.MethodNotFound, "method not found");
    expect(compactOutcome({ ok: false, error })?.level).toBe("warn");
  });
  test("a transport loss is UNKNOWN (◇), never a ▲ — dropped-not-retried, closed peer, non-Rpc", () => {
    for (const error of [
      new RpcError(JsonRpcErrorCode.InternalError, DROPPED_NOT_RETRIED),
      new RpcError(JsonRpcErrorCode.InternalError, "connection closed"),
      new Error("socket gone"),
    ]) {
      expect(compactOutcome({ ok: false, error })).toEqual({ text: COMPACT_LINK_DROPPED });
    }
  });
});

describe("clearOutcome", () => {
  test("a clear that dropped something says the chat is kept as an archived session", () => {
    expect(clearOutcome({ ok: true, before: 5, after: 1 }, true)).toEqual({
      text: CHAT_CLEARED_KEPT,
    });
  });
  test("forkKept false claims no kept copy (a daemon without a persister)", () => {
    const line = clearOutcome({ ok: true, before: 5, after: 1 }, false);
    expect(line).toEqual({ text: CHAT_CLEARED });
    expect(line.text).not.toContain("kept");
  });
  test("nothing to drop (before === after) says so, no fork claim", () => {
    expect(clearOutcome({ ok: true, before: 1, after: 1 }, true)).toEqual({
      text: NOTHING_TO_CLEAR,
    });
  });
  test("a refusal is a ▲ Couldn't clear; a transport loss is unknown", () => {
    const refused = new RpcError(DomainErrorCode.TurnInProgress, "a turn is already running");
    expect(clearOutcome({ ok: false, error: refused }, true)).toEqual({
      text: "Couldn't clear: a turn is already running",
      level: "warn",
    });
    const dropped = new RpcError(JsonRpcErrorCode.InternalError, DROPPED_NOT_RETRIED);
    expect(clearOutcome({ ok: false, error: dropped }, true)).toEqual({ text: CLEAR_LINK_DROPPED });
  });
});
