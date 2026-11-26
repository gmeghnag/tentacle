# fix/tui-accidental-copy

> Created by the reviewer: the branch shipped NO task doc (AGENTS §10). The
> executor must fill Context / Implementation / Execution (with the Repro and
> red-before-green evidence) above this Review.

## Review

**Verdict: REQUEST-CHANGES** (code is sound; one process gap, one residual path).

Scope: `git diff main...HEAD` (00b9ffa6), 11 files.

### Findings

1. **MEDIUM — no task doc, no TODO entry, no red evidence** (AGENTS §10, §4, §9).
   `docs/fix/tui-accidental-copy.md` did not exist and `TODO.md` has no item, so
   there is no Context/Repro, no Implementation (failure modes) and no recorded
   red run of the new tests on the buggy code. Fix: write the doc (Repro on
   `main`, plan, as-built) and index it.
2. **MEDIUM — a 1-row vertical jitter still overwrites the clipboard**
   (`packages/tui/src/selection.ts:74-76`). `isDeliberate` demands ≥3 cells
   horizontally but accepts ANY row change. A cell is ~2× taller than wide, and
   a press near a row boundary needs only a 1-px downward jitter to emit one drag
   report on the next row: anchor (r,c) → head (r+1,c) is "deliberate", and the
   release copies the rest of row r plus row r+1's prefix (≈ a full row) — the
   exact bug this task fixes, via the other axis. Suggested: treat a row change
   as deliberate only when the reading-order extent is also non-trivial (e.g.
   |Δrow| ≥ 2, or |Δrow| = 1 with the head ≥ COPY_MIN_CELLS past the anchor's
   column in reading order), or owner confirms the asymmetry is accepted; pin it
   with an integration test (press (x,y), drag (x,y+1), release).

### Gate
- Touched tests: `accidental-copy`, `mouse-stream`, `app`, `selection` — 165 pass / 0 fail.
- `bun run lint`: clean (2709 files).
- `tsc --noEmit`: 23 errors, ALL in files this branch does not touch
  (`apps/mobile/src/highlight.ts`, `agent/.../a2a-map.ts`, `cli/test/a2a-wiring`,
  `cli/test/serve-mcp-e2e`) — a worktree type-resolution issue, not this diff;
  0 in `packages/tui`. Full `bun run test` not run by the reviewer.

### Mutation (non-vacuity, all reverted; `git status` clean after)
- M1 release copies any selection (drop `isDeliberate`) → 2 fail (integration 2-cell click, dispatch test). ✔
- M2 confirmation via `pushNotice` instead of `onCopied` → 2 fail (scroll-offset-unchanged, transient). ✔
- M3 row change not deliberate → 1 fail (pure rule only; no integration test pins a vertical-only drag — see finding 2).

### Attacks tried
- Other copy paths: `copySelection` is emitted only at `mouse-stream.ts:343`; `useMouse.ts:136` still guards empty. Holds.
- Release at a different cell without a drag report: selection is set only by press/drag, so a release never extends it. Holds.
- Non-deliberate release leaves a stale highlight? No: state → `selection: null`, applied at `useMouse.ts:266`. Holds.
- Status-bar note moving the transcript: pinned by the multi-row test (body + "↑N more" unchanged). Holds.
- Timer after unmount: only `setState` (no-op in React 18); not cleared on unmount, acceptable.
- §7 invariants: no protocol, persistence, broker or raw-terminal write touched; logic is in pure `selection.ts`/`mouse-stream.ts`, components only render. Holds.

### Nits (not blocking)
- `copiedLabel(text.length)` counts UTF-16 units ("😀" = 2 chars).
- New tests sync on fixed `delay()`s (§9), matching the existing `app.test.tsx` style.

Reviewer: same model family as a likely Opus executor — fresh context only; shared blind spots possible.

*— claude-opus-5-5, 2026-11-26*
