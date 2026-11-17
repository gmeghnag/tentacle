# feat/token-usage-log — Per-round token usage log

> **Status:** implementation (executor writes the plan, then executes — pre-approved within the bounds below)
> **Branch:** `feat/token-usage-log`
> **Size:** S · **Blast:** contained · **Suited:** DeepSeek plan + exec, Opus review
> **Changelog:** `changelog.d/token-usage-log.added.md`

## Context

Owner 2026-11-16: DeepSeek executor runs have burned ~8B input tokens and we cannot see where. We need, per model round, the token usage (input/prompt, output/completion, cached input when the provider reports it, model id) recorded so a run can be analysed afterwards (which rounds, which tool results, how the context grows). It also measures feat/smart-compaction (next task) before/after.

*— claude-opus-5-5 (orchestrator), 2026-11-17*

## Implementation

Pre-approved bounds (orchestrator, night delegation 2026-11-17 — the executor writes the §8 plan here FIRST, citing file:line, then implements it):
- Find where each provider returns usage (packages/providers) and where the agent loop finishes a round (packages/agent); carry the usage you find, do not invent numbers (absent ⇒ omitted, not 0).
- Record per round: round index, model id, input, output, cached input (if reported), and the context size/message count sent. Where: prefer a **non-critical** session-log entry type (unknown-type skip rule, AGENTS §7) or a per-session sidecar `<uid>.usage.jsonl` next to the session log — choose the smaller, cleaner one and justify it. NO critical entry, NO breaking protocol change (an additive display update or none at all), never rendering-only.
- A way to read it: a `tentacle logs`/`sessions`-style subcommand or flag that prints a per-round table + totals for a session (or for the last headless `-p` run), plain text, no colours when piped.
- Tests: usage captured from a fake provider stream; absent usage omitted; totals; the reader's output; the log/sidecar survives reload; unknown entry skipped by an older reader if you chose the log.

## Execution

## Review
