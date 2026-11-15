/**
 * docs/feat/session-auto-accept.md T3: the session's auto-accept on the CLIENT.
 * The state moves to the daemon; the DECISION stays in each client's requester,
 * and only a client that knows its daemon is trusted reads that state.
 *
 * MUTATIONS (each named at its test): default the bit to on → the pod test goes
 * red; drop `pendingSet` → the offline-OFF test goes red; widen
 * `autoAcceptsTurn` unconditionally → the pod widening test goes red.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type AgentJobs,
  AgentJobs as AgentJobsClass,
  type BackgroundJob,
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import type { DuplexChannel } from "@tentacle/transport";
import { createChannelPair } from "@tentacle/transport";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";

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

/** A real daemon over in-memory channels, recording the methods clients send it. */
function daemon(shared: boolean, extra: { readonly openResult?: (r: object) => object } = {}) {
  const host = new SessionHost({
    defaultCwd: "/tmp/session-auto-accept-client",
    ...(shared ? { sharedAutoAccept: true } : {}),
    createAgent: () => {
      const agentJobs: AgentJobs = new AgentJobsClass(2);
      return {
        agent: new Agent({
          model: quiet,
          tools: new ToolRegistry(),
          env: noopEnv,
          jobs: new FakeJobs(),
          agentJobs,
        }),
        permissions: new PermissionBroker(),
        agentJobs,
      };
    },
  });
  const methods: string[] = [];
  const channels: Array<() => void> = [];
  /** Every `initialize` frame a daemon received, in connection order (D7's wire half). */
  const inits: unknown[] = [];
  const make = () => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    return c;
  };
  /** `make` behind a tap that records the `initialize` the client sends. */
  const tapped = (): ReturnType<typeof make> => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const onClient: DuplexChannel = {
      send: (data: string) => {
        const frame = JSON.parse(data) as { method?: string; params?: unknown };
        if (frame.method === "initialize") inits.push(frame.params);
        c.send(data);
      },
      close: () => c.close(),
      setOnMessage: (handler) => c.setOnMessage(handler),
      setOnClose: (handler) => c.setOnClose(handler),
    };
    return onClient;
  };
  return { host, make, tapped, methods, channels, inits, openResult: extra.openResult };
}

/** One client on `d`, with a chosen `sharedAutoAccept` bit. */
async function connect(
  d: ReturnType<typeof daemon>,
  sharedAutoAccept?: boolean,
  extra: {
    readonly hostLabel?: () => string | undefined;
    readonly clientInfo?: { readonly name: string; readonly version: string };
  } = {},
) {
  const client = new RemoteClient(d.tapped(), new PermissionBroker(), undefined, {
    channelFactory: async () => d.tapped(),
    random: () => 0,
    ...(sharedAutoAccept === undefined ? {} : { sharedAutoAccept }),
    ...extra,
  });
  await client.initialize();
  return client;
}

const drain = async (events: AsyncIterable<SessionEvent>): Promise<void> => {
  for await (const _event of events) {
    // drain
  }
};

describe("T3: the client's shared auto-accept", () => {
  test("with the bit on, a session exposes the link and the daemon's value", async () => {
    const d = daemon(true);
    const client = await connect(d, true);
    const session = client.newSession(undefined, "S");
    await drain(session.send("hi"));
    expect(session.autoAccept.shared()).toBe(true);
    expect(session.autoAccept.current()).toBe(false);
    expect(await session.autoAccept.set(true)).toEqual({ on: true });
    expect(session.autoAccept.current()).toBe(true);
    client.close();
  });

  test("the bit OFF (a pod, the default): the daemon's value is ignored and no method is sent", async () => {
    // Mutation: default the bit to on → `shared()` is true and `current()` follows the daemon.
    const d = daemon(true);
    // A pod-side client, then a daemon claiming ON: neither reaches this state.
    const client = await connect(d, undefined);
    const session = client.newSession(undefined, "S");
    await drain(session.send("hi"));
    expect(session.autoAccept.shared()).toBe(false);
    expect(session.autoAccept.current()).toBe(false);
    // Its OWN toggle stays local (the laptop's feed, as today).
    expect(session.autoAccept.set(true)).toBeUndefined();
    expect(session.autoAccept.current()).toBe(true);
    client.close();
  });

  test("`hostLabel` reaches the wire ONLY with the trust bit (D7's laptop half)", async () => {
    // docs/feat/session-auto-accept.md Review round 1, HIGH 2: the label is a
    // SEAM (`hostLabel`), not `os.hostname()` read inside this package — that
    // import broke the phone's bundle. So this test holds both halves of the
    // seam: it lands in `initialize`'s `clientInfo.host` when the client
    // SHARES the session, and never when its bit is off (a pod learns nothing).
    // Mutation: send it unconditionally (drop `wireClientInfo`'s bit test) →
    // the pod client's frame carries the label too.
    const d = daemon(true);
    const shared = await connect(d, true, {
      hostLabel: () => "gmeghnag-mac",
      clientInfo: { name: "tentacle", version: "1.0.0" },
    });
    const pod = await connect(d, undefined, {
      hostLabel: () => "gmeghnag-mac",
      clientInfo: { name: "tentacle", version: "1.0.0" },
    });
    // What each client declared, off its own `initialize` frame.
    expect(
      d.inits.map((params) => (params as { clientInfo?: { host?: string } }).clientInfo?.host),
    ).toEqual(["gmeghnag-mac", undefined]);
    shared.close();
    pod.close();
  });

  test("an older daemon (no field in OpenResult) → shared() false", async () => {
    // A daemon that does not share says nothing, whatever the client asked for.
    const d = daemon(false);
    const client = await connect(d, true);
    const session = client.newSession(undefined, "S");
    await drain(session.send("hi"));
    expect(session.autoAccept.shared()).toBe(false);
    client.close();
  });

  test("a daemon that CLAIMS ON never reaches a pod-side client (bit OFF, both halves)", async () => {
    // AGENTS §7 "a pod is not trusted": the gate is the laptop-side trust bit,
    // and it must be a TEST — the pass below fails with either check removed.
    // The daemon here really does share, and another client turns it ON, so the
    // pod receives a genuine `open{autoAccept: true}` snapshot AND a genuine
    // `auto_accept {on:true}` update. Both are dropped.
    // Mutation: drop `!this.sharedAutoAccept` in `noteAutoAccept`
    // (remote-client.ts) → `current()` becomes true; drop it in the
    // `auto_accept` branch of `output()` → `current()` and `seen` follow it.
    // Either one alone turns this test red (the two halves are separate gates).
    const d = daemon(true);
    const other = await connect(d, true);
    const so = other.newSession(undefined, "S");
    await drain(so.send("hi"));
    await so.autoAccept.set(true);

    const pod = await connect(d, undefined);
    const sp = pod.newSession(undefined, "S", undefined, { attach: {} });
    await sp.open();
    // The open's own snapshot said ON; the pod ignored it.
    expect(sp.autoAccept.shared()).toBe(false);
    expect(sp.autoAccept.current()).toBe(false);

    // And a change AFTER the pod attached: a fresh client turns it OFF and ON.
    const seen: boolean[] = [];
    sp.autoAccept.onChange((on) => seen.push(on));
    await so.autoAccept.set(false);
    await so.autoAccept.set(true);
    for (let i = 0; i < 200 && so.autoAccept.current() !== true; i++) await Promise.resolve();
    expect(so.autoAccept.current()).toBe(true);
    expect(sp.autoAccept.current()).toBe(false);
    expect(seen).toEqual([]);
    other.close();
    pod.close();
  });

  test("every client follows the daemon's updates, own echoes included", async () => {
    const d = daemon(true);
    const a = await connect(d, true);
    const b = await connect(d, true);
    const sa = a.newSession(undefined, "S");
    const sb = b.newSession(undefined, "S");
    await drain(sa.send("hi"));
    await drain(sb.send("hi"));
    const seen: boolean[] = [];
    sb.autoAccept.onChange((on) => seen.push(on));
    await sa.autoAccept.set(true);
    for (let i = 0; i < 50 && sb.autoAccept.current() !== true; i++) await Promise.resolve();
    expect(sb.autoAccept.current()).toBe(true);
    expect(seen).toEqual([true]);

    // Two toggles racing: the daemon applies them in ONE order and every client
    // converges on the last value, own echoes included.
    await sa.autoAccept.set(false);
    await sb.autoAccept.set(true);
    await sa.autoAccept.set(false);
    for (let i = 0; i < 50 && sa.autoAccept.current() !== false; i++) await Promise.resolve();
    for (let i = 0; i < 50 && sb.autoAccept.current() !== false; i++) await Promise.resolve();
    expect(sa.autoAccept.current()).toBe(false);
    expect(sb.autoAccept.current()).toBe(false);
    a.close();
    b.close();
  });

  test("autoAcceptsTurn widens to every turn of the session ONLY when shared", async () => {
    // Mutation: widen unconditionally → a pod's foreign turn is accepted.
    const d = daemon(true);
    const shared = await connect(d, true);
    const s = shared.newSession(undefined, "S");
    await drain(s.send("hi", undefined, { turnId: "own-turn" }));
    const foreign = "c3eed5d4-0f20-48bd-89d0-cfb09522fddd";
    expect(s.autoAcceptsTurn(foreign)).toBe(false);
    s.autoAccept.set(true);
    expect(s.autoAcceptsTurn(foreign)).toBe(true);
    // `ownsTurn` is untouched: quit/cancel semantics stay own-only.
    expect(s.ownsTurn(foreign)).toBe(false);

    // A pod client on the SAME daemon: nothing widens, whatever the daemon says.
    const pod = await connect(d, undefined);
    const p = pod.newSession(undefined, "P");
    await drain(p.send("hi", undefined, { turnId: "own-turn" }));
    p.autoAccept.set(true);
    expect(p.autoAcceptsTurn(foreign)).toBe(false);
    expect(p.autoAcceptsTurn("own-turn")).toBe(true);
    shared.close();
    pod.close();
  });
});
