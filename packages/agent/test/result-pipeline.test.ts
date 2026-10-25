import { describe, expect, test } from "bun:test";
import type { ToolResult } from "@tentacle/core";
import {
  type ResultTransformContext,
  applyResultTransforms,
  collapseRepeatedLines,
  exemptTools,
  spillLargeOutput,
  summarizeLargeOutput,
  tabulateJson,
} from "../src/result-pipeline.ts";

function ctx(overrides: Partial<ResultTransformContext> = {}): ResultTransformContext {
  return {
    toolName: "shell",
    toolCallId: "c1",
    writeSpill: async () => ".tentacle/tool-output/shell-c1.txt",
    ...overrides,
  };
}

describe("spillLargeOutput", () => {
  test("leaves a small result unchanged", async () => {
    const result: ToolResult = { content: "small", isError: false };
    const out = await spillLargeOutput({ maxInlineChars: 100 })(result, ctx());
    expect(out).toBe(result);
  });

  test("spills a large result and points at the file", async () => {
    let written: string | undefined;
    const big = "x".repeat(5000);
    const out = await spillLargeOutput({ maxInlineChars: 1000, previewChars: 200 })(
      { content: big },
      ctx({
        writeSpill: async (contents) => {
          written = contents;
          return ".tentacle/tool-output/shell-c1.txt";
        },
      }),
    );
    expect(written).toBe(big); // the full output was persisted
    expect(out.content).toContain(".tentacle/tool-output/shell-c1.txt");
    expect(out.content).toContain("read it selectively");
    expect(out.content).toContain("characters omitted");
    expect(out.content.length).toBeLessThan(big.length); // context is protected
  });

  test("falls back to truncation when the spill cannot be written", async () => {
    const big = "y".repeat(5000);
    const out = await spillLargeOutput({ maxInlineChars: 1000, previewChars: 200 })(
      { content: big },
      ctx({ writeSpill: async () => null }),
    );
    expect(out.content).toContain("could not be saved");
    expect(out.content.length).toBeLessThan(big.length); // still protects the context
  });

  test("maxInlineChars 0 disables spilling", async () => {
    const result: ToolResult = { content: "z".repeat(9999) };
    const out = await spillLargeOutput({ maxInlineChars: 0 })(result, ctx());
    expect(out).toBe(result);
  });

  test("preserves isError and details", async () => {
    const out = await spillLargeOutput({ maxInlineChars: 10 })(
      { content: "e".repeat(50), isError: true },
      ctx(),
    );
    expect(out.isError).toBe(true);
  });
});

// docs/feat/tui-spill-note.md: the spill is also DATA (`spill`), so a frontend
// never parses the banner; the model's text with a path stays byte-identical.
describe("spillLargeOutput flags the result structurally", () => {
  const PATH = ".tentacle/tool-output/fs_read-c1.txt";
  const big = Array.from({ length: 40_800 / 8 }, (_, i) => `${String(i).padStart(7, "0")}\n`).join(
    "",
  );

  test("spill = chars, path, head, tail, omitted; content is today's banner + preview", async () => {
    // Mutation (red, verified): drop `path` from the spill object → fails.
    expect(big.length).toBe(40_800);
    const out = await spillLargeOutput({ maxInlineChars: 16000 })(
      { content: big },
      ctx({ toolName: "fs_read", writeSpill: async () => PATH }),
    );
    const head = big.slice(0, 600);
    const tail = big.slice(big.length - 600);
    expect(out.spill).toEqual({ chars: 40_800, path: PATH, head, tail, omitted: 39_600 });
    expect(out.content).toBe(
      `[large fs_read output: full output (40800 chars) saved to ${PATH} — read it selectively with fs_read (offset/limit) or grep; do NOT read it whole]\n${head}\n…[39600 characters omitted]…\n${tail}`,
    );
  });

  test("no path: the spill has no path key", async () => {
    const out = await spillLargeOutput({ maxInlineChars: 16000 })(
      { content: big },
      ctx({ writeSpill: async () => null }),
    );
    expect(out.spill).toBeDefined();
    expect(out.spill !== undefined && "path" in out.spill).toBe(false);
    expect(out.spill?.chars).toBe(40_800);
  });

  test("nothing omitted (preview ≥ output): head is the whole output, tail is empty", async () => {
    const content = "q".repeat(150);
    const out = await spillLargeOutput({ maxInlineChars: 100, previewChars: 200 })(
      { content },
      ctx(),
    );
    expect(out.spill).toEqual({
      chars: 150,
      path: ".tentacle/tool-output/shell-c1.txt",
      head: content,
      tail: "",
      omitted: 0,
    });
    expect(out.content.endsWith(`\n${content}`)).toBe(true);
  });

  test("under the threshold: no spill", async () => {
    const out = await spillLargeOutput({ maxInlineChars: 100 })({ content: "small" }, ctx());
    expect(out.spill).toBeUndefined();
  });

  test("a summarised result is not flagged (Q4)", async () => {
    const out = await summarizeLargeOutput({ maxInlineChars: 100, summarize: async () => "s" })(
      { content: "x".repeat(500) },
      ctx(),
    );
    expect(out.spill).toBeUndefined();
  });
});

// Owner amendment (docs/feat/tui-spill-note.md, Q2): when the spill file cannot
// be written, the MODEL's banner says what to do next, per tool.
describe("spillLargeOutput no-path banner (model-facing, tool-aware)", () => {
  const big = "y".repeat(5000);

  test("fs_read: re-read the file in parts", async () => {
    const out = await spillLargeOutput({ maxInlineChars: 1000, previewChars: 200 })(
      { content: big },
      ctx({ toolName: "fs_read", writeSpill: async () => null }),
    );
    expect(out.content.split("\n")[0]).toBe(
      "[large fs_read output (5000 chars), could not be saved to a file — only this preview is shown; read the file in parts with fs_read offset/limit]",
    );
  });

  test("any other tool: re-run narrower ONLY if safe to repeat", async () => {
    for (const toolName of ["shell", "web_fetch"]) {
      const out = await spillLargeOutput({ maxInlineChars: 1000, previewChars: 200 })(
        { content: big },
        ctx({ toolName, writeSpill: async () => null }),
      );
      expect(out.content.split("\n")[0]).toBe(
        `[large ${toolName} output (5000 chars), could not be saved to a file — only this preview is shown; to see more, re-run with narrower output (grep, head, sed -n) ONLY if the command is safe to repeat]`,
      );
    }
  });
});

describe("summarizeLargeOutput", () => {
  test("replaces large output with a summary and spills the full output", async () => {
    let spilled: string | undefined;
    const out = await summarizeLargeOutput({
      maxInlineChars: 100,
      summarize: async (text) => `summary of ${text.length} chars`,
    })(
      { content: "x".repeat(5000) },
      ctx({
        writeSpill: async (c) => {
          spilled = c;
          return ".tentacle/tool-output/shell-c1.txt";
        },
      }),
    );
    expect(spilled).toHaveLength(5000);
    expect(out.content).toContain("summary of 5000 chars");
    expect(out.content).toContain(".tentacle/tool-output/shell-c1.txt");
    expect(out.content.length).toBeLessThan(5000);
  });

  test("leaves small output unchanged", async () => {
    const result = { content: "tiny" };
    const out = await summarizeLargeOutput({ maxInlineChars: 100, summarize: async () => "x" })(
      result,
      ctx(),
    );
    expect(out).toBe(result);
  });

  test("falls back to a pointer when summarisation fails", async () => {
    const out = await summarizeLargeOutput({
      maxInlineChars: 10,
      summarize: async () => {
        throw new Error("model down");
      },
    })({ content: "y".repeat(500) }, ctx());
    expect(out.content).toContain("summary failed");
  });
});

describe("collapseRepeatedLines", () => {
  test("collapses a run of identical lines into a marker", async () => {
    const content = ["start", "spam", "spam", "spam", "spam", "end"].join("\n");
    const out = await collapseRepeatedLines({ minRun: 3 })({ content }, ctx());
    expect(out.content).toBe(
      ["start", "spam", "… [previous line repeated 3 more times]", "end"].join("\n"),
    );
  });

  test("leaves short runs untouched (identity)", async () => {
    const result = { content: ["a", "b", "b", "c"].join("\n") };
    const out = await collapseRepeatedLines({ minRun: 3 })(result, ctx());
    expect(out).toBe(result);
  });
});

describe("tabulateJson", () => {
  test("renders a JSON array of flat objects as a table", async () => {
    const content = JSON.stringify([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
    const out = await tabulateJson()({ content }, ctx());
    expect(out.content).toContain("2 rows rendered as a table");
    expect(out.content).toContain("id | name");
    expect(out.content).toContain("1 | a");
    expect(out.content).toContain("2 | b");
  });

  test("leaves non-tabular JSON and plain text untouched", async () => {
    const obj = { content: '{"a":1}' };
    expect(await tabulateJson()(obj, ctx())).toBe(obj);
    const nested = { content: JSON.stringify([{ a: { b: 1 } }, { a: { b: 2 } }]) };
    expect(await tabulateJson()(nested, ctx())).toBe(nested);
    const plain = { content: "just text" };
    expect(await tabulateJson()(plain, ctx())).toBe(plain);
  });

  test("elides rows beyond maxRows", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ i }));
    const out = await tabulateJson({ maxRows: 3 })({ content: JSON.stringify(rows) }, ctx());
    expect(out.content).toContain("7 more rows");
  });
});

describe("applyResultTransforms", () => {
  test("applies transforms in order", async () => {
    const tag =
      (name: string) =>
      (r: ToolResult): ToolResult => ({ ...r, content: `${r.content}|${name}` });
    const out = await applyResultTransforms({ content: "x" }, [tag("a"), tag("b")], ctx());
    expect(out.content).toBe("x|a|b");
  });
});

describe("exemptTools", () => {
  test("an exempt tool's long result passes the spill untouched; any other tool's is spilled", async () => {
    const spill = exemptTools(["skill"], spillLargeOutput({ maxInlineChars: 100 }));
    const long: ToolResult = { content: "x".repeat(500) };
    const exempt = await spill(long, ctx({ toolName: "skill" }));
    expect(exempt).toBe(long);
    const other = await spill(long, ctx({ toolName: "shell" }));
    expect(other.content).not.toBe(long.content);
    expect(other.content).toContain(".tentacle/tool-output/shell-c1.txt");
  });
});
