import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "@tentacle/agent";
import { LogSessionStore } from "@tentacle/daemon";
import { ChatMessageSchema } from "@tentacle/protocol";
import type { SessionChoice } from "@tentacle/tui";
import { resolveResume } from "../src/session-resume.ts";
import { saveFixture } from "./session-fixture.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tentacle-resume-"));
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
  title: `title ${id}`,
  // A string title is the derived (auto) one: a log derives it from the first user message.
  messages: [{ role: "user", content: `title ${id}` }],
});

describe("resolveResume", () => {
  test("explicit uid: ok resumes, absent starts fresh", async () => {
    const store = new LogSessionStore(join(dir, "explicit"));
    await saveFixture(store, rec("s1", 1));
    const ok = await resolveResume(store, "s1");
    expect(ok.record?.id).toBe("s1");
    expect(ok.lines).toEqual(["[resume] s1 — title s1\n"]);
    expect(ok.fatal).toBe(false);
    const absent = await resolveResume(store, "nope");
    expect(absent).toEqual({
      record: null,
      lines: ['[resume] no session "nope"; starting fresh\n'],
      notices: [],
      fatal: false,
    });
  });

  test("explicit uid that is unreadable is fatal and names the file", async () => {
    const d = join(dir, "corrupt");
    const store = new LogSessionStore(d);
    await saveFixture(store, rec("bad", 1));
    await writeFile(join(d, "bad.jsonl"), '{"id": "bad", "messa\n');
    const result = await resolveResume(store, "bad");
    expect(result.fatal).toBe(true);
    expect(result.record).toBeNull();
    expect(result.lines[0]).toContain('session "bad" is unreadable: line 1 is not JSON');
    expect(result.lines[0]).toContain(join(d, "bad.jsonl"));
  });

  test("an invalid uid is fatal without naming a (normalized, misleading) path", async () => {
    const result = await resolveResume(new LogSessionStore(join(dir, "invalid")), "../etc");
    expect(result).toEqual({
      record: null,
      lines: ['[resume] "../etc" is not a valid session id; not starting\n'],
      notices: [],
      fatal: true,
    });
  });

  test("no uid: the newest valid session resumes and skipped files are reported in and out of the TUI", async () => {
    const d = join(dir, "latest");
    const store = new LogSessionStore(d);
    await saveFixture(store, rec("old", 1000));
    await writeFile(join(d, "newer.jsonl"), "{trunc");
    const result = await resolveResume(store, undefined);
    expect(result.record?.id).toBe("old");
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain("Skipped 1 unreadable session file(s)");
    expect(result.notices[0]).toContain("newer.jsonl");
    expect(result.lines).toEqual([`[resume] ${result.notices[0]}\n`, "[resume] old — title old\n"]);
  });

  test("no uid, nothing valid: starts fresh but still reports what was skipped", async () => {
    const d = join(dir, "only-bad");
    await saveFixture(new LogSessionStore(d), rec("x", 1));
    await writeFile(join(d, "x.jsonl"), "[]\n");
    const result = await resolveResume(new LogSessionStore(d), undefined);
    expect(result.record).toBeNull();
    expect(result.fatal).toBe(false);
    expect(result.notices).toHaveLength(1);
    expect(result.lines.at(-1)).toBe("[resume] no saved sessions yet; starting fresh\n");
  });
});

// `--resume` on a terminal: the user picks (docs/feat/resume-picker.md).
describe("resolveResume with a picker", () => {
  /** A picker spy that answers `answer` and records what it was offered. */
  function spyPick(answer: (ids: string[]) => string | null) {
    const offered: string[][] = [];
    const pick = async (choices: readonly SessionChoice[]) => {
      const ids = choices.map((c) => c.id);
      offered.push(ids);
      return answer(ids);
    };
    return { pick, offered };
  }

  async function storeWith(name: string, ...records: SessionRecord[]): Promise<LogSessionStore> {
    const store = new LogSessionStore(join(dir, name));
    for (const r of records) {
      await saveFixture(store, r);
    }
    await store.drain();
    return store;
  }

  test("several sessions: offered newest first, the chosen one (not the newest) resumes", async () => {
    // Mutation: ignore `pick` (always the newest) → "s3" resumes instead of "s1".
    const store = await storeWith("pick", rec("s1", 1000), rec("s3", 3000), rec("s2", 2000));
    const { pick, offered } = spyPick(() => "s1");
    const result = await resolveResume(store, undefined, undefined, pick);
    expect(offered).toEqual([["s3", "s2", "s1"]]);
    expect(result.record?.id).toBe("s1");
    expect(result.lines).toEqual(["[resume] s1 — title s1\n"]);
    expect(result.fatal).toBe(false);
    expect(result.cancelled).toBeUndefined();
  });

  test("the choices carry title, updatedAt and the visible message count", async () => {
    const withSystem: SessionRecord = {
      ...rec("s1", 1000),
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "title s1" },
        { role: "assistant", content: "hello" },
      ],
    };
    const store = await storeWith("choices", withSystem, rec("s2", 2000));
    let seen: readonly SessionChoice[] = [];
    await resolveResume(store, undefined, undefined, async (choices) => {
      seen = choices;
      return null;
    });
    expect(seen).toEqual([
      { id: "s2", title: "title s2", updatedAt: 2000, messageCount: 1 },
      { id: "s1", title: "title s1", updatedAt: 1000, messageCount: 2 },
    ]);
  });

  test("cancelled: nothing resumes, not fatal, silent (no line)", async () => {
    // Mutation: treat null as "start fresh" → a fresh session starts after Esc.
    const store = await storeWith("cancel", rec("s1", 1000), rec("s2", 2000));
    const result = await resolveResume(store, undefined, undefined, spyPick(() => null).pick);
    expect(result).toEqual({
      record: null,
      lines: [],
      notices: [],
      fatal: false,
      cancelled: true,
    });
  });

  test("0 or 1 session: nothing to choose, the picker is not shown", async () => {
    // Mutation: drop the `records.length < 2` guard → the spy is called.
    const one = await storeWith("one", rec("only", 1000));
    const spy = spyPick(() => "only");
    expect((await resolveResume(one, undefined, undefined, spy.pick)).record?.id).toBe("only");
    const none = await resolveResume(
      new LogSessionStore(join(dir, "none")),
      undefined,
      undefined,
      spy.pick,
    );
    expect(none.record).toBeNull();
    expect(spy.offered).toEqual([]);
  });

  test("an explicit uid never shows the picker", async () => {
    const store = await storeWith("uid-no-pick", rec("s1", 1000), rec("s2", 2000));
    const spy = spyPick(() => "s2");
    expect((await resolveResume(store, "s1", undefined, spy.pick)).record?.id).toBe("s1");
    expect(spy.offered).toEqual([]);
  });

  test("an id the picker invents is refused, never resumed", async () => {
    const store = await storeWith("invented", rec("s1", 1000), rec("s2", 2000));
    const result = await resolveResume(store, undefined, undefined, spyPick(() => "zzz").pick);
    expect(result.record).toBeNull();
    expect(result.fatal).toBe(true);
  });

  test("skipped files are still reported when the user picks", async () => {
    const store = await storeWith("pick-skipped", rec("s1", 1000), rec("s2", 2000));
    await writeFile(join(dir, "pick-skipped", "bad.jsonl"), "{trunc");
    const result = await resolveResume(store, undefined, undefined, spyPick(() => "s1").pick);
    expect(result.record?.id).toBe("s1");
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain("bad.jsonl");
  });
});
