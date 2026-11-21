# fix/mobile-project-first-tap — a just-paired project reads "Offline" until its first probe lands

Type: fix · Size: S · Blast: contained · Suited: DeepSeek exec + Opus review

## Context

QA sweep 2026-11-21 (`.tentacle/tmp/mobile-qa-1121/REPORT.md` row 13, simulator, main 63d76f3e):
for ~1–2 s after pairing (and, by the same path, on a cold start) a project row shows
"Offline · None of its projects answers" although the daemon answers — the first status probe
has not landed yet. A tap in that window hits `App.tsx` ComputersRoute `onOpen` → `row.state ===
"unreachable"` → `setTick` (a silent re-probe, "mockup A3") and does NOT open the sessions; a
second tap works. Collateral: `scripts/e2e-gate.sh` went from known reds to **40 FAIL**, every one
failing on that first tap after pairing — the gate is blind until this is fixed.
Root cause (to confirm with a red test first): "no probe result yet" is projected as
`unreachable` instead of its own state.
*— claude-opus-5-5 (orchestrator), 2026-11-21*

## Implementation

- **Load-bearing check:** find where a row's `state` is computed (`apps/mobile/src/computer-rows.ts` /
  `computer-status.ts`, the pure view-model) and prove with a unit test that a project with NO probe
  result yet is projected as `unreachable` (red).
- **Design:** a distinct `checking` state for "not probed yet" (copy: a neutral "Checking…", no
  dashed/offline styling — colour-blind rule: the state is WRITTEN, never hue only). A tap on a
  `checking` row is not dropped: it waits for that probe (bounded, e.g. ≤ 5 s) and then opens if the
  probe says ok, else falls to today's unreachable behaviour. Keep the logic in the pure module
  (AGENTS §7 "logic in pure modules"); `App.tsx` only wires it.
- **Failure modes:** probe never answers (bounded wait → unreachable, no hang); probe fails; two taps
  during checking (one open only); row removed/revoked while waiting; app backgrounded mid-wait.
- **Tests:** red-first unit tests on the view-model (no probe → checking; ok → ok; fail → unreachable);
  the tap-while-checking decision as a pure function with its cases; mutation: project "no probe" as
  unreachable again → red. Then run `scripts/e2e-gate.sh` is NOT required of the executor (simulator) —
  the orchestrator runs it.
- Changelog fragment: `changelog.d/mobile-project-first-tap.fixed.md`.

## Execution

### Load-bearing check (as the plan asked: `file:line` + a unit-test-shaped repro)

`apps/mobile/src/project-rows.ts:projectSections` built each row's observation as
`observations[index] ?? missing`, where `missing` was a **failed** probe
(`probe: {ok: false, …}`) — so a record with no probe result at all fell into
`failedState()` and read `unreachable` / "Not reachable" / section "Offline ·
None of its projects answers".

Repro `.tentacle/tmp/mobile-project-first-tap/load-bearing.ts` (before the fix):

```
no probe result yet  → {"state":"unreachable","word":"Not reachable","ok":false,
                        "section":"offline","status":"Offline",
                        "note":"None of its projects answers. Check the computer is awake…"}
ok:true              → new / New
ok:false             → unreachable / Not reachable
```

CONFIRMED. The plan's premise holds at the module level, and it is the assertion
the new unit test goes red on (`apps/mobile/test/project-rows.test.ts`, first run:
`Expected: "checking" / Received: "unreachable"`).

### Drift from the plan's stated root cause (found while reproducing — recorded, not smoothed over)

The plan says the row shows Offline "because the first status probe has not landed
yet". Two facts from the QA artefacts say the *literal* claim is not what the gate
hit:

1. The Computers screen has no row at all until `loadSections()` (now
   `readSectionInputs`) resolves — sections start as `[]` (`App.tsx:1050`). A
   rendered row therefore always HAS an observation; the "no probe result yet"
   branch is only reachable through a shorter `observations` array.
2. The gate's own failed-assert hierarchy
   (`…/ios26/02-session-list/2026-11-21_092028/02-session-list/screen-hierarchy/`)
   shows the tapped row as `computer-state-…-idle` **after** the dropped tap, i.e.
   a probe had settled and the re-probe read `idle`.

So the window the gate hits is "a probe settled and **failed** (dial/handshake
still settling right after `pairing-done`)", which projects to `unreachable`
through the *same* line. The Design still fits both cases — a distinct not-yet-known
state plus a tap that waits — so I implemented it for both, rather than narrowing
it to one. This is the one place the plan's wording was corrected, not its Design.

### As built, in order

1. `apps/mobile/src/project-rows.ts`
   - `ProjectState` gains `checking`; `PROJECT_WORDS.checking = "Checking…"`;
     `ProjectTone` gains `wait`; `SectionState` gains `checking`.
   - `ProjectRow.muted` (new): the dashed folder / dimming is now a row's OWN
     verdict, false while `checking` (a row nobody asked about is not dimmed).
   - `projectSections`: a record whose observation is **absent** is `checking`
     (not `failedState`); `options.checking` names records whose probe is in
     flight, so a tap repaints that row as `checking` over its stale verdict. A
     section is `checking` ("Checking…") when nothing answered and something is
     still being checked; the "None of its projects answers" note is only claimed
     when every row really is `unreachable`.
   - `reprobeDelay` treats `checking` like `stopped`/`unreachable`, so a wait that
     lapses still converges via the 15 s reconsideration.
   - NEW pure decision functions: `TAP_WAIT_MS` (4 s), `ProjectTap`,
     `projectTap(row)` (open / reprobe / menu) and `tapSettled(row|undefined)`
     (open only if it answers NOW), so the tap logic is testable (AGENTS §7).
2. `apps/mobile/src/ui/StatusDot.tsx`: a `wait` tone — a neutral ring, no hue-only
   signal (the state is also written).
3. `apps/mobile/src/screens/ComputersScreen.tsx`: `iconDashed`/`dimmed` follow
   `row.muted` (not `!row.ok`); the row's dot and the section's dot map `wait`.
4. `apps/mobile/App.tsx`
   - `probeAll` reports the records as soon as the store is listed
     (`recordsOf`), so the route can paint rows **before** the probes land.
   - `loadSections` split into `readSectionInputs` (records + observations) and
     `sectionsOf` (projection, with `checking`).
   - `ComputersRoute`: the FIRST read paints records-only (`checking`) so the
     screen is never empty and never claims an unasked computer is down; later
     15 s re-reads do not repaint known rows as `checking` (no flashing).
   - `onOpen` is now `projectTap`: `open` navigates, `menu` opens the sheet, and
     `reprobe` goes through `awaitProbe(id)` — bounded by `TAP_WAIT_MS`, one wait
     at a time (`settling` ref), paints the tapped row as `Checking…`, then
     `tapSettled`: opens the project if the fresh probe answers, else falls back
     to today's behaviour (tick → next reconsideration). `tapGeneration` makes a
     superseded wait unable to navigate.

### Tests (red first, then green)

`apps/mobile/test/project-rows.test.ts` — 3 new tests + 1 new case in an existing
one; 12 pass / 0 fail. Red evidence, in order:
- the checked-in property test failed on `Expected: "checking" / Received:
  "unreachable"` (the load-bearing assertion, not an import/compile error);
- the tap tests then failed on `SyntaxError: Export named 'TAP_WAIT_MS' not found`
  before the exports existed (missing capability, as a feat's repro should show).

Failure modes covered: no probe result at all; partly probed (one answered, one
checking); a `broken` record never becomes `checking`; a lapsed wait still
re-probes; tap on ok/checking/stopped/unreachable/revoked/maybe-reset; the settle
decision with the row gone (undefined), still down, and needs-a-pairing; the
bounded wait's range test.

### Mutations (each pasted result is a real run of the narrow file)

1. "no probe result → unreachable again" (`probed[i] !== true` → `false`):
   **2 failed**, `Expected: "checking" / Received: "stopped"` (and the first
   property test).
2. "one arm for every non-ok row" (`projectTap` returns `"reprobe"` always):
   **1 failed** (the tap-decision test).
3. "trust the asked row" (`tapSettled` ignores freshness):
   **1 failed** (the settle test).

### Not done here (orchestrator's)

- `scripts/e2e-gate.sh` was not run: the plan explicitly leaves it to the
  orchestrator (simulator). The gate's own recovered state is what flow
  `02-session-list` proves.
- No `protocol.d/` note and no schema regeneration: nothing on the wire changed
  (this is a UI view-model + route change only).
- `apps/mobile/App.tsx` still owns the tap wiring (known debt per AGENTS §7); the
  DECISIONS it makes are in the pure module.

*— claude-opus-5-5 (executor), 2026-11-21*

## Review

**Verdict: REQUEST-CHANGES** (one MEDIUM; the view-model half holds).

1. **MEDIUM — a stale tap-wait navigates after the person chose something else**
   (`apps/mobile/App.tsx:1154–1157`, `awaitProbe` → `onOpen(settled)`; open branch
   `App.tsx:1189–1191`). `settling` only blocks a second *wait*; a tap on an
   answering row B (`projectTap` → `"open"`), "Add" (Pair), Settings, or backgrounding
   is not blocked and does not bump `tapGeneration`. Scenario: tap unreachable A →
   within 4 s tap working B (B's sessions open) → A's re-probe answers →
   `navigation.navigate("Sessions", {computerId: A})` yanks the person to A (or off
   the Pair screen). The `tapGeneration` guard is vacuous (no second `awaitProbe` can
   run while `settling` is true), so the plan's "two taps → one open only" failure
   mode is NOT covered. Fix: bump `tapGeneration` on every tap/open/menu/onAdd and on
   blur (`useFocusEffect` cleanup), and drop the settle if not focused; keep that
   decision testable (pure `tapSettled(row, {stale})`-style input).

Gate: `project-rows.test.ts` 12 pass / 0 fail; `bun run lint` clean; `bun run
typecheck` clean. Full `bun test` not re-run (narrow scope asked).
Mutation: `probed[i] !== true` → `false` ⇒ 2 fail (checking tests); reverted,
tree byte-identical (`git status` clean), 12 pass again.
Premise: TRUE at module level — absent observation fell into `failedState` (`missing`
is `ok:false`). Executor's drift note (gate hit a settled-but-failed probe) is
plausible and the re-probe-then-open path addresses it; not verified on simulator.
Attacks tried: (a) other `SectionState`/`ProjectTone` consumers missing `checking`/`wait`
— none, typecheck clean; (b) 15 s re-reads flashing `Checking…` — guarded by
`inputsRef`/`painted`, holds; (c) wait timeout — race resolves, `settling` released,
tick re-probes, holds (the orphaned probe's result is dropped, acceptable);
(d) row removed mid-wait — `tapSettled(undefined)` → fallback, holds; (e) concurrent
tap-probe + focus-probe double-dials the same daemon — harmless, not a finding.
No §7 invariant touched (UI only, no wire/persistence). Executor behaved well:
honest drift note, red-first evidence, real mutations; missed the cross-path race.
Same model family as the executor (fresh context only).

*— claude-opus-5-5, 2026-11-21*

### Fix round 1

Scope: the Review's one finding (MEDIUM — a stale tap-wait navigates after the
person chose something else). One extra arm found while fixing it is listed too.

**Finding 1 (MEDIUM) — FIXED.** Root cause, as the Review said: the generation
guard compared a wait against itself. `settling` blocked a second *wait*, but
nothing bumped `tapGeneration` when the person chose something else, so
`mine !== tapGeneration.current` could never be true and the settle navigated
unconditionally when its probe answered.

1. `apps/mobile/src/project-rows.ts:352–390` — `tapSettled` now returns a
   three-arm `TapSettle` (`open` / `retry` / `drop`) and takes the facts only the
   screen knows (`TapSettleInput { superseded?, backgrounded? }`): `drop` when the
   person asked for anything after the tap, else `open` if the row answers NOW,
   else `retry` (today's re-probe; the old `"fallback"` arm, renamed).
   `project-rows.ts:392–396` — NEW pure `wasBackgrounded(state)` over RN's
   `string | null`: `background`/`inactive` are "not in front"; `active`, unknown
   and `null` are not a reason to drop. One rule, used by the route, pinned by
   its own test.
2. `apps/mobile/App.tsx:1063–1073` — `supersede()` (`useCallback([])`, increments
   `tapGeneration`) and `sentOffscreen`; the `settling` ref is GONE (it was the
   thing silently swallowing a second tap).
3. `App.tsx:1120–1134` (the `tick` re-probe effect) — the AppState listener sets
   `sentOffscreen` from `wasBackgrounded` and supersedes on going away, else
   `setTick`; deps gain `supersede`. `App.tsx:1142–1155` — a SECOND
   `useFocusEffect` with **no** `tick` dependency owns leaving the screen:
   cleanup sets `sentOffscreen = true` and supersedes. Both effects seed
   `sentOffscreen` from `wasBackgrounded(AppState.currentState)`, NOT from a
   literal `false`: they re-run every 15 s, and that must not mark a backgrounded
   app as being in front.
4. `App.tsx:1160–1219` (`awaitProbe`) — one wait at a time, and a tap during a
   wait SUPERSEDES it (the newer wins) instead of being dropped on the floor. The
   settle computes `superseded`/`offscreen`, calls `tapSettled(row, …)`, and on
   `drop` **returns before any repaint or navigation**; on `open` it supersedes
   then navigates.
5. Every ask the person can make bumps the generation: `onOpen` (open / menu /
   wait), `onAdd`, `onScan`, `onRetry`, `onPairAgain`, `onMenu`, `onRemove`,
   `onOpenSettings` (`App.tsx:1224–1286`).

**Tests — red first.**
`apps/mobile/test/project-rows.test.ts`: the settle test gains the `drop` arms
(`superseded`, `backgrounded`); NEW `wasBackgrounded` test (active / inactive /
background / unknown / null).
`apps/mobile/test/project-tap-wiring.test.ts` (NEW — the `hub-tap-wiring.test.ts`
pattern, since `App.tsx` is not importable from Bun): the settle is handed
`superseded`+`backgrounded` and `drop` returns before `setSections`/`onOpen`; all
eight ask-handlers call `supersede()`; leaving the screen supersedes from the
`tick`-free effect; the AppState listener goes through `wasBackgrounded` and
supersedes, and neither effect seeds `sentOffscreen` from a literal; `settling`
is gone.

**Mutations (each a real run of the narrow file).**
- A. `tapSettled`'s drop arm removed (`if (false)`) → `project-rows.test.ts`
  **1 fail**, `Expected: "drop" / Received: "open"`.
- D. `wasBackgrounded` reduced to `state === "background"` → **1 fail**,
  `Expected: true / Received: false` (the `inactive` case).
- B+C. `onMenu` no longer supersedes, and `tapSettled(settledRow)` without the
  input → `project-tap-wiring.test.ts` **2 fail**.
- E. the AppState listener reverted to round-0's (`state === "active"` → tick) →
  **1 fail**, `Expected to contain: "wasBackgrounded(state)"`.
All reverted by re-copying the file; the tree matches the intended diff and the
files are green again (19 pass / 0 fail over the two files).

**Failure modes now covered.** a tap during checking (one wait at a time, the
newer wins) · a wait outliving a tap on an answering row (drop) · the menu / Add
/ scan / Retry / Pair again / Remove / Settings during a wait (drop) · leaving
the screen mid-wait (drop) · app `background` or `inactive` mid-wait (drop) · a
bounded wait that times out (retry, no hang) · a row removed mid-wait
(`tapSettled(undefined)` → retry) · the 15 s reconsideration (NOT a supersede —
its own effect, `tick`-free).

**Not done here.** `scripts/e2e-gate.sh` (orchestrator's, simulator). No
`protocol.d/` note (nothing on the wire) and no `SectionState`/`ProjectTone`
changes. The full `bun run check` gate is the orchestrator's script, not run here
per the token budget; the narrow evidence is: `project-rows.test.ts` 15 pass,
`project-tap-wiring.test.ts` 5 pass (19 together), the 29 mobile test files that
source-pin `App.tsx` 390 pass / 0 fail, `tsc -p apps/mobile` clean,
`biome check` clean on the four changed files.

*— claude-opus-5-5 (executor, fix round 1), 2026-11-21*
