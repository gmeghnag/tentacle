import { describe, expect, test } from "bun:test";
import { Agent, NO_CAPABILITIES } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { JsonRpcErrorCode, Method, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry, builtinTools, chartTool, diagramTool } from "@tentacle/tools";
import { type DuplexChannel, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import type { SessionEvent } from "../src/mapping.ts";
import { SwitchesNotAppliedError } from "../src/pending-capabilities.ts";
import { RemoteClient } from "../src/remote-client.ts";

// docs/feat/caps-before-first-message.md: the switches flipped before the first
// message are applied INSIDE the one open — `session/open`, one awaited
// `session/set_capability` per flip, THEN `session/prompt` — so the first model
// call already runs with them. Each test names its T-C* case and the mutation
// that must turn it red.

const CWD = "/tmp/caps-before-first-message";
const env = {} as ExecutionEnvironment;

/** The model's view of every request: the tool names it was offered. */
class Recorder implements ModelProvider {
  readonly id = "recorder";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

interface Frame {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

const methods = (frames: readonly Frame[]): string[] =>
  frames.flatMap((f) => (f.method === undefined ? [] : [f.method]));

/** A client channel recording every frame it sends (the pattern of `foreign-turns`). */
function recordingClient(channel: DuplexChannel, frames: Frame[]): DuplexChannel {
  return {
    send: (data) => {
      frames.push(JSON.parse(data) as Frame);
      channel.send(data);
    },
    close: () => channel.close(),
    setOnMessage: (h) => channel.setOnMessage(h),
    setOnClose: (h) => channel.setOnClose(h),
  };
}

/** Drain a send's events; resolves "ended", or the error it threw. */
async function drain(events: AsyncIterable<SessionEvent>, ms = 3000): Promise<unknown> {
  return Promise.race([
    (async () => {
      for await (const _event of events) {
        // drained
      }
      return "ended";
    })().catch((e: unknown) => e),
    new Promise((r) => setTimeout(() => r("hung"), ms)),
  ]);
}

const until = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) {
    await Bun.sleep(2);
  }
};

/**
 * A SCRIPTED daemon: it answers just enough to open a session and run one turn,
 * so a test can HOLD a `set_capability` answer (`hold`) or REFUSE one
 * (`refuseTool`) — the two cases no real daemon offers on demand. Its
 * capabilities answer mirrors what it applied.
 */
function scripted(o: { readonly hold?: boolean; readonly refuseTool?: string } = {}) {
  const frames: Frame[] = [];
  const prompts: string[] = [];
  const disabled = { mcp: [] as string[], skill: [] as string[], tool: [] as string[] };
  let openGate = (): void => {};
  const gate =
    o.hold === true
      ? new Promise<void>((resolve) => {
          openGate = resolve;
        })
      : Promise.resolve();
  const [daemonCh, clientCh] = createChannelPair();
  new RpcPeer(daemonCh, {
    onRequest: async (method, params) => {
      if (method === Method.Initialize) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
        };
      }
      if (method === Method.Open) {
        return {
          sessionId: (params as { sessionId?: string }).sessionId ?? "s1",
          epoch: "e",
          created: true,
          resync: false,
        };
      }
      if (method === Method.SetCapability) {
        const p = params as { kind: "mcp" | "skill" | "tool"; name: string; enabled: boolean };
        await gate;
        if (p.name === o.refuseTool) {
          throw new RpcError(
            JsonRpcErrorCode.InvalidParams,
            `unknown built-in tool or group: ${JSON.stringify(p.name)}`,
          );
        }
        disabled[p.kind] = p.enabled ? [] : [p.name];
        return {
          capabilities: {
            disabledMcp: [...disabled.mcp],
            disabledSkills: [...disabled.skill],
            disabledTools: [...disabled.tool],
          },
        };
      }
      if (method === Method.Prompt) {
        prompts.push((params as { sessionId: string }).sessionId);
        return {
          turnId: (params as { turnId: string }).turnId,
          ended: { stopReason: "end_turn" },
        };
      }
      if (method === Method.SessionSkills) {
        return { slash: [], skills: [], problems: [], moreProblems: 0 };
      }
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
    },
  });
  const client = new RemoteClient(
    recordingClient(clientCh, frames),
    new PermissionBroker(),
    undefined,
    {
      clientInfo: { name: "laptop", version: "1" },
    },
  );
  return { client, frames, prompts, release: () => openGate() };
}

/** A REAL in-process daemon: real tools, a recording model (T-C2's exact property). */
function realDaemon(
  o: { readonly hostOff?: readonly string[]; readonly skills?: readonly string[] } = {},
) {
  const model = new Recorder();
  const host = new SessionHost({
    defaultCwd: CWD,
    ...(o.skills !== undefined
      ? {
          newSessionSkills: async () => ({
            skills: (o.skills ?? []).map((name) => ({
              name,
              description: name,
              scope: "project" as const,
              user: true,
              model: true,
              location: `/skills/${name}`,
            })),
            problems: [],
          }),
        }
      : {}),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry()
          .registerAll(builtinTools)
          .register(chartTool as never)
          .register(diagramTool as never),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
        capabilities: { ...NO_CAPABILITIES, disabledTools: [...(o.hostOff ?? [])] },
      });
      return { agent, permissions };
    },
  });
  const dial = async () => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const frames: Frame[] = [];
    const client = new RemoteClient(recordingClient(c, frames), new PermissionBroker(), undefined, {
      clientInfo: { name: "laptop", version: "1" },
    });
    await client.initialize();
    return { client, frames };
  };
  return { model, dial };
}

describe("T-C1 ordering: no prompt frame while a pre-open set is unanswered", () => {
  test("the set is answered first, then session/prompt (mutation M1 turns this red)", async () => {
    const d = scripted({ hold: true });
    const session = d.client.newSession(undefined, crypto.randomUUID());
    const flipped = session.setCapability("mcp", "github", false);
    expect(session.opened()).toBe(false);
    // Nothing is sent before the first message: the flip is client-side only.
    expect(methods(d.frames)).not.toContain(Method.SetCapability);

    const sent = drain(session.send("hi"));
    await until(() => methods(d.frames).includes(Method.SetCapability));
    expect(methods(d.frames)).toContain(Method.Open);
    // The set is in flight: NO prompt has been written, and the session is not
    // "open" for anybody awaiting the same open (an enqueue, a send-now).
    expect(methods(d.frames)).not.toContain(Method.Prompt);
    expect(session.opened()).toBe(false);

    d.release();
    expect(await sent).toBe("ended");
    const list = methods(d.frames);
    expect(list).toContain(Method.Prompt);
    expect(list.indexOf(Method.SetCapability)).toBeLessThan(list.indexOf(Method.Prompt));
    await flipped;
  });
});

describe("T-C2 the exact property: the FIRST model call already runs with the switches", () => {
  test("a group off and a host-off tool on, both in request #1", async () => {
    // The host config turns `chart` off; the person switches it back ON and
    // `visuals` off before the first message. The create's seed cannot turn a
    // host-off tool on (union, off wins), so only the set call can — and it must
    // land before the prompt.
    const d = realDaemon({ hostOff: ["chart"] });
    const { client } = await d.dial();
    const session = client.newSession(undefined, crypto.randomUUID());
    // Both presses are pre-open: recorded, and applied by the first message.
    const off = session.setCapability("tool", "visuals", false);
    const on = session.setCapability("tool", "chart", true);
    expect(await drain(session.send("hi"))).toBe("ended");
    await Promise.all([off, on]);

    const first = (d.model.requests[0]?.tools ?? []).map((t) => t.name);
    expect(first).not.toContain("diagram");
    expect(first).not.toContain("present");
    expect(first).toContain("chart");
  });
});

describe("T-C3 a refused set blocks the prompt", () => {
  test("the send rejects SwitchesNotAppliedError, no prompt frame, the next send goes", async () => {
    // Mutation: `runTurn` ignores `heldFailure` (M2) → a prompt frame → red.
    const d = scripted({ refuseTool: "visuals" });
    const session = d.client.newSession(undefined, crypto.randomUUID());
    const flip = session.setCapability("tool", "visuals", false).catch((e: unknown) => e);
    const failed = await drain(session.send("hi"));
    expect(await flip).toBeInstanceOf(RpcError);
    expect(failed instanceof SwitchesNotAppliedError).toBe(true);
    if (failed instanceof SwitchesNotAppliedError) {
      expect(failed.failed.map((f) => f.name)).toEqual(["visuals"]);
      expect(failed.failed[0]?.reason).toContain("unknown built-in tool");
    }
    expect(methods(d.frames)).not.toContain(Method.Prompt);
    // The session IS open (the panels now show its real switches), and the
    // refusal is consumed: the next send goes out as the session is.
    expect(session.opened()).toBe(true);
    expect(await drain(session.send("hi again"))).toBe("ended");
    expect(methods(d.frames)).toContain(Method.Prompt);
  });
});

describe("T-C5 the preview and its emissions", () => {
  test("capabilities() before the open is the preview; ONE emission, without `by`, after the sets", async () => {
    // Mutations: emit the echoes during `applyPreOpen` (M4) → more emissions,
    // one with a `by` → red; `capabilities()` returning the daemon's state only
    // → undefined before the open → red.
    const d = scripted({ hold: true });
    const session = d.client.newSession(undefined, crypto.randomUUID());
    const seen: { state: unknown; by?: string }[] = [];
    session.onCapabilities((state, by) => {
      seen.push({ state, ...(by ? { by } : {}) });
    });
    expect(session.capabilities()).toEqual({
      disabledMcp: [],
      disabledSkills: [],
      disabledTools: [],
    });
    const flipped = session.setCapability("tool", "chart", false);
    expect(session.capabilities()?.disabledTools).toEqual(["chart"]);
    // The preview: one emission, no `by` (nobody else pressed it).
    expect(seen).toHaveLength(1);
    expect(seen[0]?.by).toBeUndefined();

    const sent = drain(session.send("hi"));
    await until(() => methods(d.frames).includes(Method.SetCapability));
    // While the set is in flight the state is stored, NOT emitted.
    expect(seen).toHaveLength(1);
    d.release();
    expect(await sent).toBe("ended");
    // Exactly one more: the daemon's state, with no `by`.
    expect(seen).toHaveLength(2);
    expect(seen[1]?.by).toBeUndefined();
    expect((seen[1]?.state as { disabledTools?: string[] }).disabledTools).toEqual(["chart"]);
    await flipped;
  });
});

describe("T-C5b no flicker and no 'another device' against a real daemon", () => {
  test("the open's snapshot and the set's `by` echo are stored, not emitted (M4 turns this red)", async () => {
    // A real daemon sends a snapshot at the open (the seed, chart ON) and a
    // `capabilities` echo carrying this connection's label as `by`: emitting
    // either would flicker the row and read as another device.
    const d = realDaemon();
    const { client } = await d.dial();
    const session = client.newSession(undefined, crypto.randomUUID());
    const seen: { state: unknown; by?: string }[] = [];
    session.onCapabilities((state, by) => {
      seen.push({ state, ...(by ? { by } : {}) });
    });
    const flipped = session.setCapability("tool", "chart", false);
    expect(await drain(session.send("hi"))).toBe("ended");
    await flipped;
    expect(seen.filter((s) => s.by !== undefined)).toEqual([]);
    const tools = seen.map((s) => (s.state as { disabledTools?: string[] }).disabledTools);
    expect(tools).toEqual([["chart"], ["chart"]]);
  });
});

describe("T-C6 the common path is unchanged", () => {
  test("nothing flipped: exactly session/open then session/prompt", async () => {
    const d = realDaemon();
    const { client, frames } = await d.dial();
    const session = client.newSession(undefined, crypto.randomUUID());
    expect(await drain(session.send("hi"))).toBe("ended");
    expect(methods(frames).filter((m) => m !== Method.Initialize)).toEqual([
      Method.Open,
      Method.Prompt,
    ]);
  });
});

describe("T-C7 a flipped skill the session does not list", () => {
  test("its press rejects honestly and the prompt IS sent", async () => {
    const d = realDaemon({ skills: ["plan"] });
    const { client, frames } = await d.dial();
    const session = client.newSession(undefined, crypto.randomUUID());
    const flip = session.setCapability("skill", "deploy", false).catch((e: unknown) => e);
    expect(await drain(session.send("hi"))).toBe("ended");
    const err = await flip;
    expect(err instanceof Error && /not in this session any more/.test(err.message)).toBe(true);
    expect(methods(frames)).toContain(Method.Prompt);
  });
});

describe("T-C8 a failed open keeps the flips", () => {
  test("the retry opens and then applies them", async () => {
    const frames: Frame[] = [];
    let opens = 0;
    const [daemonCh, clientCh] = createChannelPair();
    new RpcPeer(daemonCh, {
      onRequest: async (method, params) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
          };
        }
        if (method === Method.Open) {
          if (opens++ === 0) {
            throw new RpcError(JsonRpcErrorCode.InternalError, "daemon busy");
          }
          return {
            sessionId: (params as { sessionId?: string }).sessionId ?? "s1",
            epoch: "e",
            created: true,
            resync: false,
          };
        }
        if (method === Method.SetCapability) {
          return {
            capabilities: {
              disabledMcp: [],
              disabledSkills: [(params as { name: string }).name],
              disabledTools: [],
            },
          };
        }
        if (method === Method.Prompt) {
          return {
            turnId: (params as { turnId: string }).turnId,
            ended: { stopReason: "end_turn" },
          };
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
      },
    });
    const client = new RemoteClient(
      recordingClient(clientCh, frames),
      new PermissionBroker(),
      undefined,
      { clientInfo: { name: "laptop", version: "1" } },
    );
    await client.initialize();
    const session = client.newSession(undefined, crypto.randomUUID());
    const flip = session.setCapability("skill", "deploy", false);
    expect(await drain(session.send("hi"))).toBeInstanceOf(Error);
    // Still pending, so the preview stands; the next send applies them.
    expect(session.capabilities()?.disabledSkills).toEqual(["deploy"]);
    expect(await drain(session.send("hi again"))).toBe("ended");
    await flip;
    const list = methods(frames);
    expect(list).toContain(Method.SetCapability);
    expect(list.indexOf(Method.SetCapability)).toBeLessThan(list.lastIndexOf(Method.Prompt));
  });
});

describe("T-C9 a /clear before the first message seeds the preview", () => {
  test("seedCapabilities() carries the preview as the next open's seed", async () => {
    const d = scripted();
    const session = d.client.newSession(undefined, crypto.randomUUID());
    void session.setCapability("skill", "deploy", false).catch(() => {});
    session.seedCapabilities();
    const next = d.client.newSession(undefined, crypto.randomUUID());
    expect(await drain(next.send("hi"))).toBe("ended");
    const open = d.frames.find((f) => f.method === Method.Open);
    expect((open?.params?.capabilities as { disabledSkills?: string[] }).disabledSkills).toEqual([
      "deploy",
    ]);
  });
});

describe("F5 a racing enqueue behind a set that fails", () => {
  test("it is refused with the same error and nothing is enqueued", async () => {
    const d = scripted({ refuseTool: "visuals", hold: true });
    const session = d.client.newSession(undefined, crypto.randomUUID());
    void session.setCapability("tool", "visuals", false).catch(() => {});
    // Drive the send until the sets are in flight (its turn is installed, its
    // open not settled): a second message then ENQUEUES and waits on the same
    // open — and takes its refusal (F5).
    const sent = drain(session.send("hi"));
    await until(() => methods(d.frames).includes(Method.SetCapability));
    const queued = session.enqueue("second").catch((e: unknown) => e);
    d.release();
    expect(await sent).toBeInstanceOf(SwitchesNotAppliedError);
    const err = await queued;
    expect(err instanceof Error && err.name === "SwitchesNotAppliedError").toBe(true);
    expect(methods(d.frames)).not.toContain(Method.Enqueue);
    expect(methods(d.frames)).not.toContain(Method.Prompt);
  });
});
