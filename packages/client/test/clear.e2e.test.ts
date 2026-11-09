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
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import type { SessionEvent } from "../src/mapping.ts";
import { type BackgroundExitNotice, RemoteClient } from "../src/remote-client.ts";
import type { SessionActivity } from "../src/remote-session.ts";

// docs/feat/clear-keeps-jobs.md, T20 (review M4): the owner's core requirement
// through the REAL stack — `SessionHost` + `Connection` + `RemoteClient`, two
// devices on one session, a fake job controller. `/clear` resets the
// conversation in place; the job keeps running, its exit lands in the SAME,
// cleared session and the next turn delivers it.
// Mutation (T20a): `this.jobs?.dispose()` in `HostedSession.clear` → no exit.

const env = {} as ExecutionEnvironment;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await sleep(2);
  expect(pred()).toBe(true);
}

class Say implements ModelProvider {
  readonly id = "say";
  readonly seen: string[][] = [];
  async *stream(r: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(r.messages.map((m) => `${m.role}:${m.note?.kind ?? ""}`));
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

class FakeJobs implements JobController {
  private readonly listeners = new Set<(j: BackgroundJob) => void>();
  running = true;
  disposed = false;
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
    return [
      {
        id: "bg-1",
        command: "npm run dev",
        startedAt: 0,
        status: this.running ? "running" : "exited",
        exitCode: null,
      },
    ];
  }
  dispose(): void {
    this.disposed = true;
  }
  onExit(l: (j: BackgroundJob) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  fire(): void {
    this.running = false;
    for (const l of [...this.listeners]) {
      l({ id: "bg-1", command: "npm run dev", startedAt: 0, status: "exited", exitCode: 0 });
    }
  }
}

async function rig(opts: { wake?: boolean } = {}) {
  const jobs = new FakeJobs();
  const model = new Say();
  const host = new SessionHost({
    defaultCwd: "/tmp/clear-e2e",
    ...(opts.wake ? { wakeOnJobExit: true } : {}),
    createAgent: () => ({
      agent: new Agent({ model, tools: new ToolRegistry(), env, jobs, systemPrompt: "sys" }),
      permissions: new PermissionBroker(),
      jobs,
    }),
  });
  const dial = async () => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const client = new RemoteClient(c, new PermissionBroker());
    await client.initialize();
    const exits: BackgroundExitNotice[] = [];
    client.onBackgroundExit((n) => exits.push(n));
    return { client, exits };
  };
  const a = await dial();
  const b = await dial();
  const sid = crypto.randomUUID();
  const sa = a.client.newSession(undefined, sid);
  const sb = b.client.newSession(undefined, sid);
  const drain = async (events: AsyncIterable<SessionEvent>) => {
    for await (const _ of events) {
      // drain
    }
  };
  await drain(sa.send("warm"));
  await drain(sb.send("b-warm"));
  const bActs: SessionActivity[] = [];
  sb.watch((x) => bActs.push(x));
  await until(() => bActs.some((x) => x.kind === "history")); // the attach's history
  bActs.length = 0;
  const aActs: SessionActivity[] = [];
  sa.watch((x) => aActs.push(x));
  await sleep(20);
  aActs.length = 0;
  return { host, jobs, model, a, b, sid, sa, sb, aActs, bActs, drain };
}

describe("T20: a job survives /clear through the real stack", () => {
  test("T20a: B sees the cleared chat; the exit streams to both on the same session; the next prompt delivers the note", async () => {
    const r = await rig();
    const result = await r.sa.clear();
    expect(result.after).toBeLessThan(result.before);
    // (1) the other device gets a `history` activity with reason `clear`.
    await until(() => r.bActs.some((x) => x.kind === "history"));
    expect(r.bActs.find((x) => x.kind === "history")).toMatchObject({
      kind: "history",
      reason: "clear",
    });
    // The cleared history names what still runs.
    const hist = r.bActs.find((x) => x.kind === "history");
    const notes = hist?.kind === "history" ? hist.messages.map((m) => m.note?.kind) : [];
    expect(notes).toContain("still_running");
    expect(r.jobs.disposed).toBe(false);

    // (2) the job's exit reaches BOTH devices, on the one session.
    r.jobs.fire();
    await until(() => r.a.exits.length === 1 && r.b.exits.length === 1);
    expect(r.a.exits[0]?.jobId).toBe("bg-1");
    expect(r.b.exits[0]?.jobId).toBe("bg-1");
    expect(r.host.get(r.sid)?.unflushedExits).toBe(1);

    // (3) the next prompt delivers it as a [background] note, in the cleared chat.
    await r.drain(r.sa.send("what happened?"));
    const sent = r.model.seen.at(-1) ?? [];
    expect(sent).toContain("user:background_exit");
    // No trace of the old chat: only [system, still_running note, exit note, prompt].
    expect(sent.filter((m) => m === "user:").length).toBe(1);
    expect(r.host.get(r.sid)?.unflushedExits).toBe(0);
  });

  test("T20b (daemon-ordered wake): a serve-style wake after a clear runs in the CLEARED chat, after the history on every device", async () => {
    const r = await rig({ wake: true });
    await r.sa.clear();
    r.jobs.fire();
    // The daemon wakes by itself (no TUI involved): each device sees the
    // cleared history FIRST, then the wake turn.
    await until(() => r.bActs.some((x) => x.kind === "turn"));
    const kinds = r.bActs.map((x) => (x.kind === "history" ? `history:${x.reason}` : x.kind));
    expect(kinds[0]).toBe("history:clear");
    expect(kinds.indexOf("turn")).toBeGreaterThan(0);
    // The wake's model call saw ONLY the cleared chat (+ the exit note).
    await until(() => r.model.seen.length >= 3);
    const wake = r.model.seen.at(-1) ?? [];
    expect(wake.filter((m) => m === "user:").length).toBe(0); // no old user prompt
    expect(wake).toContain("user:still_running");
    expect(wake).toContain("user:background_exit");
  });
});
