/**
 * The phone's session link (docs/feat/mobile-session-view.md 12a, plan T1–T6):
 * a REAL in-process daemon, a "laptop" client and the phone, which attaches with
 * the app's own controller + broker. Every test names the plan's case and the
 * mutation that must turn it red.
 *
 * The pattern (SessionHost + Connection + createChannelPair; the phone's frames
 * wrapped to spy on what it sends) is the client tests' own
 * (`packages/client/test/foreign-turns.test.ts`). The phone dials with an
 * injected `channelFactory` so its channel can be held (the foreground gate) —
 * `openComputer` itself, over a real WebSocket, is `connection.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { RemoteClient as Client, type RemoteClient } from "@tentacle/client";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionResponse,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost, SessionPersister } from "@tentacle/daemon";
import { Method } from "@tentacle/protocol";
import { ToolRegistry, fsWriteTool } from "@tentacle/tools";
import { type DuplexChannel, RpcError, createChannelPair } from "@tentacle/transport";
import { SpyDaemonStore } from "../../../packages/daemon/test/support/daemon-store-spy.ts";
import { createLinkBroker, leaveComputer } from "../src/connection.ts";
import { createForegroundGate } from "../src/foreground-gate.ts";
import { createSessionController } from "../src/session-controller.ts";

const CWD = "/tmp/mobile-session-link";
const WRITE_PATH = `${CWD}/a.txt`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for `check` to hold; throws nothing (the assertion that follows reports). */
async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) {
    await sleep(5);
  }
}

interface Frame {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

/** The daemon's model: `hi` answers; `ask` calls `fs_write` (an `ask` tool); `wait` calls it after a gate. */
class PromptModel implements ModelProvider {
  readonly id = "prompted";
  private gates: (() => void)[] = [];
  waiting = 0;
  open(): void {
    for (const r of this.gates.splice(0)) r();
  }
  private gate(signal?: AbortSignal): Promise<void> {
    this.waiting++;
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.waiting--;
        resolve();
      };
      this.gates.push(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const last = request.messages.at(-1);
    const prompt = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (last?.role === "tool") {
      yield { type: "text", delta: `tool said: ${last.content}` };
    } else if (prompt === "ask" || prompt === "wait") {
      if (prompt === "wait") {
        await this.gate(request.signal);
      }
      yield {
        type: "tool_call",
        toolCall: {
          id: `c-${prompt}`,
          name: "fs_write",
          arguments: JSON.stringify({ path: WRITE_PATH, content: "hi" }),
        },
      };
    } else {
      yield { type: "text", delta: `ok:${prompt}` };
    }
    yield { type: "done" };
  }
}

/** One in-process `serve`-shaped daemon: it persists, so a closed session is ARCHIVED (kept), not gone. */
function daemon() {
  const model = new PromptModel();
  const written: string[] = [];
  const env = {
    id: "e",
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    readFile: async () => "",
    writeFile: async (path: string) => {
      written.push(path);
    },
  } as unknown as ExecutionEnvironment;
  const host = new SessionHost({
    defaultCwd: CWD,
    persister: new SessionPersister({
      store: new SpyDaemonStore(),
      cwd: CWD,
      model: "m",
      onError: () => {},
    }),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(fsWriteTool),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  return { host, model, written };
}

type Daemon = ReturnType<typeof daemon>;

/**
 * A client. `frames` is what it SENT (the spy T1/T4 read). With `gate` its
 * `channelFactory` is the app's foreground gate (T5/T6) — including its FIRST
 * dial, as `openComputer` does — so `suspend`/`resume` behave exactly as on the
 * phone. `errors` collects what its `onError` saw.
 */
async function dial(
  d: Daemon,
  broker: PermissionBroker = new PermissionBroker(),
  o: { readonly gate?: boolean } = {},
) {
  const frames: Frame[] = [];
  const errors: Error[] = [];
  const connect = (): DuplexChannel => {
    const [server, client] = createChannelPair();
    // The `ws-server` closes a socket's `Connection` when it goes away, which is
    // what DETACHES that client's sessions; an in-memory pair has no server, so
    // this harness does it, exactly there. Without it a closed client would
    // stay "attached" and no test could see a detach.
    let connection: Connection | null = null;
    const serverEnd: DuplexChannel = {
      send: (data) => server.send(data),
      close: () => server.close(),
      setOnMessage: (h) => server.setOnMessage(h),
      setOnClose: (h) =>
        server.setOnClose(() => {
          h();
          connection?.close();
        }),
    };
    connection = new Connection(serverEnd, d.host);
    return {
      send: (data) => {
        frames.push(JSON.parse(data) as Frame);
        client.send(data);
      },
      close: () => client.close(),
      setOnMessage: (h) => client.setOnMessage(h),
      setOnClose: (h) => client.setOnClose(h),
    };
  };
  const foreground = o.gate === true ? createForegroundGate(async () => connect()) : null;
  const first = foreground === null ? connect() : await foreground.dial();
  const client = new Client(first, broker, undefined, {
    channelFactory: foreground === null ? async () => connect() : foreground.dial,
    random: () => 0,
    onError: (error) => errors.push(error),
  });
  return {
    client,
    frames,
    errors,
    suspend: () => foreground?.suspend(),
    resume: () => foreground?.resume(),
  };
}

/** `session/list`'s entry for `sid` (the daemon's truth), or undefined when it has none. */
async function entryOf(client: RemoteClient, sid: string) {
  const page = await client.sessionList({ limit: 50 });
  return page.sessions.find((s) => s.sessionId === sid);
}

const methods = (frames: readonly Frame[]): string[] =>
  frames.flatMap((f) => (f.method === undefined ? [] : [f.method]));

/** Seed one live session from a laptop client; returns its id. */
async function seeded(laptop: Awaited<ReturnType<typeof dial>>): Promise<string> {
  const sid = crypto.randomUUID();
  const session = laptop.client.newSession(undefined, sid);
  for await (const _event of session.send("hi")) {
    // drain: the session is then live
  }
  return sid;
}

/** The phone, ready to attach through the app's own controller. */
async function phoneOf(d: Daemon, broker: PermissionBroker, o: { readonly gate?: boolean } = {}) {
  const phone = await dial(d, broker, o);
  const controller = createSessionController({
    newSession: (id, options) =>
      phone.client.newSession(undefined, id, undefined, {
        attach: options.reopen === true ? { reopen: true } : {},
      }),
  });
  return { ...phone, controller };
}

/** Run a turn in the background, swallowing its rejection (a close mid-turn). */
function runTurn(
  laptop: Awaited<ReturnType<typeof dial>>,
  sid: string,
  prompt: string,
  onEvent?: (event: { type: string }) => void,
): { done: Promise<void> } {
  const session = laptop.client.newSession(undefined, sid);
  const done = (async () => {
    try {
      for await (const event of session.send(prompt)) {
        onEvent?.(event);
      }
    } catch {
      // the test's own close: nothing to report
    }
  })();
  return { done };
}

describe("the phone's session link over a real daemon", () => {
  test("T1 the app's broker with no requester HOLDS the ask: the phone sends no resolve_permission (mutation: denyAll → red)", async () => {
    const d = daemon();
    const laptop = await dial(d, new PermissionBroker(() => new Promise(() => {})));
    // The app's OWN broker (not a copy): `holdUntilSet`, no requester — the
    // sheet is not mounted yet. Mutation: `denyAll` there → this test is red.
    const phone = await phoneOf(d, createLinkBroker());
    await laptop.client.initialize();
    await phone.client.initialize();
    const sid = await seeded(laptop);
    expect((await phone.controller.open(sid)).ok).toBe(true);
    let ended = false;
    runTurn(laptop, sid, "ask").done.then(() => {
      ended = true;
    });
    await sleep(200);
    expect(ended).toBe(false); // the ask is pending: the turn did not finish
    expect(d.written).toEqual([]); // the tool did not run (nobody approved it)
    expect(methods(phone.frames)).not.toContain(Method.ResolvePermission);
    expect((await entryOf(laptop.client, sid))?.running).toBe(true);
    await phone.controller.leave(sid);
    laptop.client.close();
    phone.client.close();
  });

  test("T2 a requester that allows runs the tool once; a losing second answer is silent PermissionNotPending", async () => {
    const d = daemon();
    // The laptop's own user answers too, but only after the phone did: the
    // loser must be a silent no-op, never an error and never a second run.
    let laptopAnswers = 0;
    const laptopBroker = new PermissionBroker(async (): Promise<PermissionResponse> => {
      await until(() => phoneAnswered > 0);
      laptopAnswers += 1;
      return { allowed: true };
    });
    const laptop = await dial(d, laptopBroker);
    const phoneBroker = new PermissionBroker(undefined, { holdUntilSet: true });
    let phoneAnswered = 0;
    phoneBroker.setRequester(async (): Promise<PermissionResponse> => {
      phoneAnswered += 1;
      return { allowed: true };
    });
    const phone = await phoneOf(d, phoneBroker);
    await laptop.client.initialize();
    await phone.client.initialize();
    const sid = await seeded(laptop);
    expect((await phone.controller.open(sid)).ok).toBe(true);
    const results: string[] = [];
    await runTurn(laptop, sid, "ask", (event) => {
      const typed = event as { type: string; name?: string; result?: { isError?: boolean } };
      if (typed.type === "tool_result") {
        results.push(`${typed.name}:${typed.result?.isError === true ? "error" : "ok"}`);
      }
    }).done;
    expect(results).toEqual(["fs_write:ok"]);
    expect(phoneAnswered).toBe(1);
    expect(d.written).toEqual([WRITE_PATH]); // exactly once
    await until(() => laptopAnswers === 1);
    expect(laptopAnswers).toBe(1); // it did answer — and the daemon said "not pending"
    expect(phone.errors).toEqual([]); // swallowed: nothing for a sheet to report
    expect(laptop.errors).toEqual([]);
    await phone.controller.leave(sid);
    laptop.client.close();
    phone.client.close();
  });

  test("T3 leaving the screen detaches: the session stays live for the laptop, turn still running (mutation: close() → red)", async () => {
    const d = daemon();
    const laptop = await dial(d, new PermissionBroker(() => new Promise(() => {})));
    const phone = await phoneOf(d, new PermissionBroker(undefined, { holdUntilSet: true }));
    await laptop.client.initialize();
    await phone.client.initialize();
    const sid = await seeded(laptop);
    expect((await phone.controller.open(sid)).ok).toBe(true);
    expect((await entryOf(laptop.client, sid))?.attached).toBe(2);
    runTurn(laptop, sid, "wait");
    await until(() => d.model.waiting === 1);
    expect(d.model.waiting).toBe(1);
    await phone.controller.leave(sid);
    const after = await entryOf(laptop.client, sid);
    expect(after?.archived).toBe(false); // NOT ended
    expect(after?.attached).toBe(1); // the phone is gone
    expect(after?.running).toBe(true); // the laptop's turn runs on
    expect(methods(phone.frames)).toContain(Method.Detach);
    expect(methods(phone.frames)).not.toContain(Method.Close);
    d.model.open();
    laptop.client.close();
    phone.client.close();
  });

  test("T4 the app's exit path sends no session/close: the last client leaving keeps the session (mutation: closeSessions() → red)", async () => {
    const d = daemon();
    const laptop = await dial(d);
    const phone = await phoneOf(d, new PermissionBroker(undefined, { holdUntilSet: true }));
    await laptop.client.initialize();
    await phone.client.initialize();
    const sid = await seeded(laptop);
    expect((await phone.controller.open(sid)).ok).toBe(true);
    // The laptop leaves the same way, so the phone becomes the LAST attached
    // client — exactly the case where 11a's `closeSessions()` ended the session.
    await leaveComputer(laptop.client);
    const observer = await dial(d);
    await observer.client.initialize();
    await until(async () => (await entryOf(observer.client, sid))?.attached === 1);
    expect((await entryOf(observer.client, sid))?.attached).toBe(1);
    // The app's OWN exit path (mutation: `closeSessions()` there → this test is
    // red as the phone is the last attached client).
    await leaveComputer(phone.client);
    expect(methods(phone.frames)).not.toContain(Method.Close);
    await until(async () => (await entryOf(observer.client, sid))?.attached === 0);
    const after = await entryOf(observer.client, sid);
    expect(after?.archived).toBe(false); // kept, live, unarchived
    expect(after?.attached).toBe(0); // nobody attached: the idle TTL's business
    observer.client.close();
  });

  test("T5 suspend → the daemon sees the detach; the ask raised meanwhile reaches the requester exactly once after resume (mutation: resume does not release → red)", async () => {
    const d = daemon();
    const laptop = await dial(d, new PermissionBroker(() => new Promise(() => {})));
    const phoneBroker = new PermissionBroker(undefined, { holdUntilSet: true });
    const asked: string[] = [];
    phoneBroker.setRequester(async (req): Promise<PermissionResponse> => {
      asked.push((req as unknown as { title: string }).title);
      return { allowed: true };
    });
    const phone = await phoneOf(d, phoneBroker, { gate: true });
    await laptop.client.initialize();
    await phone.client.initialize();
    const sid = await seeded(laptop);
    expect((await phone.controller.open(sid)).ok).toBe(true);
    expect((await entryOf(laptop.client, sid))?.attached).toBe(2);
    // The app leaves the foreground: the gate closes the socket → the daemon
    // detaches this client.
    phone.suspend();
    await until(async () => (await entryOf(laptop.client, sid))?.attached === 1);
    expect((await entryOf(laptop.client, sid))?.attached).toBe(1);
    // A turn asks while the phone is away (the laptop's own user never answers).
    runTurn(laptop, sid, "ask");
    await sleep(150);
    expect(asked).toEqual([]); // not attached: nothing reached the phone
    expect(d.written).toEqual([]);
    // Foreground again: the client redials, re-attaches, and the still-pending
    // ask is re-offered to the phone's requester — exactly once.
    phone.resume();
    await until(() => asked.length > 0);
    expect(asked).toHaveLength(1);
    await until(() => d.written.length > 0);
    await sleep(150);
    expect(asked).toHaveLength(1); // a replay never asks twice
    expect(d.written).toEqual([WRITE_PATH]); // answered: the tool ran once
    laptop.client.close();
    phone.client.close();
  });

  test("T6 an answer given just before suspend is delivered once after resume, never lost", async () => {
    const d = daemon();
    const laptop = await dial(d, new PermissionBroker(() => new Promise(() => {})));
    const phoneBroker = new PermissionBroker(undefined, { holdUntilSet: true });
    const phone = await phoneOf(d, phoneBroker, { gate: true });
    let asked = 0;
    phoneBroker.setRequester(async (): Promise<PermissionResponse> => {
      asked += 1;
      // Answered, then the app leaves the foreground at once: the answer is
      // still on its way (the client holds it, keyed by requestId).
      queueMicrotask(() => phone.suspend());
      return { allowed: true };
    });
    await laptop.client.initialize();
    await phone.client.initialize();
    const sid = await seeded(laptop);
    expect((await phone.controller.open(sid)).ok).toBe(true);
    const turn = runTurn(laptop, sid, "ask");
    // The ask reached the phone, it answered, and the gate closed the socket.
    await until(() => asked > 0);
    await sleep(150);
    expect((await entryOf(laptop.client, sid))?.running).toBe(true); // still pending
    // Foreground again: the redial re-attaches and the held answer is sent.
    phone.resume();
    await turn.done;
    expect(d.written).toEqual([WRITE_PATH]); // the tool ran
    const answers = phone.frames.filter((f) => f.method === Method.ResolvePermission);
    expect(answers.length).toBeGreaterThanOrEqual(1);
    await sleep(150);
    expect(d.written).toEqual([WRITE_PATH]); // and only once, however many re-sends
    expect(phone.errors).toEqual([]);
    laptop.client.close();
    phone.client.close();
  });

  test("an archived session is not attached without reopen: a typed reason, then reopen attaches it", async () => {
    const d = daemon();
    const laptop = await dial(d);
    await laptop.client.initialize();
    const sid = await seeded(laptop);
    // End it: the close of its only client archives it (this daemon persists).
    await laptop.client.closeSessions();
    await leaveComputer(laptop.client);
    const phone = await phoneOf(d, new PermissionBroker(undefined, { holdUntilSet: true }));
    await phone.client.initialize();
    expect(await phone.controller.open(sid)).toEqual({ ok: false, reason: "archived" });
    // The person's explicit Reopen does attach it.
    expect((await phone.controller.open(sid, { reopen: true })).ok).toBe(true);
    expect((await entryOf(phone.client, sid))?.archived).toBe(false);
    await phone.controller.leave(sid);
    phone.client.close();
  });
});
