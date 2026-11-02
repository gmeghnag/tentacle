import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AutoAcceptFs, openSharedAutoAccept } from "../src/shared-auto-accept.ts";

// docs/fix/detach-live.md B3: a detached run's auto-accept, per session,
// shared by every TUI on it through `<runDir>/auto-accept/<sessionId>`.

const DIR = "/run";
const S = "55555555-5555-4555-8555-555555555555";
const path = (id: string) => join(DIR, "auto-accept", id);

/** An in-memory run dir; `broken` makes a path's read, or every write, throw. */
function memFs() {
  const files = new Map<string, string>();
  const broken = { read: new Set<string>(), write: false };
  const fs: AutoAcceptFs = {
    read: async (p) => {
      if (broken.read.has(p)) throw new Error("EACCES");
      const text = files.get(p);
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
    write: (p, text) => {
      if (broken.write) throw new Error("EROFS");
      files.set(p, text);
    },
  };
  return { fs, files, broken };
}

/** A poll the test ticks by hand. */
function clock() {
  let tick: (() => void) | null = null;
  let stopped = false;
  return {
    every: (fn: () => void) => {
      tick = fn;
      return () => {
        stopped = true;
      };
    },
    tick: async () => {
      tick?.();
      await new Promise((r) => setTimeout(r, 1));
    },
    stopped: () => stopped,
  };
}

const open = async (
  m: ReturnType<typeof memFs>,
  c: ReturnType<typeof clock>,
  fallback: boolean,
  notes: string[] = [],
) =>
  openSharedAutoAccept({
    dir: DIR,
    sessionId: S,
    fallback,
    fs: m.fs,
    every: c.every,
    onWriteError: (text) => notes.push(text),
  });

describe("D20 the shared auto-accept file", () => {
  test("who starts how: the session's file wins; no file, the run's bit (a session turned OFF stays OFF)", async () => {
    const m = memFs();
    expect((await open(m, clock(), true)).current()).toBe(true);
    expect((await open(m, clock(), false)).current()).toBe(false);
    m.files.set(path(S), "off\n");
    expect((await open(m, clock(), true)).current()).toBe(false);
    m.files.set(path(S), "on");
    expect((await open(m, clock(), false)).current()).toBe(true);
  });

  test("F3 only a MISSING file falls back to the run's bit: malformed, unreadable, a directory are OFF, never ON", async () => {
    // Mutations: every read error falls back (`on` untouched in the catch);
    // `?? on` back; parseAutoAccept reads garbage as ON (reviewer's O2).
    for (const fallback of [true, false]) {
      const m = memFs();
      m.files.set(path(S), "maybe");
      expect((await open(m, clock(), fallback)).current()).toBe(false);
      m.files.set(path(S), '{"on":true}');
      expect((await open(m, clock(), fallback)).current()).toBe(false);
      m.broken.read.add(path(S)); // EACCES, after a person's OFF
      expect((await open(m, clock(), fallback)).current()).toBe(false);
    }
    const dir = mkdtempSync(join(tmpdir(), "auto-accept-"));
    mkdirSync(join(dir, "auto-accept", S), { recursive: true }); // EISDIR
    const real = await openSharedAutoAccept({
      dir,
      sessionId: S,
      fallback: true,
      every: clock().every,
    });
    expect(real.current()).toBe(false);
  });

  test("F3 a file damaged under a live TUI turns it OFF; a later valid flip applies again", async () => {
    // Mutations: the poll's `?? on`; the poll's catch keeps the value.
    const m = memFs();
    const c = clock();
    const feed = await open(m, c, true);
    const seen: boolean[] = [];
    feed.onChange((on) => seen.push(on));
    m.files.set(path(S), "garbage");
    await c.tick();
    expect(feed.current()).toBe(false);
    m.files.set(path(S), "on");
    await c.tick();
    expect(feed.current()).toBe(true);
    m.broken.read.add(path(S));
    await c.tick();
    expect(feed.current()).toBe(false);
    m.broken.read.delete(path(S)); // the same text again: it must apply
    await c.tick();
    expect(seen).toEqual([false, true, false, true]);
  });

  test("a flip by another TUI is seen within one poll, once", async () => {
    const m = memFs();
    const c = clock();
    const feed = await open(m, c, false);
    const seen: boolean[] = [];
    feed.onChange((on) => seen.push(on));
    await c.tick();
    expect(seen).toEqual([]);
    m.files.set(path(S), "on"); // the other TUI's Shift+Tab
    await c.tick();
    await c.tick();
    expect(seen).toEqual([true]);
    expect(feed.current()).toBe(true);
  });

  test("deleted under a live TUI: the current value is kept; the next valid flip applies", async () => {
    const m = memFs();
    const c = clock();
    m.files.set(path(S), "on");
    const feed = await open(m, c, false);
    const seen: boolean[] = [];
    feed.onChange((on) => seen.push(on));
    m.files.delete(path(S));
    await c.tick();
    expect(seen).toEqual([]);
    expect(feed.current()).toBe(true);
    m.files.set(path(S), "off");
    await c.tick();
    expect(seen).toEqual([false]);
  });

  test("this TUI's flip: applied at once, written; a failed write is said and stays local (the poll does not undo it)", async () => {
    const m = memFs();
    const c = clock();
    const notes: string[] = [];
    const feed = await open(m, c, true, notes);
    const seen: boolean[] = [];
    feed.onChange((on) => seen.push(on));
    feed.set(false);
    expect(feed.current()).toBe(false);
    expect(m.files.get(path(S))).toBe("off");
    await c.tick();
    expect(seen).toEqual([]); // its own write is not a change from elsewhere
    m.files.set(path(S), "on"); // another TUI
    await c.tick();
    expect(seen).toEqual([true]);
    m.broken.write = true;
    feed.set(false);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("auto-accept");
    await c.tick();
    expect(feed.current()).toBe(false); // the file still says on: not re-applied
  });

  test("`use` moves the key (`/clear`): the run's file is no longer read; the value carried over; the first flip writes the new key", async () => {
    // Mutation: a TUI on a fresh session reads the run's file.
    const m = memFs();
    const c = clock();
    const feed = await open(m, c, true);
    const seen: boolean[] = [];
    feed.onChange((on) => seen.push(on));
    feed.use("FRESH");
    expect(feed.current()).toBe(true);
    m.files.set(path(S), "off"); // a TUI still on the run's session
    await c.tick();
    expect(seen).toEqual([]);
    feed.set(false);
    expect(m.files.get(path("FRESH"))).toBe("off");
  });

  test("a read in flight across this TUI's flip never reverts it; `stop` ends the poll", async () => {
    const m = memFs();
    const c = clock();
    const feed = await open(m, c, false);
    m.files.set(path(S), "off");
    // A poll whose read is answered after this TUI flipped ON.
    let release: () => void = () => {};
    const slow = m.fs.read;
    m.fs.read = (p) =>
      new Promise((resolve) => {
        release = () => resolve(m.files.get(p) ?? "off");
      });
    c.tick();
    feed.set(true);
    m.files.set(path(S), "off"); // what the slow read saw before the flip
    release();
    await new Promise((r) => setTimeout(r, 5));
    m.fs.read = slow;
    expect(feed.current()).toBe(true);
    feed.stop();
    expect(c.stopped()).toBe(true);
  });

  test("the real file: 0600 in a 0700 dir, one word", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-accept-"));
    const c = clock();
    const feed = await openSharedAutoAccept({ dir, sessionId: S, fallback: true, every: c.every });
    feed.set(false);
    const file = join(dir, "auto-accept", S);
    expect(readFileSync(file, "utf8")).toBe("off");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "auto-accept")).mode & 0o777).toBe(0o700);
    const again = await openSharedAutoAccept({ dir, sessionId: S, fallback: true, every: c.every });
    expect(again.current()).toBe(false);
  });
});
