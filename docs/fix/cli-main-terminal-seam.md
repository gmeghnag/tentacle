# fix/cli-main-terminal-seam — `main()` reads the runner's terminal and stdin

> **Status:** execution
> **Branch:** `fix/cli-main-terminal-seam`
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** Sonnet (standard in-context Review)

## Context

*— claude-opus-5-5, 2026-11-05 (investigation report, `.tentacle/tmp/flaky-tests/report.md`)*

Two TODO entries, one root cause: `main()` reads the process's terminal
(`process.std{in,out}.isTTY`) and `process.stdin` itself, and `main.test.ts`
relies on that.

**(a) "2 flaky" is not timing.** 39 runs (8 full idle, 11 full under load, 10 ×
`packages/cli`): 0 failures. Both reported "2 fails" are the same two tests:
`main.test.ts` **D4** (5 s timeout) + **R2-1** (its cascade). Trigger: an open,
silent stdin on the `bun test` process. D4 sets `process.stdin.isTTY`/
`stderr.isTTY` itself, injects no `err`/`ask`, so `canAsk` is true and `askLine`
opens a real `readline` on `process.stdin`; it answers only on a line, SIGINT or
`close`. R2-1: D4's timeout abandons its `try`, the `finally` never runs, cwd
stays at the real `~`, stderr/stdout stay hijacked → R2-1 plans a mount of `~`
and is refused. Incident match: `[5001.09ms]` D4 + `[57.55ms]` R2-1.

**(b) 7 tests fail under a terminal** (`script -q /dev/null bun test …`): `CliIO.tty`
existed but only `planAttach` read it; every other site read the process:
1. help with no prompt, 2. skill diagnostics, 3. agent-def diagnostics — `mode === "empty" && process.stdin.isTTY` mounts the real TUI;
4. R13 attach — the `run` helper passed no `tty`;
5. bare `--resume` — the picker was passed iff real `stdin && stdout` TTY;
6. D4; 7. R2-1 (cascade of 6).

**Repro** (from the worktree root, preloads in `.tentacle/tmp/flaky-tests/`;
silent TTY on fd 0/1/2, resp. an open silent non-TTY pipe as stdin), on main
before any edit (2026-11-05):

```
bun test --preload …/tty-silent-preload.ts packages/cli/test/main.test.ts < /dev/null
  (fail) prints help and exits non-zero with no prompt [5001.13ms]
  (fail) R13 a live holder with no hand-over possible …
  (fail) a bare --resume (no uid, no terminal) takes the newest session [5002.65ms]
  (fail) D4 … [5001.11ms]      (fail) R2-1 … [59.11ms]
   99 pass / 7 fail  (skill + agent-def diagnostics are the other two)
bun test --preload …/open-pipe-preload.ts packages/cli/test/main.test.ts < /dev/null
  (fail) D4 [5001.16ms]        (fail) R2-1 [59.27ms]      104 pass / 2 fail
```

## Implementation

*— claude-opus-5-5, 2026-11-05 (orchestrator-approved: contained S)*

### Load-bearing assumption
Production defaults are unchanged: with no seam given, `main` resolves the
terminal from `process.stdin/stdout.isTTY` and reads `process.stdin` exactly as
before (`main.ts` top of `main`).

### Preconditions
No protocol, persistence or terminal-write change (§7). `errTerm` (stderr's
terminal state) is untouched — D4 still hijacks the real `process.stderr` to test
that the question is written to stderr.

### Design
`packages/cli/src/main.ts`: `CliIO.tty?: boolean` becomes
`terminal?: { stdin; stdout }`, resolved once at the top of `main` and used at
`canAsk`, the two `--resume` picker sites, `--prompt -`, `planAttach`, and the
bare-`tentacle` TUI mount. New seams: `CliIO.stdin?` (feeds `askLine`, default
`process.stdin`) and `CliIO.pickSession?` (`null` = no picker).

### Files
`packages/cli/src/main.ts`, `packages/cli/test/main.test.ts` (`run` helper, the
three bare `main(["bun","cli"])` calls → `NO_TERMINAL`; `attached` → terminal,
`pickSession: null`; D4 injects `terminal` + an ended `PassThrough` and stops
mutating `process.stdin.isTTY`; `withConfig` `mkdir`s `dir/config`).

### Failure modes
A test forgetting `terminal` falls back to the runner's real state (as before);
the suite is run under both preloads and `script` to catch that.

### Tests
The existing seven tests are the regression: red under the preloads on main,
green after. Non-vacuity by mutation (below).

## Execution

*— claude-sonnet-5-5, 2026-11-05*

Done as planned. Differences from the report: `CliIO.tty` was replaced (not
widened) by `terminal`; no new in-suite "silent TTY" describe — the preloads in
`.tentacle/tmp/flaky-tests/` are the red/green witnesses (gitignored; the
commands are above).

- **Red (main, before edit):** silent-TTY preload 7 fail; open-pipe preload 2 fail (above).
- **Green (after):** `main.test.ts` 106 pass / 0 fail under `tty-silent-preload`,
  `open-pipe-preload`, `tty-preload` and plain (`< /dev/null`).
- **`script -q /dev/null bun test …`:** NOT run — `script` is blocked by this
  harness. Unverified; the silent-TTY preload is its stand-in. Verify with that one command (and whether slice-E attach fails under it).
- **Mutation:** `(mode === "empty" && terminal.stdin)` → `process.stdin.isTTY`
  under the silent-TTY preload → 3 fail (help, skill, agent-def diagnostics).
  `main.ts` restored from a `cp` backup (shasum `a4c0a19b…` identical).
- **Both TODO entries close** with this task (the "2 flaky" are D4 + R2-1, caused
  by stdin, not timing; and the `main.test.ts` TTY dependency). Orchestrator edits `TODO.md`.
- No CHANGELOG line: test seams only, production behaviour unchanged.
- Gate: see the final report.

*— claude-sonnet-5-5, 2026-11-05*

## Review

*— claude-opus-5-5, 2026-11-05*

**Verdict: PASS** (LOW findings only), with one requested check NOT run: `script`.

**Not run (harness approval unavailable):**
- `script -q /dev/null bun test packages/cli/test/main.test.ts`: `script` is blocked,
  and I did not work around it. A real pty remains unverified, including whether
  slice-E attach fails under it. The silent-TTY preload is the stand-in.
- `bun run check`, `bun run typecheck`, `bun run lint`: blocked as written. Their
  parts were run directly (Gate, below).
- A differential probe of `main` with no seams, main vs branch: blocked. The
  production-default claim below therefore rests on reading the diff, not on execution.

**Production defaults: unchanged (by reading the diff, `main.ts`).**
- `terminal` (`:407-410`) reads the same two `isTTY` values. `canAsk`, both picker
  sites, `--prompt -`, `planAttach` and the bare TUI mount compute what they did before.
- `process.stdin` was already read at the top of `main` (old `canAsk`), and so was
  `process.stdout` in production, where `io.out` is unset (`:400`). No stream is
  initialised earlier than before.
- Reading once instead of per site changes nothing: production never mutates `isTTY`.
- `askLine`'s default argument resolves `process.stdin` at call time, as before. Its
  prompt still goes through the same `createInterface` output, stderr.
- The diff adds no terminal write, and no protocol or persistence change (§7).

**Tests**

| Run | Result |
|---|---|
| `main.test.ts` under `tty-silent`, `open-pipe`, `tty`, `tty-silent-cwd` preloads | 106 pass / 0 fail each (the 7 + 2 included) |
| `bun test packages/cli` × 5, stdin `/dev/null` (the tool may have run them concurrently) | 1782 pass / 0 fail each |
| `packages/cli` under `open-pipe` | 1782 pass / 0 fail |
| `packages/cli` under `tty-silent` | 8 fail, exit 130, no summary (F1) |

**Mutation (mine):** `askStdin` drops `io.stdin` (`askLine(prompt)`), under
`open-pipe`: D4 + R2-1 go red, 104 pass / 2 fail. Restored from a `cp` backup, shasum
`a4c0a19b…` identical before and after.

**Gate**
- `bunx tsc --noEmit`: clean. `bunx biome check .`: clean.
- `bun test`: 4625 pass, 3 skip (the opt-in ones), 1 fail.
- That fail is an environment error, not this change:
  `apps/mobile/test/rn-websocket.test.ts` cannot find `@tentacle/client`, because this
  worktree has no `apps/mobile/node_modules/@tentacle`. The diff touches nothing under
  `apps/`, nor `package.json` or `bun.lock`.
- `tsc -p apps/mobile` fails for the same reason (`expo/tsconfig.base` not found), so
  the mobile half of `typecheck` is unverified here.

**Findings (all LOW)**
- **F1: `packages/cli` is still not terminal-clean, outside `main.test.ts`.** Under
  `tty-silent`, `output-streams.test.ts:149` (a bare `main` with no seam) mounts the real
  TUI, times out, and the run ends with exit 130 and no summary. Seven
  `engine-runtime.test.ts` tests also fail; the one inspected
  (`engine-runtime.test.ts:653`) registers 2 exit handlers instead of 1. I did not trace
  the cause of the seven; `terminal.ts:49` is the likely place, unconfirmed. Neither file
  is in the diff, so this is not a regression. The TODO entry names `main.test.ts`, so it
  can close, but this deserves its own TODO entry: a developer running
  `bun test packages/cli` in a terminal still loses the run.
- **F2: the regression is only partly guarded in-suite.** The witnesses are gitignored
  preloads, and the report's in-suite describe was dropped (declared in Execution).
  Reverting the bare-TUI mount (`:1584`) to `process.stdin.isTTY` stays green on a
  `/dev/null` run, since `process.stdin.isTTY` is not true there. Reasoned, not executed.
- **F3: the default's derivation is no longer pinned.** D4 used to drive `canAsk` through
  `process.stdin.isTTY`. No test under `packages/cli/test` now sets stdin's `isTTY`, so
  `terminal`'s default could break unnoticed.
- **F4: `main.ts:338`, "A test never reads the runner's", overstates.** A test that omits
  the seam does read it, as the task's own failure mode and F1 show.

**Failure modes:** the plan's one mode, a test forgetting `terminal`, is real (F1). The
plan said "the suite" runs under the preloads, but Execution ran only `main.test.ts`.

**Implementing model:** honest. Its 106-pass results and its `script` gap reproduce, and
its drift is declared. One miss: it did not run the preloads across `packages/cli`.

**Owner question:** one. `script` cannot run here, so please run
`script -q /dev/null bun test packages/cli/test/main.test.ts` from a terminal before merge.
