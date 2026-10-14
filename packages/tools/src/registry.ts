/**
 * Tool registry.
 *
 * Holds the available tools, compiles their Zod schemas to JSON Schema for the
 * model, and is the single choke-point for invocation: arguments are JSON-parsed
 * and validated against the tool's schema *before* its handler runs, so handlers
 * always receive well-typed input and never see malformed model output.
 */
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "@agent-harness/core";
import { zodToJsonSchema } from "zod-to-json-schema";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register<I>(tool: Tool<I>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as unknown as Tool);
    return this;
  }

  registerAll(tools: Iterable<Tool>): this {
    for (const tool of tools) {
      this.register(tool);
    }
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Tool schemas as JSON-Schema definitions to advertise to the model. */
  definitions(): ToolDefinition[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      // A tool may supply its own JSON Schema (e.g. an MCP tool); otherwise the
      // Zod schema is converted.
      parameters:
        tool.jsonSchema ??
        (zodToJsonSchema(tool.inputSchema, { target: "openApi3" }) as Record<string, unknown>),
    }));
  }

  /**
   * Validate `rawArguments` (a JSON string from the model) against the tool's
   * schema and run it. All failure modes are returned as an error `ToolResult`
   * rather than thrown, so a bad call becomes feedback to the model, not a crash.
   */
  async execute(name: string, rawArguments: string, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `unknown tool: ${name}`, isError: true };
    }

    let parsed: unknown;
    try {
      parsed = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
    } catch {
      return { content: `invalid JSON arguments for ${name}`, isError: true };
    }

    const validation = tool.inputSchema.safeParse(parsed);
    if (!validation.success) {
      return {
        content: `invalid arguments for ${name}: ${validation.error.message}`,
        isError: true,
      };
    }

    try {
      return await tool.execute(validation.data, ctx);
    } catch (error) {
      return { content: `tool ${name} failed: ${String(error)}`, isError: true };
    }
  }
}
