import { describe, expect, test } from "bun:test";
import { SETTINGS_USAGE, settingsCommand } from "../src/settings-command.ts";

// docs/feat/session-settings-apply.md: the routing of /settings, pure.
describe("settingsCommand", () => {
  const idle = { running: false, compacting: false, available: true };

  test("no argument: show", () => {
    expect(settingsCommand("/settings", idle)).toEqual({ kind: "show" });
    expect(settingsCommand("/settings   ", idle)).toEqual({ kind: "show" });
  });

  test("apply: apply when idle", () => {
    expect(settingsCommand("/settings apply", idle)).toEqual({ kind: "apply" });
    expect(settingsCommand("/settings  apply ", idle)).toEqual({ kind: "apply" });
  });

  test("an unknown argument is the usage, never an apply", () => {
    // Mutation: treat any argument as apply → "applyy" applies.
    for (const raw of ["/settings applyy", "/settings show", "/settings apply now"]) {
      expect(settingsCommand(raw, idle)).toEqual({ kind: "notice", text: SETTINGS_USAGE });
    }
  });

  test("busy: the apply is refused here (the daemon's check is the truth); show still works", () => {
    expect(settingsCommand("/settings apply", { ...idle, running: true })).toEqual({
      kind: "notice",
      text: "Can't apply settings while a turn is running.",
    });
    expect(settingsCommand("/settings apply", { ...idle, compacting: true })).toEqual({
      kind: "notice",
      text: "Can't apply settings while a compaction is running.",
    });
    expect(settingsCommand("/settings", { ...idle, running: true })).toEqual({ kind: "show" });
  });

  test("a runtime that carries nothing: not available", () => {
    for (const raw of ["/settings", "/settings apply"]) {
      expect(settingsCommand(raw, { ...idle, available: false })).toEqual({
        kind: "notice",
        text: "/settings isn't available for this session.",
      });
    }
  });
});
