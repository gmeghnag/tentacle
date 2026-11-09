import { describe, expect, test } from "bun:test";
import type { LogWrite } from "@tentacle/daemon";
import { type SaveTarget, SessionSaver } from "../src/session-saver.ts";

// docs/feat/clear-fork-history.md T17: `SessionSaver.keepFork`.

const update = {
  id: "f1",
  meta: { cwd: "/w", model: "m", createdAt: 1 },
  entries: [],
  messages: [],
} as unknown as LogWrite;

function target(fork: SaveTarget["fork"]): SaveTarget {
  return {
    write: async () => {},
    saveSnapshot: async () => {},
    remove: async () => {},
    ...(fork ? { fork } : {}),
  };
}

describe("SessionSaver.keepFork", () => {
  test("a rejecting store: one notice, drain lists it, no observe call, no unhandled rejection", async () => {
    const notices: string[] = [];
    const saver = new SessionSaver(
      target(async () => {
        throw new Error("disk full");
      }),
      (t) => notices.push(t),
    );
    const observed: string[] = [];
    saver.observe((s) => observed.push(s.id));
    saver.keepFork("src", update);
    const left = await saver.drain();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("disk full");
    expect(left.length).toBeGreaterThan(0);
    expect(observed).toEqual([]);
    expect(saver.clean?.() ?? false).toBe(false);
  });

  test("a throwing store call is reported the same way", async () => {
    const notices: string[] = [];
    const saver = new SessionSaver(
      target(() => {
        throw new Error("sync boom");
      }),
      (t) => notices.push(t),
    );
    saver.keepFork("src", update);
    await saver.drain();
    expect(notices.join(" ")).toContain("sync boom");
  });

  test("a resolving store shows nothing; a store without fork, or a removed source, is a no-op", async () => {
    const notices: string[] = [];
    const calls: string[] = [];
    const saver = new SessionSaver(
      target(async (source) => {
        calls.push(source);
      }),
      (t) => notices.push(t),
    );
    saver.keepFork("src", update);
    expect(await saver.drain()).toEqual([]);
    expect(calls).toEqual(["src"]);
    expect(notices).toEqual([]);
    new SessionSaver(target(undefined), (t) => notices.push(t)).keepFork("src", update);
    saver.remove("gone");
    saver.keepFork("gone", update);
    expect(calls).toEqual(["src"]);
  });
});
