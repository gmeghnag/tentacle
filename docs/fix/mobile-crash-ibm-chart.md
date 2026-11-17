# fix/mobile-crash-ibm-chart — iPhone app crashes (and crash-loops) on a session with a chart

> **Status:** context · implementation (executor: repro FIRST, then plan in Implementation, then fix — pre-approved, orchestrator 2026-11-17)
> **Branch:** `fix/mobile-crash-ibm-chart`
> **Size:** S–M · **Blast:** cross-module (mobile transcript) · **Suited:** Opus exec + fresh Opus review
> **Changelog:** `changelog.d/mobile-crash-ibm-chart.fixed.md`

## Context

Owner 2026-11-17 ~08:50, iOS build of main 32dcf4fb (published 08:47; includes mobile-tool-rows C S1–S3, open-at-end + row swipe, session-actions, model-charts C8, model-artifacts, hub H4b): "l'app ha crashato mentre stava lavorando sul graficarmi i valori azionari di IBM dell'ultimo mese".

Evidence (`.tentacle/tmp/ios-crash-ibm/` (copy in `.tentacle/tmp/mobile-crash-ibm-chart/`)):
- 3 crash reports from the owner's iPhone, 08:50:43 / 08:50:54 / 08:51:00 → it crashes AGAIN on every relaunch (deterministic on that session's state). All: `EXC_CRASH SIGABRT`, `abort() called`, `lastExceptionBacktrace` = `objc_exception_throw` from the app binary on a dispatch queue — the React Native release-mode fatal path for an unhandled **JS exception** (RCTFatal), not a native crash. Frames unsymbolicated.
- `session.jsonl`: the serve daemon's log of that session (copied from `~/.config/tentacle/daemon/orchestration-43c37b40c7e5/949a98d0-….jsonl`). The turn finished fine daemon-side (turn_end 08:50:44). Its last turn: 3 `shell` calls, a **`replace` entry (critical, index 21 — a tool result replaced)**, then a `chart` tool call (line, 1 series × 21, title with an em dash), the chart result, the final assistant text, `usage` entries (new, non-critical, from token-usage-log).

Suspects to TEST, not assume: the new tool-steps view-model (mobile-tool-rows) on a `replace` of a tool message / a chart between steps; the chart row inside a step thread; open-at-end scroll on a row whose height changes; `usage` entries reaching the mobile mapping.

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Executor: AGENTS §1 — reproduce FIRST: feed this exact `session.jsonl` (and the live update sequence that produced it: the `replace` arrives as a `session/update` while the turn runs) through the app's pure modules (transcript/mapping/transcript-rows/tool-steps/chart parsing) in a test or a `.tentacle/tmp/mobile-crash-ibm-chart/` repro until it throws. Then: root cause in one sentence, minimal fix, regression test red→green, and a guard so ONE bad row can never take the whole app down (render-level error boundary around a transcript row that shows a small "couldn't display this item" row instead — the app must not crash-loop on reopening a session). Write the plan here before the fix.

### Plan (executor, written after the repro attempts below)

**Repro result — the throw does NOT reproduce off-device.** Three empirical categories, all run on this exact `session.jsonl` (scripts + output in Execution):
1. *Pure pipeline* — `projectEntry` (the `replace` at 21 projects cleanly: 25 messages, `[21]` a tool) → `historyRows` → `stepLayout(rows, false, isBlockRow)` → `stepRowView` per tool row → `chartRowView` for both charts: no throw, both charts lay out.
2. *Render tree* — `ChartView` walked (the `chart-view.test.ts` harness) for both charts, `it-IT` and `en-US`: no bare string outside `<Text>`/`<SvgText>`, no non-finite number prop, no `NaN`/`Infinity`/`undefined` in a path/string prop.
3. *Intl diff* — `Intl` instrumented, the call sets of the fine chart (`Bug del polpo`, category x, no unit) and the IBM chart compared. Only the IBM chart calls: `DateTimeFormat({day,month:"short",timeZone:undefined}).format` (x `type:"date"`, `core/chart/format.ts:144`), `NumberFormat({min=max=2 fraction, useGrouping}).format` (`y.decimals:2`) and `NumberFormat({style:"currency",currency:"EUR"}).formatToParts` (`y.unit:"$"` → `currencyFirst`, `format.ts:84`).

Bun's Intl is complete; the phone runs Hermes with Apple's Intl, which this worktree cannot run (only `hermes-compiler` is installed, no VM). The app has no JS error handler or boundary (`rg setGlobalHandler|ErrorBoundary|componentDidCatch apps/mobile` → nothing), so the exception's text was lost with the abort. **Root cause: UNVERIFIED.** Leading candidate: one of the three Intl calls above throws under Hermes-iOS (engine-dependent, and the only behavioural difference between the chart that rendered and the one that crashed, 55 s apart on the same build). Not fixed speculatively.

**Load-bearing assumption:** an uncaught error thrown while React renders (or runs an effect of) a row reaches RN's fatal handler and aborts the release app (matches the 3 reports: `abort()` via `objc_exception_throw`), and a React error boundary above the row catches exactly that class (render, lifecycle and effects of descendants; not event handlers/async callbacks).

**Design (the approved guard):**
- `apps/mobile/src/row-guard.ts` (pure): `ROW_FALLBACK_TEXT` and `rowErrorFields(kind, error)` → `{ source: "row", row: kind, ...errorShape(error) }` — the error CLASS only, never its message (app-log F16).
- `apps/mobile/src/screens/transcript/RowGuard.tsx`: a class boundary importing only `react` (testable without RN mocks): `getDerivedStateFromError` → `{ failed: true }`; `componentDidCatch` → `props.onError?.(error)`; `render` → `props.fallback` when failed, else `children`. Once failed it stays failed for that row (no reset → no throw/log loop on every update).
- `TranscriptRow.tsx`: `RowFallback({ palette })` — a footnote row "_couldn't display this item_" in the notice style.
- `SessionScreen.tsx` renderItem: the returned `<SwipeTime>…<TranscriptRow/></SwipeTime>` is wrapped in `<RowGuard fallback={<RowFallback/>} onError={…}>`; new optional prop `onRowError?: (fields) => void`.
- `App.tsx`: `onRowError={(fields) => APP_LOG.log("error", "client-error", fields)}` — so the next such failure leaves its class (`RangeError`/`TypeError`) in the exported log, which decides the Intl hypothesis.

**Failure modes:** a row that throws on every render → fallback, logged once (componentDidCatch runs once per catch; failed state sticks). Throw inside `ChartBlock`'s effects → caught (descendant). Throw in an event handler / async callback / native (react-native-svg ObjC) → NOT caught — out of this guard's reach, stated as debt. A throw in `SessionScreen` itself (e.g. `stepLayout` memo) → not caught; repro 1 shows it does not throw on this session.

**Tests:** `row-guard.test.ts` — the boundary's contract (state from error, fallback vs children, `onError` receives the error, fields carry the class and never the message); red first against a stub that always renders children. `row-guard-wiring` (source) — renderItem wraps the row in `RowGuard` with `RowFallback`, App wires `onRowError` to `APP_LOG`; red on current code.

**Debt:** the root cause (verify on device: export the app log after reproducing; or a Hermes-iOS probe of the three Intl calls). Harmless hardening left out on purpose (it would hide the evidence the log is now set up to catch): omit `timeZone: undefined` in `formatDate`, try/catch `currencyFirst`.

*— claude-opus-5-5 (executor), 2026-11-17*

## Execution

**Load-bearing check.** The doc carried no pre-written check; the plan's own one ("the throw reproduces through the pure modules") was run first and **failed** — recorded above under *Repro result*, the plan written accordingly (guard + diagnostics, root cause left unverified). Repro scripts (in `.tentacle/tmp/mobile-crash-ibm-chart/`, gitignored), outputs verbatim:

- `pipeline.ts` (`projectEntry` → `historyRows` → `stepLayout(…, isBlockRow)` → `stepRowView` + `chartRowView`, locale `it-IT`):
  ```
  messages: 25 msg[21] role: tool
  rows: 19 user,tool,assistant,user,assistant,user,tool,assistant,user,tool,assistant,user,tool,assistant,tool,assistant,tool,tool,assistant
  cells: 5
  k9 chart ok step: object chart: yes      (Bug del polpo)
  k17 chart ok step: object chart: yes     (IBM; the 3 shell rows k12/k14/k16 before it: ok)
  ```
- `render.test.ts` (ChartView walked; bare strings outside Text/SvgText, non-finite numbers, `NaN|Infinity|undefined` in string props): `clean` for both charts × `it-IT`/`en-US`.
- `intl-diff.ts` (Intl instrumented; calls only the IBM chart makes):
  ```
  DateTimeFormat(day=numeric,month=short,timeZone=UNDEF).format
  NumberFormat(maximumFractionDigits=2,minimumFractionDigits=2,useGrouping=true).format
  NumberFormat(currency=EUR,style=currency).formatToParts
  ```
  (in both: `NumberFormat(maximumFractionDigits=1,minimumFractionDigits=1).format`).

**As built (plan order):**
1. `apps/mobile/src/row-guard.ts` (new) — `ROW_FALLBACK_TEXT`, `rowErrorFields(kind, error)` (`errorShape`: class + numeric code, never the message).
2. `apps/mobile/src/screens/transcript/RowGuard.tsx` (new) — class boundary, `react` only. Red first: a stub that always rendered children → `row-guard.test.ts` 4 fail on `expect(typeof derive).toBe("function")` / fallback assertions; then the real boundary → 9/9.
3. `TranscriptRow.tsx` — `RowFallback({ palette })` (footnote, notice style + italic, `testID="row-fallback"`).
4. `SessionScreen.tsx` — `onRowError?` prop; `renderItem` returns `<RowGuard fallback={<RowFallback palette={palette} />} onError={(error) => onRowError?.(rowErrorFields(item.kind, error))}>` around `<SwipeTime>…<TranscriptRow/></SwipeTime>`.
5. `App.tsx` — `onRowError={(fields) => APP_LOG.log("error", "client-error", fields)}`.
6. `row-guard-wiring.test.ts` (source) — red 4/4 on the unguarded code, green after 4–5.
7. `changelog.d/mobile-crash-ibm-chart.fixed.md`.

**Drift from the plan:** the fallback text is plain (`couldn't display this item`, italic by style) instead of `_…_`: notice rows render their text raw in `<Text>`, so underscores would show literally.

**Mutations (each reverted):**
- M1 `componentDidCatch` no longer calls `onError` → `row-guard.test.ts` 1 fail ("the caught error reaches onError").
- M2 `rowErrorFields` adds the error message → 2 fail ("row kind + error class", "the message never reaches a field").
- (The stub of step 2 is M0: no boundary → 4 fail; the unguarded `SessionScreen`/`App` → wiring 4 fail.)

**Gate:** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile` clean · `bun run lint` clean (1970 files, no fixes) · `bun test` 14369 pass / 0 fail / 5 skip (AGENTS §6 says 3 opt-in skips; none of the 5 is in this branch's files — the reviewer should confirm they predate it). No schema change (protocol.json untouched).

**Unverified:** the root cause, and that the boundary catches *this* crash (it catches it if the throw is in a row's render/effects, which the evidence fits but does not prove). Verify on device: open that session with this build — expect the fallback row in place of the IBM chart and a `client-error {source:"row", row:"tool", error:<Class>}` entry in the exported app log; the class decides the Intl hypothesis.

*— claude-opus-5-5 (executor), 2026-11-17*

### Fix round 1

Against Review round 1 (2 MEDIUM, no HIGH).

**Finding 2 (MEDIUM): a failed row never recovered. FIXED.**
- `RowGuard.tsx`: new optional `resetKey` prop. `state.resetKey` starts from props. `getDerivedStateFromProps` clears `failed` only when `resetKey !==` the stored key; with the same key the row stays failed (no throw/log loop).
- `SessionScreen.tsx` (`renderItem`): `resetKey={item}`.
- Why the row object is the right key: `transcript.ts` keeps unchanged rows by identity and makes a new object only for a row whose content changed. Repro `identity.ts`:
  ```
  history rows kept identity across stream: [ true, false ]   ← the user row kept; the assistant row the delta extended is new
  streaming row same object after a delta (expect false): false
  ```
- Red first: `row-guard.test.ts` "a failed row recovers when its row changes (resetKey)" failed on the old guard (`Expected: <Row id="fixed" />  Received: <Fallback id="fallback" />`, 10 pass / 1 fail), then passed after the fix.
- Real-reconciler trace `e2e-reset.ts` (Ink/React 18 driving the real `RowGuard.tsx`):
  ```
  1 throw: "row-1\nFALLBACK\nrow-3" onError 1
  2 same key re-render: "row-1\nFALLBACK\nrow-3" onError 1 new throws 0
  3 new key, valid content: "row-1\nok\nrow-3" onError 1
  ```

**Finding 1 (MEDIUM): the artifact viewer's chart was unguarded. FIXED.**
- `ArtifactViewerModal.tsx`: `ChartFullScreen` is now wrapped in `RowGuard`, with `resetKey={phase.text}` (a new version retries).
- Its fallback is viewer-sized: centred `ROW_FALLBACK_TEXT`, `testID="artifact-chart-error"`.
- On error it calls `onRenderError?.(rowErrorFields("artifact-chart", error))`. That is a new optional prop, passed through `ArtifactGallery.tsx` to `App.tsx`, which does `APP_LOG.log("error", "client-error", fields)`. It is the same ONE log, and it records the class only.
- Red first: the new wiring test failed on the unguarded viewer (`row-guard-wiring.test.ts`: 5 pass / 1 fail, on the `toMatch` assertion).
- Drift: none of substance. The wiring regexes had to match the gallery's spread form (`onRenderError: props.onRenderError`), and the first match had to be the JSX tag, not the import.
- Debt (as the reviewer noted): the gallery thumbnail (`ArtifactGallery.tsx`, `chartThumbView` in a promise callback) rejects rather than aborting. It is not guarded here.

**Mutations** (`mutate.ts`: apply, run both row-guard test files, restore; ends with 17 pass / 0 fail):
| Mutation | Caught by |
|---|---|
| M3 `getDerivedStateFromProps` never resets | "recovers when its row changes" (1 fail) |
| M4 resets on every render | "same row (same resetKey) stays failed" (1 fail) |
| M5 `resetKey={item}` removed from `SessionScreen` | wiring "retries when its row object changes" (1 fail) |
| M6 `App` drops `onRenderError` | wiring "artifact viewer … guarded" (1 fail) |
| M7 viewer's `<RowGuard>` replaced by `<View>` | wiring "artifact viewer … guarded" (1 fail) |

**Gate:**
- `bun run typecheck` clean (root + mobile + relay).
- `bun run lint`: 1970 files, no fixes.
- `bun test`: 14373 pass / 5 skip / 0 fail.
- The 5 skips are not in this branch's files (`rg skip apps/mobile/test/row-guard*` finds nothing). The difference from AGENTS §6's "3" is still for the orchestrator to confirm on `main`.

*— claude-opus-5-5 (executor, fix round 1), 2026-11-17*

## Review

**Verdict: REQUEST-CHANGES** (2 MEDIUM, no HIGH).

1. **MEDIUM — the same suspected chart throw has a second, unguarded path.** `apps/mobile/src/screens/artifacts/ArtifactViewerModal.tsx:175` mounts `ChartFullScreen`, which runs `fullScreenKpis` + `chartRowView` (all the Intl formatting: `ChartFullScreen.tsx:252-261`) in render, with no boundary above it. Scenario: the owner opens the IBM chart from the artifact gallery → the same throw → the same release-mode abort. The Context's goal is "one bad item can never take the app down"; this is another path to the same state (brief: "another path"). Fix: wrap it in `RowGuard` (with a viewer-sized fallback and the same `client-error` log), and add it to the wiring test. (The gallery thumbnail, `ArtifactGallery.tsx:126`, runs in a promise callback, so it rejects rather than aborting. Out of scope, but it should be noted as debt.)
2. **MEDIUM — once a row fails, it shows the fallback even after its content becomes renderable.** `RowGuard.tsx:25-37` never resets, and FlatList keys rows by `row.key` (`SessionScreen.tsx:863`), so the instance survives a content change. Shown end-to-end (below): after a re-render with valid children, the frame still reads `FALLBACK`. Scenario: a streaming assistant row, or a tool row whose result is later swapped by a `replace` (exactly this session's log), throws once on a transient state. It then stays "couldn't display this item" for the rest of the screen's life, although its final content would render. Fix: reset `failed` when `row` identity changes (e.g. `getDerivedStateFromProps` with a `resetKey={item}`). This still rules out a loop: a re-render with the same input stays failed. Add a test for it.

**Gate (reviewer-run):** touched tests `row-guard.test.ts` + `row-guard-wiring.test.ts` 13 pass / 0 fail; `bun run lint` clean (1970 files); `bun run typecheck` clean (root + mobile + relay). Full `bun test` not re-run by me; the executor's 5 skips vs the 3 in AGENTS §6 are still unconfirmed.

**Mutation:** `getDerivedStateFromError` changed to return `{failed:false}` → `row-guard.test.ts` 2 fail; reverted, `git status` clean.

**Premise table:**
| Premise | Result |
|---|---|
| Charts render inside `TranscriptRow`, so they are a descendant of the guard (`TranscriptRow.tsx:347-358`) | TRUE |
| `keyExtractor` uses `row.key` (`SessionScreen.tsx:863`) | TRUE |
| No pre-existing boundary in the app | TRUE (taken from the doc's `rg`; consistent with the code I read) |
| Root cause (Intl under Hermes-iOS) | UNVERIFIED, as the doc says. I did not reproduce it either. |

**Attacks tried:**
- (a) Real-reconciler trace (`.tentacle/tmp/mobile-crash-ibm-chart/e2e-guard.ts`: Ink/React 18 driving the actual `RowGuard.tsx`). A throwing child gives `"row-1\nFALLBACK\nrow-3"`, `onError` is called once with `RangeError`, and the sibling rows survive. **Holds.** Re-rendering with valid children still gives `FALLBACK`, which is finding 2.
- (b) Other chart render sites: finding 1. `ChartBlock`'s own `ChartFullScreen` is a descendant of the guard, so it is covered.
- (c) Logic outside the guard in `renderItem` / the `stepLayout` memo: still unguarded. The repro shows no throw on this session; acceptable as stated debt.
- (d) Privacy: `rowErrorFields` keeps the error class only (the test pins this). **Holds.**

**Executor behaviour:** honest. It followed repro-first, recorded that the repro did not reproduce, and did not apply a speculative fix. The plan is clear, and red→green plus mutations are recorded. The tests drive the class methods by hand, not through a reconciler; my trace (a) closes that gap.

*Same model family as the executor (fresh context only): shared blind spots are possible.*

*— claude-opus-5-5, 2026-11-17*

### Round 2

**Verdict: APPROVE** (diff `HEAD~1`, commit 139708c2). Both round-1 findings are fixed; no new HIGH or MEDIUM.

1. **R1-1 (artifact viewer unguarded) — fixed.** `ArtifactViewerModal.tsx:182-204` now wraps `ChartFullScreen` in `RowGuard`, with `resetKey={phase.text}`, a viewer-sized fallback, and `rowErrorFields("artifact-chart", …)`. That reaches `APP_LOG` "client-error" through `ArtifactGallery.tsx:319` → `App.tsx:2253`. Mutation: removing the viewer's `onError` → the wiring test fails (1 fail); reverted.
2. **R1-2 (fallback never resets) — fixed.** `RowGuard.tsx:31-36` uses `getDerivedStateFromProps` to reset `failed` when `resetKey !==` the stored key. `SessionScreen.tsx:893` passes `resetKey={item}`. Mutations:
   - never resetting → "recovers when its row changes" fails;
   - resetting on every render (the loop) → "same resetKey stays failed" fails.
   Both reverted.
3. **Real-reconciler trace** (`.tentacle/tmp/mobile-crash-ibm-chart/e2e-reset.ts`, Ink/React 18 driving the actual `RowGuard.tsx`):
   - same key, re-rendered twice → `FALLBACK`, **0 extra throws, 1 log**;
   - new key with fixed content → `ok`;
   - new key with broken content → `FALLBACK`, 2 logs.
   React applies `getDerivedStateFromProps` on the error re-render without clearing the failure, so there is no loop.
4. **Regression check, row identity:** `SessionScreen.tsx:512` `rows = state.view.rows` ← `session-screen-controller.ts:818` `transcript.rows`, and `transcript.ts:201/211` appends with spread, which keeps unchanged row objects. So `resetKey={item}` retries only when a row's content changes, or once per full replace (resync, `/clear`). That is bounded and not per update.

**Gate (reviewer-run):** `row-guard.test.ts` + `row-guard-wiring.test.ts` 17 pass / 0 fail. `bun run lint` clean (1970 files). `bun run typecheck` clean. `git status` clean after every mutation. Full `bun test` not re-run.

**Still open (debt, not blocking):** the root cause (Intl under Hermes-iOS) is unverified. The next on-device failure will log its error class. The gallery thumbnail's promise path (`ArtifactGallery.tsx:126`) is unguarded, but it rejects rather than aborting the app.

*— claude-opus-5-5, 2026-11-17*
