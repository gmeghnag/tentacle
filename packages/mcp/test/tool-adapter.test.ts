import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@agent-harness/core";
import type { McpClient } from "../src/client.ts";
import { flattenMcpResult, mcpToolName, mcpToolToTool } from "../src/tool-adapter.ts";
import type { McpCallResult } from "../src/types.ts";

const ctx = {} as ToolContext;

/** A fake McpClient capturing the last callTool and returning a scripted result. */
function fakeClient(result: McpCallResult): {
  client: McpClient;
  calls: { name: string; args: Record<string, unknown> }[];
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return result;
    },
  } as unknown as McpClient;
  return { client, calls };
}

describe("mcp tool adapter", () => {
  test("namespaces the tool name and advertises the server's JSON Schema", () => {
    const schema = { type: "object", properties: { q: { type: "string" } } };
    const { client } = fakeClient({ content: [] });
    const tool = mcpToolToTool("search", client, {
      name: "web",
      description: "search the web",
      inputSchema: schema,
    });
    expect(tool.name).toBe(mcpToolName("search", "web"));
    expect(tool.name).toBe("mcp__search__web");
    expect(tool.jsonSchema).toEqual(schema);
    expect(tool.permission).toBe("ask");
  });

  test("execute forwards arguments and flattens text content", async () => {
    const { client, calls } = fakeClient({ content: [{ type: "text", text: "result text" }] });
    const tool = mcpToolToTool("srv", client, { name: "do", inputSchema: { type: "object" } });
    const out = await tool.execute({ a: 1 }, ctx);
    expect(calls[0]).toEqual({ name: "do", args: { a: 1 } });
    expect(out.content).toBe("result text");
    expect(out.isError).toBe(false);
  });

  test("propagates the server's isError flag", async () => {
    const { client } = fakeClient({ content: [{ type: "text", text: "boom" }], isError: true });
    const tool = mcpToolToTool("srv", client, { name: "do" });
    const out = await tool.execute({}, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toBe("boom");
  });

  test("flattenMcpResult handles non-text and empty content", () => {
    expect(flattenMcpResult({ content: [{ type: "image", data: "..." }] })).toContain("non-text");
    expect(flattenMcpResult({ content: [] })).toBe("(no output)");
    expect(flattenMcpResult({})).toBe("(no output)");
  });

  test("execute threads the turn's abort signal into the MCP call", async () => {
    let received: AbortSignal | undefined;
    const client = {
      callTool: async (_name: string, _args: unknown, opts?: { signal?: AbortSignal }) => {
        received = opts?.signal;
        return { content: [] };
      },
    } as unknown as McpClient;
    const ac = new AbortController();
    const tool = mcpToolToTool("srv", client, { name: "do" });
    await tool.execute({}, { signal: ac.signal } as ToolContext);
    expect(received).toBe(ac.signal);
  });
});
