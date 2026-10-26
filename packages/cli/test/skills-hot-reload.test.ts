import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore, offeredSkillNames } from "@tentacle/agent";
import type { SessionEvent } from "@tentacle/client";
import { type TentacleConfig, loadConfig } from "@tentacle/config";
import {
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { createChannelPair } from "@tentacle/transport";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { inProcessSessions } from "../src/session-jobs.ts";
import { SessionSaver } from "../src/session-saver.ts";
import { buildAgent, createSkillScan, inProcessAgents } from "../src/wiring.ts";

// docs/feat/skills-hot-reload.md, end to end over real files and real
// objects (the `buildAgent` a daemon uses, `SessionHost` + `Connection`, the
// laptop's `RemoteClient` runtime; and the in-process path): a skill written
// after the start is in the user's `/name` list and activatable at once, while
// the model's own set (the `skill` enum, the system prompt) does not change.

let dir: string;
let savedHome: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-skills-hot-reload-"));
  // A rescan reads the user scope from `process.env.HOME` (as at start).
  savedHome = process.env.HOME;
  process.env.HOME = dir;
});
afterEach(async () => {
  const homeKey = "HOME";
  if (savedHome === undefined) delete process.env[homeKey];
  else process.env.HOME = savedHome;
  await rm(dir, { recursive: true, force: true });
});

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...request, messages: [...request.messages] });
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

const root = (): string => join(dir, ".agents", "skills");
const writeSkill = async (name: string): Promise<void> => {
  await mkdir(join(root(), name), { recursive: true });
  await writeFile(
    join(root(), name, "SKILL.md"),
    `---\nname: ${name}\ndescription: the ${name} skill\n---\n${name} instructions\n`,
  );
};

async function startConfig(): Promise<TentacleConfig> {
  const cfgDir = join(dir, "cfg");
  await mkdir(cfgDir, { recursive: true });
  await writeSkill("alpha");
  const config = await loadConfig({ env: { HOME: dir }, configDir: cfgDir, cwd: dir });
  return { ...config, subagentsEnabled: false };
}

async function drain(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** A worker-shaped daemon (one shared scan) driven through the laptop's runtime. */
async function daemonRuntime(config: TentacleConfig, model: ModelProvider) {
  const skillScan = createSkillScan(config);
  const host = new SessionHost({
    defaultCwd: dir,
    newSessionSkills: () => skillScan.newSession(),
    createAgent: (cwd) => {
      const wired = buildAgent({ ...config, cwd }, { modelOverride: model, skillScan });
      return { agent: wired.agent, permissions: wired.permissions, jobs: wired.jobs };
    },
  });
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host);
  return createLocalRuntime({
    channel: clientCh,
    disposeTransport: () => connection.close(),
    permissions: new PermissionBroker(),
    saver: new SessionSaver(new JsonSessionStore(join(dir, "sessions")), () => {}),
    cwd: dir,
    model: "scripted",
    resume: null,
  });
}

describe("skills follow the disk (T4: real files, daemon + client)", () => {
  test("before the first prompt: a new skill is listed, and that first prompt may activate it", async () => {
    const config = await startConfig();
    const model = new ScriptedProvider();
    const runtime = await daemonRuntime(config, model);
    const controller = runtime.createSession();
    await writeSkill("beta");

    const view = await controller.skills?.();
    expect(view?.slash.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(view?.skills.map((s) => [s.name, s.model, s.modelAfterReset])).toEqual([
      ["alpha", true, undefined],
      ["beta", false, true],
    ]);

    // Mutation (red, verified): a new session's activator from the start-up
    // discovery (not the shared scan's latest) → this prompt is refused.
    const events = await drain(controller.send("/beta go", undefined, { skill: "beta" }));
    expect(events.at(-1)?.type).toBe("turn_end");
    expect(events.some((e) => e.type === "tool_start" && e.name === "skill")).toBe(true);
    // The model's own set did not change: its enum and its system prompt.
    const request = model.requests[0];
    expect(offeredSkillNames(request?.tools ?? [])).toEqual(["alpha"]);
    expect(request?.messages[0]?.content).toContain("<name>alpha</name>");
    expect(request?.messages[0]?.content).not.toContain("<name>beta</name>");
    expect(request?.messages.some((m) => m.content.includes("beta instructions"))).toBe(true);
    await runtime.dispose();
  });

  test("an open session: an added skill becomes activatable, a removed one is reported", async () => {
    const config = await startConfig();
    const model = new ScriptedProvider();
    const runtime = await daemonRuntime(config, model);
    const controller = runtime.createSession();
    await drain(controller.send("hello"));

    await writeSkill("gamma");
    await rm(join(root(), "alpha"), { recursive: true, force: true });
    const view = await controller.skills?.();
    expect(view?.slash.map((s) => s.name)).toEqual(["gamma"]);
    expect(view?.problems).toContain("alpha: removed — the model keeps it until a context reset");

    const events = await drain(controller.send("/gamma now", undefined, { skill: "gamma" }));
    expect(events.at(-1)?.type).toBe("turn_end");
    const last = model.requests.at(-1);
    expect(offeredSkillNames(last?.tools ?? [])).toEqual(["alpha"]);
    expect(last?.messages.some((m) => m.content.includes("gamma instructions"))).toBe(true);
    await runtime.dispose();
  });
});

describe("the in-process path (T8)", () => {
  test("the in-process controller's skills() sees a skill written after the start", async () => {
    const config = await startConfig();
    const { build } = inProcessAgents(config);
    const { createSession } = inProcessSessions({
      build,
      mcpTools: [],
      resume: null,
      persist: () => {},
    });
    const controller = createSession();
    expect((await controller.skills?.())?.slash.map((s) => s.name)).toEqual(["alpha"]);
    await writeSkill("beta");
    const view = await controller.skills?.();
    expect(view?.slash.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(view?.skills.find((s) => s.name === "beta")?.modelAfterReset).toBe(true);
    // A session created after the scan starts from it too (the shared scan).
    const next = createSession();
    expect((await next.skills?.())?.slash.map((s) => s.name)).toEqual(["alpha", "beta"]);
    controller.close?.();
    next.close?.();
  });
});
