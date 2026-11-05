/**
 * `RemoteClientOptions.sessionSettings` (docs/feat/config-carry.md): sent wherever
 * a session may be CREATED or described as new, and on no attach; plus the
 * daemon's report (`onSessionSettings`).
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { PROTOCOL_VERSION, type SessionSettings } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient, type RemoteClientOptions } from "../src/remote-client.ts";

const CWD = "/tmp/settings-work";
const SETTINGS: SessionSettings = { maxIterations: 7, autoTitle: false };

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

function makeHost(built: (SessionSettings | undefined)[] = []): SessionHost {
  return new SessionHost({
    defaultCwd: CWD,
    createAgent: (_cwd, context) => {
      built.push(context.settings);
      return {
        agent: new Agent({ model: quiet, tools: new ToolRegistry(), env: noopEnv }),
        permissions: new PermissionBroker(),
        ...(context.settings
          ? { settingsReport: { carried: context.settings, overridden: { dedupOutput: true } } }
          : {}),
      };
    },
  });
}

const until = async (pred: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2));
  }
  expect(pred()).toBe(true);
};

const drain = async (events: AsyncIterable<SessionEvent>): Promise<void> => {
  for await (const _event of events) {
    // drain
  }
};

interface Frame {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** A client on `host`, with every frame it sends recorded; `daemon.host` is swappable. */
function dialer(first: SessionHost) {
  const frames: Frame[] = [];
  const daemon = { host: first };
  let last: DuplexChannel | null = null;
  const dial = (): DuplexChannel => {
    const [d, c] = createChannelPair();
    new Connection(d, daemon.host);
    const send = c.send.bind(c);
    c.send = (data: string) => {
      const frame = JSON.parse(data) as Partial<Frame>;
      if (frame.method) {
        frames.push({ method: frame.method, params: frame.params ?? {} });
      }
      send(data);
    };
    last = c;
    return c;
  };
  return {
    frames,
    daemon,
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

describe("sessionSettings on the wire (docs/feat/config-carry.md)", () => {
  test("every site that may create a session, or describes a new one, sends them", async () => {
    const d = dialer(makeHost());
    const c = client(d.dial, { sessionSettings: SETTINGS });
    await c.initialize();
    await c.openSession(undefined, undefined, "with-id");
    await c.openSession();
    await c.sessionContext();
    await c.sessionContext(undefined, [{ role: "user", content: "seed" }]);
    await c.sessionSkills();
    expect(d.of("session/open").map((f) => f.params.settings)).toEqual([SETTINGS, SETTINGS]);
    expect(d.of("session/context").map((f) => f.params.settings)).toEqual([SETTINGS, SETTINGS]);
    expect(d.of("session/skills").map((f) => f.params.settings)).toEqual([SETTINGS]);
    c.close();
  });

  test("a read of an EXISTING session never sends them", async () => {
    const d = dialer(makeHost());
    const c = client(d.dial, { sessionSettings: SETTINGS });
    await c.initialize();
    await c.openSession(undefined, undefined, "S");
    await c.sessionContext("S");
    await c.sessionSkills("S");
    expect(d.of("session/context")[0]?.params).toEqual({ sessionId: "S" });
    expect(d.of("session/skills")[0]?.params).toEqual({ sessionId: "S" });
    c.close();
  });

  test("attachSession never sends them", async () => {
    const host = makeHost();
    const owner = dialer(host);
    const first = client(owner.dial, { sessionSettings: { maxIterations: 1 } });
    await first.initialize();
    await first.openSession(undefined, undefined, "S");
    const d = dialer(host);
    const c = client(d.dial, { sessionSettings: SETTINGS });
    await c.initialize();
    await c.attachSession("S", { output: () => {}, linkClosed: () => {} } as never);
    expect(d.of("session/open")[0]?.params.settings).toBeUndefined();
    first.close();
    c.close();
  });

  test("the re-attach of a live session after a drop never sends them", async () => {
    const d = dialer(makeHost());
    const c = client(d.dial, { sessionSettings: SETTINGS });
    await c.initialize();
    await c.openSession(undefined, undefined, "S");
    d.frames.length = 0;
    d.drop();
    await until(() => d.of("session/open").length === 1);
    expect(d.of("session/open")[0]?.params.settings).toBeUndefined();
    c.close();
  });

  test("a never-live create re-sent after a drop keeps them", async () => {
    // The first daemon closes as soon as it reads the open: it may never have seen it.
    const [d1, c1] = createChannelPair();
    d1.setOnMessage((data: string) => {
      const frame = JSON.parse(data) as { id: number; method?: string };
      if (frame.method === "initialize") {
        d1.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: { tools: true, permissions: true },
            },
          }),
        );
      } else if (frame.method === "session/open") {
        d1.close();
      }
    });
    d1.setOnClose(() => {});
    const built: (SessionSettings | undefined)[] = [];
    const d = dialer(makeHost(built));
    const c = new RemoteClient(c1, new PermissionBroker(), undefined, {
      channelFactory: async () => d.dial(),
      random: () => 0,
      sessionSettings: SETTINGS,
    });
    await c.initialize();
    await drain(c.newSession(undefined, "S").send("hello")).catch(() => {});
    await until(() => built.length === 1);
    expect(d.of("session/open")[0]?.params).toMatchObject({
      sessionId: "S",
      create: true,
      settings: SETTINGS,
    });
    expect(built).toEqual([SETTINGS]);
    c.close();
  });

  test("a recreate (the daemon lost the session) rebuilds the agent with this laptop's values", async () => {
    const d = dialer(makeHost());
    const c = client(d.dial, { sessionSettings: SETTINGS });
    await c.initialize();
    await c.openSession(undefined, undefined, "S");
    const built: (SessionSettings | undefined)[] = [];
    const fresh = makeHost(built);
    d.daemon.host = fresh;
    d.drop();
    await until(() => fresh.get("S") !== undefined);
    expect(built).toEqual([SETTINGS]);
    c.close();
  });

  test("with no option (connect, the worker) no frame ever carries `settings`", async () => {
    const d = dialer(makeHost());
    const c = client(d.dial);
    await c.initialize();
    await c.openSession(undefined, undefined, "S");
    await c.openSession();
    await c.sessionContext();
    await c.sessionSkills();
    for (const frame of d.frames) {
      expect(frame.params.settings).toBeUndefined();
    }
    c.close();
  });
});

describe("onSessionSettings: the daemon's report (docs/feat/config-carry.md)", () => {
  test("fired on a create, on an attach, and on a recreate", async () => {
    const d = dialer(makeHost());
    const c = client(d.dial, { sessionSettings: SETTINGS });
    const seen: { sessionId: string; overridden: SessionSettings }[] = [];
    c.onSessionSettings(({ sessionId, report }) => {
      seen.push({ sessionId, overridden: report.overridden });
    });
    await c.initialize();
    await c.openSession(undefined, undefined, "S");
    expect(seen).toEqual([{ sessionId: "S", overridden: { dedupOutput: true } }]);

    const fresh = makeHost();
    d.daemon.host = fresh;
    d.drop();
    await until(() => seen.length === 2);
    expect(seen[1]).toEqual({ sessionId: "S", overridden: { dedupOutput: true } });
    c.close();
  });

  test("a daemon that sends no report (serve, a bare open) fires nothing", async () => {
    const d = dialer(makeHost());
    const c = client(d.dial);
    let fired = 0;
    c.onSessionSettings(() => {
      fired++;
    });
    await c.initialize();
    await c.openSession(undefined, undefined, "S");
    expect(fired).toBe(0);
    c.close();
  });

  test("unsubscribing stops it", async () => {
    const d = dialer(makeHost());
    const c = client(d.dial, { sessionSettings: SETTINGS });
    let fired = 0;
    const off = c.onSessionSettings(() => {
      fired++;
    });
    off();
    await c.initialize();
    await c.openSession(undefined, undefined, "S");
    expect(fired).toBe(0);
    c.close();
  });
});
