/**
 * The session's MCP/skill switches on the laptop (docs/feat/session-capabilities.md
 * S3b): the daemon's `capabilities` log entry reaches the laptop store — a
 * change while idle included — and `--resume` (the hop's seed path too)
 * recreates the session with them, so its first request lacks the hidden tool.
 * A session this client creates next (a `/clear` close-and-replace) starts with
 * the switches the person has now. Each test names the mutation that turns it
 * red (AGENTS §9).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SessionRecord } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, LogSessionStore, SessionHost } from "@tentacle/daemon";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { seedCapabilitiesOf } from "../src/session-capabilities.ts";
import { SessionSaver } from "../src/session-saver.ts";

const env = {} as ExecutionEnvironment;
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick();
  }
}
const drain = async (gen: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of gen) {
    // consume
  }
};

/** An MCP server's tool, tagged as the adapter tags it. */
const echoTool = { ...shellTool, name: "mcp__echo__echo", mcpServer: "echo" };
const OFF = { disabledMcp: ["echo"], disabledSkills: [], disabledTools: [] };

/** Records each request's tool names; answers "ok". */
class Recorder implements ModelProvider {
  readonly id = "recorder";
  readonly tools: string[][] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.tools.push((request.tools ?? []).map((t) => t.name));
    await tick(1);
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

function daemon() {
  const model = new Recorder();
  const host = new SessionHost({
    defaultCwd: "/tmp/work",
    createAgent: () => ({
      agent: new Agent({
        model,
        tools: new ToolRegistry().register(shellTool).register(echoTool),
        env,
      }),
      permissions: new PermissionBroker(),
    }),
  } as ConstructorParameters<typeof SessionHost>[0]);
  const [d, c] = createChannelPair();
  const connection = new Connection(d, host);
  return { host, model, channel: c, dispose: () => connection.close() };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tentacle-capabilities-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runtimeOn(
  name: string,
  d: ReturnType<typeof daemon>,
  resume: SessionRecord | null = null,
) {
  const store = new LogSessionStore(join(dir, name));
  const saver = new SessionSaver(store, () => {});
  const runtime = await createLocalRuntime({
    channel: d.channel,
    disposeTransport: d.dispose,
    permissions: new PermissionBroker(),
    saver,
    cwd: "/tmp/work",
    model: "m",
    resume,
  });
  return { store, saver, runtime };
}

async function loaded(store: LogSessionStore, id: string): Promise<SessionRecord> {
  const result = await store.load(id);
  if (result.status !== "ok") throw new Error(`${id}: ${result.status}`);
  return result.record;
}

describe("the switches reach the laptop store", () => {
  test("C1 a change made while idle (another device) is saved without a turn", async () => {
    // Mutation: no flush on a `capabilities` change in `persistingController` → the store has none.
    const d = daemon();
    const { store, saver, runtime } = await runtimeOn("idle", d);
    const ctl = runtime.createSession();
    await drain(ctl.send("hello"));
    const id = ctl.sessionId ?? "";
    await tick(20);
    await saver.drain();
    expect((await loaded(store, id)).capabilities).toBeUndefined();

    // The phone turns `echo` off while the Mac's TUI is idle.
    d.host.get(id)?.setCapability({ kind: "mcp", name: "echo", enabled: false }, "phone");
    await until(() => saver.cleanFor(id) && ctl.saveConfirmed(), 1000).catch(() => {});
    await tick(20);
    await saver.drain();
    expect((await loaded(store, id)).capabilities).toEqual(OFF);
    await runtime.dispose();
  });

  test("C2 --resume recreates the session with them: its first request lacks the tool", async () => {
    // Mutation: `build` does not pass `record.capabilities` to `newSession` → the tool is offered.
    const first = daemon();
    const a = await runtimeOn("resume", first);
    const ctl = a.runtime.createSession();
    await drain(ctl.send("hello"));
    const id = ctl.sessionId ?? "";
    first.host.get(id)?.setCapability({ kind: "mcp", name: "echo", enabled: false });
    await a.runtime.dispose();
    await a.saver.drain();
    const record = await loaded(a.store, id);
    expect(record.capabilities).toEqual(OFF);

    // A new daemon (the worker of the next launch): nothing but the laptop copy.
    const second = daemon();
    const b = await runtimeOn("resume", second, record);
    await drain(b.runtime.createSession().send("again"));
    expect(second.host.get(id)?.capabilities()).toEqual(OFF);
    expect(second.model.tools[0]).toContain("shell");
    expect(second.model.tools[0]).not.toContain("mcp__echo__echo");
    await b.runtime.dispose();
  });

  test("C3 a resume of a record with none starts with everything on (no seed sent)", async () => {
    // Mutation: always send `capabilities` (even undefined → {}) → the open is refused or seeded wrong.
    const d = daemon();
    const record: SessionRecord = {
      id: "plain",
      cwd: "/tmp/work",
      model: "m",
      createdAt: 1,
      updatedAt: 2,
      title: "q",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
    };
    const { runtime } = await runtimeOn("plain", d, record);
    await drain(runtime.createSession().send("next"));
    expect(d.host.get("plain")?.capabilities()).toEqual({
      disabledMcp: [],
      disabledSkills: [],
      disabledTools: [],
    });
    expect(d.model.tools[0]).toContain("mcp__echo__echo");
    await runtime.dispose();
  });
});

describe("a session this client creates next carries them (/clear close-and-replace)", () => {
  test("C4 seedCapabilitiesOf(previous) → the next created session starts with them", async () => {
    // Mutation: `takeSeedCapabilities` not spread into `openSession`'s frame → everything on.
    const d = daemon();
    const { runtime } = await runtimeOn("fork", d);
    const before = runtime.createSession();
    await drain(before.send("hello"));
    const firstId = before.sessionId ?? "";
    d.host.get(firstId)?.setCapability({ kind: "mcp", name: "echo", enabled: false });
    await until(() => JSON.stringify(capsOf(before)) === JSON.stringify(OFF));

    seedCapabilitiesOf(before);
    const after = runtime.createSession();
    await drain(after.send("fresh"));
    const nextId = after.sessionId ?? "";
    expect(nextId).not.toBe(firstId);
    expect(d.host.get(nextId)?.capabilities()).toEqual(OFF);
    expect(d.model.tools.at(-1)).not.toContain("mcp__echo__echo");

    // Consumed once: the session after that starts with everything on again.
    const third = runtime.createSession();
    await drain(third.send("third"));
    expect(d.host.get(third.sessionId ?? "")?.capabilities()).toEqual({
      disabledMcp: [],
      disabledSkills: [],
      disabledTools: [],
    });
    await runtime.dispose();
  });
});

/** The controller's view of the daemon's switches (`RemoteSession.capabilities`). */
function capsOf(ctl: object): unknown {
  const read = (ctl as { capabilities?: () => unknown }).capabilities;
  return typeof read === "function" ? read.call(ctl) : undefined;
}

describe("the TUI's switch path through the runtime controller (S4)", () => {
  test("C5 opened() after the first message; setCapability → onCapabilities echo; the next request lacks the tool", async () => {
    // Mutations: drop `setCapability` / `onCapabilities` / `opened` from
    // `persistingController` → the TUI sees "unsupported" (no switch column).
    const d = daemon();
    const { runtime } = await runtimeOn("s4", d);
    const ctl = runtime.createSession();
    expect(typeof ctl.setCapability).toBe("function");
    expect(ctl.opened()).toBe(false);
    await drain(ctl.send("hello"));
    expect(ctl.opened()).toBe(true);
    const seen: unknown[] = [];
    const unsubscribe = ctl.onCapabilities((caps) => seen.push(caps));
    await ctl.setCapability("mcp", "echo", false);
    await until(() => seen.length > 0);
    expect(seen.at(-1)).toEqual(OFF);
    expect(ctl.capabilities()).toEqual(OFF);
    await drain(ctl.send("next"));
    expect(d.model.tools.at(-1)).toContain("shell");
    expect(d.model.tools.at(-1)).not.toContain("mcp__echo__echo");
    unsubscribe();
    await runtime.dispose();
  });
});
