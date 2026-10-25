import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore, type SessionRecord, parseSessionRecord } from "@tentacle/agent";
import { ChatMessageSchema } from "@tentacle/protocol";
import type { SessionChoice } from "@tentacle/tui";
import { resolveResume } from "../src/session-resume.ts";

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
  messages: [{ role: "user", content: "hi" }],
});

describe("resolveResume", () => {
  test("explicit uid: ok resumes, absent starts fresh", async () => {
    const store = new JsonSessionStore(join(dir, "explicit"));
    await store.save(rec("s1", 1));
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
    const store = new JsonSessionStore(d);
    await store.save(rec("bad", 1));
    await writeFile(join(d, "bad.json"), '{"id": "bad", "messa');
    const result = await resolveResume(store, "bad");
    expect(result.fatal).toBe(true);
    expect(result.record).toBeNull();
    expect(result.lines[0]).toContain('session "bad" is unreadable: invalid JSON');
    expect(result.lines[0]).toContain(join(d, "bad.json"));
  });

  test("an invalid uid is fatal without naming a (normalized, misleading) path", async () => {
    const result = await resolveResume(new JsonSessionStore(join(dir, "invalid")), "../etc");
    expect(result).toEqual({
      record: null,
      lines: ['[resume] "../etc" is not a valid session id; not starting\n'],
      notices: [],
      fatal: true,
    });
  });

  test("no uid: the newest valid session resumes and skipped files are reported in and out of the TUI", async () => {
    const d = join(dir, "latest");
    const store = new JsonSessionStore(d);
    await store.save(rec("old", 1000));
    await writeFile(join(d, "newer.json"), "{trunc");
    const result = await resolveResume(store, undefined);
    expect(result.record?.id).toBe("old");
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain("Skipped 1 unreadable session file(s)");
    expect(result.notices[0]).toContain("newer.json");
    expect(result.lines).toEqual([`[resume] ${result.notices[0]}\n`, "[resume] old — title old\n"]);
  });

  test("no uid, nothing valid: starts fresh but still reports what was skipped", async () => {
    const d = join(dir, "only-bad");
    await new JsonSessionStore(d).save(rec("x", 1));
    await writeFile(join(d, "x.json"), "[]");
    const result = await resolveResume(new JsonSessionStore(d), undefined);
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

  async function storeWith(name: string, ...records: SessionRecord[]): Promise<JsonSessionStore> {
    const store = new JsonSessionStore(join(dir, name));
    for (const r of records) {
      await store.save(r);
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
        { role: "user", content: "hi" },
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

  test("cancelled: nothing resumes, not fatal, a line says so", async () => {
    // Mutation: treat null as "start fresh" → a fresh session starts after Esc.
    const store = await storeWith("cancel", rec("s1", 1000), rec("s2", 2000));
    const result = await resolveResume(store, undefined, undefined, spyPick(() => null).pick);
    expect(result).toEqual({
      record: null,
      lines: ["[resume] cancelled\n"],
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
      new JsonSessionStore(join(dir, "none")),
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
    await writeFile(join(dir, "pick-skipped", "bad.json"), "{trunc");
    const result = await resolveResume(store, undefined, undefined, spyPick(() => "s1").pick);
    expect(result.record?.id).toBe("s1");
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain("bad.json");
  });
});

describe("parseSessionRecord mirrors the wire ChatMessageSchema", () => {
  // A record that loads must also seed `session/open` (strict wire messages).
  const cases: unknown[] = [
    { role: "user", content: "x" },
    { role: "system", content: "" },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "sh", arguments: "{}" }] },
    { role: "tool", content: "out", toolCallId: "1" },
    { role: "robot", content: "x" },
    { role: "user" },
    { role: "user", content: 1 },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "sh" }] },
    { role: "assistant", content: "", toolCalls: {} },
    { role: "tool", content: "", toolCallId: 5 },
    // A spilled tool result (docs/feat/tui-spill-note.md), valid and malformed.
    {
      role: "tool",
      content: "b",
      toolCallId: "1",
      spill: { chars: 9, path: "p", head: "h", tail: "t", omitted: 7 },
    },
    {
      role: "tool",
      content: "b",
      toolCallId: "1",
      spill: { chars: 9, head: "h", tail: "", omitted: 0 },
    },
    {
      role: "tool",
      content: "b",
      toolCallId: "1",
      spill: { chars: -1, head: "h", tail: "t", omitted: 7 },
    },
    {
      role: "tool",
      content: "b",
      toolCallId: "1",
      spill: { chars: 1.5, head: "h", tail: "t", omitted: 7 },
    },
    {
      role: "tool",
      content: "b",
      toolCallId: "1",
      spill: { chars: 9, path: "", head: "h", tail: "t", omitted: 7 },
    },
    {
      role: "tool",
      content: "b",
      toolCallId: "1",
      spill: { chars: 9, path: "p".repeat(4097), head: "h", tail: "t", omitted: 7 },
    },
    { role: "tool", content: "b", toolCallId: "1", spill: { chars: 9, tail: "t", omitted: 7 } },
    { role: "tool", content: "b", toolCallId: "1", spill: "x" },
    "not an object",
    null,
  ];
  for (const message of cases) {
    test(`agrees on ${JSON.stringify(message)}`, () => {
      const wire = ChatMessageSchema.safeParse(message).success;
      const store = parseSessionRecord({ ...rec("m", 1), messages: [message] }, "m").ok;
      expect(store).toBe(wire);
    });
  }
  // Unknown keys: the wire STRIPS them since protocol 10 (forward compat), the
  // store still rejects them — stricter is safe: a record that loads still
  // seeds `session/open`.
  for (const message of [
    { role: "user", content: "x", extra: true },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "sh", arguments: "{}", x: 1 }] },
    {
      role: "tool",
      content: "b",
      toolCallId: "1",
      spill: { chars: 9, head: "h", tail: "", omitted: 0, x: 1 },
    },
  ]) {
    test(`an unknown key: the store rejects, the wire strips — ${JSON.stringify(message)}`, () => {
      expect(ChatMessageSchema.safeParse(message).success).toBe(true);
      expect(parseSessionRecord({ ...rec("m", 1), messages: [message] }, "m").ok).toBe(false);
    });
  }
  // Tripwire: a new wire key must be added to the store's mirror (session-store.ts).
  test("the set of allowed message keys is the schema's", () => {
    const keys = Object.keys(ChatMessageSchema.shape).sort();
    expect(keys).toEqual(["content", "role", "spill", "toolCallId", "toolCalls"]);
  });
});
