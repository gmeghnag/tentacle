/**
 * browser-inspect B4 wiring: the `browser_*` tools are registered only where a
 * host passes the daemon's toolset (the worker, `serve`), and every session
 * starts with them OFF unless `tools.enabled` names them. The daemon's toolset
 * runs the generic `redactText` net last, whatever `tools.redactSecrets` says.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@tentacle/config";
import { type PermissionRequest, type Tool, type ToolContext, autoApproves } from "@tentacle/core";
import { BROWSER_TOOL_NAMES } from "@tentacle/tools";
import { browserToolsetOf } from "../src/browser-link.ts";
import { createServeAgent } from "../src/serve.ts";
import { createSkillScan } from "../src/wiring.ts";
import { workerAgentFactory } from "../src/worker.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "browser-wiring-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function configIn(over: Record<string, unknown> = {}) {
  const config = await loadConfig({
    configDir: join(dir, "config"),
    cwd: dir,
    scaffold: false,
    env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
  });
  return { ...config, ...over };
}

interface Built {
  readonly config: { tools: { get(n: string): unknown } };
  capabilities(): { disabledTools: readonly string[] };
}
const built = (agent: unknown): Built => agent as Built;
const never = browserToolsetOf({ call: () => Promise.reject(new Error("never")) }, undefined);

describe("browser tools: where they are offered, and off by default", () => {
  test("worker with the toolset: all six registered, all six switched off", async () => {
    const agent = built(workerAgentFactory(await configIn(), {}, { browser: never }).agent);
    for (const name of BROWSER_TOOL_NAMES) {
      expect(agent.config.tools.get(name)).toBeDefined();
      expect(agent.capabilities().disabledTools).toContain(name);
    }
  });

  test("serve with the toolset: registered and off, like the worker", async () => {
    const config = await configIn();
    const wired = createServeAgent(
      config,
      {},
      createSkillScan(config),
      { cwd: dir },
      undefined,
      never,
    );
    const agent = built(wired.agent);
    expect(agent.config.tools.get("browser_read")).toBeDefined();
    expect(agent.capabilities().disabledTools).toContain("browser_read");
  });

  test("tools.enabled.browser: true → offered on from the start", async () => {
    const agent = built(
      workerAgentFactory(
        await configIn({ toolsEnabled: { browser: true } }),
        {},
        { browser: never },
      ).agent,
    );
    expect(agent.capabilities().disabledTools.filter((t) => t.startsWith("browser_"))).toEqual([]);
  });

  test("no toolset (a pod, a one-shot): not registered, and the switches are untouched", async () => {
    const agent = built(workerAgentFactory(await configIn(), {}).agent);
    expect(agent.config.tools.get("browser_read")).toBeUndefined();
    expect(agent.capabilities().disabledTools.some((t) => t.startsWith("browser_"))).toBe(false);
  });

  test("the daemon's toolset runs the generic secret net (redactText) on page text", async () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const set = browserToolsetOf(
      {
        call: async (op) =>
          op.op === "claim" ? {} : { url: "https://a.test/", title: "", text: `token here ${jwt}` },
      },
      undefined,
    );
    const read = set
      .tools({ maxEdge: 1568, maxImageBytes: 1_000_000 })
      .find((t) => t.name === "browser_read");
    const ctx = {
      sessionId: "s",
      signal: new AbortController().signal,
      env: {},
    } as unknown as ToolContext;
    const r = await read?.execute({ tab: 1 } as never, ctx);
    expect(r?.content).toContain("token here");
    expect(r?.content).not.toContain(jwt);
  });

  test("B5 single broker: a browser_action ask reaches the SESSION's broker; denied → no click", async () => {
    const ops: string[] = [];
    const set = browserToolsetOf(
      {
        call: async (op) => {
          ops.push(op.op === "click" && op.probe === true ? "probe" : op.op);
          if (op.op === "click") return { facts: { tag: "button", name: "Pay", submits: true } };
          return {};
        },
      },
      undefined,
    );
    const wired = workerAgentFactory(await configIn(), {}, { browser: set });
    const asked: PermissionRequest[] = [];
    wired.permissions.setRequester(async (req) => {
      asked.push(req);
      return { allowed: false };
    });
    const click = built(wired.agent).config.tools.get("browser_click") as Tool<unknown> | undefined;
    const ctx = {
      sessionId: "s",
      signal: new AbortController().signal,
      env: {},
      toolCallId: "c1",
    } as unknown as ToolContext;
    const r = await click?.execute({ tab: 1, ref: "e1" }, ctx);
    expect(asked.map((a) => a.kind)).toEqual(["browser_action"]);
    expect(autoApproves(asked[0] as PermissionRequest)).toBe(false);
    expect(r?.isError).toBe(true);
    expect(ops.filter((o) => o === "click")).toEqual([]);
  });
});
