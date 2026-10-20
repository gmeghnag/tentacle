import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore, type SessionRecord } from "@tentacle/agent";
import { SessionSaver, nextSaveState } from "../src/session-saver.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tentacle-saver-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rec = (id: string, updatedAt: number): SessionRecord => ({
  id,
  cwd: "/w",
  model: "m",
  createdAt: 1,
  updatedAt,
  title: id,
  messages: [{ role: "user", content: "hi" }],
});

/** A real store whose writes fail while `failing` holds the error. */
function flakyStore(sub: string) {
  const control: { failing: Error | null } = { failing: null };
  const store = new JsonSessionStore(join(dir, sub), {
    writeDurable: async (path, data) => {
      if (control.failing) {
        throw control.failing;
      }
      await writeFile(path, data);
    },
  });
  return { store, control };
}

describe("nextSaveState", () => {
  test("only the ok→failing and failing→ok transitions produce a notice", () => {
    const ok = { failing: false } as const;
    const first = nextSaveState(ok, "abcdef0123456789", { ok: false, error: "ENOSPC" });
    expect(first.state).toEqual({ failing: true, error: "ENOSPC" });
    expect(first.notice).toContain("Session abcdef01 not saved — ENOSPC.");
    const again = nextSaveState(first.state, "abcdef0123456789", { ok: false, error: "EIO" });
    expect(again).toEqual({ state: { failing: true, error: "EIO" }, notice: null });
    const back = nextSaveState(again.state, "abcdef0123456789", { ok: true });
    expect(back).toEqual({ state: { failing: false }, notice: "Session abcdef01 saved again." });
    expect(nextSaveState(ok, "x", { ok: true })).toEqual({ state: ok, notice: null });
  });
});

describe("SessionSaver", () => {
  test("a failing store is reported once, recovers loudly, and never leaks an unhandled rejection", async () => {
    // Mutation: make `save` a bare `void this.store.save(record)` → the spy fires.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { store, control } = flakyStore("flaky");
      const notices: string[] = [];
      const saver = new SessionSaver(store, (t) => notices.push(t));
      control.failing = new Error("EACCES: permission denied");
      saver.save(rec("s1", 1));
      expect(await saver.drain()).toEqual([
        `[session] not saved: s1 — couldn't write ${join(dir, "flaky", "s1.json")}: EACCES: permission denied (any file on disk is from an earlier save)\n`,
      ]);
      saver.save(rec("s1", 2)); // still failing: silent
      await saver.drain();
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("Session s1 not saved — couldn't write");
      expect(notices[0]).toContain("s1.json: EACCES: permission denied.");

      control.failing = null;
      saver.save(rec("s1", 3));
      expect(await saver.drain()).toEqual([]);
      expect(notices[1]).toBe("Session s1 saved again.");
      const loaded = await store.load("s1");
      expect(loaded.status === "ok" ? loaded.record.updatedAt : null).toBe(3);
      await Bun.sleep(5);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("failure state is per uid: another session's success is not reported as a recovery", async () => {
    const { store, control } = flakyStore("per-uid");
    const notices: string[] = [];
    const saver = new SessionSaver(store, (t) => notices.push(t));
    control.failing = new Error("ENOSPC");
    saver.save(rec("old", 1));
    await saver.drain();
    control.failing = null;
    saver.save(rec("new", 2));
    const lines = await saver.drain();
    expect(notices).toHaveLength(1);
    expect(lines).toEqual([
      `[session] not saved: old — couldn't write ${join(dir, "per-uid", "old.json")}: ENOSPC (any file on disk is from an earlier save)\n`,
    ]);
  });

  test("drain waits for a save submitted just before it (no sleep needed)", async () => {
    const { store } = flakyStore("drain");
    const saver = new SessionSaver(store, () => {});
    saver.save(rec("d", 7));
    await saver.drain();
    const loaded = await store.load("d");
    expect(loaded.status === "ok" ? loaded.record.updatedAt : null).toBe(7);
  });

  test("drain waits for save's own outcome, whatever the store does internally", async () => {
    // Pins the saver's own pending set: a target with no `drain` at all, whose
    // write fails late. Mutation: return before waiting → no line.
    const saver = new SessionSaver(
      { save: () => Bun.sleep(20).then(() => Promise.reject(new Error("late EIO"))) },
      () => {},
    );
    saver.save(rec("late", 1));
    expect(await saver.drain()).toEqual([
      "[session] not saved: late — late EIO (any file on disk is from an earlier save)\n",
    ]);
  });

  test("a hung save: drain says it is waiting, then gives up and reports it — never hangs", async () => {
    const saver = new SessionSaver({ save: () => new Promise<void>(() => {}) }, () => {});
    saver.save(rec("hung", 1));
    const slow: string[][] = [];
    const started = Date.now();
    const lines = await saver.drain({
      timeoutMs: 60,
      slowMs: 10,
      onSlow: (ids) => slow.push([...ids]),
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow).toEqual([["hung"]]);
    expect(lines).toEqual([
      "[session] gave up waiting for session hung after 0s — any file on disk is from an earlier save\n",
    ]);
  });

  test("a fast drain neither calls onSlow nor waits for the timeout", async () => {
    const saver = new SessionSaver({ save: async () => {} }, () => {});
    saver.save(rec("fast", 1));
    let slowCalls = 0;
    const started = Date.now();
    expect(await saver.drain({ timeoutMs: 5_000, slowMs: 50, onSlow: () => slowCalls++ })).toEqual(
      [],
    );
    expect(Date.now() - started).toBeLessThan(1000);
    await Bun.sleep(80);
    expect(slowCalls).toBe(0);
  });

  test("a throwing notice listener does not turn a handled failure into a crash", async () => {
    const { store, control } = flakyStore("bad-listener");
    const saver = new SessionSaver(store, () => {
      throw new Error("listener broke");
    });
    control.failing = new Error("EROFS");
    saver.save(rec("b", 1));
    expect(await saver.drain()).toHaveLength(1);
  });

  test("failed(): a save that never reached the store is reported like a failed write (notice + drain)", async () => {
    const notices: string[] = [];
    const saver = new SessionSaver(new JsonSessionStore(join(dir, "failed")), (t) =>
      notices.push(t),
    );
    saver.failed("abcdef0123", "could not read the history back: connection closed");
    saver.failed("abcdef0123", "again"); // still failing: no second notice
    expect(notices).toEqual([
      "⚠ Session abcdef01 not saved — could not read the history back: connection closed. The conversation continues; tentacle retries after the next turn.",
    ]);
    expect(await saver.drain()).toEqual([
      "[session] not saved: abcdef0123 — again (any file on disk is from an earlier save)\n",
    ]);
    saver.save(rec("abcdef0123", 2));
    expect(await saver.drain()).toEqual([]);
    expect(notices.at(-1)).toBe("Session abcdef01 saved again.");
  });
});
