# fix/tui-expand-latency — Ctrl+O expand takes ~0.5 s on a big session

> **Status:** done — reviewed (MERGE), owner merge OK 2026-10-25; gate 2680 pass / 2 skip / 0 fail
> **Branch:** `fix/tui-expand-latency`
> **Type:** fix · **Size:** M · **Blast:** contained · **Suited:** Sonnet executes, Opus reviews (standard in-context Review is enough: one module, pure functions, no API/protocol/persistence/IO change)

## Context

*— claude-sonnet-5-5, 2026-10-25*

Owner report (2026-10-25): on a ~120k-token session, Ctrl+O (expand all tool output) feels like ~0.5 s of latency; Ctrl+O again to collapse feels instant.

Cause (measured, below): expanding lays out every tool item from scratch, and almost all of that is `wrapLines` (`wrapAnsi` per line) although 97 % of the lines already fit the width. On top of that `rowCache` keeps ONE entry per item, so every flip of Ctrl+O is a miss for every tool item (collapse costs 35 ms, a second expand costs the full price again).

Owner-approved plan (not to be widened): (1) a fast path in `wrapLines` for lines that fit, output-identical; (2) two cache slots per item (collapsed + expanded); (3) measure the whole toggle (App render), report residual costs as open points, fix nothing else.

**Repro** (2026-10-25, current code, `.tentacle/tmp/ctrlo-latency/`, a copy of the owner's real session: 630 KB, 258 items, 189 tools; width 150). `t.ts` = `messagesToItems(session.messages)`, then for each step `layoutTranscript(items, {expandAll, width: 150})` + `sliceLaid` of the last 50 rows, timed:

```
$ bun run .tentacle/tmp/ctrlo-latency/t.ts .tentacle/tmp/ctrlo-latency/session.json
items 258 { user: 2, tool: 189, assistant: 67 }
collapsed (cold)      63 ms  rows 1576
collapsed (warm)       0 ms  rows 1576
expand #1            239 ms  rows 8939
collapse              35 ms  rows 1576
expand #2            231 ms  rows 8939
expand (warm)          0 ms  rows 8939
```

Orchestrator's breakdown (`fast.ts`): `wrapLines` over the 8048 expanded tool lines ≈ 209 ms; 7790 (97 %) already fit the width; `string-width` over all of them ≈ 20 ms.

Full toggle through the real `App` (`app.ts`: `ink-testing-library` render with `initialItems`, `stdin.write("\u000F")`, time to the next frame; stdout width 100):

```
expand #1      231 ms to new frame
collapse        44 ms to new frame
expand #2      204 ms to new frame
collapse #2     37 ms to new frame
```

## Implementation

*— claude-sonnet-5-5, 2026-10-25*

### Load-bearing assumption

For a line that is a single logical line, NFC-normalised, and whose `string-width` ≤ the wrap width, `wrapAnsi(line, w, {hard:true, trim:false, wordWrap:true})` returns the line byte-for-byte. Source: `packages/tui/node_modules/wrap-ansi/index.js` — `wrapAnsi()` does `.normalize()`, `\r\n→\n`, `.split("\n")` per line (so those three must be excluded); `exec()` with `trim:false` only ever inserts a row break when `rowLength + word > columns` or `rowLength >= columns` before a further word, impossible when the whole line fits; the SGR close/reopen code is added only next to a `\n` (`pre[index+1] === '\n'` / `character === '\n'`), and there is none. `carryColor` still runs on the result (an unclosed truecolour fg gets its `39` appended exactly as before). Proven empirically below, not just by reading.

### Preconditions

- `wrapLines` is the single place every transcript row is wrapped (`render-lines.ts`, `itemRows` → `wrapLines(itemLines(...), width)`).
- `rowCache` is module-private and only used by `itemRows`; `warmRowsChunk`/`layoutTranscript` go through `itemRows` (`render-lines.ts`), so the resize warm in `App.tsx:545-551` benefits from both changes with no edit.
- `string-width` is already imported in `render-lines.ts` and is the same function wrap-ansi uses for widths.

### Design

1. `wrapLines`: `expandTabs(line)`, then `fitsUnchanged(text, w)` (no `\r`/`\n`, `stringWidth(text) <= w`, `text.normalize() === text`) → `carryColor([text])`; otherwise the unchanged `wrapAnsi` path.
2. `rowCache` entry = `{width, threshold, preview, collapsed?, expanded?}`; `itemRows` picks the slot (`expanded` only for a tool item with `expandAll`, else `collapsed`). Matching key → return the slot if filled, else compute and fill it; mismatching key → fresh entry (both slots invalidated). Non-tool items ignore threshold/preview as before.

### Files

- `packages/tui/src/render-lines.ts` (`wrapLines`, new `fitsUnchanged`, `RowCacheEntry`, `itemRows`)
- `packages/tui/test/render-lines.test.ts`

### Failure modes

- Line with `\n`/`\r\n`, NFD text, or too wide → full `wrapAnsi` path (tested).
- Width, threshold or preview change → both slots dropped, nothing stale served (tested).
- Memory: a second view per tool item stays alive as long as the item (WeakMap), see Execution.
- Resize while expanded: `warmRowsChunk` fills the slot for the current `expandAll` only; the other is filled on first toggle (one miss, as today).

### Tests

- Identity over varied lines (SGR, truecolour `38;2`/`48;2`, bg bars, CJK, emoji, NFD, trailing spaces, exact-width, empty, tab, `\r`, `\n`, `\r\n`, OSC-8 link) vs the old implementation, at widths 1–80.
- Spy on `wrap-ansi`'s `default`: fitting lines → 0 calls, overflowing → 1, rewritable-but-fitting (`\n`, NFD, `\r\n`) → still called.
- Spy on `formatDurationMs` (called once per tool (re)layout): collapsed→expanded→collapsed→expanded lays out each item twice in total; width change invalidates both; threshold change re-lays-out the collapsed view with correct rows.

### Extension — idle warm of the other view (owner decision 2026-10-25)

*— claude-sonnet-5-5, 2026-10-25*

The first expand is still ~317 ms on `session-long.json` (2.6 MB, 1644 items, 35185 expanded rows; main was 876 ms). The owner wants it instant too.

- **Design.** New pure module `packages/tui/src/idle-warm.ts`: `otherViewOpts(state)` decides *whether and which* (null while `running` or `busy`, or with no `tool` item; else the same options with `expandAll` flipped); `startIdleWarm(state, hooks)` schedules it with injected timers: after `IDLE_WARM_DELAY_MS` = 400 it loops `warmRowsChunk(items, other, idx, 6)` and yields with `setTimeout(0)`; it returns a cancel function. It only fills `rowCache` (via `warmRowsChunk` → `itemRows`), so nothing rendered or committed changes. 400 ms: every stream flush, tool update or notice changes `items` and restarts the wait, so a streaming turn / burst never starts it; long enough to sit out key-repeat of Ctrl+O, short enough to finish before someone who paused to read toggles.
- **Wiring (`App.tsx`, ~15 lines).** One `useEffect` after the layout, deps `[items, running, busy, expandAll, columns, daemonInPod]`: the cleanup is the supersede (new item/update, turn start, Ctrl+O, resize commit); `running = st.running || permission.pending !== null`; `busy = loading !== null || warmingRef.current` (a history warm in flight). `onResize` calls `idleWarmCancelRef.current()` so a resize warm never competes with it.
- **Failure modes.** Cancelled before the delay → no work; cancelled mid-way → no further chunk; width changed meanwhile → the warmed slot has the old width key and is not served (tested); chunk granularity is one item, so one very large item can exceed 6 ms (as in the resize warm).
- **Tests.** `idle-warm.test.ts` (fake timers, spy on `formatDurationMs`): after the warm a toggle both ways lays out nothing; cancel mid-way / before the delay does no further work; no timer while running; busy / no-tool → null; stale width not served. `app.test.tsx`: after the quiet delay the first Ctrl+O recomputes no item and shows the expanded rows.

## Execution

*— claude-sonnet-5-5, 2026-10-25*

**Baseline** (before edits): `bun run check` → typecheck ok, lint clean, 2662 pass / 2 skip / 0 fail.

**Done, in order**
1. Repro above reproduced (numbers in Context, re-run on branch tip `9bddb2a`).
2. `render-lines.ts`: fast path (`fitsUnchanged`) in `wrapLines`; two-slot `rowCache`/`itemRows`.
3. Identity check on the owner's session (`ident.ts`: old `wrapAnsi`+`carryColor` copy vs the new `wrapLines`, over `itemLines` of every item, 3 widths × expanded/collapsed): **0 items differing** in all 6 configurations (e.g. width 150 expanded: 8120 lines → 8682 rows, byte-identical; width 80: 10368 rows; width 40: 15976 rows).
4. Tests added in `render-lines.test.ts`.

**Red before green** (the identity test cannot be red; the perf properties are pinned by counters). Each mutation applied, test run, reverted:
- `fitsUnchanged` → `false` (= old behaviour): `a line that fits is not handed to wrapAnsi` fails (`Expected: 0, Received: 4`).
- guard reduced to `stringWidth(text) <= w` (drop `\r\n` and normalize checks): `identical to the reference wrap` and `a fitting line that wrapAnsi would rewrite still takes the full path` fail.
- cache drops the other slot on each miss (= old single slot): `a second toggle … lays nothing out again` and `a width change invalidates both slots` fail.
After each revert the source is byte-identical to the pre-mutation copy (`shasum` 57e19225…; `git status --short` shows only the two intended files).

**Numbers after** (same session, width 150; `layoutTranscript` only, `t.ts`):

| | before | after |
|---|---|---|
| collapsed cold | 63 ms | 41 ms |
| expand #1 | 239 ms | 108 ms |
| collapse | 35 ms | 0 ms (hit) |
| expand #2 | 231 ms | 0 ms (hit) |

Full toggle through `App` (`app.ts`, time to next frame):

| | before | after |
|---|---|---|
| expand #1 | 231 ms | 128 ms |
| collapse | 44 ms | 4 ms |
| expand #2 | 204 ms | 7 ms |
| collapse #2 | 37 ms | 4 ms |

**Step 3 finding — what else is on the Ctrl+O path:** in the App, a cache-hit toggle costs 4–7 ms total (`layoutTranscript` O(items) lookups + `sliceLaid` + Ink render), so nothing else is O(transcript) in a way that matters; the residual user-visible cost is only the FIRST expand (128 ms in the App, 108 ms in layout). Not touched.

**Memory** (owner's session, width 150, rows held): collapsed view 1319 rows / 75 k chars; expanded view 8682 rows / 426 k chars (separator rows excluded). Holding both costs, at most, the second view: ≈ +0.15 MB (UTF-16) when in expanded mode, ≈ +0.85 MB when in collapsed mode after one expand. Both die with the item (WeakMap).

**Gate:** `bun run check` → typecheck ok, lint clean (0 errors / 0 warnings), 2668 pass / 2 skip / 0 fail (baseline 2662 + 6 new tests; skips = the 2 opt-in).

**Open points (not fixed, per plan):**
- First expand still ≈ 108–128 ms: the remainder is building the expanded lines (`itemLines`: syntax-highlight `highlightRead` of whole files, chalk per line), `string-width` per line (~20 ms) and `normalize()`. Could be warmed off-thread/idle after load (like the resize warm), or the highlight made lazy; separate task if wanted.
- A resize warms only the current view; the other view's first toggle after a resize is a miss (same as today's first toggle).

**Drift from Implementation:** none.

### Execution — idle warm of the other view (owner extension, 2026-10-25)

*— claude-sonnet-5-5, 2026-10-25*

Done in order: `idle-warm.ts` (pure, injected timers) → `App.tsx` effect + `onResize` cancel + imports → `idle-warm.test.ts` (8 tests) → one App test → measurements → gate.

**Numbers** (width 150; `warm.ts` for layout, `app.ts` for the App path, which waits 1.5 s after mount so the warm is done):

| | session.json (258 items, 8939 rows) | session-long.json (1644 items, 35185 rows) |
|---|---|---|
| first expand, layout, before the extension | 108 ms | ~317 ms (orchestrator) |
| first expand, layout, after the warm | 0.2 ms | 0.6 ms |
| first expand, full App path (time to frame) | 9 ms (was 128) | 10 ms |
| warm: wall time / chunks | 119 ms / 13 | 353 ms / 42 |
| extra heap held by the second slot | +1.8 MB | +6.0 MB |
| expanded rows / chars held | 8682 / 426 k | 35185 rows / 1.62 M chars (separators included) |

The warm starts 400 ms after the last change and runs in ≈ 8 ms-ish slices (budget 6 ms + at most one item) between event-loop turns.

**Red before green** (new module, so "red" = each mutation fails the named tests; reverted, `shasum` identical to the pre-mutation copies: `idle-warm.ts` 524b6c1d…, `App.tsx` 4796f786…):
- `otherViewOpts` returns the *same* view (no flip): `after the warm, a Ctrl+O toggle lays out no item again`, `cancelling … mid-way`, `the opposite view`, and the App test fail.
- cancel function replaced by a no-op: `cancelling … mid-way` and `cancelling before the delay …` fail.
- `running` ignored in `otherViewOpts`: `never while a turn runs …` and `no timer is even scheduled while a turn runs` fail.
- App wiring `idleRunning = true`: the App test fails (no warm → the Ctrl+O lays items out).

**Gate:** `bun run check` → typecheck ok, lint clean, 2677 pass / 2 skip / 0 fail (+9 over the previous 2668).

**Not covered by a test (open points):** the `onResize` → cancel wiring and `busy` (history warm) in the App are only covered at the pure level (`busy` → null); a resize/new-item supersede is covered by the cleanup semantics of the effect, tested via the cancel function, not through a live App resize. (Closed by Fix 2 below.)

### Fix 2 (Review)

*— claude-sonnet-5-5, 2026-10-25*

Review finding 2: the three `App.tsx` wirings of the idle warm were unpinned (removing all three left every TUI test green). Added three App-level tests in `app.test.tsx` (`what the App feeds the scheduler`), deterministic — no timers, no wall-clock asserts. They observe the seam `startIdleWarm` (spied with `mockImplementation`: records the `IdleWarmState` the App passes and counts the cancel function's calls):
- **permission prompt:** with a `PermissionBroker` request pending, the last scheduled state has `running: true` (and `false` before and after the answer).
- **history warm in flight:** `createSession` yields a `history_reset` of 60 messages (> `WARM_THRESHOLD`); `renderLines.warmRowsChunk` is held (no progress) until a gate opens, so the loading bar / `warmingRef` is up deterministically: last state has `busy: true`, then `false` once the gate opens.
- **resize:** `Object.defineProperty(stdout, "columns", 120)` + `emit("resize")`; synchronously (before the new width commits, whose effect cleanup would cancel anyway) the cancel count is +1 — only `onResize` can have done it.

Each red under its own mutation, then reverted: `idleRunning = st.running` (drops `permission.pending`) → the permission test fails; `idleBusy = false` → the history-warm test fails; `idleWarmCancelRef.current()` removed from `onResize` → the resize test fails (the other two stay green in each case). After the reverts `App.tsx` shasum = 4796f786… (identical to before).

Finding 1 (resize + idle warm at the old width) deliberately untouched: it goes to the owner.

**Gate:** `bun run check` → typecheck ok, lint clean, 2680 pass / 2 skip / 0 fail (+3).

## Review

*— claude-opus-5-5 (fresh context; a different model family member from the Sonnet executor, same vendor), 2026-10-25*

**Verdict: APPROVE-WITH-NITS.** The fast path is output-identical (fuzzed plus both owner fixtures), the two-slot cache serves no stale rows, and the idle warm only fills the cache. None of the findings below block a merge. Finding 1 is the only one that needs an owner decision.

**Gate (re-run by me on the final tree):** typecheck ok, lint clean (471 files, 0 issues), tests **2677 pass / 2 skip / 0 fail** (2679 across 210 files). The two skips are the opt-in ones, and the counts match Execution.

**Findings**
1. *Low, owner decision.* A stale-width idle warm can evict the cache during a resize warm (`App.tsx:546`, `App.tsx:636-645`). `onResize` cancels only the idle warm that is scheduled when the resize starts. If a deps change (a notice, a job exit, `loading`) re-renders while the resize warm is still running, the effect schedules a new idle warm at the OLD `columns`. If the resize warm then takes more than 400 ms, that warm overwrites the new-width entries (a width mismatch creates a fresh entry), and the committing render misses again. Measured mechanism: warming every item at another width, then laying out the shown view, gives 305 ms on `session-long.json` (0.4 ms without the eviction). Reaching this needs a long session, a resize, and a change during the resize, all at once. A render at the old width during a resize warm (e.g. a keystroke) already does the same thing on `main`, so this adds a path but no new class of bug. Possible fixes: skip the idle warm while a resize warm is in flight, or key the cache by width. This would be a separate task.
2. *Low, test gap.* The App wiring is not pinned. I mutated three things together: removed the `onResize` cancel, set `idleRunning = st.running` (dropping `permission.pending`), and set `idleBusy = false`. The whole TUI suite stayed green (617 pass / 0 fail). Execution admits this for resize and busy; it does not mention the permission term. The pure-level tests (`otherViewOpts`) do cover `running` and `busy`.
3. *Nit.* The metadata line still reads `Size: S · Blast: contained · … no IO change`. The extension adds render-thread timers in `App.tsx` and a new module, so it is `M`. Blast is still arguably `contained`. `Status: execution` is also stale.

**Premise table**
| Premise | Verdict |
|---|---|
| Context symptom (expand much slower than collapse, single-slot miss) | TRUE. Main-ro shows the single-slot key (old `itemRows`), and the toggle sequence below re-lays-out on every flip. I did not re-time it on main; I relied on the executor's and orchestrator's numbers. |
| wrap-ansi only normalises, rewrites `\r\n`, and splits on `\n`; with `trim:false` and a line that fits, it inserts no break and no SGR close/reopen (`wrap-ansi@9.0.2/index.js:103-221`) | TRUE (read, and fuzzed below) |
| `string-width` in `render-lines.ts:13` is the same function wrap-ansi uses | TRUE: both resolve to `string-width@7.2.0`, the same path |
| `wrapLines` is the single wrap site, and `warmRowsChunk`/`layoutTranscript` go through `itemRows` | TRUE |
| Items are immutable, so WeakMap identity is a valid key | TRUE: no in-place assignment to `resultText`/`status`/`endedAt`/`args` in `packages/tui/src` |
| Ink renders in legacy (synchronous) mode, which matters for `idleBusy` reading `warmingRef` | TRUE (`ink.js:59-61`). `setLoading(null)` re-renders while `warmingRef` is still true, and the callers' `flushNow`/next event re-render with busy=false afterwards, so a warm is scheduled. |

**Attacks tried**
- *Fast-path identity, fuzz.* 600 k random lines, two seeds, widths 1–24. The alphabet covered SGR including `38;2`/`48;2`/`38;5`, bare `\x1b[m`, `\x1b[K`, OSC-8, space followed by a combining mark, NFD/NFC/Å/ﬁ, CJK, Hangul jamo, Devanagari conjuncts, emoji/ZWJ/VS16/flags, ZWSP, soft hyphen, tabs, `\r`, `\n`, `\r\n`, BEL, and exact-width plus trailing-space lines. I compared main-ro's `wrapLines` with the branch's: **0 diffs** (about 50 % of cases took the single-row path).
- *Owner fixtures, both, final code.* A 12-step toggle/resize sequence (150/97/40 × both views), warming the opposite view through `warmRowsChunk` before each layout. Every per-step row hash and the overall hash are identical between main and the branch: `session.json` ALL `d4ac68019a67`, `session-long.json` ALL `4de4d9e9dcd0` (35185 expanded rows at width 150). No stale slot was served after a width change or a flip.
- *Two-slot cache.* A width, threshold or preview mismatch creates a fresh entry, which drops both slots. The same rule applies to non-tool items, which always use `collapsed`. `spillInPod` is not part of the key, the same as on main; it is constant per session. Memory: WeakMap, so `/clear` and history replacement release entries. A cancelled warm releases its `items` closure.
- *Idle warm scheduling.* `otherViewOpts` short-circuits on `running` before the O(items) `some()`, so a streaming flush pays nothing. When idle, the toggle back re-warms the already-cached view, which is lookups only. Unmount runs the effect cleanup, which cancels. A Ctrl+O mid-warm cancels the warm through the cleanup; already-warmed items hit and the rest compute synchronously. Nothing is committed or rendered.
- *Chunk blocking, real timers, `session-long.json`.* 44 chunks over 374 ms. The longest slices were 14.7, 14.0 and 10.2 ms; the worst single item was 11.1 ms. The first expand after the warm took **0.4 ms**. These were measured while a parallel test gate was loading the CPU, so they are pessimistic.
- *§7.* The logic is in the pure module (`idle-warm.ts`, injected timers); `App.tsx` only schedules. Transport, protocol and the RPC peer are untouched, and nothing writes to the terminal.

**Mutation non-vacuity**
- Dropping `normalize()` from `fitsUnchanged` (`render-lines.ts:583`) fails 2 tests (`identical to the reference wrap…`, `a fitting line that wrapAnsi would rewrite…`).
- The App wiring mutations from finding 2 fail **0 tests**.

After the mutations, all three sources are byte-identical to before: `App.tsx` 4796f786…, `render-lines.ts` 57e19225…, `idle-warm.ts` 524b6c1d…. `git status --short` is unchanged.

**What holds:** the identity, the cache correctness, the cancellation semantics, no rendering side effects, and a toggle in either direction is a hit after the warm. The gate is green.

**Executor behaviour:** stayed within scope, measured before and after, ran mutations on the pure-level tests, and stated its open points honestly (resize/busy wiring untested). It missed the permission-term gap and the resize-race path in finding 1. It did not update the metadata after the extension.

### Owner decisions on the findings

*— claude-opus-5-5 (orchestrator), 2026-10-25*

- **Finding 1 (resize + event → idle warm at the old width):** not a merge
  blocker; a separate small task in `TODO.md` (`3aa76c0`).
- **Finding 2 (App wirings unpinned):** fixed in Fix 2 (3 App tests, each red
  under its own mutation).
- **Finding 3 (doc metadata):** fixed in Fix 2 (Size M, Status).
- Orchestrator gate after Fix 2: 2680 pass / 2 skip / 0 fail, lint clean.
  Orchestrator identity re-check on the final code: rows byte-identical to
  main on both fixtures (widths 40/97/150, both views).
