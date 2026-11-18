/**
 * docs/feat/logs-cmd.md sub-task 2 (`logs-watch`) — the pure watcher queue.
 *
 * Each test names the mutation that turns it red (AGENTS §9); the byte/count
 * bound, the drop-oldest-droppable rule, the exact `lost` count, chunk merging
 * and the overflow end are the properties the load-bearing test (a watcher that
 * never polls) rests on.
 */
import { describe, expect, test } from "bun:test";
import type { KnownSessionUpdateParams, SessionUpdate } from "@tentacle/protocol";
import {
  WATCH_COALESCE_MS,
  WATCH_QUEUE_MAX_BYTES,
  WATCH_QUEUE_MAX_COUNT,
  WatchQueue,
} from "../src/watch-queue.ts";

let seq = 0;
function frame(update: SessionUpdate, sessionId = "s1"): KnownSessionUpdateParams {
  seq++;
  return { sessionId, seq, update };
}

const text = (body: string): SessionUpdate => ({
  type: "agent_message_chunk",
  content: { type: "text", text: body },
});
const thought = (body: string): SessionUpdate => ({
  type: "agent_thought_chunk",
  content: { type: "text", text: body },
});
const ask = (id: string): SessionUpdate => ({
  type: "permission_request",
  requestId: id,
  toolCallId: "c1",
  tool: "fs_write",
  title: "write a file",
  options: [{ optionId: "o1", name: "Allow", kind: "allow_once" }],
});
const turnEnd = (): SessionUpdate => ({ type: "turn_end", turnId: "t1", stopReason: "end_turn" });

describe("the watcher queue's bound", () => {
  test("it holds at most WATCH_QUEUE_MAX_COUNT updates, dropping the oldest droppable", () => {
    // Mutation: drop the count half of `evict` (bytes only) → length stays at
    // MAX+1 and this fails; the daemon's memory is then unbounded in COUNT.
    const queue = new WatchQueue();
    for (let i = 0; i < WATCH_QUEUE_MAX_COUNT + 5; i++) {
      queue.push(frame({ type: "plan", entries: [{ content: `step ${i}`, status: "pending" }] }));
    }
    expect(queue.length).toBe(WATCH_QUEUE_MAX_COUNT);
    // Five were dropped and counted: never silent (Owner Q3).
    expect(queue.dropped).toBe(5);
    expect(queue.endReason).toBeUndefined();
  });

  test("it holds at most WATCH_QUEUE_MAX_BYTES, dropping the OLDEST droppable", () => {
    // Mutation: drop the byte half of `evict` (count only) → a few huge tool
    // results pile up and `bytes` exceeds the cap by megabytes.
    const queue = new WatchQueue();
    const big = "x".repeat(200_000);
    for (let i = 0; i < 10; i++) {
      queue.push(
        frame({ type: "tool_progress", toolCallId: `c${i}`, kind: "subagent_tool", label: big }),
      );
    }
    expect(queue.bytes).toBeLessThanOrEqual(WATCH_QUEUE_MAX_BYTES);
    // The oldest went first: the newest is still there.
    const batch = queue.take();
    expect(batch.updates.at(-1)?.update.type).toBe("tool_progress");
    expect(batch.lost).toBeGreaterThan(0);
  });

  test("an ask or a turn's end is NEVER dropped: only-non-droppable overflow ends the watch", () => {
    // Mutation: drop ANY entry when full (findIndex → 0) → the oldest ask is
    // discarded and `endReason` stays undefined: the follower never learns.
    const queue = new WatchQueue();
    for (let i = 0; i < WATCH_QUEUE_MAX_COUNT + 1; i++) {
      queue.push(frame(ask(`r${i}`)));
    }
    expect(queue.endReason).toBe("overflow");
    // The batch still carries what it has, and `ended` rides it.
    const batch = queue.take();
    expect(batch.ended).toBe("overflow");
    expect(batch.updates.length).toBeGreaterThan(0);
    expect(batch.updates[0]?.update.type).toBe("permission_request");
  });

  test("the first end reason wins (an overflow is never rewritten as a close)", () => {
    // Mutation: `end` overwrites unconditionally → the client is told `closed`
    // after it already saw `overflow` (and the exit code flips to 0).
    const queue = new WatchQueue();
    queue.end("overflow");
    queue.end("closed");
    expect(queue.endReason).toBe("overflow");
  });
});

describe("chunk coalescing", () => {
  test("adjacent text chunks merge into ONE queued update carrying the newest seq", () => {
    // Mutation: never merge (`mergeChunks` → undefined) → 10 000 entries, and
    // the storm fills the queue as 10 000 separate updates.
    const queue = new WatchQueue();
    const base = seq;
    for (const chunk of ["a", "b", "c"]) {
      queue.push(frame(text(chunk)));
    }
    expect(queue.length).toBe(1);
    const batch = queue.take();
    expect(batch.updates).toHaveLength(1);
    expect(batch.updates[0]?.update).toEqual({
      type: "agent_message_chunk",
      content: { type: "text", text: "abc" },
    });
    // The merged entry's seq is the LAST chunk's: the follower's order is the stream's.
    expect(batch.updates[0]?.seq).toBe(base + 3);
  });

  test("a tool call between two texts is a boundary: they do NOT merge", () => {
    // Mutation: merge with the first queued entry instead of the last → the
    // two texts across the tool call become one and their order is lost.
    const queue = new WatchQueue();
    queue.push(frame(text("before")));
    queue.push(frame({ type: "tool_call", toolCallId: "c1", title: "read", status: "pending" }));
    queue.push(frame(text("after")));
    const batch = queue.take();
    expect(batch.updates.map((u) => u.update.type)).toEqual([
      "agent_message_chunk",
      "tool_call",
      "agent_message_chunk",
    ]);
  });

  test("text and thought never merge with each other", () => {
    // Mutation: merge any two chunks → message text and reasoning become one.
    const queue = new WatchQueue();
    queue.push(frame(text("t")));
    queue.push(frame(thought("r")));
    expect(queue.take().updates).toHaveLength(2);
  });

  test("a non-text block never merges (an image is not concatenable)", () => {
    // Mutation: concat `text ?? ""` regardless of block type → the image is lost.
    const queue = new WatchQueue();
    const image = {
      type: "agent_message_chunk" as const,
      content: { type: "image" as const, mimeType: "image/png", data: "AAA" },
    };
    queue.push(frame(image));
    queue.push(frame(text("x")));
    const batch = queue.take();
    expect(batch.updates).toHaveLength(2);
    expect(batch.updates[0]?.update).toEqual(image);
  });

  test("the emitter's own update object is never mutated by the merge", () => {
    // Mutation: concat into `into.content.text` in place → the replay ring and
    // every other attachment see the text grow (a stream that lies).
    const queue = new WatchQueue();
    const first = text("a");
    queue.push(frame(first));
    queue.push(frame(text("b")));
    expect(first).toEqual({ type: "agent_message_chunk", content: { type: "text", text: "a" } });
  });
});

describe("the filter runs before the queue", () => {
  test("a text-only watcher stores no text when it asked for another category", () => {
    // Mutation: filter at `take()` instead of `push` → the queue's bytes grow
    // with 10 000 ignored chunks (the failure the filter exists to prevent).
    const queue = new WatchQueue(["ask"]);
    for (let i = 0; i < 10_000; i++) {
      if (queue.accepts(text("chunk"))) {
        queue.push(frame(text("chunk")));
      }
    }
    expect(queue.length).toBe(0);
    expect(queue.bytes).toBe(0);
    expect(queue.accepts(ask("r1"))).toBe(true);
  });

  test("a failed turn's end is both `turn` and `error`", () => {
    // Mutation: map `turn_end` to `turn` only → `--only error` never sees a failure.
    const queue = new WatchQueue(["error"]);
    expect(queue.accepts({ type: "turn_end", turnId: "t1", stopReason: "error" })).toBe(true);
    expect(queue.accepts(turnEnd())).toBe(false);
    expect(queue.accepts({ type: "session_closed", reason: "closed" })).toBe(true);
  });
});

describe("waking a held poll", () => {
  test("a flush-now update is due at once; ordinary text waits the coalescing window", () => {
    // Mutation: stop setting `urgent` for a flush-now type → a held poll keeps
    // waiting its full window after the turn ended (or the ask was raised).
    const text1 = new WatchQueue();
    text1.push(frame(text("a")), 1000);
    expect(text1.dueAt(1000, WATCH_COALESCE_MS)).toBe(1000 + WATCH_COALESCE_MS);

    const urgent = new WatchQueue();
    urgent.push(frame(ask("r1")), 1000);
    expect(urgent.dueAt(1000, WATCH_COALESCE_MS)).toBe(1000);
    // The window the caller waits on is the stream's own coalescing.
    expect(WATCH_COALESCE_MS).toBe(250);
  });

  test("take() clears the urgency, the lost counter and the window", () => {
    // Mutation: keep `lost` after a take → every later batch repeats the count.
    const queue = new WatchQueue();
    queue.end("evicted");
    expect(queue.take().ended).toBe("evicted");
    expect(queue.take()).toEqual({ updates: [], lost: 0, ended: "evicted" });
  });

  test("push after an end is a no-op (nothing queues behind a closed watch)", () => {
    // Mutation: drop the `ended` guard in `push` → updates pile into a queue
    // nobody will ever take (a leak that outlives the watch).
    const queue = new WatchQueue();
    queue.end("closed");
    queue.push(frame(text("late")));
    expect(queue.length).toBe(0);
  });

  test("revision moves on every change, so a woken poll can re-check", () => {
    const queue = new WatchQueue();
    const before = queue.revision;
    queue.push(frame(text("a")));
    expect(queue.revision).toBeGreaterThan(before);
    const pushed = queue.revision;
    queue.end("closed");
    expect(queue.revision).toBeGreaterThan(pushed);
  });

  test("a `schedules` frame is DROPPABLE (docs/feat/cron-tool.md S2)", () => {
    // Mutation: drop "schedules" from `DROPPABLE` → a full queue of schedule
    // tables has nothing to drop, ends the watch with `overflow`, and the
    // follower dies over a display-class list it could have skipped.
    const queue = new WatchQueue();
    const table = (i: number): SessionUpdate => ({
      type: "schedules",
      schedules: [
        {
          id: `sc-${i}`,
          kind: "every",
          spec: "every 10m",
          prompt: "check CI",
          nextAt: i,
          fires: 0,
          createdAt: 0,
        },
      ],
    });
    for (let i = 0; i < WATCH_QUEUE_MAX_COUNT + 5; i++) {
      queue.push(frame(table(i)));
    }
    expect(queue.length).toBe(WATCH_QUEUE_MAX_COUNT);
    expect(queue.dropped).toBe(5);
    expect(queue.endReason).toBeUndefined();
    // And it never wakes a held poll ahead of the coalescing window.
    const fresh = new WatchQueue();
    fresh.push(frame(table(1)), 1000);
    expect(fresh.dueAt(1000, WATCH_COALESCE_MS)).toBe(1000 + WATCH_COALESCE_MS);
  });
});
