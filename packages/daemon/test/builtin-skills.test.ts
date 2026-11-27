import { describe, expect, test } from "bun:test";
import { Agent, NO_CAPABILITIES } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  builtinDefaultOff,
} from "@tentacle/core";
import { type OpenResult, PROTOCOL_VERSION, SessionSkillsResultSchema } from "@tentacle/protocol";
import { ToolRegistry, createSkillTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { composeSystemPrompt } from "../../config/src/resolve.ts";
import type { SkillInfo } from "../../config/src/skills.ts";
import { Connection } from "../src/connection.ts";
import { type AgentFactory, SessionHost } from "../src/session-host.ts";
import { SessionPersister } from "../src/session-persister.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";

// docs/feat/builtin-skills.md T5: a built-in skill the host seeds off is out of
// the model's catalog and `skill` enum, `/skills` turns it on, and a `serve`
// reload keeps it off (D4: off wins for the built-ins this host built off).

const CWD = "/tmp/builtin-skills";

const skill = (name: string, builtin: boolean): SkillInfo => ({
  name,
  description: `does ${name}`,
  location: `/s/${name}/SKILL.md`,
  dir: `/s/${name}`,
  scope: "user",
  files: [],
  filesTruncated: false,
  modelInvocable: true,
  userInvocable: true,
  ...(builtin ? { builtin: true as const } : {}),
});
const SKILLS = [skill("mine", false), skill("tentacle", true), skill("tentacle-a2a", true)];

interface Sent {
  readonly system: string;
  readonly enum: readonly string[];
}

class Recorder implements ModelProvider {
  readonly id = "recorder";
  readonly sent: Sent[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const first = request.messages[0];
    const def = (request.tools ?? []).find((t) => t.name === "skill");
    const params = def?.parameters as { properties?: { name?: { enum?: string[] } } } | undefined;
    this.sent.push({
      system: first?.role === "system" ? String(first.content) : "",
      enum: params?.properties?.name?.enum ?? [],
    });
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

/** A daemon whose config turned `on` built-ins on (what `buildAgent` seeds). */
function daemon(on: Record<string, boolean> = {}, store?: SpyDaemonStore, skills = SKILLS) {
  const model = new Recorder();
  const createAgent: AgentFactory = (_cwd, ctx) => {
    const permissions = ctx.reuse?.permissions ?? new PermissionBroker();
    const tools = new ToolRegistry();
    const tool = createSkillTool(skills, async () => ({ body: "B", bodyLine: 1 }));
    if (tool) tools.register(tool);
    const agent = new Agent({
      model,
      tools,
      env: {} as ExecutionEnvironment,
      systemPrompt: composeSystemPrompt({ identity: "sys", agentsEnabled: false, skills })
        .systemPrompt,
      skillListing: {
        skills: skills.map((s) => ({
          name: s.name,
          description: s.description,
          scope: s.scope,
          user: true,
          model: true,
          location: s.location,
          ...(s.builtin ? { builtin: true as const } : {}),
        })),
        problems: [],
      },
      requestPermission: (req, options) => permissions.request(req, options),
      capabilities: { ...NO_CAPABILITIES, disabledSkills: builtinDefaultOff(skills, on) },
    });
    return { agent, permissions, settingsReport: { carried: {}, overridden: {} } };
  };
  const persister = store
    ? new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} })
    : undefined;
  const host = new SessionHost({
    defaultCwd: CWD,
    createAgent,
    ...(persister ? { persister } : {}),
  });
  return { host, model };
}

async function promptAndRead(d: ReturnType<typeof daemon>, run: () => void): Promise<Sent> {
  const before = d.model.sent.length;
  run();
  for (let i = 0; i < 500 && d.model.sent.length === before; i++) await Bun.sleep(1);
  const sent = d.model.sent[before];
  if (!sent) throw new Error("no model call");
  return sent;
}

/** Wait for the turn to have ended (polled, throwing on timeout). */
async function idle(hosted: { assertIdle(): void }): Promise<void> {
  for (let i = 0; i < 500; i++) {
    try {
      hosted.assertIdle();
      return;
    } catch {
      await Bun.sleep(1);
    }
  }
  throw new Error("the turn never ended");
}

describe("a created session", () => {
  test("lacks the off built-ins in its prompt and `skill` enum; `/skills` turns one on", async () => {
    const d = daemon();
    const { hosted } = d.host.open({ create: true }, { send: () => {} });
    expect(hosted.capabilities().disabledSkills).toEqual(["tentacle", "tentacle-a2a"]);
    const off = await promptAndRead(d, () => hosted.prompt("t1", [{ type: "text", text: "hi" }]));
    expect(off.system).toContain("<name>mine</name>");
    expect(off.system).not.toContain("<name>tentacle");
    expect(off.enum).toEqual(["mine"]);

    hosted.setCapability({ kind: "skill", name: "tentacle", enabled: true });
    await idle(hosted);
    const on = await promptAndRead(d, () => hosted.prompt("t2", [{ type: "text", text: "hi" }]));
    expect(on.system).toContain("<name>tentacle</name>");
    expect(on.system).not.toContain("<name>tentacle-a2a</name>");
    expect(on.enum).toEqual(["mine", "tentacle"]);
  });

  test("a client's seed can't turn one on (off wins)", async () => {
    const d = daemon();
    const [server, side] = createChannelPair();
    new Connection(server, d.host);
    const client = new RpcPeer(side, {
      onNotification: () => {},
      onRequest: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
      clientInfo: { name: "tentacle", version: "1.0.0" },
    });
    const opened = (await client.request("session/open", {
      sessionId: "S",
      create: true,
      capabilities: { disabledMcp: [], disabledSkills: [], disabledTools: [] },
    })) as OpenResult;
    expect(opened.capabilities?.disabledSkills).toEqual(["tentacle", "tentacle-a2a"]);
    // The listing says which are built-in, and which are off.
    const listed = SessionSkillsResultSchema.parse(
      await client.request("session/skills", { sessionId: "S" }),
    );
    expect(
      listed.skills.map((s) => [s.name, s.scope, s.builtin ?? false, s.disabled ?? false]),
    ).toEqual([
      ["mine", "user", false, false],
      ["tentacle", "user", true, true],
      ["tentacle-a2a", "user", true, true],
    ]);
  });
});

describe("a serve reload (D4)", () => {
  async function recordOf(turnOn: boolean) {
    const store = new SpyDaemonStore();
    const d = daemon({}, store);
    const { hosted } = d.host.open(
      { create: true, messages: [{ role: "user", content: "q" }] },
      { send: () => {} },
    );
    hosted.setCapability({ kind: "skill", name: "mine", enabled: false });
    if (turnOn) hosted.setCapability({ kind: "skill", name: "tentacle", enabled: true });
    await hosted.persisted();
    const record = store.durable.get(hosted.id);
    if (!record) throw new Error("nothing durable");
    return { store, record };
  }

  test("a record without them (written before the feature) reloads with them off", async () => {
    // Mutation: drop the D4 union → the built-ins come back on.
    const { store, record } = await recordOf(false);
    for (const old of [
      { ...record, capabilities: undefined },
      {
        ...record,
        capabilities: { disabledMcp: [], disabledSkills: ["mine"], disabledTools: [] },
      },
    ]) {
      const restarted = daemon({}, store);
      const restored = restarted.host.restore(old);
      expect(restored.capabilities().disabledSkills).toEqual(
        old.capabilities ? ["mine", "tentacle", "tentacle-a2a"] : ["tentacle", "tentacle-a2a"],
      );
      const sent = await promptAndRead(restarted, () =>
        restored.prompt("t1", [{ type: "text", text: "go" }]),
      );
      expect(sent.system).not.toContain("<name>tentacle");
    }
  });

  test("one turned on with `/skills` goes back off; the config key is what lasts", async () => {
    const { store, record } = await recordOf(true);
    expect(record.capabilities?.disabledSkills).toEqual(["mine", "tentacle-a2a"]);
    expect(daemon({}, store).host.restore(record).capabilities().disabledSkills).toEqual([
      "mine",
      "tentacle",
      "tentacle-a2a",
    ]);
    // Turned on in the config: the record's set stands.
    const on = daemon({ tentacle: true }, store).host.restore(record);
    expect(on.capabilities().disabledSkills).toEqual(["mine", "tentacle-a2a"]);
  });

  test("a user's own skill of a built-in's name is not forced off", async () => {
    const { store, record } = await recordOf(true);
    const shadowed = [skill("mine", false), skill("tentacle", false)];
    const restored = daemon({}, store, shadowed).host.restore(record);
    expect(restored.capabilities().disabledSkills).toEqual(["mine", "tentacle-a2a"]);
  });
});
