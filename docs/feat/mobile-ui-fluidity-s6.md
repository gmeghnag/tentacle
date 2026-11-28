# feat/mobile-ui-fluidity-s6 — ingestion budget: a backlog is folded in ≤ 8 ms slices, prose merged

> **Status:** executed as approved — **do NOT merge yet**: an ordering bug in the design is open (Implementation → "Plan correction")
> **Branch:** `feat/mobile-ui-fluidity-s6`
> Type: feat · Size: S · Blast: contained · Suited: Opus plan + fresh Opus review (owner night rule), Sonnet exec
> **Changelog:** `changelog.d/mobile-ui-fluidity-s6.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-28*

Slice 6 of `docs/eval/mobile-ui-fluidity.md` (APPROVED by the owner 28/11). Scope is
its Migration plan row 6 (`:325`) and nothing else: **a backlog (attach, reconnect,
4G burst) is folded in slices of ≤ 8 ms, consecutive `text`/`reasoning` deltas
merged into one fold, yielding to the event loop between slices; wire the unused
`stream-batch.ts`.** AI-free check of the row: 5 000 queued deltas → no single task
> 8 ms (fake clock), final state == unbatched fold. Gate 0 (`90-perf-stream`, s0)
must improve or hold.

**Evidence.**

- Device (eval, Device evidence, `:254`): the owner's iPhone log at 23:21:19 shows
  `folds=23 932` in one 20 s window (9.4 s of renders) on reattach.
- The daemon replays every delta past the cut as its own frame (eval `:96-103`,
  `hosted-session.ts:2572-2600`); daemon-side merging was rejected in the eval
  (`:369-372`, the seq-contiguity invariant), so the bound is phone-side.
- The feed folds one event per loop turn and never yields:
  `apps/mobile/src/session-feed.ts:269-286` (`for await` → `deps.put(apply(…))` per
  event). A buffered `AsyncQueue` yields its items without awaiting anything
  (`packages/client/src/queue.ts:57-60`), so a backlog already in the queue is drained
  in one microtask chain: **one JS task**, however long.
- `stream-batch.ts` exists, is tested ("batched == unbatched",
  `apps/mobile/test/stream-batch.test.ts:50-67`, a 10 000-chunk fold at `:104`) and
  is imported by nothing in `src/` (`grep stream-batch apps/mobile/src` → only a
  comment in `transcript-rows.ts:83`).

**Earlier slices (merged on `main`), drift that matters here:** s3 moved the render
coalescer into `createSessionStore` (`session-screen-controller.ts:1515-1527`, its
`clock: () => deps.now()` and `schedule: deps.schedule ?? setTimeout`); the feed's
`put` publishes `"stream"` for prose and `emit()` otherwise (`:904-909`). s5's gate 0
on the branch: PERF PASS, 0 jank lines, settle 705–717 ms, panes `shell 3 / tail 1209
/ cells 118`. No earlier slice touched `session-feed.ts` or `stream-batch.ts`.
Gate 0 is a LIVE stream (the laptop starts `THINKHOLD FAST` after the open,
`e2e/flows/90-perf-stream.yaml:7-8`), so this slice is expected to HOLD it, not to
move it; the attach path is measured by the repro below.

**Repro** (2026-11-28, `main` `0663297c` = this branch's base, run from the main
checkout's modules because the worktree has no `node_modules`; JIT. The interpreter
run needs an approval this session did not have — the eval's `ingest.ts` measured
the same pipeline at ~10× under `BUN_JSC_useJIT=0`, so a Hermes-class phone is in the
hundreds of ms for one task).
`.tentacle/tmp/mobile-ui-fluidity-s6/ingest-runs.ts` — real `SessionHost` +
`Connection` → Noise → `RemoteClient` → `createSessionScreen`, each inbound frame
delivered in its OWN macrotask (as RN delivers WebSocket messages); a `setImmediate`
tick counter tells whether two folds were in the same task:

```ts
// s6 repro: on the PHONE side of an attach replay, how many stream folds run with
// NO macrotask between them, and for how long? (= the longest JS task the feed makes)
// Run: bun ingest-runs.ts N   ·   BUN_JSC_useJIT=0 bun ingest-runs.ts N
import { Agent } from "@tentacle/agent";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { type ByteCarrier, createByteCarrierPair, createChannelPair } from "@tentacle/transport";
const W = "/Users/gmeghnag/tentacle"; // the tree under test (needs node_modules)
const { noiseResponder, publicKeyOf, systemRandom } = await import(`${W}/packages/transport/src/noise-channel.ts`);
const { RemoteClient } = await import(`${W}/packages/client/src/remote-client.ts`);
const { secureChannelFactory } = await import(`${W}/packages/client/src/secure-channel.ts`);
const { createSessionController } = await import(`${W}/apps/mobile/src/session-controller.ts`);
const { createSessionScreen } = await import(`${W}/apps/mobile/src/session-screen-controller.ts`);
const N = Number(process.argv[2] ?? 4000);
const DELTA = "the next token, ";
class HoldModel implements ModelProvider {
  readonly id = "hold";
  holding = false;
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    for (let i = 0; i < N; i++) {
      if (i % 200 === 0) await new Promise((r) => setImmediate(r));
      yield { type: "reasoning", delta: DELTA };
    }
    this.holding = true;
    await new Promise(() => {});
  }
}
const key = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const DAEMON = key(1);
const DEVICE = key(2);
function host(model: ModelProvider) {
  return new SessionHost({
    defaultCwd: "/tmp/ingest",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        env: { id: "x", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), readFile: async () => "", writeFile: async () => {} },
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
}
async function laptop(h: SessionHost) {
  const [a, b] = createChannelPair();
  new Connection(b, h);
  const c = new RemoteClient(a, new PermissionBroker());
  await c.initialize();
  return c;
}
async function phone(h: SessionHost) {
  const dial = async (): Promise<ByteCarrier> => {
    const [d, c] = createByteCarrierPair();
    noiseResponder(d, { staticKey: DAEMON, random: systemRandom, authorize: () => true }).then(
      (secure: unknown) => new Connection(secure as never, h),
      () => {},
    );
    const queue: Uint8Array[] = [];
    let handler: ((f: Uint8Array) => void) | null = null;
    let draining = false;
    const drain = () => {
      const f = queue.shift();
      if (f === undefined) {
        draining = false;
        return;
      }
      handler?.(f);
      setImmediate(drain); // one frame per macrotask
    };
    return {
      send: (data) => c.send(data),
      close: () => c.close(),
      setOnMessage: (fn) => {
        handler = fn as (f: Uint8Array) => void;
        c.setOnMessage((frame) => {
          queue.push(frame as Uint8Array);
          if (!draining) {
            draining = true;
            setImmediate(drain);
          }
        });
      },
      setOnClose: (fn) => c.setOnClose(fn),
    } as ByteCarrier;
  };
  const factory = secureChannelFactory(dial, { staticKey: DEVICE, remoteStatic: publicKeyOf(DAEMON), random: systemRandom });
  const c = new RemoteClient(await factory(), new PermissionBroker(), undefined, { channelFactory: factory, random: () => 0 });
  await c.initialize();
  return c;
}
const RUN = { tick: 0, lastTick: -1, run: 0, maxRun: 0, start: 0, maxMs: 0, folds: 0 };
const tickLoop = () => {
  RUN.tick++;
  setImmediate(tickLoop);
};
setImmediate(tickLoop);
const until = async (cond: () => boolean, ms = 600_000) => {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 2));
  }
};
const model = new HoldModel();
const h = host(model);
const lap = await laptop(h);
const s = lap.newSession();
void (async () => {
  for await (const _ of s.send("go")) {
  }
})();
await until(() => model.holding);
const id = (s.id ?? (s as unknown as { sessionId: string }).sessionId) as string;
const ph = await phone(h);
let thought = 0;
let notifies = 0;
const screen = createSessionScreen({
  sessionId: id,
  archived: false,
  title: "t",
  project: "p",
  controller: createSessionController({
    newSession: (sid: string) => ph.newSession(undefined, sid, undefined, { attach: {} }),
  }),
  broker: new PermissionBroker(undefined, { holdUntilSet: true }),
  now: () => Date.now(),
  onStreamFold: () => {
    const t = performance.now();
    if (RUN.tick === RUN.lastTick) {
      RUN.run++;
    } else {
      RUN.run = 1;
      RUN.start = t;
      RUN.lastTick = RUN.tick;
    }
    if (RUN.run > RUN.maxRun) RUN.maxRun = RUN.run;
    if (t - RUN.start > RUN.maxMs) RUN.maxMs = t - RUN.start;
    RUN.folds++;
  },
  onChange: (st: { transcript: { rows: { kind: string; text?: string }[] } }) => {
    notifies++;
    let n = 0;
    for (const r of st.transcript.rows) if (r.kind === "reasoning") n += r.text?.length ?? 0;
    thought = n;
  },
});
const t0 = performance.now();
await screen.open();
await until(() => thought >= N * DELTA.length);
const jit = process.env.BUN_JSC_useJIT === "0" ? "interp" : "jit";
console.log(
  `${jit} ATTACH N=${N}: caught up in ${(performance.now() - t0).toFixed(0)} ms | ${RUN.folds} stream folds, ${notifies} notifications | longest run of folds with NO macrotask between: ${RUN.maxRun} folds over ${RUN.maxMs.toFixed(1)} ms`,
);
process.exit(0);
```

```
$ bun .tentacle/tmp/mobile-ui-fluidity-s6/ingest-runs.ts 4000
jit ATTACH N=4000: caught up in 58 ms | 4000 stream folds, 10 notifications | longest run of folds with NO macrotask between: 4000 folds over 2.4 ms
```

Reading: although every frame arrives in its own macrotask, **all 4 000 folds run in
ONE task** — the replay is already buffered in the turn's queue when the feed starts
iterating, and nothing in the loop yields. 4 000 folds, one per delta: nothing merges.
Expected after the change: `longest run` bounded by the slice (≤ 8 ms of fold time
plus one fold), and `stream folds` ≪ 4 000.

## Implementation

*— claude-opus-5-5, 2026-11-28* — **APPROVED** (owner delegated the details; decisions below, none touches a §7 rule)

### Load-bearing assumption

**A backlog reaches `foldStream` as events available without a macrotask between
them, so a loop that measures its own elapsed time can tell "I have been folding
for 8 ms without the event loop running" and yield then — and, conversely, a live
stream's events arrive with a measurable wait between them, so the budget never
trips on a live stream.**

- Backlog side: proven by the code (`queue.ts:57-60`: a buffered item is yielded
  with no `await` on a new promise; the turn's generator is `yield* turn.queue`,
  `remote-session.ts:2242-2244`) and by the repro (4 000 folds, one task).
- Live side: a live delta is a WebSocket frame → its own macrotask, and the feed is
  parked on the queue's waiter in between (`queue.ts:68-70`). Gate 0's mock emits a
  delta every 10 ms (eval `:158-159`); the feed loop is idle between them. The gap
  is measured on the same injected clock, so the tests pin it.

### Preconditions

- **Batching is semantics-free:** prose merges only with the same type; anything else
  releases what is held first (`stream-batch.ts:53-56`, `:63-72`), and the batched
  fold equals the unbatched one (`stream-batch.test.ts:50-67`, rows' `version` is
  `text.length` so they compare equal, `transcript-rows.ts:80-84`).
- **Prose events carry only `{ type, delta }`:** `client/src/mapping.ts:276-278`. A
  merged event loses nothing.
- **`put(…, "stream")` is coalesced by the store** (`session-screen-controller.ts:904-909`):
  fewer, larger prose folds mean fewer `onStreamFold` calls, never more renders.
- **One bracket at a time:** `successorTurn` waits for every stream being folded
  (`session-feed.ts:353-354`), so a held delta of the old turn is folded before the
  new bracket opens (the fold promise settles only after the final release).
- **The controller has an injected clock and timer:** `deps.now` (`:429`; `Date.now`
  in the app, `screens/SessionScreen.tsx:411`) and `deps.schedule ?? setTimeout`
  (`:1520-1527`). Tests inject both, so the budget is deterministic in every
  existing controller test.
- No protocol, persistence, broker, terminal or pod path is touched (§7 does not apply
  beyond "logic in pure modules": the slicing decision is pure, in `stream-batch.ts`).

### Orchestrator decisions

1. **Backlog mode only, not always-batch.** The loop folds each event at once (today's
   behaviour, byte for byte) until it has folded for `SLICE_MS` (8) without a wait;
   only then it yields and enters *backlog mode*, where prose is held and merged.
   Recommended over always holding: the live path, the s2 receipt times and every
   existing test stay as they are. Rejected: always-batch with the 50 ms window
   (`createBatcher`'s default) — it holds the last live delta until the NEXT event, a
   visible stall on a pausing model.
2. **The budget clock is the controller's `deps.now`** (ms resolution in the app),
   not `performance.now`. Recommended: deterministic in tests (they inject `now`),
   and ±1 ms is fine for an 8 ms budget. Rejected: a real clock in the feed — a
   loaded parallel gate would trip the budget inside microtask-only test bodies and
   suspend folds on a timer the test never runs (flaky).
3. **A "wait" is a gap ≥ `GAP_MS` (2) between the end of one fold and the next
   event's arrival.** With a ms clock, a 1 ms tick inside a drain must not look like
   a wait. Mis-reading a short real wait as continuous only trips earlier (harmless:
   one extra yield).
4. **Yield and deferred flush go through the store's one `schedule(fn, 0)`** (hoisted
   to a const, shared by the store and the feed). No new timer source.
5. **Files: the eval's row plus the one wiring line** in `session-screen-controller.ts`
   (the row lists `session-feed.ts` + `stream-batch.ts`; without the wiring the feed
   runs unbudgeted in the app). Recorded as drift from the eval row, not scope creep.

### Design

**Pure (`stream-batch.ts`):** add

```ts
/** A backlog is folded in slices of at most this much fold time (eval row 6). */
export const SLICE_MS = 8;
/** A gap this long between two events means the loop waited: a new task. */
export const GAP_MS = 2;

export interface Slicer {
  /** An event arrived at `t`: a wait since the last `done` starts a new slice. */
  arrive(t: number): void;
  /** A fold finished at `t`: true when the slice has used its budget (yield now). */
  done(t: number): boolean;
  /** The loop yielded (or a deferred flush ran): the next event starts a slice. */
  reset(): void;
}
export function createSlicer(sliceMs = SLICE_MS, gapMs = GAP_MS): Slicer;
```

`arrive`: `start === null || t - lastDone >= gapMs` → `start = t`. `done`: `lastDone =
t; return t - start >= sliceMs`. `reset`: `start = null`. Update the module header:
the batcher is now wired, for the backlog path (its 50 ms `WINDOW_MS` stays for the
existing tests; the feed uses `createBatcher(Number.POSITIVE_INFINITY)` — a backlog
slice is released by the budget, a type switch or a non-prose event, never by time).

**Feed (`session-feed.ts`):** `SessionFeedDeps` gains

```ts
readonly slice?: {
  readonly clock: () => number;
  readonly schedule: (fn: () => void, ms: number) => () => void;
};
```

Absent → today's loop exactly (every existing feed test). Present → in `foldStream`,
one `Slicer` + one `Batcher` per stream:

```
fold(e)    = today's body: deps.put(apply(state, e, now()), prose ? "stream" : undefined)
             + the history_reset hook                       (one helper, used everywhere)
release()  = cancel the deferred flush; for e of batcher.flush(): fold(e)
for await (event of stream):
  slicer.arrive(clock())
  drawPrompt(event); turn_end bookkeeping                   (on ARRIVAL, as today)
  if backlog: for e of batcher.push(event, 0): fold(e)
              if batcher.pending() && no deferred: deferred = schedule(() => { deferred = null;
                  release(); backlog = false; slicer.reset() }, 0)
  else:       fold(event)
  if slicer.done(clock()): release(); backlog = true; slicer.reset();
                           await new Promise(r => schedule(r, 0))
release()                                                   (before finish, both paths)
catch: release(); finish(lost); throw
```

- The deferred flush is what stops a merged delta from waiting for the NEXT event: it
  runs at the first macrotask after the drain, i.e. as soon as the loop is parked on
  an empty queue. It also leaves backlog mode, so the next live delta folds at once.
- `drawPrompt` and the `turn_end` facts stay on arrival, so the own prompt row is
  drawn before any held prose and the bracket's outcome is unchanged.
- **Controller (`session-screen-controller.ts`):** hoist the store's `schedule`
  (`:1520-1527`) to one const above `createSessionFeed` (`:876`) and pass
  `slice: { clock: () => deps.now(), schedule }`; the store takes the same const.

### Files

1. `apps/mobile/src/stream-batch.ts` — `SLICE_MS`, `GAP_MS`, `createSlicer`, header.
2. `apps/mobile/src/session-feed.ts` — `slice?` dep, the budgeted loop (`:265-296`).
3. `apps/mobile/src/session-screen-controller.ts` — the hoisted `schedule` + `slice` wiring.
4. `apps/mobile/test/stream-batch.test.ts`, `apps/mobile/test/session-feed.test.ts`,
   `apps/mobile/test/session-screen-stream-render.test.ts` — below.
5. `changelog.d/mobile-ui-fluidity-s6.fixed.md` — `- **Opening a session in the middle
   of a long reply no longer freezes the app while it catches up.** The replayed
   backlog is folded in short slices, with the text merged, so the screen keeps
   responding.`

### Failure modes

| Mode | Convergence |
|---|---|
| Backlog drains, a merged delta is held, the queue goes idle | the deferred `schedule(…, 0)` folds it at the next macrotask and leaves backlog mode (test B4) |
| Non-prose event in a backlog (tool call, `turn_end`, `history_reset`) | `batcher.push` releases the held prose first, then the event (`stream-batch.ts:53-56`); order exact (B5) |
| Stream throws mid-backlog | `release()` before `finish(lost)`; the error still rejects `ownTurn` (B6) |
| Stream ends mid-backlog | `release()` before `finish`; the fold promise settles after it, so `successorTurn` waits for it |
| A new foreign `turn` activity while the old stream still holds prose | **WRONG — see "Plan correction" below (executor, 2026-11-28). Open: not converging.** (Planned text: the old stream holds across a macrotask only while parked mid-prose, so not widened beyond one task.) |
| One fold > 8 ms (a big `history_reset`) | not split: the budget bounds slices, not one fold. Out of scope (eval row 6) |
| Live stream | gaps ≥ 2 ms reset the slice, the budget never trips, no timer is armed, every delta folds at once (B3; gate 0 holds) |
| Unmount mid-backlog | the stream keeps folding into the dead controller, as today; a deferred flush is one more `put` of that kind |
| Receipt times | a row created by a merged fold is stamped at the fold, ≤ one slice after its first delta arrived (a replay's times are replay-time anyway) |
| `slice` absent (unit feeds) | today's loop exactly |

### Plan correction (OPEN — needs approval before merge)

*— claude-sonnet-5-5, 2026-11-28*

**The contradiction.** The budget yield (`session-feed.ts`, `createPace.take`) also
spans a macrotask while the stream still has **unread** events, its `turn_end`
possibly among them. Today a buffered drain is one task, so no activity can land
inside it. Now a frame can: `activity()` handles it at once, ahead of the older
stream's remaining events. Reachable on attach/reconnect, when the replay holds one
turn's end followed by the next turn's start, or a resync snapshot
(`closeWithoutOutcome` closes the old queue but keeps its buffered items, then
raises `history`: `client/src/remote-session.ts` `onReset`).

**Evidence** (`.tentacle/tmp/mobile-ui-fluidity-s6/interleave.ts`: this branch's
`createSessionFeed`; turn A = 3 000 deltas + `turn_end`, buffered; one activity
arrives at A's first yield):

```
UNSLICED · next: turn
  trace: turn-start A | turn-end A ended | turn-start B
  open bracket: B · Stop (foreign): B
  rows: reasoning(3000) assistant(8)
SLICED · next: turn
  trace: turn-start A | turn-start B | turn-end A ended
  open bracket: null · Stop (foreign): null          <- B runs, no Stop, A closed B's bracket
  rows: reasoning(64) assistant(8) reasoning(2936)   <- A's reply split around B's
UNSLICED · next: history
  rows: assistant(8)
SLICED · next: history
  rows: assistant(8) reasoning(2936)                 <- stale prose appended to the snapshot
```

**Proposed correction (NOT implemented: outside the approved Implementation).** A
stream that spent a slice is *catching up* until its loop ends, or until a flush
armed after the yield runs (it can only run once the drain is parked; so arm it
even with nothing held). While any stream is catching up, `createSessionFeed`
queues `activity()` and `ownTurn`'s bracket behind it, in arrival order
(`successorTurn` already waits). A live stream never spends a slice, so it is
unchanged. Tests: the two scenarios above, red on this branch.

### Tests

Red first, on assertions (not a missing import: the new deps field is simply ignored
by today's code). Driver for B: a fake clock; `put` advances it by `0.1` ms (the fold
cost); a fake `schedule` queue; one "task" = run microtasks to quiescence with a real
`await new Promise((r) => setImmediate(r))`, record the fake-clock span, then fire the
next queued timer. Streams are `gen(...)` (`session-feed.test.ts:48-52`, a
microtask-only drain like a buffered `AsyncQueue`) or a generator that yields N then
awaits forever.

**A. `stream-batch.test.ts` (pure slicer):** a gap ≥ `GAP_MS` starts a new slice;
continuous folds report spent at ≥ `SLICE_MS`, not before; `reset` starts over; a
1 ms tick (< `GAP_MS`) does not reset.

**B. `session-feed.test.ts` "ingestion budget":**

- **B1 (red):** 5 000 queued `reasoning` deltas → every task span ≤ `SLICE_MS + 0.1`;
  the final `transcript.rows` `toEqual` the unbatched harness's (no `slice`). Today:
  one span of 500 ms.
- **B2 (red):** same run → stream `put`s < 500 (merged). Today: 5 000.
- **B3 (guard, green on both):** 50 deltas with the generator advancing the clock 11 ms
  between them → zero timers scheduled, `put`s == 50.
- **B4 (guard):** 5 000 deltas then idle → after the drive the reasoning text is all
  5 000 deltas, with no further event.
- **B5:** 3 000 `reasoning`, a `tool_call`, 3 000 `text`, `turn_end` → rows equal the
  unbatched fold; one `turn_ended` with outcome `ended`.
- **B6:** 3 000 deltas then a throw → the held prose is in the rows before the LOST
  notice; `ownTurn` rejects with that error.
- **B7:** an own prompt + 3 000 deltas → the prompt row precedes the reasoning row.

**C. `session-screen-stream-render.test.ts` (wiring, red):** `createSessionScreen`
with an injected `schedule` and `now`, the clock advanced `0.1` per `onStreamFold`;
5 000 queued deltas through the foreign-turn `watch` → `onStreamFold` < 500, a 0 ms
timer was scheduled, and the reasoning text is complete. Today: 5 000 folds.

**Mutations** (each must turn a test red, then revert): m1 no `await` at the budget
(B1); m2 no deferred flush (B4); m3 fold prose directly in backlog mode (B2); m4 no
gap reset in `arrive` (B3); m5 controller does not pass `slice` (C); m6 no `release()`
in `catch` (B6).

**Validation (AI-free).**

1. The repro above, against the tree under test: `longest run` ≤ ~9 ms of fold time
   and `stream folds` ≪ 4 000; paste before/after into Execution.
2. **Gate 0** under `/Users/gmeghnag/tentacle/.tentacle/tmp/orchestration/sim.lock`
   (mkdir; wait if present; rmdir after): `bun run e2e:mobile --udid <iPhone 17 Pro>
   --only 90-perf-stream` on `main` then on the branch. Must hold: PERF PASS, 0 jank
   lines, `starts=1`, settle no worse than `main`'s (s5: 705–717 ms), panes no worse,
   `folds/s` and `renders/s` no higher than `main`'s. No build is published.
3. `bun test apps/mobile/test`, `tsc -p apps/mobile`, `biome check` on the changed
   files; the full `bun run check` before done.

## Execution

*— claude-sonnet-5-5, 2026-11-28*

**Open, blocks merge:** the Plan correction above. The approved steps are built and
green, and wiring them exposes that ordering bug in the app. The correction is not
coded.

**Load-bearing check (re-run before editing): holds.** The worktree had no
`node_modules`, so I ran `bun install --frozen-lockfile` in it. Repro copy
`ingest-runs-tree.ts` = the Context script plus two arguments: argv[3] is the tree
whose `apps/mobile` is imported (packages stay the main checkout's; `packages` and
`apps/mobile` had no diff against `main`), argv[4] is busy µs per fold inside
`onStreamFold`, standing in for a slower engine.

```
jit ATTACH N=4000: caught up in 61 ms | 4000 stream folds, 10 notifications | longest run of folds with NO macrotask between: 4000 folds over 2.5 ms
```

**As built, in order**

1. `stream-batch.ts`: `SLICE_MS`, `GAP_MS`, `createSlicer`, header. 3 slicer tests
   red on a never-spent stub, then green. The gap test passes on the stub (m4
   proves it).
2. `session-feed.ts`: `slice?` dep, `createPace` (the Design's loop body, as one
   function), one `fold` helper, `release()` at the end and in `catch`. B1, B2, B5
   red first (a 625.25 ms task; 5 000 and 6 000 stream puts), then green. B3, B4, B6,
   B7 are guards, green on both.
3. `session-screen-controller.ts`: `schedule` hoisted, `slice` passed. C red first
   (5 000 folds), then green.
4. `changelog.d/mobile-ui-fluidity-s6.fixed.md`.

**Drift**

- B driver: a fold costs 0.125 ms, not 0.1 (exact sums); B1's bound is
  `SLICE_MS + 2 × 0.125`, because the turn bracket's `put` rides on the first slice.
  C uses 0.125 too. B5 also asserts merged puts.
- Gate 0 ran on the branch only (below).
- The failure-mode row for a new foreign turn is wrong (Plan correction).

**Mutations** (`mutate.ts`: apply, run the 3 touched test files, write the original
back). All caught:

| Mutation | Red |
|---|---|
| m1 no `await` at the budget | B1 (50 pass, 1 fail) |
| m2 no deferred flush | B4, C (49 / 2) |
| m3 fold prose directly in backlog mode | B2, B5, C (48 / 3) |
| m4 no gap reset in `arrive` | slicer gap test, B3 (49 / 2) |
| m5 controller passes no `slice` | C (50 / 1) |
| m6 no `release()` in `catch` | B6 (50 / 1) |

**Repro, before → after** (JIT; before = main checkout, after = this worktree)

| N, extra µs/fold | stream folds | longest run with no macrotask |
|---|---|---|
| 4 000, 0 | 4 000 → 4 000 | 2.5 → 3.0 ms (under 8 ms: the budget never trips) |
| 4 000, 25 | 4 000 → 242 | 4 000 folds / 102.1 ms → 241 folds / 7.2 ms |
| 100 000, 0 | 100 000 → 21 705 | 100 000 folds / 28.1 ms → 21 703 folds / 6.9 ms |

Not run: the interpreter (`BUN_JSC_useJIT=0`, needs an approval).

**Gate 0** (`90-perf-stream`, iPhone 17 Pro iOS 26.5, under `sim.lock`, released;
runner `gate0.ts`; app key `5931980f1904`). No same-session `main` run: the baseline
is s5's recorded branch run. The first attempt built the app and hit my 570 s
timeout before the flow; the second ran it.

| | s5 recorded | this branch |
|---|---|---|
| verdict | PERF PASS | PERF PASS |
| jank / streaming fan lines | 0 / 4 | 0 / 4 |
| `starts` | 1,1,1,1 | 1,1,1,1 |
| settle ms | 705, 717, 710, 712 | 716, 735, 707, 707 |
| panes `shell` / `tail` / `cells` | 3 / 1209 / 118 | 3 / 1233 / 118 |
| `renders/s` | n/a | n/a |

Settle's worst sample is 18 ms higher and `tail` 24 higher (s5's `main` side read
1222). One run each: whether this is spread or the change is **unverified**. The
output carries no `folds/s`.

**Checks:** 3 touched files 51 pass, 0 fail; `bun test apps/mobile/test` 5987 pass,
0 fail (before a format-only rewrite of `session-feed.test.ts`); `tsc -p apps/mobile`
clean; `biome check` on the 6 changed files clean. Full `bun run check` not run (the
orchestrator's). No protocol change.

**Disk:** 3.6 GiB free after the gate. My build left
`~/Library/Developer/Xcode/DerivedData/tentacle-akcqdinhpvikysgobrlegvnkmvrm`
(7.1 GB, `WorkspacePath` = this worktree); deleting it was not approved.

## Review

*(empty — fresh-context Opus review)*
