/**
 * docs/fix/attach-plain-resume.md: the units behind "attach to a plain kept
 * container reopens the run's conversation" — the entry's `sessionId`, its
 * laptop-side writer, the saver observer and the pure attach decision.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "@tentacle/agent";
import { plainResumeUid } from "../src/attach-plan.ts";
import {
  forgetKept,
  readKept,
  recordKept,
  setKeptSession,
  trackKeptSession,
} from "../src/kept-index.ts";
import { type KeptEntry, parseKeptEntry } from "../src/kept.ts";
import { SessionSaver } from "../src/session-saver.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const fresh = (): string => join(mkdtempSync(join(tmpdir(), "kept-sess-")), "kept");
const entry = (name: string, over: Partial<KeptEntry> = {}): KeptEntry => ({
  schemaVersion: 1,
  name,
  engine: "docker",
  endpoint: "unix:///var/run/docker.sock",
  model: "m",
  created: "2026-10-27T10:00:00.000Z",
  ...over,
});
const rec = (id: string): SessionRecord => ({
  id,
  cwd: "/w",
  model: "m",
  createdAt: 1,
  updatedAt: 1,
  title: id,
  messages: [{ role: "user", content: "hi" }],
});

describe("KeptEntry.sessionId", () => {
  test("a valid id round-trips; an invalid one is dropped, the entry kept", () => {
    const base = entry("a");
    expect(parseKeptEntry(JSON.stringify({ ...base, sessionId: A }))).toEqual({
      ok: true,
      entry: { ...base, sessionId: A },
    });
    expect(parseKeptEntry(JSON.stringify({ ...base, sessionId: "../../etc/passwd" }))).toEqual({
      ok: true,
      entry: base,
    });
    expect(parseKeptEntry(JSON.stringify({ ...base, sessionId: 7 }))).toEqual({
      ok: true,
      entry: base,
    });
  });
});

describe("KeptEntry.cwd", () => {
  test("round-trips; an entry without it still parses (older index files)", () => {
    const base = entry("a");
    expect(parseKeptEntry(JSON.stringify({ ...base, cwd: "/Users/me/code" }))).toEqual({
      ok: true,
      entry: { ...base, cwd: "/Users/me/code" },
    });
    expect(parseKeptEntry(JSON.stringify(base))).toEqual({ ok: true, entry: base });
    expect(parseKeptEntry(JSON.stringify({ ...base, cwd: 7 }))).toEqual({ ok: true, entry: base });
  });
});

describe("plainResumeUid", () => {
  const none = { resume: false, continue: false };
  test("a kept entry's session is reopened; no id, or no kept entry: nothing", () => {
    expect(plainResumeUid({ sessionId: A }, none)).toBe(A);
    expect(plainResumeUid({}, none)).toBeUndefined();
    expect(plainResumeUid(undefined, none)).toBeUndefined();
  });
  test("--resume (with or without a uid) and --continue win", () => {
    expect(plainResumeUid({ sessionId: A }, { resume: true, continue: false })).toBeUndefined();
    expect(plainResumeUid({ sessionId: A }, { resume: false, continue: true })).toBeUndefined();
  });
});

describe("SessionSaver.observe", () => {
  test("sees every saved record; a throwing listener never breaks the save", async () => {
    const seen: string[] = [];
    const saved: string[] = [];
    const saver = new SessionSaver(
      {
        write: async () => {},
        saveSnapshot: async (r) => {
          saved.push(r.id);
        },
        remove: async () => {},
      },
      () => {},
    );
    saver.observe((r) => seen.push(r.id));
    saver.observe(() => {
      throw new Error("listener bug");
    });
    saver.save(rec("one"));
    saver.save(rec("two"));
    expect(await saver.drain()).toEqual([]);
    expect(seen).toEqual(["one", "two"]);
    expect(saved).toEqual(["one", "two"]);
  });

  test("a removed session is not observed (never written back)", async () => {
    const seen: string[] = [];
    const saver = new SessionSaver(
      { write: async () => {}, saveSnapshot: async () => {}, remove: async () => {} },
      () => {},
    );
    saver.observe((r) => seen.push(r.id));
    saver.remove("gone");
    saver.save(rec("gone"));
    await saver.drain();
    expect(seen).toEqual([]);
  });
});

describe("setKeptSession / trackKeptSession", () => {
  const sessionOf = (dir: string, name = "a"): string | undefined =>
    readKept(dir).entries.find((e) => e.entry.name === name)?.entry.sessionId;

  test("writes the id into the entry's own file, keeping its other fields", () => {
    const dir = fresh();
    recordKept(dir, entry("a", { mount: "/w", profile: "p" }));
    expect(setKeptSession(dir, entry("a", { mount: "/w", profile: "p" }), A)).toBe(true);
    expect(readKept(dir).entries.map((e) => e.entry)).toEqual([
      entry("a", { mount: "/w", profile: "p", sessionId: A }),
    ]);
    expect(setKeptSession(dir, entry("a"), B)).toBe(true);
    expect(sessionOf(dir)).toBe(B);
  });

  test("an entry that is gone is not resurrected; one of another `created` is left untouched", () => {
    const dir = fresh();
    const file = recordKept(dir, entry("a"));
    forgetKept(file); // `tentacle rm` while the run's TUI is open
    expect(setKeptSession(dir, entry("a"), A)).toBe(false);
    expect(readKept(dir).entries).toEqual([]);
    // A re-run under the same name re-recorded the entry: the old process must not touch it.
    recordKept(dir, entry("a", { created: "2026-11-01T00:00:00.000Z" }));
    expect(setKeptSession(dir, entry("a"), A)).toBe(false);
    expect(sessionOf(dir)).toBeUndefined();
  });

  test("track: records a NEW uid once per change (/clear, /resume)", () => {
    const dir = fresh();
    recordKept(dir, entry("a"));
    const listeners: Array<(r: { readonly id: string }) => void> = [];
    const errors: string[] = [];
    trackKeptSession({ observe: (l) => listeners.push(l) }, dir, entry("a"), (m) => errors.push(m));
    expect(listeners).toHaveLength(1);
    listeners[0]?.({ id: A });
    expect(sessionOf(dir)).toBe(A);
    // The same uid again: no rewrite (the file is left as it is).
    const file = readKept(dir).entries[0]?.file ?? "";
    const before = readFileSync(file, "utf8");
    writeFileSync(file, `${before}\n`);
    listeners[0]?.({ id: A });
    expect(readFileSync(file, "utf8")).toBe(`${before}\n`);
    listeners[0]?.({ id: B }); // /clear: the next turn is another session
    expect(sessionOf(dir)).toBe(B);
    expect(errors).toEqual([]);
  });

  test("track: a failing index write is ONE message, never thrown into the saver", () => {
    const dir = fresh();
    recordKept(dir, entry("a"));
    const listeners: Array<(r: { readonly id: string }) => void> = [];
    const errors: string[] = [];
    trackKeptSession({ observe: (l) => listeners.push(l) }, dir, entry("a"), (m) => errors.push(m));
    // The entry is readable but the dir is not writable: every write fails (EACCES).
    chmodSync(dir, 0o500);
    try {
      expect(() => listeners[0]?.({ id: A })).not.toThrow();
      expect(() => listeners[0]?.({ id: B })).not.toThrow();
      expect(errors).toHaveLength(1);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
