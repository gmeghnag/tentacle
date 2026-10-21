/**
 * The client side of `/name` (docs/feat/skills-slash.md): the handshake's skill
 * catalog (refreshed on reconnect) and the structured `skill` on `session/prompt`
 * (kept on the keyed re-send), over real daemon objects.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { type ModelProvider, PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry, createSkillActivator } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";
import { GatedModel, done, t, until } from "./support/fakes.ts";

type Frame = { method?: string; params?: Record<string, unknown> };

function makeHost(model: ModelProvider, names: readonly string[]): SessionHost {
  const entries = names.map((name) => ({
    name,
    location: `/s/${name}/SKILL.md`,
    dir: `/s/${name}`,
    files: [],
    filesTruncated: false,
    userInvocable: true,
  }));
  return new SessionHost({
    defaultCwd: "/tmp/skills-slash-client",
    skills: names.map((name) => ({ name, description: `does ${name}` })),
    createAgent: () => ({
      agent: new Agent({
        model,
        tools: new ToolRegistry(),
        env: {
          id: "e",
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          readFile: async () => "",
          writeFile: async () => {},
        },
        skills: createSkillActivator(entries, async (s) => ({
          body: `BODY ${s.name}`,
          bodyLine: 5,
        })),
      }),
      permissions: new PermissionBroker(),
    }),
  });
}

/** Where a dial lands (swappable: a restarted daemon), with each channel's outbound frames. */
class Target {
  readonly frames: Frame[][] = [];
  last: DuplexChannel | null = null;
  onFrame: ((frame: Frame) => void) | null = null;
  constructor(public host: SessionHost) {}
  connect(): DuplexChannel {
    const [d, c] = createChannelPair();
    new Connection(d, this.host);
    const log: Frame[] = [];
    this.frames.push(log);
    const tapped: DuplexChannel = {
      send: (data) => {
        const frame = JSON.parse(data) as Frame;
        log.push(frame);
        c.send(data);
        this.onFrame?.(frame);
      },
      close: () => c.close(),
      setOnMessage: (h) => c.setOnMessage(h),
      setOnClose: (h) => c.setOnClose(h),
    };
    this.last = tapped;
    return tapped;
  }
}

async function drain(iter: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

const prompts = (log: readonly Frame[]): Frame[] =>
  log.filter((f) => f.method === "session/prompt");

describe("RemoteClient skill catalog", () => {
  test("empty before the handshake, then the daemon's catalog", async () => {
    const target = new Target(makeHost(new GatedModel([]), ["deploy-app", "lint"]));
    const client = new RemoteClient(target.connect(), new PermissionBroker());
    expect(client.skills()).toEqual([]);
    await client.initialize();
    expect(client.skills()).toEqual([
      { name: "deploy-app", description: "does deploy-app" },
      { name: "lint", description: "does lint" },
    ]);
    client.close();
  });
});

describe("session/prompt{skill} from RemoteSession", () => {
  test("send(…, {skill}) carries it structured; a plain send carries no `skill` key", async () => {
    const model = new GatedModel([
      [t("ok"), done],
      [t("ok"), done],
    ]);
    const target = new Target(makeHost(model, ["deploy-app"]));
    const client = new RemoteClient(target.connect(), new PermissionBroker());
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const events = await drain(session.send("/deploy-app go", undefined, { skill: "deploy-app" }));
    await drain(session.send("plain"));
    const [first, second] = prompts(target.frames[0] ?? []);
    expect(first?.params?.skill).toBe("deploy-app");
    expect(first?.params?.content).toEqual([{ type: "text", text: "/deploy-app go" }]);
    expect(second?.params && "skill" in second.params).toBe(false);
    // The daemon's round reaches the client as an ordinary `skill` tool call.
    const start = events.find((e) => e.type === "tool_start");
    expect(start?.type === "tool_start" && start.name).toBe("skill");
    client.close();
  });

  test("a drop before the ack: the keyed re-send keeps `skill`", async () => {
    const model = new GatedModel([[t("ok"), done]]);
    const target = new Target(makeHost(model, ["deploy-app"]));
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: async () => target.connect(),
      random: () => 0,
    });
    await client.initialize();
    // The link drops right after the prompt frame left: the ack is lost with it.
    target.onFrame = (frame) => {
      if (frame.method === "session/prompt") {
        target.onFrame = null;
        target.last?.close();
      }
    };
    const outcome = await drain(
      client.newSession(undefined, "S").send("/deploy-app go", undefined, { skill: "deploy-app" }),
    ).catch((e: Error) => e);
    expect(outcome).not.toBeInstanceOf(Error);
    const resent = prompts(target.frames[1] ?? [])[0];
    expect(resent?.params?.skill).toBe("deploy-app");
    expect(resent?.params?.turnId).toBe(prompts(target.frames[0] ?? [])[0]?.params?.turnId);
    client.close();
  });
});

describe("the catalog follows the daemon across a reconnect", () => {
  test("a daemon restarted with other skills: the reconnect's handshake replaces the catalog", async () => {
    const model = new GatedModel([]);
    const target = new Target(makeHost(model, ["deploy-app"]));
    const client = new RemoteClient(target.connect(), new PermissionBroker(), undefined, {
      channelFactory: async () => target.connect(),
      random: () => 0,
    });
    await client.initialize();
    expect(client.skills().map((s) => s.name)).toEqual(["deploy-app"]);
    target.host = makeHost(model, ["lint"]);
    target.last?.close();
    expect(await until(() => client.skills()[0]?.name === "lint")).toBe(true);
    expect(client.skills().map((s) => s.name)).toEqual(["lint"]);
    client.close();
  });
});
