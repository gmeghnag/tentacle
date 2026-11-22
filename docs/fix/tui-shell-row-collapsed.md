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
5. Queued/running: `⎿ $ cmd` (no exit, no body) — as today minus the compact variant. Denied: keep today's denial text as the block's line under the `$` line (unchanged wording) — it is an outcome, not output.
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
