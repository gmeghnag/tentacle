/**
 * A `serve` daemon's own wake (docs/feat/serve-autowake.md, Review finding 1):
 * a client that attaches WHILE the daemon's wake turn runs must not receive the
 * exit as a live `background_exit` — that would arm its TUI's wake and fire a
 * second, empty continuation at the wake's end. It gets the exit through the
 * snapshot plus the wake turn's own flush note instead. Model-bound and
 * tool-bound wakes both. Mutation: drop the `recordCut` before the wake's
 * `prompt()` → the replay carries the exit → the backlog has it.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type BackgroundJob,
  type ChatRequest,
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { type BackgroundExitNotice, RemoteClient } from "../src/remote-client.ts";

class FakeJobs implements JobController {
  private readonly listeners = new Set<(job: BackgroundJob) => void>();
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
  onExit(listener: (job: BackgroundJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  fire(id: string): void {
    for (const l of [...this.listeners]) {
      l({ id, command: "sleep 1", startedAt: 0, status: "exited", exitCode: 0 });
    }
  }
}

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick(5);
  }
}

/** Plays `steps` (each optionally held until a gate opens), then answers "ok". */
class Model implements ModelProvider {
  readonly id = "model";
  readonly seen: ChatRequest[] = [];
  readonly steps: { events: readonly StreamEvent[]; gate?: Promise<void> }[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(request);
    const step = this.steps.shift();
    if (step?.gate) await step.gate;
    for (const e of step?.events ?? [{ type: "text", delta: "ok" }, { type: "done" }]) yield e;
  }
}

function rig() {
  const jobs = new FakeJobs();
  const model = new Model();
  const execGate: { wait: Promise<void> | null; calls: number } = { wait: null, calls: 0 };
  const env: ExecutionEnvironment = {
    id: "gated",
    async exec() {
      execGate.calls++;
      if (execGate.wait) await execGate.wait;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
    readFile: async () => "",
    writeFile: async () => {},
  };
  const host = new SessionHost({
    defaultCwd: "/tmp/serve-autowake-client",
    wakeOnJobExit: true,
    // No `requestPermission`: tools run without an ask (a tool-bound wake, not a held one).
    createAgent: () => ({
      agent: new Agent({ model, tools: new ToolRegistry().register(shellTool), env, jobs }),
      permissions: new PermissionBroker(),
      jobs,
    }),
  });
  const clients: RemoteClient[] = [];
  const dial = async (): Promise<RemoteClient> => {
    const make = () => {
      const [d, c] = createChannelPair();
      new Connection(d, host);
      return c;
    };
    const c = new RemoteClient(make(), new PermissionBroker(), undefined, {
      channelFactory: async () => make(),
      random: () => 0,
    });
    await c.initialize();
    clients.push(c);
    return c;
  };
  const close = (): void => {
    for (const c of clients) c.close();
  };
  return { jobs, model, execGate, host, dial, close };
}

/** A session S, then its only client gone: nobody attached. */
async function detachedSession(r: ReturnType<typeof rig>): Promise<void> {
  const c = await r.dial();
  await c.openSession(undefined, undefined, "S");
  await c.detachSession("S");
  await until(() => r.host.get("S")?.attachedCount === 0);
}

describe("attach mid-wake: the exit is never a live notice (one turn per exit)", () => {
  test("model-bound wake: a client attaching mid-turn gets no `background_exit`", async () => {
    const r = rig();
    await detachedSession(r);
    const { promise, resolve } = Promise.withResolvers<void>();
    r.model.steps.push({
      events: [{ type: "text", delta: "woken" }, { type: "done" }],
      gate: promise,
    });
    r.jobs.fire("j1");
    await until(() => r.model.seen.length === 1);
    expect(r.host.get("S")?.running).toBe(true);
    // A TUI reconnects while the daemon's wake waits on the model.
    const b = await r.dial();
    await b.openSession(undefined, undefined, "S");
    await tick();
    const notices: BackgroundExitNotice[] = [];
    b.onBackgroundExit((n) => notices.push(n));
    expect(b.unflushedExits()).toBe(0);
    resolve();
    await until(() => r.host.get("S")?.running === false);
    await tick();
    // Nothing armed a client wake; the daemon ran exactly one model call.
    expect(notices).toEqual([]);
    expect(r.model.seen.length).toBe(1);
    r.close();
  });

  test("tool-bound wake: a client attaching during the wake's tool call gets no `background_exit`", async () => {
    const r = rig();
    await detachedSession(r);
    const { promise, resolve } = Promise.withResolvers<void>();
    r.execGate.wait = promise;
    r.model.steps.push({
      events: [
        {
          type: "tool_call",
          toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "make" }) },
        },
        { type: "done" },
      ],
    });
    r.jobs.fire("j1");
    await until(() => r.execGate.calls === 1);
    const b = await r.dial();
    await b.openSession(undefined, undefined, "S");
    await tick();
    const notices: BackgroundExitNotice[] = [];
    b.onBackgroundExit((n) => notices.push(n));
    resolve();
    await until(() => r.host.get("S")?.running === false);
    await tick();
    expect(notices).toEqual([]);
    // The wake's two rounds (tool call, then the answer): one turn, no second one.
    expect(r.model.seen.length).toBe(2);
    r.close();
  });
});
