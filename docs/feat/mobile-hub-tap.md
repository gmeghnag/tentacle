# feat/mobile-hub-tap — A tap on the hub opens the fan; an empty Activity stays dimmed

> **Status:** implementation (awaiting owner approval)
> **Branch:** `feat/mobile-hub-tap`
> **Size:** S · **Blast:** contained · **Suited:** DeepSeek exec + standard review
> **Changelog:** `changelog.d/mobile-hub-tap.changed.md` — `- **A tap on the floating button opens the hub.** On the iPhone, with the Floating Activity button, a single tap now opens the fan of actions (with a haptic) instead of the full-screen Activity sheet; Activity is one of the fan's items, and it stays dimmed and says "Nothing running" when there is nothing to show.`

## Context

*— claude-opus-5-5, 2026-11-17*

Owner request (TODO.md, 2026-11-17): a SINGLE TAP on the floating hub button
opens the hub fan with a haptic. Today a tap opens the full-screen Activity
sheet, even when there is nothing in it. Activity becomes one item of the fan.
LONG-PRESS is reserved for the hands-free voice conversation; until that exists
on mobile, a long-press does what a tap does. Empty entries follow the owner
standard: they stay **dimmed**, a tap gives a **light** haptic and an inline
"Nothing running", and an empty modal never opens.

This depends on `feat/mobile-hub-opacity` (merged, `ec42f0e9`), because both
touch `ui/FloatingActivity.tsx`. `feat/mobile-hub-badges` touches the same file
and the same fan items, so it goes after this one (see Owner question 5).

**Repro** (2026-11-17, branch `feat/mobile-hub-tap` = `main` @ `d96355bd`),
`.tentacle/tmp/mobile-hub-tap/repro.ts`:

```ts
import { hubActions } from "../../worktrees/mobile-hub-tap/apps/mobile/src/hub-actions.ts";
import { IDLE, reduce } from "../../worktrees/mobile-hub-tap/apps/mobile/src/hub-gesture.ts";

const solve = () => {
  throw new Error("solve called");
};
const s1 = reduce(IDLE, { type: "down", p: { x: 0, y: 0 }, t: 0 }, solve);
const s2 = reduce(s1.state, { type: "up", p: { x: 1, y: 1 }, t: 120 }, solve);
console.log("tap →", JSON.stringify(s2));
const ctx = {
  link: "up", turn: null, ended: null, editable: true, dictation: false,
  schedules: 0, nextWakeInMs: null, unseenArtifacts: 0,
} as const;
console.log(
  "activity item (idle, nothing running) →",
  JSON.stringify(hubActions(ctx, { activity: () => {} }).fan),
);
```

```
tap → {"state":{"kind":"idle"},"effects":[{"kind":"tap"}]}
activity item (idle, nothing running) → [{"id":"activity","label":"Activity","badge":null,"danger":false}]
```

So: (1) a tap never builds a fan (`solve` is not called), it emits `tap`, which
the button maps to `onPress` = `openActivity` (the full sheet); (2) the Activity
item already exists in the fan (H3), but it has no "empty" state, so committing
it on an idle session opens an empty sheet.

## Implementation

*— claude-opus-5-5, 2026-11-17*

### Load-bearing assumption

**The gesture machine already has a "fan opened by a release" path, and a tap
can reuse it.** `pressing` → `up` with `kind === "long"` calls
`open(event.p, solve, "sticky")` (`apps/mobile/src/hub-gesture.ts:189-190`).
`open` plays `firm` and emits `open(layout)`. With no actions it opens nothing
(`:135-137`). A layout that is not a fan becomes the ActionSheet (`:142-144`).
The `fanSticky` state then handles tap-to-commit, tap-elsewhere-to-close and a
new touch on the button that closes it (`:248-260`). So "tap → fan" is a
one-branch change in a pure reducer: `kind === "tap"` → `open(event.p, solve, "sticky")`.
Everything after that (commit, close, opacity, back-swipe guard) already runs
off the state that comes out.

### Preconditions

- The button does nothing on its own. It applies the machine's effects
  (`apps/mobile/src/ui/FloatingActivity.tsx:251-300`). `tap` is the only effect
  that calls `onPress` (`:277-279`). The `open` effect builds the fan from
  `fanItems` by id (`:255-262`).
- The body goes solid when `gesture !== "idle" || fanOpen`
  (`apps/mobile/src/hub-opacity.ts:68`). `setEngaged(driver.state().kind)` runs
  after every effect batch (`FloatingActivity.tsx:300`), so a tap that ends in
  `fanSticky` is engaged, and closing it goes back to the set opacity. This
  needs no change.
- The back-swipe guard follows `isFanOpen`, which includes `fanSticky`
  (`apps/mobile/src/hub-session.ts:246-248`), through `onFanChange`
  (`SessionScreen.tsx:796-804`). This also needs no change.
- Haptics: the machine names a cue and `hubHaptic` plays it as is
  (`apps/mobile/src/haptic-rules.ts:50-52`). `"light"` is already a `HapticKind`
  (`:13`). It is not a `HubCue` yet (`hub-gesture.ts:43`).
- A commit goes through `commitPlan` → `resolveCommit`
  (`hub-session.ts:180-191`, `hub-actions.ts:202-219`). A `noop` with a notice
  is shown in the inline `hub-notice` line (`SessionScreen.tsx:805-815`,
  `:1214-1221`). This is the existing "Already finished" channel, so "Nothing
  running" reuses it.
- Activity is "empty" when `activityView(...).groups` is empty. That is when the
  sheet draws its own dimmed `empty` line (`apps/mobile/src/activity.ts:60-72`).
  The screen already computes `activityVm` (`SessionScreen.tsx:571`).
- The ONE Activity path, `openActivity` (`SessionScreen.tsx:730-733`), stays the
  path for the header pill (`:871-880`). That pill is drawn only while
  something runs or a report is unread, so it never opens an empty sheet.
- No §7 invariant is touched. This is mobile-only, pure modules plus
  rendering, with no protocol, persistence or terminal I/O.

### Design

1. **Tap → fan (pure, `hub-gesture.ts`).** In `pressing`/`up`, `tap` and `long`
   both return `open(event.p, solve, "sticky")`. The timer path (held 400 ms
   while the finger is still down) still opens `fanTracking`, so slide-to-select
   still works after a long-press (Owner question 1). This is the "long-press =
   tap until voice exists" rule: both end with the same fan, and a long-press
   also lets you slide. The `tap` effect kind is removed (nothing emits it any
   more). `classifyPress` stays, because it still separates drag from press.
   The table in the module doc is updated (tap → fan sticky, firm).
2. **Dimmed items (pure, `hub-actions.ts`).** `HubContext` gains
   `activityEmpty: boolean`. `HubItem` gains `dimmed: boolean`, and only
   `activity` is dimmed, when `activityEmpty` (Owner question 3). A dimmed item
   **keeps its slot**. It is not hidden, so the order stays the one in owner
   decision Q-H5. `resolveCommit("activity")` when it is empty →
   `{ kind: "noop", notice: NOTHING_RUNNING }` with
   `NOTHING_RUNNING = "Nothing running"`. The check reads the world at the
   release, like every other re-check (M7/M8), so an Activity that fills up
   while the fan is open opens for real.
3. **The haptic of a dimmed commit (pure, `hub-gesture.ts`).** `HubMenu` gains
   `dimmed: readonly string[]` (the snapshot taken at the open, next to `ids`).
   `commit()` plays `light` instead of `commit` for a dimmed id, and still
   emits `commit` + `close`. That way the screen's `resolveCommit` produces the
   notice, and there is exactly one haptic per release, never two. `HubCue`
   gains `"light"`. `hubHaptic` stays a straight pass-through. `solveHub`
   (`hub-session.ts`) fills `dimmed` from `items`.
   *Edge:* the snapshot says dimmed but the release says full: you get the light
   haptic and the sheet opens. That is a harmless mismatch in a rare race, and it
   is pinned by a test, not designed away (the haptic has already played at
   the release).
4. **Screen wiring (`SessionScreen.tsx`).** `hubContextOf` takes
   `activityEmpty: activityVm.groups.length === 0`. Nothing else changes:
   `onPress` stays a prop for the VoiceOver activate path (Owner question 2).
5. **Rendering (`ui/HubFan.tsx`).** A `dimmed` item is drawn at a fixed low
   opacity. This is presentation only, and the final values will come from
   mobile-hub-badges' solid discs. Its a11y label gets ", nothing running".
6. **VoiceOver.** The fan never opens under VoiceOver (Design 7 of
   mobile-hub). The `activate` route and its hint "Double-tap for Activity" are
   **unchanged in this task unless Owner question 2 says otherwise**.

### Files

In dependency order:

1. `apps/mobile/src/hub-actions.ts`: `activityEmpty`, `dimmed`,
   `NOTHING_RUNNING`, the `resolveCommit` branch.
2. `apps/mobile/src/hub-gesture.ts`: tap → `open(..., "sticky")`, drop the
   `tap` effect, `HubMenu.dimmed`, `light` cue in `commit()`, doc table.
3. `apps/mobile/src/hub-session.ts`: `hubContextOf` input + `solveHub` fills
   `dimmed`. If Owner question 2 = B, `hubA11yRoute("activate")` → `menu`.
4. `apps/mobile/src/ui/FloatingActivity.tsx`: remove the `case "tap"` branch,
   update the header comment (`:2-6`).
5. `apps/mobile/src/ui/HubFan.tsx`: dimmed opacity + a11y suffix.
6. `apps/mobile/src/screens/SessionScreen.tsx`: pass `activityEmpty`.
7. `changelog.d/mobile-hub-tap.changed.md`.
8. Tests (below). `docs/feat/mobile-hub.md` gets no edit (it is a legacy
   record). This doc supersedes its "Tap still opens Activity".

### Failure modes

- **A tap with no actions** (`ids` empty) → `open` returns idle, with no
  haptic (`hub-gesture.ts:135-137`). The button does nothing, as a long-press
  does today. There are no dead taps in practice, because `info` is always
  present.
- **A tap where the fan doesn't fit** → `open(menu)` + firm → the ActionSheet
  with all actions (existing `onMenu` path).
- **A double tap** → the first tap opens the fan (sticky). The second touch on
  the button is `down` in `fanSticky` → `close` (`:255-257`), and its release
  meets idle. This is the existing, tested behaviour; it is re-pinned for the
  tap entry.
- **A late timer after a tap** → after `up` the state is `fanSticky`, and a
  `timer` there does nothing (M13, `:258-259`).
- **The world changes while the fan is open** (sheet arrives, VoiceOver turns
  on, background) → `cancel` → close, silent (M12). Unchanged.
- **Activity goes empty or full between the open and the release** → the
  notice or the sheet follows the release-time world (Design 2). The haptic
  follows the open-time snapshot (Design 3 edge). Both cases get tests.
- **The notice stays on screen.** `hubNotice` clears only at the next commit
  (`SessionScreen.tsx:809`), the same as "Already finished" today. That is
  existing behaviour and is not widened here. It goes under Review notes as
  debt for mobile-activity-panel / hub-badges.
- **A drag that used to begin as a "tap"** → still a drag (≥ SLOP). The tap
  branch is only reached under SLOP and before LONG_MS.

### Tests

These fail first on today's code (red), then pass after the change:

- `test/hub-gesture.test.ts`
  - "9 pt / 390 ms → tap, nothing else" becomes **"a tap opens the fan sticky
    + firm, solve called once"**. Red today: the effect is `tap` and `solve`
    is not called.
  - "a tap then a tap on an item commits; a tap elsewhere closes". Red.
  - "a tap then touching the button again closes; its release is ignored". Red.
  - "a tap with no fit → open(menu) + firm". "a tap with no actions →
    silent idle".
  - "commit of a dimmed id → light + commit + close (no `commit` cue)". Red
    (there is no `dimmed` yet).
  - The existing drag / M4 / M13 / M16 cases stay green, unchanged.
- `test/hub-actions.test.ts`: dimmed only for `activity` and only when
  `activityEmpty`. A dimmed item keeps its slot. `resolveCommit("activity")`
  when empty → notice "Nothing running", and when full → run. Release-time
  re-read in both directions.
- `test/hub-session.test.ts`: the M13 test at `:383-388` ("a tap, never a late
  open") becomes "a tap opens sticky, a later timer does nothing". `solveHub`
  carries `dimmed`.
- `test/hub-opacity-wiring.test.ts`: a tap leaves the body solid, and a
  close after it goes back to the set opacity. This pins that the tap entry
  rides the existing engaged rule.
- Non-vacuity: mutate `tap` back to `{ kind: "tap" }` and `commit()` back to
  always `commit`, and confirm the new tests fail (§9).
- Gate: `bun test apps/mobile` per slice, then the full `bun run check`.

### Owner questions

1. **Long-press until voice exists:** should it open the same fan **with
   slide-to-select** (finger held → slide to an item → let go), or exactly
   tap's sticky fan? — *Recommendation: keep slide-to-select. It is the same
   fan and costs nothing, and it is removed when voice takes over the
   long-press.*
2. **VoiceOver double-tap** ("activate"): A) keep it opening Activity, as
   today, or B) open "Show all actions" (the menu), which is the same as tap
   now opening the hub? — *Recommendation: B, with the hint "Double-tap for
   actions". A sighted tap and a VoiceOver activate should do the same thing,
   and the rotor still reaches Activity directly.*
3. **Which items count as "empty" in this task:** only Activity, or also
   Artifacts when the session has none? (Scheduled is already hidden at 0
   wakes.) — *Recommendation: Activity only, which keeps this S and matches the
   request. Artifacts-empty goes to a follow-up line in TODO.md.*
4. **Haptic of a tap-open:** reuse `firm`, the same lift as today's
   long-press, or a lighter one? — *Recommendation: `firm`. It is one "the hub
   opened" feel whatever opened it, and `light` stays the cue for "dimmed,
   nothing happened".*
5. **Order with `feat/mobile-hub-badges`** (same file, same fan items): this
   task first, then badges restyles the dimmed item as a solid disc. —
   *Recommendation: yes, this task first. The dimmed opacity here is a
   placeholder value that badges will replace.*

### Owner answers (2026-11-17 ~22:30)
Q1–Q5: all recommendations accepted (slide-to-select on long-press; VoiceOver activate = B, opens the actions menu; empty = Activity only, Artifacts-empty → TODO; tap-open haptic `firm`; this task before mobile-hub-badges). Implementation APPROVED.
*— recorded by claude-opus-5-5 (orchestrator), 2026-11-17*

## Execution

*— claude-opus-5-5 (executor; model id read from `~/.claude/settings.json`
`model: "opus"` / `claude-opus-5-5`), 2026-11-17*

In the worktree `.tentacle/worktrees/mobile-hub-tap` (branch `feat/mobile-hub-tap`
= `main` @ `d96355bd` + the two plan commits). Order followed as the Implementation
lists it, red before green per slice.

**Load-bearing check first (passed).** `.tentacle/tmp/mobile-hub-tap/repro.ts` on
the branch reproduced the Context exactly:

```
tap → {"state":{"kind":"idle"},"effects":[{"kind":"tap"}]}
activity item (idle, nothing running) → [{"id":"activity","label":"Activity","badge":null,"danger":false}]
```

So the tap emitted `tap` (never `solve`d a fan) and the Activity item had no
"empty" state. Preconditions re-verified in source: `open(..., "sticky")` at
`hub-gesture.ts:189-190`, the no-fit/no-ids early returns (`:135-144`), the
`fanSticky` handler (`:248-260`), `setEngaged(driver.state().kind)` after every
batch (`FloatingActivity.tsx:300`), `hubOpacity`'s engaged rule
(`hub-opacity.ts:68`), `isFanOpen` (`hub-session.ts:246-248`), the notice line
(`SessionScreen.tsx:1214-1221`), `activityView(...).empty` (`activity.ts:60-72`).
No §7 invariant touched.

**As built, in the Implementation's order.**

1. `hub-actions.ts` — `HubContext.activityEmpty: boolean` (required field, not
   optional: the screen must say it, and a silently-defaulted `false` is the bug
   this task fixes); `HubItem.dimmed: boolean`; `NOTHING_RUNNING = "Nothing running"`;
   `dimmedBecause(id, ctx)` (Activity-only, per Q3) used by BOTH `hubActions`
   (the flag) and `resolveCommit` (the notice) so there is one truth for "empty".
   `resolveCommit` gained the branch: a live dimmed id → `{kind:"noop", notice}`,
   read at the release, so a fan opened while empty opens the sheet once Activity
   fills, and an Activity that empties before the release says so (both directions
   tested).
2. `hub-gesture.ts` — `pressing`/`up`: a `tap` now falls through to
   `open(event.p, solve, "sticky")`; only `drag` still diverges. The `tap` effect
   kind is REMOVED from `GestureEffect`. `HubCue` gained `"light"`; `HubMenu`
   gained `dimmed: readonly string[]`; `commit()` plays `light` for a dimmed id and
   still emits `commit` + `close` (one haptic per release). Module doc table updated.
3. `hub-session.ts` — `hubContextOf` takes `activityEmpty?: boolean` (optional in
   the INPUT, defaulted to `false`; every existing caller/test literal stays
   valid); `solveHub` fills `dimmed` from `items.dimmed` on both layouts;
   `hubA11yRoute` — **Q2 = B**: `activate` now routes to `menu` (the `"tap"` route
   variant is gone).
4. `ui/FloatingActivity.tsx` — the `case "tap":` branch and the whole `onPress`
   prop are removed (nothing emits `tap`, and Activity is the fan's item now); the
   `hubA11yRoute` handler lost its `tap` branch; the hint became "Double-tap for
   actions. Swipe up or down for more actions."; `onAccessibilityTap={props.onPress}`
   is removed (RN's default would have fired a prop that no longer exists — the
   `activate` action already covers it); the header comment updated.
5. `ui/HubFan.tsx` — `DIMMED_OPACITY = 0.45` (a named placeholder, owner Q5),
   applied as `item.dimmed && !lit` so a highlighted dimmed item still reads as
   selected; a11y label `"<label>, nothing running"` + `accessibilityState={{disabled}}`.
   The item is never filtered out of `layout.items`, so no slot moves.
6. `screens/SessionScreen.tsx` — `activityEmpty: activityVm.groups.length === 0`
   in the `hubContextOf` call; `onPress={openActivity}` dropped from
   `<FloatingActivity>` (the header pill's `onPress={openActivity}`, `:879`, is
   untouched — it is the other, still-valid path).
7. `changelog.d/mobile-hub-tap.changed.md` — one bullet, as the doc specifies.

**Drift from the Implementation (all small, all deliberate).**

- **A tap with no actions** keeps the plan's behaviour (silent idle) and its test,
  but the plan's `Failure modes` calls it "a tap with no actions" while Design 1
  removes the `tap` path entirely. In practice identical (it now no-ops through
  `open`, not through a `tap` effect); no code difference, noted for honesty.
- **`HubContext.activityEmpty` is required, `hubContextOf`'s input field is
  optional.** The plan says `HubContext` gains it and the screen passes it; it did
  not say which side defaults. Defaulting in `hubContextOf` keeps the 6 existing
  test literals and the artifacts/scheduled suites untouched, and the screen still
  passes it explicitly (pinned by `hub-tap-wiring.test.ts`).
- **`HubFan` a11y label** uses a template literal rather than string concatenation,
  so the NO-faint case keeps the plain label verbatim (a11y tests elsewhere match
  the exact label).
- **e2e flows updated** (not in the plan's Files list): `28-floating-activity.yaml`
  and `33-hub.yaml` both asserted "a tap opens Activity", which this task makes
  false. Both now tap the button → assert `hub-scrim`/`hub-item-activity` → close.
  Leaving them would have shipped a knowingly-stale e2e assertion.
- **New file `test/hub-tap-wiring.test.ts`** (not in the plan's Tests list): the
  plan pinned the *machine* but nothing pinned that the component stopped
  performing `tap`, that the screen passes `activityEmpty` from `activityVm`, or
  that the fan draws a dimmed item without dropping it. Those are `.tsx` files, so
  this is the source-pin pattern of `hub-opacity-wiring.test.ts`.

**Tests — red first, then green.**

- Red on the branch before any `src` change: `bun test apps/mobile/test/hub-gesture.test.ts`
  → **8 fail** (the tap cases, the dimmed-commit cases, M13); `hub-actions.test.ts`
  → 1 error (`NOTHING_RUNNING` not exported); `hub-session.test.ts`,
  `haptic-rules.test.ts`, `hub-opacity.test.ts` each red on their changed case;
  `hub-tap-wiring.test.ts` red on every assertion (`onPress` still present, etc.).
- Green after: `bun test apps/mobile` → 3204 pass / 0 fail (226 files).

**Mutation checks (§9 non-vacuity, all reverted).** Each mutation was applied to
`src`, the narrow suite run, and the file restored from a saved copy:

| mutation | result |
|---|---|
| `tap` → `{kind:"tap"}` restored (the old path) | 8 fail in gesture/session/opacity suites |
| `commit()` cue forced to always `"commit"` | 2 fail (the dimmed-commit cases) |
| `dimmedBecause` forced to `null` (no item ever dimmed) | 4 fail (actions + session) |
| `solveHub`'s `dimmed` forced to `[]` | 1 fail (the snapshot-carried test) |

So every new assertion fails on the old behaviour, and not on an import/compile
error.

**Gate** (worktree, after restoring the mutations): `bunx tsc --noEmit` clean,
`bunx tsc -p apps/mobile` clean, `bunx tsc -p apps/relay` clean, `bun run lint`
clean (0 errors, 0 warnings — the baseline of AGENTS §6), and the full suite:

```
 14851 pass
 5 skip
 0 fail
 47 snapshots, 177774 expect() calls
Ran 14856 tests across 1065 files. [564.21s]
```

Zero failures and only the five documented opt-in skips (live-k8s, live-docker,
real-socket keepalive). No protocol/persistence change, so
`packages/protocol/schema/protocol.json` needs no regeneration and no
`protocol.d/` note.

**One incident, disclosed.** A first foreground `bun test` attempt was killed at
the 120 s timeout mid-run; it left `packages/tui/test/__snapshots__/diagram-lines.test.ts.snap`
with its header line corrupted to an ESC sequence (`\x1b[?25h Snapshot v1, …`).
I restored that one line byte-for-byte, and `git diff` for the file is now empty
(the final full run above leaves it untouched). Likewise, one `git checkout --`
of `apps/mobile/src/hub-session.ts` during the mutation round reverted my own
uncommitted edits to it; I re-applied them by hand and the diff above matches the
intended Design. Neither is in the tree now.

**Unverified (one line).** Nothing was run on a device/simulator: the e2e flows
are updated but not driven, and the dimmed look (0.45) is a placeholder the owner
sees for the first time on device — verify by running `33-hub.yaml`, which now
opens the fan by tapping and asserts the fan, then `28-floating-activity.yaml`.

### Fix round 1

*— claude-sonnet-4-5, 2026-11-17* (my own model id. Note: `~/.claude/settings.json`
says `model: "opus"`, which is the launcher's config, not this agent's identity —
the same contradiction Review flagged against the Execution signature above. I am
signing what I am.)

Both round-1 findings reproduced in source before any edit, then fixed red-first.

**Finding 1 (MEDIUM) — flow 33 asserted a sheet it cannot open.**

*Confirmed:* `33-hub.yaml:146-149` stops the `HOLD hub` turn → `turn-idle`;
`mock-model.ts` starts sub-agents/jobs only for `SUBAGENT27`/`SHELLJOB27`
(`:491-504`), the flow arms no schedule and finishes nothing, so
`activityView(...).groups` is empty ⇒ `activityEmpty` ⇒ `activity.dimmed`, and
`commitPlan("activity", …)` is `{kind:"notice", text:"Nothing running"}`.
`assertVisible activity-sheet-close` could never pass. The header (`:10`) and
`run.ts:1272` still said "tap is still Activity".

*Fixed:* the tap block now taps `hub-item-activity` and asserts the **inline
notice** (`extendedWaitUntil visible hub-notice`) plus
`assertNotVisible activity-sheet-close` — the state the flow actually sets up
(the comment says so, and points at 27 for the sheet's own path). Header and
`run.ts` comments corrected to "a tapped empty Activity says Nothing running".
`28-floating-activity.yaml` needed no change: it only opens and closes the fan.

*Regression tests* (`test/e2e-flows.test.ts`, new describe "flow 33 asserts the
hub state it actually sets up"): (a) `hub-notice` is asserted visible and
`activity-sheet-close` is not asserted visible anywhere in the flow — parsed
through the file's existing `assertions()` helper, so a commented-out or
`assertNotVisible` line cannot satisfy it; (b) the `hub-item-activity` tap
precedes the `hub-notice` assertion (the notice can only come from committing
it); (c) neither the flow nor the runner still carries a "tap … Activity"
comment. *Red on buggy:* with `git show HEAD:…/33-hub.yaml` restored, **3 fail**;
with only the sheet assertion flipped back to `assertVisible`, 1 fail; with only
`run.ts`'s comment restored, 1 fail. Green with the fix.

**Finding 2 (MEDIUM) — a dimmed item's opacity overrode the fan's animation.**

*Confirmed:* `HubFan.tsx:138` put `faint` (`{opacity: DIMMED_OPACITY}`) **after**
the animated `{opacity: hi !== null && !lit ? motion.dimOpacity : value}` in the
style array, so RN's last-wins flattened it to a constant 0.45 — the disc drawn
before the fan's spring/fade starts, left standing while the others fade, and
ignoring the 0.55 highlight dim.

*Fixed:* one `opacity`, computed per item: `base` is still the animated value (or
the highlight dim), and a dimmed, non-lit item's opacity is
`Animated.multiply(base, DIMMED_OPACITY)` — an `AnimatedMultiplication` node
(`AnimatedImplementation.js:93`), so both factors stay on the native driver and
multiply on the UI thread. The `styles.dimmed` entry is gone; the constant is
still the one named placeholder (owner Q5). `!lit` keeps the highlight rule: a
dimmed item under the finger is drawn solid, as before.

*Regression test* (`hub-tap-wiring.test.ts`, replacing the weaker "the faint
level is one constant" case which the buggy code passed): `styles.dimmed` is
absent, `base` is the animated value, the opacity is
`Animated.multiply(base, DIMMED_OPACITY)`, and the style reads that one
`opacity,`. *Red on buggy:* **1 fail** on `not.toContain("styles.dimmed")` (an
assertion failure, not an import error). Green after.

**Mutations (§9 non-vacuity, all reverted from `.tentacle/tmp/mobile-hub-tap/`).**

| mutation | result |
|---|---|
| pre-fix flow 33 restored (`git show HEAD`) | 3 fail (e2e-flows) |
| flow 33's sheet assertion flipped back to `assertVisible` | 1 fail |
| `run.ts`'s "tap = Activity" comment restored | 1 fail |
| HubFan's overriding `faint` style restored | 1 fail (hub-tap-wiring) |

**Gate** (worktree): `bunx tsc --noEmit` clean, `bunx tsc -p apps/mobile` clean,
`bun run lint` clean (2045 files, 0 errors/warnings — the AGENTS §6 baseline),
`bun test apps/mobile` **3208 pass / 0 fail** (226 files), and the full suite:

```
 14855 pass
 5 skip
 0 fail
 47 snapshots, 177783 expect() calls
Ran 14860 tests across 1065 files. [463.50s]
```

Zero failures, only the five documented opt-in skips, and no snapshot file is
modified (`git status` is clean of them).

**Unverified (one line).** Still nothing driven on a device: finding 1's fix is
verified against the flow's state machine and `activityView`'s own emptiness rule,
not against a simulator — `33-hub.yaml` is the check, and it now asserts what the
flow can actually reach.


## Review

*— claude-opus-5-5, 2026-11-17* (fresh context; if the executor really was Opus, as Execution's signature says, this is the same model, so blind spots we share can survive both passes. Note that commit `2ec557ac` says "exec (deepseek)", which contradicts that signature.)

**Verdict: REQUEST-CHANGES**

**Findings**

1. **MEDIUM: the updated e2e flow 33 is wrong, and the change will make it fail.** `apps/mobile/e2e/flows/33-hub.yaml:150-161`: once the `HOLD hub` turn is stopped (`turn-idle`), nothing is running. `mock-model.ts` starts sub-agents/jobs only for flow 27 (`:15`, `:491-504`), there are no schedules, and nothing has finished. So `activityView(...).groups` is empty, `activity` is dimmed, and `tapOn hub-item-activity` gives `resolveCommit`'s "Nothing running" notice instead of the sheet. The `assertVisible activity-sheet-close` step then fails. The new comment ("reaches the sheet while something runs") describes a state the flow never sets up. The header at `:10` still says "a tap is still Activity". Fix: either assert the dimmed item plus the notice text `Nothing running` here, or run something first. Execution's line "e2e flows updated" was never run.
2. **MEDIUM: a dimmed item's opacity overrides the fan's animated opacity.** At `apps/mobile/src/ui/HubFan.tsx:138`, `faint` comes after the `{ opacity: hi… ? motion.dimOpacity : value }` style in the array, so the later entry wins. The dimmed disc therefore sits at a fixed 0.45 from frame 0 of the open fade, stays at 0.45 while the other items fade out on collapse, and ignores the highlight dim (0.55). Visible effect: the Activity disc shows up before the fan and stays behind after it closes. Fix: multiply the two opacities (e.g. an inner `View` that carries the 0.45) instead of overriding.

**Gate** (worktree): the touched suites gave 153 pass / 0 fail across 6 files. `bun run lint` is clean (2045 files). `bun run typecheck` is clean (root, mobile, relay). I did not re-run the full suite; Execution reports 14851 pass / 5 skip / 0 fail.

**Mutations** (all reverted; `git status` is clean afterwards):
- tap → idle with no effects: 7 fail (gesture/session/opacity).
- `commit()` cue always `commit`: 2 fail.
- `resolveCommit`'s dimmed branch nulled: 2 fail.

The new tests are not vacuous.

**Attacks tried**
- (a) Other paths to Activity: the ActionSheet/"Show all", the rotor `item:activity` and VoiceOver activate (now → menu) all go through `commitHub` → `resolveCommit`, so they all get the notice. Holds.
- (b) Is `groups` empty while the sheet would still show something? `finished` and `scheduled` are both groups, so empty means truly empty. Holds.
- (c) Double tap / late timer: the `fanSticky` close and the M13 no-op are pinned. Holds.
- (d) §7 invariants: mobile-only and pure plus rendering, with no protocol, persistence or terminal I/O touched. Holds.
- (e) e2e coherence: fails (finding 1).

**Executor behaviour:** the work is disciplined. It went red-first, mutated its own tests, disclosed the snapshot and `git checkout` incidents, and recorded its drift. But it edited e2e flows it never drove without checking the state they assume, and its model signature contradicts the commit message.
