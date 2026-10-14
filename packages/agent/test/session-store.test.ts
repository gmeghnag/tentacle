import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "@agent-harness/core";
import { JsonSessionStore, recordFromSnapshot, sessionTitle } from "../src/index.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-sessions-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const messages = (text: string): ChatMessage[] => [
  { role: "user", content: text },
  { role: "assistant", content: "ok" },
];

describe("sessionTitle", () => {
  test("uses the first user message, collapsed and trimmed", () => {
    expect(sessionTitle([{ role: "user", content: "  hello\n  world  " }])).toBe("hello world");
    expect(sessionTitle([{ role: "assistant", content: "x" }])).toBe("(empty)");
    expect(sessionTitle([{ role: "user", content: "a".repeat(200) }]).length).toBe(80);
  });
});

describe("recordFromSnapshot", () => {
  test("carries metadata and derives the title; preserves createdAt", () => {
    const rec = recordFromSnapshot(
      { id: "s1", messages: messages("do a thing") },
      { cwd: "/work", model: "qwen3", createdAt: 1000 },
    );
    expect(rec).toMatchObject({ id: "s1", cwd: "/work", model: "qwen3", createdAt: 1000 });
    expect(rec.title).toBe("do a thing");
    expect(rec.updatedAt).toBeGreaterThanOrEqual(1000);
  });
});

describe("JsonSessionStore", () => {
  test("save → load round-trips a record", async () => {
    const store = new JsonSessionStore(dir);
    const rec = recordFromSnapshot(
      { id: "round", messages: messages("hi") },
      {
        cwd: "/w",
        model: "m",
      },
    );
    await store.save(rec);
    const loaded = await store.load("round");
    expect(loaded).toEqual(rec);
  });

  test("load returns null for an unknown id", async () => {
    expect(await new JsonSessionStore(dir).load("nope")).toBeNull();
  });

  test("list is newest-updated first; latest() is its head", async () => {
    const store = new JsonSessionStore(join(dir, "multi"));
    await store.save(
      recordFromSnapshot(
        { id: "old", messages: messages("old") },
        { cwd: "/w", model: "m", createdAt: 1 },
      ),
    );
    await store.save(
      recordFromSnapshot(
        { id: "new", messages: messages("new") },
        { cwd: "/w", model: "m", createdAt: 1 },
      ),
    );
    // Force a strictly-greater updatedAt on "new" by re-saving it.
    await Bun.sleep(2);
    await store.save(
      recordFromSnapshot(
        { id: "new", messages: messages("new") },
        { cwd: "/w", model: "m", createdAt: 1 },
      ),
    );

    const list = await store.list();
    expect(list.map((r) => r.id)).toEqual(["new", "old"]);
    expect((await store.latest())?.id).toBe("new");
  });

  test("list/latest tolerate a missing directory", async () => {
    const store = new JsonSessionStore(join(dir, "does-not-exist"));
    expect(await store.list()).toEqual([]);
    expect(await store.latest()).toBeNull();
  });
});
