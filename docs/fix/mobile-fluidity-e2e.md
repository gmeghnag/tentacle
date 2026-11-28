# fix/mobile-fluidity-e2e — two e2e flows red after the fluidity slices

> **Status:** implementation (APPROVED — orchestrator, owner delegation)
> **Branch:** `fix/mobile-fluidity-e2e`
> **Size:** S–M · **Blast:** cross-module · **Suited:** Sonnet exec (simulator), Opus review
> **Changelog:** none — the 44 regression (s3, merged 28/11 05:22) never shipped (last release 0.9.0, 27/11); the 34 fix is harness-only.

## Context

*— claude-opus-5-5, 2026-11-28*

The night e2e gate on main `a6da148d` (after fluidity s0..s7) had two reds:
`44-workflow-editor` (gate + rerun) and `34-hub-scheduled` (gate only). They are
**two different bugs**, and only one is a fluidity regression.

**44-workflow-editor — a real app regression (s3), deterministic.** After Run on
the workflow start form, the run's hash approval must come up as the ask sheet
over the run screen (`44-workflow-editor.yaml:199-207`, docs/fix/mobile-ask-surfaces.md
D6). On main the run screen shows only the slim ask row («Run workflow wfedit v1 …
Review ^») and `perm-sheet` never appears (night screenshot
`…/1795854313517/ios26/44-workflow-editor/…/step-096-assertCondition-perm-sheet.png`).
Trigger: the ask is raised while the Workflows landing is on top, then the run is
PUSHED over it. Magnitude: always (3/3 runs). Collateral: none — the store has
the ask (the slim row shows it).

**34-hub-scheduled — a pre-existing, order-dependent HARNESS flake.** It failed
before the fluidity slices too (`e2e-gate-2411b.log:466`, `e2e-gate-2611-night.log:550`,
`e2e-gate-mobile-native-sheets.log:167`), passes alone (night rerun, and here),
and fails deterministically after flow `10-background-ask` on the same `serve`.
The phone shows the `schedule_create` ask sheet still up at 30 s and the turn
never ends (night screenshot `step-035-assertCondition-turn-idle.png`); the
daemon's log shows that turn ended 324 s after it started
(`unit_end dd7ff6e4… startedAt 1795852938149 endedAt 1795853262310`) — i.e. the
ask was answered only by a LATER flow's `laptop-prompt`.

**Repro** (28/11, simulator iOS 26 `0B43D716…`, main's cached Release build
`b9b4ce1d1d5a` = the night's app, harness of this branch = main):

```
bun apps/mobile/e2e/run.ts --udid 0B43D716-9670-421A-BE51-9162004F2963 \
  --app <main-ro>/.tentacle/tmp/e2e-app-cache/b9b4ce1d…/tentacle.app \
  --only 34-hub-scheduled,44-workflow-editor
34-hub-scheduled    PASS    60       1
44-workflow-editor  FAIL    112      1        # run 1795854975370

… --only 09-foreign-turn,10-background-ask,11-disconnect-mid-turn,14-returned-mine,15-returned-other,34-hub-scheduled
… 15-returned-other PASS · 34-hub-scheduled FAIL 74   # run 1795855404287

… --only 10-background-ask,34-hub-scheduled
10-background-ask  PASS    68       1
34-hub-scheduled   FAIL    74       1          # run 1795855853216 (minimal pair)
```

After the 6-flow run, the ONLY daemon session with an open turn is 34's own
(`1054e434….state.json`: turn `651f9f7b…` without `end`, log contains `WAKEPING`).

**Bisect.** A build bisect across the slice merges was not run: building an older
tree needs a scratch worktree / `git archive`, which this planning session could
not get approved (and disk is at 32 GiB free). Attribution is from the source
instead, and the decisive test is the fix's own red→green e2e:
- 44: before s3 the screen re-rendered on EVERY controller publish —
  `git show ab3a158c:apps/mobile/src/screens/SessionScreen.tsx` lines 396-402
  (`controller.subscribe((next) => { … setState(next); })`). s3 (`d3e98913`)
  replaced that with three slice subscriptions (`SessionScreen.tsx:331-333`
  today), so nothing re-renders Session when only the navigator changes.
- 34: the harness files involved (`seed.ts` `laptopLink`, `hooks.ts`) did not
  change in the slices except `longHistory`/`longSessionOf` (s0, `601dfd5f`);
  the flake predates them (logs above).

## Implementation

*— claude-opus-5-5, 2026-11-28*

### Load-bearing assumption

**A `useNavigationState` selector re-renders Session when the screen on top
changes, even while Session is blurred.** Proven in the installed
`@react-navigation/core` 7.24.0
(`node_modules/.bun/@react-navigation+core@7.24.0+…/src/useNavigationState.tsx`):
the provider notifies every subscriber after each committed navigator state
(lines 91-94), with no focus check, and the hook `forceUpdate()`s exactly when
`Object.is(previous, selector(state))` is false (lines 51-58). The existing
`stackKey` selector (`SessionScreen.tsx:356-358`) already relies on this while
Sheet routes blur Session.

### Preconditions

- 44 — the stale value: `topRunId` and `workflowsTop` are computed from
  `rootRoutes` (`SessionScreen.tsx:480,483`), a memo of `navigation.getState()`
  read at render (`:363-366`). A render happens only on `rowsSlice`/`hubSlice`/
  `sheetsSlice` (`:331-333`), `stackKey` (`:356`) or focus (`:477`). `stackKey`
  is the signature of SHEET routes only (`sheet-plan.ts:354-358`), and pushing the
  run over the landing does not change Session's focus (it is already blurred by
  the landing). The run is a plain push from the landing
  (`App.tsx:3861-3868`, `navigation.navigate("WorkflowRun", …)`).
- 44 — why stale blocks the sheet: while the landing is on top
  `askPresentable` returns `reviewed` (false) (`sheet-plan.ts:856-858`); with the
  run on top it returns true for that run's own ask (`:862`). The `permission`
  leg of `desiredStack` reads both (`SessionScreen.tsx:1550-1564`). The ask
  arrives while the landing is on top (the run is opened after the start), so the
  last render saw `workflowsTop === true` and no later render corrects it.
- 44 — the pure functions already exist and return primitives:
  `ownRunTopId` → `string | null` (`sheet-plan.ts:779-801`), `ownWorkflowsTop`
  → `boolean` (`:819-838`), so they are valid `Object.is` selectors as they are.
- 34 — the harness's laptop requester holds every ask in `pending` keyed by
  `tool\0title\0detail` and NEVER removes one whose request is withdrawn: it
  ignores `options.signal` (`apps/mobile/e2e/seed.ts:364-370`; the signal is
  passed: `packages/client/src/remote-client.ts:5210-5216`,
  `packages/core/src/permission.ts:230-232`).
- 34 — flow 10 leaves such a stale entry: its laptop turn `EDIT c.txt`
  (`flows/10-laptop-edit.js:7`) raises an `fs_write` ask (`e2e/mock-model.ts:9`)
  that the PHONE answers (`flows/10-background-ask.yaml:72-73`), so the laptop's
  copy is withdrawn but stays in `pending`.
- 34 — the stale key ends the wait at once: `prompt(…, answer)` polls until ANY
  `pending` key starts with `fs_write` (`seed.ts:441-448`), then `answerAll`
  (`:449`, `:499-504`) answers what is pending NOW. With flow 10's stale
  `fs_write…` key present it answers immediately — before 34's
  `schedule_create` ask exists — and that ask is never answered by this hook
  (the 324 s turn above). Alone, the loop waits its 10 s and the ask is there.
  The same latent race hits every `answer=allow` caller: flows 34-hub-*,
  `35-gallery-laptop.js:108`, `36-preview-laptop.js:33`.
- An ask's `options.turnId` names the turn it was raised in
  (`permission.ts:250-255`; set from the stream bracket or the update,
  `permission-router.ts:202-214`, passed at `remote-client.ts:5212`).

### Design

**44 (app).** In `SessionScreen.tsx`, derive the two "what is on top" facts from
`useNavigationState` selectors instead of the render-time routes:

```ts
const topRunId = useNavigationState((state) =>
  owner === null ? null : ownRunTopId(state.routes as readonly SheetRouteLike[], owner),
);
const workflowsTop = useNavigationState(
  (state) => owner !== null && ownWorkflowsTop(state.routes as readonly SheetRouteLike[], owner),
);
```

Session now re-renders exactly when its own run / landing becomes or stops being
the top screen — rare events, so no cost to the fluidity budget (s0's perf flow
90 must stay green). Everything downstream (`inFront`, `askPresentable`,
`desiredStack`) is unchanged. `rootRoutes`/`sheetStack` stay as they are (keyed
by `freshKey` + `stackKey`); fix the now-misleading comment at `:359-362` to say
the run/landing facts come from selectors. Rejected: widening `stackSignature`
to every route (it is the sheet reconciler's dependency — every navigation would
re-run it); re-adding a whole-controller subscription (undoes s3).

**34 (harness).** Extract the laptop link's ask bookkeeping from `seed.ts` into a
pure module `apps/mobile/e2e/laptop-answerer.ts` (no network), then fix it:
1. a withdrawn request (`options.signal` aborted) is removed from `pending` and
   settles as `DISMISSED` — no stale entries;
2. `laptop-prompt … answer=X` registers its `turnId` BEFORE sending; the
   requester answers at once, with X, every ask whose `options.turnId` is that
   turn, for as long as the turn runs (released in the drain's `finally`). Asks
   already pending for that turn are answered at registration. No polling loop,
   no `fs_write` prefix: the hook returns right after starting the turn, as the
   no-answer form already does;
3. `answerAll` (the `laptop-answer` hook, flow 09) keeps its meaning: answer
   every LIVE pending ask.

`hooks.ts` is unchanged (same query, same response).

#### Orchestrator decisions (owner delegation, 28/11)

1. **Fix 34 here, not in a separate task** — recommended and taken: it is the
   other half of this TODO item, the gate must be green, and the change is
   harness-only. (Alt: split to `fix/e2e-laptop-answer`; rejected, same gate.)
2. **44 shape: `useNavigationState` selectors** — recommended and taken (above).
3. **No build bisect** — taken: the attribution is cited from source, and the
   fix's own red→green e2e is the decisive test. The executor does NOT build old
   trees.
4. **No changelog fragment** — the 44 regression never shipped; 34 is test-only.

No choice here touches an AGENTS §7 trust rule (the auto-answer lives in the
e2e harness's own laptop client, not in any product broker).

### Files

1. `apps/mobile/e2e/laptop-answerer.ts` (new) — `pending`, `requester`,
   `answerAll`, `answerTurn(turnId, answer) → release`; pure, injectable.
2. `apps/mobile/e2e/seed.ts` — `laptopLink` uses it (`:355-370`, `:419-452`,
   `:498-504`).
3. `apps/mobile/src/screens/SessionScreen.tsx` — `:480`, `:483` (+ comment `:359-362`).
4. Tests: `apps/mobile/test/laptop-answerer.test.ts` (new),
   `apps/mobile/test/session-front-wiring.test.ts` (new), cases added to
   `apps/mobile/test/sheet-plan.test.ts`.

### Failure modes

- **Ask raised before the run is pushed** (44's case): the selector flips when
  the push commits → render → `askPresentable` true → sheet. **After** the push:
  `sheetsSlice` publishes → same render. Both orders converge.
- **Another session's run on top / a Sheet over the run**: unchanged pure rules
  (`ownRunTopId` skips Sheet routes, rejects other sessions) — pinned by tests.
- **Run popped back to the landing with the ask pending**: selector flips back,
  `workflowsTop` true → banner again (D1 behaviour), no stray sheet.
- **owner null** (route without ids): selectors return `null`/`false`, as today.
- **Harness: ask raised before/after the hook returns, or after a stale ask** —
  answered by turnId whenever it arrives; a withdrawn one is gone from `pending`.
- **Harness: ask without `turnId`** — not auto-answered (stays pending for
  `laptop-answer`); if the e2e shows the own-turn ask lacks it, STOP and fix the
  plan (do not fall back to "answer everything").
- **Harness: turn ends/cancelled** — registration released in `finally`; a late
  ask of that turn is not answered by a dead registration.

### Tests

Red before green (§9), each red on its assertion, not on an import:

1. **Harness (34)** — step A: move the CURRENT logic verbatim into
   `laptop-answerer.ts` (including today's poll-then-`answerAll`, with an
   injectable `sleep`) and write `laptop-answerer.test.ts`:
   (a) a withdrawn ask leaves no `pending` entry; (b) with a stale withdrawn
   `fs_write` ask present, an `answer=allow` turn's `schedule_create` ask that
   arrives AFTER the hook returned is answered `{allowed: true}`; (c) an ask of
   ANOTHER turn is not answered by that registration; (d) `answerAll` answers
   live asks only. Show (a)(b) RED on step A; step B fixes → green.
2. **App (44)** — `session-front-wiring.test.ts` (the repo's source-reading
   pattern, e.g. `fan-jank-wiring.test.ts`): `topRunId` and `workflowsTop` come
   from `useNavigationState` selectors calling `ownRunTopId`/`ownWorkflowsTop`,
   and neither is computed from `rootRoutes`. RED on main. Plus `sheet-plan.test.ts`:
   over the 44 sequence `[Session, WorkflowStart]` → `[…, WorkflowRun]` →
   `[…, WorkflowRun, Sheet]` the two selectors' values differ by `Object.is` at
   the push and not at the Sheet, and `stackSignature` is identical across the
   push (documents why `stackKey` could not catch it).
3. **Mutation**: revert `:480` to `rootRoutes` → wiring test red; drop the
   `signal` cleanup → (a)/(b) red.
4. **E2E (decisive)**, under `sim.lock`: `--only 10-background-ask,34-hub-scheduled`
   and `--only 44-workflow-editor` RED on main's build (done above) → GREEN on
   the branch's build; then `--only 10-background-ask,34-hub-scheduled,35-gallery-shots,36-preview-cards,36-theme-beta-shots,44-workflow-editor,90-perf-stream`
   (90 = the s0 perf gate must still pass); full 2-sim gate before merge per the
   fast-gates rule.
5. `bun run check` green (lint baseline clean).

Unverified: that an own-turn ask carries `options.turnId` on the harness's
client — verified by test 4's green 34 (and by a one-line log in the requester
during the first run, removed after).

## Execution

*— claude-sonnet-5-5, 2026-11-28*

**Result: 34 DONE. 44 PARTIAL — still RED on the simulator. The plan's 44 design
is necessary-looking but NOT sufficient; do not merge as "44 fixed".**

- **Load-bearing check: holds.** Installed `useNavigationState.tsx` (core 7.24.0)
  has no focus check; `forceUpdate` on an `Object.is` change (lines 51-67, 91-94).
  The live log below also shows Session re-rendering while blurred.
- **Drift:** the Repro was not re-run on main before editing (I relied on the
  Context's run of the same day).

### 34 (harness) — DONE
- Step A (old logic moved verbatim): 5 fail / 3 pass, on assertions — both (a),
  (b), "every later ask of that turn", (d). Step B: 8/8.
- `e2e/laptop-answerer.ts` (new), `e2e/seed.ts` uses it. Drift: `pending` is a
  Set (two identical asks no longer overwrite each other); `answerAll` and
  `answerTurn` are synchronous; the final module needs no `sleep` seam.
- The unverified `options.turnId` point is settled: flow 34 passes, and the new
  code answers nothing without it (no temporary requester log was needed).

### 44 (app) — PARTIAL
- `SessionScreen.tsx`: `topRunId` / `workflowsTop` are `useNavigationState`
  selectors; comment fixed. `session-front-wiring.test.ts` was RED on the old
  code (2/2, received `…ownRunTopId(rootRoutes, owner)`), then green. The
  `sheet-plan.test.ts` 44-sequence cases pin pure behaviour (green on main too).
- **E2E still fails** at step 96 `perm-sheet`, same screen as the report (slim
  ask row, no sheet).
- **Temporary logging** (removed; `git diff` holds only the approved change).
  With the run on top the render has `topRunId:"wf-1"`, `workflowsTop:false`,
  `inFront:true`, `hidden:false`, `parked:false`, `actual:[]`,
  `wanted:["permission"]`. The loop effect never runs with those values, so
  `openSheet` is never reached. Numbered run `1795858513010` (no gaps, so no
  dropped log lines):

```
#61 render-body wanted= actual=0
#62 render-effect {"topRunId":null,"workflowsTop":true,…}
#63 loop{…"wanted":[]…}
#64 render-body wanted=permission actual=0
#65 render-body wanted=permission actual=0
#66 render-effect {"topRunId":"wf-1",…}     ← only the NO-DEPS effect
#67 render-body … #68 render-effect … #69 render-body … #70 render-effect
```

  Probes, in declaration order: `useEffect([wantedKey])`, the no-deps
  render-effect, the loop, `useEffect([wanted])`. After #63 none of the three
  dep-keyed ones logs again (the lines after #70 were not paged; the run before,
  `1795857974640`, searched whole, has no later `loop` line). So the cause is not
  in `sheet-plan` or the loop's gates: React skips dep-keyed effects whose deps
  changed. The plan's premise "a render with the right values presents the sheet"
  is false.
- **Not established:** why. Unproven hypothesis: the #64 render commits with its
  passive effects never run, so #65 compares against deps already
  `permission`. No JS exception was found by a log search; no `Activity`,
  `freezeOnBlur`, `enableFreeze` or React Compiler setting matched in
  `apps/mobile`, nor `Activity`/`Freeze` wrappers in native-stack/elements.
  This also puts the Context's s3 attribution in doubt (never bisected).
- **Stopped here** (§0, and "no production code outside the approved
  Implementation"). Needs a new plan. Cheapest next test: log a per-instance id
  plus `useLayoutEffect([wantedKey])` beside `useEffect([wantedKey])`, to tell
  whether #64 committed.

### Evidence
- Unit: 262 pass / 0 fail over the 9 touched/covering files; `tsc -p
  apps/mobile` clean; `biome check` on the 6 changed code files clean.
- Mutations (`.tentacle/tmp/mobile-fluidity-e2e/mutate.ts`, each restored):
  - M1 `topRunId` back to `rootRoutes` → wiring `topRunId` case red (1/1).
  - M2 no `signal` listener → (a), (b), (d) red (5 pass, 3 fail).
  - M3 release does nothing → "released registration" red (7/1).
  - M4 registration answers any turn → (c) red (7/1).
- E2E (iOS 26 `0B43D716…`, under `sim.lock`, released), branch build:
  `10,34` PASS 2/2 (run `1795856329899`; the minimal pair, RED on main);
  `44` FAIL (`1795856852910`). Final clean tree, run `1795859027849`: 10, 34, 35,
  36-preview, 36-theme PASS; **44 FAIL**; 90-perf-stream FAIL (known-bug, not
  counted). No second simulator and no full 2-sim gate.
- Full `bun run check`: not run (the orchestrator's script runs it).
- No changelog fragment, per orchestrator decision 4. The spawn brief's generic
  line asks for one; the orchestrator decides.

## Review
