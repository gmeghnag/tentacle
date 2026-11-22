# fix/tui-shell-row-collapsed — TUI shell rows: command + exit code only, output on ctrl+o

Type: fix · Size: S–M · Blast: contained (TUI rendering only, `packages/tui`) · Suited: DeepSeek exec + Opus review

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-22*

Owner, 2026-11-22 ~19:25 (TUI screenshot, `beta.compactShell: true`): collapsed shell rows show the command's OUTPUT under the sentence, while the owner wants the COMMAND there; and with ctrl+o the rows are misaligned (`  │ $ cmd` on its own row above the `⎿` block — the shape fix/tui-shell-row-uniform removed only from the collapsed view).

Repro on main e8a86068 (`transcriptRows`, width 80, a described ok `shell` call), SGR stripped:
```
compactShell=true  collapsed:  ● Sleep 5 secondi 5.0s / ⎿ dormito 5s, sveglio / "  riga 2"
compactShell=false collapsed:  ● Sleep 5 secondi 5.0s / ⎿ $ sleep 5; echo '…' / "  dormito 5s, sveglio"
either, expanded (ctrl+o):     ● Sleep 5 secondi 5.0s / "  │ $ sleep 5; echo '…'" / ⎿ dormito 5s, sveglio
```

Owner decisions (mockup `docs/fix/tui-shell-row-collapsed-mockup.html`, variant **B**, chosen 22/11 ~20:15, for BOTH views):

**Collapsed (no ctrl+o) — NO output ever, success or failure:**
```
● Container in esecuzione 0.2s
⎿ $ podman ps 2>&1; echo ---; docker ps 2>&1  exit=1

● Job in background di 8s da leggere dopo 0.0s
⎿ $ echo "partito in background"; sleep 8; echo "lavoro lungo terminato"

● Test dei componenti file 3.4s
⎿ $ cd apps/mobile && bun test src/ui/FileBody.test.tsx src/ui/CodeBloc…  exit=1
```
- `exit=N` only when N ≠ 0, at the END of the `$` line, two spaces after the command, error colour. The command is cut with `…` so `exit=N` ALWAYS fits on the row (the code is never cut).
- Rows WITHOUT a sentence: title only — `● Bash <command cut>  exit=N 0.4s` (exit after the command, before the duration); no body.

**Expanded (ctrl+o, or the row clicked — `expandedIds`):**
```
● Container in esecuzione 0.2s
⎿ $ podman ps 2>&1; echo ---; docker ps 2>&1  exit=1
  Cannot connect to Podman. Please verify your connection to the Linux system
  ---
  Cannot connect to the Docker daemon at unix:///var/run/docker.sock.

● Bash 0.4s
⎿ $ podman ps --format '{{.Names}} {{.Status}}' 2>&1; echo ---; docker ps --form
    at '{{.Names}}' 2>&1  exit=125
  Cannot connect to Podman. Please verify your connection to the Linux system
```
- The `$` line opens the `⎿` block (no `  │ ` rows anymore); the WHOLE command, wrapped at the width with continuation rows indented 4; `exit=N` (N ≠ 0) ends the LAST command row; output follows at col 2 (today's `toolBody` cut/expand rules for the output itself).
- A row without a sentence expands to `● Bash <elapsed>` + the same block (the command moves from the title into the block).

Constraints: TUI only — the phone (`apps/mobile`, `packages/core/src/shell-intent.ts` `shellRowParts`, which the app also uses) is NOT changed. The permission ask keeps the verbatim command (security rule of shell-intent-line — do not touch `permission-ui.ts`). Colour-blind owner: success = no `exit=` text; colour only reinforces. Other tools (Read/Edit/Write/…) unchanged.

`beta.compactShell`: owner OK to retire it. In the TUI it has no effect anymore (one shape). The config KEY stays valid (`packages/config/src/schema.ts:490` is `.strict()` — deleting it would reject configs that set it, the owner's included); update its `key-docs.ts` text to say it no longer changes the TUI. The phone's own setting (`apps/mobile/src/shell-rows-store.ts`) is untouched.

## Implementation

*— claude-opus-5-5 (orchestrator), 2026-11-22 — APPROVED by the owner (spec above, 22/11 ~20:15)*

**Load-bearing assumption:** every shell row (described or not) is drawn in `packages/tui/src/render-lines.ts` — described rows by `shellIntentLines` (`render-lines.ts:~1044`, reached at `:971-977` via `shellRowParts`), plain `Bash` rows by the generic branch (`:985-998`: `header` + `commandRows` when expanded + `toolBodyRows`). Verify first with the repro below; if a shell row is drawn elsewhere too, STOP and write it in Execution.

**Preconditions (verified on e8a86068):** `exit=N` is the first line of a shell `resultText` (`exit=0\n…`), and today's body already writes `exit=N` only for N ≠ 0 (`packages/tui/test/shell-intent-rows.test.ts` header comment). `expanded` = `opts.expandAll === true || isExpanded(opts.expandedIds ?? [], tool.id)` in both branches.

**Design:**
1. One TUI-local helper (in `render-lines.ts` or a small pure module next to it, e.g. `shell-row.ts`): from a shell `ToolItem` → `{ command, exitCode: number | null, outputLines }` (exit parsed from the `exit=N` first line; `null` while running/queued/denied/background start). Reuse the existing parsing if `toolBody` already has it — do not duplicate.
2. `dollarRows(command, exit, cols, expanded)`: collapsed → one row `⎿ $ <first line, cut so that "  exit=N" fits>  exit=N`; expanded → all command lines wrapped at `cols`, first on the connector, continuation rows indented 4, `  exit=N` appended to the last row (if it does not fit, it goes on its own continuation row — never cut).
3. `shellIntentLines`: always `header` + `dollarRows`; body ONLY when expanded (output lines at INDENT). Ignore `parts.commandRow`/compact in the TUI (pass `compact=false` to `shellRowParts` at `:973`).
4. Plain `shell` rows (`tool.name === "shell"`, no sentence): collapsed → title `● Bash <cmd cut>  exit=N <elapsed>` with NO body; expanded → `● Bash <elapsed>` + `dollarRows` + output. Non-shell tools: untouched.
5. Queued/running: `⎿ $ cmd` (no exit, no body) — as today minus the compact variant. Denied: keep today's denial text as the block's line under the `$` line (unchanged wording) — it is an outcome, not output. *Clarified in fix round 1 (review round 1 MEDIUM): only a case that never ran an outcome (a denial, its reply, a hook's reason, a spawn failure) keeps its body collapsed. A `run_in_background` START (`tools/src/builtins.ts:456`) has no `exit=` either but its note points at the job's OUTPUT, so it is output: collapsed it is the `$` row only.*
6. Remove `compactShell` from the TUI props path (`App.tsx`, `run.tsx`, `app-types.ts`, `render-lines.ts` options + row cache key `:1349/1412/1434`, `cli/main.ts:1434/2294`, `cli/connect.ts` `connectCompactShell` + its test) OR keep the plumbing and ignore it — executor's choice, smallest clean diff; update `config/src/key-docs.ts:1013` text. Keep the config schema key.
7. Click hit-testing (`tool-hit.ts`: header = row 0) must still toggle the row.

**Files:** `packages/tui/src/render-lines.ts` (+ optional new pure helper), `packages/tui/test/shell-intent-rows.test.ts`, `packages/tui/test/app-shell-intent.test.tsx` (if it asserts the old shapes), `packages/config/src/key-docs.ts`; plus the compactShell plumbing files only if removed (step 6).

**Failure modes → tests (red on e8a86068 first):** described ok collapsed (no output); described fail collapsed (`$ cmd  exit=1`, no output); long command + exit (cut with `…`, exit intact, row width ≤ cols); multi-line command collapsed (first line + `…`); expanded ok/fail (whole command, exit at end of last row, output at col 2, NO `│`); expanded long command wrap; exit that does not fit on the last row; plain Bash ok/fail collapsed (title only, exit before duration) and expanded (`● Bash 0.4s` + block); running, queued, denied, background start (no exit); `exit=124`/`exit=-1`; spilled output (expanded only); a row clicked via `expandedIds` behaves like ctrl+o; widths 40 and 190; the input row does not move (Ink seam test in `app-shell-intent.test.tsx`). Mutation: break the "no body when collapsed" check and the exit placement — tests must fail.

**Changelog:** `changelog.d/tui-shell-row-collapsed.changed.md` — one bullet.

## Execution

*— claude-sonnet-4-5, 2026-11-23*

**Load-bearing check (before any edit).** The Context repro ran on this branch
(`.tentacle/tmp/tui-shell-row-collapsed/repro.ts`, `transcriptRows`, width 80,
SGR stripped) and reproduced the report byte for byte: `compactShell=true` drew
`⎿ dormito 5s, sveglio` / `  riga 2` (the OUTPUT) under the sentence with no
command row; `compactShell=false` drew the command then the output; expanded
(ctrl+o) put `  │ $ sleep 5; …` on its own row ABOVE the `⎿` block. Both halves
of the bug are real, so the plan's premise held and I proceeded.

**As built, in the plan's order.**

1. **`packages/tui/src/shell-row.ts` (new, pure; Design step 1–2).**
   `shellRow(tool)` parses `{ command, exitCode }` ONCE for both views — `command`
   from `shellCommand(args)`, `exitCode` via the existing `shellExitCode`
   (reused, not duplicated) from `spill.head ?? resultText` and only when the call
   is settled. `exitSuffix` (`""` on 0/null), `exitTailWidth`, `dollarRoom`,
   `titleRoom` and `cutCommand` hold the room math so the cut can never eat the
   code; `DOLLAR_WIDTH`/`DOLLAR_HANG` are the block's 4-cell geometry.
2. **`dollarRows(row, cols, expanded)` (Design step 2).** Collapsed: one
   `⎿ $ <cmd cut to cols − 4 − tail>` row + `  exit=N`. Expanded: the WHOLE
   command, `expandTabs`, each line wrapped at `cols − 4`, line 1 on `⎿ $ ` and
   the rest on `DOLLAR_HANG`, the code appended to the LAST command row, or on its
   own hung row when it does not fit — never cut. A call with no command draws no
   `$` row at all (the body keeps its own connector), which is what keeps a
   resumed/argless call reading as before.
3. **`shellIntentLines` (Design step 3).** Always `header` + `shellBlock`; the
   call site passes `compact=false` to `shellRowParts` and `parts.commandRow` is
   no longer read at all. `shellBlock` shows the body only when EXPANDED, or when
   the call never produced a code (a denial, its reply, a hook's reason, a
   background start) — an outcome, not output (Design step 5).
4. **`plainShellLines` (new; Design step 4).** No sentence: collapsed
   `● Bash <cmd cut>  exit=N <elapsed>` with no block; expanded `● Bash <elapsed>`
   + the same `dollarRows` block + the output. `queuedToolRow` was extracted from
   the old inline generic branch so every branch draws a queued row the same way.
5. **`shellBodyText` now drops the `exit=` first line for BOTH codes** (was:
   only `exit=0`). Without this an expanded failure printed the code twice — once
   on its `$` row, once as the body's first line. This is a behaviour change the
   plan implied but did not spell out.
6. **Retired the beta (Design step 6, the "remove the plumbing" option).** Deleted
   `compactShell` from `RenderOptions` **and from the row-cache key** (it can no
   longer change a row, so keying on it would only throw layouts away),
   `App.tsx`, `run.tsx`, `app-types.ts`, `cli/main.ts` (2 sites), `connect.ts`
   (`connectCompactShell` + its option + the test file), and rewrote
   `key-docs.ts`'s `beta.compactShell` summary/details. The config KEY stays
   (`schema.ts` is `.strict()`), so a config that sets it still loads.
7. **`permission-ui.ts` untouched behaviourally** — only its comment, which cited
   the beta as the reason the ask must show the whole command; the reason is now
   this row's cut. `apps/mobile` and `packages/core/src/shell-intent.ts` untouched
   (`shellRowParts` keeps its `compact` parameter for the phone).

**Tests.** New `packages/tui/test/shell-row-collapsed.test.ts` (32 cases) carries
the whole failure-mode list from the plan: described ok/fail collapsed (no output),
long command + code (cut with `…`, code intact, width ≤ cols at 40/80/190),
multi-line command, expanded ok/fail/long-wrap/multi-line, the code on its own row,
clicked row = ctrl+o, spilled failure, denial, `exit=124`/`-1`, background start,
running/queued, plain `Bash` collapsed and expanded, a non-shell row untouched,
"the beta changes nothing", and widths 40/190. New
`packages/tui/test/app-shell-row-collapsed.test.tsx` pins both shapes at the Ink
seam (collapsed frame has no output; ctrl+o and a header click both open the block;
the input row does not move).

**Drift, and why.**

- **Mutation 4 (beta plumbed back) is no longer expressible**: `parts.commandRow`
  is not read by the renderer at all, so re-passing `true` changes nothing (I ran
  it: 47 pass, 0 fail). The beta's removal is therefore proven by the type (the
  option is gone) and by "one shape" tests, not by a mutation — recorded honestly
  rather than claimed.
- **`cutCommand` also expands the first line's trailing whitespace and cuts with
  `truncateCells`** rather than `fitSubtitle`: `fitSubtitle` flattens newlines, and
  the multi-line `…` had to be applied first.
- **Two test expectations of mine were arithmetically wrong** (not code bugs) and
  were fixed: the 40-column room for the code, and the `  │ ` → `⎿ $ ` join in the
  click-expand test.
- **Existing tests pinned the retired shape** and were updated to the new one,
  keeping their intent: `shell-intent-rows.test.ts` (rewritten),
  `render-lines.test.ts` (the spill body helper skips `⎿ $ ` rows too; the four
  shell expand tests now assert the block; a new test pins that a NON-shell call
  still expands to `  │ ` rows), `app.test.tsx` (the `cont()` helper and the
  blink view now read `⎿ $ `/4-cell rows), `tool-hit.test.ts` (the block's rows are
  not controls). `connect-compact-shell.test.ts` was deleted with the function.
- **Pre-existing failure, not mine**: `render-lines.test.ts > the shipped default
  is the text-only header` fails when run alongside `permission-shell-command.test.tsx`
  — reproduced on a pristine `git archive HEAD` copy in
  `.tentacle/tmp/tui-shell-row-collapsed/pristine` (135 pass / 1 fail there).
  Alone it passes.

**Mutations (red, pasted).**

1. Dropped the "no body when collapsed" guard in `shellBlock` → 13 fail
   (`collapsed: … NO output`, `no sentence: … NO body`, `widths 40 and 190: …`).
2. `const last = lines.length - 1` → `const last = 0` (the code ends the FIRST
   command row) → `expanded: … a long command wraps at the width, continuation
   rows indented 4` fails.
3. Moved the code after the duration in a plain row → 2 fail
   (`no sentence: … collapsed failure: ● Bash <cmd cut>  exit=N <elapsed>` and
   `no sentence: … running / ok / error / queued / expanded`).

All files restored after each mutation and re-run green (47 pass). `bunx biome
check` on the 17 changed files: clean.

**Gate.** Not run here (the orchestrator's script runs it). Locally: the touched
+ covering test files are green (237 pass) except the pre-existing header
interaction failure above; `bunx tsc --noEmit -p packages/tui` reports 21 errors
vs 38 on the pristine copy — all `@tentacle/protocol` resolution and none in the
lines I touched.

## Review

*— claude-sonnet-4-5 (gate round), 2026-11-23*

The orchestrator's gate ran `bun run check` on this branch and failed 8 tests.
Diagnosis and fix, one per failure — all of them test/codegen-side, no product
code changed in this round.

1. **Codegen drift (2 failures, one cause).** `scripts/test/mockup-kit.test.ts`
   "no drift" and `config/test/readme-config-table.test.ts` "the block equals the
   generated one" were both stale BY CONSTRUCTION: this branch changes a rendered
   row (`toolRunning` no longer draws `⎿ running…`) and `key-docs.ts`'s
   `beta.compactShell` text, so the two generated artefacts had to move with it.
   The executor updated `key-docs.ts` but never re-ran the generators. Fixed by
   running them (`bun run mockup-kit` → `tools/mockup-kit/generated/kit-data.json`,
   4 rows: `toolRunning`/`toolRunningOff` × 2 themes lose the `⎿ running…` line;
   `bun run docs:config` → `README.md`'s `beta.compactShell` row). Both tests green.
2. **`mockup-kit-calibration.test.tsx` `transcriptRow toolRunning` /
   `toolRunningOff` (2 failures).** The same drift seen from the TUI side: the kit
   served the old two-row `toolRunning` while Ink drew one. Regenerating (1)
   fixed it; no test edit needed — it is the gate that was right.
3. **`denial-reply-row.test.ts` "collapsed and expanded … no model text" (1).**
   The test pinned the RETIRED expand shape (`  │ rm -rf build`); the branch's
   expand is the `⎿ $ ` block (docs §Design 3). Its own `body()` helper already
   strips `⎿ `, so the expectation becomes `$ rm -rf build`. Intent unchanged (the
   structured `✗ Denied` fact, never the model-facing text) and it still asserts
   `not.toContain("Answer the user")`. A stale test, not a regression: the branch
   rewrote `shell-intent-rows.test.ts`/`render-lines.test.ts`/`app.test.tsx` for
   the new shape but missed this file.
4. **`app-mouse-layer.test.tsx` S4 "press+release in ONE write is still a CLICK"
   (1).** Same miss, one level down: the test's `cont()` looked for `  │ ` rows to
   observe that the call expanded, and a shell call no longer draws any. It now
   accepts the block opener `⎿ $ ` or a 4-cell-hung continuation, matching the
   `cont()` the branch already gave `app.test.tsx`. The property the test exists
   for (a coalesced chunk threads the click state) is untouched — it re-asserts
   `0` before the click and `> 0` after.
5. **`serve-log-store.test.ts` S2 (a) and (b) (2 failures; (a) a 20 s timeout on
   `until(() => c.ended("T1"))`).** A REAL race in the test harness, not a flake
   of timing luck: `PARKED` stored its release in `PARKED.release`, overwritten by
   every park, and `open()` called whatever was there. When the prompt's own write
   landed and the test called `PARKED.open()` (or the round parked after the
   release), the release was LOST and the parked model round never resumed — the
   turn could never end, so only the 20 s `until` dead-man closed the test.
   `PARKED` now LATCHES: `open()` sets `latched`, and a park that finds it set
   consumes it instead of waiting, so one `open()` covers exactly one park in
   either order. (b) also stopped keying off the global `PARKED.waiting === 1`,
   which a still-parked round from a previous failed test could satisfy, and waits
   on its OWN park via a monotonic `PARKED.parks`. Both tests reset `latched`
   first so a test cannot inherit a stale release.

**Red before green (5).** Probes: `await tick(50)` in `Scripted.stream` (so the
release lands before the park, deterministically) + an `open()` right after
`await hosted.persisted()`, with the latch branch removed → `(fail) S2 (a) …
[20014.78ms]`, `error: timed out: () => c.ended("T1")` — byte for byte the gate's
failure. Restoring the latch, same probes: `2 pass / 0 fail`. Probes then removed
and both tests re-run green.

**Verification.** `bun test` on all 6 affected files together: **73 pass, 0
fail**; the full `serve-log-store.test.ts` also run `--rerun-each 2` under 8
busy-loop CPUs: 44 pass, 0 fail. `bunx biome check` on the 4 changed source/test
files: clean.

**Not fixed, deliberately.** `render-lines.test.ts` "the shipped default is the
text-only header" fails ONLY when run in the same process as
`permission-shell-command.test.tsx` (a module-level theme/first-import
interaction): the executor already reproduced it on a pristine `git archive HEAD`
copy, and each file alone is green (127 pass / 0 fail alone). Pre-existing on
`main`, unrelated to this branch, and out of the approved Implementation — it is
not touched here.

## Review

*— claude-opus-5-5, 2026-11-22* (fresh context; NOT the executor's model family — the executor was Sonnet/DeepSeek)

**Verdict: REQUEST-CHANGES** (1 MEDIUM, no HIGH).

1. **MEDIUM — a background start shows its start note collapsed, against the approved spec.** `packages/tui/src/render-lines.ts` `shellBlock` (`outcomeOnly = row.exitCode === null && status ∉ {running, queued}`) treats any settled call with no `exit=` as "outcome", so a `run_in_background` start (`tools/src/builtins.ts:456`, no `exit=` line) draws its 2-line note under the `$` row collapsed (3–5 rows at w=40/80; for a plain row it replaces the title-only shape with a `⎿ started background job …` block). The owner's variant B (Context example "Job in background di 8s…" = header + `⎿ $ …` only; mockup `render()` puts that note in `out`, shown only when `expanded`) says NO output collapsed. `shell-row-collapsed.test.ts:120` pins the wrong shape. Fix: exclude the background start from `outcomeOnly` (keep denial/hook reasons), and flip that test.
   Repro (`.tentacle/tmp/tui-shell-row-collapsed/review.ts`, w=80, SGR stripped): `● Job in background 0.0s` / `⎿ $ echo "partito"; sleep 8; echo fine` / `  started background job bg-1 (pid 95): …` / `  Read output with shell_output({ job_id: "bg-1" }); …`.

**Gate (touched files):** 11 files, 351 pass / 1 fail — the fail is `render-lines.test.ts` "shipped default is the text-only header", order-dependent with `permission-shell-command.test.tsx` (whose diff is comment-only); accepted as pre-existing per Execution, not re-verified on `main`. `bun run lint`: clean. `bun run typecheck`: clean. Full `bun test` not run here.

**Mutation:** `dollarRows` exit-fits check forced to "never fits" → 4 fail in `shell-row-collapsed.test.ts`; reverted, `git status` clean.

**Attacks tried:** (a) background start collapsed → finding 1. (b) settled error with no `exit=` (spawn failure) → shows `$ x` + reason collapsed; reasonable as an outcome, not output. (c) wide CJK command + `exit=1` at w=40 → cut with `…`, `exit=1` intact, width ≤ cols. (d) `compactShell` removed from row-cache key → safe, no renderer reads it; config key kept in `.strict()` schema. (e) §7 "logic in pure modules": room math is in pure `shell-row.ts`; the assembly (`shellBlock`/`dollarRows`) still branches in `render-lines.ts`, consistent with the existing file — no finding. Permission ask untouched (comment only); `apps/mobile`/`core` untouched.

**Executor behaviour:** honest Execution (red mutations pasted, drift recorded, pre-existing fail reproduced); the one miss is reading Design step 5's "denied → keep text" as covering background starts.

### Fix round 1

*— claude-opus-5-5, 2026-11-23* (executor; review round 1 was claude-opus-5-5, the orchestrator's fresh-context reviewer)

**The one finding (MEDIUM, no HIGH) — FIXED: a background start no longer shows its note collapsed.**

Root cause, exactly as the review stated it: `shellBlock`'s `outcomeOnly` reads
"settled with no `exit=`" as "an outcome the call had to say", and a
`run_in_background` start is the one settled-no-code case that is not an outcome
— its note says where the job's output will be read. One sentence:
`packages/tui/src/shell-row.ts:62` now also returns `backgroundStart`, and
`render-lines.ts:1127-1131` (its `outcomeOnly`) excludes it.

- `shell-row.ts:30`: `BACKGROUND_START` — the marker `packages/tools/src/builtins.ts:456`
  writes as the result's head (`started background job `), pinned in ONE place.
- `shell-row.ts:48,62`: `ShellRow.backgroundStart` = `status === "ok" && head
  starts with BACKGROUND_START`. `ok` only, deliberately: an `isError` result
  about background execution (`background execution is not available here`) is a
  REFUSAL, i.e. an outcome that must stay visible; and a failed shell call can
  never have started a job.
- `render-lines.ts:1127-1131`: `outcomeOnly` gains `!row.backgroundStart`; the
  doc comment above `shellBlock` (`:1106-1116`) now names a spawn failure as
  the outcome case and the background start as the exception.
- Design step 5 clarified in place (Implementation), since it is the sentence
  this round read the other way.

**Red before green (the review's own repro, then the tests).** `.tentacle/tmp/tui-shell-row-collapsed/review.ts`
on the pre-fix code, w=80, SGR stripped:
```
● Job in background 0.0s
⎿ $ echo "partito"; sleep 8; echo fine
  started background job bg-1 (pid 95): `echo "partito"; sleep 8; echo fine`
  Read output with shell_output({ job_id: "bg-1" }); stop it with shell_kill({ …
```
(plain row at w=40: `● Bash echo "partito"; sleep 8; ec… 0.0s` + a 3-row
`⎿ started background job …` block — the title-only shape replaced by a block.)
Tests flipped first, run against the unfixed code — **3 fail**, on the
assertion, not an import: `a background start: NO start note collapsed` (+ a
spurious `"  started background job j1: `x`"` row), `… with no sentence: the
title alone, no block` (+ `"⎿ started background job j1: `ls`"`), and
`shell-intent-rows.test.ts`'s background case. Same repro after the fix: two
rows, `● Job in background 0.0s` / `⎿ $ echo "partito"; sleep 8; echo fine`;
plain: the single title row. `expandAll: true` still shows the note, so the
information is ctrl+o away, never lost.

**Mutation checks (each reverted; `git status` never carried the mutation).**
1. `render-lines.ts` `!row.backgroundStart &&` deleted (the pre-fix guard) →
   **3 fail**, byte for byte the RED above. Restored → 49 pass.
2. Over-fix: `if (!expanded)` (every collapsed body dropped) → **6 fail**,
   including the new `a spawn failure … KEEPS its reason` — the guard against
   fixing this by hiding outcomes. This is the non-vacuity check for the
   outcome half.
3. `shell-row.ts` `tool.status === "ok"` → `settled` (an error read as a start) →
   **1 fail**: the added assertion `a failed call is never read as a start` got
   `⎿ $ bun test apps/mobile` where it wants the note. This is the non-vacuity
   check for the new `ok`-only condition (it would otherwise be untested).

**Drift from Implementation:** none beyond the fix itself — no new file, no
plumbing change; the pure module keeps the parse (`shell-row.ts`, §7), the
renderer keeps only assembly. Two cases the review listed as attacks are now
pinned by tests instead of prose: a spawn failure (outcome, kept) and a plain
row's background start (title only, `background start with no sentence`).

**Verification.** `shell-row-collapsed` + `shell-intent-rows` +
`denial-reply-row` + `render-lines` + `app-shell-row-collapsed` + `tool-hit`:
**192 pass / 0 fail**. `scripts/test/mockup-kit.test.ts` + `app.test.tsx` (the
codegen-drift and Ink seams): 150 pass / 0 fail — no generated artefact moved
(nothing user-visible in the kit changes: the start note was never in it).
`bunx biome check` on the 4 changed files: clean. `bun run check` on the whole
branch is the orchestrator's script's job.

**The known pre-existing fail, re-observed honestly.** Adding
`permission-shell-command.test.tsx` to that set (7 files, 202 tests) yields
**201 pass / 1 fail**: `render-lines.test.ts` "the shipped default is the
text-only header" — the order-dependent module-level theme/first-import
interaction already recorded in the gate-round Review and reproduced by the
executor on a pristine `git archive HEAD` copy. It is green alone (127 pass) and
green with `shell-row-collapsed` in the same process (161 pass); the test file is
byte-identical to `HEAD` (`git show HEAD:…`), and the row it asserts is the
startup header (`mascot.ts`), which this round does not touch. Not fixed here:
pre-existing, unrelated, outside the approved Implementation. Unverified part:
whether the co-run also fails on `main` — the gate's own baseline run decides
that.

### Round 2

*— claude-opus-5-5, 2026-11-22* — **Verdict: PASS.** Diff `HEAD~1` (dfd63328).

- **Finding 1 (MEDIUM) fixed.** `shell-row.ts` adds `backgroundStart` (`status === "ok"` and the text starts with `BACKGROUND_START`, matching `tools/src/builtins.ts:456`); `render-lines.ts` `shellBlock` excludes it from `outcomeOnly`. Repro `review.ts`: described start collapsed is header + `⎿ $ …`; plain start is `● Bash <cmd> 0.0s` only; expanded still shows the note.
- **Mutation:** dropping `!row.backgroundStart` → 3 fail (both test files); dropping the `status === "ok"` guard → 1 fail (the spawn-failure / errored-start test). Both reverted, `git status` clean.
- **Regressions:** spawn failure (error, no `exit=`) keeps its reason collapsed; 5 shell/render/app test files 301 pass / 0 fail; `bun run lint` clean; `bun run typecheck` clean. Full `bun test` not run here.
