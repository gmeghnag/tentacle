/**
 * The push HOOK (docs/feat/mobile-push.md Design 5, slice P7): the daemon-side
 * observer the rules are fed from, `Attachment.deviceId`, and the two device
 * RPCs.
 *
 * The load-bearing property being pinned (Implementation / Load-bearing
 * assumption): everything the grace rule needs is produced synchronously, in
 * order, at ONE point — and the observer is NOT an attachment, so adding one
 * changes nothing a client or the agent loop sees.
 *
 * Each block names the mutation that turns it red (AGENTS §9); the whole set was
 * mutation-checked (Execution's table).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type KnownSessionUpdateParams,
  PROTOCOL_VERSION,
  type PermissionRequestUpdate,
  type SessionUpdate,
} from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import type {
  PushHookEvent,
  PushWatchedUpdate,
  SessionPushObserver,
} from "../src/hosted-session.ts";
import type { PushAttached } from "../src/push-rules.ts";
import { readPushRegistration } from "../src/push-store.ts";
import { SessionHost } from "../src/session-host.ts";

const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };

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

/** One observed hook call, exactly as the session made it. */
interface Observed {
  readonly sessionId: string;
  readonly event: PushHookEvent;
  readonly attached: PushAttached;
  /** What `SpyObserver.probe` answered DURING this call (absent: no probe set). */
  readonly probe?: string;
}

/** A spy observer: records every call, and can be made to throw on one kind. */
class SpyObserver implements SessionPushObserver {
  readonly calls: Observed[] = [];
  throwOn: "update" | "attachment" | "never" = "never";
  /**
   * Read INSIDE each call: the no-await block asks the session whether the turn
   * is still running. `finishTurn` emits `turn_end` BEFORE it retires the turn,
   * and no continuation can run between the two — so a hook deferred onto a
   * microtask (or awaited) would see `idle`.
   */
  probe: (() => string) | undefined;

  onPushEvent(sessionId: string, event: PushHookEvent, attached: PushAttached): void {
    this.calls.push({
      sessionId,
      event,
      attached,
      ...(this.probe !== undefined ? { probe: this.probe() } : {}),
    });
    if (this.throwOn === "update" && event.type === "update") throw new Error("observer bug");
    if (this.throwOn === "attachment" && event.type === "attachment") {
      throw new Error("observer bug");
    }
  }

  /** What it saw, in order — an `attachment` reported as `"attachment"`. */
  types(): string[] {
    return this.calls.map((c) =>
      c.event.type === "attachment" ? "attachment" : c.event.update.type,
    );
  }

  updates(): PushWatchedUpdate[] {
    return this.calls.flatMap((c) => (c.event.type === "update" ? [c.event.update] : []));
  }
}

const errors: Error[] = [];
const dirs: string[] = [];

afterEach(() => {
  errors.splice(0);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const env = (): ExecutionEnvironment => ({
  id: "rec",
  async exec() {
    return { stdout: "ok", stderr: "", exitCode: 0 };
  },
  async readFile() {
    return "";
  },
  async writeFile() {},
});

interface DaemonOptions {
  readonly script: readonly (readonly StreamEvent[])[];
  /** `undefined` = a daemon with NO push at all (a pod daemon, the worker). */
  readonly observer?: SessionPushObserver;
  /** A real store dir mounted on the push option (the RPC blocks use one). */
  readonly storeDir?: string;
  readonly graceSeconds?: number;
}

function daemon(options: DaemonOptions) {
  const host = new SessionHost({
    defaultCwd: "/tmp/push-hook",
    onTurnError: (error) => errors.push(error),
    ...(options.observer !== undefined
      ? {
          push: {
            observer: options.observer,
            storeDir: options.storeDir ?? "/tmp/push-hook-store",
            graceSeconds: options.graceSeconds ?? 42,
            status: () => "on" as const,
          },
        }
      : {}),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model: new ScriptedProvider(options.script),
        tools: new ToolRegistry().register(shellTool),
        env: env(),
        requestPermission: (req: PermissionRequest, opts): Promise<PermissionResponse> =>
          permissions.request(req, opts),
      });
      return { agent, permissions };
    },
  });
  const connect = async (principal?: { kind: "device"; id: string }) => {
    const [d, c] = createChannelPair();
    const connection = new Connection(d, host, undefined, {
      ...(principal !== undefined ? { principal } : {}),
    });
    const updates: KnownSessionUpdateParams[] = [];
    const client = new RpcPeer(c, {
      onNotification: (method, params) => {
        if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
      },
      onRequest: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });
    await client.request("initialize", INIT);
    const open = (params: Record<string, unknown>) =>
      client.request("session/open", params) as Promise<{ sessionId: string }>;
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
    return { connection, client, updates, open, prompt, resolve, of };
  };
  return { host, connect };
}

const oneAsk = [[call("c1", "rm -rf build"), { type: "done" }], [{ type: "done" }]] as const;
const noTools = [[{ type: "done" }]] as const;

function firstAsk(updates: readonly PermissionRequestUpdate[]): PermissionRequestUpdate {
  const [first] = updates;
  if (first === undefined) throw new Error("no permission_request");
  return first;
}

describe("the hook sees exactly the watched updates, in emit order", () => {
  test("open → ask → resolve → turn_end, and NOTHING else the session emits", async () => {
    // Mutation: forward every update (drop the type filter in `offerPush`) → the
    // list gains `tool_call_update`/`turn_progress`/… and this fails. Since task
    // 18 the watched set is seven (task 16's four + `turn_start`, `tool_call`,
    // `session_title`), so the assertion below names what must NOT appear rather
    // than pinning a count that the widening legitimately changed.
    const spy = new SpyObserver();
    const d = daemon({ script: oneAsk, observer: spy });
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    const ask = firstAsk(a.of("permission_request"));
    await a.resolve("S", ask.requestId, "allow_once");
    await flush();
    // The watched set, in emit order (task 16's four plus task 18's three; the
    // ask's turn also emits a `turn_start` and the tool call that raised it).
    expect(spy.types()).toEqual([
      "attachment",
      "turn_start",
      "tool_call",
      "permission_request",
      "permission_resolved",
      "turn_end",
    ]);
    // What must NEVER be watched: the high-frequency display classes.
    expect(spy.types()).not.toContain("tool_call_update");
    expect(spy.types()).not.toContain("turn_progress");
    // The HOOK's order is the clients' order: same seq, same moment.
    const watched = [
      "permission_request",
      "permission_resolved",
      "turn_end",
      "turn_start",
      "tool_call",
    ];
    const emitted = a.updates.map((u) => u.update.type).filter((t) => watched.includes(t));
    expect(spy.types().filter((t) => t !== "attachment")).toEqual(emitted);
    // By TYPE, not by index: the watched set grew in task 18, so a positional
    // lookup would silently start asserting about `tool_call` instead.
    const resolved = spy.updates().find((update) => update.type === "permission_resolved");
    expect(resolved).toMatchObject({
      type: "permission_resolved",
      requestId: ask.requestId,
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
  });

  test("a `workflows` update reaches the hook (slice 9: a run's end is pushable)", async () => {
    // docs/feat/agent-workflows.md slice 9. A run's end is reported ONLY on the
    // session's `workflows` update — full state, on every step of any run — so if
    // the hook's filter does not widen to it, no run end can ever be pushed.
    // Mutation: remove `update.type !== "workflows"` from `offerPush` → this
    // fails, and so would every run-end push (M3 of the slice's mutation table).
    const spy = new SpyObserver();
    const d = daemon({ script: noTools, observer: spy });
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    const hosted = d.host.get("S");
    if (hosted === undefined) throw new Error("no session");
    // The daemon's own publisher, the one every run state change goes through.
    (hosted as unknown as { publishWorkflows(rows: unknown[]): void }).publishWorkflows([
      {
        runId: "wf-1",
        name: "task",
        version: 1,
        hash: "a".repeat(64),
        state: "ok",
        tokens: 0,
        startedAt: 1,
        endedAt: 2,
        steps: [{ id: "plan", kind: "agent", where: "local", state: "ok", attempt: 1, round: 0 }],
      },
    ]);
    await flush();
    expect(spy.types()).toContain("workflows");
    const rows = a.of("workflows");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runs.map((r) => r.runId)).toEqual(["wf-1"]);
  });

  test("session_closed reaches the hook (its timers must not outlive the session)", async () => {
    const spy = new SpyObserver();
    const d = daemon({ script: noTools, observer: spy });
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.client.request("session/close", { sessionId: "S" });
    await flush();
    expect(spy.types()).toContain("session_closed");
  });

  test("a daemon with no push option observes nothing at all (a pod, the worker: F23)", async () => {
    const d = daemon({ script: oneAsk });
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    expect(a.of("permission_request")).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});

describe("the attached set the hook reports (F17's input)", () => {
  test("a device attachment carries ITS id; a token client carries none", async () => {
    // Mutation: read the id from `open`'s params instead of the connection's
    // principal → a client could name any device, and a token client could
    // claim one.
    const spy = new SpyObserver();
    const d = daemon({ script: noTools, observer: spy });
    const phone = await d.connect({ kind: "device", id: "0123456789abcdef" });
    await phone.open({ sessionId: "P", create: true });
    const desk = await d.connect();
    await desk.open({ sessionId: "D", create: true });
    await flush();
    const bySession = new Map(
      spy.calls
        .filter((c) => c.event.type === "attachment")
        .map((c) => [c.sessionId, c.attached] as const),
    );
    expect(bySession.get("P")).toEqual({ clients: 1, devices: ["0123456789abcdef"] });
    expect(bySession.get("D")).toEqual({ clients: 1, devices: [] });
  });

  test("a detach is an event of its own (a phone locked mid-grace, F17)", async () => {
    // Mutation: drop `offerPushAttachment()` in `removeAttachment` → the rules
    // never learn the device left, so the ask is never pushed.
    const spy = new SpyObserver();
    const d = daemon({ script: oneAsk, observer: spy });
    const a = await d.connect({ kind: "device", id: "0123456789abcdef" });
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    const before = spy.calls.length;
    // The socket goes away: `Connection.close` detaches every session it opened.
    a.connection.close();
    await flush(20);
    const after = spy.calls.slice(before);
    expect(
      after.map((c) => (c.event.type === "attachment" ? "attachment" : c.event.update.type)),
    ).toEqual(["attachment"]);
    expect(after[0]?.attached).toEqual({ clients: 0, devices: [] });
  });
});

describe("the observer is NOT an attachment (AGENTS §7 one session path)", () => {
  test("a pending ask is NOT denied by `recheckAsks` while the observer is installed", async () => {
    // The load-bearing property, mutated directly: register the observer in
    // `attachments` and `blockingUnsupported` sees an "attached client" that
    // declared no `permission_request`, so the ask is settled `cancelled`.
    const spy = new SpyObserver();
    const d = daemon({ script: oneAsk, observer: spy });
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    const hosted = d.host.get("S");
    expect(spy.calls.length).toBeGreaterThan(0);
    // ONE attachment: the client. The observer is not one.
    expect(hosted?.attachedCount).toBe(1);
    expect(a.of("permission_resolved")).toEqual([]);
    expect(hosted?.running).toBe(true);
  });

  test("with the client gone the ask still waits (the observer cannot stand in for it)", async () => {
    // Mutation: register the observer as an attachment → the detach makes
    // `blockingUnsupported` deny the ask, and the turn ends instead of waiting.
    const spy = new SpyObserver();
    const d = daemon({ script: oneAsk, observer: spy });
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    a.connection.close();
    await flush(20);
    const hosted = d.host.get("S");
    expect(hosted?.attachedCount).toBe(0);
    expect(hosted?.running).toBe(true);
    expect(a.of("permission_resolved")).toEqual([]);
  });
});

describe("a bug in the observer never reaches the turn or the clients (F24)", () => {
  test("a throwing observer: the turn still ends and every client gets every update", async () => {
    // Mutation: drop the session's `try/catch` around the hook → the throw
    // escapes `emit`, so the turn never reaches `turn_end`.
    const spy = new SpyObserver();
    spy.throwOn = "update";
    const d = daemon({ script: oneAsk, observer: spy });
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    const ask = firstAsk(a.of("permission_request"));
    await a.resolve("S", ask.requestId, "allow_once");
    await flush();
    expect(a.of("turn_end")).toMatchObject([{ turnId: "t1", stopReason: "end_turn" }]);
    expect(a.of("permission_resolved")).toHaveLength(1);
    // Reported, not swallowed: the daemon's own error sink saw it.
    expect(errors.map((e) => e.message)).toContain("observer bug");
  });

  test("a throwing observer on the attach path costs nothing either", async () => {
    const spy = new SpyObserver();
    spy.throwOn = "attachment";
    const d = daemon({ script: oneAsk, observer: spy });
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();
    expect(a.of("permission_request")).toHaveLength(1);
    expect(d.host.get("S")?.attachedCount).toBe(1);
    expect(errors.map((e) => e.message)).toContain("observer bug");
  });
});

describe("the hook runs inside the steering no-await window (AGENTS §7)", () => {
  test("turn_end reaches the hook with NO microtask between the fan-out and the hook", async () => {
    // `emit` fans out to the attachments, then calls the hook, in ONE synchronous
    // stretch. The probe is a second, raw attachment whose sink (called by that
    // very fan-out) queues a microtask: if the hook runs in the same stretch, it
    // sees the flag still unset. Mutation: defer the hook
    // (`queueMicrotask(() => this.offerPush(update))`) → the flag is already set,
    // and this fails. (A marker taken from the CLIENT's notification does not
    // work here: peer notifications land on a later microtask, so it would never
    // fire during the emit — the vacuity that let M3 survive the first draft.)
    const spy = new SpyObserver();
    const d = daemon({ script: noTools, observer: spy });
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    const hosted = d.host.get("S");
    if (hosted === undefined) throw new Error("no session");
    let microtaskAfterFanOut = false;
    hosted.attach({
      send: (update) => {
        if (update.update.type !== "turn_end") return;
        queueMicrotask(() => {
          microtaskAfterFanOut = true;
        });
      },
    });
    spy.probe = () => (microtaskAfterFanOut ? "after-microtask" : "same-stretch");
    await a.prompt("S", "t1");
    await flush();
    const atTurnEnd = spy.calls
      .filter((c) => c.event.type === "update" && c.event.update.type === "turn_end")
      .map((c) => c.probe);
    expect(atTurnEnd).toEqual(["same-stretch"]);
    // The marker DID fire eventually: the probe is not vacuous.
    expect(microtaskAfterFanOut).toBe(true);
  });
});

describe("device/push_register is a DEVICE's method only", () => {
  const params = { token: "a".repeat(64), env: "sandbox" as const, key: "A".repeat(43) };

  test("a token principal is refused", async () => {
    // Mutation: drop the principal check → a plain `serve` client could register
    // a token this laptop would then push to.
    const d = daemon({ script: noTools, observer: new SpyObserver() });
    const a = await d.connect();
    const error = await a.client
      .request("device/push_register", params)
      .then(() => undefined)
      .catch((e: { message?: string }) => e);
    expect(error?.message).toContain("only a paired device");
  });

  test("a daemon with no push answers MethodNotFound (an old phone says 'update tentacle')", async () => {
    const d = daemon({ script: noTools });
    const a = await d.connect({ kind: "device", id: "0123456789abcdef" });
    const error = await a.client
      .request("device/push_register", params)
      .then(() => undefined)
      .catch((e: { code?: number }) => e);
    expect(error?.code).toBe(-32601);
  });

  test("a device's registration is written, and answers the grace + status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "push-hook-store-"));
    dirs.push(dir);
    const d = daemon({ script: noTools, observer: new SpyObserver(), storeDir: dir });
    const a = await d.connect({ kind: "device", id: "0123456789abcdef" });
    const result = (await a.client.request("device/push_register", params)) as {
      graceSeconds: number;
      push: string;
    };
    expect(result).toEqual({ graceSeconds: 42, push: "on" });
    const stored = readPushRegistration(dir, "0123456789abcdef");
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.registration.token).toBe("a".repeat(64));
      expect(stored.registration.env).toBe("sandbox");
    }
    // Unregister removes it, idempotently.
    expect(await a.client.request("device/push_unregister", {})).toEqual({});
    expect(readPushRegistration(dir, "0123456789abcdef").ok).toBe(false);
    expect(await a.client.request("device/push_unregister", {})).toEqual({});
  });

  test("a malformed registration is InvalidParams, and nothing is written (F26)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "push-hook-store-"));
    dirs.push(dir);
    const d = daemon({ script: noTools, observer: new SpyObserver(), storeDir: dir });
    const a = await d.connect({ kind: "device", id: "0123456789abcdef" });
    const error = await a.client
      .request("device/push_register", { ...params, token: "zz" })
      .then(() => undefined)
      .catch((e: { code?: number }) => e);
    expect(error?.code).toBe(-32602);
    expect(readPushRegistration(dir, "0123456789abcdef").ok).toBe(false);
  });
});

// --- the hook's widened kind filter (docs/feat/mobile-live-activity.md L7) ---
/**
 * The observer task 16 added sees four kinds. A Live Activity needs three more
 * — `turn_start` (the elapsed timer's origin and the start threshold),
 * `tool_call` (the current tool) and `session_title` — and the ONLY change this
 * task makes to `HostedSession` is that filter growing.
 *
 * The load-bearing property is unchanged and is re-pinned here: the hook is
 * called synchronously, in `emit`'s own order, and nothing is awaited
 * (AGENTS §7, the steering no-wait window).
 */
describe("the observer sees the Live Activity kinds too (L7)", () => {
  test("turn_start, tool_call and session_title reach the observer, in emit order", async () => {
    const seen: string[] = [];
    const spy: SessionPushObserver = {
      onPushEvent(_sessionId, event) {
        if (event.type === "update") {
          seen.push(event.update.type);
        }
      },
    };
    // `oneAsk` makes a real tool call (and raises an ask), so `tool_call` is
    // genuinely emitted rather than assumed.
    const d = daemon({ script: oneAsk, observer: spy });
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    await a.prompt("S", "t1");
    await flush();

    // The three NEW kinds are observed...
    expect(seen).toContain("turn_start");
    expect(seen).toContain("tool_call");
    // ...and `turn_start` precedes both the tool call and the ask it raised (the
    // turn then waits on the ask, so no `turn_end` is expected yet).
    const startAt = seen.indexOf("turn_start");
    const toolAt = seen.indexOf("tool_call");
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(toolAt).toBeGreaterThan(startAt);
    expect(seen.indexOf("permission_request")).toBeGreaterThan(toolAt);
    expect(seen).not.toContain("turn_end");
    // Nothing else was added to the filter: a `tool_call_update` (display-class,
    // high frequency) is still NOT watched — the filter widened by three, not by
    // "everything".
    expect(seen).not.toContain("tool_call_update");
  });

  test("`session_title` is observed when the session is named", async () => {
    const seen: string[] = [];
    const spy: SessionPushObserver = {
      onPushEvent(_sessionId, event) {
        if (event.type === "update") {
          seen.push(event.update.type);
        }
      },
    };
    const d = daemon({ script: noTools, observer: spy });
    const a = await d.connect();
    await a.open({ sessionId: "S", create: true });
    // Renaming makes the daemon emit `session_title`.
    await a.client.request("session/rename", { sessionId: "S", title: "named by the test" });
    await flush();
    expect(seen).toContain("session_title");
  });
});
