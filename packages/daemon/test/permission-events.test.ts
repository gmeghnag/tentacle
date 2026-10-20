import { afterEach, describe, expect, jest, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type PermissionResponse,
  type StreamEvent,
} from "@tentacle/core";
import {
  JsonRpcErrorCode,
  type KnownSessionUpdateParams,
  type OpenResult,
  PROTOCOL_VERSION,
  type PermissionRequestUpdate,
  type SessionUpdate,
} from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { DomainErrorCode, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { SessionHost } from "../src/session-host.ts";

// Permissions as session state (docs/feat/permission-events.md): a pending ask
// is a `permission_request` event, answered by `session/resolve_permission`
// from any client that opened the session; first answer wins; no timeout; a
// cancel settles it. Each test names the mutation that turns it red (AGENTS §9).

// Bun ≥ 1.4 implements fake timers; the pinned `bun-types` (1.1.x) does not declare them.
const timers = jest as unknown as {
  useFakeTimers(): void;
  useRealTimers(): void;
  advanceTimersByTime(ms: number): void;
};
const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };
const H = 60 * 60 * 1000;
/** Drain microtasks only: the in-memory channel and the agent loop never need a timer. */
async function flush(rounds = 300): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

const call = (id: string, command: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "shell", arguments: JSON.stringify({ command }) },
});

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    for (const event of this.script[this.turn++] ?? [{ type: "done" }]) yield event;
  }
}

/** The daemon-side broker, logging what its GATE receives back from the requester. */
class DaemonBrokerSpy extends PermissionBroker {
  readonly log: string[] = [];
  override async request(req: PermissionRequest): Promise<PermissionResponse> {
    const r = await super.request(req);
    this.log.push(`${req.detail} -> ${JSON.stringify(r)}`);
    return r;
  }
}

function daemon(script: readonly (readonly StreamEvent[])[]) {
  const execs: string[] = [];
  const env: ExecutionEnvironment = {
    id: "rec",
    async exec(command) {
      execs.push(command);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
  };
  const clock = { t: 0 };
  const brokers: DaemonBrokerSpy[] = [];
  const host = new SessionHost({
    defaultCwd: "/tmp/permission-events",
    now: () => clock.t,
    createAgent: () => {
      const permissions = new DaemonBrokerSpy();
      brokers.push(permissions);
      const agent = new Agent({
        model: new ScriptedProvider(script),
        tools: new ToolRegistry().register(shellTool),
        env,
        requestPermission: (req) => permissions.request(req),
      });
      return { agent, permissions };
    },
  });
  const connect = async () => {
    const [d, c] = createChannelPair();
    const connection = new Connection(d, host);
    const updates: KnownSessionUpdateParams[] = [];
    const inbound: string[] = [];
    const client = new RpcPeer(c, {
      onNotification: (method, params) => {
        if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
      },
      onRequest: async (method) => {
        inbound.push(method);
        throw new Error(`unexpected request ${method}`);
      },
    });
    await client.request("initialize", INIT);
    const open = (params: Record<string, unknown>) =>
      client.request("session/open", params) as Promise<OpenResult>;
    const prompt = (sessionId: string, turnId: string) =>
      client.request("session/prompt", {
        sessionId,
        turnId,
        content: [{ type: "text", text: "go" }],
      });
    const resolve = (sessionId: string, requestId: string, optionId: string) =>
      client.request("session/resolve_permission", { sessionId, requestId, optionId });
    const of = <T extends SessionUpdate["type"]>(type: T) =>
      updates
        .map((u) => u.update)
        .filter((u): u is Extract<SessionUpdate, { type: T }> => u.type === type);
    return { connection, client, updates, inbound, open, prompt, resolve, of };
  };
  return { host, execs, brokers, clock, connect };
}

const types = (updates: readonly KnownSessionUpdateParams[]) => updates.map((u) => u.update.type);

function onlyRequest(requests: readonly PermissionRequestUpdate[]): PermissionRequestUpdate {
  expect(requests).toHaveLength(1);
  const [r] = requests;
  if (!r) throw new Error("no permission_request");
  return r;
}

const ask = [[call("c1", "rm -rf build"), { type: "done" }], [{ type: "done" }]] as const;

afterEach(() => {
  timers.useRealTimers();
});

describe("permission requests are session events", () => {
  test("T1 an ask streams one permission_request; the decision travels only through resolve_permission", async () => {
    // Mutation: keep the daemon→client request → `inbound` is non-empty and no event.
    const d = daemon(ask);
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    const req = onlyRequest(a.of("permission_request"));
    expect(req).toMatchObject({ toolCallId: "c1", tool: "shell", explanation: "rm -rf build" });
    expect(req.requestId).not.toBe("");
    expect(req.options.map((o) => o.optionId)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
    ]);
    expect(a.inbound).toEqual([]);
    expect(d.execs).toEqual([]);
    expect(d.host.get("S")?.running).toBe(true);

    expect(await a.resolve("S", req.requestId, "allow_once")).toEqual({});
    await flush();
    expect(d.execs).toEqual(["rm -rf build"]);
    expect(a.of("permission_resolved")).toEqual([
      {
        type: "permission_resolved",
        requestId: req.requestId,
        outcome: { outcome: "selected", optionId: "allow_once" },
      },
    ]);
    // Resolved before anything of the tool's execution, and the turn ends normally.
    const t = types(a.updates);
    expect(t.indexOf("permission_resolved")).toBeLessThan(t.indexOf("tool_call_update"));
    expect(a.of("turn_end")).toMatchObject([{ turnId: "t1", stopReason: "end_turn" }]);
  });

  test("T1b a shell prefix suggestion travels with the request", async () => {
    const d = daemon([[call("c1", "git status -s"), { type: "done" }], [{ type: "done" }]]);
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    expect(onlyRequest(a.of("permission_request")).suggestion).toEqual({ prefix: "git status" });
  });

  test("T1c a denial blocks the tool; the turn ends normally and the history says denied", async () => {
    const d = daemon(ask);
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    await a.resolve("S", onlyRequest(a.of("permission_request")).requestId, "reject_once");
    await flush();
    expect(d.execs).toEqual([]);
    expect(a.of("turn_end")).toMatchObject([{ stopReason: "end_turn" }]);
    const tool = d.host
      .get("S")
      ?.snapshotPage()
      .messages.find((m) => m.role === "tool");
    expect(tool?.content).toContain("Permission denied by the user");
  });
});

describe("no timeout, no daemon-originated deny", () => {
  test("T2 a request pending for 24 h is still pending, then approvable", async () => {
    // Mutation: settle `cancelled` from a 5-minute `setTimeout` in the requester → red.
    timers.useFakeTimers();
    const d = daemon(ask);
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    const req = onlyRequest(a.of("permission_request"));
    timers.advanceTimersByTime(24 * H);
    await flush();
    expect(a.of("permission_resolved")).toEqual([]);
    expect(d.brokers[0]?.log).toEqual([]);
    expect(d.execs).toEqual([]);
    expect(d.host.get("S")?.running).toBe(true);
    await a.resolve("S", req.requestId, "allow_once");
    await flush();
    expect(d.execs).toEqual(["rm -rf build"]);
  });

  test("T3 the only client's socket drops: no deny; a client that opens later is replayed the request and answers it", async () => {
    // Red on main (experiment E2): the drop became {allowed:false}.
    // Mutation: settle `cancelled` in `Connection.close()` / on detach → red.
    const d = daemon(ask);
    const a = await d.connect();
    const { epoch } = await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    const req = onlyRequest(a.of("permission_request"));
    a.connection.close();
    await flush();
    expect(d.brokers[0]?.log).toEqual([]);
    expect(d.host.get("S")?.running).toBe(true);

    // Three ways back: a fresh open (resync), a `since` before the request, and
    // a `since` from another epoch — each replays the pending request.
    for (const since of [undefined, { epoch, seq: 0 }, { epoch: "other", seq: 0 }]) {
      const b = await d.connect();
      await b.open({ sessionId: "S", ...(since ? { since } : {}) });
      expect(b.of("permission_request").map((r) => r.requestId)).toEqual([req.requestId]);
      b.connection.close();
    }
    const c = await d.connect();
    await c.open({ sessionId: "S" });
    await c.resolve("S", req.requestId, "allow_once");
    await flush();
    expect(d.execs).toEqual(["rm -rf build"]);
    expect(c.of("turn_end")).toMatchObject([{ stopReason: "end_turn" }]);
  });

  test("T3b nobody attached when the ask is raised: no deny, the turn waits for a client", async () => {
    // Red on main (experiment E2b, the registry's interim routing): denied at once.
    const d = daemon([
      [{ type: "text", delta: "thinking" }, call("c1", "make deploy"), { type: "done" }],
      [{ type: "done" }],
    ]);
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    a.connection.close();
    await flush();
    expect(d.brokers[0]?.log).toEqual([]);
    expect(d.execs).toEqual([]);
    expect(d.host.get("S")?.running).toBe(true);
    const b = await d.connect();
    await b.open({ sessionId: "S" });
    await b.resolve("S", onlyRequest(b.of("permission_request")).requestId, "allow_once");
    await flush();
    expect(d.execs).toEqual(["make deploy"]);
  });
});

describe("first answer wins; nonces never rebind", () => {
  test("T4 two clients answer: the first wins, the second gets PermissionNotPending, both see one permission_resolved", async () => {
    // Mutation: look up without deleting from the pending table → the second
    // answer also "succeeds" (and resolves an already-settled promise) → red.
    const d = daemon(ask);
    const a = await d.connect();
    const b = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await b.open({ sessionId: "S" });
    await a.prompt("S", "t1");
    await flush();
    const req = onlyRequest(a.of("permission_request"));
    expect(b.of("permission_request").map((r) => r.requestId)).toEqual([req.requestId]);
    const first = a.resolve("S", req.requestId, "allow_once");
    const second = b.resolve("S", req.requestId, "reject_once");
    expect(await first).toEqual({});
    await expect(second).rejects.toMatchObject({ code: DomainErrorCode.PermissionNotPending });
    await flush();
    const resolved = {
      type: "permission_resolved" as const,
      requestId: req.requestId,
      outcome: { outcome: "selected" as const, optionId: "allow_once" },
    };
    expect(a.of("permission_resolved")).toEqual([resolved]);
    expect(b.of("permission_resolved")).toEqual([resolved]);
    expect(d.execs).toEqual(["rm -rf build"]);
  });

  test("T4b two answers in the same tick: exactly one wins", async () => {
    // Mutation: an `await` between the lookup and the delete → both win → red.
    const d = daemon(ask);
    const sink: KnownSessionUpdateParams[] = [];
    const { hosted } = d.host.open({ sessionId: "S", create: true }, { send: (u) => sink.push(u) });
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await flush();
    const req = sink.map((u) => u.update).find((u) => u.type === "permission_request");
    if (req?.type !== "permission_request") throw new Error("no request");
    hosted.resolvePermission(req.requestId, "allow_once");
    expect(() => hosted.resolvePermission(req.requestId, "reject_once")).toThrow(
      expect.objectContaining({ code: DomainErrorCode.PermissionNotPending }),
    );
    await flush();
    expect(sink.filter((u) => u.update.type === "permission_resolved")).toHaveLength(1);
    expect(d.execs).toEqual(["rm -rf build"]);
  });

  test("T5 a late answer to a cancelled turn's request never binds to the next request for the same tool call id", async () => {
    // Mutation: `requestId = toolCallId` → the late answer approves R2 → red.
    const d = daemon([
      [call("c1", "rm -rf build"), { type: "done" }],
      [call("c1", "rm -rf build"), { type: "done" }],
      [{ type: "done" }],
    ]);
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    const r1 = onlyRequest(a.of("permission_request"));
    a.client.notify("session/cancel", { sessionId: "S" });
    await flush();
    expect(a.of("turn_end")).toMatchObject([{ turnId: "t1", stopReason: "cancelled" }]);
    await a.prompt("S", "t2");
    await flush();
    const r2 = a.of("permission_request")[1];
    expect(r2?.toolCallId).toBe("c1");
    expect(r2?.requestId).not.toBe(r1.requestId);
    await expect(a.resolve("S", r1.requestId, "allow_once")).rejects.toMatchObject({
      code: DomainErrorCode.PermissionNotPending,
    });
    await flush();
    expect(d.execs).toEqual([]);
    expect(d.host.get("S")?.running).toBe(true);
  });
});

describe("a cancel or a close settles the request", () => {
  test("T6 session/cancel while pending: permission_resolved{cancelled}, then turn_end{cancelled}; the history says cancelled", async () => {
    // Red on main (experiment E3): the turn hung until someone answered.
    // Mutation: drop the abort listener → no turn_end → red.
    const d = daemon(ask);
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    const req = onlyRequest(a.of("permission_request"));
    a.client.notify("session/cancel", { sessionId: "S" });
    await flush();
    expect(a.of("permission_resolved")).toEqual([
      { type: "permission_resolved", requestId: req.requestId, outcome: { outcome: "cancelled" } },
    ]);
    expect(a.of("turn_end")).toMatchObject([{ turnId: "t1", stopReason: "cancelled" }]);
    const t = types(a.updates);
    expect(t.indexOf("permission_resolved")).toBeLessThan(t.indexOf("turn_end"));
    expect(d.execs).toEqual([]);
    const tool = d.host
      .get("S")
      ?.snapshotPage()
      .messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe("Cancelled by the user before this tool ran.");
    await expect(a.resolve("S", req.requestId, "allow_once")).rejects.toMatchObject({
      code: DomainErrorCode.PermissionNotPending,
    });
  });

  test("T6c a cancel between tool_start and the ask: nobody is prompted, the turn ends cancelled", async () => {
    // Review finding 1. Mutation: drop the `signal.aborted` early return in
    // `awaitDecision` → a request is streamed on an already-aborted turn, whose
    // abort listener never fires → the turn hangs (no turn_end) → red.
    const d = daemon(ask);
    const sink: KnownSessionUpdateParams[] = [];
    let cancel = (): void => {};
    const { hosted } = d.host.open(
      { sessionId: "S", create: true },
      {
        send: (u) => {
          sink.push(u);
          // The tool call is announced (`tool_start`), the ask not raised yet.
          if (u.update.type === "tool_call") cancel();
        },
      },
    );
    cancel = () => hosted.cancel();
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await flush();
    const kinds = sink.map((u) => u.update.type);
    expect(kinds).not.toContain("permission_request");
    expect(sink.at(-1)?.update).toMatchObject({ type: "turn_end", stopReason: "cancelled" });
    expect(d.execs).toEqual([]);
    expect(hosted.running).toBe(false);
  });

  test("T6b session/close while pending: permission_resolved{cancelled} precedes turn_end and session_closed", async () => {
    // The session-registry Review's finding 6: a closed session's dialog is withdrawn.
    const d = daemon(ask);
    const a = await d.connect();
    const b = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await b.open({ sessionId: "S" });
    await a.prompt("S", "t1");
    await flush();
    await a.client.request("session/close", { sessionId: "S" });
    await flush();
    expect(types(b.updates).slice(-3)).toEqual([
      "permission_resolved",
      "turn_end",
      "session_closed",
    ]);
    expect(b.of("permission_resolved")[0]?.outcome).toEqual({ outcome: "cancelled" });
    expect(d.execs).toEqual([]);
  });
});

describe("bad answers never decide", () => {
  test("T7 an option not offered is InvalidParams and the request stays pending; unknown request / session / not opened here are refused", async () => {
    // Mutation: map an unknown option to deny (today's `outcomeToResponse`) → red.
    const d = daemon(ask);
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    const req = onlyRequest(a.of("permission_request"));
    await expect(a.resolve("S", req.requestId, "reject_always")).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
    await expect(a.resolve("S", "no-such-request", "allow_once")).rejects.toMatchObject({
      code: DomainErrorCode.PermissionNotPending,
    });
    await expect(a.resolve("nope", req.requestId, "allow_once")).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
    // Commands need an `open` on this connection (the rule of every session command).
    const stranger = await d.connect();
    await expect(stranger.resolve("S", req.requestId, "allow_once")).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
    await flush();
    expect(a.of("permission_resolved")).toEqual([]);
    expect(d.brokers[0]?.log).toEqual([]);
    expect(d.host.get("S")?.running).toBe(true);
    await a.resolve("S", req.requestId, "allow_once");
    await flush();
    expect(d.execs).toEqual(["rm -rf build"]);
  });
});

describe("the single decision path", () => {
  test("T8 an 'allow always' from one client holds for every client of the session (daemon-side, remembered)", async () => {
    const d = daemon([
      [call("c1", "git status"), { type: "done" }],
      [call("c2", "git status -s"), { type: "done" }],
      [{ type: "done" }],
    ]);
    const a = await d.connect();
    const b = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await b.open({ sessionId: "S" });
    await a.prompt("S", "t1");
    await flush();
    await a.resolve("S", onlyRequest(a.of("permission_request")).requestId, "allow_always");
    await flush();
    expect(d.execs).toEqual(["git status", "git status -s"]);
    expect(a.of("permission_request")).toHaveLength(1);
    expect(b.of("permission_request")).toHaveLength(1);
  });

  test("T9 the requester is installed on the factory's broker (no daemon-side allowAll bypass)", async () => {
    // Mutation: `HostedSession` installs its requester on a broker of its own →
    // the agent's gate falls back to the factory broker's allowAll → the tool
    // runs with no event → red.
    const d = daemon(ask);
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    expect(a.of("permission_request")).toHaveLength(1);
    expect(d.execs).toEqual([]);
  });
});

describe("a suspended turn is a running turn", () => {
  test("T18 a suspended, detached session is not reaped after TTL + 1 h (session-ttl-limits contract)", async () => {
    const d = daemon(ask);
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    a.connection.close();
    d.clock.t += 25 * H;
    expect(d.host.reapExpired({ idleTtlMs: 24 * H })).toEqual([]);
    expect(d.host.get("S")?.running).toBe(true);
  });
});
