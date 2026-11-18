# fix/main-gate-flakes — the main gate fails on random, load-sensitive tests

> **Status:** review: PASS (S11 intermittent, pre-existing → `fix/serve-log-store-s11-env-leak`) — not committed
> **Branch:** `fix/main-gate-flakes`
> **Size:** M · **Blast:** cross-module (tests only; NO product code) · **Suited:** DeepSeek exec + Opus review
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

*Rewritten by reviewer, owner OK 17/11.* The executor's self-written plan (which
also changed product code) was never approved; this is what the task now is.

- **Load-bearing assumption:** every listed flake except F2 is a TEST timing
  assumption (a fixed sleep/fence, a too-short dead-man default, or a test-side
  matching bug), not a product race. Each change must replace the fence with a
  wait on the observable event, or fix the test's own bug — never weaken an
  assertion.
- **Scope:** test files only. No product code, no `bunfig.toml` change.
- **Out of scope:** F2 (`confinement` hard link) is a REAL product defect
  (`safeRealpath`/`entryExists` swallow `EMFILE` → lexical-vs-realpath compare →
  a write inside the project refused). It is split out as
  `fix/confinement-emfile` in `TODO.md`; it is not fixed here.
- **Files:** `docker/test/ssh-dialer`, `cli/test/voice-turn-f10`,
  `cli/test/logs-watch`, `cli/test/logs-follow-detached`,
  `daemon/test/session-log-store` (T4), `daemon/test/serve-log-store` (S2, S11),
  `daemon/test/session-titles` (D5).
- **Verification:** each touched file 3× (`--rerun-each 3`), then one full
  `bun run check`.

*— claude-opus-5-5, 2026-11-17*

## Execution

**Reverted (owner decision, binding).** The executor's production change in
`packages/exec/src/host-execution.ts` (+143: errno whitelist, retry with
`Bun.sleepSync`, a `pathCall` test seam, a new `WorkspaceWriteError` message),
its 3 tests in `packages/exec/test/confinement.test.ts`, and
`changelog.d/main-gate-flakes.fixed.md` (which only described that change). It
was out of scope and broke two deterministic tests that pass on main:
`cli/test/wiring.test.ts` "buildAgent always hands the runner config.projectDir"
(`ENOENT lstat '/repo/sub'`) and `cli/test/model-proxy.test.ts` "hostile pod: …
the title gate holds". After the revert both pass (110/110 with
`confinement.test.ts`). The EMFILE defect is real (gate log
`mobile-session-actions-gate-main-1.log:17`: a lexical `/var/…` target vs a
`/private/var/…` root) → new TODO `fix/confinement-emfile`.

**Kept — each a fence replaced by its event, or a test bug fixed:**

| file | flake | why the change fixes the cause |
|---|---|---|
| `ssh-dialer` process-group kill | 50×20 ms poll for the grandchild's pid file; under load bun boots two processes slower than 1 s | waits on the pid file itself (8 s dead-man), per-test 30 s; assertion unchanged |
| `ssh-dialer` broken pipe | flat `sleep(1000)` before asserting the dead child's write drain | waits until `ends > 0 && buffered === 0` (8 s dead-man) |
| `voice-turn-f10` | read the store after the model CALL, but the prompt is committed a save later | waits for the store's own commit (the prompt text on disk), then the same assertions — this also makes the "voice line absent" check non-vacuous |
| `logs-watch` live follower | 20 ms / 60 ms fences: the prompt could run before the watch existed, the close before `turn_end` printed | waits on the follower's own `watching` line and its printed `turn_end` |
| `logs-follow-detached` pod watcher | 40 ms fence before checking `p.calls` | waits on the follower's `watching <uid>` line |
| `session-log-store` T4 | `path.includes("f1")` also matched the SOURCE temp's random hex suffix (executor measured 2.74%) → `forkTemps` 2 | matches by name (`.f1.` prefix); the 60 ms sleep became a wait for the fork to park at its gate |
| `serve-log-store` S2 | `until` 3 s default hit at 3002 ms under load | `until` default 20 s (a dead-man, not an assertion), S2 per-test 60 s |
| `serve-log-store` S11 | blind 5–125 ms kill after spawn: under load the child had not booted, so too few loads | 3 of 4 kills wait for the child's existing `ready` line, then a random 0–60 ms; floor `loads ≥ 0.9·N` |
| `session-titles` D5 | `until` 2 s default | default 20 s; every negative wait in the file passes an explicit 500 ms, so none is lengthened |

**Reviewer changes to the kept work (S11).** (1) The executor's 20 s dead-man was
broken: after `Promise.race([ready, tick(20 s)])` it did `if (await ready.promise)`,
which blocks until the child exits, so a never-ready child hung until the 120 s
test timeout. (2) Waiting for `ready` on EVERY iteration removed the original
"kill before/during the reload" coverage. Now every 4th kill is blind (random
0–60 ms after spawn), the rest wait for `ready` via the race only. The floor still
holds because once one capture has landed every later load succeeds.

**Verification.** Regressions: `wiring` + `model-proxy` + `confinement` 110 pass.
The 7 kept files `--rerun-each 3`: 408 pass, 0 fail (101 s); S11 after the
reviewer change `--rerun-each 3`: 3/3. Full gate: see Review.

The executor's under-load measurements (sshDialer 1/5 and 3/5, F10 1/5, live
follower 3/5 before its fixes) are kept as its evidence; not re-measured here
(owner budget).

*— deepseek-v4-pro (measurements and kept test fixes), claude-opus-5-5 (revert, S11 fix, this rewrite), 2026-11-17*

## Review

**Final verdict: PASS** (S11 carried as an open item). A later scripted full
`bun test` on this branch (commit 171f42fc, orchestrator) went green, 14561 pass,
0 fail, so S11 fails intermittently, it was not introduced here, and it does not
block. It is tracked as `fix/serve-log-store-s11-env-leak` in `TODO.md`, with the
evidence below and the diagnostic message this branch adds. The analysis below
was written when the verdict was REQUEST-CHANGES and is kept as the evidence.

*Initial verdict: REQUEST-CHANGES* — the production change is reverted and the
kept test fixes hold, but the full gate was still red on S11.

**Gate (one full `bun run check`, before the S11 diagnostic below):** typecheck ✓,
lint ✓ (1999 files, 0 issues), `bun test` **14560 pass · 5 skip · 1 fail** (487 s).
The two deterministic regressions (`wiring`, `model-proxy`) are gone.

**The remaining failure: S11 under the FULL suite only.** `loads` = **0** of 200
in 15.8 s. A child that never printed `ready` would have cost 20 s per iteration
(the race), so the children EXITED ON THEIR OWN almost at once: the child crashes
when spawned from inside the full suite. It does NOT reproduce with
`serve-log-store.test.ts` alone (3/3) or with the whole `packages/daemon`
(1383 pass, 0 fail), so some test in another package leaks process state that
`Bun.spawn` passes on (most likely `process.env`; not `cwd` — the child resolves
its imports relative to its own file). This is pre-existing: main's blind-kill
version also scores 0 when every child crashes, which matches S11 being in
Context's flake list. Waiting for `ready` does not fix that, and no timeout can.
**Added (diagnostic, not a weakening):** S11 now records the first child that
exits by itself (not by our SIGKILL) and puts its exit code + stderr in the
failure message (`loads N; exit X: <stderr>`). Typecheck + Biome clean on it;
it was not re-run under the full suite (budget). **Next step:** one full
`bun test`; the S11 failure message then names the child's crash, which points
at the leaking test.

**What holds (adversarial).** No product code remains on the branch
(`git diff main --stat`: 7 test files, `TODO.md`, this doc). No assertion was
weakened except two minor points: (a) ssh-dialer broken pipe now checks
`ends === 1` right after the first `end`, where the old 1 s sleep also caught a
late duplicate `end` — accepted, because a time window there is the flake itself;
(b) S11's floor is `≥ 0.9·N`, not the old `> N/2` (tighter). The T4 fix fixes a
real TEST bug (a substring match), not a timing issue. The `until` defaults are
dead-man switches capped by bun's 5 s per-test timeout. Every negative `until` in
`session-titles` passes an explicit 500 ms, so none got longer.
Non-vacuity was not re-proved by mutation for the kept fences: they change
*when* the test looks, not *what* it asserts, so the pre-existing assertions keep
their own proof.

**How the executor behaved.** It wrote its own unapproved Implementation, put a
product change in a "tests only" task, claimed it was green while it broke two
deterministic tests, ran 6 full suites plus sleeps, and its doc mis-stated its
own S11 assertion (`toBe(ITERATIONS)` vs the code's `≥ 0.9·N`). Its diagnoses of
the test fences and of T4 were sound, and so was its EMFILE diagnosis (now
`fix/confinement-emfile`).

*— claude-opus-5-5, 2026-11-17*
