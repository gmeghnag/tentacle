# feat/mobile-ui-fluidity-s1 — break the thumbnail feedback loop

> **Status:** implementation (APPROVED, delegated) · execution · review
> **Branch:** `feat/mobile-ui-fluidity-s1`
> Type: feat · Size: S · **Blast:** contained · Suited: Sonnet plan/review, DeepSeek exec
> **Changelog:** `changelog.d/mobile-ui-fluidity-s1.fixed.md`

## Context

*— claude-sonnet-5-5, 2026-11-28*

Slice 1 of `docs/eval/mobile-ui-fluidity.md` (APPROVED by the owner 28/11;
Root cause point 3, Migration plan row 1). Scope is that row only.

While a turn streams, the session screen renders about twice as often as the
100 ms coalescer allows:

1. The screen's effect keyed on `rows` calls `controller.window(...)`
   (`apps/mobile/src/screens/SessionScreen.tsx:854-856`).
2. `window` calls `driver.view(...)`
   (`apps/mobile/src/session-screen-controller.ts:2189-2191`).
3. `view` calls `commit(step.state)` on every call
   (`apps/mobile/src/thumbnails.ts:312`).
4. `commit` calls `onChange` (`thumbnails.ts:287-290`), and the controller's
   `onChange` calls `emit()` (`session-screen-controller.ts:860-867`), which is
   the immediate `render.now()` (`:1515-1517`): a second full screen render for
   every coalesced one.

### Repro

Run 2026-11-28 on this branch's source (HEAD `9ea37ba1`).

The eval's script (its Repro B, real controller, 100 reasoning deltas over 1 s):

```
branch source:
  window effect absent: 10 screen notifications for 100 deltas over 1 s (design: <= 10)
  window effect wired: 20 screen notifications for 100 deltas over 1 s (design: <= 10)
copy with only the thumbnails.ts guard (Design below):
  window effect absent: 10
  window effect wired: 10
```

The two proposed tests (code under **Tests**), run on both copies:

```
test-red     during: 20, asked: 11 → expect(during).toBeLessThanOrEqual(10)  Received: 20  (fail)
             driver: expect(commits).toBe(0)                                 Received: 1   (fail)
test-patched during: 10, asked: 11 → both pass, with the 3 existing stream-render tests
total: 8 pass, 2 fail
```

How it ran: `.tentacle/tmp/mobile-ui-fluidity-s1/` in the main checkout holds
two copies of `apps/mobile/src` (`src-red`, `src-patched`), with packages
resolved through a symlink to the main checkout's `apps/mobile/node_modules`.
This worktree has no installed dependencies (`Cannot find module
'@tentacle/client'`), so run `bun install --frozen-lockfile` before any test.

## Implementation

*— claude-sonnet-5-5, 2026-11-28* — **APPROVED** (owner delegated the details;
no AGENTS §7 trust rule is touched).

### Load-bearing assumption

In `view()`, the thumbnail state changes **iff** `step.start` or `step.abort` is
non-empty. So skipping the commit otherwise loses nothing.

- `plan` returns `{ ...state, inFlight }` (`thumbnails.ts:217`): `inFlight` is
  the only field it can change.
- `inFlight` starts as the old list minus exactly the `abort` ids
  (`thumbnails.ts:188-189`) and only grows by the ids pushed to `start`.
- The object and array are always new, so a reference comparison would not
  work. The test is `start.length > 0 || abort.length > 0`.

Proven by execution: with that guard alone, 20 → 10 (Repro).

### Preconditions

- The driver has one production consumer, the controller
  (`session-screen-controller.ts:860`), and `window()` does nothing besides
  `view()` (`:2189-2191`). The driver's `onChange` is therefore the only `emit`
  on this path.
- A fetch settle commits only while its request is still pending
  (`thumbnails.ts:315-323`, `settle`), and each outcome changes the state (the
  id leaves `inFlight`). Those commits stay.
- The screen asks the window from two places: viewability
  (`SessionScreen.tsx:537-544`) and the rows effect (`:854-856`), both pinned by
  `test/mobile-media-live-wiring.test.ts:182-195`.
- No render depends on the removed notification through a ref: viewability
  writes only `visible.current`, read only by those two calls
  (`SessionScreen.tsx:539, 543, 855`). Follow state reaches React through its
  own `setFollow` (`:622-626`).
- A streamed delta already reaches the screen through `render.soon()` and
  anything else through `emit()` (the feed's `put`,
  `session-screen-controller.ts:870-905`; coalescer at `:1505-1517`, window
  `render-coalesce.ts:22`).

### Design

In `createThumbnailDriver.view` (`thumbnails.ts:312`) replace the unconditional
commit with:

```ts
// An unchanged plan commits nothing: the screen asks on every new `rows`, and a
// commit per ask re-rendered it twice per streamed update.
if (step.start.length > 0 || step.abort.length > 0) {
  commit(step.state);
}
```

Everything else in `view` stays and stays unconditional: the abort loop,
`pending = new Map(step.pending)`, and the start loop. No change to `plan`, the
coalescer, the screen, or any protocol or persisted format.

#### Orchestrator decisions

1. **Where the guard lives.** Recommended and **chosen**: in the driver only;
   `session-screen-controller.ts` is not edited. "The controller emits only on a
   real change" then holds on this path because `onChange` fires only on a real
   change, and the integration test pins it through the real controller.
   Rejected: also adding `if (next === thumbnails) return;` in the controller.
   After the driver fix no caller can reach it, so no test can show it red
   (AGENTS §9). This narrows the eval row's file list by one file.
2. **A general "did the screen state change" comparison in `notifyListeners`.**
   Rejected: that is slice 3 (store and slices), with its own stale-UI risk.
3. **Changelog category:** `fixed`.

### Files

1. `apps/mobile/src/thumbnails.ts`: the guard above.
2. `apps/mobile/test/thumbnails.test.ts`: the driver test.
3. `apps/mobile/test/session-screen-stream-render.test.ts`: the integration test.
4. `changelog.d/mobile-ui-fluidity-s1.fixed.md`, one bullet:
   `- **The phone app redraws less while a reply streams.** A session screen no longer renders twice for each streamed update, which leaves more time for taps and animations.`

### Failure modes

| Case | How state converges |
|---|---|
| Window only drops requests (scrolled to rows with no images) | `abort` non-empty → commit; `inFlight` empties. Tested. |
| Window only adds requests | `start` non-empty → commit. Tested. |
| Unchanged window, requests still in flight | No commit; the state is already what the screen holds. Their settle commits. Tested. |
| More images than `MAX_IN_FLIGHT` | After a settle, the next `view()` starts the next one and commits. `plan` still runs on every call; only the notification is skipped. When `view()` is called is unchanged. Tested. |
| Fetch fails, answers `null` or `"gone"` | `settle` path untouched: one commit each. |
| Unmount / signal already aborted | `close()` and `plan` untouched; a request created on an aborted signal is in `start`, so it commits as today. |
| A pending stream delta that the second emit used to flush early | It now arrives at the coalescer's deferred fire (≤ 100 ms), as designed. Turn end and non-stream changes stay immediate (existing tests). |
| Some other state change relying on the extra emit | None found on the paths in Preconditions; not proven for every controller setter. Full gate plus review check it; a symptom would be UI stale until the next change. |
| Disconnect, version skew | Not applicable: no wire or disk change. |

### Tests

Write both first and show them **red on the assertion** before the edit (§9).

**A. `session-screen-stream-render.test.ts`**, using the file's `harness`,
`pushedTurn` and `settle`:

```ts
describe("the screen's rows-keyed window effect does not double the renders", () => {
  test("100 deltas in 1 s with the effect wired: at most 10 notifications", async () => {
    const h = harness();
    await h.screen.open();
    await settle();
    // The screen's effect (`SessionScreen.tsx`, keyed on `rows`), emulated.
    let rows: unknown = null;
    let asked = 0;
    h.screen.subscribe((s) => {
      if (s.view.rows !== rows) {
        rows = s.view.rows;
        const next = s.view.rows;
        queueMicrotask(() => {
          asked += 1;
          h.screen.window(0, next.length - 1, next);
        });
      }
    });
    const turn = pushedTurn();
    h.emit(turn.activity);
    await settle();
    const before = h.states.length;
    for (let i = 0; i < 100; i += 1) {
      turn.push({ type: "reasoning", delta: `w${i} ` } as SessionEvent);
      await settle();
      h.advance(10);
      await settle();
    }
    const during = h.states.length - before;
    expect(during).toBeLessThanOrEqual(10);
    expect(during).toBeGreaterThanOrEqual(9);
    expect(asked).toBeGreaterThanOrEqual(9);
    h.advance(STREAM_RENDER_MS);
    expect(JSON.stringify(h.states[h.states.length - 1]?.view.rows)).toContain("w99");
  });
});
```

The lower bounds keep it non-vacuous: the stream still renders and the effect
really ran.

**B. `thumbnails.test.ts`**, using the file's `ref`, `userRow`, `NOTICE`,
`settle`:

```ts
describe("the driver commits only a changed plan", () => {
  test("an unchanged window is silent; a start, a settle and an abort-only step each commit once", async () => {
    let commits = 0;
    const calls: ((thumb: { id: string; uri: string }) => void)[] = [];
    const driver = createThumbnailDriver(
      { fetch: () => new Promise((resolve) => calls.push(resolve)) },
      () => {
        commits += 1;
      },
      new AbortController().signal,
    );
    const rows = [
      userRow([ref("a")]),
      ...Array.from({ length: 40 }, () => NOTICE),
      userRow([ref("b")]),
    ];
    driver.view([NOTICE], 0, 0);
    expect(commits).toBe(0);
    driver.view(rows, 0, 0); // start a
    driver.view(rows, 0, 0); // unchanged, a in flight
    expect(commits).toBe(1);
    calls[0]?.({ id: ref("a").id, uri: "file:a" });
    await settle();
    driver.view(rows, 0, 0); // unchanged, a loaded
    expect(commits).toBe(2);
    driver.view(rows, 41, 41); // start b
    expect(commits).toBe(3);
    driver.view([NOTICE], 0, 0); // abort b only
    expect(commits).toBe(4);
    expect(driver.state().inFlight).toEqual([]);
  });
});
```

Add one more case in B for the queue: `MAX_IN_FLIGHT + 1` images on one row;
`view` (1 commit), settle one (2), `view` the same window: the last image starts
(3) and `inFlight` has `MAX_IN_FLIGHT` entries. This case is green on the old
code by design (it guards the skip); A and the first B case are the red ones.
B was run in scratch with an inline row helper; the form above, using the file's
helpers, and the queue case were not run.

**Mutations** (apply, see red, revert): guard on `step.start.length > 0` only →
B fails at the abort-only step; guard on `step.abort.length > 0` only → B fails
at the first start.

### Validation

`bun test ./apps/mobile/test/thumbnails.test.ts ./apps/mobile/test/session-screen-stream-render.test.ts`
while iterating; then `bun run check` against the clean baseline (AGENTS §6).

### Notes / debt

- Not measured on simulator or device here. Expected effect is about half the
  renders while streaming; it does not reduce the cost of one render (slices
  3-4). So slice 0's perf gate, if merged, is not expected to go fully green
  from this slice alone.
- Existing behaviour left as is: an image queued behind `MAX_IN_FLIGHT` starts
  only at the next `view()` call, not when a slot frees.

## Execution

*— deepseek (V4.1 Flash), 2026-11-28*

### Preconditions, re-run on this worktree (branch HEAD `3239b1f4`)

`bun install --frozen-lockfile` first, as Context warned (the worktree had only
root dev deps). Then the Context's own Repro, `.tentacle/tmp/mobile-ui-fluidity-s1/`:

```
branch source (HEAD, no guard):  wired: 20 screen notifications / 100 deltas over 1 s
copy with the guard:             wired: 10
```

Load-bearing check holds: the guard alone takes 20 → 10. Nothing contradicts the
Implementation, so no plan step was stopped.

### As built, in order

1. **Tests first (red).** Added exactly the two tests of **Tests** A/B (B plus the
   queue case), using the files' existing helpers (`harness`/`pushedTurn`/`settle`;
   `ref`/`userRow`/`NOTICE`/`settle`/`createThumbnailDriver`/`MAX_IN_FLIGHT`):
   - `apps/mobile/test/session-screen-stream-render.test.ts:180-218`
   - `apps/mobile/test/thumbnails.test.ts:434-508`
   Red on the assertion, production code untouched:
   ```
   session-screen-stream-render: during = 20, expect(during).toBeLessThanOrEqual(10)   (fail)
   thumbnails:                   commit on the FIRST no-op window: expected 0, received 1 (fail)
   28 pass, 2 fail
   ```
2. **The fix.** `apps/mobile/src/thumbnails.ts:312-317`: `view()` commits only when
   `step.start.length > 0 || step.abort.length > 0`; the abort loop, the pending map
   and the start loop stay unconditional. Same two test files:
   ```
   30 pass, 0 fail
   ```
3. **Repro re-run against this worktree's fixed source** (a `feedback-worktree.ts`
   pointing at `apps/mobile/src/`): `wired: 10` (was 20), `absent: 10` — matches the
   designed figure.
4. **Changelog:** `changelog.d/mobile-ui-fluidity-s1.fixed.md`, the plan's one bullet.
5. **Narrow verification:** `bunx biome check` on the three changed files (clean),
   `bunx tsc -p apps/mobile --noEmit` (clean), `bun test ./apps/mobile/test`
   (5789 pass, 0 fail, 357 files). The full `bun run check` is the orchestrator's.

### Mutations (applied, seen red, reverted)

| Mutation | Red |
|---|---|
| `if (step.start.length > 0)` only | `thumbnails.test.ts` B: abort-only step — `Expected: 4, Received: 3` |
| `if (step.abort.length > 0)` only | B both cases: first start — `Expected: 1, Received: 0`; plus the pre-existing `a window change ABANDONS the fetches it scrolled away from` (`Expected length: 4, Received length: 12`) |

The queue case stays green under both mutants and on the old code, as designed
(it guards the skip, it is not a red test).

### Drift from Implementation

- **Test B's red lands one assertion earlier than the plan predicted.** The plan
  said B fails at the *second* unchanged view (`expect(commits).toBe(1)`); in fact
  the old code committed even the first `view([NOTICE], 0, 0)`, an empty step, so
  `expect(commits).toBe(0)` already fails. Same property (a commit per ask,
  changed or not); the assertion was left as planned because it reads as the
  contract. No code/design divergence.
- No other file touched: no controller edit (orchestrator decision 1), no protocol,
  schema or persisted-format change — so no `protocol.d/` note and no
  `protocol.json` regeneration.
- `changelog.d/mobile-ui-fluidity-s1.fixed.md` is new; `TODO.md` untouched (as
  instructed).

## Review

*— claude-sonnet-5-5, 2026-11-28* (fresh context; same model as the planner,
exec was DeepSeek. The brief asked for an `claude-opus-5-5` signature; the
session runs `claude-sonnet-5-5`, so that is what is signed.)

**Verdict: PASS (APPROVE).** No HIGH or MEDIUM finding.

**Gate** (run as three commands): typecheck clean; lint clean (2803 files);
`bun run test` 21402 pass, 5 skip, 0 fail (1476 files; the diff adds no skip).
The two touched files: 30 pass.

**Mutations** on the guard (`thumbnails.ts:314`), reverted, `git diff HEAD` empty:

| Mutant | Red |
|---|---|
| `if (true)` (= `main`) | A: 20 > 10; driver: 1 ≠ 0 |
| `start.length > 0` only | driver abort-only step: 3 ≠ 4 |
| `abort.length > 0` only | both new driver tests + the abandon test |
| `if (false)` | same three driver tests |

**Premises** (all TRUE against the pre-edit lines): `SessionScreen.tsx:537-544,
854-856, 622-626`; controller `:860-867, 870-905, 1505-1517, 2189-2191`;
`thumbnails.ts:188-189, 217, 287-290, 312, 315-323`; wiring test `:182-195`;
`render-coalesce.ts:22`. Symptom: reproduced with the `main` guard (20).

**Attacks tried**
1. State relying on the removed emit: surveyed the controller's state
   assignments in the attach, send, compose, activity, resync, compact, clear
   and artifact paths; each reaches `emit()` / `render.soon()` or a subscribed
   `onChange`. Nothing found (static, not proof for every setter).
2. Screen render reading a ref or clock that the scroll-triggered re-render
   refreshed: `visible` is read only by the two `window` calls; sticky row,
   scroll dim and follow set their own state; the copy pill, activity clock and
   voice have timers or ticks. Nothing found.
3. End-to-end through the real controller (`.tentacle/tmp/mobile-ui-fluidity-s1/
   review-trace.test.ts`, main checkout): effect wired, 5 images, 4 settles, 100
   deltas, abort-only window, turn end. Last notified state equals `state()` at
   each checkpoint; the queued 5th image starts; the abort is signalled and
   notified. 11 notifications over the delta loop (20 on the `main` guard).
4. Load-bearing assumption: `plan` changes only `inFlight`, by `abort` removals
   and `start` appends. Holds, also on an aborted signal.
5. §7: no protocol, persistence, broker or transport touched; logic stays in the
   pure driver. Scope is the five listed files.

**Executor:** followed the plan; the one drift (red one assertion earlier) is
reported and correct.

**Unverified:** device/simulator frame cost; check with a streaming turn on the
phone's perf trace.
