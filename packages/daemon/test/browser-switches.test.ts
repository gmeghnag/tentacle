/**
 * docs/feat/browser-inspect.md B5b: the session's browser switches
 * (`capabilities.browser {secrets, actions}`) — set live, logged, broadcast,
 * NEVER restored or carried — and the AUTO answer of a browser action, given by
 * the daemon that hosts the session from its LIVE switch, as an allow-once,
 * on a host that does not answer the session's auto-accept (the worker). Each
 * test names the mutation that turns it red (AGENTS §9).
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  BROWSER_ACTION_TOOL,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import {
  JsonRpcErrorCode,
  type KnownSessionUpdateParams,
  type LogResult,
  type SessionUpdate,
} from "@tentacle/protocol";
import { ToolRegistry, createBrowserToolset } from "@tentacle/tools";
import { RpcError } from "@tentacle/transport";
import { z } from "zod";
import type { Attachment } from "../src/hosted-session.ts";
import type { DaemonSessionRecord } from "../src/persisted-session.ts";
import { type BrowserHostPort, SessionHost } from "../src/session-host.ts";
import { SessionPersister } from "../src/session-persister.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";

const CWD = "/tmp/browser-switches";
const env = {} as ExecutionEnvironment;
const go = [{ type: "text" as const, text: "go" }];
const done: StreamEvent = { type: "done" };
const call = (id: string, name: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name, arguments: "{}" },
});

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** A model that replays one scripted round per call. */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    for (const event of this.script[this.turn++] ?? [done]) yield event;
  }
}

/** The browser tools' ask, as `gate()` raises it: eligible (`browserAuto`) unless `hard`. */
function browserAsk(hard: boolean): PermissionRequest {
  return {
    kind: "browser_action",
    tool: BROWSER_ACTION_TOOL,
    level: "ask",
    title: "Click “Send” on example.com",
    detail: "a form submit",
    input: {},
    ...(hard ? {} : { browserAuto: true as const }),
  };
}

/** A tool that asks a browser action through the session's ONE broker, then records it ran. */
function acting(name: string, runs: string[], broker: PermissionBroker, hard = false): Tool {
  return {
    name,
    description: name,
    inputSchema: z.object({}).passthrough(),
    permission: "none",
    async execute(_input, ctx) {
      const answer = await broker.request(browserAsk(hard), {
        ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
        origin: "call",
        signal: ctx.signal,
      });
      if (!answer.allowed) return { content: "declined", isError: true };
      runs.push(name);
      return { content: `${name} ok` };
    },
  };
}

const PORT: BrowserHostPort = {
  status: async () => ({ available: true, tabs: [] }),
  retitle: () => {},
};

function rig(
  script: readonly (readonly StreamEvent[])[],
  opts: {
    browser?: boolean;
    answers?: boolean;
    store?: SpyDaemonStore;
    port?: BrowserHostPort;
  } = {},
) {
  const runs: string[] = [];
  const model = new Scripted(script);
  const store = opts.store ?? new SpyDaemonStore();
  const persister = new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} });
  const host = new SessionHost({
    defaultCwd: CWD,
    persister,
    sharedAutoAccept: true,
    ...(opts.answers ? { answersAutoAccept: true } : {}),
    ...(opts.browser === false ? {} : { browser: opts.port ?? PORT }),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const registry = new ToolRegistry();
      registry.register(acting("act", runs, permissions));
      registry.register(acting("pay", runs, permissions, true));
      const agent = new Agent({
        model,
        tools: registry,
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  return { host, runs, store };
}

/** An in-process client: what it was sent, by stream order. */
function client() {
  const frames: KnownSessionUpdateParams[] = [];
  const attachment: Attachment = { send: (u) => frames.push(u) };
  const of = <T extends SessionUpdate["type"]>(type: T) =>
    frames
      .map((u) => u.update)
      .filter((u): u is Extract<SessionUpdate, { type: T }> => u.type === type);
  const pending = () => {
    const resolved = new Set(of("permission_resolved").map((u) => u.requestId));
    return of("permission_request").filter((u) => !resolved.has(u.requestId));
  };
  return { attachment, frames, of, pending };
}

const AUTO = { kind: "browser" as const, name: "auto", enabled: true };
const CLEAR = { kind: "browser" as const, name: "clear", enabled: true };

describe("the load-bearing auto answer (B5b assumption)", () => {
  test("A1 actions auto, a host WITHOUT answersAutoAccept (the worker) → answered allow_once, the action runs", async () => {
    // Mutation: gate the browser branch of `autoAnswers` on `answersAutoAccept` → the turn hangs.
    const r = rig([[call("c1", "act"), done]]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    expect(r.host.answersAutoAccept).toBe(false);
    hosted.setCapability(AUTO, "phone");
    hosted.prompt("T1", go);
    await until(() => !hosted.running);
    expect(r.runs).toEqual(["act"]);
    const asked = c.of("permission_request");
    expect(asked).toHaveLength(1);
    expect(c.of("permission_resolved")).toEqual([
      {
        type: "permission_resolved",
        requestId: asked[0]?.requestId ?? "",
        outcome: { outcome: "selected", optionId: "allow_once" },
      },
    ]);
  });
});

const cold = (hosted: { logRead(): LogResult }) =>
  (
    hosted.logRead().entries as (LogResult["entries"][number] & { capabilities?: unknown })[]
  ).filter((e) => e.type === "capabilities");

describe("the switches: set, logged, broadcast; only where the browser is", () => {
  test("S1 a set is logged (the whole state, Q2), broadcast with `by`, and the snapshot carries it", () => {
    // Mutation: drop `browser` from `toWireCapabilities` → the emit / snapshot lack it.
    const r = rig([]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    expect(hosted.capabilities().browser).toEqual({
      enabled: true,
      secrets: "masked",
      actions: "ask",
    });
    const result = hosted.setCapability(CLEAR, "phone");
    const want = { enabled: true, secrets: "clear", actions: "ask" } as const;
    expect(result.capabilities.browser).toEqual(want);
    expect(c.of("capabilities")).toEqual([
      {
        type: "capabilities",
        capabilities: { disabledMcp: [], disabledSkills: [], disabledTools: [], browser: want },
        by: "phone",
      },
    ]);
    expect(cold(hosted).at(-1)?.capabilities).toMatchObject({ browser: want });
    // Idempotent: the same set emits and logs nothing more.
    hosted.setCapability(CLEAR, "phone");
    expect(c.of("capabilities")).toHaveLength(1);
    // `enabled` is the tool group's projection, set by the `tool` op.
    hosted.setCapability({ kind: "tool", name: "browser", enabled: false });
    expect(hosted.capabilities().browser?.enabled).toBe(false);
  });

  test("S2 a host without the port: kind `browser` is InvalidParams, no `browser` on the wire, status unavailable", async () => {
    // Mutation: drop the port check in `setCapability` → the set applies on a pod.
    const r = rig([], { browser: false });
    const { hosted } = r.host.open({ create: true }, client().attachment);
    let error: unknown;
    try {
      hosted.setCapability(AUTO);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(hosted.capabilities().browser).toBeUndefined();
    expect(await hosted.browserStatus()).toEqual({ available: false, tabs: [] });
  });

  test("S3 an unknown browser switch name is InvalidParams, state untouched", () => {
    const r = rig([]);
    const { hosted } = r.host.open({ create: true }, client().attachment);
    expect(() =>
      hosted.setCapability({ kind: "browser", name: "everything", enabled: true }),
    ).toThrow(/unknown browser switch/);
    expect(hosted.capabilities().browser?.actions).toBe("ask");
  });
});

const pause = (ms = 20): Promise<void> => new Promise((res) => setTimeout(res, ms));

describe("who answers a browser ask", () => {
  test("W1 a `hard` ask in auto is NOT answered (Q3)", async () => {
    // Mutation: `browserAutoAnswers` ignores `browserAuto` → the payment click runs.
    const r = rig([[call("c1", "pay"), done]]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.setCapability(AUTO);
    hosted.prompt("T1", go);
    await until(() => c.pending().length === 1);
    await pause();
    expect(r.runs).toEqual([]);
    expect(hosted.running).toBe(true);
    hosted.cancel();
  });

  test("W2 the session's auto-accept (on a trusted host) never answers a browser ask", async () => {
    // Mutation: `autoApproves` lets `browser_action` through → it runs with actions `ask`.
    const r = rig([[call("c1", "act"), done]], { answers: true });
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.setAutoAccept(true);
    hosted.prompt("T1", go);
    await until(() => c.pending().length === 1);
    await pause();
    expect(r.runs).toEqual([]);
    hosted.cancel();
  });

  test("W3 auto switched OFF between the raise and the show → a human answers", async () => {
    // Mutation: decide the browser answer once at raise (a cached flag) → answered.
    const runs: string[] = [];
    const ref: { hosted?: { setCapability: (op: typeof AUTO) => unknown } } = {};
    const model = new Scripted([[call("c1", "act"), done]]);
    const host = new SessionHost({
      defaultCwd: CWD,
      sharedAutoAccept: true,
      browser: PORT,
      createAgent: () => {
        const permissions = new PermissionBroker();
        const registry = new ToolRegistry();
        registry.register({
          name: "act",
          description: "act",
          inputSchema: z.object({}).passthrough(),
          permission: "none",
          async execute(_input, ctx) {
            const asked = permissions.request(browserAsk(false), {
              ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
              origin: "call",
              signal: ctx.signal,
            });
            // Raised, not shown yet (the show waits on the record's write).
            ref.hosted?.setCapability({ ...AUTO, enabled: false });
            const answer = await asked;
            if (answer.allowed) runs.push("act");
            return { content: "ok" };
          },
        });
        const agent = new Agent({
          model,
          tools: registry,
          env,
          requestPermission: (req, options) => permissions.request(req, options),
        });
        return { agent, permissions };
      },
    });
    const c = client();
    const { hosted } = host.open({ create: true }, c.attachment);
    ref.hosted = hosted;
    hosted.setCapability(AUTO);
    hosted.prompt("T1", go);
    await until(() => c.pending().length === 1);
    await pause();
    expect(runs).toEqual([]);
    expect(c.of("permission_resolved")).toEqual([]);
    hosted.cancel();
  });

  test("W4 switching auto ON answers the pending eligible ask, after the `capabilities` emit; a hard one stays", async () => {
    // Mutation: drop the sweep in `setCapability` → the eligible ask stays pending.
    const r = rig([[call("c1", "act"), call("c2", "pay"), done]]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.pending().length >= 1);
    hosted.setCapability(AUTO, "phone");
    await until(() => r.runs.includes("act"));
    const types = c.frames.map((u) => u.update.type);
    expect(types.indexOf("capabilities")).toBeLessThan(types.indexOf("permission_resolved"));
    await until(() => c.pending().length === 1);
    await pause();
    expect(r.runs).toEqual(["act"]);
    hosted.cancel();
  });

  test("W5 the emitted permission_request never carries the `browserAuto` slack", async () => {
    // Mutation: spread `req` into the update in `toPermissionRequestUpdate` → the field leaks.
    const r = rig([[call("c1", "act"), done]]);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.pending().length === 1);
    expect(JSON.stringify(c.of("permission_request"))).not.toContain("browserAuto");
    hosted.cancel();
  });
});

describe("never restored, never carried (§7)", () => {
  const ON = { enabled: true, secrets: "clear" as const, actions: "auto" as const };
  const SAFE = { enabled: true, secrets: "masked", actions: "ask" } as const;

  test("N1 a created session's seed with auto/clear (resume, fork, hop) starts masked / ask", () => {
    // Mutation: `seedCapabilities` carries `seed.browser` AND `normalizeCapabilities`
    // keeps it (two layers: either alone stays green) → the seed turns auto on.
    const r = rig([]);
    const { hosted } = r.host.open(
      {
        create: true,
        capabilities: { disabledMcp: [], disabledSkills: [], disabledTools: [], browser: ON },
      },
      client().attachment,
    );
    expect(hosted.capabilities().browser).toEqual(SAFE);
  });

  test("N2 a serve reload whose record says auto/clear starts masked / ask", async () => {
    // Mutation: `normalizeCapabilities` keeps `browser` → the reload restores auto.
    const r = rig([]);
    const { hosted } = r.host.open({ create: true }, client().attachment);
    hosted.setCapability(AUTO);
    hosted.setCapability(CLEAR);
    await hosted.persisted();
    const record = r.store.durable.get(hosted.id) as DaemonSessionRecord;
    // The record DOES say it (the log records the switch, Q2)…
    expect(record.capabilities?.browser).toEqual({ secrets: "clear", actions: "auto" });
    // …and a restart does not apply it.
    const restarted = rig([], { store: r.store });
    const restored = restarted.host.restore(record);
    expect(restored.capabilities().browser).toEqual(SAFE);
  });

  test("N3 an agent rebuilt by a settings change keeps the live switches", () => {
    // Mutation: `swapAgent` hands the new agent NO_CAPABILITIES → clear is lost mid-session.
    const r = rig([]);
    const { hosted } = r.host.open({ create: true }, client().attachment);
    hosted.setCapability(CLEAR);
    const next = new Agent({ model: new Scripted([]), tools: new ToolRegistry(), env });
    hosted.swapAgent(next, { settingsReport: {} as never, id: "s2" });
    expect(next.capabilities().browser).toEqual({ secrets: "clear", actions: "ask" });
  });
});

describe("browser/status and the group title through the port", () => {
  test("P1 status is the port's answer; a port fault is no throw", async () => {
    const tabs = [{ id: 3, title: "t", where: "example.com/", handedOver: false, traced: false }];
    let broken = false;
    const port: BrowserHostPort = {
      status: async () => {
        if (broken) throw new Error("hub gone");
        return { available: true, link: { state: "connected", managed: false }, tabs };
      },
      retitle: () => {},
    };
    const r = rig([], { port });
    const { hosted } = r.host.open({ create: true }, client().attachment);
    expect((await hosted.browserStatus()).tabs).toEqual(tabs);
    broken = true;
    expect(await hosted.browserStatus()).toEqual({ available: true, tabs: [] });
  });

  test("P2 a rename retitles the session's tab group", () => {
    const titles: [string, string][] = [];
    const port: BrowserHostPort = {
      status: async () => ({ available: true, tabs: [] }),
      retitle: (uid, title) => {
        titles.push([uid, title]);
      },
    };
    const r = rig([], { port });
    const { hosted } = r.host.open({ create: true }, client().attachment);
    hosted.rename("Fix the login form");
    expect(titles).toEqual([[hosted.id, "Fix the login form"]]);
  });
});

describe("the log and the secrets switch (Q2)", () => {
  test("L1 a planted token is absent from <uid>.jsonl when masked, present once clear", async () => {
    // Mutation: the agent's `browserSecrets` getter reads a turn-start capture
    // or the tool ignores it → turn 2 is still masked on disk.
    const set = createBrowserToolset({
      backend: {
        call: async (op) =>
          op.op === "claim"
            ? {}
            : { url: "https://a.test/cb?token=PLANTED42", title: "A", text: "x" },
      },
    });
    const read = (id: string): StreamEvent => ({
      type: "tool_call",
      toolCall: { id, name: "browser_read", arguments: JSON.stringify({ tab: 1 }) },
    });
    const ok: StreamEvent = { type: "text", delta: "ok" };
    const model = new Scripted([
      [read("c1"), done],
      [ok, done],
      [read("c2"), done],
      [ok, done],
    ]);
    const store = new SpyDaemonStore();
    const host = new SessionHost({
      defaultCwd: CWD,
      persister: new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} }),
      browser: PORT,
      createAgent: () => {
        const permissions = new PermissionBroker();
        const registry = new ToolRegistry();
        for (const tool of set.tools({ maxEdge: 1568, maxImageBytes: 1_000_000 })) {
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
    const { hosted } = host.open({ create: true }, client().attachment);
    const onDisk = () => store.files.get(hosted.id)?.log ?? "";

    hosted.prompt("T1", go);
    await until(() => !hosted.running);
    await hosted.persisted();
    expect(onDisk()).toContain("a.test/cb?token=");
    expect(onDisk()).not.toContain("PLANTED42");

    hosted.setCapability(CLEAR);
    hosted.prompt("T2", go);
    await until(() => !hosted.running);
    await hosted.persisted();
    expect(onDisk()).toContain("PLANTED42");
  });
});
