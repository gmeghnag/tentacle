import { describe, expect, test } from "bun:test";
import type { RemoteSession } from "@tentacle/client";
import { DomainErrorCode } from "@tentacle/protocol";
import { persistingController } from "../src/local-runtime.ts";

// docs/feat/clear-fork-history.md T18-T22: `/clear` keeps the chat it drops as
// its own session, from the controller's own last read.

const OLD = [
  { role: "system" as const, content: "sys" },
  { role: "user" as const, content: "the OLD chat" },
  { role: "assistant" as const, content: "old reply" },
];
const NEW = [{ role: "system" as const, content: "sys" }];
const readOf = (messages: unknown[], head: string, title?: unknown) => ({
  messages,
  ...(title ? { title } : {}),
  entries: [],
  read: { head: { seq: 1, id: head }, outcome: "linear" },
});

function rig(initial: unknown[], clear: () => Promise<unknown>, keep = true) {
  const log: string[] = [];
  let current: unknown = readOf(initial, "h-old", { source: "model", text: "Old title" });
  let activity: ((a: unknown) => void) | null = null;
  const inner = {
    readBack: async () => {
      log.push("read");
      return current;
    },
    clear: async () => {
      log.push("clear");
      const out = await clear();
      current = readOf(NEW, "h-new");
      return out;
    },
    watch: (l: (a: unknown) => void) => {
      activity = l;
      return () => {};
    },
    runningCalls: () => new Set<string>(),
    onTitle: () => () => {},
    enqueue: async () => {},
    close: () => {},
  } as unknown as RemoteSession;
  const forks: { messages: unknown; title: unknown }[] = [];
  const ctl = persistingController(
    inner,
    () => log.push("persist"),
    () => {},
    { source: "auto" },
    undefined,
    undefined,
    undefined,
    keep
      ? (messages, title) => {
          log.push("fork");
          forks.push({ messages, title });
        }
      : undefined,
  );
  return { ctl, log, forks, fire: (a: unknown) => activity?.(a) };
}

describe("clear keeps the old chat (persistingController)", () => {
  test("T18 reads first, forks the PRE-clear copy and title, before the save that drops it", async () => {
    const r = rig(OLD, async () => ({ before: 3, after: 1 }));
    await r.ctl.clear?.();
    await r.ctl.flushed?.();
    expect(r.forks).toHaveLength(1);
    expect(r.forks[0]?.messages).toEqual(OLD);
    expect(r.forks[0]?.title).toEqual({ source: "model", text: "Old title" });
    expect(r.log.indexOf("read")).toBeLessThan(r.log.indexOf("clear"));
    expect(r.log.indexOf("clear")).toBeLessThan(r.log.indexOf("fork"));
    // The save of the NEW chat comes after the fork.
    expect(r.log.lastIndexOf("persist")).toBeGreaterThan(r.log.indexOf("fork"));
  });

  test("T19 a daemon refusal forks nothing and rethrows", async () => {
    const r = rig(OLD, async () => {
      throw Object.assign(new Error("busy"), { code: DomainErrorCode.TurnInProgress });
    });
    await expect(r.ctl.clear?.()).rejects.toThrow("busy");
    expect(r.forks).toHaveLength(0);
  });

  test("T20 a dropped link forks anyway (it may have landed) and rethrows", async () => {
    const r = rig(OLD, async () => {
      throw Object.assign(new Error("dropped"), { code: -32603 });
    });
    await expect(r.ctl.clear?.()).rejects.toThrow("dropped");
    expect(r.forks).toHaveLength(1);
    expect(r.forks[0]?.messages).toEqual(OLD);
  });

  test("T21 the same read head forks once (a retry after a drop)", async () => {
    let calls = 0;
    const r = rig(OLD, async () => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error("dropped"), { code: -32603 });
      }
      return { before: 3, after: 1 };
    });
    await expect(r.ctl.clear?.()).rejects.toThrow();
    await r.ctl.clear?.(); // the clear did not land: the read still has the old head
    expect(r.forks).toHaveLength(1);
  });

  test("T22 a foreign history{clear} forks nothing", async () => {
    const r = rig(OLD, async () => ({ before: 3, after: 1 }));
    r.fire({ kind: "history", reason: "clear" });
    await r.ctl.flushed?.();
    expect(r.forks).toHaveLength(0);
  });

  test("M1 a pre-clear read slower than the 3 s bound forks the NEWEST chat, not the stale copy", async () => {
    // The daemon's history moved on after the last saved read; the read issued
    // just before the clear takes 3.2 s (longer than FLUSH_ON_EXIT_TIMEOUT_MS),
    // and the clear's reply follows it (the channel is ordered). The copy must
    // come from that pre-clear read, not from the stale one held at the bound.
    const NEWEST = [
      ...OLD,
      { role: "user" as const, content: "the newest turn" },
      { role: "assistant" as const, content: "newest reply" },
    ];
    // What the daemon holds AFTER the clear: tellable apart from NEWEST, so a
    // read started after the clear can never pass for the copy.
    const AFTER = [
      ...NEW,
      { role: "user" as const, content: "asked after the clear" },
      { role: "assistant" as const, content: "answered after the clear" },
    ];
    const answered = Promise.withResolvers<void>();
    let held: unknown = readOf(OLD, "h-old", { source: "model", text: "Old title" });
    let reads = 0;
    const inner = {
      readBack: async () => {
        reads++;
        const back = held;
        if (reads === 2) {
          await Bun.sleep(3200);
          // The read's reply reaches its owner first, the clear's reply after it.
          setTimeout(() => answered.resolve(), 0);
        }
        return back;
      },
      clear: async () => {
        await answered.promise; // ordered after the slow read's reply
        held = readOf(AFTER, "h-cleared"); // the daemon reset the history
        return { before: NEWEST.length, after: NEW.length };
      },
      watch: () => () => {},
      runningCalls: () => new Set<string>(),
      onTitle: () => () => {},
      enqueue: async () => {},
      close: () => {},
    } as unknown as RemoteSession;
    const forks: { messages: unknown }[] = [];
    const ctl = persistingController(
      inner,
      () => {},
      () => {},
      { source: "auto" },
      undefined,
      undefined,
      undefined,
      (messages) => {
        forks.push({ messages });
      },
    );
    // Read #1 (fast): the held copy is the OLD chat. Then the daemon's history
    // moves on to NEWEST, and the pre-clear read is the slow one.
    await ctl.saveNow();
    held = readOf(NEWEST, "h-newest");
    void ctl.saveNow(); // read #2: in flight when the clear is sent
    while (reads < 2) {
      await Bun.sleep(5);
    }
    await ctl.clear?.();
    await ctl.flushed?.();
    expect(forks).toHaveLength(1);
    expect(forks[0]?.messages).toEqual(NEWEST);
  }, 20_000);

  test("a chat of only the system prompt forks nothing", async () => {
    const r = rig(NEW, async () => ({ before: 1, after: 1 }));
    await r.ctl.clear?.();
    expect(r.forks).toHaveLength(0);
  });
});
