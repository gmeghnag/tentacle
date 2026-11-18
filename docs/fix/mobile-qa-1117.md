# fix/mobile-qa-1117 — the six bugs of the 2026-11-17 simulator QA

> **Status:** execution (review pending)
> **Branch:** `fix/mobile-qa-1117`
> **Type:** fix · **Size:** M · **Blast:** cross-module · **Suited:** Opus exec + Opus review WITH screenshots
> **Changelog:** `changelog.d/mobile-qa-1117.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-18*

The simulator QA of main @ 680b4b8b (`.tentacle/tmp/mobile-qa-1117/REPORT.md`,
shots in `shots/`) found 10 OK · 6 BUG · 0 BLOCKER. The six bugs:

1. **hub-opacity band** (report rows 2+3) — the slider thumb is `palette.page`:
   white on the white light band (only a gap in the rail shows), #1E1F21 on
   #242528 in dark; and the preview's sample text is test jargon ("The relay
   answers, but the first ping arrives after the 5 s the test allows…").
2. **Tool rows after reopen** (row 8) — re-entering a session, both Thought rows
   vanish and the two failed steps (`ls missing-dir`, `browser_resize`) turn
   green. Pre-existing? (to check).
3. **model-diagrams** (rows 11+12) — a full-screen diagram opened in light stays
   light after a switch to dark while it is open; the `outline | filled` setting
   the owner decided (docs/feat/model-diagrams.md, owner answers Q1, 2026-11-17
   09:40) is not in Settings.
4. **harness-notices** (row 13) — another device's compaction shows the literal
   `_the conversation was compacted on another device_`; after a reopen the
   summary is a USER bubble and there is no compaction separator.
5. **Queue consumed → view** (row 15) — after a queued steer is consumed, the last
   reply sits half under the composer (to check against today's merged
   `fix/mobile-queued-stuck`).

**Repro (BEFORE, this branch's base f5e73d5f, own simulator iPhone 17 Pro Max
0B43D716…, iOS 26, Release, `bun apps/mobile/e2e/run.ts --ios 26 --udid … --only
29-tool-rows --hold`, serve on a free port picked by the harness, hand-driven with
Maestro; shots in `.tentacle/tmp/mobile-qa-1117/fix-shots/`):**

- Bug 2: `02-reopen-live-reference.png` (live: two Thought rows, two red steps) vs
  `02-reopen-before.png` (drawer → Alpha → back to `compose`: no Thought, all four
  steps green). `git log -S "any other error flag is not stored"` → b6de7529
  (`mobile-session-view-12b`): **pre-existing** since the first transcript fold.
  The TUI's `resume.ts:141` carries the same sentence: the stored `ChatMessage`
  has no error flag and no reasoning at all.
- Bug 5: `05-queue-queued-before.png` — during the HOLD turn with a steer queued,
  the list is NOT at its end (the HOLD bubble and its reply are under the Queued
  panel) while it is still following (no "Jump to latest" pill).
  `05-queue-consumed-before.png` — on this run the end after consumption was
  right: the symptom is a race (the QA's `05-queue-consumed-qa-before.png` caught
  it after consumption). Not fixed by `fix/mobile-queued-stuck`.
- Bugs 1, 3, 4: no file they touch changed between 680b4b8b and f5e73d5f
  (`git diff --stat 680b4b8b..HEAD` lists only compose/hub/queue files), so the
  QA's own shots are the BEFORE: `01-hub-opacity-{light,dark}-before.png`,
  `03-diagram-full-switch-before.png`, `04-compaction-{live,reopen}-before.png`.

## Implementation

*— claude-opus-5-5, 2026-11-18*

### Load-bearing assumption

Bug 2 stands on: **the projection cannot draw what the history does not store.**
`ChatMessage` (`packages/core/src/model.ts:31`) has no error flag; the agent's
`toolMessage` (`packages/agent/src/agent.ts:275`) drops `result.isError`; both
projections then guess `"ok"` (`apps/mobile/src/transcript-history.ts`,
`packages/tui/src/resume.ts:141`). So the fix is to STORE the flag, not to infer it
from the text.

### Preconditions

- Fields are free (AGENTS §7, protocol v10): `ChatMessageSchema` is a strip
  schema (`packages/protocol/src/session.ts:143`); a display-only field rides
  fail-soft (`note`, `media`, `compacted` precedent), so no `PROTOCOL_VERSION`
  note is needed.
- The checkpoint digest (`canonicalMessage`, `packages/protocol/src/session-log.ts:570`)
  lists its fields explicitly; `note`/`media`/`compacted` are outside it, so a new
  display-only field leaves every stored checkpoint valid.
- `compactionOf` / `compactionSeparatorText` are in core
  (`packages/core/src/compaction-view.ts`) precisely so mobile shares the TUI's
  wording (harness-notices Q6: one wording whatever device compacted).
- A notice row on the phone is plain text (`TranscriptRow.tsx` `NoticeRowView`):
  `_…_` is shown as typed.

### Design

1. **Bug 1** — the thumb is `palette.accentFill` (≥ 3:1 against the band in both
   schemes) with `shadowOpacity: palette.shadowOpacity` (`shadow.glass` carries
   none, so iOS drew no shadow). The sample is `PREVIEW_SAMPLE` in `hub-opacity.ts`.
2. **Bug 2** — `isError?: true` on the tool `ChatMessage` (core type, agent
   `toolMessage`, protocol schema fail-soft, `protocol.json`), read by both
   projections: mobile `historyRows` (`denied` still wins), TUI `messagesToItems`.
   **Thought rows: PARKED** — reasoning text is not in `ChatMessage`; storing it
   means persisting every round's reasoning in every log, snapshot and phone page
   (size, and the model's private reasoning on disk) and changing the agent
   loop's message assembly — a load-bearing persisted-format decision for the
   owner, not a projection fix. The TUI does not show reasoning on resume either.
3. **Bug 3** — full screens are presented `overFullScreen`
   (`FULL_SCREEN_PRESENTATION`, shared by chart and diagram): with `fullScreen`
   iOS removes the presenting view from the window, stops its trait updates, and
   the root `useColorScheme` keeps the old scheme until the modal closes. The
   setting: `diagram-settings-store.ts` (`{v:1, style}` behind `SecureKV`, the
   activity-settings rules) + `diagram-settings-expo.ts`; `diagramThemeVariables(
   palette, style)` (filled = slot-1 tint fills, slot-1 borders/edges/messages,
   edge labels on the page); the style joins the render key (`diagramCacheKey`,
   outline keeps its old key); `DiagramRowView` gets it from `SessionScreen`
   (reads the holder live, like the Activity button) and `DiagramBlock` puts the
   caption below for filled. A "Diagrams" band in Settings (Outline / Filled).
4. **Bug 4** — one `compactionSeparatorRow` in `transcript-history.ts`, used by
   the reload (`historyRows`, a compaction summary → separator, no brief: the
   TUI keeps it behind Ctrl+O and a phone notice has no expand) AND by the live
   foreign compaction (`transcript.ts` `applyHistory`). The other phone notices
   lose their `_…_`. `FOREIGN_COMPACTED_NOTICE` is gone (no foreign variant, Q6).
5. **Bug 5** — `follow.ts` `settleStep`: once the sizes have gone quiet
   (`SETTLE_MS` = 450 ms after the last content/viewport change, past RN's
   ~300 ms animated scroll), a list that is following but not within
   `SETTLE_SLACK_PT` of its true end is scrolled there. `SessionScreen` tracks the
   real offset from `onScroll` and re-arms the timer after every
   `contentGrew`/`viewportChanged` step; a drag skips it.

### Files

core `model.ts` → agent `agent.ts` → protocol `session.ts` (+ `schema/protocol.json`
via `bun run schema:export`) → tui `resume.ts` → mobile: `hub-opacity.ts`,
`ui/HubOpacityBand.tsx`, `transcript-history.ts`, `transcript.ts`,
`diagram-settings-store.ts` (new), `diagram-settings-expo.ts` (new),
`diagram-theme.ts`, `diagram-cache.ts`, `diagram-row.ts`,
`ui/diagram/DiagramBlock.tsx`, `ui/diagram/DiagramFullScreen.tsx`,
`ui/chart/ChartFullScreen.tsx`, `screens/transcript/TranscriptRow.tsx`,
`screens/SettingsScreen.tsx`, `screens/SessionScreen.tsx`, `follow.ts`, `App.tsx`.

### Failure modes

- Older daemon / older log (no `isError`): the step reloads green, as before —
  never a refusal. A malformed `isError` is dropped (fail-soft), the message loads.
- An older client meeting `isError`: strip schema drops it.
- A compaction whose history carries no summary: separator `compacted` alone.
- Diagram setting: a newer build's record reads `outline` and is never written
  over (rows disabled, footnote says why); a failed write keeps the pick for the
  run and shows a banner.
- Settle: never moves a list the person scrolled up (`following` false), never
  fires during a drag, and re-checks only after the sizes stop changing (no
  fight with an animation in flight). Content shorter than the viewport → nothing.

### Tests

- `packages/agent/test/tool-error-history.test.ts` — the stored tool message
  carries `isError: true` on a failed call, none on a success.
- `packages/protocol/test/permission-reply.test.ts` — the schema keeps it; a bad
  value is dropped, the message still parses.
- `packages/daemon/test/persistence.test.ts` — it survives a `serve` restart.
- `packages/tui/test/resume.test.ts` — a stored failure resumes as `error`.
- `apps/mobile/test/transcript-reload.test.ts` — live = reload for a failed step
  and for a compaction (live foreign + reopen + legacy summary); no notice is
  `_…_`.
- `apps/mobile/test/diagram-style.test.ts` — store rules, filled variables,
  render key, Settings/App/SessionScreen wiring, `overFullScreen` on both full
  screens.
- `apps/mobile/test/hub-opacity-band-look.test.ts` — thumb colour + contrast +
  shadow opacity; the sample constant without jargon.
- `apps/mobile/test/follow.test.ts` (`settleStep`) and
  `session-screen-follow-wiring.test.ts` (the re-arm and the offset).

## Execution

*— claude-opus-5-5, 2026-11-18*

| # | Bug | Root cause (file:line) | Fix | Test (red → green) | Shots (fix-shots/) |
|---|---|---|---|---|---|
| 1 | Thumb invisible; jargon preview | `ui/HubOpacityBand.tsx:209` thumb `backgroundColor: palette.page`, `shadow.glass` with no `shadowOpacity`; copy hard-coded at `:239` | accent-fill thumb + shadow opacity; `PREVIEW_SAMPLE` | `hub-opacity-band-look.test.ts` | `01-hub-opacity-{light,dark}-{before,after}` |
| 2 | Reopen: failed steps green | the stored tool message has no error flag: `agent.ts:275` `toolMessage` drops `isError`; both projections guess `ok` (`transcript-history.ts`, `tui/resume.ts:141`) — pre-existing since b6de7529 | `isError?: true` stored (core/agent/protocol) and projected (mobile + TUI). **Thought rows PARKED** (see Design 2) | `tool-error-history`, `permission-reply`, `persistence`, `resume`, `transcript-reload` | `02-reopen-live-reference`, `02-reopen-{before,after}` |
| 3a | Full screen ignores light↔dark | `DiagramFullScreen.tsx:62` (and `ChartFullScreen.tsx:87`) `presentationStyle="fullScreen"`: the presenting view leaves the window, no trait change reaches the root `useColorScheme` | `FULL_SCREEN_PRESENTATION = "overFullScreen"` | `diagram-style.test.ts` (wiring) | `03-diagram-full-switch-{before,after}`, `03-diagram-full-light-after` |
| 3b | outline\|filled setting missing | never built (model-diagrams D6/D7 deferred it) | store + holder + theme + render key + Settings band + SessionScreen wiring | `diagram-style.test.ts` | `03-settings-diagrams-after`, `03-diagram-inline-outline-after`, `03-diagram-inline-filled-{light,dark}-after` |
| 4 | Foreign compaction `_…_`; no separator after reopen | `transcript.ts:170` markdown in a plain-text notice; `transcript-history.ts` `historyRows` has no compaction branch (summary → user row) | `compactionSeparatorRow`, live and reload; plain-text notices | `transcript-reload.test.ts`, `transcript.test.ts` | `04-compaction-{live,reopen}-{before,after}` |
| 5 | Last reply under the composer | a scroll-to-end issued in the frame of a layout change lands at the native view's OLD end (`SessionScreen.tsx` `onContentSize`/`onListLayout` → `perform`), `following` stays true, nothing corrects it | `follow.ts` `settleStep` + `SessionScreen` settle timer | `follow.test.ts`, `session-screen-follow-wiring.test.ts` | `05-queue-{queued,consumed}-before`, `05-queue-consumed-qa-before`, `05-queue-{queued,consumed}-after` |

**Bug 5 evidence (device trace).** A temporary `console.error("FTRACE …")` in the
follow path (removed before the gate; `console.log` does not reach the unified log
in a Release build) on the diagnostic build, `log stream` on the simulator:

```
FTRACE content c=1006.33 v=753.33
FTRACE perform to=253.00 anim=true f=true c=1006.33 v=753.33
FTRACE settle off=215.33 c=1006.33 v=753.33 step=253.00      ← asked 253, parked at 215 (38 pt short)
FTRACE perform to=253.00 anim=true f=true …
FTRACE scroll off=253 c=1006.33 v=753.33 drag=false f=true    ← the settle's scroll lands
FTRACE layout v=434.33 c=821
FTRACE settle off=73.67 c=821 v=434.33 step=386.67            ← keyboard: asked 386, parked at 73
```

The same pattern on every viewport change (keyboard, Queued panel): the step's
target was right, the list did not get there; `following` stayed true.

**Mutation checks** (each reverted): agent drops `isError` → agent test red; TUI
resume ignores it → resume test red; schema field removed → protocol + daemon
tests red (2); mobile `historyRows` ignores it → 2 red; no compaction branch → 2
red; old `_…_` live notice → 1 red; filled = page fill → 2 red; key ignores style →
1 red; chart back to `fullScreen` → 1 red; thumb back to `palette.page` → 1 red.

**Drift from the plan, in order.**
- The first wiring read the diagram setting through a hook inside
  `TranscriptRow.tsx`; it pulled `expo-secure-store` into the row's import graph
  and broke two mock-based suites (`chart-view`, `step-thought-marker`: `__DEV__`
  undefined). Moved to `SessionScreen` (which already reads the Activity holder)
  → a `diagramStyle` prop. Guards updated: `pairing-guards` (a seventh Keychain
  wiring file), `band-screens` (ten Settings bands, "Diagrams").
- The filled look's first device render showed a teal patch behind edge labels
  (mermaid derives `edgeLabelBackground` from the translucent fill): added
  `edgeLabelBackground: palette.page`, red → green.
- The first full `bun test` failed one golden (`parallel-tools.test.ts`: the
  refused call's message now carries `isError: true` — the intended change). It
  also showed one path that bypassed `toolMessage`: a call answered
  "Cancelled by the user before this tool ran" (`agent.ts`, the `signal?.aborted`
  branch) pushed its own message without the flag while its live result had it.
  It now builds ONE result for the event and the history (`toolMessage`); the
  goldens in `parallel-tools.test.ts` / `agent.test.ts` (whose `observe` helper
  asserts "the message mirrors the event") were updated; mutation (restore the
  hand-built push) → 3 red. Not touched: `prune.ts`'s repair answers for orphaned
  calls — they have no live row to agree with.
- `bun run schema:export` regenerated `protocol.json` on the branch (the drift
  test fails otherwise; earlier feat branches did the same).
- Builds: BEFORE (f5e73d5f); a diagnostic build (fixes 1–4 + trace); one with the
  bug-5 fix + trace (the trace above, and `05-*-after`); the final builds
  without the trace (all other AFTER shots).

**Gate (final tree):** `bunx tsc --noEmit` clean · `bunx tsc -p apps/mobile
--noEmit` clean · `bun run lint` clean (2053 files, 0 errors/warnings) ·
`bun test`: **14929 pass · 5 skip · 0 fail** (14934 tests, 1070 files; the skips
are the env-gated opt-ins — live k8s/docker, the slow socket test — none in a
file this task touched).

**Unverified:** iOS 18 (only the iOS 26 simulator ran); Thought rows after a
reopen stay missing (PARKED, needs an owner decision on persisting reasoning).

## Review

*— claude-opus-5-5, 2026-11-18* (fresh context, SAME model as the executor: shared blind spots possible)

**Verdict: APPROVE** — no HIGH/MEDIUM finding. Screenshots not re-inspected; code + tests only.

**Gate (narrow + static):** touched suites (agent ×3, protocol permission-reply + json-schema,
daemon persistence, tui resume, all `apps/mobile/test`) **3492 pass · 0 fail**; `bun run lint`
clean (2053 files); `bun run typecheck` clean (root + mobile + relay). Full `bun test` not re-run.

**Premises:** `toolMessage` dropped `isError` (TRUE, diff of `agent.ts:275`); `ChatMessageSchema` is
the session log's message schema (`session-log.ts:45`), so the laptop log, the `serve` log and the
wire all carry the field with no extra mapping (TRUE); `canonicalMessage` (`session-log.ts:570`)
does not list it, so checkpoints stay valid (TRUE); no provider spreads a `ChatMessage`
(`rg '\.\.\.(m|msg|message)\b' packages/providers/src` → none), so the flag never reaches a model API (TRUE).

**Mutations (each reverted, `git status` clean after):** `settleStep` without its `following`
guard → follow.test red; settle timer without the drag skip → wiring test red; TUI resume
ignores `isError` → resume test red; live foreign compaction built from `[]` → transcript-reload red.

**Attacks tried:** (1) §7 pod not trusted: a pod could set `isError` on a message, but it only
changes how the step looks (red or green), with no effect on the laptop: OK. (2) Protocol: strip field with
`.catch(undefined)`, no `PROTOCOL_VERSION` note needed (it is shown only, and an older peer
drops it): OK. (3) Settle loop: the timer is armed only by content/viewport changes, never by its
own scroll, so it cannot keep re-arming itself: OK. (4) `overFullScreen`: both modals have an opaque `palette.page` root,
so nothing shows through: OK. (5) Cancelled path now goes through `toolMessage`, so its history
message matches the live event: OK.

**Non-blocking notes:** `App.tsx` comment still names a `useDiagramStyle` hook that no longer
exists (it moved to `SessionScreen`). A compaction this phone caused itself (`own === true`, e.g.
an auto-compaction inside its own turn) still shows no separator live, but does after a reopen.
This live/reload gap is older than this branch and outside the six bugs.

**Executor behaviour:** honest. Every change from the plan is listed with its reason, the mutation claims
reproduced, and Thought rows are clearly marked PARKED rather than half-done.
