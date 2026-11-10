/**
 * docs/fix/autoaccept-wake-turns.md T2: a REMOTE session's own-vs-foreign test is
 * `ownsTurn` (minted by me) for everything, plus — only on a daemon trusted to
 * wake on its own (`daemonWakes`, set by `connect`) — the session's own wake
 * turns (`wake-<uuid>`), for auto-accept alone.
 *
 * RED before the fix: `autoAcceptsTurn` did not exist, so a `serve` daemon's
 * wake turn was foreign to the TUI that was driving the session, and every ask
 * of it (and of a background child it spawned) was held for a human.
 * MUTATION (both halves of the load-bearing assumption): drop the
 * `this.daemonWakes &&` guard → the "without the option" case goes red; drop
 * `isWakeTurnId` → the wake cases go red.
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

/** A jobs registry the Agent is happy with (it only needs the interface). */
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

/** A real daemon (in-memory channel) and one `RemoteClient`, with a chosen `daemonWakes`. */
async function rig(daemonWakes: boolean | undefined) {
  const host = new SessionHost({
    defaultCwd: "/tmp/autoaccept-wake-client",
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
  const make = () => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    return c;
  };
  const client = new RemoteClient(make(), new PermissionBroker(), undefined, {
    channelFactory: async () => make(),
    random: () => 0,
    ...(daemonWakes === undefined ? {} : { daemonWakes }),
  });
  await client.initialize();
  return { client, close: () => client.close() };
}

const drain = async (events: AsyncIterable<SessionEvent>): Promise<void> => {
  for await (const _event of events) {
    // drain
  }
};

describe("T2: autoAcceptsTurn (the session's own test for auto-accept)", () => {
  test("with daemonWakes: a wake id and an own minted id are accepted; a foreign uuid is not", async () => {
    const r = await rig(true);
    const session = r.client.newSession(undefined, "S");
    await drain(session.send("hi", undefined, { turnId: "own-turn" }));
    expect(session.autoAcceptsTurn("own-turn")).toBe(true);
    expect(session.autoAcceptsTurn("wake-7a202134-1ef8-48e0-8271-18fb79bdafd8")).toBe(true);
    expect(session.autoAcceptsTurn("c3eed5d4-0f20-48bd-89d0-cfb09522fddd")).toBe(false);
    // `ownsTurn` is untouched: a wake stays FOREIGN for quit/cancel semantics.
    expect(session.ownsTurn("wake-7a202134")).toBe(false);
    r.close();
  });

  test("without the option (the default, every runtime but connect): a wake id is foreign", async () => {
    for (const daemonWakes of [undefined, false]) {
      const r = await rig(daemonWakes);
      const session = r.client.newSession(undefined, "S");
      await drain(session.send("hi", undefined, { turnId: "own-turn" }));
      expect(session.autoAcceptsTurn("own-turn")).toBe(true);
      expect(session.autoAcceptsTurn("wake-7a202134")).toBe(false);
      r.close();
    }
  });

  test("a long-ended wake's id is still accepted (stateless on the prefix), and a lookalike is not", async () => {
    const r = await rig(true);
    const session = r.client.newSession(undefined, "S");
    await drain(session.send("hi", undefined, { turnId: "own-turn" }));
    for (let i = 0; i < 300; i++) {
      await drain(session.send("again", undefined, { turnId: `turn-${i}` }));
    }
    // Past the bounded `mintedTurns`: a wake is still the session's own wake.
    expect(session.autoAcceptsTurn("wake-long-ended")).toBe(true);
    // The prefix is a PREFIX: an id that merely contains it is foreign.
    expect(session.autoAcceptsTurn("not-a-wake-1")).toBe(false);
    r.close();
  });
});
