import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "@tentacle/core";
import { projectKey, recordFromSnapshot, sessionTitle } from "../src/index.ts";

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

describe("sessionTitle skips tentacle-written notes (docs/feat/clear-keeps-jobs.md, T4)", () => {
  test("a still-running note at the head is not the title", () => {
    const note: ChatMessage = {
      role: "user",
      content: "Background jobs still running: bg-1",
      note: { kind: "still_running" },
    };
    expect(sessionTitle([note, { role: "user", content: "real question" }])).toBe("real question");
    expect(sessionTitle([note])).toBe("(empty)");
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

describe("projectKey", () => {
  test("<basename>-<12 hex>, stable, distinct for distinct paths, symlinks resolved", async () => {
    // Mutation: hash the unresolved path → the symlink gets another key.
    const { mkdir, symlink } = await import("node:fs/promises");
    const a = join(dir, "proj-a");
    await mkdir(a, { recursive: true });
    const link = join(dir, "proj-link");
    await symlink(a, link);
    expect(projectKey(a)).toMatch(/^proj-a-[0-9a-f]{12}$/);
    expect(projectKey(a)).toBe(projectKey(`${a}/`));
    expect(projectKey(link)).toBe(projectKey(a));
    expect(projectKey(join(dir, "proj-b"))).not.toBe(projectKey(a)); // absent: still keyed
    expect(projectKey("/")).toMatch(/^root-[0-9a-f]{12}$/);
  });
});
