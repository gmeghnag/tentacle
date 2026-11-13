/**
 * A unified diff as rows (12b "Tests"): the counts MUST equal
 * `packages/client/src/mapping.ts`'s `countDiff` on the same patch (that is what
 * the tool row's `+n −m` is built from), plus numbering, the file-header rule
 * and truncation.
 */
import { describe, expect, test } from "bun:test";
import type { ToolResultDetail } from "@tentacle/core";
import { DIFF_MAX_LINES, countDiff, diffView } from "../src/diff-view.ts";

/**
 * The client's own counter, copied here as the ORACLE (it is private there). The
 * last test pins the copy to the real one through the client's own mapping, so
 * a change there cannot silently disagree.
 */
function clientCountDiff(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function detail(patch: string, path = "x.txt"): ToolResultDetail {
  const { added, removed } = clientCountDiff(patch);
  return { kind: "diff", path, patch, added, removed };
}

const PATCH = [
  "--- a/x.txt",
  "+++ b/x.txt",
  "@@ -1,4 +1,4 @@",
  " keep",
  "-old line",
  "+new line",
  " also keep",
  "-another",
  "+and another",
].join("\n");

describe("the counts agree with the client's `countDiff`", () => {
  test("on a two-hunk patch", () => {
    const patch = `${PATCH}\n@@ -20,2 +20,3 @@\n ctx\n+added\n+twice\n-replaced\n`;
    const view = diffView(detail(patch));
    expect({ added: view.added, removed: view.removed }).toEqual(clientCountDiff(patch));
    expect(view.added).toBe(4);
    expect(view.removed).toBe(3);
  });

  test("the same patch the client's mapping would receive (the real one agrees)", async () => {
    // The oracle is a copy of a PRIVATE function, so prove the copy: build the
    // tool result from a `tool_call_update` frame carrying the same patch and
    // read the counts the client derived.
    const mapping = await import("../../../packages/client/src/mapping.ts");
    const event = mapping.updateToEvent(
      {
        type: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        content: [{ type: "resource", uri: "diff://x.txt", text: PATCH }],
      } as never,
      new Map([["c1", "fs_edit"]]),
    );
    if (event?.type !== "tool_result" || event.result.details?.kind !== "diff") {
      throw new Error("expected a diff detail");
    }
    const view = diffView(event.result.details);
    expect({ added: view.added, removed: view.removed }).toEqual({
      added: event.result.details.added,
      removed: event.result.details.removed,
    });
    expect(countDiff(PATCH)).toEqual({
      added: event.result.details.added,
      removed: event.result.details.removed,
    });
  });
});

describe("hunks and line numbers", () => {
  test("a hunk keeps its heading and numbers both sides", () => {
    const view = diffView(detail(PATCH));
    expect(view.path).toBe("x.txt");
    expect(view.hunks).toHaveLength(1);
    const hunk = view.hunks[0];
    if (hunk === undefined) {
      throw new Error("expected a hunk");
    }
    expect(hunk.heading).toBe("@@ -1,4 +1,4 @@");
    expect(hunk.lines.map((line) => line.kind)).toEqual(["ctx", "del", "add", "ctx", "del", "add"]);
    expect(hunk.lines.map((line) => [line.oldNo, line.newNo])).toEqual([
      [1, 1],
      [2, null],
      [null, 2],
      [3, 3],
      [4, null],
      [null, 4],
    ]);
  });

  test("the file headers are not body lines", () => {
    const view = diffView(detail(PATCH));
    const texts = view.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text));
    expect(texts).not.toContain("++ b/x.txt");
    expect(texts.some((text) => text.startsWith("---"))).toBe(false);
  });

  test("`\\ No newline at end of file` is skipped, the numbering unharmed", () => {
    const patch = ["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n");
    const hunk = diffView(detail(patch)).hunks[0];
    expect(hunk?.lines).toHaveLength(2);
    expect(hunk?.lines.map((line) => line.kind)).toEqual(["del", "add"]);
  });

  test("an empty context line keeps the numbering (a bare ``, not ` ` + text)", () => {
    const patch = ["@@ -1,3 +1,3 @@", " a", "", "-b", "+B"].join("\n");
    const hunk = diffView(detail(patch)).hunks[0];
    expect(hunk?.lines.map((line) => [line.kind, line.oldNo, line.newNo])).toEqual([
      ["ctx", 1, 1],
      ["ctx", 2, 2],
      ["del", 3, null],
      ["add", null, 3],
    ]);
  });

  test("a patch with no hunk at all is empty, not an error", () => {
    const view = diffView(detail("--- a/x\n+++ b/x\n"));
    expect(view.hunks).toHaveLength(0);
  });
});

describe("bounds (plan F21)", () => {
  test("a long patch stops at the bound and counts what it held back", () => {
    const body = Array.from({ length: DIFF_MAX_LINES + 50 }, (_, at) => `+line ${at}`);
    const patch = ["@@ -0,0 +1 @@", ...body].join("\n");
    const view = diffView(detail(patch));
    const rendered = view.hunks.flatMap((hunk) => hunk.lines).length;
    expect(rendered).toBe(DIFF_MAX_LINES);
    expect(view.hidden).toBeGreaterThan(0);
    // The counts still describe the WHOLE patch, never only what is drawn.
    expect(view.added).toBe(body.length);
  });

  test("a huge patch is not parsed at all", () => {
    const patch = `@@ -1 +1 @@\n${"+x\n".repeat(200_000)}`;
    const started = performance.now();
    const view = diffView(detail(patch));
    expect(view.hunks).toHaveLength(0);
    expect(view.hidden).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
