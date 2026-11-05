# fix/resume-cancel-silent — Esc in the `--resume` picker exits silently

> **Status:** execution
> **Branch:** `fix/resume-cancel-silent`
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** Sonnet, standard Review

## Context

*— claude-sonnet-5-5, 2026-11-06*

Esc / Ctrl+C in the `--resume` session picker printed `[resume] cancelled`.
Owner decision (2026-11-05, option A): exit silently — no line at all, on both
paths (local and `connect --resume`). The exit code stays as today (local: `0`,
pinned by `tui-sessions.test.ts`; `connect`: `connectTui` resolves, no throw).

**Repro:** before the fix, the three updated tests fail on the assertion that
no line is written (`lines` / `out` / `write` calls contained
`"[resume] cancelled\n"`).

## Implementation

*— claude-sonnet-5-5, 2026-11-06*

- `packages/cli/src/session-resume.ts` (`cancelled` branch, ~l.103): `lines: []`.
- `packages/cli/src/connect.ts` (`resumeFirst`, ~l.235): drop the `write(...)`,
  still `return "cancelled"` (the caller returns before mounting the TUI).
- Failure mode: a failed `session/list` never reaches this branch (the plan is
  an error, not a pick), so no error is swallowed.
- Tests: `session-resume.test.ts` (`lines: []`), `tui-sessions.test.ts`
  (`out` empty, `{ exit: 0 }` kept), `connect.test.ts` (new: null pick →
  nothing written, TUI not mounted, resolves).

## Execution

*— claude-sonnet-5-5, 2026-11-06*

Tests edited first: 3 red on the "no output" assertion; fix applied: 99 pass
(the three files). Mutation: restoring the `write` in `connect.ts` turns the
new connect test red; reverted. Exit code untouched. CHANGELOG line added.
Gate: see the final report.

## Review

*— claude-opus-5-5 (orchestrator), 2026-11-06*

Standard in-context review (contained, S). Diff read: two one-line source changes (`session-resume.ts` `lines: []`, `connect.ts` no write), exit code untouched. Gate of the combined build (main + this + fix/cli-tests-terminal-clean): tsc/biome clean, 4742 pass, 3 skip, 0 fail. Live (installed binary, a real pseudo-terminal in the repo root with many sessions): `tentacle --resume`, Esc → no output line, `EXIT=0`. Executor's mutation (line restored in `connect.ts` → red) accepted. Verdict: PASS. Merged under the owner's one-night delegation (2026-11-06).
