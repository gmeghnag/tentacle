/**
 * T2.5b — `chart`'s REGISTRATION (docs/feat/model-charts.md D3, slice C2).
 *
 * The tool is offered in every session-hosting build and NEVER to a child agent.
 * Both halves are silent if nobody pins them: a build that forgot to register it
 * makes the capability disappear with no error at all, and a child offered it
 * would answer a `tool_result` claiming "Chart shown to the user" that nobody
 * sees — the child's steps are not transcript rows (the class AGENTS §7 forbids).
 *
 * Pins the real `buildAgent` (the one registration site) and the `subagent.ts`
 * filter against a parent registry that really holds the tool.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { CHART_TOOL_NAME, createContextResetTool } from "@tentacle/tools";
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
  dir = await mkdtemp(join(tmpdir(), "harness-chart-"));
  for (const key of ["TENTACLE_CONFIG_DIR"]) saved[key] = process.env[key];
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

/** The names the model is OFFERED for this build (the definitions, not the registry). */
const offered = (tools: { definitions(): readonly { name: string }[] }): string[] =>
  tools.definitions().map((definition) => definition.name);

describe("`chart` is registered in a session-hosting build", () => {
  test("the model is offered it, with the hand-written JSON Schema", () => {
    // Mutation: drop `tools.register(chartTool)` from `wiring.ts` → not contained.
    const wired = buildAgent(config);
    expect(offered(wired.tools)).toContain(CHART_TOOL_NAME);
    const definition = wired.tools.definitions().find((d) => d.name === CHART_TOOL_NAME);
    // The model needs the shape to fill in — a bare `{}` would be unusable.
    expect(JSON.stringify(definition?.parameters)).toContain("datasets");
    expect(JSON.stringify(definition?.parameters)).toContain("additionalProperties");
  });

  test("`chart` is a plain tool, not a session-conditional one", () => {
    // `context_reset` is registered only when the reset is configured; `chart`
    // has no switch of its own (a chart has no side effect to gate). This pins
    // the asymmetry so a later "off by default" cannot creep in unnoticed.
    const wired = buildAgent(config);
    expect(wired.tools.get(CHART_TOOL_NAME)).toBeDefined();
    expect(createContextResetTool().name).toBe("context_reset");
  });

  test("it answers a real call through the wired registry (nothing is shadowed)", async () => {
    const wired = buildAgent(config);
    const result = await wired.tools.execute(
      CHART_TOOL_NAME,
      JSON.stringify({
        type: "bar",
        title: "Confronto",
        labels: ["a", "b"],
        datasets: [{ label: "2026", data: [3, 5] }],
      }),
      { sessionId: "s1", signal: new AbortController().signal, env: envOf() },
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Chart shown to the user: bar "Confronto"');
  });
});

describe("a child agent is never offered `chart`", () => {
  const recording = (offeredNames: string[][]): ModelProvider => ({
    id: "rec",
    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      offeredNames.push((request.tools ?? []).map((tool) => tool.name));
      yield { type: "text", delta: "report" };
      yield { type: "done" };
    },
  });

  const env: ExecutionEnvironment = {
    id: "noop",
    exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    readFile: () => Promise.resolve(""),
    writeFile: () => Promise.resolve(),
  };

  test('a `general` child (tools: "all") does not get it, from a parent that holds it', async () => {
    const offeredNames: string[][] = [];
    const parent = buildAgent(config).tools;
    // The parent really had it, so its absence below is the filter's doing.
    expect(parent.get(CHART_TOOL_NAME)).toBeDefined();
    const { run } = createSubagentRunner({
      model: recording(offeredNames),
      env,
      tools: parent,
      types: BUILTIN_AGENT_TYPES,
    });
    await run({ description: "d", prompt: "go", type: "general" });
    expect(offeredNames[0]?.length).toBeGreaterThan(0);
    expect(offeredNames[0]).not.toContain(CHART_TOOL_NAME);
    // Non-vacuity: the filter DID hand the child its other tools.
    expect(offeredNames[0]).toContain("fs_read");
    expect(offeredNames[0]).toContain("shell");
  });
});

/** The wire env is irrelevant here (the tool draws nothing); reuse a stub. */
function envOf(): ExecutionEnvironment {
  return {
    id: "noop",
    exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    readFile: () => Promise.resolve(""),
    writeFile: () => Promise.resolve(),
  };
}
