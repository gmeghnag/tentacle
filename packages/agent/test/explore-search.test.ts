/**
 * T-S4: the `explore` child runs `search`, and NOBODY ELSE has it
 * (docs/feat/explore-search.md, owner Q1 c).
 *
 * The whole child path is real: `createSubagentRunner` → a real `Agent` → a real
 * `ToolRegistry` → the real `search` tool → a real `sh` over a fixture. Only the
 * MODEL is scripted, which is the seam that makes an end-to-end run
 * deterministic (AGENTS §9). The wiring below mirrors `wiring.ts:547`: the
 * parent registry holds `fs_read` (and `shell`), and `search` arrives for
 * `explore` only through `extraTools`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import {
  ToolRegistry,
  exploreTools,
  fsReadTool,
  searchTool,
  shellTool,
  subagentExtraTools,
} from "@tentacle/tools";
import { makeSearchFixture } from "../../tools/test/search-fixture.ts";
import { BUILTIN_AGENT_TYPES, createSubagentRunner } from "../src/subagent.ts";

const ROOT = mkdtempSync(join(tmpdir(), "search-agent-"));
const FX = join(ROOT, "ws");
makeSearchFixture(FX, { expressibleGitignoreOnly: true, withoutBinary: true });

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  readonly requests: ChatRequest[] = [];
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const toolCall = (name: string, args: unknown): StreamEvent => ({
  type: "tool_call",
  toolCall: { id: `c-${name}`, name, arguments: JSON.stringify(args) },
});

/** A real host env rooted at the fixture (the tools run for real inside it). */
function hostEnv(): ExecutionEnvironment {
  return {
    id: "fixture",
    async exec(command, options) {
      const proc = Bun.spawnSync(["/bin/sh", "-c", command], {
        cwd: options?.cwd ?? FX,
        env: { PATH: process.env.PATH ?? "" },
      });
      const decoder = new TextDecoder("utf-8", { fatal: false });
      return {
        stdout: decoder.decode(new Uint8Array(proc.stdout)),
        stderr: decoder.decode(new Uint8Array(proc.stderr)),
        exitCode: proc.exitCode ?? 124,
      };
    },
    async readFile(path) {
      return Bun.file(join(FX, path)).text();
    },
    async writeFile() {},
  };
}

/** The parent's registry as `wiring.ts` builds it for a session: no `search`. */
const parentTools = (): ToolRegistry => new ToolRegistry().register(fsReadTool).register(shellTool);

describe("T-S4: an `explore` child is offered search, runs it, and reads a hit", () => {
  test("the explore type's tool-set is exactly [fs_read, search]", () => {
    const explore = BUILTIN_AGENT_TYPES.find((type) => type.name === "explore");
    expect(explore?.tools).toEqual(["fs_read", "search"]);
    // The prompt tells it to search FIRST (Design 4) — the place the cost is saved.
    expect(explore?.prompt).toContain("SEARCH first, then read");
    expect(explore?.prompt).toContain("`search`");
    // And exactly the two tools it is allowed are offered by the group.
    expect(exploreTools.map((tool) => tool.name).sort()).toEqual(["fs_read", "search"]);
  });

  test("the child's first request offers search, and it searches then reads", async () => {
    const provider = new ScriptedProvider([
      // Turn 1: locate the symbol — through the real tool.
      [toolCall("search", { pattern: "needleTwo", path: "src" }), { type: "done" }],
      // Turn 2: read the ONE line the hit pointed at.
      [toolCall("fs_read", { path: "src/a.ts:3:3" }), { type: "done" }],
      // Turn 3: the report the parent receives.
      [{ type: "text", delta: "needleTwo is defined at src/a.ts:3" }, { type: "done" }],
    ]);
    const { run, readOnlyType } = createSubagentRunner({
      model: provider,
      env: hostEnv(),
      tools: parentTools(),
      extraTools: (type) => subagentExtraTools(type.name),
    });
    // Precondition 4: a read-class `concurrency` keeps `explore` read-only, so
    // `agent_task`'s scheduling sees a reader (task.ts:360-363).
    expect(readOnlyType("explore")).toBe(true);

    const result = await run({ description: "find it", prompt: "find needleTwo", type: "explore" });

    // The child was offered BOTH tools, and the spawn tool never.
    const offered = (provider.requests[0]?.tools ?? []).map((tool) => tool.name).sort();
    expect(offered).toEqual(["fs_read", "search"]);
    expect(result.toolUses).toBe(2);
    expect(result.report).toContain("src/a.ts:3");
  });

  test("the search the child ran really walked the workspace", async () => {
    const provider = new ScriptedProvider([
      [toolCall("search", { pattern: "needleTwo", path: "src" }), { type: "done" }],
      [{ type: "text", delta: "done" }, { type: "done" }],
    ]);
    const env = hostEnv();
    const seen: string[] = [];
    const recording: ExecutionEnvironment = {
      ...env,
      async exec(command, options) {
        const result = await env.exec(command, options);
        if (!command.includes("TENTACLE_ENGINE")) {
          seen.push(result.stdout);
        }
        return result;
      },
    };
    const { run } = createSubagentRunner({
      model: provider,
      env: recording,
      tools: parentTools(),
      extraTools: (type) => subagentExtraTools(type.name),
    });
    await run({ description: "find it", prompt: "find needleTwo", type: "explore" });
    expect(seen.join("\n")).toContain("./src/a.ts:3:needleTwo();");
  });

  test("a `general` child is NOT offered search (owner Q1 c: explore only)", async () => {
    const provider = new ScriptedProvider([[{ type: "text", delta: "hi" }, { type: "done" }]]);
    const { run } = createSubagentRunner({
      model: provider,
      env: hostEnv(),
      tools: parentTools(),
      extraTools: (type) => subagentExtraTools(type.name),
    });
    await run({ description: "d", prompt: "go", type: "general" });
    const offered = (provider.requests[0]?.tools ?? []).map((tool) => tool.name);
    // `general` keeps `shell` (its own way to grep) and never gets `search`.
    expect(offered).not.toContain("search");
    expect(offered).toContain("shell");
  });

  test("`shell` is still not available to an explore child (the guard stays green)", async () => {
    const provider = new ScriptedProvider([
      [toolCall("shell", { command: "rm -rf /" }), { type: "done" }],
      [{ type: "text", delta: "could not run shell" }, { type: "done" }],
    ]);
    const { run } = createSubagentRunner({
      model: provider,
      env: hostEnv(),
      tools: parentTools(),
      extraTools: (type) => subagentExtraTools(type.name),
    });
    await run({ description: "try shell", prompt: "try shell", type: "explore" });
    const offered = (provider.requests[0]?.tools ?? []).map((tool) => tool.name);
    expect(offered).not.toContain("shell");
  });

  test("the real `search` TOOL is the one offered (a read-class concurrency)", () => {
    // The tool instance in the group IS the exported tool — not a copy.
    expect(exploreTools.find((tool) => tool.name === "search")).toBe(searchTool);
    expect(typeof searchTool.concurrency).toBe("function");
    // Owner Q1 (c): the DECISION is one function, asserted on both sides of it.
    expect(
      subagentExtraTools("explore")
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["fs_read", "search"]);
    expect(subagentExtraTools("general")).toEqual([]);
    expect(subagentExtraTools("anything-else")).toEqual([]);
  });
});
