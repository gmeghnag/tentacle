import { describe, expect, test } from "bun:test";
import type { ToolResult } from "@tentacle/core";
import {
  type ResultTransformContext,
  applyResultTransforms,
  collapseRepeatedLines,
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
