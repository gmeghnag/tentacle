/**
 * The `diagram` tool's wiring (docs/feat/model-diagrams.md D2): registered in
 * every session-hosting build beside `chart`, and never offered to a child agent
 * (T2.7) — a child's steps are not rows of the user's transcript, so a diagram
 * drawn there would be drawn nowhere.
 *
 * Mirrors `chart-wiring.test.ts` (the same two seams, the same reasons).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { DIAGRAM_TOOL_NAME } from "@tentacle/tools";
import { BUILTIN_AGENT_TYPES, createSubagentRunner } from "../../agent/src/subagent.ts";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { buildAgent } from "../src/wiring.ts";

let dir: string;
let config: TentacleConfig;
const saved: Record<string, string | undefined> = {};

/** A computed delete (AGENTS §6: `noDelete` is hand-fixed, not disabled). */
const unsetEnv = (key: string): void => {
  const env = process.env as Record<string, string | undefined>;
  delete env[key];
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-diagram-"));
  saved.TENTACLE_CONFIG_DIR = process.env.TENTACLE_CONFIG_DIR;
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
  config = await loadConfig({ cwd: dir });
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) unsetEnv(key);
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

describe("`diagram` is registered in a session-hosting build", () => {
  test("the model is offered it, with the hand-written JSON Schema", () => {
    // Mutation: drop `tools.register(diagramTool)` from `wiring.ts` → not offered.
    const wired = buildAgent(config);
    const definition = wired.tools.definitions().find((d) => d.name === DIAGRAM_TOOL_NAME);
    expect(definition).toBeDefined();
    expect(JSON.stringify(definition?.parameters)).toContain('"mermaid"');
  });

  test("it answers a real call through the wired registry (mermaid parses it)", async () => {
    const wired = buildAgent(config);
    const result = await wired.tools.execute(
      DIAGRAM_TOOL_NAME,
      JSON.stringify({ title: "Login", mermaid: "flowchart TD\n  A[Richiesta] --> B[Ok]" }),
      { sessionId: "s1", signal: new AbortController().signal, env },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toStartWith('Diagram shown to the user: flowchart "Login" · 2 nodes');
  });
});

describe("T2.7 a child agent is never offered `diagram`", () => {
  const recording = (offeredNames: string[][]): ModelProvider => ({
    id: "rec",
    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      offeredNames.push((request.tools ?? []).map((tool) => tool.name));
      yield { type: "text", delta: "report" };
      yield { type: "done" };
    },
  });

  test('a `general` child (tools: "all") does not get it, from a parent that holds it', async () => {
    const offeredNames: string[][] = [];
    const parent = buildAgent(config).tools;
    // The parent really had it, so its absence below is the filter's doing.
    expect(parent.get(DIAGRAM_TOOL_NAME)).toBeDefined();
    const { run } = createSubagentRunner({
      model: recording(offeredNames),
      env,
      tools: parent,
      types: BUILTIN_AGENT_TYPES,
    });
    await run({ description: "d", prompt: "go", type: "general" });
    expect(offeredNames[0]?.length).toBeGreaterThan(0);
    expect(offeredNames[0]).not.toContain(DIAGRAM_TOOL_NAME);
    // Non-vacuity: the filter DID hand the child its other tools.
    expect(offeredNames[0]).toContain("fs_read");
  });
});
