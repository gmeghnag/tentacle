# fix/main-gate-flakes — the main gate fails on random, load-sensitive tests

> **Status:** context · implementation (executor: measure FIRST, then plan, then fix — pre-approved, orchestrator 2026-11-17)
> **Branch:** `fix/main-gate-flakes`
> **Size:** M · **Blast:** cross-module (tests only + `bun test` config; no product code unless a test exposes a real race) · **Suited:** DeepSeek exec + Opus review
> **Changelog:** none (test infra)

## Context

On 2026-11-17 the main gate (`bun run check`, run twice before a merge is reverted) reverted 4+ good merges because, under load (several agents, simulators and gates in parallel on one Mac), a DIFFERENT handful of tests fails on each run. Gate logs are copied in `.tentacle/tmp/main-gate-flakes/`. Seen failing (count over today's gates):
- `T3.1 no line wider than the width` (packages/tui/test/chart-lines.test.ts) — ~7 s alone, over bun's 5 s default: ALREADY fixed on main (379678bb, explicit 60 s timeout).
- `fork … T4 the fork precedes the source's next write` (clear-fork-history) ×2
- `sshDialer: process-group kill on close` and `a broken pipe` (~1 s, timing)
- `S2 — the overlay … (a)/(b)` and `S11 — a real SIGKILL at random points … 200 kills` (daemon serve-log-store, ~14 s)
- `logs -f --connect: the live follower`
- `generation (session-titles) D5 failures … timeout`
- `F10 the transient voice line is never persisted`
- `dangling links, hard links and races F2`
(`rowSubtitle` and `I1 [Unreleased]` were REAL failures of a branch, not flakes.)

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Executor: measure FIRST — run each listed test file 20× alone and 5× under CPU load (e.g. `bun test` of that file while `yes > /dev/null` ×(cores) runs; kill the load after), record pass rate + max duration per test in Execution. For each flaky one: find the timing assumption (wall-clock sleeps, fixed short timeouts, real-time races, port reuse, temp-dir collisions), make it deterministic (fake clock, waits on the event not on time, explicit generous per-test timeout ONLY where the test is legitimately slow), never weaken what it asserts. If one exposes a REAL product race, stop and record it as a finding (do not paper over it). Also: per-file timeouts for the known slow suites, and check whether `bunfig.toml` concurrency/timeout settings help the loaded case. Done when: each listed test passes 20/20 alone and 5/5 under load; full `bun test` twice under load green.

## Execution

**Load-bearing check (measured first, as the Implementation demands).** Worktree
`.tentacle/worktrees/main-gate-flakes` (note: the `/v1` gate logs come from the
MAIN checkout, `.tentacle/tmp/main-gate-flakes/*.log`; re-running the same files
here showed a different, smaller set). Alone, every listed file passed. Under
CPU load (`yes > /dev/null` × cores, 5 runs each) these reproduced:

| target | alone | under load |
|---|---|---|
| `sshDialer: process-group kill on close` | pass | **1/5** |
| `sshDialer: a broken pipe` | pass | **3/5** |
| `voice-turn-f10 F10 (the store)` | pass | **1/5** |
| `logs -f --connect: the live follower` | pass | **3/5** |
| `confinement F2 hard link` | 20/20 | 5/5 (see the finding) |
| `session-titles D5`, `session-log-store T4`, `serve-log-store S2`, `serve-log-store S11` | pass | 5/5 |

A full `bun test` (unloaded) also failed `logs -f <run-name>: the pod's watcher`
— a second fixed-`setTimeout` fence of the same class, fixed here too.

**What was actually wrong, and the fix (in dependency order).**

1. **`packages/exec/src/host-execution.ts` — a REAL product bug, not a test
   flake.** `safeRealpath`/`entryExists` swallowed *every* errno and fell back to
   the lexical path. Proved with real fds
   (`.tentacle/tmp/main-gate-flakes/probe-realpath-emfile.ts`): `realpathSync`
   throws `EMFILE` under fd pressure. The confinement check then compared a
   lexical `/var/…` target with a realpath'd `/private/var/…` root and refused a
   write **inside** the project — the gate log's exact text. Reproduced on the
   buggy code (`.tentacle/tmp/main-gate-flakes/repro-confine-emfile.ts` →
   `(A) write inside the project: REFUSED (bug)`). The false-**allow** direction
   is not reachable (`repro-confine-allow.ts` → "refused (correct)"): it fails
   closed, so this was a wrong answer and a flake, never an escape.
   Fix (`:126-215`, `:947-963`): `PATH_VERDICT` names the errnos that ARE a
   verdict about the path (`ENOENT`, `ENOTDIR`, `ELOOP`, `EACCES`, `EPERM`,
   `ENAMETOOLONG`); anything else is transient and is retried
   (`retrying`, 5 attempts) and, if it persists, reported — never turned into a
   lexical path and never into "outside the workspace". `confineWrite` maps it to
   a `WorkspaceWriteError` that says to try again. A `pathCall` TEST SEAM (the
   file's fifth) injects the failure deterministically. 3 regression tests in
   `packages/exec/test/confinement.test.ts`.
2. **`packages/docker/test/ssh-dialer.test.ts`** — two duration fences replaced
   by waits on the event: the grandchild's pid file (50×20 ms) and the dead
   child's `ends`/`buffered` drain (a flat `sleep(1000)`). Dead-man switch 8 s,
   per-test timeout 30 s for the two-process kill test.
3. **`packages/cli/test/voice-turn-f10.test.ts`** — waited for the model CALL,
   then read a store that commits a save later. Now waits for the store's own
   commit (the prompt line), bounded 10 s; the assertions are unchanged.
4. **`packages/cli/test/logs-watch.test.ts`** + **`logs-follow-detached.test.ts`**
   — fixed 20/60/40 ms fences replaced by the follower's own output: an `onErr`
   seam resolving on its `watching` line, and `onOut` resolving on `turn_end`.
5. **`packages/daemon/test/session-log-store.test.ts`** (T4) — `forkIo` counted
   a fork temp by `path.includes("f1")`, which also matched the SOURCE's own temp
   (`.s.jsonl.tmp-<pid>-<8 hex>`): **2.74% of runs** (proved,
   `probe-temp-substring.ts`, 5474/200000). Now matched by NAME
   (`.f1.` prefix). The blind `sleep(60)` before the assertion became a wait for
   the fork to be parked at its gate.
6. **`packages/daemon/test/serve-log-store.test.ts`** — `until`'s 3 s default
   (S2's 3002.85 ms failure) raised to 20 s with the intent stated; S2's two
   tests get an explicit 60 s. S11's blind `sleep(5–125 ms)` after spawn became a
   wait for the child's own `ready` line, so `loads` is now honestly assertable:
   measured **200/200** and the assertion tightened from `> ITERATIONS / 2` to
   `toBe(ITERATIONS)` — the suite got stronger, not weaker.
7. **`packages/daemon/test/session-titles.test.ts`** — `until`'s 2 s default
   raised to 20 s (same dead-man-switch reasoning).

**`bunfig.toml` (the Implementation asked): it does NOT help, and silently.**
Measured on bun 1.4.3: a 1.5 s test passes under `[test] timeout = 500`, under
`BUN_TEST_TIMEOUT=500`, and is only caught by the CLI flag
(`bun test --timeout=500` → 504 ms, 1 fail). `[test] preload` IS honoured. So
there is no config-file per-file timeout; the only mechanism is an explicit
per-test timeout argument, which is what the known-slow suites use (T3.1's
precedent, `379678bb`). No `bunfig.toml` change was made, because a setting that
is ignored is worse than none.

**Mutations (non-vacuity, §9).** With the seam in place I restored the two old
blanket-`catch` helpers in `host-execution.ts` and re-ran the three new tests:
2 of 3 failed (the retry test and the construction test), then reverted —
recorded above. The T4 substring rule was proved by the 2.74% measurement plus
`probe-t4-rule.ts` (the old rule counts the source temp as a fork temp, the new
one does not).

**Drift from the Implementation.** (a) S11's assertion was TIGHTENED rather than
left, because waiting for `ready` makes `loads` deterministic. (b) A `pathCall`
test seam was added to `HostExecutionConfig`; the doc did not ask for one, but
without it the only way to exercise the EMFILE path is to exhaust the machine's
real fds, which is exactly the non-deterministic thing under repair. (c) The
`logs-follow-detached` flake is not in Context's list; it is the same defect and
was in the full-suite run, so it is fixed here.

*— deepseek-v4-pro, 2026-11-17*

## Review
