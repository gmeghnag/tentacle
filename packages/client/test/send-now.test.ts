import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { JsonRpcErrorCode, Method, Notification, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { DomainErrorCode, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";

// `RemoteSession.sendNow` / `RemoteClient.sendNow` (docs/feat/send-now-b.md).

/** Round 1 of "go" calls a tool; every other round echoes the last message. */
const echoModel = (seen: string[][]): ModelProvider => ({
  id: "echo",
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const messages = request.messages.map((m) => m.content);
    seen.push(messages);
    if (messages.at(-1) === "go") {
      yield {
        type: "tool_call",
        toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "ls" }) },
      };
    } else {
      yield { type: "text", delta: `echo:${messages.at(-1) ?? ""}` };
    }
    yield { type: "done" };
  },
});

/** An env whose exec holds until `release()`: the turn sits in its tool. */
function gatedEnv() {
  let release = (): void => {};
  let running = false;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const env: ExecutionEnvironment = {
    id: "gated",
    async exec() {
      running = true;
      await gate;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
    readFile: () => Promise.resolve(""),
    writeFile: () => Promise.resolve(),
  };
  return { env, release, running: () => running };
}

function realDaemon(model: ModelProvider, env: ExecutionEnvironment) {
  const host = new SessionHost({
    defaultCwd: "/tmp/send-now-work",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(shellTool),
        env,
        requestPermission: (req) => permissions.request(req),
      });
      return { agent, permissions };
    },
  });
  const [daemonCh, clientCh] = createChannelPair();
  new Connection(daemonCh, host);
  return clientCh;
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

/** Drain `iter` into `into`; resolves "ended", the error it threw, or "hung". */
function drain(
  iter: AsyncIterable<SessionEvent>,
  into: SessionEvent[],
  timeoutMs = 2000,
): Promise<unknown> {
  return Promise.race([
    (async () => {
      for await (const e of iter) into.push(e);
      return "ended";
    })().catch((e: unknown) => e),
    new Promise((r) => setTimeout(() => r("hung"), timeoutMs)),
  ]);
}

const texts = (events: readonly SessionEvent[]): string[] =>
  events.flatMap((e) => (e.type === "text" ? [e.delta] : []));

/**
 * A raw daemon: acks `prompt`, records `enqueue`s and cancels, and answers
 * `send_now` with `onSendNow` (which may stream through `notify` first, as the
 * real daemon does when the slot is already free). `requests` lists every
 * method that reached it. `onSnapshot(seq)` answers `session/snapshot` (`seq`:
 * the last update sent, the cut).
 */
function scriptedDaemon(
  onSendNow?: (params: { turnId: string }, notify: (update: unknown) => void) => unknown,
  opts: { readonly onSnapshot?: (seq: number) => unknown } = {},
) {
  const [daemonCh, clientCh] = createChannelPair();
  let seq = 0;
  const enqueues: { sessionId: string; id: string; turnId: string; text: string }[] = [];
  const sendNows: unknown[] = [];
  const requests: string[] = [];
  let promptTurn = "";
  const notify = (update: unknown, mandatory = true): void =>
    daemon.notify(Notification.SessionUpdate, {
      sessionId: "s1",
      seq: ++seq,
      ...(mandatory ? { mandatory: true } : {}),
      update,
    });
  const daemon: RpcPeer = new RpcPeer(daemonCh, {
    onRequest: async (method, params) => {
      requests.push(method);
      if (method === Method.Snapshot && opts.onSnapshot) {
        return opts.onSnapshot(seq);
      }
      if (method === Method.Initialize) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
          skills: [],
        };
      }
      if (method === Method.Open) {
        return { sessionId: "s1", epoch: "e", created: true, resync: false };
      }
      if (method === Method.Prompt) {
        promptTurn = (params as { turnId: string }).turnId;
        setTimeout(() => notify({ type: "turn_start", turnId: promptTurn, prompt: "go" }));
        return { turnId: promptTurn };
      }
      if (method === Method.Enqueue) {
        enqueues.push(params as (typeof enqueues)[number]);
        return {};
      }
      if (method === Method.SendNow && onSendNow) {
        sendNows.push(params);
        return onSendNow(params as { turnId: string }, notify);
      }
      throw new RpcError(JsonRpcErrorCode.MethodNotFound, `unknown method: ${method}`);
    },
  });
  return { clientCh, enqueues, sendNows, requests, notify, promptTurn: () => promptTurn, daemon };
}

describe("RemoteSession.sendNow — the hand-off on the stream", () => {
  test("T-B1: the successor streams to the new iterable, the old turn's tail to the old one", async () => {
    const seen: string[][] = [];
    const gated = gatedEnv();
    const client = new RemoteClient(realDaemon(echoModel(seen), gated.env), new PermissionBroker());
    await client.initialize();
    const session = client.newSession();

    const oldEvents: SessionEvent[] = [];
    const oldDone = drain(session.send("go"), oldEvents);
    expect(await waitFor(gated.running)).toBe(true);

    // Acked while T1 still unwinds (a reservation daemon-side).
    const events = await session.sendNow([{ id: "a", text: "A" }], "turn");
    // T1's tail (its tool result, its turn_end) streams only now: AFTER the ack.
    gated.release();
    const newEvents: SessionEvent[] = [];
    expect(await drain(events, newEvents)).toBe("ended");
    expect(await oldDone).toBe("ended");

    expect(oldEvents.some((e) => e.type === "tool_result")).toBe(true);
    expect(oldEvents.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect(texts(oldEvents)).toEqual([]); // no successor event leaked into it
    expect(newEvents).toEqual([
      { type: "user_message", text: "A" },
      { type: "text", delta: "echo:A" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    client.close();
  });

  test("T-B2: the old turn ended on its own before the ack — the successor is still routed", async () => {
    // The real daemon's order when the slot is already free: the old
    // `turn_end`, then the successor's whole start, then the ack.
    const d = scriptedDaemon(({ turnId }, notify) => {
      notify({ type: "turn_end", turnId: d.promptTurn(), stopReason: "end_turn" });
      notify({ type: "turn_start", turnId, prompt: "A" });
      notify({ type: "agent_message_chunk", content: { type: "text", text: "ok" } });
      notify({ type: "turn_end", turnId, stopReason: "end_turn" });
      return { turnId };
    });
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const oldEvents: SessionEvent[] = [];
    const oldDone = drain(session.send("go"), oldEvents);
    expect(await waitFor(() => d.promptTurn() !== "")).toBe(true);

    const events = await session.sendNow([{ id: "a", text: "A" }], "turn");
    const newEvents: SessionEvent[] = [];
    expect(await drain(events, newEvents)).toBe("ended");
    expect(await oldDone).toBe("ended");
    expect(oldEvents).toEqual([{ type: "turn_end", reason: "end_turn" }]);
    expect(newEvents).toEqual([
      { type: "user_message", text: "A" },
      { type: "text", delta: "ok" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    client.close();
  });

  test('a continuation (prompt "") shows no user_message', async () => {
    const d = scriptedDaemon(({ turnId }, notify) => {
      notify({ type: "turn_end", turnId: d.promptTurn(), stopReason: "end_turn" });
      notify({ type: "turn_start", turnId, prompt: "" });
      notify({ type: "turn_end", turnId, stopReason: "end_turn" });
      return { turnId };
    });
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const oldDone = drain(session.send("go"), []);
    expect(await waitFor(() => d.promptTurn() !== "")).toBe(true);
    const newEvents: SessionEvent[] = [];
    expect(await drain(await session.sendNow([{ id: "a", text: "A" }], "turn"), newEvents)).toBe(
      "ended",
    );
    expect(await oldDone).toBe("ended");
    expect(newEvents).toEqual([{ type: "turn_end", reason: "end_turn" }]);
    client.close();
  });

  test("T-B3: Esc before the successor started → its events reject Cancelled, nothing shown", async () => {
    const seen: string[][] = [];
    const gated = gatedEnv();
    const client = new RemoteClient(realDaemon(echoModel(seen), gated.env), new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const oldDone = drain(session.send("go"), []);
    expect(await waitFor(gated.running)).toBe(true);

    const esc = new AbortController();
    const events = await session.sendNow([{ id: "a", text: "A" }], "turn", esc.signal);
    esc.abort(); // the window: T1 still unwinds, the successor is only reserved
    await new Promise((r) => setTimeout(r, 20)); // the cancel reaches the daemon
    gated.release();
    const newEvents: SessionEvent[] = [];
    expect(await drain(events, newEvents)).toMatchObject({ code: DomainErrorCode.Cancelled });
    expect(await oldDone).toBe("ended");
    expect(newEvents).toEqual([]);
    expect(seen.flat()).not.toContain("A"); // the model never saw it
    client.close();
  });

  test("T-B4: an older daemon (MethodNotFound) → rejects; the old turn and its steering are untouched", async () => {
    const d = scriptedDaemon(); // no send_now
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const oldEvents: SessionEvent[] = [];
    const oldDone = drain(session.send("go"), oldEvents);
    expect(await waitFor(() => d.promptTurn() !== "")).toBe(true);

    await expect(session.sendNow([{ id: "a", text: "A" }], "turn")).rejects.toMatchObject({
      code: JsonRpcErrorCode.MethodNotFound,
    });
    // The refused turn was discarded (review finding 1): a second send-now in
    // the same turn reaches the daemon (not a local TurnInProgress).
    await expect(session.sendNow([{ id: "b", text: "B" }], "turn")).rejects.toMatchObject({
      code: JsonRpcErrorCode.MethodNotFound,
    });
    expect(d.requests.filter((m) => m === Method.SendNow)).toHaveLength(2);
    // The fallback path still works: steering binds to the old turn.
    await session.enqueue("A", "a");
    expect(d.enqueues).toEqual([{ sessionId: "s1", id: "a", turnId: d.promptTurn(), text: "A" }]);
    d.notify({ type: "agent_message_chunk", content: { type: "text", text: "still T1" } });
    d.notify({ type: "turn_end", turnId: d.promptTurn(), stopReason: "end_turn" });
    expect(await oldDone).toBe("ended");
    expect(texts(oldEvents)).toEqual(["still T1"]);
    // Nor was it installed at the old turn's end: steering still names T1.
    await session.enqueue("late", "l");
    expect(d.enqueues.at(-1)).toMatchObject({ id: "l", turnId: d.promptTurn() });
    client.close();
  });

  test("a refusal after the hand-off (NoTurnRunning) rejects, and the old turn still ends cleanly", async () => {
    const d = scriptedDaemon((_, notify) => {
      notify({ type: "turn_end", turnId: d.promptTurn(), stopReason: "end_turn" });
      throw new RpcError(DomainErrorCode.NoTurnRunning, "no turn is running");
    });
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const oldDone = drain(session.send("go"), []);
    expect(await waitFor(() => d.promptTurn() !== "")).toBe(true);
    await expect(session.sendNow([{ id: "a", text: "A" }], "turn")).rejects.toMatchObject({
      code: DomainErrorCode.NoTurnRunning,
    });
    expect(await oldDone).toBe("ended");
    client.close();
  });

  test("local refusals send nothing: no messages, no turn, a send-now already waiting", async () => {
    const d = scriptedDaemon(({ turnId }) => ({ turnId })); // acks, never hands over
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    await expect(session.sendNow([{ id: "a", text: "A" }], "turn")).rejects.toMatchObject({
      code: DomainErrorCode.NoTurnRunning, // no session yet
    });
    const oldDone = drain(session.send("go"), [], 300);
    expect(await waitFor(() => d.promptTurn() !== "")).toBe(true);
    await expect(session.sendNow([], "turn")).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
    await session.sendNow([{ id: "a", text: "A" }], "turn");
    await expect(session.sendNow([{ id: "b", text: "B" }], "turn")).rejects.toMatchObject({
      code: DomainErrorCode.TurnInProgress,
    });
    expect(d.sendNows).toHaveLength(1);
    expect(d.sendNows[0]).toMatchObject({
      interrupt: { kind: "turn", turnId: d.promptTurn() },
      messages: [{ id: "a", text: "A" }],
    });
    // Until the old turn ends, steering still binds to it.
    await session.enqueue("C", "c");
    expect(d.enqueues.at(-1)).toMatchObject({ id: "c", turnId: d.promptTurn() });
    expect(await oldDone).toBe("hung");
    client.close();
  });

  test("after the hand-off, steering binds to the successor", async () => {
    let successor = "";
    const d = scriptedDaemon(({ turnId }, notify) => {
      successor = turnId;
      notify({ type: "turn_end", turnId: d.promptTurn(), stopReason: "cancelled" });
      notify({ type: "turn_start", turnId, prompt: "A" });
      return { turnId };
    });
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const oldDone = drain(session.send("go"), []);
    expect(await waitFor(() => d.promptTurn() !== "")).toBe(true);
    const events = await session.sendNow([{ id: "a", text: "A" }], "turn");
    expect(await oldDone).toBe("ended");
    await session.enqueue("B", "b");
    expect(d.enqueues).toEqual([{ sessionId: "s1", id: "b", turnId: successor, text: "B" }]);
    d.notify({ type: "turn_end", turnId: successor, stopReason: "end_turn" });
    expect(await drain(events, [])).toBe("ended");
    client.close();
  });
});

// Follow-up 1 of task c (owner principle: the client never guesses what the
// daemon knows). With no live turn client-side the request still goes out,
// naming the last-known turn: the daemon decides (a turn with the undelivered
// texts, a continuation, or `NoTurnRunning`).
describe("RemoteSession.sendNow — no client-side guess", () => {
  test("CF-1: the old turn already ended client-side → send_now still reaches the daemon, interrupt = the last turn", async () => {
    const d = scriptedDaemon(({ turnId }, notify) => {
      notify({ type: "turn_start", turnId, prompt: "A" });
      notify({ type: "turn_end", turnId, stopReason: "end_turn", delivered: true });
      return { turnId };
    });
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const oldDone = drain(session.send("go"), []);
    expect(await waitFor(() => d.promptTurn() !== "")).toBe(true);
    d.notify({ type: "turn_end", turnId: d.promptTurn(), stopReason: "end_turn" });
    expect(await oldDone).toBe("ended");

    const newEvents: SessionEvent[] = [];
    expect(await drain(await session.sendNow([{ id: "a", text: "A" }], "turn"), newEvents)).toBe(
      "ended",
    );
    expect(d.sendNows).toHaveLength(1);
    expect(d.sendNows[0]).toMatchObject({
      interrupt: { kind: "turn", turnId: d.promptTurn() },
      messages: [{ id: "a", text: "A" }],
    });
    expect(newEvents).toEqual([
      { type: "user_message", text: "A" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    client.close();
  });

  test("CF-2: the daemon's NoTurnRunning (nothing to answer) is what rejects, not a local guess", async () => {
    const d = scriptedDaemon(() => {
      throw new RpcError(DomainErrorCode.NoTurnRunning, "no turn is running");
    });
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const oldDone = drain(session.send("go"), []);
    expect(await waitFor(() => d.promptTurn() !== "")).toBe(true);
    d.notify({ type: "turn_end", turnId: d.promptTurn(), stopReason: "end_turn" });
    expect(await oldDone).toBe("ended");
    await expect(session.sendNow([{ id: "a", text: "A" }], "turn")).rejects.toMatchObject({
      code: DomainErrorCode.NoTurnRunning,
    });
    expect(d.sendNows).toHaveLength(1);
    // Refused: left as before — steering still names the last turn.
    await session.enqueue("B", "b");
    expect(d.enqueues.at(-1)).toMatchObject({ id: "b", turnId: d.promptTurn() });
    client.close();
  });

  test("CF-3: the first send is still opening the session → the request waits for it and interrupts that turn", async () => {
    const d = scriptedDaemon(({ turnId }, notify) => {
      notify({ type: "turn_end", turnId: d.promptTurn(), stopReason: "cancelled" });
      notify({ type: "turn_start", turnId, prompt: "A" });
      notify({ type: "turn_end", turnId, stopReason: "end_turn", delivered: true });
      return { turnId };
    });
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const oldDone = drain(session.send("go"), []); // runs up to the open's await
    const newEvents: SessionEvent[] = [];
    expect(await drain(await session.sendNow([{ id: "a", text: "A" }], "turn"), newEvents)).toBe(
      "ended",
    );
    expect(await oldDone).toBe("ended");
    expect(d.requests.filter((m) => m !== Method.Initialize)).toEqual([
      Method.Open,
      Method.Prompt,
      Method.SendNow,
    ]);
    expect(d.sendNows[0]).toMatchObject({ interrupt: { kind: "turn", turnId: d.promptTurn() } });
    expect(newEvents.at(0)).toEqual({ type: "user_message", text: "A" });
    client.close();
  });

  test("CF-4: close() while the first send is still opening → sendNow rejects UnknownSession, nothing sent", async () => {
    // Review finding 3 (mutation M-R1: no `closed` re-check after the open).
    const d = scriptedDaemon(({ turnId }) => ({ turnId }));
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    void drain(session.send("go"), [], 300); // runs up to the open's await
    const refused = session.sendNow([{ id: "a", text: "A" }], "turn");
    session.close(); // during the open
    await expect(refused).rejects.toMatchObject({ code: DomainErrorCode.UnknownSession });
    await new Promise((r) => setTimeout(r, 20));
    expect(d.sendNows).toHaveLength(0);
    client.close();
  });

  test("CF-5: a refusal's `data` (what the daemon holds) reaches the caller untouched", async () => {
    const d = scriptedDaemon(() => {
      throw new RpcError(DomainErrorCode.TurnInProgress, "a send-now is already waiting", {
        held: ["a"],
      });
    });
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    void drain(session.send("go"), [], 300);
    expect(await waitFor(() => d.promptTurn() !== "")).toBe(true);
    await expect(
      session.sendNow(
        [
          { id: "a", text: "A" },
          { id: "b", text: "B" },
        ],
        "turn",
      ),
    ).rejects.toMatchObject({ code: DomainErrorCode.TurnInProgress, data: { held: ["a"] } });
    client.close();
  });
});

// Follow-up 1 (owner decision 2026-10-23): whether a send-now turn delivered
// its texts is the daemon's fact (`delivered` on its end), never inferred from
// a `turn_start` the client may not have seen. Absent (an older daemon): the
// old inference, restore over loss.
describe("RemoteSession.sendNow — `delivered` decides, not a seen turn_start", () => {
  /** The old turn ends, then the successor's end arrives via `via`, with no `turn_start` seen. */
  async function hiddenStart(via: "ack" | "stream", delivered: boolean | undefined) {
    const end = {
      stopReason: "cancelled",
      ...(delivered !== undefined ? { delivered } : {}),
    };
    const d = scriptedDaemon(({ turnId }, notify) => {
      notify({ type: "turn_end", turnId: d.promptTurn(), stopReason: "cancelled" });
      if (via === "stream") {
        notify({ type: "turn_end", turnId, ...end });
        return { turnId };
      }
      return { turnId, ended: end }; // a retried send-now's ack after an outage
    });
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const oldDone = drain(session.send("go"), []);
    expect(await waitFor(() => d.promptTurn() !== "")).toBe(true);
    const newEvents: SessionEvent[] = [];
    const outcome = await drain(await session.sendNow([{ id: "a", text: "A" }], "turn"), newEvents);
    expect(await oldDone).toBe("ended");
    client.close();
    return { outcome, newEvents };
  }

  for (const via of ["ack", "stream"] as const) {
    test(`${via}: delivered: true → the turn ends cancelled; the texts are NOT restored (no duplicate)`, async () => {
      const r = await hiddenStart(via, true);
      expect(r.outcome).toBe("ended");
      expect(r.newEvents).toEqual([{ type: "turn_end", reason: "cancelled" }]);
    });

    test(`${via}: delivered: false → Cancelled (restore)`, async () => {
      const r = await hiddenStart(via, false);
      expect(r.outcome).toMatchObject({ code: DomainErrorCode.Cancelled });
      expect(r.newEvents).toEqual([]);
    });

    test(`${via}: no field (an older daemon) → the inference: unstarted + cancelled → Cancelled`, async () => {
      const r = await hiddenStart(via, undefined);
      expect(r.outcome).toMatchObject({ code: DomainErrorCode.Cancelled });
    });
  }

  test("delivered: false wins over a seen turn_start", async () => {
    // Defensive: the fact beats the inference in both directions.
    const d = scriptedDaemon(({ turnId }, notify) => {
      notify({ type: "turn_end", turnId: d.promptTurn(), stopReason: "cancelled" });
      notify({ type: "turn_start", turnId, prompt: "A" });
      notify({ type: "turn_end", turnId, stopReason: "cancelled", delivered: false });
      return { turnId };
    });
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const oldDone = drain(session.send("go"), []);
    expect(await waitFor(() => d.promptTurn() !== "")).toBe(true);
    const outcome = await drain(await session.sendNow([{ id: "a", text: "A" }], "turn"), []);
    expect(outcome).toMatchObject({ code: DomainErrorCode.Cancelled });
    expect(await oldDone).toBe("ended");
    client.close();
  });
});

describe("RemoteSession.sendNow — review follow-up 2", () => {
  test("finding 2: older daemon (no `delivered`) — a reset naming the successor marks it started: its cancel restores nothing", async () => {
    // The successor's `turn_start` is never seen: a barrier makes the client
    // resync, and the snapshot says the successor runs at the cut.
    let successor = "";
    const d = scriptedDaemon(
      ({ turnId }, notify) => {
        successor = turnId;
        notify({ type: "turn_end", turnId: d.promptTurn(), stopReason: "cancelled" });
        notify({ type: "history_replaced", reason: "compact" });
        return { turnId };
      },
      {
        onSnapshot: (seq) => {
          setTimeout(() =>
            d.notify({ type: "turn_end", turnId: successor, stopReason: "cancelled" }),
          );
          return {
            messages: [{ role: "user", content: "A" }],
            since: { epoch: "e2", seq },
            turn: { turnId: successor },
          };
        },
      },
    );
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const oldDone = drain(session.send("go"), []);
    expect(await waitFor(() => d.promptTurn() !== "")).toBe(true);
    const newEvents: SessionEvent[] = [];
    const outcome = await drain(await session.sendNow([{ id: "a", text: "A" }], "turn"), newEvents);
    expect(await oldDone).toBe("ended");
    expect(outcome).toBe("ended"); // not Cancelled: "A" is in the snapshot
    expect(newEvents.map((e) => e.type)).toEqual(["history_reset", "turn_end"]);
    expect(newEvents.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    client.close();
  });

  test("finding 4: a refused compaction-target send-now leaves the client as before: turnId and idle notices", async () => {
    const d = scriptedDaemon(() => {
      throw new RpcError(DomainErrorCode.CompactInProgress, "a compaction is running");
    });
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    const first = drain(session.send("go"), []);
    expect(await waitFor(() => d.promptTurn() !== "")).toBe(true);
    const t1 = d.promptTurn();
    d.notify({ type: "turn_end", turnId: t1, stopReason: "end_turn" });
    expect(await first).toBe("ended");
    // An unknown display update while idle: kept for the next turn.
    d.notify({ type: "future_display", x: 1 }, false);
    await new Promise((r) => setTimeout(r, 10));

    await expect(session.sendNow([{ id: "a", text: "A" }], "compaction")).rejects.toMatchObject({
      code: DomainErrorCode.CompactInProgress,
    });
    // Steering still names T1 (the daemon answers NoTurnRunning for it, as before).
    await session.enqueue("x", "x");
    expect(d.enqueues.at(-1)).toMatchObject({ id: "x", turnId: t1 });
    // The notice is shown at the start of the next turn, not lost.
    const events: SessionEvent[] = [];
    const second = drain(session.send("again"), events);
    expect(await waitFor(() => d.promptTurn() !== t1)).toBe(true);
    d.notify({ type: "turn_end", turnId: d.promptTurn(), stopReason: "end_turn" });
    expect(await second).toBe("ended");
    expect(events[0]).toEqual({ type: "unsupported", kind: "future_display" });
    client.close();
  });
});

describe("RemoteSession.enqueue(text, id)", () => {
  test("T-B6: the caller's id is the enqueue key; without one a fresh key per text", async () => {
    const d = scriptedDaemon();
    const client = new RemoteClient(d.clientCh, new PermissionBroker());
    await client.initialize();
    const session = client.newSession();
    void drain(session.send("go"), [], 300);
    expect(await waitFor(() => d.promptTurn() !== "")).toBe(true);
    await session.enqueue("A", "id1");
    await session.enqueue("B");
    await session.enqueue("C");
    expect(d.enqueues.map((e) => e.text)).toEqual(["A", "B", "C"]);
    expect(d.enqueues[0]?.id).toBe("id1");
    const [, b, c] = d.enqueues;
    expect(b?.id).not.toBe("id1");
    expect(b?.id).not.toBe(c?.id);
    client.close();
  });
});
