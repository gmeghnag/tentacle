# fix/parallel-agents-followups — Wide permission labels, cap-line prefix

> **Status:** execution
> **Branch:** `fix/parallel-agents-followups`
> **Size:** S · **Blast:** contained · **Suited:** weaker model, standard Review

## Context

*— claude-sonnet-5-5, 2026-11-06*

Follow-ups (1) and (3) of the TODO entry "feat/parallel-agents follow-ups" (task 7 review). (5) is done elsewhere; the live `-np 2` checklist is not part of this task. No owner approval needed (orchestrator delegation 2026-11-06).

1. `permission-ui.ts` `permissionAgentLine` and `PermissionPrompt.tsx` `truncate` cut by UTF-16 length. A CJK / wide label is 2 cells per unit, so the row overflows the width Ink lays out, wraps, and the dialog is taller than `permissionPromptRows` says.
2. `wiring.ts` `slotsReader` logs `sub-agents capped at N at once…` through `options.log`; `main.ts` (plain REPL, one-shot) prefixes `log` with `[hook]`, so the line reads as a hook failure.

**Repro (2026-11-06, before any fix):** the two tests added below.
- `bun test packages/tui/test/permission-agent-line.test.tsx`: `cellWidth(permissionAgentLine(CJK×200, 40))` = 62 (max 37); the dialog frame with CJK detail/cwd/agent rows has 10 rows, `permissionPromptRows` says 7.
- `bun test packages/cli/test/parallel-agents.test.ts`: with `log` and `agentsNotice` both given, `log` received the cap line (expected `[]`).

## Implementation

*— claude-sonnet-5-5, 2026-11-06*

### Load-bearing assumption
`string-width` (via `cells.ts` `headCells`) measures what Ink lays out: `cells.ts:1-8` states it is the repo's rule for the status bar and input border.

### Preconditions
- `cells.ts:23` `headCells` already cuts at grapheme boundaries by cells.
- `main.ts` plain (`~1587`) and one-shot (`~1695`) are the only callers that prefix `log`/`notice` with a tag; `serve.ts:424,480` pass `log` as both `log` and `notice` (no prefix), so a `notice` fallback keeps the daemon log working.
- No AGENTS §7 invariant touched: pure helper + a display-only log option.

### Design
- (1) One helper `truncateCells(s, max)` in `cells.ts` (cut with `headCells(max-1)` + `…`). `permissionAgentLine` and the component's `truncate` both use it.
- (3) New optional `BuildAgentOptions.agentsNotice`; `slotsReader` writes to `agentsNotice ?? notice`. `main.ts` plain and one-shot pass `[agents] ` prefixed writers. Never `log` (hook failures).

### Files
`packages/tui/src/cells.ts`, `permission-ui.ts`, `components/PermissionPrompt.tsx`; `packages/cli/src/wiring.ts`, `main.ts`; tests; `CHANGELOG.md`.

### Failure modes
- Width ≤ 1: `truncateCells` returns `…` or empty, never a negative slice.
- A wide grapheme that would straddle the limit is dropped whole (the row may be one cell short, never over).
- No `agentsNotice` and no `notice` (tests, other callers): the line is dropped, as before when `log` was absent.
- Known limit: Ink's grid disagrees with string-width for some single-unit / ZWJ emoji (docs/library-bugs.md); not fixable here.

### Tests
- `permission-agent-line.test.tsx`: agent line ≤ width in cells; the dialog with CJK detail, cwd and agent row has exactly `permissionPromptRows(2,1,true,undefined,true)` rows.
- `parallel-agents.test.ts`: the cap line reaches `agentsNotice` and not `log`; `notice` is the fallback.

## Execution

*— claude-sonnet-5-5, 2026-11-06*

1. Wrote both regression tests; ran them on the old code: RED on the property (agent line 62 cells > 37; dialog 10 rows ≠ 7; `log` got the cap line).
2. (1) `truncateCells` in `cells.ts:54`-ish; used in `permission-ui.ts` and `PermissionPrompt.tsx` (local `truncate` removed). Tests green.
3. (3) `agentsNotice` option in `wiring.ts`; `slotsReader` takes the notice; `main.ts` plain + one-shot pass `[agents]` writers. The existing "capped at 1" test now passes `notice` instead of `log`. Green.
4. CHANGELOG: two `### Fixed` lines.
5. Gate (2026-11-06): `bunx tsc --noEmit` clean; `bunx biome check .` clean (after `biome check --write packages` fixed import order); `bun test packages` 4983 pass / 3 skip (opt-in) / 0 fail.

No drift from Implementation, except the round-2 fix below.

**Round 2 (orchestrator review, MEDIUM):** `worker.ts` (in-process TUI) and `wiring.ts` (nested build) pass only `log`, so `agentsNotice ?? notice` silently dropped the cap line there. Fallback is now `agentsNotice ?? notice ?? log`. Test extended (buildAgent with only `log` → the line arrives): RED first (received length 0), then green. Stray blank line after the CHANGELOG entries removed. Gate re-run: see result in the final report (tsc, biome clean; `bun test packages` all pass).

## Review

*— claude-sonnet-5-5, 2026-11-06*

Pending (standard in-context review by the orchestrator).
