# fix/autowake-unbounded — The detached relay's auto-wake has no limit

> **Status:** execution
> **Branch:** `fix/autowake-unbounded`
> **Size:** S · **Blast:** cross-module · **Suited:** a weaker model may execute; standard Review

## Context

*— claude-sonnet-5-5, 2026-11-06*

`docs/fix/detached-autowake.md` (review F1, decision Q-R1) gave the relay a cap of 20 wakes per relay (`RELAY_WAKE_LIMIT`), with a `wake limit reached` note, a grace-time exit and a `keep=false` veto. It was never released.

**Owner decision (2026-11-06):** the relay's auto-wake must be UNLIMITED, like the TUI. A legitimate poll loop (the agent re-checks a build through background jobs) must not stop at 20. The bad case (a model relaunching jobs forever) needs `--auto-accept`, and the user stops it with `tentacle stop` / `attach`.

**Repro:** a model that ends a background job on each of its first 25 calls. On the capped code the 21st call never comes: `bun test packages/cli/test/relay.test.ts -t R-W10` → `timed out waiting for every wake ran` (2026-11-06).

## Implementation

*— claude-sonnet-5-5, 2026-11-06*

### Load-bearing assumption

A pending wake still holds `exitPlan` (round 1): `relay-state.ts` `exitPlan`, the `model.wake.pending && rest === "idle" && !stopping && !linkStopped` row, now always `hold`.

### Design

Remove the cap, keep the rest of round 2: relay-only `runFinished`, the `ps` tie, no wake after a stop in a prepared hand-over, REVIEW-F (`exiting` blocks a wake under the removal's read), R-W11/R-W11b, `saveConfirmed` honesty.

- `relay-state.ts`: drop `RELAY_WAKE_LIMIT`, `RelayModel.wakes`, the `wake` flag of `turn_started`, `relayWakeCapped`; `wakeOwed` becomes `relayWakeDue`; the `exitPlan` cap branch is `hold`.
- `relay.ts`: drop `sayCapped`/`cappedSaid`, the post-loop capped note and the `wake: true` flag. The refusal give-back needed only the counter (`wakes - 1`): it goes, `wake_refused` still returns the turn to `over` and re-arms the wake.
- Tests: drop the cap tests (relay-state cap + counter tests, R-W10/b/c); add R-W10 "no limit" (25 consecutive job-exit wakes).
- Docs: the `[Unreleased]` CHANGELOG entry and `docs/attach-detach-behaviour.md` lose the cap. `docs/feat/detached-runs.md` has no mention.

### Files

`packages/cli/src/relay-state.ts`, `packages/cli/src/relay.ts`, `packages/cli/test/relay-state.test.ts`, `packages/cli/test/relay.test.ts`, `CHANGELOG.md`, `docs/attach-detach-behaviour.md`.

### Failure modes

A runaway wake loop now ends only by `tentacle stop` / `attach` (accepted by the owner). `stop` still blocks a wake (`relayWakeDue` is false when stopping); the exit plan for a stop is unchanged.

### Tests

R-W10: a model whose first 25 calls each end a job; all 26 calls run, the log has 25 `wake: background job exit` lines, no `detail`. Red on the capped code (stops at 21 calls).

## Execution

*— claude-sonnet-5-5, 2026-11-06*

As planned. R-W10 shown RED on the capped code (`timed out waiting for every wake ran`), green after. Gate: `bunx tsc --noEmit`, `bunx biome check .`, `bun test packages` — see the final report.
