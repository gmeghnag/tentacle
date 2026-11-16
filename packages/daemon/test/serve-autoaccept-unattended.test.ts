/**
 * docs/fix/serve-autoaccept-unattended.md: on a `serve` daemon (the user's own
 * host) a session with auto-accept ON is answered BY THE DAEMON, so it keeps
 * running with no app or terminal attached. Every other host (a pod daemon, the
 * worker, the relay) never answers on its own (AGENTS §7). Each test names the
 * mutation that must turn it red (AGENTS §9).
 */
import { describe, expect, test } from "bun:test";
import { Agent, Session, createSubagentRunner } from "@tentacle/agent";
import {
  AgentJobs,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import {
  type KnownSessionUpdateParams,
  type OpenResult,
  PROTOCOL_VERSION,
  type PermissionRequestUpdate,
  type PermissionResolvedUpdate,
  type SessionUpdate,
} from "@tentacle/protocol";
import { ToolRegistry, createTaskTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { z } from "zod";
import { Connection } from "../src/connection.ts";
import { type Attachment, HostedSession } from "../src/hosted-session.ts";
import type { DaemonSessionRecord } from "../src/persisted-session.ts";
import { SessionHost } from "../src/session-host.ts";
import { SessionPersister } from "../src/session-persister.ts";
import { SpyDaemonStore, decodeFiles, filesOf } from "./support/daemon-store-spy.ts";

const INIT = {
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { streaming: true },
  clientInfo: { name: "tentacle", version: "1.0.0" },
};

const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick();
  }
}
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

const done: StreamEvent = { type: "done" };
const text = (delta: string): StreamEvent => ({ type: "text", delta });
const call = (id: string, name: string, args: unknown = {}): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name, arguments: JSON.stringify(args) },
});
const go = [{ type: "text" as const, text: "go" }];

/** A model that replays one scripted round per call. */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    for (const event of this.script[this.turn++] ?? [done]) yield event;
  }
}

const env = {} as ExecutionEnvironment;
const anyInput = z.object({}).passthrough();

/** A tool that counts its runs; `permission` decides whether it is asked first. */
function counted(name: string, runs: string[], permission: Tool["permission"] = "ask"): Tool {
  return {
    name,
    description: name,
    inputSchema: anyInput,
    permission,
    async execute() {
      runs.push(name);
      return { content: `${name} ok` };
    },
  };
}

interface Rig {
  host: SessionHost;
  runs: string[];
  brokers: PermissionBroker[];
}

/** A host whose one tool asks; `answers` is the serve-only trust bit. */
function rig(
  script: readonly (readonly StreamEvent[])[],
  opts: {
    answers?: boolean;
    shared?: boolean;
    runs?: string[];
    tools?: (broker: PermissionBroker, runs: string[]) => Tool[];
  } = {},
): Rig {
  const runs = opts.runs ?? [];
  const brokers: PermissionBroker[] = [];
  const model = new Scripted(script);
  const host = new SessionHost({
    defaultCwd: "/tmp/serve-autoaccept-unattended",
    ...(opts.shared === false ? {} : { sharedAutoAccept: true }),
    ...(opts.answers ? { answersAutoAccept: true } : {}),
    createAgent: () => {
      const permissions = new PermissionBroker();
      brokers.push(permissions);
      const registry = new ToolRegistry();
      for (const tool of (opts.tools ?? ((_b, r) => [counted("askme", r)]))(permissions, runs)) {
        registry.register(tool);
      }
      const agent = new Agent({
        model,
        tools: registry,
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  return { host, runs, brokers };
}

/** An in-process client: what it was sent, by stream order. */
function client(updates?: readonly string[]) {
  const frames: KnownSessionUpdateParams[] = [];
  const attachment: Attachment = {
    send: (u) => frames.push(u),
    ...(updates ? { updates } : {}),
  };
  const of = <T extends SessionUpdate["type"]>(type: T) =>
    frames
      .map((u) => u.update)
      .filter((u): u is Extract<SessionUpdate, { type: T }> => u.type === type);
  /** The asks nobody answered yet, oldest first. */
  const pending = (): PermissionRequestUpdate[] => {
    const resolved = new Set(of("permission_resolved").map((u) => u.requestId));
    return of("permission_request").filter((u) => !resolved.has(u.requestId));
  };
  return {
    attachment,
    frames,
    of,
    get asks() {
      return pending();
    },
  };
}

/** A host with one live session, attached to `c` (and prompting when asked to). */
function open(r: Rig, c: ReturnType<typeof client>) {
  const { hosted } = r.host.open({ create: true }, c.attachment);
  return hosted;
}

const priv = (hosted: HostedSession) =>
  hosted as unknown as {
    autoAnswer(requestId: string): void;
    autoAnswers(req: PermissionRequest, turnId: string | undefined): boolean;
  };

describe("U1-U3: the daemon answers an auto-accepted ask itself", () => {
  test("U1 bit on, ON, nobody attached when the ask is raised → it is answered, the tool runs once", async () => {
    // Mutation: drop the `autoAnswer` call in `awaitDecision` → the turn hangs, no run.
    const r = rig([[call("c1", "askme"), done]], { answers: true });
    const c = client();
    const hosted = open(r, c);
    hosted.setAutoAccept(true, "phone");
    hosted.prompt("T1", go);
    await until(() => !hosted.running);
    expect(r.runs).toEqual(["askme"]);
    // Every client the daemon answered for sees the SAME pair a client's own
    // auto-answer produces: request, then resolved with `allow_once`.
    const asked = c.of("permission_request");
    const resolved = c.of("permission_resolved");
    expect(asked).toHaveLength(1);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual({
      type: "permission_resolved",
      requestId: asked[0]?.requestId ?? "",
      outcome: { outcome: "selected", optionId: "allow_once" },
    } satisfies PermissionResolvedUpdate);
    // And a re-attach shows no stale prompt.
    const fresh = client();
    hosted.attach(fresh.attachment);
    expect(fresh.asks).toEqual([]);
  });

  test("U2 the WORKER shape (sharedAutoAccept, no answersAutoAccept) still waits for a client", async () => {
    // Guard (green before the fix): non-vacuity by mutation — default
    // `answersAutoAccept` to true, or key the answer on `sharedAutoAccept` → red.
    const r = rig([[call("c1", "askme"), done]]);
    const c = client();
    const hosted = open(r, c);
    hosted.setAutoAccept(true);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    await settle();
    expect(hosted.running).toBe(true);
    expect(r.runs).toEqual([]);
    expect(r.host.answersAutoAccept).toBe(false);
  });

  test("U3 bit on but the session's auto-accept OFF → it waits", async () => {
    // Guard: mutation — drop `this.autoAccept` from `autoAnswers` → red.
    const r = rig([[call("c1", "askme"), done]], { answers: true });
    const c = client();
    const hosted = open(r, c);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    await settle();
    expect(hosted.running).toBe(true);
    expect(r.runs).toEqual([]);
  });
});

describe("U4: switching auto-accept ON with an ask pending", () => {
  test("U4 the pending ask is answered, after the `auto_accept` update", async () => {
    // Mutation: drop the sweep in `setAutoAccept` → the ask stays pending.
    const r = rig([[call("c1", "askme"), done]], { answers: true });
    const c = client();
    const hosted = open(r, c);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    await settle(2);
    expect(hosted.running).toBe(true);

    hosted.setAutoAccept(true, "phone");
    await until(() => !hosted.running);
    expect(r.runs).toEqual(["askme"]);
    const types = c.frames.map((u) => u.update.type);
    // The switch comes FIRST: every client sees the cause before its effect.
    expect(types.indexOf("auto_accept")).toBeLessThan(types.indexOf("permission_resolved"));
    expect(c.asks).toEqual([]);
  });
});

describe("U5: one resolution point — a client's answer is never a second one", () => {
  test("U5 the daemon's `allow_once` and a client's repeat: success; a different answer loses the race", async () => {
    // Mutation: call `settle` instead of `resolvePermission` in `autoAnswer`
    // → the client's identical answer is `PermissionNotPending`.
    const r = rig([[call("c1", "askme"), done]], { answers: true });
    const c = client();
    const hosted = open(r, c);
    hosted.setAutoAccept(true);
    hosted.prompt("T1", go);
    await until(() => !hosted.running);
    expect(r.runs).toEqual(["askme"]);
    const requestId = c.of("permission_request")[0]?.requestId ?? "";
    // The client's requester answered `allow_once` too: the same answer, no effect.
    expect(() => hosted.resolvePermission(requestId, "allow_once")).not.toThrow();
    // A different answer is the lost race every client already handles.
    expect(() => hosted.resolvePermission(requestId, "reject_once")).toThrow();
    expect(r.runs).toEqual(["askme"]);
    expect(c.of("permission_resolved")).toHaveLength(1);
  });
});

describe("U6: the SAME rule a client's auto-accept applies", () => {
  test("U6 never a hooks_trust ask, never a session_hop without `hopAuto`", async () => {
    // Guard: mutation — replace `autoApproves(req, own)` with `own` → red.
    const r = rig([[]], { answers: true });
    const c = client();
    const hosted = open(r, c);
    hosted.setAutoAccept(true);
    const base = { tool: "t", level: "ask" as const, title: "t", input: {} };
    const hop = { ...base, kind: "session_hop" as const };
    // The unit under test, called as its callers do (inside a turn's ask).
    expect(priv(hosted).autoAnswers({ ...base, kind: "hooks_trust" }, "T1")).toBe(false);
    expect(priv(hosted).autoAnswers(hop, "T1")).toBe(false);
    expect(priv(hosted).autoAnswers({ ...hop, hopAuto: true }, "T1")).toBe(true);
    expect(priv(hosted).autoAnswers(base, "T1")).toBe(true);
    // And no turn id is not known to be the session's: not answered.
    expect(priv(hosted).autoAnswers(base, undefined)).toBe(false);
  });

  test("U6b a REAL `hooks_trust` / bare `session_hop` ask during a live turn waits; a tool ask is answered", async () => {
    // Mutation: same as U6 — and this half proves it through the GATE itself,
    // not just the predicate: those two asks are HELD, the tool ask is not.
    const gate = Promise.withResolvers<void>();
    const r = rig(
      [
        [call("c1", "askme"), call("c2", "hold"), done],
        [text("end"), done],
      ],
      {
        answers: true,
        tools: (_broker, runs) => [
          counted("askme", runs),
          {
            name: "hold",
            description: "hold",
            inputSchema: anyInput,
            permission: "none",
            async execute() {
              await gate.promise;
              return { content: "held" };
            },
          },
        ],
      },
    );
    const c = client();
    const hosted = open(r, c);
    hosted.setAutoAccept(true);
    hosted.prompt("T1", go);
    await until(() => c.of("permission_request").length === 1);
    expect(c.of("permission_request")[0]?.tool).toBe("askme");
    // The `askme` ask was answered by the daemon, so its tool ran and the turn
    // went on to `hold` — which keeps the turn live for the asks below.
    await until(() => r.runs.length === 1);
    const broker = r.brokers[0];
    if (!broker) throw new Error("no broker");
    const settled: unknown[] = [];
    const base = { level: "ask" as const, input: {} };
    for (const req of [
      { ...base, tool: "hooks", title: "Trust this repo's hooks?", kind: "hooks_trust" as const },
      { ...base, tool: "hop", title: "Move this session?", kind: "session_hop" as const },
    ]) {
      void broker
        .request(req, { turnId: "T1", signal: new AbortController().signal })
        .then((response) => settled.push(response));
    }
    await until(() => c.of("permission_request").length === 3);
    await settle(8);
    // Both are still pending: never answered by the computer.
    expect(settled).toEqual([]);
    expect(c.of("permission_resolved")).toHaveLength(1);
    gate.resolve();
    await until(() => !hosted.running);
  });
});

describe("U7: a background child's ask", () => {
  /** A parent that launches one background child which asks, then finishes. */
  function childRig(answers: boolean) {
    const runs: string[] = [];
    const parent = new Scripted([
      [call("c1", "agent_task", { description: "map", prompt: "go", background: true }), done],
      [text("started"), done],
    ]);
    const child = new Scripted([
      [call("k1", "needs_ok"), done],
      [text("CHILD DONE"), done],
    ]);
    const permissions = new PermissionBroker();
    const requestPermission = permissions.request.bind(permissions);
    const agentJobs = new AgentJobs(2);
    const childTools = new ToolRegistry().register(counted("needs_ok", runs));
    const { run, types } = createSubagentRunner({
      model: child,
      env,
      tools: childTools,
      requestPermission,
    });
    const parentTools = new ToolRegistry()
      .register(counted("needs_ok", runs))
      .register(createTaskTool(run, types, { background: agentJobs }));
    const agent = new Agent({
      model: parent,
      tools: parentTools,
      env,
      agentJobs,
      maxIterations: 8,
      requestPermission,
    });
    const hosted = new HostedSession(
      "s1",
      new Session(agent, "s1", {}),
      permissions,
      undefined,
      answers ? { answersAutoAccept: true } : {},
      undefined,
      undefined,
      undefined,
      {},
      {},
      {},
      agentJobs,
    );
    const frames: KnownSessionUpdateParams[] = [];
    hosted.attach({ send: (u) => frames.push(u) });
    const asks = () =>
      frames.flatMap((p) => (p.update.type === "permission_request" ? [p.update] : []));
    const resolved = () => frames.filter((p) => p.update.type === "permission_resolved").length;
    return { hosted, frames, asks, resolved, runs };
  }

  test("U7 a background ask carrying its SPAWNING turn is answered; without a turn it waits", async () => {
    // Mutation: pass `undefined` as the turn id in `awaitBackgroundDecision` → red.
    const answered = childRig(true);
    answered.hosted.setAutoAccept(true);
    answered.hosted.prompt("T1", go);
    await until(() => answered.runs.length === 1, 3000);
    const shown = answered.asks();
    expect(shown).toHaveLength(1);
    // It names the spawning turn, and only that makes it "ours" (ownRequest).
    expect(shown[0]?.turnId).toBe("T1");
    expect(answered.resolved()).toBe(1);

    // No trust bit: the child's ask is held, as a client's own would be (a pod).
    const held = childRig(false);
    held.hosted.setAutoAccept(true);
    held.hosted.prompt("T1", go);
    await until(() => held.asks().length === 1, 3000);
    await settle();
    expect(held.runs).toEqual([]);
    expect(held.resolved()).toBe(0);
  });
});

describe("U9: a wake turn with nobody attached", () => {
  test("U9 a wake turn's ask is answered by the daemon", async () => {
    // Mutation: drop the `autoAnswer` call (same as U1) → red.
    const r = rig([[call("c1", "askme"), done]], { answers: true });
    const c = client();
    const hosted = open(r, c);
    hosted.setAutoAccept(true);
    hosted.detach(c.attachment);
    hosted.prompt("wake-1", go);
    await until(() => !hosted.running);
    expect(r.runs).toEqual(["askme"]);
  });
});

describe("U10: an old client that declared no `permission_request`", () => {
  test("U10 the ask the daemon will answer is not refused: nobody needs that client", async () => {
    // Mutation: remove the `blockingUnsupported` skip → the turn is refused.
    const r = rig([[call("c1", "askme"), done]], { answers: true });
    const old = client([]); // an older client: cannot show an ask
    const hosted = open(r, old);
    hosted.setAutoAccept(true);
    hosted.prompt("T1", go);
    await until(() => !hosted.running);
    expect(r.runs).toEqual(["askme"]);
    // And a host that does NOT answer still refuses it, exactly as today.
    const pod = rig([[call("c1", "askme"), done]]);
    const stale = client([]);
    const podHosted = open(pod, stale);
    podHosted.setAutoAccept(true);
    podHosted.prompt("T1", go);
    await until(() => !podHosted.running);
    expect(pod.runs).toEqual([]);
  });
});

describe("U8: a reload / an archived reopen", () => {
  /** A persisting `serve` host (the sidecar is where the switch lives). */
  function persisting(
    script: readonly (readonly StreamEvent[])[],
    answers: boolean,
    store = new SpyDaemonStore(),
  ) {
    const runs: string[] = [];
    const model = new Scripted(script);
    const persister = new SessionPersister({
      store,
      cwd: "/tmp/serve-autoaccept-unattended-persist",
      model: "m",
      onError: () => {},
    });
    const host = new SessionHost({
      defaultCwd: "/tmp/serve-autoaccept-unattended-persist",
      persister,
      sharedAutoAccept: true,
      ...(answers ? { answersAutoAccept: true } : {}),
      createAgent: () => {
        const permissions = new PermissionBroker();
        const agent = new Agent({
          model,
          tools: new ToolRegistry().register(counted("askme", runs)),
          env,
          requestPermission: (req, options) => permissions.request(req, options),
        });
        return { agent, permissions };
      },
    });
    return { host, store, runs };
  }

  /** What a restarted daemon reads back: the two files through the real decoders. */
  const reread = (store: SpyDaemonStore, id: string): DaemonSessionRecord => {
    const record = store.durable.get(id);
    if (!record) throw new Error("nothing durable");
    return decodeFiles(record.id, filesOf(record));
  };

  test("U8 a suspended turn reloads with the value ON: re-asked and answered, the tool runs ONCE", async () => {
    // Mutation: ignore `restored.autoAccept` at the constructor's
    // `this.autoAccept = restored?.autoAccept === true` → the reload waits.
    const first = persisting([[call("c1", "askme"), done]], false);
    const c = client();
    const { hosted } = first.host.open({ create: true }, c.attachment);
    hosted.setAutoAccept(true, "phone");
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    await hosted.persisted();
    const record = reread(first.store, hosted.id);
    // The ask is durable and unanswered, and the sidecar says ON.
    expect(record.turn?.pending?.[0]).toMatchObject({ toolCallId: "c1", resumable: true });
    expect(record.autoAccept).toBe(true);

    // A serve restart (`answersAutoAccept`, restored value ON): the resumed turn
    // asks again and the DAEMON answers it — the tool runs exactly once.
    const second = persisting([[text("all done"), done]], true);
    const restored = second.host.restore(record);
    expect(restored.autoAccept).toBe(true);
    await until(() => !restored.running, 5000);
    expect(second.runs).toEqual(["askme"]);

    // Without the trust bit the same reload WAITS, exactly as a pod daemon does.
    const third = persisting([[text("all done"), done]], false);
    const waited = third.host.restore(record);
    expect(waited.autoAccept).toBe(true);
    await settle(6);
    expect(waited.running).toBe(true);
    expect(third.runs).toEqual([]);
  });

  test("U8b an ARCHIVED reopen starts OFF, so it is not answered", async () => {
    // The fixture: the owner's bug state — auto-accept ON, the ask pending with
    // nobody answering (a host without the trust bit) — then the session ends
    // mid-turn and is kept ARCHIVED with `autoAccept: true` on disk.
    const first = persisting([[call("c1", "askme"), done]], false);
    const c = client();
    const { hosted } = first.host.open({ create: true }, c.attachment);
    hosted.setAutoAccept(true, "phone");
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    await hosted.persisted();
    first.host.close(hosted.id);
    // The archive write lands on a later microtask (the store's own queue).
    for (let i = 0; i < 200 && first.store.durable.get(hosted.id)?.archivedAt === undefined; i++) {
      await tick(1);
    }
    expect(first.store.durable.get(hosted.id)?.archivedAt).toBeDefined();

    // A restarted `serve` indexes it from its sidecar (`addArchived`: metadata
    // only, the history is read at the reopen) — the same view `startDaemon` gets.
    const serve = persisting([[text("all done"), done]], true, first.store);
    const meta = reread(first.store, hosted.id);
    serve.host.addArchived({
      id: meta.id,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      updatedAt: meta.lastActiveAt,
      title: meta.title,
      ...(meta.archivedAt !== undefined ? { archivedAt: meta.archivedAt } : {}),
    });
    const prepared = await serve.host.prepareOpen({ sessionId: hosted.id, reopen: true });
    const reopened = serve.host.open(
      { sessionId: hosted.id, reopen: true },
      { send: () => {} },
      prepared,
    );
    expect(reopened.hosted.autoAccept).toBe(false);
    await settle(6);
    expect(serve.runs).toEqual([]);
  });
});

describe("R1: the OD5 skip is re-decided when the ask is SHOWN", () => {
  test("R1 auto-accept switched OFF while the ask's write is in flight, only an old client attached → refused, never left hanging", async () => {
    // Finding of fix round 1 (HIGH). OD5 skips the `blockingUnsupported` refusal
    // at RAISE, reading `autoAnswers` there; the answer itself is re-read later,
    // when the ask is shown. Between the two, `setAutoAccept(false)` can land —
    // so the ask is shown to a client that cannot display it, one this host will
    // no longer answer: it hangs forever, where before the fix it was refused
    // with a reason the model sees (the property `blockingUnsupported` exists
    // for, docs/feat/protocol-v10-forward-compat.md). Mutation: decide the skip
    // once, at raise (`autoAnswers` at `:1150` only), and this test hangs.
    const store = new SpyDaemonStore();
    const persister = new SessionPersister({
      store,
      cwd: "/tmp/serve-autoaccept-unattended-od5",
      model: "m",
      onError: () => {},
    });
    const runs: string[] = [];
    const model = new Scripted([[call("c1", "askme"), done]]);
    const host = new SessionHost({
      defaultCwd: "/tmp/serve-autoaccept-unattended-od5",
      persister,
      sharedAutoAccept: true,
      answersAutoAccept: true,
      createAgent: () => {
        const permissions = new PermissionBroker();
        const agent = new Agent({
          model,
          tools: new ToolRegistry().register(counted("askme", runs)),
          env,
          requestPermission: (req, options) => permissions.request(req, options),
        });
        return { agent, permissions };
      },
    });
    const old = client([]); // an older client: it cannot show an ask
    const { hosted } = host.open({ create: true }, old.attachment);
    hosted.setAutoAccept(true, "phone");
    // Hold the disk: the ask is registered (and its OD5 skip decided, ON) but
    // not shown yet.
    store.hold = true;
    hosted.prompt("T1", go);
    await until(() => hosted.running);
    await settle(4);
    hosted.setAutoAccept(false, "phone"); // switched OFF inside that window
    store.hold = false;
    store.release();
    // The turn must END: refused with the reason (no answer, no tool run), not
    // wait on a client that cannot be shown the ask.
    await until(() => !hosted.running, 3000);
    expect(runs).toEqual([]);
    expect(old.of("permission_resolved")).toHaveLength(0);
  });
});

describe("U11: the RPC surface", () => {
  test("U11 a real connection: ON, prompt, detach → the turn ends and the tool ran once", async () => {
    // Mutation: delete `answersAutoAccept: true` from serve.ts (the CLI test pins
    // that); here, drop the option from the host → red.
    const r = rig([[call("c1", "askme"), done]], { answers: true });
    const [d, ch] = createChannelPair();
    new Connection(d, r.host);
    const updates: KnownSessionUpdateParams[] = [];
    const peer = new RpcPeer(ch, {
      onNotification: (method, params) => {
        if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
      },
      onRequest: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });
    await peer.request("initialize", INIT);
    const openResult = (await peer.request("session/open", {
      sessionId: "S",
      create: true,
    })) as OpenResult;
    expect(openResult.created).toBe(true);
    expect(await peer.request("session/set_auto_accept", { sessionId: "S", on: true })).toEqual({
      on: true,
    });
    void peer.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    await until(() =>
      updates.some((u) => u.update.type === "permission_request" || u.update.type === "turn_end"),
    );
    await peer.request("session/detach", { sessionId: "S" });
    await until(() => updates.some((u) => u.update.type === "turn_end"));
    expect(r.runs).toEqual(["askme"]);
    const types = updates.map((u) => u.update.type);
    expect(types.indexOf("permission_request")).toBeLessThan(types.indexOf("permission_resolved"));
    // A later open finds nothing pending: the ask is gone, not waiting.
    await peer.request("session/open", { sessionId: "S" });
    const reopened = await peer.request("session/snapshot", { sessionId: "S" });
    expect(reopened).toMatchObject({ messages: expect.any(Array) });
    expect(updates.filter((u) => u.update.type === "permission_request")).toHaveLength(1);
  });
});
