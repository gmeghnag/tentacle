import { describe, expect, test } from "bun:test";
import { SETTINGS_USAGE, settingsCommand } from "../src/settings-command.ts";

// docs/feat/session-settings-apply.md: the routing of /settings, pure.
describe("settingsCommand", () => {
  const idle = { running: false, compacting: false, available: true, syncing: false };

  test("no argument: show", () => {
    expect(settingsCommand("/settings", idle)).toEqual({ kind: "show" });
    expect(settingsCommand("/settings   ", idle)).toEqual({ kind: "show" });
  });

  test("sync: syncs when idle", () => {
    expect(settingsCommand("/settings sync", idle)).toEqual({ kind: "sync" });
    expect(settingsCommand("/settings  sync ", idle)).toEqual({ kind: "sync" });
  });

  test("an unknown argument is the usage, never a sync", () => {
    // Mutation: treat any argument as sync → "syncy" and the old "apply" sync.
    for (const raw of [
      "/settings syncy",
      "/settings show",
      "/settings sync now",
      "/settings apply",
    ]) {
      expect(settingsCommand(raw, idle)).toEqual({ kind: "notice", text: SETTINGS_USAGE });
    }
  });

  test("busy: the sync is refused here (the daemon's check is the truth); show still works", () => {
    expect(settingsCommand("/settings sync", { ...idle, running: true })).toEqual({
      kind: "notice",
      text: "Can't sync settings while a turn is running.",
    });
    expect(settingsCommand("/settings sync", { ...idle, compacting: true })).toEqual({
      kind: "notice",
      text: "Can't sync settings while a compaction is running.",
    });
    expect(settingsCommand("/settings", { ...idle, running: true })).toEqual({ kind: "show" });
  });

  test("a runtime that carries nothing: not available", () => {
    for (const raw of ["/settings", "/settings sync"]) {
      expect(settingsCommand(raw, { ...idle, available: false })).toEqual({
        kind: "notice",
        text: "/settings isn't available for this session.",
      });
    }
  });

  test("F4 a sync in flight: a second one is told, /settings still shows", () => {
    expect(settingsCommand("/settings sync", { ...idle, syncing: true })).toEqual({
      kind: "notice",
      text: "Already syncing this terminal's settings…",
    });
    expect(settingsCommand("/settings", { ...idle, syncing: true })).toEqual({ kind: "show" });
  });
});
