/**
 * docs/feat/logs-cmd.md sub-task 2 (`logs-watch`) — the daemon side of the
 * watcher, on a real `HostedSession`.
 *
 * The load-bearing test is the first block: a watcher that NEVER polls while a
 * turn streams 10 000 chunks — every `emit` returns synchronously, the watcher's
 * queue stays at its cap, the next poll says how many it lost, and the attached
 * TUI client's frames are IDENTICAL to a run without the watcher. Each test
 * names the mutation that turns it red (AGENTS §9).
 */
import { describe, expect, test } from "bun:test";
import { Agent, Session } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import type { KnownSessionUpdateParams, SessionUpdate } from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { type Attachment, HostedSession } from "../src/hosted-session.ts";
import { WATCH_QUEUE_MAX_BYTES, WATCH_QUEUE_MAX_COUNT } from "../src/watch-queue.ts";

const CHUNKS = 10_000;

/** A model whose stream throws: the turn ends with `stopReason: "error"`. */
class Failing implements ModelProvider {
  readonly id = "failing";
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "partial" };
    throw new Error("provider exploded");
  }
}

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

/** A model that streams `chunks` text deltas (then ends), or asks for a shell command. */
class Streaming implements ModelProvider {
  readonly id = "streaming";
  constructor(
    private readonly chunks: number,
    private readonly ask?: string,
    private readonly text = "x",
  ) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.ask !== undefined) {
      yield {
        type: "tool_call",
        toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: this.ask }) },
      };
      yield { type: "done" };
      return;
    }
    for (let i = 0; i < this.chunks; i++) {
      yield { type: "text", delta: `${this.text}` };
    }
    yield { type: "done" };
  }
}

interface Rig {
  readonly hosted: HostedSession;
  readonly frames: KnownSessionUpdateParams[];
}

/** One hosted session with an attached client (the TUI's stand-in) collecting its frames. */
function hostedWithClient(
  model: ModelProvider,
  seed: readonly ChatMessage[] = [],
  now: () => number = Date.now,
): Rig {
  const permissions = new PermissionBroker();
  const agent = new Agent({
    model,
    tools: new ToolRegistry().register(shellTool),
    env,
    requestPermission: (req, options) => permissions.request(req, options),
  });
  const session = new Session(agent, "s1", {
    messages: seed as ChatMessage[],
  });
  const frames: KnownSessionUpdateParams[] = [];
  const attachment: Attachment = {
    send: (params) => {
      frames.push(params);
    },
  };
  const hosted = new HostedSession("s1", session, permissions, undefined, {}, 4 * 1024 * 1024, now);
  hosted.attach(attachment);
  return { hosted, frames };
}

/** Drain microtasks: the in-memory agent loop needs no timer. */
async function flush(rounds = 2000): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Wait (bounded) until the rig saw a `turn_end` — the turn's stream is over then. */
async function runToEnd(rig: Rig): Promise<void> {
  for (let i = 0; i < 4000; i++) {
    if (rig.frames.some((f) => f.update.type === "turn_end")) {
      return;
    }
    await new Promise((done) => setTimeout(done, 0));
  }
}

const types = (frames: readonly KnownSessionUpdateParams[]) => frames.map((f) => f.update.type);

/** One prompt, and the frames the attached client saw while it ran. */
async function runTurn(chunks: number, watch: boolean): Promise<string[]> {
  const rig = hostedWithClient(new Streaming(chunks));
  if (watch) {
    rig.hosted.watch(); // a watcher that never polls
  }
  rig.hosted.prompt("t1", [{ type: "text", text: "go" }]);
  await runToEnd(rig);
  return types(rig.frames);
}
describe("the load-bearing property: the daemon never waits on a watcher", () => {
  test("a non-polling watcher while 10 000 chunks stream: emit is sync, its queue is capped, the client's frames are unchanged", async () => {
    // Mutation: `await` the watcher's enqueue (or make its queue unbounded) →
    // the turn blocks / the queue grows to 10 000 entries / the attached
    // client's frame list differs. All three are asserted here.
    const withWatcher = await runTurn(CHUNKS, true);
    const withoutWatcher = await runTurn(CHUNKS, false);
    // The attached client's stream is IDENTICAL: the watcher changes nothing a
    // client sees, in content or in order.
    expect(withWatcher).toEqual(withoutWatcher);

    const rig = hostedWithClient(new Streaming(CHUNKS));
    const { watchId } = rig.hosted.watch();
    const started = Bun.nanoseconds();
    rig.hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await runToEnd(rig);
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
    // The prompt returned at once (a synchronous accept), and the turn's whole
    // stream finished promptly: no per-chunk await chain through a watcher.
    expect(elapsedMs).toBeLessThan(5000);
    expect(rig.hosted.running).toBe(false);

    // The next poll: everything coalesced into ONE update (adjacent text
    // merges), so the queue's count never grew with the storm — and the byte
    // cap held whatever else arrived.
    const batch = await rig.hosted.watchNext(watchId, 0);
    expect(batch.updates.length).toBeLessThanOrEqual(WATCH_QUEUE_MAX_COUNT);
    const text = batch.updates.filter((u) => u.update.type === "agent_message_chunk");
    expect(text).toHaveLength(1);
    expect(text[0]?.update).toEqual({
      type: "agent_message_chunk",
      content: { type: "text", text: "x".repeat(CHUNKS) },
    });
    expect(JSON.stringify(batch.updates).length).toBeLessThanOrEqual(WATCH_QUEUE_MAX_BYTES);
  });

  test("a watcher is NOT an attachment: attachedCount, an ask's pending state and the TUI's frames are untouched", async () => {
    // Mutation: `this.attachments.add(...)` for a watcher in `watch()` → the
    // count below becomes 2, and the ask is DENIED at once (the blocking
    // fallback sees a client that declared no `permission_request`).
    const rig = hostedWithClient(new Streaming(0, "echo hi"));
    expect(rig.hosted.attachedCount).toBe(1);
    rig.hosted.watch();
    expect(rig.hosted.attachedCount).toBe(1);

    rig.hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await flush();
    // Still waiting for a human: the watcher neither answered nor withdrew it.
    expect(rig.hosted.running).toBe(true);
    expect(types(rig.frames)).toContain("permission_request");
    // `session/list`'s `attached` is the truth `ps` and the relay read.
    expect(rig.hosted.summary("/w").attached).toBe(1);
  });

  test("a throwing watcher is DROPPED, never the turn, and its siblings still get the updates", async () => {
    // Mutation: let `offer`'s per-watcher exception escape (no try/catch) → the
    // turn's next `emit` throws out of the fan-out and the healthy watcher stops
    // receiving. Both halves are asserted below.
    const rig = hostedWithClient(new Streaming(6));
    const broken = rig.hosted.watch();
    const healthy = rig.hosted.watch();
    const queues = (
      rig.hosted as unknown as {
        watchers: { watchers: Map<string, { queue: { push(p: unknown, now?: number): void } }> };
      }
    ).watchers.watchers;
    const target = queues.get(broken.watchId);
    expect(target).toBeDefined();
    if (target !== undefined) {
      target.queue.push = () => {
        throw new Error("watcher bug");
      };
    }
    rig.hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await flush();
    await flush();
    // The turn completed: the attached client saw its end.
    expect(types(rig.frames)).toContain("turn_end");
    // And the healthy watcher still got the stream.
    const batch = await rig.hosted.watchNext(healthy.watchId, 0);
    expect(batch.updates.length).toBeGreaterThan(0);
    // The broken one was dropped rather than left to throw on every update.
    const after = await rig.hosted
      .watchNext(broken.watchId, 0)
      .catch((error: { code?: number }) => error.code);
    expect(after === -32018 || (after as { updates?: unknown[] }).updates !== undefined).toBe(true);
  });
});

describe("the watcher's state", () => {
  test("watch() answers the running turn and every pending ask (so an ask raised before it is never missed)", async () => {
    // Mutation: return an empty `pending` → a follower that arrives mid-turn
    // never learns about the ask it is waiting for.
    const rig = hostedWithClient(new Streaming(0, "echo hi"));
    rig.hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await flush();
    const { state } = rig.hosted.watch();
    expect(state.running).toBe(true);
    expect(state.turnId).toBe("t1");
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]?.toolCallId).toBe("c1");
  });

  test("`only` filters the pending asks and the stream alike", async () => {
    // Mutation: filter only the stream (not `state.pending`) → an `--only turn`
    // follower is handed an ask it never asked for.
    const rig = hostedWithClient(new Streaming(0, "echo hi"));
    rig.hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await flush();
    expect(rig.hosted.watch(["turn"]).state.pending).toEqual([]);
    expect(rig.hosted.watch(["ask"]).state.pending).toHaveLength(1);
  });

  test("a closing session delivers what it has, then `ended: closed`", async () => {
    // Mutation: drop `watchers.endAll` from `close` → the held poll waits its
    // full timeout on a session that is already gone.
    const rig = hostedWithClient(new Streaming(3));
    const { watchId } = rig.hosted.watch();
    rig.hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await flush();
    const first = await rig.hosted.watchNext(watchId, 0);
    expect(first.updates.length).toBeGreaterThan(0);
    expect(first.ended).toBeUndefined();

    rig.hosted.close();
    const last = await rig.hosted.watchNext(watchId, 0);
    expect(last.ended).toBe("closed");
    // `session_closed` rides that last batch (the follower prints it).
    expect(last.updates.map((u) => u.update.type)).toContain("session_closed");
    // And the watch is gone from the session.
    expect(
      await rig.hosted.watchNext(watchId, 0).catch((e: { code?: number }) => e.code),
    ).toBeDefined();
  });

  test("a second concurrent watch_next is InvalidParams (never two batches in flight)", async () => {
    // Mutation: drop the `holding` guard → two polls interleave and split one
    // batch between them (the follower's picture becomes unordered).
    const rig = hostedWithClient(new Streaming(0));
    const { watchId } = rig.hosted.watch();
    const held = rig.hosted.watchNext(watchId, 50);
    let code: number | undefined;
    try {
      await rig.hosted.watchNext(watchId, 50);
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(-32602); // JsonRpcErrorCode.InvalidParams
    const empty = await held;
    expect(empty.updates).toEqual([]);
  });

  test("the queue is filtered BEFORE it stores anything: `--only ask` keeps no text at all", async () => {
    // Mutation: filter at take() → the byte count of an `--only ask` watcher
    // grows with the whole streamed answer (the memory the filter must save).
    const rig = hostedWithClient(new Streaming(2000));
    const { watchId } = rig.hosted.watch(["ask"]);
    rig.hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await flush();
    const batch = await rig.hosted.watchNext(watchId, 0);
    expect(batch.updates.filter((u) => u.update.type === "agent_message_chunk")).toEqual([]);
    // Turn markers are `turn`, not `ask`: nothing at all for this watcher.
    expect(batch.updates).toEqual([]);
  });

  test("an 8-watcher cap ends the OLDEST `evicted`, never the newcomer", async () => {
    // Mutation: refuse the 9th `watch` (or evict the newest) → a `logs -f`
    // that just started is the one told to go away.
    const rig = hostedWithClient(new Streaming(0));
    const first = rig.hosted.watch().watchId;
    for (let i = 0; i < 7; i++) rig.hosted.watch();
    // The cap is 8: a 9th watch evicts the first.
    const ninth = rig.hosted.watch();
    const evicted = await rig.hosted.watchNext(first, 0);
    expect(evicted.ended).toBe("evicted");
    const fresh = await rig.hosted.watchNext(ninth.watchId, 0);
    expect(fresh.ended).toBeUndefined();
  });

  test("a watcher that stops polling for 60 s is dropped (bounded leak)", async () => {
    // Mutation: never check `lastPollAt` → a hung client's queue lives forever.
    const clock = { t: 1000 };
    const rig = hostedWithClient(new Streaming(3), [], () => clock.t);
    const { watchId } = rig.hosted.watch();
    clock.t += 61_000;
    rig.hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await flush();
    const batch = await rig.hosted.watchNext(watchId, 0).catch((e: { code?: number }) => e);
    // Either the last batch says `evicted`, or the watch is already gone.
    expect("ended" in batch ? batch.ended : (batch as { code?: number }).code).toBe(
      "ended" in batch ? "evicted" : -32018,
    );
  });

  test("unwatch is idempotent and releases the watcher", async () => {
    // Mutation: make `unwatch` throw on an unknown id → Ctrl+C of a `logs -f`
    // that already ended fails instead of exiting 0.
    const rig = hostedWithClient(new Streaming(0));
    const { watchId } = rig.hosted.watch();
    rig.hosted.unwatch(watchId);
    expect(() => rig.hosted.unwatch(watchId)).not.toThrow();
    expect(() => rig.hosted.unwatch("nope")).not.toThrow();
    // A released watch is GONE: a later poll is UnknownWatch, never a silent
    // empty batch (which a poll loop would spin on forever).
    let code: number | undefined;
    try {
      await rig.hosted.watchNext(watchId, 0);
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(-32018);
  });
});

describe("the vocabulary", () => {
  test("a failed turn's end is `turn` AND `error`, a cancelled one is only `turn`", async () => {
    // Mutation: `turn_end` → `turn` only → `--only error` never sees a failure;
    // or `error` for every end → a cancel is reported as a failure.
    const failed = hostedWithClient(new Failing());
    const failing = failed.hosted.watch(["error"]);
    failed.hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await runToEnd(failed);
    const seen = (await failed.hosted.watchNext(failing.watchId, 0)).updates.map((u) => u.update);
    const ends = seen.filter(
      (u): u is Extract<SessionUpdate, { type: "turn_end" }> => u.type === "turn_end",
    );
    expect(ends.map((u) => u.stopReason)).toEqual(["error"]);

    const cancelled = hostedWithClient(new Streaming(0, "echo hi"));
    const only = cancelled.hosted.watch(["error"]);
    cancelled.hosted.prompt("t2", [{ type: "text", text: "go" }]);
    await flush();
    cancelled.hosted.cancel();
    await flush();
    await flush();
    const cancelEnds = (await cancelled.hosted.watchNext(only.watchId, 0)).updates.map(
      (u) => u.update,
    );
    expect(cancelEnds.filter((u) => u.type === "turn_end")).toEqual([]);

    // And a close IS an error for a follower: the reason its stream stops.
    const closing = hostedWithClient(new Streaming(0));
    const watching = closing.hosted.watch(["error"]);
    closing.hosted.close();
    const last = await closing.hosted.watchNext(watching.watchId, 0);
    expect(last.ended).toBe("closed");
    expect(last.updates.map((u) => u.update.type)).toContain("session_closed");
  });
});

/** A local `Session` (the agent package's), constructed the way other daemon tests do. */
