/**
 * `RemoteClient.updateSettings` and the `session_settings` update
 * (docs/feat/session-settings-apply.md): the applier sends this laptop's
 * carried settings, knows its own update by `id`, and every OTHER client
 * hears about the change.
 */
import { describe, expect, test } from "bun:test";
import { Agent, SessionGrants } from "@tentacle/agent";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { JsonRpcErrorCode, PROTOCOL_VERSION, type SessionSettings } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, RpcError, createChannelPair } from "@tentacle/transport";
import {
  RemoteClient,
  type RemoteClientOptions,
  type SessionSettingsChange,
} from "../src/remote-client.ts";

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

/** A proxy-like host: honours `settings` and the reuse of a live session's state. */
function makeHost(built: (SessionSettings | undefined)[] = []): SessionHost {
  return new SessionHost({
    defaultCwd: "/tmp/w",
    createAgent: (_cwd, context) => {
      built.push(context.settings);
      return {
        agent: new Agent({ model: quiet, tools: new ToolRegistry(), env: noopEnv }),
        permissions: context.reuse?.permissions ?? new PermissionBroker(),
        grants: context.reuse?.grants ?? new SessionGrants(),
        ...(context.settings
          ? { settingsReport: { carried: context.settings, overridden: {} } }
          : {}),
      };
    },
  });
}

interface Frame {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** Dials `host`; every frame sent is recorded; `answer` may short-circuit a method. */
function dialer(host: SessionHost, answer?: (frame: { id: number; method: string }) => unknown) {
  const frames: Frame[] = [];
  let last: DuplexChannel | null = null;
  const dial = (): DuplexChannel => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const send = c.send.bind(c);
    const deliver: { fn: ((data: string) => void) | null } = { fn: null };
    const setOnMessage = c.setOnMessage.bind(c);
    c.setOnMessage = (handler) => {
      deliver.fn = handler;
      setOnMessage(handler);
    };
    c.send = (data: string) => {
      const frame = JSON.parse(data) as { id: number; method?: string; params?: never };
      if (frame.method) {
        frames.push({ method: frame.method, params: frame.params ?? {} });
        const reply = answer?.({ id: frame.id, method: frame.method });
        if (reply === null) {
          return; // swallowed: the daemon never sees it, never answers
        }
        if (reply !== undefined) {
          queueMicrotask(() =>
            deliver.fn?.(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...(reply as object) })),
          );
          return;
        }
      }
      send(data);
    };
    last = c;
    return c;
  };
  return {
    dial,
    drop: () => (last as DuplexChannel | null)?.close(),
    of: (method: string) => frames.filter((f) => f.method === method),
  };
}

const client = (dial: () => DuplexChannel, options: RemoteClientOptions = {}): RemoteClient =>
  new RemoteClient(dial(), new PermissionBroker(), undefined, {
    channelFactory: async () => dial(),
    random: () => 0,
    ...options,
  });

const until = async (pred: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2));
  }
  expect(pred()).toBe(true);
};

describe("RemoteClient.updateSettings (docs/feat/session-settings-apply.md)", () => {
  test("sends this client's carried settings with an id; the report becomes the session's", async () => {
    const built: (SessionSettings | undefined)[] = [];
    const d = dialer(makeHost(built));
    const c = client(d.dial, { sessionSettings: { maxIterations: 3 } });
    await c.initialize();
    // Created by another laptop's values: simulate with a first open carrying other settings.
    const first = client(d.dial, { sessionSettings: { maxIterations: 1 } });
    await first.initialize();
    await first.openSession(undefined, undefined, "S");
    await c.attachSession("S", { output: () => {}, linkClosed: () => {} } as never);
    expect(c.settingsOf("S")?.carried).toEqual({ maxIterations: 1 });
    const result = await c.updateSettings("S");
    expect(result).toEqual({
      applied: true,
      settings: { carried: { maxIterations: 3 }, overridden: {} },
    });
    const sent = d.of("session/update_settings")[0]?.params;
    expect(sent?.sessionId).toBe("S");
    expect(sent?.settings).toEqual({ maxIterations: 3 });
    expect(typeof sent?.id).toBe("string");
    expect(built).toEqual([{ maxIterations: 1 }, { maxIterations: 3 }]);
    expect(c.settingsOf("S")?.carried).toEqual({ maxIterations: 3 });
    await until(() => first.settingsOf("S")?.carried?.maxIterations === 3);
    first.close();
    c.close();
  });

  test("T11 a client that carries nothing rejects locally: nothing on the wire", async () => {
    const d = dialer(makeHost());
    const c = client(d.dial);
    await c.initialize();
    await c.openSession(undefined, undefined, "S");
    await expect(c.updateSettings("S")).rejects.toThrow(/no settings/);
    expect(d.of("session/update_settings")).toHaveLength(0);
    c.close();
  });

  test("T11 an older daemon (MethodNotFound) is worded: it predates /settings apply", async () => {
    const d = dialer(makeHost(), (frame) =>
      frame.method === "session/update_settings"
        ? { error: { code: JsonRpcErrorCode.MethodNotFound, message: "Method not found" } }
        : undefined,
    );
    const c = client(d.dial, { sessionSettings: { maxIterations: 3 } });
    await c.initialize();
    await c.openSession(undefined, undefined, "S");
    const error = await c.updateSettings("S").catch((e: unknown) => e);
    expect(error instanceof RpcError && error.code).toBe(JsonRpcErrorCode.MethodNotFound);
    expect((error as Error).message).toMatch(/predates \/settings apply/);
    c.close();
  });

  test("T11 not re-sent after a drop (once): the caller is told to run it again", async () => {
    let held = true;
    const d = dialer(makeHost(), (frame) =>
      frame.method === "session/update_settings" && held ? null : undefined,
    );
    const c = client(d.dial, { sessionSettings: { maxIterations: 3 } });
    await c.initialize();
    await c.openSession(undefined, undefined, "S");
    const pending = c.updateSettings("S").catch((e: unknown) => e);
    await until(() => d.of("session/update_settings").length === 1);
    held = false;
    d.drop();
    const error = await pending;
    expect(error).toBeInstanceOf(RpcError);
    expect((error as Error).message).toMatch(/dropped/);
    await new Promise((r) => setTimeout(r, 30));
    expect(d.of("session/update_settings")).toHaveLength(1);
    c.close();
  });
});

describe("the session_settings update: other terminals are told, the applier is not", () => {
  test("T21 the other client gets {previous, report}; the applier gets nothing", async () => {
    const host = makeHost();
    const a = client(dialer(host).dial, { sessionSettings: { maxIterations: 3 } });
    const b = client(dialer(host).dial, { sessionSettings: { maxIterations: 1 } });
    const told: { who: string; change: SessionSettingsChange }[] = [];
    a.onSessionSettingsChanged((change) => told.push({ who: "a", change }));
    b.onSessionSettingsChanged((change) => told.push({ who: "b", change }));
    await b.initialize();
    await b.openSession(undefined, undefined, "S");
    await a.initialize();
    await a.attachSession("S", { output: () => {}, linkClosed: () => {} } as never);
    await a.updateSettings("S");
    await until(() => told.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(told).toEqual([
      {
        who: "b",
        change: {
          sessionId: "S",
          previous: { carried: { maxIterations: 1 }, overridden: {} },
          report: { carried: { maxIterations: 3 }, overridden: {} },
        },
      },
    ]);
    expect(b.settingsOf("S")?.carried).toEqual({ maxIterations: 3 });
    a.close();
    b.close();
  });
});

describe("an applier's response never overwrites a newer report (F2)", () => {
  const report = (maxIterations: number) => ({ carried: { maxIterations }, overridden: {} });
  /** A daemon that opens S, and answers an apply through `onApply`. */
  async function applier(
    onApply: (send: (frame: object) => void, id: number, applyId: string) => void,
  ) {
    const [d, c] = createChannelPair();
    const send = (frame: object): void => d.send(JSON.stringify({ jsonrpc: "2.0", ...frame }));
    d.setOnMessage((data: string) => {
      const frame = JSON.parse(data) as { id: number; method?: string; params?: { id?: string } };
      if (frame.method === "initialize") {
        send({
          id: frame.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
          },
        });
      } else if (frame.method === "session/open") {
        send({
          id: frame.id,
          result: { sessionId: "S", epoch: "e", created: true, resync: false, settings: report(1) },
        });
      } else if (frame.method === "session/update_settings") {
        onApply(send, frame.id, frame.params?.id ?? "");
      }
    });
    d.setOnClose(() => {});
    const a = new RemoteClient(c, new PermissionBroker(), undefined, {
      sessionSettings: { maxIterations: 3 },
    });
    await a.initialize();
    await a.openSession(undefined, undefined, "S");
    return a;
  }
  const update = (seq: number, settings: unknown, id: string) => ({
    method: "session/update",
    params: { sessionId: "S", seq, update: { type: "session_settings", settings, id } },
  });

  test("own update, then another terminal's, then the own response: the newer report stands", async () => {
    // Round 1 writes the response unconditionally: the session reads 3 while 4 runs.
    const a = await applier((send, id, applyId) => {
      send(update(1, report(3), applyId));
      send(update(2, report(4), "another-terminal"));
      send({ id, result: { applied: true, settings: report(3) } });
    });
    expect(await a.updateSettings("S")).toEqual({ applied: true, settings: report(3) });
    expect(a.settingsOf("S")?.carried).toEqual({ maxIterations: 4 });
    a.close();
  });

  test("the response ahead of its update still updates the report", async () => {
    // Mutation: never write on the response → `settingsOf` lags until the update.
    const a = await applier((send, id) => {
      send({ id, result: { applied: true, settings: report(3) } });
    });
    await a.updateSettings("S");
    expect(a.settingsOf("S")?.carried).toEqual({ maxIterations: 3 });
    a.close();
  });
});
