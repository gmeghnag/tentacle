/** Built-in tools' concurrency keys (T-K, docs/feat/parallel-tools.md). */
import { describe, expect, test } from "bun:test";
import type { Tool } from "@tentacle/core";
import {
  createContextResetTool,
  createTaskTool,
  fsEditTool,
  fsMultiEditTool,
  fsReadTool,
  fsWriteTool,
  shellKillTool,
  shellOutputTool,
  shellTool,
} from "../src/index.ts";

function keys(tool: Tool, input: unknown): unknown {
  const c = tool.concurrency;
  return c === undefined || c === "exclusive" ? "exclusive" : c(input);
}

describe("built-in concurrency keys (T-K)", () => {
  test("fs_read reads its path (case-folded basename)", () => {
    expect(keys(fsReadTool as Tool, { path: "/ws/src/A.ts" })).toEqual([
      { mode: "read", resource: "path:a.ts" },
    ]);
  });

  test("fs_read with a `path:start:end` range keys both spellings", () => {
    expect(keys(fsReadTool as Tool, { path: "src/a.ts:10:20" })).toEqual([
      { mode: "read", resource: "path:a.ts:10:20" },
      { mode: "read", resource: "path:a.ts" },
    ]);
  });

  test("fs_write / fs_edit / fs_multi_edit write their path", () => {
    for (const tool of [fsWriteTool, fsEditTool, fsMultiEditTool]) {
      expect(keys(tool as Tool, { path: "./x/../a.ts" })).toEqual([
        { mode: "write", resource: "path:a.ts" },
      ]);
    }
  });

  test("shell_output writes its job's cursor", () => {
    expect(keys(shellOutputTool as Tool, { job_id: "j1" })).toEqual([
      { mode: "write", resource: "job:j1" },
    ]);
  });

  test("shell, shell_kill, context_reset, agent_task: exclusive", () => {
    const task = createTaskTool(async () => ({ content: "" }) as never, []);
    for (const tool of [shellTool, shellKillTool, createContextResetTool(), task]) {
      expect(keys(tool as Tool, { command: "ls", job_id: "j" })).toBe("exclusive");
    }
  });

  test("garbage input → exclusive", () => {
    for (const bad of [undefined, null, 42, "a.ts", {}, { path: "" }, { path: 3 }, []]) {
      expect(keys(fsReadTool as Tool, bad)).toBe("exclusive");
      expect(keys(fsEditTool as Tool, bad)).toBe("exclusive");
    }
    for (const bad of [undefined, {}, { job_id: "" }, { job_id: 1 }]) {
      expect(keys(shellOutputTool as Tool, bad)).toBe("exclusive");
    }
  });
});
