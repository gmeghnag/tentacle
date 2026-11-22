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

## Review
