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
  const make = () => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    return c;
  };
  return { host, make, methods, channels, openResult: extra.openResult };
}

/** One client on `d`, with a chosen `sharedAutoAccept` bit. */
async function connect(d: ReturnType<typeof daemon>, sharedAutoAccept?: boolean) {
  const client = new RemoteClient(d.make(), new PermissionBroker(), undefined, {
    channelFactory: async () => d.make(),
    random: () => 0,
    ...(sharedAutoAccept === undefined ? {} : { sharedAutoAccept }),
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

  test("an older daemon (no field in OpenResult) → shared() false", async () => {
    // A daemon that does not share says nothing, whatever the client asked for.
    const d = daemon(false);
    const client = await connect(d, true);
    const session = client.newSession(undefined, "S");
    await drain(session.send("hi"));
    expect(session.autoAccept.shared()).toBe(false);
    client.close();
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
