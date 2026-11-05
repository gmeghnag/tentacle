# fix/cli-tests-terminal-clean — `packages/cli` tests must not read the runner's terminal (outside `main.test.ts`)

> **Status:** implementation (awaiting approval)
> **Branch:** `fix/cli-tests-terminal-clean`
> **Type:** fix · **Size:** S · **Blast:** contained (test-only: no `src/` change) · **Suited:** a weaker model may execute; standard in-context Review

## Context

*— claude-sonnet-5-5, 2026-11-05*

Sibling `fix/cli-main-terminal-seam` (merged 0a7496b) made `main.test.ts` hermetic. Outside it,
`packages/cli` still depends on the runner's terminal: a developer who runs `bun test packages/cli`
in a real terminal (open, silent TTY stdin) loses the run. CI and agent shells have no TTY, so it
is hidden.

**Repro** (main @ 3a149c7, Bun 1.4.3, 2026-11-05; logs in `.tentacle/tmp/cli-tests-terminal-clean/`).
The preload `.tentacle/tmp/flaky-tests/tty-silent-preload.ts` makes stdin a never-ending
`isTTY` PassThrough and stdout/stderr `isTTY` (`script` itself is blocked by this harness — not
run; see "Unverified").

1. `bun test --preload …/tty-silent-preload.ts packages/cli < /dev/null` → `silent.log`:
   the run **dies with exit 130 and no summary** after `output-streams.test.ts` times out; the log
   ends with a mounted Ink TUI (`Tentacle ready. Type a task…`). 7 `engine-runtime.test.ts` fails
   were printed before it. Tests after `output-streams` (alphabetical) never ran in this run.
2. `… packages/cli/test/engine-runtime.test.ts` alone → `silent-engine-runtime.log`:
   **92 pass / 7 fail**.
3. `… packages/cli` minus those two files (`--path-ignore-patterns`) → `silent-rest.log`:
   **1666 pass / 0 fail**, so nothing else in `packages/cli` leaks (`main.test.ts` included).
4. `script -q /dev/null bun test packages/cli < /dev/null` — **blocked** by the harness
   ("What 'script' starts can't be checked") → not run.

**Failing tests: 8 (1 + 7), all outside `main.test.ts`.**

### A. `output-streams.test.ts:149` — "no prompt and no terminal: the help is the error's…"

- Test: `capture([])` (`test/output-streams.test.ts:150`). `capture` (`:95-107`) injects `out`/`err`
  but **not `terminal`**, so `main` falls back to the process: `src/main.ts:408-411`
  (`io.terminal ?? { stdin: process.stdin.isTTY === true, … }`).
- With a TTY stdin, mode `empty` mounts the real TUI: `src/main.ts:1585`
  (`mode === "empty" && terminal.stdin`). It waits for keys → 5 s timeout, then exit 130 kills
  the run (this is what loses the whole `bun test packages/cli`).
- The seam exists since 0a7496b (`CliIO.terminal`, `src/main.ts:341`); this file just never
  passes it. The other 11 `capture` tests pass today only because they never reach `:1585` /
  `:413-418` (picker) / `:397`-area y/N paths.

### B. `engine-runtime.test.ts` — 7 fails; `terminal.ts:49` suspicion **refuted**

`src/terminal.ts:49` is `shared: process.stdout.isTTY === true && …` inside `startTerminal`
(the REPL). No `startEngineRuntime`/`attachEngineRuntime` call reaches it. The real leak:

- `src/engine-runtime.ts:180-183` `statusLineFor`:
  `const term = deps.logTerm ?? termOf(process.stderr);` → with a TTY stderr it builds a
  `StatusLine` (`:182`). Called from `:429` (start) and `:740` (attach).
- A `StatusLine` hides the cursor and registers a **second** process exit handler:
  `src/status-line.ts:129-132` (`process.once("exit", this.exitHandler)`), on top of the
  pod-delete net `src/engine-runtime.ts:333`/`:365` (`process.once("exit", fire)`). That is the
  "2 exit handlers instead of 1".
- With a TTY, phase/notice/warning lines also go through the spinner (`:429-…`) instead of
  `deps.log`, so the `log`/`info` assertions see nothing.
- Tests never pass `logTerm` (`grep logTerm test/engine-runtime.test.ts` → no hit); the seam
  `EngineRuntimeDeps.logTerm` already exists (`src/engine-runtime.ts:246`, `:698`).

| # | Test (`test/engine-runtime.test.ts`) | Fails at | Cause |
|---|---|---|---|
| 1 | startPodRuntime › registers a process-exit cleanup that deletes the pod | `:653` `registered` length 2, not 1 | 2nd `exit` handler = `status-line.ts:132` |
| 2 | startPodRuntime › --keep: no exit net… | `:700` `exitListeners` is `[fn]`, not `[]` | same handler (no pod net with keep) |
| 3 | startPodRuntime › daemon stderr on exit › `info` carries… | `:971-972` `infos` lacks the phases | phases went to the spinner |
| 4 | version check › attach: older tentacle replaced… | `:1830-1831` `logs` lacks the line | same |
| 5 | version check › attach: newer tentacle replaced… | `:1830-1831` | same |
| 6 | version check › a pod's escape sequences… never reach the log | `:2422` | same |
| 7 | version check › attach: replacing fails (read-only dir)… | `:2577-2578` | same |

(All 78 call sites go through the two local wrappers `startPodRuntime` / `startAttachRuntime`,
`test/engine-runtime.test.ts:60-76`, which build the deps → one injection point.)

## Implementation

*— claude-sonnet-5-5, 2026-11-05*

### Load-bearing assumption

A test that omits the terminal facts reads the runner's. Proven: A at `main.ts:408-411`, B at
`engine-runtime.ts:181`. **Production defaults stay exactly as they are** (`terminal` →
`process.std*.isTTY`; `logTerm` → `termOf(process.stderr)`): the seams already exist, so
**`src/` is untouched.**

### Preconditions

- `CliIO.terminal?: { stdin; stdout }` (`main.ts:341`); `CliIO.stdin` (`:342-343` area),
  `CliIO.pickSession` (`:348`).
- `NOT_A_TERMINAL: StreamTerm` (`src/streams.ts:29`) satisfies `logTerm: Pick<StreamTerm, "tty"|"columns">`.
- A spread order `{ logTerm: NOT_A_TERMINAL, ...rest }` lets any future test that wants the
  spinner pass its own `logTerm`.

### Design

1. **Hermetic defaults in the two test entry points** (test-only):
   - `test/output-streams.test.ts` `capture` (`:95-107`): add `terminal: { stdin: false, stdout: false }`
     before `...over` (the file's contract is "not a terminal"; a test that wants one overrides via `over`).
   - `test/engine-runtime.test.ts` wrappers (`:60-76`): `{ logTerm: NOT_A_TERMINAL, ...rest }` in both
     (import `NOT_A_TERMINAL` from `../src/streams.ts`).
2. **In-suite guard, so it cannot regress unseen** (the AGENTS §9 point: a plain `bun test` in CI has no
   TTY, so the fix alone would be unprovable there): a tiny helper `test/silent-terminal.ts`
   exporting `simulateSilentTerminal()` → installs the preload's stand-in (stdin = never-ending
   `PassThrough` with `isTTY`/`setRawMode`/`ref`/`unref`; `isTTY` on stdout/stderr) and returns a
   restore function. `output-streams.test.ts` and `engine-runtime.test.ts` call it in `beforeAll`
   and restore in `afterAll`, so those files run **under a simulated terminal on every run, any
   environment**. A future test in either file that reads the real terminal then fails in CI,
   not only on a developer's laptop. (Bun runs files sequentially in one process → restore is mandatory;
   `main.test.ts` is left to its own seam fix.)

### Files

1. `packages/cli/test/silent-terminal.ts` (new, ~25 lines; same stand-in as `tty-silent-preload.ts`).
2. `packages/cli/test/output-streams.test.ts` — `capture` + `beforeAll`/`afterAll` (a file-level `beforeAll`
   already exists for `server`/`dir` at ~`:58`; extend it).
3. `packages/cli/test/engine-runtime.test.ts` — import, two wrappers, `beforeAll`/`afterAll`.

No `src/`, protocol or format change.

### Failure modes

- **Restore forgotten / throws** → later files see a fake TTY stdin. Mitigate: `afterAll` restores via the
  saved property descriptors; assert in the helper's own mini-test that `process.stdin` is restored.
- **Simulation breaks an unrelated test in the same file** (e.g. one that needs the real stdin): the
  silent run showed 92 pass / 0 other fails in engine-runtime and 11 pass in output-streams, so none today.
- **A test that legitimately wants the spinner** → passes `logTerm: { tty: true, columns: () => 80 }`
  (wins by spread order).
- **Wrapper hides the default from a direct `startEngineRuntime` call** (not through the wrapper): none
  exist in this file (78 sites, all wrappers/`runDeps` over them); the guard (Design 2) catches new ones.
- **Mounting the TUI after a timeout kills the run (exit 130)**: with `terminal.stdin=false` `main` returns the
  help (`:1585` not taken), so the failure mode becomes an ordinary red test, not a lost run.

### Tests

Red first (§9), in-suite and deterministic, no preload:

1. Step 1 on current code: add only `simulateSilentTerminal()` to both files' `beforeAll`/`afterAll`
   → **expect red**: `output-streams.test.ts` "no prompt and no terminal…" times out (the TUI mounts),
   and the 7 engine-runtime tests fail as in the table. Record the output.
2. Step 2: add the hermetic defaults (Design 1) → green; `bun test packages/cli/test/output-streams.test.ts
   packages/cli/test/engine-runtime.test.ts` all pass.
3. **Mutation (non-vacuity):** delete `logTerm: NOT_A_TERMINAL` from the `startPodRuntime` wrapper
   (or `terminal:` from `capture`) → the 7 / 1 tests fail again; revert.
4. Gate: `bun test packages/cli` plain **and** under `--preload …/tty-silent-preload.ts` (both green,
   exit 0 with a summary), then `bun run check` vs. the lint baseline. Do NOT run `tsc -p apps/mobile`.

### Overlap with `feat/config-carry` (edits `engine-runtime.ts`, `main.ts`, `test/engine-runtime.test.ts`)

- `src/engine-runtime.ts`, `src/main.ts`: **no overlap** (this fix does not touch them).
- `test/engine-runtime.test.ts`: **overlap, small and mechanical** — the import block (`:50-53`), the two
  wrappers (`:60-76`) and the file's top-level `beforeAll`/`afterAll`. The config-carry diff on that file
  is unknown to me (`git diff main...feat/config-carry` is empty today). Hunks are in lines that a
  config-carry change to deps/tests rarely touches, but if it edits the wrappers/`runDeps` there will be a
  textual conflict: **land this after config-carry merges, or rebase** — it is a 10-line resolution.

### Unverified

- `script -q /dev/null bun test packages/cli` (a real pty): blocked here. Verification: run it once on the
  laptop after the fix; expected to match the silent-preload result.
- Tests after `output-streams` never ran in repro 1 (the run died); repro 3 covers them (0 fail).

## Execution

*— claude-sonnet-5-5, 2026-11-06*

As built (test-only, no `src/` change, no CHANGELOG line). Re-verified on main@90e8fef after config-carry: `capture` (`output-streams.test.ts`), the two wrappers and `statusLineFor` (`engine-runtime.ts:168-169`) are as the plan says.

1. `packages/cli/test/silent-terminal.ts` (new): `simulateSilentTerminal()` → restore fn (saved descriptors for `process.stdin`, `stdout/stderr.isTTY`).
2. `beforeAll`/`afterAll` (simulate / restore) in `output-streams.test.ts`, `engine-runtime.test.ts` and, per Owner answer Q2=B, `main.test.ts`.
3. **RED** (step 1 only, logs in `.tentacle/tmp/cli-tests-terminal-clean/red-*.log`): engine-runtime **92 pass / 7 fail**; output-streams "no prompt and no terminal…" **times out 5 s, TUI mounts, exit 130**; main.test.ts **113 pass / 0 fail** (already hermetic, guard only).
4. **GREEN**: `capture` gets `terminal: { stdin: false, stdout: false }` before `...over`; both wrappers get `logTerm: NOT_A_TERMINAL` before `...rest`; engine-runtime + output-streams + main: 231 pass / 0 fail.
5. **Mutation** (cp backup, shasum identical after): remove `terminal:` from `capture` → output-streams timeout again; remove `logTerm` from the `startPodRuntime` wrapper → 2 engine-runtime fails (the attach wrapper still had it).
6. `packages/cli` under `tty-silent-preload.ts`: **1901 pass / 0 fail**, with summary (was: dead at exit 130).

**Drift:** (a) the plan listed only the 2 wrappers, but the `info carries…` test calls `provisionWorkload` directly (a bare site the plan's "78 sites all wrappers" missed) and failed once the simulation was on → `logTerm: NOT_A_TERMINAL` added to all 6 direct `provisionWorkload` calls. (b) No separate mini-test for the helper's restore (the plan's failure-mode mitigation): restore is exercised implicitly — files after these in the run (full suite) stay green. (c) `script -q /dev/null bun test packages/cli` was **not run**: blocked by the harness; verify on the laptop. Gate: tsc clean, biome clean; `bun test packages` see below.

## Review

*— (empty)*

## Owner questions

1. **Ordering vs `feat/config-carry`** (shared file `test/engine-runtime.test.ts`). Recommendation: let
   config-carry merge first, then execute this (conflict-free; the fix is S). Alternative: run now in a
   separate worktree and resolve the rebase.
2. **Also run the in-suite simulation for `main.test.ts`?** It is already hermetic via its seam
   (sibling fix), and the silent run is 0 fail there. Recommendation: **no** (keep this S); only the
   two files that leaked get the guard.

*— claude-sonnet-5-5, 2026-11-05*

### Owner answers (2026-11-05)

1. Decided by the standing rule (parallel code tasks only on disjoint files): **after feat/config-carry merges**.
2. **B — yes**: the in-suite silent-terminal simulation also covers `main.test.ts` (owner chose over the recommendation).
