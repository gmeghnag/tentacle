/**
 * Adapt an MCP tool into the harness `Tool` contract.
 *
 * The model-facing schema is the server's own JSON Schema (carried verbatim via
 * `jsonSchema`); `inputSchema` stays a permissive runtime guard since the MCP
 * server validates arguments itself. Tool names are namespaced
 * `mcp__<server>__<tool>` so servers can't collide with each other or the
 * built-ins. MCP tools default to `permission: "ask"` (they run external code
 * or hit the network).
 */
import type { Tool } from "@tentacle/core";
import { z } from "zod";
import type { McpClient } from "./client.ts";
import type { McpCallResult, McpToolDef } from "./types.ts";

const EMPTY_OBJECT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

/** Flatten an MCP tool result's content blocks into plain text. */
export function flattenMcpResult(result: McpCallResult): string {
  const blocks = result.content ?? [];
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
  if (text !== "") {
    return text;
  }
  const otherKinds = [...new Set(blocks.map((b) => b.type).filter((t) => t !== "text"))];
  if (otherKinds.length > 0) {
    return `[non-text MCP content: ${otherKinds.join(", ")}]`;
  }
  return "(no output)";
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export function mcpToolToTool(server: string, client: McpClient, def: McpToolDef): Tool {
  const schema = def.inputSchema ?? EMPTY_OBJECT_SCHEMA;
  const tool: Tool<Record<string, unknown>> = {
    name: mcpToolName(server, def.name),
    description: def.description ?? `MCP tool \`${def.name}\` from server \`${server}\`.`,
    inputSchema: z.record(z.unknown()),
    jsonSchema: schema,
    permission: "ask",
    async execute(input, ctx) {
      try {
        // Thread the turn's abort signal so a cancelled turn (or a wedged
        // server hitting the client timeout) doesn't hang on this call.
        const result = await client.callTool(def.name, input, { signal: ctx.signal });
        return { content: flattenMcpResult(result), isError: Boolean(result.isError) };
      } catch (error) {
        return { content: `MCP call failed: ${String(error)}`, isError: true };
      }
    },
  };
  return tool as unknown as Tool;
}
