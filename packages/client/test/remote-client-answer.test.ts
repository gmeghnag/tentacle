/**
 * docs/feat/mobile-notifications.md Design 5 / slice N1: an answer given from a
 * NOTIFICATION. The phone never gets a second session path: it attaches the
 * session on the computer's ONE link (which replays the pending ask) and settles
 * that ask by id — the same keyed `session/resolve_permission` the sheet sends,
 * with no broker requester involved.
 *
 * (a) is the plan's load-bearing property, and it is a PIN, not a red test: the
 * wire order (the replay frames are written before `open`'s result) is what
 * makes it true, and it holds on the unfixed code — it was proved by the
 * slice's scratch probe first, and it is pinned here so a future reorder of
 * `Connection.open` / `attachSession` cannot break the notification path
 * silently.
 *
 * Every other test names the mutation that turns it red (AGENTS §9).
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionResponse,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import {
  JsonRpcErrorCode,
  type KnownSessionUpdateParams,
  PROTOCOL_VERSION,
  type PermissionRequestUpdate,
} from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { DomainErrorCode, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { notificationAnswerOutcome } from "../src/permission-map.ts";
import { RemoteClient } from "../src/remote-client.ts";
import { SessionLostError } from "../src/session-lost.ts";
import { cutLink } from "./support/link-cutter.ts";

/** Drain microtasks only: the in-memory channel and the agent loop never need a timer. */
async function flush(rounds = 400): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

const call = (id: string, command: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "shell", arguments: JSON.stringify({ command }) },
});

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  /** Every session asks once, then ends its turn. */
  constructor(private readonly commands: readonly string[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    const command = this.commands[this.turn++];
    if (command !== undefined) {
      yield call(`c-${this.turn}`, command);
    }
    yield { type: "done" };
  }
}

interface RigOptions {
  readonly commands: readonly string[];
  /** The phone's requester: what the broker "shows" (a never-answered prompt by default). */
  readonly requester?: (
    req: PermissionRequest,
    options?: PermissionRequestOptions,
  ) => Promise<PermissionResponse>;
}

/**
 * A real daemon (a `SessionHost` with a scripted model that asks), a DAEMON-side
 * peer that opens and prompts, and the PHONE's `RemoteClient` on its own link.
 */
async function rig(opts: RigOptions) {
  const execs: string[] = [];
  const env = {
    id: "rec",
    async exec(command: string) {
      execs.push(command);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
  } as unknown as ExecutionEnvironment;
  const host = new SessionHost({
    defaultCwd: "/tmp/remote-client-answer",
    createAgent: () => {
      const permissions = new PermissionBroker();
      return {
        agent: new Agent({
          model: new ScriptedProvider(opts.commands),
          tools: new ToolRegistry().register(shellTool),
          env,
          requestPermission: (req, options) => permissions.request(req, options),
        }),
        permissions,
      };
    },
  });
  const connect = () => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    return c;
  };

  // The daemon-side peer: it creates the session, prompts, and sees the updates.
  const daemonCh = connect();
  const updates: KnownSessionUpdateParams[] = [];
  const daemonSide = new RpcPeer(daemonCh, {
    onNotification: (method, params) => {
      if (method === "session/update") {
        updates.push(params as KnownSessionUpdateParams);
      }
    },
  });
  await daemonSide.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  const open = (sessionId: string): Promise<unknown> =>
    daemonSide.request("session/open", { sessionId, create: true });
  const prompt = (sessionId: string, turnId: string): Promise<unknown> =>
    daemonSide.request("session/prompt", {
      sessionId,
      turnId,
      content: [{ type: "text", text: "go" }],
    });
  const asks = (): PermissionRequestUpdate[] =>
    updates
      .map((u) => u.update)
      .filter((u): u is PermissionRequestUpdate => u.type === "permission_request");
  const resolved = () =>
    updates.map((u) => u.update).filter((u) => u.type === "permission_resolved");

  // The phone: ONE link, a broker holding every prompt (no requester answer).
  const asked: string[] = [];
  const aborted: string[] = [];
  const broker = new PermissionBroker(
    opts.requester ??
      ((req, options) =>
        new Promise<PermissionResponse>((resolve) => {
          asked.push(req.detail ?? req.title);
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted.push(req.detail ?? req.title);
              resolve({ allowed: false, dismissed: true });
            },
            { once: true },
          );
        })),
  );
  const errors: Error[] = [];
  const client = new RemoteClient(connect(), broker, undefined, {
    onError: (e) => errors.push(e),
  });
  await client.initialize();
  const attach = (sessionId: string): Promise<string> =>
    client.attachSession(sessionId, { output() {}, recovered() {}, linkClosed() {} });
  return {
    host,
    execs,
    client,
    broker,
    asked,
    aborted,
    errors,
    open,
    prompt,
    asks,
    resolved,
    attach,
    close: () => {
      client.close();
      daemonSide.close();
    },
  };
}

/** A fake daemon: it answers `session/resolve_permission` however a test wants. */
async function fakeDaemon(
  resolveWith: (params: unknown) => unknown = () => ({}),
  options: readonly { optionId: string; name: string; kind: string }[] = [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ],
) {
  const [daemonCh, clientCh] = createChannelPair();
  const resolves: unknown[] = [];
  const frames: string[] = [];
  // Record what the CLIENT writes: "zero frames" is one of the assertions.
  const recording = {
    send: (data: string) => {
      frames.push(data);
      clientCh.send(data);
    },
    close: () => clientCh.close(),
    setOnMessage: (handler: (data: string) => void) => clientCh.setOnMessage(handler),
    setOnClose: (handler: () => void) => clientCh.setOnClose(handler),
  };
  let seq = 0;
  const daemon = new RpcPeer(daemonCh, {
    onRequest: async (method: string, params: unknown) => {
      if (method === "initialize") {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
        };
      }
      if (method === "session/open") {
        return { sessionId: "s1", epoch: "e", created: true, resync: false };
      }
      if (method === "session/resolve_permission") {
        resolves.push(params);
        return resolveWith(params);
      }
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
    },
  });
  const client = new RemoteClient(
    recording,
    // A HOLDING requester: the rig is a phone whose screen is elsewhere, so the
    // ask must stay pending for the answer under test (the default broker would
    // auto-approve it, proving nothing).
    new PermissionBroker(
      (_req, opts) =>
        new Promise((resolve) => {
          opts?.signal?.addEventListener(
            "abort",
            () => resolve({ allowed: false, dismissed: true }),
            {
              once: true,
            },
          );
        }),
    ),
    undefined,
    { onError: () => {} },
  );
  await client.initialize();
  await client.openSession(undefined, undefined, "s1");
  const push = (update: Record<string, unknown>): Promise<void> => {
    daemon.notify("session/update", {
      sessionId: "s1",
      seq: ++seq,
      mandatory: true,
      update,
    });
    return flush();
  };
  const ask = (requestId: string, opts: Record<string, unknown> = {}) => ({
    type: "permission_request",
    requestId,
    toolCallId: "c1",
    tool: "shell",
    title: "Run a shell command",
    explanation: `cmd-${requestId}`,
    options,
    ...opts,
  });
  return { client, resolves, frames, push, ask, close: () => client.close() };
}

const answerFrames = (frames: readonly string[]): unknown[] =>
  frames
    .map((f) => JSON.parse(f) as { method?: string; params?: unknown })
    .filter((f) => f.method === "session/resolve_permission")
    .map((f) => f.params);

describe("(a) the pending ask is in the router the instant attachSession resolves", () => {
  test("a replayed permission_request reaches the broker before the attach resolves", async () => {
    // PIN (not red on the unfixed code): the load-bearing property of Design 5.
    // Breaking it: buffer the replay frames behind the open result (or resolve
    // the attach before applying them) → `asked` is empty here.
    const r = await rig({ commands: ["rm -rf build"] });
    await r.open("S");
    await r.prompt("S", "t1");
    await flush();
    const [ask] = r.asks();
    if (!ask) throw new Error("the daemon raised no ask");
    await r.attach("S");
    // NO await between the resolution and this read.
    expect(r.asked).toEqual(["rm -rf build"]);
    r.close();
  });
});

describe("(b) an answer by id travels the existing keyed session path", () => {
  test("a QUEUED ask (another session's is on screen) is answered: the daemon resolves that option", async () => {
    // Mutation: `answerById` accepts only `current` (i.e. call `answered`) → red
    // ("not-pending"), which is exactly the gap the plan records.
    const r = await rig({ commands: ["rm -rf build"] });
    // Session A is on screen and its ask is `current` (never answered).
    await r.open("A");
    await r.prompt("A", "ta");
    await flush();
    const [askA] = r.asks();
    if (!askA) throw new Error("no ask for A");
    await r.attach("A");
    expect(r.asked).toEqual(["rm -rf build"]);
    // Session B's ask arrives while A's is still on screen: it QUEUES.
    await r.open("B");
    await r.prompt("B", "tb");
    await flush();
    const askB = r.asks().find((a) => a.requestId !== askA.requestId);
    if (!askB) throw new Error("no ask for B");
    await r.attach("B");
    expect(r.asked).toEqual(["rm -rf build"]);
    // The notification's answer for B — the queued one.
    expect(
      await r.client.answerPermission("B", askB.requestId, { allowed: true, scope: "once" }),
    ).toBe("sent");
    await flush();
    expect(r.execs).toEqual(["rm -rf build"]);
    expect(r.resolved()).toEqual([
      {
        type: "permission_resolved",
        requestId: askB.requestId,
        outcome: { outcome: "selected", optionId: "allow_once" },
      },
    ]);
    expect(r.errors).toEqual([]);
    // B's ask is gone from the router too: a second answer is not sent.
    expect(await r.client.answerPermission("B", askB.requestId, { allowed: false })).toBe(
      "not-pending",
    );
    r.close();
  });
});

describe("(c) answering the CURRENT ask by id withdraws the open prompt", () => {
  test("the broker's prompt is aborted; its late DISMISSED sends nothing", async () => {
    // Mutation: omit the `abort` action from `answerById` → the prompt stays on
    // screen after the answer (and would offer a second, losing answer).
    const r = await rig({ commands: ["rm -rf build"] });
    await r.open("S");
    await r.prompt("S", "t1");
    await flush();
    const [ask] = r.asks();
    if (!ask) throw new Error("no ask");
    await r.attach("S");
    expect(r.asked).toEqual(["rm -rf build"]);
    expect(
      await r.client.answerPermission("S", ask.requestId, { allowed: true, scope: "once" }),
    ).toBe("sent");
    // The open prompt was withdrawn (the person stopped being asked)…
    expect(r.aborted).toEqual(["rm -rf build"]);
    await flush();
    // …and its DISMISSED — which lands after the answer — sent nothing.
    expect(r.execs).toEqual(["rm -rf build"]);
    expect(r.resolved()).toHaveLength(1);
    r.close();
  });
});

describe("(d)-(g) what a notification's answer reports", () => {
  test("(d) an unknown requestId: not-pending, zero frames", async () => {
    // Mutation: send anyway → a frame appears (and the daemon would report
    // PermissionNotPending for it, which the phone shows as "already answered"
    // only by luck).
    const f = await fakeDaemon();
    await f.push(f.ask("r1"));
    expect(await f.client.answerPermission("s1", "nope", { allowed: true, scope: "once" })).toBe(
      "not-pending",
    );
    await flush();
    expect(f.resolves).toEqual([]);
    f.close();
  });

  test("(e) an option the request did not offer: unoffered, nothing sent, the ask stays", async () => {
    // Mutation: skip the offered-option check → a frame goes out with
    // `allow_once` (the daemon answers InvalidParams and the phone says the
    // wrong thing).
    const f = await fakeDaemon(undefined, [
      { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
    ]);
    await f.push(f.ask("r1"));
    expect(await f.client.answerPermission("s1", "r1", { allowed: true, scope: "once" })).toBe(
      "unoffered",
    );
    await flush();
    expect(f.resolves).toEqual([]);
    // Still pending here: a scope-less refusal is not offered either; the
    // request was NOT consumed — the sheet (or a later tap) can still answer it.
    expect(await f.client.answerPermission("s1", "r1", { allowed: true, scope: "session" })).toBe(
      "sent",
    );
    await flush();
    expect(f.resolves).toEqual([{ sessionId: "s1", requestId: "r1", optionId: "allow_always" }]);
    f.close();
  });

  test("(f) a reply where the daemon offered none: unreplyable, nothing sent", async () => {
    // Mutation: send the refusal bare (stripping the message) → red, because the
    // daemon never gets a decision on this file's watch: the person's words must
    // never be silently dropped (docs/feat/permission-reply.md).
    const f = await fakeDaemon();
    await f.push(f.ask("r1"));
    expect(
      await f.client.answerPermission("s1", "r1", { allowed: false, message: "why not?" }),
    ).toBe("unreplyable");
    await flush();
    expect(f.resolves).toEqual([]);
    f.close();
  });

  test("(g) the daemon says not-pending (answered elsewhere meanwhile): not-pending, no error", async () => {
    // Mutation: report PermissionNotPending as `failed` (or as an error) → red:
    // another device winning is not a failure of this phone.
    const f = await fakeDaemon(() => {
      throw new RpcError(DomainErrorCode.PermissionNotPending, "permission request not pending");
    });
    await f.push(f.ask("r1"));
    expect(await f.client.answerPermission("s1", "r1", { allowed: false })).toBe("not-pending");
    expect(f.resolves).toHaveLength(1);
    f.close();
  });

  test("(g2) a real failure is `failed` and the request is offered again by a replay", async () => {
    // Mutation: leave the request in `answeredIds` after a failed send → the
    // replayed ask prompts nothing (a stuck turn).
    const asked: string[] = [];
    const [daemonCh, clientCh] = createChannelPair();
    let seq = 0;
    let failure: unknown = new RpcError(JsonRpcErrorCode.InternalError, "boom");
    const daemon = new RpcPeer(daemonCh, {
      onRequest: async (method: string) => {
        if (method === "initialize") {
          return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { tools: true } };
        }
        if (method === "session/open") {
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        }
        if (method === "session/resolve_permission") {
          if (failure) throw failure;
          return {};
        }
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
      },
    });
    const errors: Error[] = [];
    const broker = new PermissionBroker(
      (req, opts) =>
        new Promise((resolve) => {
          asked.push(req.detail ?? "");
          opts?.signal?.addEventListener(
            "abort",
            () => resolve({ allowed: false, dismissed: true }),
            {
              once: true,
            },
          );
        }),
    );
    const client = new RemoteClient(clientCh, broker, undefined, {
      onError: (e) => errors.push(e),
    });
    await client.initialize();
    await client.openSession(undefined, undefined, "s1");
    const push = (update: Record<string, unknown>): Promise<void> => {
      daemon.notify("session/update", { sessionId: "s1", seq: ++seq, mandatory: true, update });
      return flush();
    };
    await push({
      type: "permission_request",
      requestId: "r1",
      toolCallId: "c1",
      tool: "shell",
      title: "Run a shell command",
      explanation: "rm -rf build",
      options: [{ optionId: "reject_once", name: "Deny", kind: "reject_once" }],
    });
    expect(await client.answerPermission("s1", "r1", { allowed: false })).toBe("failed");
    // Not reported to `onError` too: the notification path tells the PERSON
    // (Design 4 step 5) — the outcome IS the report, and a background action has
    // no error surface.
    expect(errors).toEqual([]);
    failure = null;
    // A re-attach replays the ask: this client must offer it again (it may still
    // be pending daemon-side).
    await push({
      type: "permission_request",
      requestId: "r1",
      toolCallId: "c1",
      tool: "shell",
      title: "Run a shell command",
      explanation: "rm -rf build",
      options: [{ optionId: "reject_once", name: "Deny", kind: "reject_once" }],
    });
    expect(asked).toEqual(["rm -rf build", "rm -rf build"]);
    client.close();
  });
});

describe("(i) the link dies mid-answer", () => {
  /**
   * The phone's link, cut on demand, over a daemon that CREATES the session and
   * prompts. Returns the client, the ask's id and the drop's controls.
   */
  async function cutRig() {
    /** Which daemon a (re)connect lands on: a test can swap it for a restarted one. */
    const land: { get: () => SessionHost } = { get: () => host };
    const makeHost = (): SessionHost =>
      new SessionHost({
        defaultCwd: "/tmp/remote-client-answer-cut",
        createAgent: () => {
          const permissions = new PermissionBroker();
          return {
            agent: new Agent({
              model: new ScriptedProvider(["rm -rf build"]),
              tools: new ToolRegistry().register(shellTool),
              env: {
                id: "rec",
                async exec() {
                  return { stdout: "ok", stderr: "", exitCode: 0 };
                },
                async readFile() {
                  return "";
                },
                async writeFile() {},
              } as unknown as ExecutionEnvironment,
              requestPermission: (req, options) => permissions.request(req, options),
            }),
            permissions,
          };
        },
      });
    const host = makeHost();
    const [dc, cc] = createChannelPair();
    new Connection(dc, host);
    let requestId: string | undefined;
    const creator = new RpcPeer(cc, {
      onNotification: (method, params) => {
        const update = (params as { update?: { type?: string; requestId?: string } }).update;
        if (method === "session/update" && update?.type === "permission_request") {
          requestId = update.requestId;
        }
      },
    });
    await creator.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    await creator.request("session/open", { sessionId: "S", create: true });
    await creator.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    await flush();
    if (!requestId) throw new Error("the daemon raised no ask");
    const id = requestId;
    /** A reconnect: a fresh channel onto whichever daemon `land` now names. */
    const dial = (): ReturnType<typeof createChannelPair>[1] => {
      const pair = createChannelPair();
      new Connection(pair[0], land.get());
      return pair[1];
    };
    const link = cutLink(3); // initialize, session/open, session/resolve_permission
    new Connection(link.daemon, host);
    const client = new RemoteClient(
      link.client,
      new PermissionBroker(
        (_req, opts) =>
          new Promise((resolve) => {
            opts?.signal?.addEventListener(
              "abort",
              () => resolve({ allowed: false, dismissed: true }),
              { once: true },
            );
          }),
      ),
      undefined,
      { channelFactory: async () => dial() },
    );
    await client.initialize();
    await client.attachSession("S", { output() {}, recovered() {}, linkClosed() {} });
    return {
      client,
      id,
      link,
      land,
      host,
      makeHost,
      close: () => {
        client.close();
        creator.close();
      },
    };
  }

  test("a plain drop re-sends the KEYED answer on the new link: `sent` (idempotent)", async () => {
    // The daemon takes a re-send of the answer that settled it as a success
    // (first-wins), so a drop is not reported as a loss. Mutation: make
    // `sendAnswer` `once` instead of `keyed` → a drop reports `failed` and the
    // phone would nag "tap to answer" for an ask that IS answered.
    const r = await cutRig();
    r.link.arm();
    expect(await r.client.answerPermission("S", r.id, { allowed: true, scope: "once" })).toBe(
      "sent",
    );
    expect(r.link.cut()).toBe(true);
    r.close();
  });
});

describe("(i2) a failed send's meaning (pure)", () => {
  test("not-pending / session-lost / failed, never merged", () => {
    // Mutation: map SessionLostError to `sent` (or to `failed`) → red: after a
    // recreate the answer reached a session no ask was raised in, so the person
    // must be told "it may have been sent" (F2), not "approved" and not "it
    // failed" (which would invite a pointless retry).
    expect(
      notificationAnswerOutcome(
        new RpcError(DomainErrorCode.PermissionNotPending, "permission request not pending"),
      ),
    ).toBe("not-pending");
    expect(notificationAnswerOutcome(new SessionLostError())).toBe("session-lost");
    expect(notificationAnswerOutcome(new RpcError(JsonRpcErrorCode.InternalError, "boom"))).toBe(
      "failed",
    );
    expect(notificationAnswerOutcome(new Error("socket gone"))).toBe("failed");
  });
});
