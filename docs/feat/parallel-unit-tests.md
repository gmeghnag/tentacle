# feat/parallel-unit-tests — Run the unit suite across cores

> **Status:** context
> **Branch:** `feat/parallel-unit-tests`
> **Size:** M · **Blast:** cross-module (the test gate every task depends on) · **Suited:** Opus plan → DeepSeek exec → fresh Opus review
> **Changelog:** none (dev/test-only)

## Context

**Problem.** The full unit suite is the slowest step of every gate: `Ran 17881 tests across 1253 files. [529.67s]`
(`.tentacle/tmp/mobile-open-long-session-gate-main.log`, 24/11) — ~9 min, run several times per task
(branch gate, fix rounds, the merge gate on main via `bun run check`). `bun test` runs every file in one
process; the machine has 14 cores. The owner (25/11) asked to speed tasks up; this is lever 4 of that
discussion (levers 1–3 were orchestration-only: two-simulator e2e gate, branch gates on touched
packages + changed e2e flows only, full unit suite only on the main merge gate).

**Goal.** `bun test` (and therefore `bun run check`) keeps meaning "the whole suite, same pass/fail
verdict", but finishes in a fraction of the time by running shards concurrently. Target: ≤ 3 min on this
machine, measured.

**Constraints.**
- Same verdict as today: every file runs exactly once; a failure anywhere fails the run with a readable
  summary (which shard, which file, the failing test output) — no lost or duplicated files, no swallowed
  exit codes.
- The test env guard (`bunfig.toml` preload `scripts/test-preload.ts` / `scripts/test-env-guard.ts`) applies
  to every shard; the opt-in env vars (`TENTACLE_K8S_SERVER`, `TENTACLE_DOCKER_TESTS=1`,
  `TENTACLE_SLOW_TESTS=1`) keep working.
- Tests that share global resources (ports, temp dirs, the HOME temp dir, sockets, file locks) must not
  collide across concurrent shards — find them, prove isolation or keep them in one shard.
- Deterministic (owner: AI-free automated gates are our strength): sharding stable across runs, flake
  rate not worse than today — measure it (e.g. 5 consecutive full runs).
- CI keeps working (`--filter '!@tentacle/mobile'` install); `bun test <path>` for a single file/dir
  unchanged for iteration (AGENTS §4).
- AGENTS.md §4/§6 updated if the meaning or timing of the commands changes (a rule-text change rides
  this branch).

*— claude-opus-5-5, 2026-11-25 (orchestrator)*

## Implementation

## Execution

## Review
