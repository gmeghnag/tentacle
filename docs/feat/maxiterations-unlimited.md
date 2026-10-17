# feat/maxiterations-unlimited — allow `maxIterations: -1` (unlimited) for the main agent loop

> **Status:** context · implementation · execution · review · done
> **Branch:** `feat/maxiterations-unlimited`
> **Size:** S · **Blast:** contained (config surface only — `schema.ts` + `resolve.ts` + tests; the engine is unchanged) · **Suited:** a weaker model may execute; standard in-context Review (no §7 code invariant touched).

## Context

*— claude-opus-4-8, 2026-10-17*

**Why this exists.** The owner wants tentacle able to run as many tool rounds per
turn as the model needs — i.e. an *unlimited* iteration budget. The engine
**already supports this**: `packages/agent/src/agent.ts:173-174` reads
`maxIterations ?? 16` and maps `configured < 0 ? Number.POSITIVE_INFINITY`, with
the comment *"A negative limit means 'unlimited'"*. The sub-agent knob already
exposes it (`subagents.maxIterations: -1`, documented in `defaults.ts:90` and
tested in `resolve.test.ts:57`).

**The gap (evidence).** The **top-level** `maxIterations` cannot reach that path,
because the config surface rejects a negative value in two places:
1. **File schema** — `packages/config/src/schema.ts:69`:
   `maxIterations: z.number().int().positive().optional()`. `.positive()` rejects
   `-1`, so `"maxIterations": -1` in `config.jsonc` fails validation in `load.ts`
   (`FileConfigSchema.safeParse`).
2. **Env parser** — `packages/config/src/resolve.ts:161`:
   `parsePositiveInt(env.TENTACLE_MAX_ITERATIONS)` returns `undefined` for `-1`,
   so `TENTACLE_MAX_ITERATIONS=-1` silently falls back to the default (16).

So the capability exists in the engine but is unreachable from config — and it is
**inconsistent** with the sibling sub-agent knob, which already allows `-1`. Today
the only workaround is a large positive number (e.g. `100000`), which is a pezza.

**Decision (owner, 2026-10-17):** expose `-1` (unlimited) for the top-level
`maxIterations`, mirroring the sub-agent convention exactly. (Framed as a `feat` —
it exposes a capability via the config surface; the engine behaviour is unchanged.)

## Implementation

*— claude-opus-4-8, 2026-10-17*

### Load-bearing assumption

The config surface is the **only** thing blocking `-1`; everything downstream
already handles it. Verified end-to-end:
- `resolve.ts:160-164` passes `maxIterations` through **unclamped** to
  `ResolvedConfig`.
- `cli/src/wiring.ts:133` passes `config.maxIterations` straight to the agent.
- `agent.ts:174` maps any negative to `Number.POSITIVE_INFINITY`.
So fixing the two config gatekeepers (schema + env parser) is sufficient; no
engine change. (This assumption was *corrected* mid-planning: the first read
assumed only the schema blocked it — the env parser is a second gate.)

### Preconditions (verified)

- The sub-agent path already models exactly this: `schema.ts:76` uses
  `.refine((n) => n > 0 || n === -1, …)`, and `resolve.ts:189` uses
  `parseIterationLimit` (`resolve.ts:130-136`: integer `>0 || === -1`, else
  `undefined`). Both are the reuse targets — no new helper, no new pattern.
- `parsePositiveInt` is **shared** (also `contextWindow`, `resolve.ts:166`, where
  `-1` is meaningless), so it must **not** be changed globally — only the
  `TENTACLE_MAX_ITERATIONS` call site swaps to `parseIterationLimit`.

### Design

Two one-line changes + doc, mirroring the sub-agent knob:
1. `schema.ts:69` — replace `.positive()` with
   `.refine((n) => n > 0 || n === -1, "must be a positive integer or -1 (unlimited)")`
   (identical to the sub-agent `maxIterations` refine at `:76`).
2. `resolve.ts:161` — `parsePositiveInt(env.TENTACLE_MAX_ITERATIONS)` →
   `parseIterationLimit(env.TENTACLE_MAX_ITERATIONS)` (reuse the existing helper).
3. `defaults.ts` — annotate the generated `config.jsonc` `maxIterations` line with
   `// -1 = unlimited`, matching the sub-agent line (`:90`), so the written config
   is self-documenting.

### Files

- `packages/config/src/schema.ts` — the refine (1).
- `packages/config/src/resolve.ts` — the parser swap (2).
- `packages/config/src/defaults.ts` — the comment (3).
- `packages/config/test/resolve.test.ts` — tests (below).

### Failure modes

- *`0` or garbage silently accepted.* Guarded: `parseIterationLimit` rejects `0`
  and non-integers (→ `undefined` → fall through to default), and the refine
  rejects `0`. The existing "ignores 0 / abc" env test still holds and is extended
  to assert `-1` is now accepted (so the boundary is pinned both ways).
- *`contextWindow` accidentally allowed `-1`.* Designed out: only the
  `TENTACLE_MAX_ITERATIONS` call site changes; `parsePositiveInt` itself is
  untouched, so `contextWindow` still rejects `-1`.
- *Downstream clamp reintroduced.* None exists today (verified above); the engine
  maps negative → Infinity. No new clamp added.

### Tests (red-before-green)

- **Schema accepts `-1`** (`FileConfigSchema.safeParse({ maxIterations: -1 })
  .success === true`) — red on `.positive()`, green after the refine. Also assert
  `0` is still rejected (the refine's lower boundary).
- **Env `-1` resolves to `-1`** (`resolveConfig(ctx({ env: {
  TENTACLE_MAX_ITERATIONS: "-1" } })).maxIterations === -1`) — red on
  `parsePositiveInt` (falls back to default), green after `parseIterationLimit`.
  Extend the existing "ignores 0 / abc" test so `0`/`abc` still → default.
- **File `-1` passes through** (`resolveConfig(ctx({ fileConfig: {
  maxIterations: -1 } })).maxIterations === -1`) — pins the resolve pass-through.

Non-vacuity: each new assertion fails on the pre-change code (shown red), and the
mutation is the change itself (revert → red).

## Execution

*— claude-opus-4-8, 2026-10-17*

Exactly the Files list, no drift:
1. `schema.ts:69` — `.positive()` → `.refine((n) => n > 0 || n === -1, "must be a
   positive integer or -1 (unlimited)")` (identical to the sub-agent refine).
2. `resolve.ts:161` — `parsePositiveInt(env.TENTACLE_MAX_ITERATIONS)` →
   `parseIterationLimit(...)`. `parsePositiveInt` itself untouched (still guards
   `contextWindow`).
3. `defaults.ts:87` — generated-config comment now `// -1 = unlimited`.
4. `resolve.test.ts` — imported `FileConfigSchema`; the env test now also asserts
   `TENTACLE_MAX_ITERATIONS=-1 → -1`; a new test asserts file `-1` pass-through +
   `FileConfigSchema` accepts `-1` / rejects `0`.

**Verification:** narrow `resolve.test.ts` → 17 pass / 0 fail. Full gate
(`bun run check`) → typecheck ✓, lint ✓ (0 new), **650 pass / 1 skip / 0 fail**.

## Review

*— claude-opus-4-8, 2026-10-17 (same-model, in-context — contained/S, §10 permits standard Review)*

**Verdict: APPROVE.**

1. **Non-vacuity by mutation (§9):** restored the pre-change `schema.ts` +
   `resolve.ts` from `HEAD` under the new tests → **2 fail** (exactly the two `-1`
   assertions: the env `-1` case and the `FileConfigSchema` accept-`-1` case),
   restored the edits → **17 pass**, working tree byte-identical after. The two
   red-first assertions pin the real change; the file pass-through assertion is a
   guard (holds on both) and is labelled as such.
2. **Load-bearing assumption held:** config is the only gate — verified
   `resolve.ts` passes through unclamped, `wiring.ts:133` forwards, `agent.ts:174`
   maps negative → `Infinity`. The mid-plan correction (env parser was a *second*
   gate, not just the schema) is what made the fix complete; both gates now use
   the sub-agent convention.
3. **No over-reach:** `parsePositiveInt` left intact, so `contextWindow` still
   rejects `-1`; only the `TENTACLE_MAX_ITERATIONS` call site changed. `0`/garbage
   still fall back to the default (pinned).
4. **Honesty note (routing, §10):** same model as executor, fresh in-context only
   — acceptable for a `contained`/`S` task, weaker than a different-model
   reviewer. Nothing here leans on a §7 invariant.

**Residual / caveat:** with `-1` the per-turn iteration cap no longer bounds a
degenerate model loop (only `end_turn` / cancel / the not-yet-built anti-runaway
guard, TODO Block 1). This is the intended behaviour of the knob, documented for
the user.
