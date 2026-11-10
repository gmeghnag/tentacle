/**
 * feat/subagent-panel (task 7) client half: `messageSubagent` / `killSubagent`
 * on the ONE session path (AGENTS §7), and the `subagent_message` update —
 * bounded here, because a pod's daemon is not trusted — routed to its session's
 * listeners only, and producing no turn event (`mapping.ts`).
 */
import { describe, expect, test } from "bun:test";
import { Agent, Session } from "@tentacle/agent";
import {
  AgentJobs,
  type BackgroundJob,
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { JsonRpcErrorCode, Method, RequestSchemas } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcError } from "@tentacle/transport";
import { createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";
import { boundSubagentMessage } from "../src/subagents.ts";

const noopEnv = {
  id: "noop",
  exec() {
    throw new Error("unused");
  },
} as unknown as ExecutionEnvironment;

const quiet: ModelProvider = {
  id: "quiet",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "done" };
  },
};

class FakeJobs implements JobController {
  start(): BackgroundJob {
    throw new Error("unused");
  }
  read(): undefined {
    return undefined;
  }
  kill(): boolean {
    return false;
  }
  list(): readonly BackgroundJob[] {
    return [];
  }
  dispose(): void {}
  onStart(): () => void {
    return () => {};
  }
  onExit(): () => void {
    return () => {};
  }
}

function rig() {
  const jobs = new FakeJobs();
  const runtimes: AgentJobs[] = [];
  const host = new SessionHost({
    defaultCwd: "/tmp/subagent-panel-client",
    createAgent: () => {
      const agentJobs = new AgentJobs(4);
      runtimes.push(agentJobs);
      return {
        agent: new Agent({
          model: quiet,
          tools: new ToolRegistry(),
          env: noopEnv,
          jobs,
          agentJobs,
        }),
        permissions: new PermissionBroker(),
        jobs,
        agentJobs,
      };
    },
  });
  const clients: RemoteClient[] = [];
  const dial = () => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    return c;
  };
  const client = new RemoteClient(dial(), new PermissionBroker(), undefined, {
    channelFactory: async () => dial(),
    random: () => 0,
  });
  clients.push(client);
  const sid = () =>
    [...(host as unknown as { sessions: Map<string, unknown> }).sessions.keys()][0] ?? "";
  return {
    runtimes,
    client,
    sid,
    host,
    close: () => {
      for (const c of clients) c.close();
    },
  };
}

const drain = async (events: AsyncIterable<unknown>): Promise<void> => {
  for await (const _event of events) {
    // drain
  }
};

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A session with sa-1 started and running (held by its own promise). */
async function withChild(r: ReturnType<typeof rig>) {
  await r.client.initialize();
  const session = r.client.newSession();
  const turnDone = drain(session.send("hello"));
  await until(() => r.sid() !== "");
  const runtime = r.runtimes[0];
  if (runtime === undefined) throw new Error("no runtime");
  const stopped = Promise.withResolvers<void>();
  runtime.start(
    { callId: "c1", agentType: "general", description: "map repo" },
    async (ctl) =>
      new Promise((resolve) => {
        ctl.signal.addEventListener("abort", () =>
          resolve({ report: "", toolUses: 0, stopReason: "cancelled" }),
        );
      }),
  );
  await until(() => runtime.rows().length === 1);
  return { session, turnDone, runtime, stopped };
}

describe("T-C1: the two methods on the session path", () => {
  test("messageSubagent resolves `{ok: true}` and the update reaches onSubagentMessage", async () => {
    const r = rig();
    const { session, turnDone, stopped } = await withChild(r);
    const seen: { agentId: string; text: string }[] = [];
    session.onSubagentMessage((n) => seen.push(n));
    expect(await session.messageSubagent("sa-1", "skip the tests folder")).toEqual({ ok: true });
    await until(() => seen.length > 0);
    expect(seen.at(-1)?.agentId).toBe("sa-1");
    expect(seen.at(-1)?.text).toBe("skip the tests folder");
    // A refusal is a typed RESULT, never a throw at the TUI.
    expect((await session.messageSubagent("sa-9", "hi")).ok).toBe(false);
    stopped.resolve();
    await turnDone;
    r.close();
  });

  test("killSubagent answers `{killed}` (the same decision as the model's tool)", async () => {
    const r = rig();
    const { session, turnDone, stopped } = await withChild(r);
    expect(await session.killSubagent("sa-1")).toEqual({ killed: true });
    stopped.resolve();
    await until(() => (r.runtimes[0]?.rows().length ?? 0) === 0);
    expect(await session.killSubagent("sa-1")).toEqual({ killed: false });
    await turnDone;
    r.close();
  });

  test("MethodNotFound → a typed refusal, never thrown at the TUI", async () => {
    // An OLDER daemon: the method is not in its registry.
    const client = new RemoteClient(
      {
        send() {},
        close() {},
        setOnMessage() {},
        setOnClose() {},
      } as never,
      new PermissionBroker(),
    );
    const call = (
      client as unknown as { call(p: unknown, m: string, a: unknown): Promise<unknown> }
    ).call.bind(client);
    (client as unknown as { call: (p: unknown, m: string, a: unknown) => Promise<unknown> }).call =
      (_p, method, _a) =>
        method === Method.SubagentMessage
          ? Promise.reject(new RpcError(JsonRpcErrorCode.MethodNotFound, "no such method"))
          : call(_p, method, _a);
    const result = await client.messageSubagent("s1", "sa-1", "hi");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("older version");
    client.close();
  });
});

describe("T-C2: the update is bounded, and only its own session's listeners see it", () => {
  test("boundSubagentMessage strips control characters but keeps newlines, and caps both fields", () => {
    const clean = boundSubagentMessage({ agentId: "sa-1", text: "ok" });
    expect(clean).toEqual({ agentId: "sa-1", text: "ok" });
    const hostile = boundSubagentMessage({
      agentId: `sa-1\n${"y".repeat(200)}`,
      text: "line one\nline two\u001b[31m red",
    });
    expect(hostile.agentId.length).toBeLessThanOrEqual(64);
    expect(hostile.agentId).not.toContain("\n");
    // An escape never reaches the terminal; a newline is prose and is kept.
    expect(hostile.text).toBe("line one\nline two [31m red");
    const long = boundSubagentMessage({ agentId: "sa-1", text: "z".repeat(20_000) });
    expect(long.text).toHaveLength(8000);
    expect(long.text.endsWith("…")).toBe(true);
  });

  test("its own session's listener only; no event, no turn (mapping returns null)", async () => {
    const r = rig();
    const { session, turnDone, stopped } = await withChild(r);
    const mine: string[] = [];
    const other: string[] = [];
    session.onSubagentMessage((n) => mine.push(n.text));
    r.client.onSessionSubagentMessage((notice) => {
      if (notice.sessionId !== r.sid()) other.push(notice.text);
    });
    await session.messageSubagent("sa-1", "only mine");
    await until(() => mine.length > 0);
    expect(mine).toEqual(["only mine"]);
    expect(other).toEqual([]);
    stopped.resolve();
    await turnDone;
    r.close();
  });

  test("the protocol's registry validates the frame the client routes (a wire-level check)", () => {
    expect(
      RequestSchemas[Method.SubagentMessage].result.safeParse({ ok: false, reason: "x" }).success,
    ).toBe(true);
  });
});

/** The session object the controller returns carries the two methods (the seam the TUI uses). */
describe("the session controller's surface", () => {
  test("a RemoteSession has messageSubagent / killSubagent / onSubagentMessage", async () => {
    const r = rig();
    await r.client.initialize();
    const session = r.client.newSession();
    expect(typeof session.messageSubagent).toBe("function");
    expect(typeof session.killSubagent).toBe("function");
    expect(typeof session.onSubagentMessage).toBe("function");
    // And the LOCAL session (an in-process Agent) does not: the TUI's optional
    // methods are exactly why the panel refuses there instead of guessing.
    expect(Session.prototype).not.toHaveProperty("messageSubagent");
    r.close();
  });
});
