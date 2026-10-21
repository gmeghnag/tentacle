import { describe, expect, test } from "bun:test";
import { FileConfigSchema } from "../src/schema.ts";

const parse = (server: unknown) => FileConfigSchema.safeParse({ mcpServers: { s: server } });

describe("mcpServers schema", () => {
  test("accepts a Streamable HTTP server with url + headers", () => {
    const result = parse({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer t" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServers?.s).toEqual({
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer t" },
      });
    }
  });

  test("a server without `type` is stdio", () => {
    const result = parse({ command: "npx", args: ["-y", "srv"] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServers?.s).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "srv"],
      });
    }
  });

  test("a stdio typo keeps its precise first-issue message", () => {
    const result = parse({ comand: "npx" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(" | ");
      expect(messages).toContain("comand");
      expect(result.error.issues[0]?.message).not.toBe("Invalid input");
    }
  });

  test("`url` without `type` (the Cursor / Claude Desktop shape) is http, not a stdio error", () => {
    const result = parse({ url: "https://mcp.example.com/mcp", headers: { A: "b" } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServers?.s).toEqual({
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: { A: "b" },
      });
    }
  });

  test("http requires a valid url and rejects stdio-only keys", () => {
    expect(parse({ type: "http" }).success).toBe(false);
    expect(parse({ type: "http", url: "not a url" }).success).toBe(false);
    expect(parse({ type: "http", url: "https://x.test/mcp", command: "x" }).success).toBe(false);
  });

  test("an unknown type is rejected", () => {
    expect(parse({ type: "sse", url: "https://x.test/sse" }).success).toBe(false);
  });

  test("a profile may set an http server or null it out", () => {
    const result = FileConfigSchema.safeParse({
      mcpServers: { a: { command: "x" } },
      profiles: { p: { mcpServers: { a: null, b: { type: "http", url: "https://x.test/mcp" } } } },
    });
    expect(result.success).toBe(true);
  });
});
