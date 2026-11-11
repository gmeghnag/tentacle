# fix/connect-functest-batch — the `connect` functional-test bugs (A, B, C, E; F verified)

> **Status:** execution (awaiting the orchestrator's fresh-context Review)
> **Branch:** `fix/connect-functest-batch`
> **Type: fix · Size: M · Blast: cross-module · Suited: DeepSeek exec**

## Context

*— deepseek (tentacle --profile deepseek), 2026-11-11*

The orchestrator's functional tests on `.17` (`tentacle connect` → `serve`, report
`.tentacle/tmp/functest/report.md`, 2026-11-10 evening) found five defects on the
`connect` path that no local-only test caught. Item D (the input rule's model
name) was fixed separately in `460e93a`; this task is A, B, C, E and the
verification of F.

| Item | Seen live |
|---|---|
| **A** (M) | A finished background shell job's drawer reads `✗ stopped` instead of `✗ exited (3)`, and its duration keeps counting (26 s → 32 s) — under `connect` only. |
| **B** (S) | The pill reads `0 agents · 1 shell`. |
| **C** (S–M) | After `/compact`, the session title in `/sessions` is the summary text (`Summary of the earlier conversation (compacted to save context): …`) — it also hit the owner's own session. |
| **E** (S) | `/clear` under `connect` shows no confirmation, and the ctx meter keeps the cleared chat's figure until the next turn. |
| **F** (verify) | An ended child's open drawer head allegedly stayed `running · 26s` for ~2 min — the same feed as A (a child's exit rides `jobs.onExit`), see Execution 6. |

**Why they slipped:** every one of them lives in what the runtime HANDS the TUI,
and `connect` (`packages/cli/src/connect.ts`) builds its own `RemoteClient` and
its own option set, while `run`/`attach` hand `jobs: runtime.jobs`. A test that
fakes a `SessionController` (or mounts `App` with a fake `jobs`) exercises
neither. So the rule this task follows is the owner's: **the repro and the
regression test run on the REAL `serve` + `connect` + `App` stack** —
`packages/tui/test/connect-functest-stack.tsx` is that harness, and the item
tests are `connect-functest-{a,b,c,e,f}.test.tsx`.

**Repro** (all five tests, run from the worktree root; they are the repro — on
the unfixed code each asserts the buggy observable):

```
$ bun test packages/tui/test/connect-functest-a.test.tsx
--- the drawer's head, job exited (exit 3) 6 s into its life ---
Expected to contain: "exited (3)"
Received: "✗ stopped · 6s"
(fail) A: a finished shell job's drawer shows its exit code, and its clock freezes

$ bun test packages/tui/test/connect-functest-b.test.tsx
Expected: not "0 agents"
Received: "… ⏵⏵ auto-accept on  · 0 agents · 1 shell ↓"
(fail) B (stack): a shell alone makes the pill read `1 shell`, never `0 agents`
Expected: "1 shell ↓"   Received: "0 agents · 1 shell ↓"      (B, pure)

$ bun test packages/tui/test/connect-functest-c.test.tsx
Expected to contain: "fix the login bug"
Received: "Summary of the earlier conversation (compacted to save context): the gist of it"
(fail) C: after /compact the title is the original message, never the summary

$ bun test packages/tui/test/connect-functest-e.test.tsx
Expected to contain: "Cleared"       (no confirmation at all on the frame)
(fail) E: /clear confirms itself and refreshes the ctx meter
  (and, once the notice existed, the meter assertion still failed:
   Expected: not "~2.3k/128k)" — the cleared chat's figure stayed.)
```

## Implementation

*— deepseek (tentacle --profile deepseek), 2026-11-11*

### Load-bearing assumption

**The TUI's ONE job-exit feed is `JobController.onExit`, and `connect` passed
none.** `App.tsx:1036-1063` (the effect on `jobs`) is the ONLY place a shell
job's outcome and `endedAt` are stamped (`jobOutcome({… endedAt: Date.now()})`,
then `dockOutcomeRef`, `applyLateOutcome`, `dockFinishedRef`). It returns
immediately when `jobs` is undefined (`App.tsx:1036-1038`). `run`/`attach` pass
`jobs: runtime.jobs` (`packages/cli/src/main.ts:1048`, `:1842`);
`connectTui`'s option object (`packages/cli/src/connect.ts:222-243`) had no
`jobs` at all — while `createLocalRuntime` (the SAME client) builds
`jobs: remoteJobsView(client)` (`local-runtime.ts:900`). That asymmetry is the
whole of item A: the drawer freezes on the `{kind:"stopped"}` fallback
(`App.tsx:1574`) and `jobElapsedSeconds` measures to `now` because the record
carries no `endedAt` (`job-drawer.ts:132-133`).

### Preconditions (verified)

- `JobController` is an interface; `remoteJobsView` (`local-runtime.ts:173-196`)
  is a client-side view whose only live capability is `onExit` →
  `client.onBackgroundExit`, and `RemoteClient` has that listener already (the
  daemon emits `background_exit` BEFORE the `jobs` frame, `hosted-session.ts:690-710`).
- `connect`'s TUI must NOT wake: the `serve` daemon owns that, per its own
  host's `autoWake` (`docs/feat/serve-autowake.md`, `serve.ts:216-219`). `autoWakeOnJobExit`
  defaults to `true` in the App (`App.tsx:603`), so feeding `jobs` without
  pinning it would start a SECOND continuation — the invariant
  `packages/cli/test/connect.test.ts` ("a `serve` daemon is the only waker") pins.
- The session title is the DAEMON's (`docs/feat/session-titles.md`), derived from
  the first user message (`agent/src/session-store.ts:74-80`), and an `auto`
  title is re-derived on EVERY read (`session-title.ts:43-45`
  `titleText`, `:1583` `wireTitle`, `:1439` `summary`).
- A compaction replaces the history's head with a `role:"user"` summary
  (`agent/src/compact.ts:277`), so that summary becomes `messages.find(user)` —
  the derived title's input. `HostedSession.historyReplaced` already notices it
  by identity (`compactionSummary`, `hosted-session.ts:2754`).
- The measured ctx fill (`DisplayState.lastTurnTokens.prompt`) OUTRANKS the
  daemon's count at open (`status-view.ts:28-37` `contextShown`), so it is what
  the meter shows until another `usage` replaces it — the reason it went stale.

### Design

**A.** Export the existing `remoteJobsView` and pass it from `connect` with
`autoWakeOnJobExit: false`. One source of truth (the daemon's exit frames), one
view for every RPC runtime, no second wake.

**B.** `pillView` builds its counts by KIND, skipping a kind with nothing
running: `1 shell`, `1 agent`, `2 agents · 1 shell`.

**C.** An `auto` title may now carry `text` — the name the conversation HAD.
`HostedSession.persist()` pins it (`pinAutoTitle`) once the history holds a
first real user message; `titleText`/`encodeTitle`/`sessionTitle` use the pin
when present. Two supporting changes make the pin survive a round trip:
`recordTitleState` reads a plain string as `{source:"auto", text}` (it already
IS the name — re-deriving it was the bug), and `seedState` accepts a string. The
`(empty)` sentinel is not pinned (a session with no visible message must still
name itself at its first prompt). `/clear` drops the pin, so a fresh chat names
itself. The on-disk shape is unchanged (an auto title stays a plain string), so
no version bump.

**E.** `CLEARED_NOTICE` for this TUI's own `/clear` (another device's already had
`CLEARED_ELSEWHERE_NOTICE`), and on a replaced history
(`cleared || action === "replace"`) the measured fill is dropped
(`forgetContextFill`) and the daemon asked to count the current history
(`askContext`, `session/context`).

**F.** Verified, not fixed: see Execution.

### Files

- `packages/cli/src/local-runtime.ts` — export `remoteJobsView`.
- `packages/cli/src/connect.ts` — pass `jobs` + `autoWakeOnJobExit: false`.
- `packages/tui/src/status-view.ts` — B's counts.
- `packages/agent/src/session-store.ts` — `TitleState.auto.text`, `encodeTitle`,
  `recordTitleState`, `EMPTY_TITLE`.
- `packages/daemon/src/session-title.ts` — `titleText`, `seedState` (string).
- `packages/daemon/src/hosted-session.ts` — `pinAutoTitle` (in `persist`), drop
  the pin on `/clear`.
- `packages/daemon/src/session-host.ts` — `restore` seeds the record's title.
- `packages/tui/src/clear-command.ts`, `src/state.ts` (`forgetContextFill`),
  `src/App.tsx` (the notice, the meter refresh, `askContext` hoisted above its
  first use).
- Tests: `packages/tui/test/connect-functest-stack.tsx` (harness) +
  `-a/-b/-c/-e/-f.test.tsx`; three existing contract tests updated (see Drift).
- `CHANGELOG.md` — `[Unreleased] → Fixed`.

### Failure modes

- **A**: an older daemon sends no `background_exit`? Then the drawer never had an
  outcome locally either (the same view is all there is) — no new silence. A TUI
  that attaches after the exit: the client's backlog replays it
  (`EXIT_BACKLOG_MAX`, `remote-client.ts:1667-1675`), and the notice dedupes by id.
- **A/wake**: `autoWakeOnJobExit: false` on `connect` — a `serve` host with
  `autoWake: false` is no longer overridden by an attached TUI, and a host with it
  on still wakes once (verified: `probe11`/`probe13`, 3 turns with it on, 2 off).
- **B**: nothing running still yields NO pill (`total <= 0` unchanged).
- **C**: a model/user rename still wins (`applyGenerated`/`applyRename`), a
  record's `(empty)` still derives, a `/clear` resets, and a session that had no
  visible message before its first compaction keeps deriving (nothing pinned).
- **E**: another device's clear keeps its own notice; a `/compact` (also a
  `replace`) now refreshes the meter too — the same staleness, same fix.

### Tests

Each item test asserts the property that kills its bug, on the real stack, and
was RED before its fix (see Execution). One mutation per A, C, E confirms
non-vacuity (`§9`).

## Execution

*— deepseek (tentacle --profile deepseek), 2026-11-11*

Worktree `.tentacle/worktrees/connect-functest` (this task's branch),
`bun install --filter '!@tentacle/mobile'` to give it its own `node_modules`.
Scratch (probes) in `.tentacle/tmp/connect-functest/`, none of it kept.

1. **Harness first.** `connect-functest-stack.tsx`: a real `startDaemon` over a
   Bun-served OpenAI-compatible endpoint, the real `connectTui`, the real `App`
   through `renderAt` on a real 120×30 terminal, driven through
   `options.createSession`/`options.sessions` exactly as `connect` builds them.
   Two harness facts cost a round each and are worth recording: the endpoint also
   receives the ctx meter's `POST /apply-template` count, which is NOT a turn
   (numbering every request slid each scripted turn by one), and a parent's and a
   child's model calls RACE, so a child's round must be scripted by its content,
   never by arrival order.
2. **A red, then fixed.** `connect-functest-a.test.tsx` printed
   `✗ stopped · 6s` on the unfixed `connect.ts`; after passing
   `jobs: remoteJobsView(client)` + `autoWakeOnJobExit: false` it prints
   `✗ exited (3) · 6s`, frozen 2 s later. Checked empirically that the wake
   invariant holds: with the daemon's `autoWake` on, 3 turns (prompt, end, wake);
   with it off, 2 (no TUI-started continuation) — `probe11`/`probe13`.
3. **B red, then fixed** (pure + stack). `0 agents · 1 shell` → `1 shell`.
4. **C red, then fixed.** The stack test first proved the history really was
   compacted (a later request carries the summary), then showed the title flip.
   Fixed by pinning the derived title in the daemon (`pinAutoTitle`), with the
   round-trip (`recordTitleState`/`seedState`) so a `serve` restart keeps it.
5. **E red twice, then fixed.** First the missing confirmation, then (with the
   notice in) the stale meter — `Expected: not "~2.3k/128k)"`. The endpoint had
   to report `usage` for the meter to have a measured figure at all
   (`sayWithUsage`), which is also why the original report's figure was stale
   rather than absent.
6. **F: the same bug as A, not a separate one.** A child's exit rides the SAME
   `jobs.onExit` feed (its `job.agent` says which), so with `connect` passing no
   `jobs` a child's open drawer froze on the `stopped` fallback (`✗ stopped`)
   rather than the report's `running · 26s`; its head predicted the report's
   symptom for metadata-only rows. With A's fix the head goes
   `running · 0 tools · 0 · 2s` → `✓ finished · report sent to the agent`, frozen.
   *Not reproduced as a separate defect*: the child's row does update (the daemon's
   `subagents` frame is session-scoped, not the jobs view), so the ONLY stale-head
   mechanism found is A's. The test is kept as the pin: mutation (remove `jobs`
   from `connect.ts`) → `✗ stopped`.
7. **Mutations (§9, A/C/E).** A: remove `jobs` from `connect` → `✗ stopped · 6s`
   again. C: remove `this.pinAutoTitle()` from `persist` → the summary title
   again. E: remove `forgetContextFill` → the meter assertion fails again. Each
   restored immediately; all green afterwards.
8. **Gate.** `bunx tsc --noEmit` (the repo's own `tsc --noEmit` step) **clean**.
   `bun run lint` (`biome check .`) **clean, 0 errors 0 warnings** (§6 baseline).
   `bun test packages` → **6732 pass / 3 skip / 0 fail** (476 files); the 3 skips
   are the documented opt-ins (live-k8s, live-docker, the real-socket keepalive).
   One run showed `packages/exec/test/confinement.test.ts` F2 (a hard-link race)
   failing: it is unrelated to this task (nothing under `packages/exec` changed),
   passes on its own file, and passed in the immediately following full run —
   a flake, recorded here rather than hidden.
   The whole-repo `bun test` additionally runs `apps/mobile`, whose deps are
   absent here (`Cannot find module '@tentacle/client'`) — **so the mobile package
   was excluded and its suite was not run**, exactly as reported.
   `bun run typecheck` as a whole also type-checks `apps/mobile` and therefore
   prints its 47 missing-deps errors; the main project (`tsc --noEmit`) is clean,
   and `bun run typecheck`'s second step (`tsc -p apps/mobile`) is the one that
   cannot run without its deps.

**Drift from Implementation.**

- Three existing tests pinned the OLD contracts and had to change with them;
  each now pins the corrected property instead:
  1. `packages/cli/test/connect.test.ts` — "the connect TUI gets no wake input"
     asserted `jobs: undefined`. It now asserts `hasJobs: true` +
     `autoWakeOnJobExit: false` (the drawer's feed IS needed; the wake still is
     not), with the mutation named in the comment.
  2. `packages/agent/test/session-title-record.test.ts` — "a string title reads
     as auto" asserted `{source:"auto"}`. It now asserts the pinned
     `{source:"auto", text}` (that re-derivation was item C's root cause) and
     that `(empty)` still derives.
  3. `packages/daemon/test/session-list.test.ts` (H3) — a restored record with
     `title: "t"` and a different first message listed `"an old question"`. It
     now lists `"an old name"`: the record's own title IS the name.
- `askContext` had to move above `onActivity` (it is now a dependency of the
  history handler), and joined that `useCallback`'s dep list.
- The title pin is applied in `persist()` (the one synchronous point every
  history change passes through) rather than in `historyReplaced`: pinning at the
  replacement alone would miss a log that was already compacted when it was
  written by an older build. Same file, same test, no extra state.
- `packages/daemon/src/session-host.ts`'s `restore` needed one line
  (`renamed ?? record.title`, no longer `undefined` for a string title) — that
  is what made the H3 test above change, and it is required for the pin to
  survive a `serve` restart.
- F's harness needed a slow model round (`slowSay`) so a child is really running
  when its drawer opens; without it the child always ended first and the test
  proved nothing.

## Review

*— deepseek (tentacle --profile deepseek), 2026-11-11*

Not a fresh-context review (this is the implementation pass; the orchestrator's
Review follows). What was checked here, adversarially:

- **A's wake invariant is the one thing that could break silently.** Feeding
  `jobs` from `connect` is exactly what `docs/feat/serve-autowake.md` warns
  against, so it was measured, not argued: `autoWake: true` on the daemon → 3
  model turns (prompt, end, ONE wake); `autoWake: false` → 2 (no TUI-started
  continuation). The test that pinned "no wake input" now pins
  `hasJobs: true` + `autoWakeOnJobExit: false` instead of `jobs: undefined`, so a
  future removal of the flag is red.
- **C touches a §7 persistence-adjacent seam** (the title on disk). The on-disk
  SHAPE is unchanged — an auto title is still a plain string
  (`encodeTitle`), so no `schemaVersion`/`PROTOCOL_VERSION` bump is needed and an
  older build reads the file exactly as before. The state file's `title` stays
  `string | RecordTitle` (`titleProblem`, `daemon-state-file.ts:175-194`). What
  DID change is the meaning of a string (it is a name, not "derive again"), which
  is why `recordTitleState` and `seedState` moved with it; both are pinned.
- **The non-vacuity of A, C, E** was confirmed by mutation, each restored
  immediately (`✗ stopped · 6s` / the summary title / the stale meter came back).
  B's is the pure test itself (it asserts both halves, including the singular and
  plural forms and the notice prefix); F's is A's mutation.
- **Failure modes re-read**: an older daemon with no `background_exit` behaves as
  before; a `connect` TUI attaching after an exit reads the client's backlog and
  dedupes by job id; nothing running still yields no pill; a rename still wins
  over the pin, `(empty)` still derives, and `/clear` drops the pin (a fresh chat
  names itself); another device's `/clear` keeps its own notice.
- **Not verified / left**: the `apps/mobile` suite was not run (its deps are
  absent here — see the gate line), and item F's exact live symptom (`running ·
  26s`) could not be reproduced on this build beyond item A's mechanism. If a
  stale child head is ever seen again with item A fixed, the remaining suspect is
  the drawer's 1 Hz clock over a frozen row, not the exit feed.

**Result per item: A FIXED · B FIXED · C FIXED · E FIXED · F FIXED by A's fix
(NOT REPRODUCED as a separate defect).**
