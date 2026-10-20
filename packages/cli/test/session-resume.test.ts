import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore, type SessionRecord, parseSessionRecord } from "@tentacle/agent";
import { ChatMessageSchema } from "@tentacle/protocol";
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
    { role: "user", content: "x", extra: true },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "sh" }] },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "sh", arguments: "{}", x: 1 }] },
    { role: "assistant", content: "", toolCalls: {} },
    { role: "tool", content: "", toolCallId: 5 },
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
  // Tripwire: a new wire key must be added to the store's mirror (session-store.ts).
  test("the set of allowed message keys is the schema's", () => {
    const keys = Object.keys(ChatMessageSchema.shape).sort();
    expect(keys).toEqual(["content", "role", "toolCallId", "toolCalls"]);
  });
});
