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

## Review
