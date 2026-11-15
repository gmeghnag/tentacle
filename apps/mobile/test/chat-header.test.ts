import { describe, expect, test } from "bun:test";
import { type ChatFacts, chatStatus } from "../src/chat-header.ts";

const open: ChatFacts = { phase: "open", link: "up", running: false, closed: null };

describe("chatStatus (the chat header's status line)", () => {
  test("idle and running, with their tones", () => {
    expect(chatStatus(open)).toEqual({ text: "Idle", tone: "online" });
    expect(chatStatus({ ...open, running: true })).toEqual({ text: "Running", tone: "running" });
  });

  test("the link down wins over a running turn (the phone cannot see it run)", () => {
    expect(chatStatus({ ...open, running: true, link: "down" })).toEqual({
      text: "Offline",
      tone: "offline",
    });
  });

  test("an attach in flight or failed says so before anything else", () => {
    expect(chatStatus({ ...open, phase: "opening", link: "down" }).text).toBe("Connecting…");
    expect(chatStatus({ ...open, phase: "failed" })).toEqual({
      text: "Not connected",
      tone: "attention",
    });
  });

  test("an ended session is Ended, not Idle", () => {
    expect(chatStatus({ ...open, closed: "deleted" }).text).toBe("Ended");
  });
});
