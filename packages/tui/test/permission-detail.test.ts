/**
 * What a permission ask's dialog SHOWS for the file-editing tools
 * (docs/feat/detach-small-fixes.md item 4): the title, and the subject rows
 * `permissionDetailLines` builds from it. The bug: a `fs_multi_edit` ask had no
 * `describeToolCall` case, so its only row was `—` — the person was asked to
 * approve an edit with no idea of which file, or how many edits.
 */
import { describe, expect, test } from "bun:test";
import { describeToolCall } from "@tentacle/agent";
import type { Tool } from "@tentacle/core";
import { fsMultiEditTool } from "@tentacle/tools";
import { permissionDetailLines } from "../src/permission-ui.ts";

const ask = (name: string, input: unknown) =>
  describeToolCall({ name, permission: "ask" } as unknown as Tool, input);

const rows = (name: string, input: unknown): string[] => permissionDetailLines(ask(name, input));

describe("permission dialog rows for fs_multi_edit", () => {
  test("several edits: the path and how many, never `—`", () => {
    // Mutation: drop the `fs_multi_edit` case → ["—"].
    const input = {
      path: "src/a.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    };
    expect(rows("fs_multi_edit", input)).toEqual(["src/a.ts · 2 edits"]);
    expect(ask("fs_multi_edit", input).title).toBe("Edit a file");
  });

  test("one edit reads in the singular", () => {
    // Mutation: always "edits" → "src/a.ts · 1 edits".
    expect(rows("fs_multi_edit", { path: "src/a.ts", edits: [{ old_string: "a" }] })).toEqual([
      "src/a.ts · 1 edit",
    ]);
  });

  test("a rewrite with no readable `edits` still names the file (never a throw)", () => {
    // A hook may rewrite the input; the prompt must survive a shape it cannot read.
    expect(rows("fs_multi_edit", { path: "src/a.ts" })).toEqual(["src/a.ts"]);
    expect(rows("fs_multi_edit", { path: "src/a.ts", edits: "two" })).toEqual(["src/a.ts"]);
    expect(rows("fs_multi_edit", { path: "src/a.ts", edits: [] })).toEqual(["src/a.ts"]);
  });

  test("nothing readable at all keeps today's `—`", () => {
    expect(rows("fs_multi_edit", {})).toEqual(["—"]);
    expect(rows("fs_multi_edit", null)).toEqual(["—"]);
  });

  test("fs_edit and fs_write are unchanged (the neighbours of the new case)", () => {
    expect(rows("fs_edit", { path: "src/b.ts" })).toEqual(["src/b.ts"]);
    expect(rows("fs_write", { path: "src/c.ts" })).toEqual(["src/c.ts"]);
    expect(ask("fs_edit", { path: "src/b.ts" }).title).toBe("Edit a file");
  });

  test("the real tool's own schema shape renders (not a hand-written stub)", () => {
    // `fsMultiEditTool`'s input is `{path, edits: [{old_string, new_string}]}`.
    expect(
      permissionDetailLines(
        describeToolCall(fsMultiEditTool as unknown as Tool, {
          path: "lib/x.ts",
          edits: [
            { old_string: "x", new_string: "y" },
            { old_string: "z", new_string: "w" },
            { old_string: "p", new_string: "q" },
          ],
        }),
      ),
    ).toEqual(["lib/x.ts · 3 edits"]);
  });
});
