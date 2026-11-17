# fix/mobile-crash-ibm-chart — iPhone app crashes (and crash-loops) on a session with a chart

> **Status:** context · implementation (executor: repro FIRST, then plan in Implementation, then fix — pre-approved, orchestrator 2026-11-17)
> **Branch:** `fix/mobile-crash-ibm-chart`
> **Size:** S–M · **Blast:** cross-module (mobile transcript) · **Suited:** Opus exec + fresh Opus review
> **Changelog:** `changelog.d/mobile-crash-ibm-chart.fixed.md`

## Context

Owner 2026-11-17 ~08:50, iOS build of main 32dcf4fb (published 08:47; includes mobile-tool-rows C S1–S3, open-at-end + row swipe, session-actions, model-charts C8, model-artifacts, hub H4b): "l'app ha crashato mentre stava lavorando sul graficarmi i valori azionari di IBM dell'ultimo mese".

Evidence (`.tentacle/tmp/ios-crash-ibm/`):
- 3 crash reports from the owner's iPhone, 08:50:43 / 08:50:54 / 08:51:00 → it crashes AGAIN on every relaunch (deterministic on that session's state). All: `EXC_CRASH SIGABRT`, `abort() called`, `lastExceptionBacktrace` = `objc_exception_throw` from the app binary on a dispatch queue — the React Native release-mode fatal path for an unhandled **JS exception** (RCTFatal), not a native crash. Frames unsymbolicated.
- `session.jsonl`: the serve daemon's log of that session (copied from `~/.config/tentacle/daemon/orchestration-43c37b40c7e5/949a98d0-….jsonl`). The turn finished fine daemon-side (turn_end 08:50:44). Its last turn: 3 `shell` calls, a **`replace` entry (critical, index 21 — a tool result replaced)**, then a `chart` tool call (line, 1 series × 21, title with an em dash), the chart result, the final assistant text, `usage` entries (new, non-critical, from token-usage-log).

Suspects to TEST, not assume: the new tool-steps view-model (mobile-tool-rows) on a `replace` of a tool message / a chart between steps; the chart row inside a step thread; open-at-end scroll on a row whose height changes; `usage` entries reaching the mobile mapping.

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Executor: AGENTS §1 — reproduce FIRST: feed this exact `session.jsonl` (and the live update sequence that produced it: the `replace` arrives as a `session/update` while the turn runs) through the app's pure modules (transcript/mapping/transcript-rows/tool-steps/chart parsing) in a test or a `.tentacle/tmp/mobile-crash-ibm-chart/` repro until it throws. Then: root cause in one sentence, minimal fix, regression test red→green, and a guard so ONE bad row can never take the whole app down (render-level error boundary around a transcript row that shows a small "couldn't display this item" row instead — the app must not crash-loop on reopening a session). Write the plan here before the fix.

## Execution

## Review
