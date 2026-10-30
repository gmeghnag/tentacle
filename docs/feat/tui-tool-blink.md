# feat/tui-tool-blink — a blinking bullet on a running tool call

> **Status:** execution
> **Branch:** `feat/tui-tool-blink`
> **Size:** S–M · **Blast:** contained · **Suited:** DeepSeek executes, Opus reviews

## Context

*— deepseek-v4.1-flash, 2026-10-30*

A running tool call is drawn with the same `⏺` glyph for its whole life, so a
long shell call looks frozen: the bullet is static and the only sign of life is
the `running…` body line. Owner request (2026-10-30): the bullet must **blink**
while the call runs, "to give the sense of in progress"; on completion it
becomes today's ok (green) / error (red) bullet.

Owner decisions, fixed:

- 500 ms on / 500 ms off (1 s cycle).
- Starts **ON** when the call starts — a 200 ms call shows a steady bullet,
  never an "off" flash.
- OFF phase = a blank of **the same display width** as `⏺` instead of the glyph:
  round 1 used one space `" "` on `⏺` being 2 columns with `string-width`
  (measured in fix round 1: the premise was asserted, not measured, and the row
  re-wrapped at 1 Hz — review finding 1). The glyph is now
  `BLANK = "  "` (2 columns), swapped in after the wrap. The Ink empty-`<Text>`
  gotcha (AGENTS §6) does not apply because the glyph lives inside a row string,
  but a `""` would still be wrong.
- **One shared clock**: every running call blinks in sync; no timer per row and
  no timer at all when nothing is running.
- Only the running tool rows may change between phases: the rest of the
  transcript must not be re-laid-out per tick (long sessions; the per-item row
  cache in `render-lines.ts:646` and the idle warm logic in `App.tsx:717`).
- "Which glyph for this tool at time t" is a pure, React-free, unit-tested
  function; the component only renders.

**Repro:** `.tentacle/tmp/tui-tool-blink-wt/repro.tsx` in the WORKTREE (a
scratch dir at the main-repo root resolves `../../../packages/...` to the main
checkout, i.e. the unmodified code — a real trap, hit once here). Pattern of
`packages/tui/test/app.test.tsx`, React/Ink imported by relative path per AGENTS
§6): mount `App` with a session whose single turn runs one `shell` call for
2.4 s, sample the tool row every 250 ms. Captured with the three touched sources
at plain `HEAD` (`git show HEAD:…` written over them, `git diff packages/tui/src`
empty):

```
$ bun run .tentacle/tmp/tui-tool-blink-wt/repro.tsx
frames taken over 2517ms while the call was running:
  t≈0ms  "⏺ Bash cp a b"
  t≈250ms  "⏺ Bash cp a b"
  t≈500ms  "⏺ Bash cp a b"
  t≈750ms  "⏺ Bash cp a b"
  t≈1000ms  "⏺ Bash cp a b"
  t≈1250ms  "⏺ Bash cp a b"
  t≈1500ms  "⏺ Bash cp a b"
  t≈1750ms  "⏺ Bash cp a b"
  t≈2000ms  "⏺ Bash cp a b"
  t≈2250ms  "⏺ Bash cp a b"
distinct running rows: 1
after the call ended: "⏺ Bash cp a b 2.4s"
```

One distinct row over 2.5 s: no blink. The capability is missing.

For contrast, the SAME script on the implementation
(`.tentacle/tmp/tui-tool-blink-wt/repro.tsx`, unchanged):

```
  t≈0ms  "⏺ Bash cp a b"
  t≈250ms  "⏺ Bash cp a b"
  t≈500ms  "  Bash cp a b"
  t≈750ms  "  Bash cp a b"
  t≈1000ms  "⏺ Bash cp a b"
  ...
distinct running rows: 2
after the call ended: "⏺ Bash cp a b 2.4s"
```

**The repro script, pasted in full** (AGENTS §6: output only does not let
anyone re-run it; fix round 1, finding 7). Run it from the WORKTREE, in
`.tentacle/tmp/tui-tool-blink-wt/`, with `bun run repro.tsx`:

```tsx
// Repro (AGENTS §1/§6): capture App frames while a tool call runs, and show the
// bullet never changes. Style follows packages/tui/test/app.test.tsx, but the
// React/Ink modules are imported by relative path (AGENTS §6).
import { createElement as h } from "../../../packages/tui/node_modules/react/index.js";
import { render } from "../../../packages/tui/node_modules/ink-testing-library/build/index.js";
import { App } from "../../../packages/tui/src/App.tsx";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CTRL_C = "\u0003";

/** A session whose one turn runs a tool call for `holdMs`. */
function slowToolSession(holdMs: number) {
  return () => ({
    async *send() {
      yield {
        type: "tool_start" as const,
        id: "c1",
        name: "shell",
        arguments: JSON.stringify({ command: "cp a b" }),
      };
      await delay(holdMs);
      yield {
        type: "tool_result" as const,
        id: "c1",
        name: "shell",
        result: { content: "done", isError: false },
        durationMs: holdMs,
      };
      yield { type: "turn_end" as const, reason: "end_turn" as const };
    },
  });
}

const bulletRow = (frame: string): string =>
  frame.split("\n").find((l) => l.includes("Bash")) ?? "<no tool row>";

const app = render(h(App, { createSession: slowToolSession(2400), model: "m", cwd: "/w" }));
await delay(40);
app.stdin.write("go");
await delay(30);
app.stdin.write("\r");
await delay(120);
const t0 = Date.now();
const samples: string[] = [];
for (let i = 0; i < 10; i++) {
  samples.push(bulletRow(app.lastFrame() ?? ""));
  await delay(250);
}
console.log(`frames taken over ${Date.now() - t0}ms while the call was running:`);
for (const [i, s] of samples.entries()) {
  console.log(`  t≈${i * 250}ms  ${JSON.stringify(s)}`);
}
console.log("distinct running rows:", new Set(samples).size);
await delay(800);
console.log("after the call ended:", JSON.stringify(bulletRow(app.lastFrame() ?? "")));
app.stdin.write(CTRL_C);
app.unmount();
process.exit(0);
```

The round-1 "for contrast" frames above were taken with the round-1 OFF glyph
(`" "`, one column); with the fix the OFF row is `"  Bash cp a b"` (two spaces,
same 2 columns as `⏺`), which is exactly finding 1's correction.

## Implementation

*— deepseek-v4.1-flash, 2026-10-30*

### Load-bearing assumption

The render path can express "one row differs per tick" **without** invalidating
the per-item layout cache for every other item. It can: `itemRows`
(`render-lines.ts:668`) keys its `WeakMap` on the item's object identity plus
width/expand/threshold/preview, and `layoutTranscript` (`render-lines.ts:725`)
only does cache lookups plus offset arithmetic. So if the blink phase is part of
the *layout options* and the cache key, only a **running** tool item misses (its
`status` is the only thing that mentions the phase), while every settled item —
and every non-tool item — keeps its identity and its cache hit. Verified
empirically by the tests below (a `renderMarkdown` / `wrapLines` spy shows zero
re-wraps of the untouched items per tick).

### Preconditions

- `ToolItem.status` is the running marker (`state.ts:61`–`77`); `tool_start`
  appends a `status: "running"` item (`state.ts:269`), `tool_result` replaces it
  with `ok`/`error` (`state.ts:280`). A replayed history row is `ok` unless the
  turn is running (`state.ts:442`).
- The bullet is produced by `bullet(tool)` (`render-lines.ts:438`) and used
  only in the tool header (`render-lines.ts:500`): `header = ${bullet} ${label}…`.
  (Fix round 1: it takes NO phase — it always draws `⏺`, and the OFF glyph is
  swapped into the wrapped row afterwards, `withPhase`/`offPhaseRows`.)
- The transcript is committed as ONE `<Text>{visible.join("\n")}</Text>`
  (`App.tsx:2366`), so a per-tick re-render of the visible window is cheap; the
  expensive part is layout, which is cached (`render-lines.ts:657`–`736`).
- Tool rows are laid out in `itemLines` → `toolLines` **before** the blink
  decision, so the phase cannot be hidden from the cache: the cache key must
  carry it (see Design).
- Deterministic time: Bun's `jest.useFakeTimers()` replaces `Date.now` *and* the
  timer functions (`jest.advanceTimersByTime(600)` reads back as a 600 ms
  `Date.now` delta — verified in `.tentacle/tmp/tui-tool-blink/ft.test.ts`).
  The App frame test therefore takes fake timers **before** mounting: a timer
  armed under real timers is not reachable by `advanceTimersByTime` (verified —
  installing the fake clock after the key press did not tick the armed
  `setTimeout`). Each step flushes macrotasks with a real `setImmediate`, since
  Ink's own stdin plumbing is macrotask-based.
- Real timers work too: `.tentacle/tmp/tui-tool-blink-wt/dbg.tsx` shows the row
  alternating at wall-clock 300 ms steps with nothing faked, so the behaviour is
  not an artefact of the fake clock.

### Design

Pure module: `blink.ts` (new, React-free) — the whole decision "which glyph at
time t", one coordinate.

```ts
export const BLINK_HALF_MS = 500;
export const BULLET = "⏺";
/** ON for the first half of every one-second cycle. */
export function blinkOn(phase: number): boolean;
/** `⏺` for a finished call (ok or error) and for a running one while ON; `BLANK` (two spaces) while OFF. */
export function toolBullet(status: ToolStatus, phase: number): string;
```

The ONE coordinate is the app's **blink clock**, `BlinkClock {calls, tick}` from
`blink.ts`, held as one state in `App.tsx`. The rules live in the pure module
(AGENTS §7); the component only relays:

- `blink = blinkState(st.items, st.running)` — the call count and whether the
  clock may run at all.
- ONE `useEffect` arms a single `setInterval(500)` **only while** `blink.running`
  is true and applies `advanceBlink(clock, blink.calls)`; an idle transcript has
  no timer at all — not a disabled one, none (mutation F/G killed).
- A second `useEffect` applies `syncBlink(clock, blink)`: it returns the clock
  to `BLINK_IDLE` when nothing runs (so the next call starts at tick 0 and a
  finished row can never be left on the OFF half) and re-arms it at tick 0 when
  the call set changed.
- The phase is `blinkPhase(clock, blink)` — derived in RENDER, so the first frame
  of a new call already shows ON (the review's requirement).
- Because there is exactly one phase value, every running row is drawn with it
  in one layout pass: they blink **in sync**, and no row owns a timer.

"Starts ON" (owner decision) holds in BOTH cases now: the first call of an idle
transcript sees `tick 0`, and a call that *joins* a running cycle restarts the
shared clock ON (`blinkPhase` returns 0 while `clock.calls !== state.calls`, i.e.
in the very first frame that sees the new call). Round 1 let a joining call
inherit the current phase, which blanked a 200 ms call for its whole life
(review finding 3); the owner's decision 1 replaced that with the restart. Rows
already running lose their strict 500/500 rhythm at that moment — the accepted
trade-off, stated in Review.

`RenderOptions` gains `blinkPhase?: number` (default 0 = ON).

**Cache correctness (the load-bearing bit).** The glyph is NOT in the layout:
`toolLines` always opens with `⏺` (`bullet(tool)`, `render-lines.ts:438`), so the
wrapped rows depend only on the item and the width (plus collapse options for a
tool). The phase is applied AFTER the wrap, in `withPhase`
(`render-lines.ts:724`), which swaps the glyph for `BLANK` — the same 2 columns
— in row 0 only, memoised on the cached array (`offPhaseRows`, `:673`,
`offPhaseCache`, `:670`). Consequences,: (a) a phase tick re-wraps nothing, and
every item — settled, running, or not a tool — keeps its cache entry; (b) the
row grid cannot depend on the phase, which is what round 1 got wrong (its
phase-keyed cache still wrapped at a 1-column OFF glyph, so the row re-flowed at
1 Hz). This supersedes round 1's "the phase is part of the cache key" design;
the review's fix is exactly this shape.

### Files

1. `packages/tui/src/blink.ts` (new) — `BLINK_HALF_MS`, `BULLET`, `BLANK`,
   `blinkOn`, `toolBullet`, and the whole clock rule (`BlinkClock`,
   `blinkState`, `blinkPhase`, `advanceBlink`, `syncBlink`). Pure, no React.
2. `packages/tui/src/render-lines.ts` — `RenderOptions.blinkPhase`, `bullet(tool)`
   (always ON), `withPhase` / `offPhaseRows` (the equal-width swap after the wrap).
3. `packages/tui/src/App.tsx` — relays only: one `BlinkClock` state, one interval
   gated on `blinkState(...).running`, one `syncBlink` effect, `blinkPhase(...)`
   into the layout options.
4. `packages/tui/test/blink.test.ts` (new) — pure-module + clock-rule tests.
5. `packages/tui/test/app.test.tsx` — frame-level: blinks, one row, one clock,
   starts-ON, the 79-column proof, the dead call, the timer lifecycle.
6. `packages/tui/test/render-lines.test.ts` — the glyph/width and cache tests.

### Failure modes

- **The call ends exactly on a phase edge.** The clock's timer may fire after
  the item became `ok`; `toolBullet` returns `⏺` for any non-running status, so
  the finished row is the ok/error bullet whatever the phase. The effect also
  clears the timer when the last running call ends, and resets the phase to 0,
  so no stale OFF phase can leak onto a later call.
- **Several tools in parallel.** One clock, one phase value for all rows →
  they blink in sync (the same `opts.blinkPhase` in one layout pass). A NEW call
  restarts the shared clock ON (owner decision 1), so the row already running
  yields its 500/500 rhythm at that moment; a half-period is never shown twice or
  skipped (`advanceBlink` re-arms at tick 1).
- **Cancel / interrupt (Esc, Ctrl+C).** The real Agent answers a call it cancels
  (`agent.ts:1098–1110`), and the gate is now the TURN running
  (`blink.ts: blinkState`), so whatever the reducer leaves behind, the clock
  stops when the turn does and the row is drawn solid: a dead call can neither
  blink nor keep a timer (fix round 1, finding 2; mutation F2 red). The stale
  `running…` row after a *failed* turn is still there — closing it in the
  reducer is the separate `TODO.md` task, deliberately not done here. The only
  window left is the frame between the turn ending and the render that sees it.
- **Resume / reconnect with a call still running** (`historyItems`,
  `state.ts:442` marks historical calls `running` while the turn runs): those
  rows are ordinary running tools, so they blink with the clock from the moment
  the effect sees them; nothing else is needed. An archived/replayed settled
  call is `ok` → solid.
- **Nothing running.** The effect arms no timer at all (early return) — no
  wakeups, no renders, no battery cost when idle (the owner's explicit
  requirement). A finished-only transcript renders once and stays.
- **A stalled frame (event loop busy).** The phase is recomputed from the tick
  counter, never accumulated, so a stall shifts the phase by as many
  half-periods as the timers that were skipped, not "one at most" (round-1 doc
  claim, corrected in fix round 1). Every row still agrees on the one value, so
  the effect is a late (never an inconsistent) phase.
- **Scrolled-up reader.** The blink lives in the row string, so a running row
  already on screen blinks; a row scrolled out of the window costs nothing.

### Tests

Round-1 targets, with the fix round's corrections marked:

- `packages/tui/test/blink.test.ts` (pure, `blink.ts`): `blinkOn` edges
  (0/1/250/499/1000/1499/2000 ON; 500/750/999/1500/1999 OFF), negative / NaN /
  Infinity are ON; `toolBullet` blinks `running` on both phases; the OFF glyph's
  **`string-width`** equals `⏺`'s (2 — round 1 counted code points, finding 1);
  `ok`/`error` are `⏺` at **every** phase. Fix round 1 adds the clock rule:
  `blinkState` (the turn gate, finding 2), the call-count restart (finding 3),
  `syncBlink` (E), `advanceBlink`/`blinkPhase`.
- `packages/tui/test/render-lines.test.ts`: the running row changes glyph only
  (same row count, the label at the same DISPLAY COLUMN — `string-width` of the
  prefix, not a raw index), every other row identical; zero `renderMarkdown`
  calls and array identity for settled items on a tick; the width-79 case at
  22/44/45/79/80 (finding 1); a finished call solid at 0/500/1000.
- `packages/tui/test/app.test.tsx` (frame level, fake timers): (1) a 5 s call
  blinks through both phases and the label never moves column, ending
  `⏺ Bash cp a b 5.0s`; (2) two calls are always on the **same** glyph and go
  through both phases; (3) a 200 ms call is solid at every 50 ms sample;
  (4) **the 79-column proof** — same `{rows, bashRow, replyRow}` across 4 phases;
  (5) **a dead call** after a thrown stream is solid and the timer is gone;
  (6) **a call joining mid-OFF starts ON**; (7) **the timer lifecycle** — an
  idle App arms 0 timers and the count is back at 0 after the turn.
- Measurement (not a test), `.tentacle/tmp/tui-tool-blink-wt/measure.tsx`: a
  200-item transcript + one running call, spy on `renderMarkdown`, 3 s of real
  blinking. See Execution for the numbers (0 re-layouts vs 1200 under the
  mutation).

## Execution

*— deepseek-v4.1-flash, 2026-10-30*

As built, in the Implementation's order.

1. **Repro first.** `.tentacle/tmp/tui-tool-blink-wt/repro.tsx` against pristine
   `HEAD` sources: one distinct running row over 2.5 s (pasted in Context).
   Same script on the implementation: 2 distinct rows, alternating every
   500 ms, and `⏺ Bash cp a b 2.4s` once the call ends.
2. **`blink.ts` (new, 43 lines).** `BLINK_HALF_MS = 500`, `BULLET`, `blinkOn`,
   `toolBullet`. Pure, no React/Ink. `blinkOn` treats ≤0 / NaN / Infinity as ON
   so a bad phase can never blank a row.
3. **Tests written before the implementation** (AGENTS §9). Red, on the
   assertion of the property, not on a missing import:
   - `render-lines.test.ts`: `expected [ "off", "on" ]` / received `[ "on" ]`
     (the running row's bullet does not change); the cache test failed on
     `expect(header(first)).not.toBe(header(second))` — the non-vacuity guard.
   - `app.test.tsx`: same shape at frame level, `Received + 0` for `"off"`.
   - `blink.test.ts` had to be green from the start (it only exercises the new
     pure module, which the red tests above already showed unused) — stated
     plainly rather than dressed up as red.
4. **`render-lines.ts`.** `RenderOptions.blinkPhase`, `bullet(tool, opts)` →
   `toolBullet`, and the phase in `itemRows`' cache key **only** for a running
   tool item. ~~12 +/− lines~~ — **corrected in fix round 1, finding 6:** the
   review measured 24+/5− (`git diff --stat` on round 1); the "12" was the
   net line delta, not the diff, and reading it as the diff was wrong.
   *Superseded in fix round 1: the phase left the cache key entirely and the
   glyph is swapped after the wrap (`withPhase`), because wrapping with a
   1-column OFF glyph is what finding 1 caught.*
5. **`App.tsx`.** One `blinkTick` counter, one `setInterval(500)` armed only
   while `st.items` holds a running tool, one effect resetting the tick to 0
   when none is. The phase is `blinkTick * BLINK_HALF_MS` in the layout options.
   26 added lines, no other path touched. *Superseded in fix round 1: the counter
   became `BlinkClock` and every rule moved into `blink.ts` (R5).*

### Drift from the Implementation

- **Timer shape.** The plan said a re-armed `setTimeout`; the build uses one
  `setInterval` while running. Reason: the re-arming version needs `blinkTick`
  in its dependency list, which Biome correctly flags as a self-triggering
  effect (`useExhaustiveDependencies`) — the interval expresses the same thing
  without a lint suppression.
- **A single phase coordinate, not two.** The Implementation's first draft
  argued for call-age *plus* clock; that was cut to the clock alone (the call
  age would need per-row state, which the owner forbade). Consequence, stated
  in the Design and re-stated here: a call joining an already-blinking cycle
  inherits the current phase (up to 500 ms OFF). The "never an off flash"
  decision holds for a call that starts an idle transcript, which is the
  200 ms case the owner named; the test pins exactly that.
- **Determinism.** The tests take fake timers **before** mounting. Installing
  them after the key press was tried first and does not tick a timer armed
  under real timers — the tests would have been vacuously green. Each step
  flushes with a real `setImmediate` (Ink's stdin plumbing is macrotask-based).
- **Typed fake clock.** The pinned `bun-types` predates the `jest` timer
  typings, so `app.test.tsx` declares them in one `clock` facade
  (`jest as unknown as {...}`) instead of sprinkling casts.
- **Scratch-dir trap (worth recording).** A repro run from
  `<repo>/.tentacle/tmp/<slug>/` resolves `../../../packages/...` to the MAIN
  checkout (the parent of the worktree), i.e. the unmodified code. That briefly
  looked like "the implementation does not blink". The worktree-local scratch
  (`.tentacle/tmp/tui-tool-blink-wt/`, `../../../packages/...` from inside it)
  is what proved it does.

### Measurements

`.tentacle/tmp/tui-tool-blink-wt/measure.tsx` — a 200-item transcript + one
running call, `renderMarkdown` spied, 3 s of real wall-clock blinking:

```
markdown renders for ONE cold 200-item layout: 200
phases seen over 3 s: [ "on", "off" ] (12 samples)
markdown renders during those 3 s of blinking: 0
```

The first line is the spy's non-vacuity control. Under mutation C (below) the
same run reports **1200** — so "0" is a real measurement, not a broken spy.

### Mutations (each restored by `cp`; shasums identical after restore)

Backups and shasums: `.tentacle/tmp/tui-tool-blink-wt/shasums-final.txt`
(`blink.ts` 14d03af…, `render-lines.ts` b1ee853…, `App.tsx` f18d0d4…, all three
re-checked unchanged after every restore).

| # | Mutation | Result |
|---|---|---|
| A | `blinkOn` starts OFF (`>=` instead of `<`) | 5 red: 3 in `blink.test.ts`, 2 in `render-lines.test.ts` |
| B | a finished call blinks too (`toolBullet` for `ok`/`error` → `blinkOn(phase) ? ⏺ : " "`) | 1 red in `blink.test.ts` — **corrected:** 2 red (review, finding 6; the second is the `render-lines` cold-layout case) | 
| C | the phase is keyed into **every** item's cache (`const blink = opts.blinkPhase ?? 0`) | 1 red (`settled rows are not re-laid-out per tick`); measurement 1200 vs 0 re-layouts |
| D | a per-row clock (`itemRows` lays out the running row at `phase + (own id parity) * 500`) | 1 red (`a call joining mid-cycle blinks in step…`) |

Two of these needed the tests strengthened to be non-vacuous, which is the
point of running them:

- **B** first only tripped the unit test — the `render-lines` "solid at every
  phase" case reused the same item objects, so the cache legitimately served
  them across phases and the phase never reached the glyph. Fixed by giving
  each phase fresh identities (a cold layout proves the assertion, not the
  cache).
- **D** first produced *zero* failures. Two causes, both real: my first "two
  calls blink together" test started both calls at once (so a per-row clock and
  a shared one agree), and the first mutation only perturbed the *cache key*,
  never the glyph. Rewritten as "a call joining mid-cycle blinks in step" with
  the mutation applied to the value actually rendered.

### Gate

`bun run check` (typecheck → lint → test), final:

```
$ tsc --noEmit && tsc -p apps/mobile      # clean
$ biome check .                           # Checked 557 files. No fixes applied.
$ bun test                                # 3495 pass, 3 skip, 0 fail (260 files)
```

3495 + 3 skips = 3498; the 3 skips are the documented opt-in ones
(live-k8s, live-docker, real-socket keepalive). Lint baseline: 0 issues.

### Not verified

How it *looks* in a real terminal — the phase edges under a real event loop,
whether 1 s reads as "alive" rather than "flickery", and behaviour on a slow
terminal. The frame captures here are ink-testing-library snapshots (fake clock)
plus one real-clock run; a human glance at a 30 s tool call is the check.

## Review

*— claude-opus-5-5, 2026-10-30*

Reviewer: claude-opus-5-5, fresh context, a different model family from the
executor. Scratch: `.tentacle/tmp/tui-tool-blink-review/` (`attack.test.tsx`,
`reflow.test.tsx`, `width.test.ts`, gitignored).

**Verdict: REQUEST-CHANGES.** Do not merge. The happy path works and the cache
claim is real, but two owner decisions are broken on real paths: "no width
change" and "no timer when nothing runs". The clock is not pinned by any test.

### Findings

1. **HIGH: the OFF phase re-wraps the row, so the transcript jumps one row at
   1 Hz.** `render-lines.ts:439` puts the glyph in the row BEFORE `wrapLines`
   (`:697`). `string-width("⏺") === 2`, the OFF `" "` is 1, so the two phases
   wrap differently. Row count differs ON vs OFF at width 79 for `shell`,
   `fs_read`, `fs_edit`, `grep`, at width 80 for `fs_write`, and at 44/45/22 too.
   Frames at 79 columns with a long command:
   ```
   "bashRow=14 replyRow=10 runningRow=16 head=57"
   "bashRow=15 replyRow=11 runningRow=16 head=79"   (alternating every 500 ms)
   ```
   This breaks "same width: the row text never shifts" and "only the running
   rows change". `blink.test.ts:36` calls `[...glyph].length` "the same display
   width"; it counts code points, the §2 weak-correlate trap. The fix is the
   executor's, no owner input needed: wrap with the ON glyph, then swap the glyph
   in row 0 after the wrap. The grid stops depending on the phase and a tick no
   longer re-wraps at all. How a real terminal draws `⏺` was not measured.
2. **HIGH: a dead call blinks forever and the timer never stops.**
   `App.tsx:701` tests `status === "running"` only, and `failTurn`
   (`state.ts:170`), `turn_end` (`:394`) and `endWithoutOutcome` (`:230`) do not
   settle tool items. A stream that throws after `tool_start`, or ends with
   `turn_end{cancelled}` and no `tool_result`, leaves `live: 1` and frames
   `off ON off ON off ON` with the turn over and the prompt idle. This was
   driven with a scripted session; I did not exercise a real link loss through
   `RemoteSession`. The stale `running…` row predates this task; the perpetual
   timer, the App re-render and a dead call "looking alive" are new. The doc's
   Cancel failure mode ("ends its items ok/error (or the turn's `failTurn`
   path) → phase gate off, timer cleared", line 192) is false. The real Agent
   does answer a call it cancels (`agent.ts:1098–1110`), so a plain local Esc
   is fine.
3. **MEDIUM: "starts ON" fails for a call starting while the clock is OFF.**
   A 200 ms call joining at t = 600 ms is blank for its whole life:
   `"  Bash short two"` in all 4 samples (A1). The reachability is narrower than
   the design assumes: the agent loop is strictly sequential (`agent.ts:1051`;
   `docs/eval/parallel-tool-calls.md` is DEFER), and consecutive calls in a
   healthy turn do reset (A2 ON, A3 ON). It IS reachable today through finding 2:
   after a failed turn the next turn's first call starts `off` (B5), and it
   becomes the normal case if parallel calls land. See the owner decision.
4. **MEDIUM: the clock is not pinned.** Three owner-facing properties can be
   deleted with 137/137 green: the reset to 0 (E), "no timer when idle" (F),
   `clearInterval` (G). A timer leak would pass this suite.
5. **LOW: logic in the component (§7).** The running predicate and the reset
   rule live in `App.tsx:701–715`, which is why nothing tests them. The clock
   rule belongs in `blink.ts`.
6. **LOW: false or stale statements.** Execution line 263 says "12 +/− lines";
   `render-lines.ts` is 24+/5−. The table says B is "1 red"; it is 2 now. The
   comment at `render-lines.test.ts` "key `blinkPhase` … for every item → this
   test fails" is false: under C that test stays green, only the next one fails.
   The first App test's comment describes two running rows and "in sync", but it
   has one row. The doc's "a skipped tick shifts the phase by one half-period at
   most" does not hold for a longer stall (harmless, one value for all rows).
7. **LOW: process.** The repro script is not pasted in the doc (§6: output only)
   and `TODO.md` has no entry for the task (§10).

### Owner decision: "sync" and "starts ON"

Both can hold; what yields is the strict 500/500 rhythm of a row already
running. **Recommended rule: the shared clock restarts ON whenever a new call
starts.** One timer, one phase value, all rows in sync; an older row may show a
shortened OFF or a longer ON at that moment, which nobody can read as a stall.
Prototyped as a temporary mutation (restart keyed on the tool count): A1 went
all ON and `app.test.tsx` stayed 78/78, the sync test included. The final code
should derive the phase in render rather than reset in an effect, or the first
frame of the new call can still show the stale phase.

Second, for finding 2: gating on `st.running` stops the timer and leaves a solid
stale row, which still blinks during a LATER turn. Settling running tools at the
turn's end in the reducer cures that and the old stale `running…`, but changes
what a failed turn shows. **Recommended: gate on `st.running` here and file the
reducer change in `TODO.md`.**

### Gate and mutations

`bun run check`: typecheck clean, Biome 557 files 0 issues, **3495 pass / 3 skip
/ 0 fail** (3498 tests, 260 files), matching Execution. Same counts when re-run
on the restored tree after all mutations, with every `shasum` identical.

Each run is the 3 test files (137 tests), restored by `cp`, `shasum -c` OK.

| # | Mutation | Result |
|---|---|---|
| A | `blinkOn` inverted | 5 red (3 + 2), as claimed |
| B | finished call blinks | 2 red (doc: 1) |
| C | phase keyed for every item | 1 red, as claimed; measurement 1200 vs 0 reproduced |
| D | per-row clock | 1 red, as claimed |
| E (mine) | no reset to 0 when idle | **survived** |
| F (mine) | interval armed always | **survived** |
| G (mine) | interval never cleared | **survived** |
| H (mine) | `useState(1)` seed | survived: equivalent, the reset effect zeroes it at mount |
| H2 (mine) | phase `(tick + 1) * 500` | 1 red, the 200 ms test: that test is not vacuous |

### Premise table

| Premise | Result |
|---|---|
| Repro on `HEAD` sources: 1 distinct row | TRUE, re-run |
| `state.ts:61`, `:269`, `:280`, `:442`; `render-lines.ts:496`; `App.tsx:2357` | TRUE |
| Only a running tool's cache key takes the phase | TRUE |
| "OFF has the same width" (Context, Design) | **FALSE**, finding 1 |
| A cancelled/failed turn ends its items (Failure modes) | **FALSE**, finding 2 |
| Executor's sha256 prefixes | TRUE (`shasum -a 256`) |

### Attacks tried

- Timer count (App's interval only): idle 0, running 1, two running 1, ended 0,
  unmount mid-call 0, `/clear` on a stale row 0. Holds, except finding 2.
- Repaint: 0 `renderMarkdown` vs 1200 under C, reproduced. A 20 000-item
  transcript costs 0.6 ms per tick against 111 ms cold. The streaming throttle
  and the idle warm are untouched (`blinkTick` is in neither's deps). The resize
  warm uses options without the phase: at most one extra miss on a running row.
- Phase edge: an error result at exactly 500 ms is `⏺ Bash cp a b 0.5s`. Holds.
- No start time (resync): the unanswered call blinks, then settles solid. Holds.
- Colour after the end (read, not run): `bullet` branches on status as before,
  `toolBullet` is `⏺` for any non-running status. Holds.
- Copy while OFF (read `selection.ts` and `App.tsx:2177`, not run): the copy
  takes the current phase's rows, so a selection over the bullet copies a space.
  Harmless, except at the reflow widths of finding 1.

### What holds

The pure glyph function, the cache key and the shared phase value, the timer on
the ordinary paths, and the honest "Not verified" note.

### How the executing model behaved

**Grade C.** The good: real shasums, a measurement that reproduces, mutations
reported truthfully, and the join trade-off stated openly instead of hidden. It
strengthened tests B and D when they proved nothing. The bad: it again left
owner-stated behaviour unpinned, the same fault as its first task: nothing
tests the timer lifecycle although the owner asked for it explicitly. It proved
width with a weaker property and asserted the cancel path without running it, so
two HIGH defects shipped under a green gate.

**Owner decisions on Review (2026-10-30):** (1) the shared clock restarts ON whenever a new tool call starts (sync + starts-ON both hold; rows already running yield their 500/500 rhythm at that moment); (2) blinking is gated on the turn running (`st.running`) now; closing the dead running calls in the reducer after a failed turn is a separate task in `TODO.md`; (3) the fix round is done by DeepSeek again.

## Execution — fix round 1

*— deepseek-v4.1-flash, 2026-10-30*

Review-round work list: findings 1–7. Every finding fixed except where the doc
says "argued" (with evidence). Tests written first and shown failing; scratch in
`.tentacle/tmp/tui-tool-blink/fix1/` (`run.sh`, `shasums-agent.txt`).

### R1. HIGH — width: the OFF phase re-wrapped the row (finding 1)

**Root cause (measured, not reasoned).** `string-width("⏺") === 2`,
`string-width(" ") === 1`. The round-1 code put the phase glyph into the row
*before* `wrapLines`, so the row measured 1 column narrower in the OFF half.
Scratch scan of every width 20–100 with a long `shell` command: **81 of 81
widths** had ON ≠ OFF row content (row count or the wrap point); the review's
79 is one of them. That is the transcript jumping a row at 1 Hz.

**Fix.** The wrap no longer depends on the phase: `toolLines` always opens with
`⏺` (`render-lines.ts` `bullet(tool)` — the phase parameter is gone), the
wrapped rows are cached (`itemRows`), and `withPhase` / `offPhaseRows` swap
**one** glyph in row 0 for `BLANK` — now two spaces (`blink.ts`), the same 2
columns as `⏺`. There is no `blink` field in the row-cache key any more
(`RowCacheEntry`): the phase cannot invalidate a layout, so a tick re-wraps
*nothing* (the cache test asserts zero `renderMarkdown` calls and array
identity). The OFF twin array is itself memoised on the ON array
(`offPhaseCache`), so a tick allocates nothing after its first visit.

**Proof, at the width the review named.** `render-lines.test.ts` "at width 79 a
long command's rows do not move between phases": `string-width` equality of both
phases against `⏺`, and, for widths 22/44/45/79/80, the same row count and
`off.map(strip) === on.map(i === 0 ? swap : strip)` — only row 0's glyph differs.
Frame level: `app.test.tsx` "at 79 columns no row moves between phases" mounts
the App, resizes the fake stdout to 79, runs a wrapping command, samples 4 phases
and asserts `{rows, bashRow, replyRow}` is ONE value across them, with both
phases seen (non-vacuity).

**Red evidence (the round-1 code, replayed).** Rewriting `render-lines.ts` to
round-1's shape (glyph into the wrapped line, OFF = `" "`):
`Expected - 1 / (fail) … at 79 columns no row moves between phases`. Restored by
`cp`, shasum identical. The same mutation also reds 3 unit tests
("the OFF glyph measures exactly the same width as the ON glyph" etc.).

The old weak correlate is gone: `blink.test.ts` "the OFF glyph measures exactly
the same width as the ON glyph" uses `string-width` (and pins the premise
`stringWidth("⏺") === 2`), not `[...glyph].length`.

### R2. HIGH — a dead call blinked forever (finding 2)

**Fix.** The gate is the pure `blinkState(items, turnRunning)` (`blink.ts`):
`running = turnRunning && some item is a running tool`. `st.running` is the
owner's decision 2; it is what stops a call the reducer left `running` behind
(`failTurn`, `state.ts:170`; `turn_end`, `:394`; `endWithoutOutcome`, `:230` —
the reducer fix is a separate task, untouched here).

**Tests (both red on a status-only gate).**
- `blink.test.ts` "runs only while the TURN runs and a call is unanswered":
  `blinkState([running("a")], false).running === false`.
- `app.test.tsx` "a dead call left by a failed turn does not blink, and no timer
  is left": the stream throws after `tool_start`; the stale row stays (that is
  the separate reducer task) but is **solid** for 4 half-periods and
  `getTimerCount()` falls back to the idle baseline.

Mutation F2 (drop `turnRunning &&`): 2 red — the unit test and the frame test.
Restored, shasum identical.

### R3. MEDIUM — "starts ON" failed for a call joining an OFF clock (finding 3)

Owner decision 1 fixes this: the shared clock **restarts ON when a new tool call
starts**. Implemented as `BlinkClock {calls, tick}`: `blinkPhase` returns 0
whenever `clock.calls !== state.calls` — i.e. the very first frame that sees a
new call renders ON, with no effect needed (the review asked for exactly that:
derive in render, not reset in an effect). The next half-period of the new cycle
is OFF (`advanceBlink` re-arms at tick 1), so no half-period is shown twice or
skipped; rows already running yield their 500/500 rhythm at that moment, which
is the trade-off the owner accepted.

**Tests.** `blink.test.ts` "a new call starts ON in the frame that sees it, even
mid-OFF" and "a call joining mid-cycle restarts the shared clock ON";
`app.test.tsx` "a call joining an OFF-phase cycle starts ON" — a 200 ms call
joins at 550 ms (mid-OFF), both rows ON in all 4 samples of its life.
Mutation F3 (drop the call-count key): 3 red. Restored, shasum identical.

### R4. MEDIUM — the clock was not pinned (E/F/G)

The review's three survivors, now **killed** (same mutations, `cp` backup,
`shasum -a 256` identical after restore — see the mutation table for the pasted
output):

| # | Mutation | Before | Now |
|---|---|---|---|
| E | `syncBlink`'s "not running → idle" branch removed | survived | **1 red**: `blink.test.ts` "a stopped clock goes back to IDLE (E)" |
| F | `if (!blinkRuns) return;` removed (interval always armed) | survived | **1 red**: `app.test.tsx` "the interval exists only while a call runs, and is cleared (F, G)" |
| G | `clearInterval` replaced by a no-op cleanup | survived | **1 red**: same test (`getTimerCount()` is back at the idle baseline 0) |

G needed a *measured* baseline: an idle App arms 0 timers, a running call 4
(Ink spinner + loading bar + the blink interval + one more), and after the turn
+1000 ms it is 0 again. `afterTurn).toBeLessThan(running)` was **not** enough
(the spinner and loading bar die on their own, so the count drops anyway) — that
is why the assertion is the absolute 0, measured, with an idle App mounted in the
same fake clock as the control.

### R5. LOW — decision logic in the component (finding 5, AGENTS §7)

`App.tsx` now only relays: `blink = blinkState(st.items, st.running)`, one
`setInterval` whose gate is `blink.running`, `setBlinkClock((c) =>
advanceBlink(c, blink.calls))`, one sync effect `setBlinkClock((c) => syncBlink(c,
…))`, and `blinkPhase(blinkClock, blink)` into the layout options. Every rule —
when it runs, when it restarts ON, what a tick renders, that it returns to idle —
is a pure exported function in `blink.ts` with its own tests (`syncBlink`,
`advanceBlink`, `blinkPhase`, `blinkState`, `blinkOn`, `toolBullet`). The
component contains no branch on phases or timers any more.

### R6. LOW — false or stale statements (finding 6), corrected

- "Execution says 12 +/− lines" for `render-lines.ts`: wrong, the review
  measured 24+/5−. The round-1 figure stands corrected; the fix round's diff is
  stated from `git diff --stat`, not by hand.
- "B is 1 red": it is 2 in round 1 (`toolBullet` unit test + the `render-lines`
  cold-layout test); this round it is 1 (the unit test), because the
  fresh-identity fix left only the shortest one — stated as it is, re-measured,
  not as claimed.
- The comment on the first `render-lines` blink test claiming the cache-key
  mutation fails *that* test: false. It now says what is true (an OFF glyph
  narrower than `⏺`, or no phase swap at all), and the cache property is pinned
  by the *next* test, as the review found.
- The first App test's comment described "two running rows, in sync": it has
  one row. It now says one row, and the sync property is the second test.
- "a skipped tick shifts the phase by one half-period at most": false for a
  longer stall. Corrected in the Implementation's failure modes below.

### R7. LOW — process (finding 7)

- The repro script is **pasted in full** in Context (AGENTS §6: output only is
  not enough for a reader to re-run it) — see the new "Repro" block there.
- `TODO.md` gets the task entry and the reducer follow-up (§10).

### Measurements after the fix

- **Width scan, before:** every width 20–100 with long `shell` commands had
  ON ≠ OFF row content (81/81 widths, by row count or wrap point — 79 included).
- **Width scan, after:** the same scan reports **0** differing widths; only the
  glyph differs. `string-width("  ") === 2 === string-width("⏺")`, measured
  with the width function Ink's layout uses.
- **Re-wrap on a tick:** the cache test's `renderMarkdown` spy sees 0 calls, and
  the phase is no longer in the cache key at all — a tick re-wraps **nothing**
  (it swaps one glyph in an already-cached array, memoised in `offPhaseCache`).
- **Timer count (fake clock):** idle App 0; a running call 4 (Ink spinner +
  loading bar + the blink interval + one more); after the turn +1000 ms 0.

### Mutations in fix round 1 (each `cp`-backed; `shasum -a 256` identical after)

Final shasums, re-checked after every restore:

```
3859e953379f243483a23df2b4ecc0745a3da3dfe79bf8a77c78f107bd7c5d38  packages/tui/src/blink.ts
6ccb912d7fef51da600e6287493ab770bdd2a5ff5de2433523759164a6fa604a  packages/tui/src/render-lines.ts
a43514baf4b389935ba70a997042752feb6df94c91da06c6c2422138bbf9a973  packages/tui/src/App.tsx
```

Each run is the 3 blink files (151 tests). Every row below is pasted output.

| # | Mutation | Result |
|---|---|---|
| **E** | `syncBlink`'s "not running → idle" branch removed | **1 red**: `a stopped clock goes back to IDLE … (E)` — 150 pass / 1 fail |
| **F** | `if (!blinkRuns) return;` removed (interval always armed) | **1 red**: `the interval exists only while a call runs, and is cleared (F, G)` — 150 pass / 1 fail |
| **G** | `clearInterval` → a no-op cleanup | **1 red**: same test (`getTimerCount()` back at 0) — 150 pass / 1 fail |
| F2 | `blinkState` loses `turnRunning &&` (finding 2 back) | **2 red**: the `blinkState` unit test + the dead-call frame test |
| F3 | `blinkPhase` loses the call-count key (finding 3 back) | **3 red**: 2 unit + the joining-call frame test |
| W1 | the round-1 1-column OFF glyph `" "` | **3 red**: `toolBullet` blinks, the `string-width` equality, widths-79 rows (the first `render-lines` test stays green — it pins the swap, not the glyph) |
| W2 | round-1's shape replayed (glyph wrapped, OFF 1 column) | **1 red**: `at 79 columns no row moves between phases` |
| NS | no phase swap at all (`withPhase` returns `rows`) | **8 red** (the comment on the first `render-lines` test is true) |
| A | `blinkOn` inverted | **7 red** |
| B | a finished call blinks too | **1 red** (the `toolBullet` unit test; re-measured) |
| C | the phase reaches every item (settled ones included) | **3 red** |
| D | a per-call phase offset (a per-row clock) | **8 red** |
| H2 | phase `(tick + 1) * 500` | **8 red** |

**What was corrected in the round-1 record** (finding 6, and my own re-checks):

- `render-lines.ts` “12 +/− lines” → the diff was 24+/5− in round 1; the fix
  round's own diff is **56+/4−** (`git diff --numstat`), `App.tsx` **35+/0−**,
  `blink.ts` 134 new lines, tests **441+/136+**.
- “B is 1 red” → 2 in round 1, **1 now**, re-measured rather than repeated.
- The first `render-lines` test's comment (cache-key mutation fails *it*): false
  → rewritten to the property that actually reds it, verified: dropping the phase
  swap reds it (NS), while a narrower OFF glyph does not (W1) — the width claim
  belongs to the width-79 test.
- “Two running rows, in sync” on a one-row test → comment corrected.
- “a skipped tick shifts the phase by one half-period at most” → false for a
  longer stall; corrected in the Failure modes.
- The Cancel/`failTurn` failure mode ("ends its items ok/error") → **false**, and
  now states what is true: the gate is the turn, the stale row is the separate
  reducer task.
- The repro script is now **pasted in full** in Context (finding 7).
- `TODO.md` gained the task entry and the reducer follow-up (finding 7).

### Gate (fix round 1)

```
$ bun run typecheck      # tsc --noEmit && tsc -p apps/mobile — clean
$ bun run lint           # biome check . — Checked 557 files. No fixes applied.
$ bun test               # 3509 pass, 3 skip, 0 fail (260 files, 12804 expects)
```

Round-1 baseline was 3495 pass / 3 skip / 0 fail: **+14** tests this round,
measured per file — `blink.test.ts` 6 → **15**, `render-lines.test.ts` 53 →
**54**, `app.test.tsx` 78 → **82** (the width proof, the dead call, the mid-OFF
join, the timer lifecycle). The 3 skips are the documented opt-ins. Lint
baseline stays 0 issues.

### Not verified (fix round 1)

- How a real terminal draws `⏺` (2 columns is Ink's model, and `string-width`
  agrees; a terminal with a different width table would still keep the row
  stable, because both phases are the same two columns).
- A real link loss through `RemoteSession` (`endWithoutOutcome`): the dead-call
  test drives the same reducer path with a stream that throws. The other two
  paths (`turn_end{cancelled}`, `endWithoutOutcome`) share `blinkState`, which
  is unit-tested for `running: false` on its own.

## Review — fix round 1

*— claude-opus-5-5, 2026-10-30*

Reviewer: claude-opus-5-5, fresh context, a different model family from the
executor (DeepSeek). Same reviewer model as round 1, new context. Scratch:
`.tentacle/tmp/tui-tool-blink/rev/` (`timer.test.ts`, `scan.test.ts`,
`width.test.ts`, `mut.sh`, `run1.sh`; gitignored).

**Verdict: APPROVE-WITH-NITS → MERGE** (after `feat/tui-tool-expand` is fixed,
since the two are stacked in one tree). Every round-1 finding is fixed and
pinned. The nits are about `TODO.md`, not code.

### Round-1 findings, re-checked

| # | Finding | Result |
|---|---|---|
| 1 | OFF phase re-wrapped the row | **FIXED.** The glyph is swapped after the wrap (`render-lines.ts` `offPhaseRows`/`withPhase`, called from `itemRows`), `BLANK = "  "` is 2 columns by `string-width`. My scan over widths 20–100, two long commands, `expandAll` on and off: **0 widths differ** on the blink-only tree (`5b9f2dd`, 232 cases with more than 2 rows, so the scan has teeth) and on the stacked tree. Rows 1… are byte-identical, and row 0 differs only by `⏺`→`  `. The 79-column frame test passes on `5b9f2dd` (run with that snapshot's sources and tests swapped in, then restored from `d719fe6`, `git diff d719fe6` clean). Colour after the end: `withPhase` returns the cached array for any non-running tool, so ok/error bullets are untouched (`ok`/`error` rows were identical at every phase in my width test). Copy: a selection over the OFF bullet copies two spaces instead of `⏺`. That is harmless, and the width is the same. |
| 2 | Dead call blinked forever | **FIXED.** `blinkState` (`blink.ts:62`) gates on `turnRunning`. Three scripted dead-call paths under fake timers (`turn_end{cancelled}` with no result, a stream that throws, `turn_end{end_turn}` with no result): the row blinks while the turn runs, then `getTimerCount()` is `[0,0,0,0]` over 4 half-periods and the row is solid `⏺`. |
| 3 | "Starts ON" failed for a joining call | **FIXED** per owner decision 1. Four sequential calls (1300/200/760/200 ms) sampled every 50 ms: each new call is ON in its first frame, and both 200 ms calls are never blank. `c1` keeps a clean 500/500 rhythm, and `c3` goes OFF at +500 ms of its own start. |
| 4 | Clock not pinned (E/F/G) | **FIXED.** Re-run, `cp`-restored, `shasum -a 256 -c` 5/5 OK each time: **E 1 red, F 1 red, G 1 red**, as claimed. Mine: **`BLANK = "   "`** (3 columns) → 5 red. See nit 2. |
| 5 | Logic in `App.tsx` | **FIXED.** The App only relays `blinkState`/`blinkPhase`/`advanceBlink`/`syncBlink`. It has no branch on phases. |
| 6–7 | Stale statements, process | Fixed. The repro is pasted, the `TODO.md` entry exists. |

The existing tests were not weakened: the fix round removes no assertion (the
only `-` line in its test diff is an import line it extended). `blink.ts`
sha256 `3859e953…` matches the Execution's.

### Nits

1. **LOW, `TODO.md:1492`: a duplicate on merge.** `main` (commit `1d4401a`)
   already has the reducer follow-up ("TUI: close a turn's still-running tool
   calls when the turn fails"). The branch adds a second copy ("Settle a dead
   tool call in the reducer") in a new `## TUI polish` section.
   `git merge-tree main d719fe6` merges **cleanly**, because the hunks are far
   apart, so git will not flag the duplicate. Drop the branch's copy at merge.
   Also: the entry is `[x] DONE` before the merge, and the index line has no
   `Suited:` (§10).
2. **LOW: on the stacked tree, the 79-column frame test no longer guards the
   re-wrap.** Expand cuts the collapsed header to one row, and the
   test's command header is 78 columns. With `BLANK = "   "` the frame test
   stays green. The unit test (`string-width` equality) and the
   "label never moves column" frame test catch it, so the property is still
   pinned. The frame test itself is now a weaker guard.

### Gate

`bun run check` on the stacked tree (`d719fe6` + docs): typecheck clean, Biome
561 files 0 issues, **3554 pass / 3 skip / 0 fail** (3557 tests, 262 files).
The blink-only figure 3509 was not re-run on its own. 3509 + 45 new expand tests
= 3554 is consistent with it. On `5b9f2dd` the 3 blink files are 151/151.

### Attacks tried

- Dead-call paths ×3, timer count: hold (above).
- Width scan 20–100 and 20–160, with CJK, emoji, ZWJ, flags, combining marks,
  tabs and multi-line commands, running and ok, in collapsed, clicked and
  Ctrl+O views: no row is wider than the width, and ON/OFF row counts are
  equal. Holds.
- Sequential short calls and a mid-cycle join: hold.
- Wide-OFF mutation: caught by 5 tests (nit 2 is about which ones).

### How the executing model behaved

**Grade B.** Every claim I re-ran matched: the shasums, E/F/G each 1 red, the
151-test count and the 0/81 scan. Each fix is the smallest one that cures the
root cause, and it fixed its own misstatements openly. Short of A: the
`TODO.md` follow-up duplicates one already on `main`, and the task is marked
`[x] DONE` before its review.
