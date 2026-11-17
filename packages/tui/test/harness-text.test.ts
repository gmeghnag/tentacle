/**
 * S2 (feat/harness-notices): a harness line is plain text. Its `_…_` source is
 * markdown for the module it USED to be (a command reply), so the markers at the
 * 47 call sites must not reach the grey row as literal punctuation.
 *
 * RED before the fix: `stripInlineMarkdown` did not exist; `/attach` rendered
 * `` Usage: `/attach <path>`… `` with the backticks in it, and an engine's
 * `/_ping` came through as `/\_ping` (the `noticeText` escape, added to survive
 * markdown, visible because a harness line no longer runs through it).
 */
import { describe, expect, test } from "bun:test";
import { stripInlineMarkdown } from "../src/harness-text.ts";

describe("stripInlineMarkdown", () => {
  test("inline code loses its backticks, keeps its text", () => {
    // The exact call sites (`useAttachments.ts:254`, `commands.ts:198`).
    expect(stripInlineMarkdown("Usage: `/attach <path>` (a path may be dragged in)")).toBe(
      "Usage: /attach <path> (a path may be dragged in)",
    );
    expect(stripInlineMarkdown("Usage: `/rename <title>`")).toBe("Usage: /rename <title>");
  });

  test("bold loses its markers, both spellings, including inside a word span", () => {
    expect(stripInlineMarkdown("**MCP servers** — 1 of 1 reachable")).toBe(
      "MCP servers — 1 of 1 reachable",
    );
    expect(stripInlineMarkdown("__note__: done")).toBe("note: done");
  });

  test("a backslash escape is undone (the hop's engine text)", () => {
    expect(stripInlineMarkdown("not moved: Docker API GET /\\_ping failed")).toBe(
      "not moved: Docker API GET /_ping failed",
    );
    expect(stripInlineMarkdown("\\*literal\\*")).toBe("*literal*");
  });

  test("a LONE `*` or `_` is punctuation, not a marker: it stays", () => {
    // Mutation: strip every `*`/`_` → an engine's own punctuation disappears.
    expect(stripInlineMarkdown("no such container: a_b")).toBe("no such container: a_b");
    expect(stripInlineMarkdown("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(stripInlineMarkdown("exit_1")).toBe("exit_1");
  });

  test("plain text and an unmatched marker are untouched", () => {
    expect(stripInlineMarkdown("a job finished")).toBe("a job finished");
    expect(stripInlineMarkdown("5 * 3 and a_lone")).toBe("5 * 3 and a_lone");
    expect(stripInlineMarkdown("`unclosed")).toBe("`unclosed");
  });
});
