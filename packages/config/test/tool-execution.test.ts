/** `tools.execution` / `tools.maxParallel` / `readOnlyTools` (docs/feat/parallel-tools.md). */
import { describe, expect, test } from "bun:test";
import { type ResolveContext, resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
  fileConfig: {},
  env: {},
  defaultCwd: "/launch",
  ...over,
});

describe("tools.execution / tools.maxParallel", () => {
  test("defaults: read-only, 8", () => {
    const c = resolveConfig(ctx());
    expect(c.toolExecution).toEqual({ mode: "read-only", maxParallel: 8 });
    expect(c.sources.toolExecution).toBe("default");
    expect(c.sources.toolMaxParallel).toBe("default");
  });

  test("file, then env wins; an invalid env value falls back", () => {
    const fileConfig = FileConfigSchema.parse({
      tools: { execution: "parallel", maxParallel: 3 },
    });
    expect(resolveConfig(ctx({ fileConfig })).toolExecution).toEqual({
      mode: "parallel",
      maxParallel: 3,
    });
    const env = { TENTACLE_TOOL_EXECUTION: "sequential", TENTACLE_TOOL_MAX_PARALLEL: "1" };
    const c = resolveConfig(ctx({ fileConfig, env }));
    expect(c.toolExecution).toEqual({ mode: "sequential", maxParallel: 1 });
    expect(c.sources.toolExecution).toBe("env");
    const bad = resolveConfig(
      ctx({
        fileConfig,
        env: { TENTACLE_TOOL_EXECUTION: "wild", TENTACLE_TOOL_MAX_PARALLEL: "0" },
      }),
    );
    expect(bad.toolExecution).toEqual({ mode: "parallel", maxParallel: 3 });
  });

  test("the schema refuses an unknown mode and a maxParallel below 1", () => {
    expect(FileConfigSchema.safeParse({ tools: { execution: "wild" } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ tools: { maxParallel: 0 } }).success).toBe(false);
    expect(FileConfigSchema.safeParse({ tools: { maxParallel: 1.5 } }).success).toBe(false);
  });
});

describe("mcpServers.<name>.readOnlyTools", () => {
  test('"hint" | "none" | a list, on both transports', () => {
    for (const readOnlyTools of ["hint", "none", ["search", "fetch"]]) {
      const stdio = FileConfigSchema.safeParse({
        mcpServers: { s: { command: "srv", readOnlyTools } },
      });
      const http = FileConfigSchema.safeParse({
        mcpServers: { s: { type: "http", url: "https://x.example/mcp", readOnlyTools } },
      });
      expect(stdio.success && http.success).toBe(true);
      if (stdio.success) {
        expect(stdio.data.mcpServers?.s).toMatchObject({ readOnlyTools });
      }
    }
    expect(
      FileConfigSchema.safeParse({ mcpServers: { s: { command: "srv", readOnlyTools: "all" } } })
        .success,
    ).toBe(false);
  });
});
