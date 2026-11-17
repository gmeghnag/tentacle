/**
 * The write tools refuse a pruned placeholder as file content
 * (docs/feat/smart-compaction.md, S2 Design §4): a model that copies a stub
 * into a real write gets a clear error, and the file is untouched.
 */
import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment, ToolContext } from "@tentacle/core";
import { PRUNE_SENTINEL, fsEditTool, fsMultiEditTool, fsWriteTool } from "../src/index.ts";

const STUB = `${PRUNE_SENTINEL}: 4.1k chars, already written to a.txt — fs_read a.txt if you need the text⟫`;

function env(files: Record<string, string>): ExecutionEnvironment {
  return {
    id: "fake",
    exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    async readFile(path) {
      const value = files[path];
      if (value === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      return value;
    },
    async writeFile(path, contents) {
      files[path] = contents;
    },
  };
}

const ctx = (e: ExecutionEnvironment): ToolContext => ({
  sessionId: "s1",
  signal: new AbortController().signal,
  env: e,
});

describe("the write tools refuse a pruned placeholder", () => {
  test("fs_write", async () => {
    const files = { "a.txt": "real" };
    const r = await fsWriteTool.execute(
      { path: "a.txt", content: `x\n${STUB}\n` },
      ctx(env(files)),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("pruned placeholder");
    expect(r.content).toContain("fs_read a.txt");
    expect(files["a.txt"]).toBe("real");
  });

  test("fs_edit (new_string)", async () => {
    const files = { "a.txt": "hello world" };
    const r = await fsEditTool.execute(
      { path: "a.txt", old_string: "world", new_string: STUB },
      ctx(env(files)),
    );
    expect(r.isError).toBe(true);
    expect(files["a.txt"]).toBe("hello world");
  });

  test("fs_multi_edit (any edit's new_string): nothing is written", async () => {
    const files = { "a.txt": "one two" };
    const r = await fsMultiEditTool.execute(
      {
        path: "a.txt",
        edits: [
          { old_string: "one", new_string: "1" },
          { old_string: "two", new_string: STUB },
        ],
      },
      ctx(env(files)),
    );
    expect(r.isError).toBe(true);
    expect(files["a.txt"]).toBe("one two");
  });

  test("the bare marker without the stub's colon is ordinary text (source code may name it)", async () => {
    const files: Record<string, string> = {};
    const content = `export const M = "${PRUNE_SENTINEL}";\n`;
    const r = await fsWriteTool.execute({ path: "m.ts", content }, ctx(env(files)));
    expect(r.isError).toBeUndefined();
    expect(files["m.ts"]).toBe(content);
  });
});
