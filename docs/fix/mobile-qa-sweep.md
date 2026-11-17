# fix/mobile-qa-sweep — live simulator QA of everything merged 16–17/11, and fix what is broken

> **Status:** context · implementation (executor: sweep FIRST, list every defect with a screenshot, then fix — pre-approved, orchestrator 2026-11-17)
> **Branch:** `fix/mobile-qa-sweep`
> **Size:** M–L (split fixes into commits per defect) · **Blast:** cross-module (apps/mobile) · **Suited:** Opus exec + fresh Opus review WITH the screenshots
> **Changelog:** `changelog.d/mobile-qa-sweep.fixed.md`

## Context

Owner 2026-11-17 09:14, on the iOS build of main 32dcf4fb: "sembra che qui i test dall'app emulata non li abbia fatti nessuno". True: the night's slices were reviewed on code + unit tests; most simulator checks were skipped ("pixels unverified"). Already found by the owner:
1. **Artifacts gallery**: the close ✕ sits ON the status-bar clock (top-left, no safe-area inset) — `.tentacle/tmp/mobile-qa-sweep/owner-artifacts.png`.
2. **HTML artifact viewer**: opening "Pagina HTML minimale" (HTML page · 567 B) shows only "Couldn't keep this file" (`apps/mobile/src/screens/artifacts/ArtifactViewerModal.tsx:189`); the viewer also opens as a half sheet under the gallery.
3. Hub long-press dead / no haptics / no glyph / Activity "Scheduled · soon" → being fixed in `fix/mobile-hub-longpress-dead` (do NOT touch hub files; just re-check at the end and note).
4. App crash-loop on a session with a chart → being fixed in `fix/mobile-crash-ibm-chart` (do not touch; re-check at the end).


**Orchestrator addendum (09:33, owner):** the ∴ glyph beside "Thought" (and the ∴ marker on tool rows) is too small — "anche un filo più grandi" (owner screenshot `/Users/gmeghnag/Desktop/Screenshot 2026-11-17 at 09.31.19.png`, light mode). Make it a bit larger (≈ 12–13 pt instead of 10, centred on the thread line, the dots still thin), same change on the row marker; screenshot before/after in light + dark.


**Orchestrator addendum (09:36, owner pick):** the running turn's live "Thinking…" node (today a static hollow ring) becomes mockup **B + D** (`.tentacle/mockups/mobile-thinking-anim/index.html`): the ∴ glyph (new larger size, above) with its three dots breathing in sequence (top → right → left, ~1.5 s, accent) AND the shimmer sweep across the word "Thinking…" (~2.2 s). When a tool starts the node becomes the tool's spinner row and the ∴ stays as the small static marker on that row; Reduce Motion → static ∴ in accent + plain grey word. Use Reanimated/Animated on the native driver (no JS-thread timers per frame); a real-screen render test + simulator screenshots/video frames.


**Orchestrator addendum (09:45):** fix/mobile-crash-ibm-chart merged (b7bba9f4) with a per-row error boundary, but its **root cause is UNVERIFIED** (no Hermes VM off-device). The simulator runs Hermes with Apple's Intl, so: replay the IBM chart (`.tentacle/tmp/mobile-crash-ibm-chart/session.jsonl`; chart args: line, x type date, y decimals 2, unit "$") in the simulator, confirm whether one of the three Intl calls in `docs/fix/mobile-crash-ibm-chart.md` (DateTimeFormat with `timeZone: undefined`, NumberFormat 2-decimals grouping, currency formatToParts) throws under Hermes-iOS, then fix the cause (the chart must render, not just fall back) with a regression test, and record the verified cause in that doc's Review or here.

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Executor (Opus):
- **Simulator**: use your OWN simulator, `iPhone 17 Pro Max` (UDID 0B43D716-9670-421A-BE51-9162004F2963) — other agents use the booted iPhone 17 Pro. Build the app as the e2e harness does (`apps/mobile/e2e/README.md`, `run.ts`, mock model `mock-model.ts`, Maestro flows in `e2e/flows`) against a local daemon you start on a FREE port (never port 4000: that is the owner's live serve).
- **Sweep FIRST** (before any fix): exercise every user-visible feature merged since 2026-11-16 — tool rows variant C (rows, ∴, expand, error, running, long command), charts inline + full screen + gallery/hub entry, artifacts of every kind (HTML, image, PDF, Markdown) from the row AND from the gallery, open-at-end on open/reopen/foreground + row swipe timestamps, session drawer long-press (rename/delete/pin, pinned first), PDF attach/view, the `diagram` tool's row (D2: generic row today), the composer + header basics. Light AND dark. For each: screenshot to `.tentacle/tmp/mobile-qa-sweep/shots/<nn>-<what>.png` and a row in a table here under `### Sweep results` (feature · expected · seen · OK/BUG · screenshot).
- **Fix** every BUG in this branch's scope (not hub, not the chart crash): root cause in one sentence, red→green regression test (pure test where possible, plus a Maestro flow or real-screen render for UI ones), re-screenshot after. A bug too big for here → a `TODO.md`-ready line in `### Follow-ups` (do not edit TODO.md).
- Gate: `bunx tsc --noEmit`, `bunx tsc -p apps/mobile --noEmit`, `bun run lint`, the mobile tests; full `bun test` once at the end.

## Execution

**Status: PARTIAL.** Owner bugs 1 and 2 are fixed with red→green tests. The live
simulator sweep was **NOT run**: starting the harness (`bun apps/mobile/e2e/run.ts`)
was refused by the session's permission gate (no approval available), so there
are no `shots/`, no `### Sweep results` table, no re-screenshot after the fixes,
and no re-check of bugs 3 and 4.

### Harness prep (for the sweep, unused so far)
- `apps/mobile/e2e/run.ts` (device pick + after the flow loop): `E2E_DEVICE=<udid>`
  pins the simulator (the harness otherwise takes the FIRST iOS-26 device, which is
  the other agents' booted iPhone 17 Pro); `E2E_HOLD=1` keeps serve, the mock and
  the hooks up after the flows until Ctrl+C, for a hand-driven sweep.
- `apps/mobile/e2e/mock-model.ts` `callDirectives`: a prompt line
  `CALL <tool> <json>` makes the round call that tool with those arguments (any
  `present`/`chart`/`diagram`/`shell` row on demand, without a new constant per flow).
- Intended command (not run):
  `E2E_DEVICE=0B43D716-9670-421A-BE51-9162004F2963 E2E_HOLD=1 bun apps/mobile/e2e/run.ts --ios 26 --only 01-shell`.

### Bug 2: HTML artifact shows "Couldn't keep this file"
- **Root cause:** the viewer read sets `fileUri: ""` for every TEXT kind (html, svg,
  markdown, text: decoded, never cached), and the modal tested `phase.fileUri === ""`
  ("too big to keep") BEFORE the html/markdown branches, so every text artifact hit
  the error.
- **Fix:** the branching moved to a pure `viewerBody(phase, viewer, target)` in
  `apps/mobile/src/artifact-open.ts` (AGENTS §7); `too-big` now applies only to the
  file kinds (image, pdf). `ArtifactViewerModal.tsx` only maps `body` to elements.
- **Red** (`viewerBody` extracted with the buggy order unchanged, modal wired to it,
  before the fix): `apps/mobile/test/artifact-open.test.ts`
  `Expected: "webview" Received: "too-big"` (1 fail). Green after the one-condition fix.
- Pin: `artifact-viewers-wiring.test.ts`: the modal calls `viewerBody(phase,
  choice.kind, target)` and has no `fileUri === ""` or `choice.kind === …` branch.
  The existing chart pin in `artifact-gallery-wiring.test.ts` moved from
  `choice.kind === "chart"` to `body === "chart"`.

### Bug 1: gallery ✕ on the status-bar clock; viewer opens as a half sheet
- **Root cause (✕):** `ArtifactGallery` is a full-screen stack screen
  (`App.tsx` `name="ArtifactGallery"`, `headerShown: false`, no `presentation`),
  but it passed `insetTop={false}` to `ScreenHeader`, which is only meant for sheets.
  **Fix:** the prop is removed.
- **Root cause (half sheet):** the gallery mounts `ArtifactViewerModal` as a plain
  sibling of its list, and the viewer's root was `flex: 1`, so it shared the column
  with the list. **Fix:** the root is absolutely positioned over the whole host
  (`position: "absolute"`, all edges 0, `zIndex: 1`); `ViewerHeader` already adds
  `insets.top`.
- Tests (`artifact-gallery-wiring.test.ts`): (a) the gallery passes
  `insetTop={false}` iff its route is a sheet presentation; (b) the viewer root is
  absolutely positioned. (b) was **red** on `root: { flex: 1 }` before the fix.
  (a) was **mutation-checked**: putting `insetTop={false}` back → 1 fail; reverted.
- These are source pins (`.tsx` cannot be imported from Bun). The pixels are
  unverified until the simulator sweep runs.

### Mutations
| target | mutation | result |
|---|---|---|
| `viewerBody` | buggy order (`fileUri === ""` → too-big for every kind) | red: `Expected "webview" Received "too-big"` |
| gallery header | re-add `insetTop={false}` | red: "the gallery header takes the top inset…" |
| viewer root | `flex: 1` (pre-fix) | red: "the artifact viewer covers the whole screen…" |

### Drift from Implementation
- "Sweep FIRST" could not be done, because the harness launch was refused. The fixes
  for the two owner-reported bugs went ahead on the owner's screenshot as evidence.
- A row card's tap opens the gallery, not the artifact itself
  (`SessionScreen.tsx` `onArtifact: (meta) => onOpenArtifacts("card")`: `meta` is
  ignored). Noted only, not changed; the sweep should decide whether this is a bug.

### Follow-ups
- Run the sweep (command above), fill `### Sweep results`, and re-screenshot
  bugs 1–2 in light and dark; re-check bugs 3 (hub) and 4 (chart crash).

### Gate
`bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile --noEmit` clean ·
`bun run lint` clean (1966 files) · `bun test apps/mobile` 2934 pass / 0 fail ·
full `bun test`: 14361 pass / 5 skip / **1 fail**. The fail is
`packages/daemon/test/session-log-store.test.ts:815` (fork T4, `forkTemps` 2 vs 1),
in a package this branch does not touch (`git diff -- packages` is empty). That file
alone passes 43/43, so it looks like a timing flake under full-suite load. The
skip count is 5, against the 3 opt-in skips in AGENTS §6; not investigated.

*— claude-opus-5-5 (executor), 2026-11-17*

### Fix round 1
Only `apps/mobile/test/artifact-gallery-wiring.test.ts` changed. No production code changed.
- **R1 (inset pin vacuous) — FIXED.** The test slices `App.tsx` from
  `name="ArtifactGallery"` to `<ArtifactGalleryScreen`, so it gets the whole
  `options={({ route }) => …}` arrow. Before, it cut at the arrow's `>`. It also asserts that the
  slice holds `options=`.
- **R2 (chart-bytes pin vacuous) — FIXED.** `toContain("phase.text")` is replaced by
  two pins: `const text = ready?.text ?? "";` and a match for
  `<ChartFullScreen … tool={{ name: "chart", args: text, status: "ok" }}`.
- **R3 (sweep not run) — NOT FIXED.** The permission gate refused
  `E2E_DEVICE=0B43D716-… bun apps/mobile/e2e/run.ts --ios 26 --only 01-shell` again.
  There are still no `shots/` and no `### Sweep results`. Bugs 1–2 have no pixel
  check, and bugs 3–4 have not been re-checked. Someone with harness approval must run it.

Red → green. Each mutation is applied to the source, then reverted from a backup
copy in `.tentacle/tmp/mobile-qa-sweep/`. "Old test" means the HEAD version of the test file:
| mutation | old test | new test |
|---|---|---|
| M1: `App.tsx` gallery options gets `presentation: "modal"` | 9 pass / 0 fail (vacuous) | **1 fail**: "the gallery header takes the top inset unless the route is a sheet", `Expected: true Received: false` |
| M2: modal `args: text` → `args: ""` | 9 pass / 0 fail (vacuous) | **1 fail**: "a chart artifact OPENS as the full-screen chart…" |
| M3: modal `args: text` → `args: failedText` | — | **1 fail**: same test |
| restored | — | 9 pass / 0 fail |

Gate: `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile --noEmit` clean ·
`bun run lint` clean (1966 files). The formatter fix came from `biome check --write` on the
test. Full `bun test`: 14362 pass / 5 skip / 0 fail. The round-0 daemon flake did not recur.
The 5 skips are the same as in round 0 and were not investigated.

*— claude-opus-5-5 (executor, fix round 1), 2026-11-17*

## Review

**Verdict: REQUEST-CHANGES.**

Gate (re-run): the 3 touched test files pass 30/0 · `bun run lint` is clean (1966 files) · `bun run typecheck` is clean (root, mobile, relay). I did not re-run the full `bun test`.

Findings (MEDIUM):
1. **The test that pins the inset is vacuous in its "sheet" branch.** `apps/mobile/test/artifact-gallery-wiring.test.ts:134` slices `App.tsx` from `options=` up to the first `>`. That `>` is the arrow `=>` in `options={({ route }) => (…)` at `App.tsx:2235`, so the slice never contains `presentation` and `sheet` is always false. The test therefore only pins "`insetTop={false}` never appears". It does not pin the "iff the route is a sheet" that the Execution claims. Scenario: someone later presents the gallery as `presentation: "modal"`. The test still demands an inset, so the ✕ gets a double top gap, and the claimed guard stays silent.
2. **The D6 chart-bytes pin is now vacuous.** `artifact-gallery-wiring.test.ts:113` still asserts `toContain("phase.text")`. After the refactor, the only `phase.text` in the modal is the **failed** text (`ArtifactViewerModal.tsx:134`). The chart now receives `args: text` (`:183`). Scenario: change the chart's args to `""` or to `failedText`, and every chart artifact renders nothing, with all tests green. The pin should match `args: text` or the `ready?.text` source.
3. **The task's primary deliverable is missing.** There was no simulator sweep: no `shots/`, no `### Sweep results` table, and no re-check of bugs 3 and 4. The fixes for bug 1 (the overlay and the inset) are source pins only, and their pixels are unverified. The fix is correct on paper, but the task cannot close as `fix/mobile-qa-sweep` until the sweep runs.

Premises: TRUE — a text kind's read sets `fileUri: ""` (`ArtifactViewerModal.tsx:104`), and the old order hit too-big first. TRUE — `svg` maps to `webview` (`artifact-viewer.ts:50`), so it is covered by the fix. TRUE — the gallery route has no `presentation` (`App.tsx:2235`). TRUE — the modal is mounted only by the gallery (`ArtifactGallery.tsx:306`), and that host root is `flex: 1` with no padding, so the absolute overlay covers it.

Mutations: I could not run them, because the session's permission gate refused the mutation script. Findings 1–2 are proved by reading the source, which settles them: the slice's end index and the single `phase.text` occurrence. The executor's M3 (`viewerBody`'s buggy order → red) is consistent with `artifact-open.test.ts:115`.

Attacks tried: (a) other hosts of the absolute-root modal: none, holds. (b) svg/markdown/text reaching too-big: none, holds. (c) `share`/`none` before the file check: pinned, holds. (d) `E2E_HOLD` SIGINT vs the `finally` teardown: the `once` listener resolves into the normal teardown, holds (e2e only). (e) `CALL` directives re-firing on the follow-up round: guarded by `followUp`, holds. No §7 invariant is touched (mobile UI plus the e2e harness only).

Executor behaviour: honest. It marked the task PARTIAL, stated what was unverified, and kept the business logic in a pure module (§7). The two weak pins above are its §9 lapses.

*— claude-opus-5-5, 2026-11-17* (fresh context, same model family as the executor: shared blind spots possible)

### Round 2

**Verdict: REQUEST-CHANGES** (the code is fine; finding 3 remains).

- **Finding 1: FIXED, verified by mutation.** I added `presentation: "modal"` to the gallery route's options at `App.tsx:2235`. The new test at `artifact-gallery-wiring.test.ts:136` then fails ("the gallery header takes the top inset unless the route is a sheet"). Reverted.
- **Finding 2: FIXED, verified by mutation.** I changed the chart's `args: text` to `args: failedText` at `ArtifactViewerModal.tsx:183`. The chart test then fails ("a chart artifact OPENS as the full-screen chart…"). Reverted. The two mutations ran together and gave 2 fail / 7 pass, one fail for each pin.
- **Finding 3: STILL OPEN.** There is no simulator sweep, no `shots/` and no `### Sweep results`. The pixels for bugs 1–2 are unverified, and bugs 3–4 have not been re-checked. The executor cannot close this without approval to run the harness. The owner or the orchestrator must run `E2E_DEVICE=0B43D716-9670-421A-BE51-9162004F2963 E2E_HOLD=1 bun apps/mobile/e2e/run.ts --ios 26 --only 01-shell`, or explicitly accept the task without the sweep.
- **Regressions in this round's diff:** none. The diff touches tests only. After the reverts the tree is unchanged (`git status` is empty). The 3 touched test files pass 30/0, `bun run lint` is clean (1966 files), and `bun run typecheck` is clean (root, mobile, relay).
- **Not yet done:** the orchestrator addenda added in this commit (09:33 ∴ size, 09:36 Thinking animation, 09:45 IBM chart cause) have no implementation on this branch yet. They are scope still owed by the task, not defects in this diff.

*— claude-opus-5-5, 2026-11-17* (fresh context, same model family as the executor)
