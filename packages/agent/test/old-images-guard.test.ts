/**
 * T5 of docs/feat/image-old-on-demand.md (F9): the placeholder the model is
 * shown in place of an aged user image stays under the EXISTING prune guard —
 * quoting it into a file is refused, nothing is written, no second guard.
 */
import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment, ToolContext } from "@tentacle/core";
import { fsEditTool, fsMultiEditTool, fsWriteTool } from "@tentacle/tools";
import { oldImagePlaceholder } from "../src/old-images.ts";
import { PRUNE_MARKER } from "../src/prune.ts";

const image = oldImagePlaceholder({
  id: "a".repeat(64),
  mimeType: "image/png",
  size: 590 * 1024,
  name: "screenshot.png",
});

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

describe("an old-image placeholder is refused as file content", () => {
  test("it starts with the prune marker, so the existing guard covers it", () => {
    expect(image.startsWith(`${PRUNE_MARKER}:`)).toBe(true);
    expect(image).toContain("image_view aaaaaaaaaaaa");
  });

  test("fs_write refuses it, alone and inside a document, and writes nothing", async () => {
    for (const content of [image, `# notes\n${image}\nmore\n`]) {
      const files: Record<string, string> = { "a.txt": "real" };
      const r = await fsWriteTool.execute({ path: "a.txt", content }, ctx(env(files)));
      expect(r.isError).toBe(true);
      expect(r.content).toContain("pruned placeholder");
      expect(files["a.txt"]).toBe("real");
    }
  });

  test("fs_edit and fs_multi_edit inherit the same refusal", async () => {
    const edit = await fsEditTool.execute(
      { path: "a.txt", old_string: "real", new_string: image },
      ctx(env({ "a.txt": "real" })),
    );
    expect(edit.isError).toBe(true);
    const multi = await fsMultiEditTool.execute(
      { path: "a.txt", edits: [{ old_string: "real", new_string: image }] },
      ctx(env({ "a.txt": "real" })),
    );
    expect(multi.isError).toBe(true);
  });
});
