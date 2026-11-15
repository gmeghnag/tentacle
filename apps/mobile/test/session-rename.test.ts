/**
 * Renaming from the phone (Owner decision 5, docs/feat/mobile-session-info.md):
 * tapping the title opens a field, and the typed title goes through the EXISTING
 * rename path — `session/rename`, the one the TUI's `/rename` uses — so the name
 * is the same on every client afterwards.
 */
import { describe, expect, test } from "bun:test";
import { JsonRpcErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import {
  MAX_TITLE_LENGTH,
  renameErrorText,
  renamePlan,
  titleAfterRename,
} from "../src/session-rename.ts";

describe("renamePlan (empty or unchanged is a no-op)", () => {
  test("the same text sends nothing at all", () => {
    expect(renamePlan("Fix the flaky test", "Fix the flaky test")).toEqual({ kind: "noop" });
  });

  test("whitespace-only differences are still the same title", () => {
    expect(renamePlan("Fix the flaky test", "  Fix   the flaky test ")).toEqual({ kind: "noop" });
  });

  test("an empty field sends nothing (closing the sheet keeps the title)", () => {
    expect(renamePlan("Fix the flaky test", "")).toEqual({ kind: "noop" });
    expect(renamePlan("Fix the flaky test", "   ")).toEqual({ kind: "noop" });
  });

  test("a new title is sent as ONE line, trimmed", () => {
    expect(renamePlan("old", "  New\n title  ")).toEqual({ kind: "send", title: "New title" });
  });

  test("a title over the cap is refused before it round-trips", () => {
    const plan = renamePlan("old", "x".repeat(MAX_TITLE_LENGTH + 1));
    expect(plan.kind).toBe("invalid");
    // The boundary itself is fine.
    expect(renamePlan("old", "x".repeat(MAX_TITLE_LENGTH)).kind).toBe("send");
  });
});

describe("renameErrorText", () => {
  test("an older daemon says so, in the person's words", () => {
    const error = new RpcError(JsonRpcErrorCode.MethodNotFound, "no such method");
    expect(renameErrorText(error)).toContain("too old");
  });

  test("a dead link keeps its own sentence (the retry hint comes from the screen)", () => {
    expect(renameErrorText(new Error("not connected to the daemon"))).toBe(
      "not connected to the daemon",
    );
  });

  test("an error with no words still says something usable", () => {
    expect(renameErrorText(new Error(""))).toBe("Couldn't rename the session.");
    expect(renameErrorText(undefined)).toBe("Couldn't rename the session.");
  });
});

describe("titleAfterRename", () => {
  test("the header shows exactly what the daemon stored", () => {
    expect(titleAfterRename("  The  new   name ")).toBe("The new name");
  });
});
