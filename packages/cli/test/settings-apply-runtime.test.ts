/**
 * `/settings` through the real runtime (docs/feat/session-settings-apply.md):
 * `createLocalRuntime` over a channel pair on a real `SessionHost`. The apply is
 * saved at once (the laptop's copy takes the new system head); other terminals
 * get their notice; a runtime that carries nothing offers no command.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, SessionGrants } from "@tentacle/agent";
import { ATTACH_TIMEOUT_MS, AttachTimeoutError } from "@tentacle/client";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, LogSessionStore, SessionHost } from "@tentacle/daemon";
import { Method, PROTOCOL_VERSION, type SessionSettings } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";

const made: string[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "settings-apply-"));
  made.push(d);
  return d;
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const env = { id: "noop" } as unknown as ExecutionEnvironment;
const quiet: ModelProvider = {
  id: "quiet",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  },
};

function makeHost(): SessionHost {
  return new SessionHost({
    defaultCwd: "/tmp/w",
    createAgent: (_cwd, context) => ({
      agent: new Agent({
        model: quiet,
        tools: new ToolRegistry(),
        env,
        systemPrompt: `prompt ${context.settings?.maxIterations ?? "-"}`,
      }),
      permissions: context.reuse?.permissions ?? new PermissionBroker(),
      grants: context.reuse?.grants ?? new SessionGrants(),
      ...(context.settings
        ? { settingsReport: { carried: context.settings, overridden: {} } }
        : {}),
    }),
  });
}

async function terminal(host: SessionHost, sessionSettings?: SessionSettings) {
  const [daemonCh, clientCh] = createChannelPair();
  new Connection(daemonCh, host);
  const notices: { text: string; hint?: string }[] = [];
  const store = new LogSessionStore(dir());
  const runtime = await createLocalRuntime({
    channel: clientCh,
    disposeTransport: () => {},
    permissions: new PermissionBroker(),
    saver: new SessionSaver(store, () => {}),
    cwd: "/tmp/w",
    model: "m",
    resume: null,
    sessionId: "S",
    notify: (text, hint) => notices.push({ text, ...(hint ? { hint } : {}) }),
    ...(sessionSettings ? { sessionSettings } : {}),
  });
  return { runtime, notices, store };
}

const drain = async (events: AsyncIterable<unknown>): Promise<void> => {
  for await (const _event of events) {
    // drain
  }
};
const until = async (pred: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2));
  }
  expect(pred()).toBe(true);
};

describe("/settings after a timed-out attach (F3)", () => {
  test("no false claim on that session; a fresh one after it keeps the plain line", async () => {
    // Mutation: drop `unconfirmed` in `build` → "it starts with this terminal's settings".
    const [daemonCh, clientCh] = createChannelPair();
    const frames: string[] = [];
    const daemon = new RpcPeer(daemonCh, {
      onRequest: (method) => {
        frames.push(method);
        if (method === Method.Open) {
          return new Promise(() => {}); // never answers
        }
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
        };
      },
    });
    let now = 0;
    let fire: () => void = () => {};
    const runtime = await createLocalRuntime({
      channel: clientCh,
      disposeTransport: () => daemon.close(),
      permissions: new PermissionBroker(),
      saver: new SessionSaver(new LogSessionStore(dir()), () => {}),
      cwd: "/tmp/w",
      model: "m",
      resume: {
        id: "S",
        createdAt: 1,
        updatedAt: 1,
        cwd: "/tmp/w",
        model: "m",
        title: { source: "auto" },
        messages: [{ role: "user", content: "hi" }],
      } as never,
      sessionSettings: { maxIterations: 3 },
      clock: {
        now: () => now,
        setTimeout: (fn: () => void, ms: number) => {
          if (ms === ATTACH_TIMEOUT_MS) fire = fn;
          return ms;
        },
        clearTimeout: () => {},
      },
    });
    const failed = runtime.attachTo("S", null).catch((e: unknown) => e);
    await until(() => frames.includes(Method.Open));
    now = ATTACH_TIMEOUT_MS;
    fire();
    expect(await failed).toBeInstanceOf(AttachTimeoutError);
    const session = runtime.createSession();
    const line = {
      text: "The session is not attached yet: it may be running with other settings, shown after your first prompt.",
    };
    expect(session.settings?.()).toEqual([line]);
    expect(await session.updateSettings?.()).toEqual([line]);
    expect(frames).not.toContain(Method.UpdateSettings);
    // `/clear`: a new id nobody else can hold.
    expect(runtime.createSession().settings?.()).toEqual([
      { text: "The session is not open yet: it starts with this terminal's settings." },
    ]);
    runtime.dispose();
  });
});

describe("/settings through the runtime", () => {
  test("not open yet; then the lines; a second terminal applies; the first one is told, in the one-line format", async () => {
    const host = makeHost();
    const a = await terminal(host, { maxIterations: 1 });
    const sessionA = a.runtime.createSession();
    expect(sessionA.settings?.()).toEqual([
      { text: "The session is not open yet: it starts with this terminal's settings." },
    ]);
    expect(await sessionA.updateSettings?.()).toEqual([
      { text: "The session is not open yet: it starts with this terminal's settings." },
    ]);
    await drain(sessionA.send("hi"));
    expect(sessionA.settings?.()).toEqual([
      { text: 'Session settings:\n{\n  "maxIterations": 1\n}' },
    ]);

    const b = await terminal(host, { maxIterations: 3 });
    expect(await b.runtime.attachTo("S", null)).toBe(true);
    const sessionB = b.runtime.createSession();
    // The drift notice, with the new way out.
    expect(b.notices).toEqual([
      {
        text: 'Session settings: { "maxIterations": 1 }',
        hint: "(/settings sync to use this terminal's values, or /clear)",
      },
    ]);
    expect(sessionB.settings?.()).toEqual([
      {
        text: 'Session settings:\n{\n  "maxIterations": 1 // this terminal: 3\n}\n1 differs from this terminal',
        hint: "(/settings sync to use this terminal's values)",
      },
    ]);
    expect(await sessionB.updateSettings?.()).toEqual([{ text: "Session settings synced." }]);
    expect(sessionB.settings?.()).toEqual([
      { text: 'Session settings:\n{\n  "maxIterations": 3\n}' },
    ]);
    await until(() => a.notices.length > 0);
    expect(a.notices).toEqual([
      { text: 'Session settings changed by another terminal: { "maxIterations": 3 }' },
    ]);
    // The applier hears only its own confirmation.
    expect(b.notices).toHaveLength(1);
    // And the first terminal's /settings follows.
    expect(sessionA.settings?.()).toEqual([
      {
        text: 'Session settings:\n{\n  "maxIterations": 3 // this terminal: 1\n}\n1 differs from this terminal',
        hint: "(/settings sync to use this terminal's values)",
      },
    ]);
    a.runtime.dispose();
    b.runtime.dispose();
  });

  test("T12 an apply is saved at once: the laptop's copy has the new head", async () => {
    // Mutation: skip `flush()` after the apply → the record keeps "prompt 1".
    const host = makeHost();
    const a = await terminal(host, { maxIterations: 1 });
    await drain(a.runtime.createSession().send("hi"));
    const b = await terminal(host, { maxIterations: 3 });
    await b.runtime.attachTo("S", null);
    const session = b.runtime.createSession();
    await session.flushed();
    await session.updateSettings?.();
    await session.flushed();
    await until(() => host.get("S") !== undefined);
    const deadline = Date.now() + 2000;
    let head: unknown;
    while (Date.now() < deadline) {
      const loaded = await b.store.load("S");
      head = loaded.status === "ok" ? loaded.record.messages[0]?.content : undefined;
      if (head === "prompt 3") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(head).toBe("prompt 3");
    a.runtime.dispose();
    b.runtime.dispose();
  });

  test("T12/T16 a runtime that carries nothing (the worker) offers no command", async () => {
    // Mutation: pass `carried` whatever `deps.sessionSettings` says.
    const { runtime } = await terminal(makeHost());
    const session = runtime.createSession();
    expect(session.settings).toBeUndefined();
    expect(session.updateSettings).toBeUndefined();
    runtime.dispose();
  });
});
