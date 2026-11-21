# fix/mobile-project-first-tap — a just-paired project reads "Offline" until its first probe lands

Type: fix · Size: S · Blast: contained · Suited: DeepSeek exec + Opus review

## Context

QA sweep 2026-11-21 (`.tentacle/tmp/mobile-qa-1121/REPORT.md` row 13, simulator, main 63d76f3e):
for ~1–2 s after pairing (and, by the same path, on a cold start) a project row shows
"Offline · None of its projects answers" although the daemon answers — the first status probe
has not landed yet. A tap in that window hits `App.tsx` ComputersRoute `onOpen` → `row.state ===
"unreachable"` → `setTick` (a silent re-probe, "mockup A3") and does NOT open the sessions; a
second tap works. Collateral: `scripts/e2e-gate.sh` went from known reds to **40 FAIL**, every one
failing on that first tap after pairing — the gate is blind until this is fixed.
Root cause (to confirm with a red test first): "no probe result yet" is projected as
`unreachable` instead of its own state.
*— claude-opus-5-5 (orchestrator), 2026-11-21*

## Implementation

- **Load-bearing check:** find where a row's `state` is computed (`apps/mobile/src/computer-rows.ts` /
  `computer-status.ts`, the pure view-model) and prove with a unit test that a project with NO probe
  result yet is projected as `unreachable` (red).
- **Design:** a distinct `checking` state for "not probed yet" (copy: a neutral "Checking…", no
  dashed/offline styling — colour-blind rule: the state is WRITTEN, never hue only). A tap on a
  `checking` row is not dropped: it waits for that probe (bounded, e.g. ≤ 5 s) and then opens if the
  probe says ok, else falls to today's unreachable behaviour. Keep the logic in the pure module
  (AGENTS §7 "logic in pure modules"); `App.tsx` only wires it.
- **Failure modes:** probe never answers (bounded wait → unreachable, no hang); probe fails; two taps
  during checking (one open only); row removed/revoked while waiting; app backgrounded mid-wait.
- **Tests:** red-first unit tests on the view-model (no probe → checking; ok → ok; fail → unreachable);
  the tap-while-checking decision as a pure function with its cases; mutation: project "no probe" as
  unreachable again → red. Then run `scripts/e2e-gate.sh` is NOT required of the executor (simulator) —
  the orchestrator runs it.
- Changelog fragment: `changelog.d/mobile-project-first-tap.fixed.md`.

## Execution

## Review
