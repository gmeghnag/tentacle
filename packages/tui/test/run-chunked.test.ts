import { describe, expect, test } from "bun:test";
import { CHUNK_BUDGET_MS, type ChunkTimers, runChunked } from "../src/run-chunked.ts";

/** Manual timers: nothing fires until `runNext()`, so the schedule is deterministic. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const timers: ChunkTimers = {
    set: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pending,
    /** Fire the oldest pending timer; false when none. */
    runNext(): boolean {
      const first = pending.entries().next();
      if (first.done) {
        return false;
      }
      const [id, { fn }] = first.value;
      pending.delete(id);
      fn();
      return true;
    },
    runAll(): number {
      let n = 0;
      while (this.runNext()) {
        n += 1;
      }
      return n;
    },
  };
}

/**
 * What a promise settles to, recorded without waiting and handled from the start
 * (so a rejection is never an "unhandled rejection" report). Fake timers only,
 * so the microtask order is deterministic.
 */
function outcome<T>(p: Promise<T>) {
  const box: { value: T | "pending" | Error } = { value: "pending" };
  p.then(
    (value) => {
      box.value = value;
    },
    (error: Error) => {
      box.value = error;
    },
  );
  return box;
}

/** The rejection `done` carries, or a failure that it never rejected. */
async function rejectedWith(box: { value: unknown }, expected: string): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  if (!(box.value instanceof Error)) {
    throw new Error(`done never rejected (settled to ${JSON.stringify(box.value)})`);
  }
  if (!String(box.value).includes(expected)) {
    throw new Error(`done rejected with ${String(box.value)}, not ${expected}`);
  }
}

/** A `work` that advances one unit per chunk and records `(from, budgetMs)`. */
function steppingWork() {
  const calls: [number, number][] = [];
  const work = (from: number, budgetMs: number): number => {
    calls.push([from, budgetMs]);
    return from + 1;
  };
  return { calls, work };
}

describe("runChunked", () => {
  test("forwards the shared budget and resumes in the work's own order", async () => {
    // Pins: the ONE 6 ms budget (no per-site literal), `from` threading, and that
    // the first chunk runs synchronously while later ones yield.
    const clock = fakeTimers();
    const { calls, work } = steppingWork();
    let done = false;
    const run = runChunked(3, work, {
      timers: clock.timers,
      onDone: () => {
        done = true;
      },
    });
    expect(CHUNK_BUDGET_MS).toBe(6);
    expect(calls).toEqual([[0, CHUNK_BUDGET_MS]]); // one chunk before returning
    expect(done).toBe(false); // no timer fired yet: not finished
    clock.runAll();
    expect(calls).toEqual([
      [0, CHUNK_BUDGET_MS],
      [1, CHUNK_BUDGET_MS],
      [2, CHUNK_BUDGET_MS],
    ]);
    expect(await run.done).toBe(true);
    expect(done).toBe(true);
  });

  test("an explicit budgetMs is forwarded verbatim", async () => {
    // A NON-default, non-zero value: `0` would also be what a "budget dropped"
    // mutation forwards, so it could not catch it (Review F6).
    const clock = fakeTimers();
    const { calls, work } = steppingWork();
    void runChunked(2, work, { timers: clock.timers, budgetMs: 11 });
    clock.runAll();
    expect(calls).toEqual([
      [0, 11],
      [1, 11],
    ]);
  });

  test("a run that goes stale mid-way does no further work and never commits", async () => {
    // Pins the cancel semantics the resize warm had via its generation token.
    const clock = fakeTimers();
    const { calls, work } = steppingWork();
    let stale = false;
    let done = 0;
    const run = runChunked(5, work, {
      timers: clock.timers,
      isStale: () => stale,
      onDone: () => {
        done += 1;
      },
    });
    stale = true;
    clock.runAll();
    expect(calls).toEqual([[0, CHUNK_BUDGET_MS]]); // the superseded warm stopped
    expect(await run.done).toBe(false);
    expect(done).toBe(0);
  });

  test("a run already stale before the first step does no work at all", async () => {
    // The old `onResize` checked its token before the first (synchronous) step.
    const clock = fakeTimers();
    const { calls, work } = steppingWork();
    const run = runChunked(4, work, { timers: clock.timers, isStale: () => true });
    clock.runAll();
    expect(calls).toEqual([]);
    expect(await run.done).toBe(false);
  });

  test("cancel stops the run, clears its timer, and is idempotent", async () => {
    const clock = fakeTimers();
    const { calls, work } = steppingWork();
    let done = 0;
    const run = runChunked(5, work, {
      timers: clock.timers,
      onDone: () => {
        done += 1;
      },
    });
    clock.runNext(); // chunk 2
    expect(calls.length).toBe(2);
    run.cancel();
    expect(clock.pending.size).toBe(0); // nothing left to fire
    run.cancel();
    expect(clock.runAll()).toBe(0);
    expect(calls.length).toBe(2); // no further work
    expect(await run.done).toBe(false);
    expect(done).toBe(0);
  });

  test("cancelled before the first chunk while waiting on a delay", async () => {
    const clock = fakeTimers();
    const { calls, work } = steppingWork();
    const run = runChunked(3, work, { timers: clock.timers, delayMs: 400 });
    expect(calls).toEqual([]); // the idle warm waits for its quiet delay
    expect([...clock.pending.values()][0]?.ms).toBe(400);
    run.cancel();
    expect(clock.runAll()).toBe(0);
    expect(calls).toEqual([]);
    expect(await run.done).toBe(false);
  });

  test("nothing to do: done at once, no timer, the done hook fires", async () => {
    const clock = fakeTimers();
    const { calls, work } = steppingWork();
    let done = 0;
    const run = runChunked(0, work, {
      timers: clock.timers,
      onDone: () => {
        done += 1;
      },
    });
    expect(calls).toEqual([]);
    expect(clock.pending.size).toBe(0);
    expect(await run.done).toBe(true);
    expect(done).toBe(1);
  });

  test("going stale on the last chunk withholds the commit", async () => {
    // Pins the stale check *before* the done hook: a superseded run must not commit.
    const clock = fakeTimers();
    let stale = false;
    let done = 0;
    const run = runChunked(
      2,
      (from) => {
        if (from === 1) {
          stale = true; // superseded while the last chunk ran
        }
        return from + 1;
      },
      {
        timers: clock.timers,
        isStale: () => stale,
        onDone: () => {
          done += 1;
        },
      },
    );
    clock.runAll();
    expect(await run.done).toBe(false);
    expect(done).toBe(0);
  });
  test("a chunk that throws rejects `done` instead of hanging it (F1)", async () => {
    // `commitHistory` awaits `done`: a throw must reach `streamTurn`'s catch, as
    // the old `while` loop's throw did (`main`), not escape from a timer.
    const clock = fakeTimers();
    const { calls, work } = steppingWork();
    const run = runChunked(
      5,
      (from, budgetMs) => {
        if (from === 1) {
          throw new Error("boom-chunk-2");
        }
        return work(from, budgetMs);
      },
      { timers: clock.timers },
    );
    expect(calls).toEqual([[0, CHUNK_BUDGET_MS]]); // the throwing chunk runs in a timer
    // In a timer the throw must NOT escape (that is the uncaught error `main` never
    // had): it rejects `done`, which is what the caller's `await` sees.
    const box = outcome(run.done);
    expect(clock.runAll()).toBe(1); // the one timer: the chunk that threw, then stop
    // Red first: with no reject path `done` stays pending, so this throws
    // "done never rejected (settled to "pending")".
    await rejectedWith(box, "boom-chunk-2");
  });

  test("a `work` that throws in the FIRST chunk rejects `done` and stays loud", () => {
    // Synchronous, at the call site: the throw both escapes (as `main`) and rejects.
    const clock = fakeTimers();
    expect(() =>
      runChunked(
        3,
        () => {
          throw new Error("boom-first");
        },
        { timers: clock.timers },
      ),
    ).toThrow("boom-first");
    expect(clock.pending.size).toBe(0); // no timer left behind
  });

  test("a throwing progress hook rejects `done` too (it runs in the same step)", async () => {
    const clock = fakeTimers();
    const { work } = steppingWork();
    const run = runChunked(4, work, {
      timers: clock.timers,
      delayMs: 0, // first chunk in a timer, where escaping would lose the error
      onProgress: () => {
        throw new Error("boom-progress");
      },
    });
    const box = outcome(run.done);
    expect(clock.runNext()).toBe(true); // chunk 1, then the hook — no escape
    await rejectedWith(box, "boom-progress");
  });

  test("an explicit `delayMs: 0` still waits for the timer (F4)", () => {
    // `main`'s `startIdleWarm` always went through `timers.set`, even at 0.
    const clock = fakeTimers();
    const { calls, work } = steppingWork();
    runChunked(2, work, { timers: clock.timers, delayMs: 0 });
    expect(calls).toEqual([]); // nothing ran synchronously
    expect([...clock.pending.values()][0]?.ms).toBe(0);
    clock.runAll();
    expect(calls).toEqual([
      [0, CHUNK_BUDGET_MS],
      [1, CHUNK_BUDGET_MS],
    ]);
  });

  test("no `delayMs` still starts synchronously (the two App sites)", () => {
    const clock = fakeTimers();
    const { calls, work } = steppingWork();
    runChunked(3, work, { timers: clock.timers });
    expect(calls).toEqual([[0, CHUNK_BUDGET_MS]]);
  });

  test("a run gone stale during its chunk reports no progress (F5 related)", async () => {
    // The old idle warm's `cancelled` was checked before every chunk, so a
    // superseded run never counted (or reported) that chunk.
    const clock = fakeTimers();
    let stale = false;
    const seen: number[] = [];
    const run = runChunked(
      3,
      (from) => {
        if (from === 1) {
          stale = true; // superseded while this chunk ran
        }
        return from + 1;
      },
      {
        timers: clock.timers,
        isStale: () => stale,
        onProgress: (next) => {
          seen.push(next);
        },
      },
    );
    clock.runAll();
    expect(seen).toEqual([1]); // only the chunk that was not stale when it ended
    expect(await run.done).toBe(false);
  });

  test("nothing to do still reports one progress step, as the old loop did", async () => {
    // `main`'s idle warm called `warmRowsChunk` once even for 0 items, so its
    // `onDone` saw 1 chunk. Unreachable in production (`otherViewOpts` is null
    // without a tool item), kept so the count the idle warm reports cannot drift.
    const clock = fakeTimers();
    const seen: number[] = [];
    let chunks = 0;
    const run = runChunked(0, (_from) => 0, {
      timers: clock.timers,
      onProgress: (next) => {
        seen.push(next);
        chunks += 1;
      },
    });
    expect(seen).toEqual([0]);
    expect(chunks).toBe(1);
    expect(await run.done).toBe(true);
  });

  test("cancel() from inside the work commits nothing (F5)", async () => {
    // A call site cancelling while its own (last) chunk runs: `cancel` says "no
    // commit" (`run-chunked.ts:43`), and the step must honour it.
    const clock = fakeTimers();
    let run: { cancel: () => void; done: Promise<boolean> } | null = null;
    let done = 0;
    const ids: number[] = [];
    run = runChunked(
      2,
      (from) => {
        ids.push(from);
        if (from === 1) {
          run?.cancel(); // the last chunk: without a `stopped` re-check it commits
        }
        return from + 1;
      },
      {
        timers: clock.timers,
        onDone: () => {
          done += 1;
        },
      },
    );
    clock.runAll();
    expect(ids).toEqual([0, 1]);
    expect(done).toBe(0); // `cancel()` won: no commit
    expect(await run.done).toBe(false);
  });

  test("onError handles the rejection, so an unread `done` is not unhandled (R1)", async () => {
    // The resize and idle sites never read `done`. With `onError` supplied the
    // rejection must be HANDLED (no unhandled-rejection report) AND `onError`
    // must see the real error. Note: this test never touches `done` — touching
    // it would attach the handler that is the very thing under test.
    // Mutation: drop the `void done.catch(() => {})` in `fail` → red: `bun test`
    // reports `error: boom-chunk-2` as an unhandled rejection and fails the file.
    const clock = fakeTimers();
    const seen: string[] = [];
    runChunked(
      5,
      (from) => {
        if (from === 1) {
          throw new Error("boom-chunk-2");
        }
        return from + 1;
      },
      { timers: clock.timers, onError: (error) => seen.push(String(error)) },
    );
    clock.runAll();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20)); // let the runtime decide "unhandled"
    expect(seen).toEqual(["Error: boom-chunk-2"]); // the site's surface ran
  });

  test("without onError, a chunk-2 throw still rejects `done` loudly (no silent drop)", async () => {
    // No site omits `onError` today; this pins the default so a future one that
    // ignores the error cannot swallow it: `done` rejects and nothing catches.
    const clock = fakeTimers();
    const run = runChunked(
      5,
      (from) => {
        if (from === 1) {
          throw new Error("boom-unhandled");
        }
        return from + 1;
      },
      { timers: clock.timers },
    );
    const box = outcome(run.done);
    clock.runAll();
    await rejectedWith(box, "boom-unhandled");
  });
});
