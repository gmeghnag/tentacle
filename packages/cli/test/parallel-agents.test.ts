/**
 * The real wiring of parallel sub-agents (docs/feat/parallel-agents.md, S5):
 * T-W (`buildAgent` reads the config), T-DESC (the description), T-CARRY (a pod
 * takes the laptop's values, over the channel pair), `model/slots` end to end.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient } from "@tentacle/client";
import {
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import { Connection } from "@tentacle/daemon";
import type { SessionSettings } from "@tentacle/protocol";
import { fsReadTool } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import * as serve from "../src/serve.ts";
import { buildAgent } from "../src/wiring.ts";

let dir: string;
let config: TentacleConfig;
const saved = process.env.TENTACLE_CONFIG_DIR;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "parallel-agents-"));
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
  config = await loadConfig({ cwd: dir });
});

afterAll(async () => {
  if (saved === undefined) {
    Reflect.deleteProperty(process.env, "TENTACLE_CONFIG_DIR");
  } else {
    process.env.TENTACLE_CONFIG_DIR = saved;
  }
  await rm(dir, { recursive: true, force: true });
});

const spawn = (id: string, prompt: string): StreamEvent => ({
  type: "tool_call",
  toolCall: {
    id,
    name: "agent_task",
    arguments: JSON.stringify({ description: `task ${id}`, prompt }),
  },
});

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  expect(pred()).toBe(true);
}

/** The parent answers with `round` once; a child (`CHILD-…`) waits on its gate. */
class GatedModel implements ModelProvider {
  readonly id = "gated";
  readonly gates = new Map<string, PromiseWithResolvers<void>>();
  readonly started: string[] = [];
  readonly parentRequests: ChatRequest[] = [];
  readonly childScripts = new Map<string, readonly (readonly StreamEvent[])[]>();
  private readonly childTurns = new Map<string, number>();
  private running = 0;
  peak = 0;
  slotCalls = 0;
  slots?: (signal?: AbortSignal) => Promise<number | undefined>;

  constructor(
    private readonly round: readonly StreamEvent[],
    slots?: number,
  ) {
    if (slots !== undefined) {
      this.slots = async () => {
        this.slotCalls++;
        return slots;
      };
    }
  }

  gate(prompt: string): PromiseWithResolvers<void> {
    const made = Promise.withResolvers<void>();
    this.gates.set(prompt, made);
    return made;
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    // Matched, not compared: the message may carry a rendered context line.
    const content = request.messages.find((m) => m.role === "user")?.content ?? "";
    const first = /CHILD-[\w-]+/.exec(content)?.[0];
    if (first === undefined) {
      this.parentRequests.push(request);
      const answered = request.messages.some((m) => m.role === "tool");
      for (const event of answered ? [{ type: "done" } as StreamEvent] : this.round) {
        yield event;
      }
      return;
    }
    const turn = this.childTurns.get(first) ?? 0;
    this.childTurns.set(first, turn + 1);
    const script = this.childScripts.get(first);
    if (script) {
      for (const event of script[turn] ?? [{ type: "done" } as StreamEvent]) {
        yield event;
      }
      return;
    }
    this.started.push(first);
    this.running++;
    this.peak = Math.max(this.peak, this.running);
    await this.gates.get(first)?.promise;
    this.running--;
    yield { type: "text", delta: `report ${first}` };
    yield { type: "done" };
  }
}

const three = [
  spawn("c1", "CHILD-1"),
  spawn("c2", "CHILD-2"),
  spawn("c3", "CHILD-3"),
  { type: "done" as const },
];
const two = [spawn("c1", "CHILD-1"), spawn("c2", "CHILD-2"), { type: "done" as const }];

async function runLocal(agent: ReturnType<typeof buildAgent>["agent"]): Promise<void> {
  for await (const _ of agent.run("s", [{ role: "user", content: "go" }])) {
    // drained
  }
}

/** CHILD-1 held open: the second child must not start beside it (an open child, or a peak, proves nothing alone). */
async function expectOneAtATime(model: GatedModel, start: () => Promise<void>): Promise<void> {
  const first = model.gate("CHILD-1");
  const running = start();
  await until(() => model.started.length >= 1);
  await new Promise((r) => setTimeout(r, 15));
  expect(model.started).toEqual(["CHILD-1"]);
  first.resolve();
  await running;
  expect(model.peak).toBe(1);
  expect(model.started).toEqual(["CHILD-1", "CHILD-2"]);
}

describe("buildAgent reads subagents.* (T-W)", () => {
  test("parallel, cap 2: two overlap, the third waits", async () => {
    const model = new GatedModel(three);
    const gates = ["CHILD-1", "CHILD-2", "CHILD-3"].map((p) => model.gate(p));
    const { agent } = buildAgent(
      { ...config, subagentExecution: "parallel", subagentMaxParallel: 2 },
      { modelOverride: model },
    );
    const running = runLocal(agent);
    await until(() => model.started.length === 2);
    await new Promise((r) => setTimeout(r, 5));
    expect(model.started.length).toBe(2);
    for (const gate of gates) {
      gate.resolve();
    }
    await running;
    expect(model.peak).toBe(2);
    expect(model.started.length).toBe(3);
  });

  test("sequential: no overlap (mutation: hard-code the mode → red)", async () => {
    const model = new GatedModel(two);
    const { agent } = buildAgent(
      { ...config, subagentExecution: "sequential", subagentMaxParallel: 4 },
      { modelOverride: model },
    );
    await expectOneAtATime(model, () => runLocal(agent));
  });

  test("read-only: general-purpose children do not overlap", async () => {
    const model = new GatedModel(two);
    const { agent } = buildAgent(
      { ...config, subagentExecution: "read-only", subagentMaxParallel: 4 },
      { modelOverride: model },
    );
    await expectOneAtATime(model, () => runLocal(agent));
  });

  test("the slots are wired from the model, and lowering the cap is logged once", async () => {
    const model = new GatedModel(two, 1);
    const lines: string[] = [];
    const { agent } = buildAgent(
      { ...config, subagentExecution: "parallel", subagentMaxParallel: 4 },
      { modelOverride: model, log: (line) => lines.push(line) },
    );
    await expectOneAtATime(model, () => runLocal(agent));
    expect(model.slotCalls).toBe(1);
    expect(lines.filter((l) => l.includes("capped at 1"))).toHaveLength(1);
  });

  test("a child's rounds inherit tools.*", async () => {
    for (const [mode, peak] of [
      ["parallel", 2],
      ["sequential", 1],
    ] as const) {
      let running = 0;
      let top = 0;
      const look: Tool = {
        name: "look",
        description: "look",
        inputSchema: fsReadTool.inputSchema,
        permission: "none",
        concurrency: () => [{ mode: "read", resource: "x" }],
        async execute() {
          running++;
          top = Math.max(top, running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
          return { content: "ok" };
        },
      };
      const model = new GatedModel([spawn("c1", "CHILD-reads"), { type: "done" }]);
      const lookCall = (id: string, path: string): StreamEvent => ({
        type: "tool_call",
        toolCall: { id, name: "look", arguments: JSON.stringify({ path }) },
      });
      model.childScripts.set("CHILD-reads", [
        [lookCall("l1", "a"), lookCall("l2", "b"), { type: "done" }],
      ]);
      const { agent, tools } = buildAgent(
        { ...config, toolExecution: { mode, maxParallel: 8 } },
        { modelOverride: model },
      );
      tools.register(look);
      await runLocal(agent);
      expect(top).toBe(peak);
    }
  });

  test('one store for the session: a child\'s "always" covers the parent', async () => {
    const write = (id: string, name: string): StreamEvent => ({
      type: "tool_call",
      toolCall: { id, name: "fs_write", arguments: JSON.stringify({ path: name, content: "x" }) },
    });
    const model = new GatedModel([
      spawn("c1", "CHILD-w"),
      write("p", "parent.txt"),
      { type: "done" },
    ]);
    model.childScripts.set("CHILD-w", [[write("w", "child.txt"), { type: "done" }]]);
    const permissions = new PermissionBroker();
    let asked = 0;
    permissions.setRequester(async () => {
      asked++;
      return { allowed: true, scope: "session" };
    });
    const { agent } = buildAgent(
      { ...config, subagentExecution: "sequential" },
      { modelOverride: model, permissions },
    );
    await runLocal(agent);
    expect(asked).toBe(1);
  });
});

describe("the agent_task description (T-DESC)", () => {
  const description = async (over: Partial<TentacleConfig>): Promise<string | undefined> => {
    const model = new GatedModel([{ type: "done" }]);
    const { agent } = buildAgent({ ...config, ...over }, { modelOverride: model });
    await runLocal(agent);
    return model.parentRequests[0]?.tools?.find((t) => t.name === "agent_task")?.description;
  };

  test("neither: the neutral text, per mode", async () => {
    const parallel = await description({ subagentExecution: "parallel" });
    expect(parallel).toContain("may run at the same time. They share one workspace");
    expect(parallel).toContain("- explore:");
    const readOnly = await description({ subagentExecution: "read-only" });
    expect(readOnly).toContain("Read-only sub-agents in one message may run at the same time.");
    const sequential = await description({ subagentExecution: "sequential" });
    expect(sequential).not.toContain("at the same time");
    expect(sequential).toContain("Delegate a self-contained task");
  });

  test("a custom text is used as is, in every mode, still ending with the type list", async () => {
    for (const mode of ["parallel", "read-only", "sequential"] as const) {
      const text = await description({
        subagentExecution: mode,
        agentTaskDescription: "Use me well.",
      });
      expect(text?.startsWith("Use me well.\n\nAvailable sub-agent types:\n- ")).toBe(true);
      expect(text).toContain("- explore:");
      expect(text).not.toContain("Delegate a self-contained task");
    }
  });
});

describe("a pod takes the laptop's values (T-CARRY)", () => {
  async function pod(own: Partial<TentacleConfig>, laptop: GatedModel, settings?: SessionSettings) {
    const [daemonCh, clientCh] = createChannelPair();
    const host = serve.podSessionHost({ ...config, ...own }, undefined, { modelProxy: true });
    const connection = new Connection(daemonCh, host, undefined, { servesModel: true });
    const client = new RemoteClient(clientCh, new PermissionBroker(), laptop, {
      ...(settings ? { sessionSettings: settings } : {}),
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const say = async (): Promise<void> => {
      for await (const _ of session.send("go")) {
        // drained
      }
    };
    return {
      say,
      close: () => {
        connection.close();
        client.close();
      },
    };
  }
  const ownSays = {
    subagentExecution: "sequential",
    subagentMaxParallel: 9,
    agentTaskDescription: "POD TEXT",
  } as const;
  const descriptionOf = (model: GatedModel): string | undefined =>
    model.parentRequests[0]?.tools?.find((t) => t.name === "agent_task")?.description;

  test("the pod says sequential + 9; the laptop parallel + 2 + its text: the laptop's wins", async () => {
    // Mutation: `buildAgent` reading the pod's config instead of the merged one → red.
    const laptop = new GatedModel(three);
    const gates = ["CHILD-1", "CHILD-2", "CHILD-3"].map((p) => laptop.gate(p));
    const t = await pod(ownSays, laptop, {
      subagentExecution: "parallel",
      subagentMaxParallel: 2,
      agentTaskDescription: "LAPTOP TEXT",
    });
    const said = t.say();
    await until(() => laptop.started.length === 2);
    await new Promise((r) => setTimeout(r, 10));
    expect(laptop.started.length).toBe(2);
    for (const gate of gates) {
      gate.resolve();
    }
    await said;
    expect(laptop.peak).toBe(2);
    expect(descriptionOf(laptop)?.startsWith("LAPTOP TEXT\n\n")).toBe(true);
    t.close();
  });

  test("settings with no description, over a pod text: the neutral text", async () => {
    const laptop = new GatedModel([{ type: "done" }]);
    const t = await pod(ownSays, laptop, { subagentExecution: "sequential" });
    await t.say();
    expect(descriptionOf(laptop)).not.toContain("POD TEXT");
    expect(descriptionOf(laptop)).toContain("Delegate a self-contained task");
    t.close();
  });

  test("a bare open: the pod's own values", async () => {
    const laptop = new GatedModel(two);
    const t = await pod({ ...ownSays, agentTaskDescription: "POD TEXT" }, laptop);
    await expectOneAtATime(laptop, () => t.say());
    expect(descriptionOf(laptop)?.startsWith("POD TEXT\n\n")).toBe(true);
    t.close();
  });

  test("model/slots reaches the laptop's provider and lowers the cap (slots = 1 → no overlap)", async () => {
    const laptop = new GatedModel(two, 1);
    const t = await pod({}, laptop, { subagentExecution: "parallel", subagentMaxParallel: 4 });
    await expectOneAtATime(laptop, () => t.say());
    expect(laptop.slotCalls).toBe(1);
    t.close();
  });

  test("a laptop with no slots: the carried cap applies", async () => {
    const laptop = new GatedModel(two);
    const one = laptop.gate("CHILD-1");
    const second = laptop.gate("CHILD-2");
    const t = await pod({}, laptop, { subagentExecution: "parallel", subagentMaxParallel: 4 });
    const said = t.say();
    await until(() => laptop.started.length === 2);
    one.resolve();
    second.resolve();
    await said;
    expect(laptop.peak).toBe(2);
    t.close();
  });

  test("no call without a fan-out: a lone agent_task never probes", async () => {
    const laptop = new GatedModel([spawn("c1", "CHILD-1"), { type: "done" }], 2);
    const t = await pod({}, laptop, { subagentExecution: "parallel", subagentMaxParallel: 4 });
    await t.say();
    expect(laptop.slotCalls).toBe(0);
    t.close();
  });
});
