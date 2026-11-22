# feat/e2e-parallel-gate — the mobile e2e gate on two simulators, one build

Type: feat · Size: M · Blast: cross-module (test infrastructure: `scripts/e2e-gate.sh`, `apps/mobile/e2e/run.ts`, orchestration launchers; no app/runtime code) · Suited: Opus plan → DeepSeek exec → Opus review + Opus live validation

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-22*

Owner 22/11 ~23:30: «ad oggi tutti i test UI mobile ci impiegano tantissimo tempo» → chose, of four proposals, **(1) two simulators in parallel** and **(2) one Release build reused** — «subito»; (3) affected-flows selection only as a TODO idea (`eval/e2e-affected-flows`).

Evidence: the last full gate `GATE PASS — 58 passed, 0 failed, 0 known-bug, 7 quarantined (of 65; 4221 s)` (`.tentacle/tmp/orchestration/runs/e2e-gate-2211c.log`) — ~70 min of flows, plus a Release `xcodebuild` (~10–15 min) per gate, run before every iOS publish (`run-gate-build-2211*.sh` → `scripts/e2e-gate.sh <udid>` → `bun apps/mobile/e2e/run.ts`). Two simulators exist on this Mac: iPhone 17 Pro `0FA4B51F-A0E3-421B-BE66-CE29EF45213D` and iPhone 17 Pro Max `0B43D716-9670-421A-BE51-9162004F2963`. `run.ts` already takes `--app <path.app>` (`run.ts:76-83`, install at `:811`) and `--only a,b` / `E2E_ONLY_FLOWS` (`:1545-1565`, `FLOWS` at `:1405`).

Goal: the SAME full suite (nothing skipped, same PASS/FAIL semantics, same summary + per-flow artefacts, same exit codes) in about half the wall time, by (1) building the Release app ONCE and installing it on both simulators, and (2) splitting the flows between the two, balanced by each flow's last recorded duration, each half with its own `serve`/port/mock model and its own Maestro device so the halves cannot see each other. One merged summary table and one exit code. A flow that depends on another flow's state must stay on the same shard (find out which, if any). Also: reuse the built `.app` across runs when the app inputs are unchanged (key it honestly — a JS change changes the Release bundle), so a task's `--only` shots and the publish gate do not each rebuild the same tree.

Constraints: the single-simulator form `scripts/e2e-gate.sh <udid>` keeps working unchanged (the launchers use it); the new form is opt-in (e.g. `scripts/e2e-gate.sh <udid1>,<udid2>`) and then the build launchers switch to it. Quarantined/known-bug semantics unchanged. Deterministic: no AI in the gate. Owner principle: deterministic test gates are our strength — the gate must not get weaker to get faster.

## Implementation

## Execution

## Review
