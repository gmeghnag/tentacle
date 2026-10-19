# feat/tui-brand-color — TUI accent → cyan

> **Status:** done — merged to `main` (f1df6bb) · status synced by audit 2026-10-19
> **Branch:** `feat/tui-brand-color`
> **Size:** M · **Blast:** cross-module · **Suited:** Phase 1 → a weaker model (Qwen3 27B) executes (design + sites + acceptance given; it makes and applies the edits); **Review by a stronger model / fresh context** (executor is weak). Phase 2 (OSC-11) → `load-bearing`, Opus-only, a SEPARATE task.

## Context

*— claude-opus-4-8, 2026-10-16*

For the public MIT release the TUI accent must drop the Anthropic trade-dress
orange `#d77757` and the barely-visible permission blue `#6377ff`, and become one
distinctive cyan: **`#06b6d4`** (dark terminals; light variant `#0891b2` for
later). Today the colour is **hard-coded in 6 places** plus two theme tokens, so
it drifts and a change touches many files. This task centralises it to ONE source
and swaps to cyan.

Scope split: **Phase 1** (this task now) = centralise + swap to cyan on dark,
safe and release-ready. **Phase 2** (deferred, separate task, NOT Qwen) = `theme`
config `auto|dark|light` + an OSC-11 terminal-background probe before Ink mounts
(that touches terminal ownership, AGENTS §7 → `load-bearing`).

## Implementation

*— claude-opus-4-8, 2026-10-16*

> **For the executor (Qwen):** this is yours to *do*, not transcribe. The plan
> gives the design, the sites, and the acceptance criteria; **you** read each
> site, make the edit that reaches the target state, and verify. Keep edits
> minimal and faithful to the Design; don't reformat unrelated lines. If a site
> doesn't look as described, reconcile it with the Design — or STOP and report if
> it's genuinely ambiguous; never retry with invented text. When done, run the
> Tests/Verification; `bun run check` must be green. Work only on this branch.

### Load-bearing assumption

There is **one source of truth** for the accent hex that *both* colour paths
read: a new `accentHex` constant in `theme.ts`. The chalk path uses
`chalk.hex(accentHex)`; the component path imports `accentHex` for `color=`
props. If both don't funnel through it, the colour re-scatters. (Everything below
enforces this.)

### Preconditions (verified)

- **Two colour-consumption paths** (why it's scattered):
  1. chalk stylers in `theme.ts` → used by `render-lines.ts` (`theme.claude("⏺")`
     at `:66`; `theme.accent` at `:239`,`:288`).
  2. Ink `<Text color={…}>` in components with hard-coded hex:
     `components/LineInput.tsx:13` `const CLAUDE = "#d77757"` (used `:37`),
     `components/Thinking.tsx:11` `const CLAUDE = "#d77757"` (used `:26`),
     `components/CommandPalette.tsx:11` `const ACCENT = "#d77757"` (used `:30`),
     `components/PermissionPrompt.tsx:6` `const ACCENT = "#6377ff"` (used `:41`,`:50`),
     `components/StatusBar.tsx:94` inline `color="#d77757"`.
- A chalk styler is a function, not a hex → it can't be an Ink `color=` prop;
  hence the shared raw `accentHex` constant.
- `chalk.hex(...)` exists (chalk is already imported in `theme.ts:11`).
- Components live in `packages/tui/src/components/`; `theme.ts` is
  `packages/tui/src/theme.ts` → import path from a component is `../theme.ts`.
- Removing the `claude` token is safe: its only use is `render-lines.ts:66`
  (changed below). If any `theme.claude` reference is missed, **typecheck fails**
  (the key no longer exists) — a built-in safety net, not a silent bug.
- Colour is **not frame-observable** in tests (chalk off + SGR stripped) → the
  regression net is a grep-guard + a tiny unit test on `accentHex`, not frames.

### Design

Phase 1: add `accentHex = "#06b6d4"` to `theme.ts`; collapse the two brand tokens
into one `accent = chalk.hex(accentHex)` (drop `claude`); point `render-lines.ts`
at `theme.accent`; in each component, import `accentHex` and set its local accent
const (or the inline prop) to it. Each component keeps its existing usage sites
unchanged — only the *value* now comes from the single source. (The local const
names `CLAUDE`/`ACCENT` stay as aliases to `accentHex`; renaming them is cosmetic
debt, see Review — do NOT rename now, it adds edits and risk.)

### Files — sites & target state

Seven files; the executor reads each and makes the edit that reaches the target
(keep usage sites intact where possible — only the *value* moves to one source):

- `theme.ts` — add `export const accentHex = "#06b6d4";` (after the `chalk`
  import); collapse the brand tokens to one — `accent: chalk.hex(accentHex)` —
  and **remove** `claude` (`:15`).
- `render-lines.ts:66` — the assistant bullet `theme.claude("⏺")` → `theme.accent`
  (the only `theme.claude` use; removing the token makes typecheck flag a miss).
- `components/LineInput.tsx:13` (`CLAUDE`, used `:37`), `Thinking.tsx:11`
  (`CLAUDE`, `:26`), `CommandPalette.tsx:11` (`ACCENT`, `:30`),
  `PermissionPrompt.tsx:6` (`ACCENT`, `:41`,`:50`) — in each: import `accentHex`
  from `../theme.ts` and make the local const resolve to it (keep the const name
  and its usages).
- `components/StatusBar.tsx:94` — inline `color="#d77757"`: import `accentHex` and
  use it there.

Target invariant: **no literal `#d77757`/`#6377ff` left under `packages/tui/src`**,
and every accent reads `accentHex`.

### Failure modes

- *Executor drift / corrupted edit:* old strings are short and distinctive and
  live outside repetitive regions → low risk; the "STOP, don't invent" rule and
  `bun run check` catch the rest.
- *Missed `theme.claude` site:* typecheck fails (key removed) — caught, not
  silent.
- *Import in the wrong place / `chalk.hex` typo:* lint/typecheck fail — caught.
- *Residual hard-coded hex:* the grep-guard below fails.

### Tests

- **Grep-guard (must return nothing):**
  `grep -rn "d77757\\|6377ff" packages/tui/src` → zero matches.
- **New unit test** `packages/tui/test/theme.test.ts`:
  ```ts
  import { expect, test } from "bun:test";
  import { accentHex, theme } from "../src/theme.ts";

  test("brand accent is the release cyan, single-sourced", () => {
    expect(accentHex).toBe("#06b6d4");
    expect(typeof theme.accent).toBe("function"); // chalk styler present
  });
  ```
- The existing TUI suite must stay green (it asserts structure, not colour).

## Execution

*— claude-opus-4-8, 2026-10-17*

All seven sites matched the plan exactly on first read (no STOP conditions).
Edits applied in the plan's dependency order:

1. **Precondition sweep (read-only):** `grep` over `packages/` confirmed the
   full inventory — 5 hard-coded hex (`#d77757` ×4, `#6377ff` ×1) at the exact
   plan sites, `theme.claude` used ONLY at `render-lines.ts:66`, `theme.accent`
   at `:239`/`:288` (kept), no other `rgb(215,119,87)`/`rgb(99,119,255)`
   scattered anywhere.
2. **Red first (§9):** wrote `packages/tui/test/theme.test.ts` (the plan's test
   verbatim) and ran it on the unmodified code → FAIL
   (`SyntaxError: Export named 'accentHex' not found`), exit 1.
3. `theme.ts` — added `export const accentHex = "#06b6d4"` (with a
   source-of-truth doc comment) after the `chalk` import; collapsed the two
   brand tokens to `accent: chalk.hex(accentHex)`; removed `claude`.
4. `render-lines.ts:66` — `theme.claude("⏺")` → `theme.accent("⏺")`.
5. `LineInput.tsx`, `Thinking.tsx`, `CommandPalette.tsx`,
   `PermissionPrompt.tsx` — in each: `import { accentHex } from "../theme.ts"`
   and the local const now resolves to it (`CLAUDE = accentHex` /
   `ACCENT = accentHex`); const names and all usage sites untouched.
6. `StatusBar.tsx` — import added; the inline `color="#d77757"` (line 94) is
   now `color={accentHex}`.
7. **Green + non-vacuity:** `theme.test.ts` passes (1 pass, 2 expect calls).
   Mutation check: temporarily set `accentHex = "#000000"` → test FAILED
   (non-vacuous), reverted → passes.

**Drift from the Files section (all cosmetic comments, no behaviour):** the
plan said not to touch unrelated lines, but the stale colour descriptions
*directly above* the edited tokens would have contradicted the new code, so
three one-line comments were updated in place: the `theme.ts` header
("claude orange, a blue accent" → "a single distinctive cyan"), the
`render-lines.ts` bullet comment ("claude-orange bullet" → "brand-accent
bullet"), and the `CLAUDE`/`ACCENT` const comments in `Thinking.tsx`
("Claude brand orange…" → "Brand accent (single-sourced in theme.ts)…)") and
`PermissionPrompt.tsx` ("Accent blue (matches…)" → "Brand accent (matches…)").
No other lines changed.

**Verification:**

- Grep-guard: `grep -rn "d77757\|6377ff" packages/tui/src` → **zero matches**
  (grep exit 1).
- `bun run check` → **green**: typecheck ✓, lint ✓ (baseline clean, 0 new),
  tests **635 pass / 1 skip / 0 fail** (the skip is the documented opt-in
  live-k8s test; the suite has grown since the §6 baseline of 540).

## Review

*— review subagent, 2026-10-17 (fresh context — executor was a different model)*

**Verdict: APPROVE.** Every §8 invariant holds; the change is exactly the
plan's Phase 1 — one source of truth, both colour paths reading it, no
Phase 2 leakage, no unrelated lines touched. Nothing needs fixing.

**Findings (all verified against the code, not the doc):**

1. **Gate re-run: green.** `bun run check` (typecheck → lint → test) passed:
   typecheck ✓, lint ✓ (clean, no new diagnostics), tests **635 pass /
   1 skip / 0 fail, 1975 expect() calls, 636 tests across 88 files**
   (the skip is the documented opt-in live-k8s test). Matches the Execution
   section's claim exactly.
2. **Grep-guard (scoped): clean.** `grep -rn "d77757\|6377ff" packages/tui/src`
   → zero matches (exit 1).
3. **Grep-guard (repo-wide, `*.ts/*.tsx/*.md`): only the task doc itself**
   mentions the old hex — Context/Implementation/Execution describe it as
   history (the old literals, the plan's site inventory, the grep-guard
   command text). **No code outside `packages/tui/src` carries the old brand
   hex.** Acceptable per the standard.
4. **Single-source invariant holds end to end:**
   (a) `accentHex` declared exactly once — `theme.ts:18`
   (`export const accentHex = "#06b6d4"`); it is the **only** `#06b6d4`
   literal under `packages/tui/src`.
   (b) `theme.accent: chalk.hex(accentHex)` at `theme.ts:22` — chalk path
   built from the source.
   (c) All five components import it from `../theme.ts`: `LineInput.tsx:4`
   (used at `:14` via `const CLAUDE = accentHex`), `Thinking.tsx:4`
   (`:12`, `CLAUDE`), `CommandPalette.tsx:10` (`:12`, `ACCENT`),
   `PermissionPrompt.tsx:4` (`:7`, `ACCENT`), `StatusBar.tsx:4` (inline
   `color={accentHex}` at `:95`). Import placement is consistent
   (after other imports, before module consts).
   (d) `theme.claude` fully gone: zero `theme.claude` / `claude:` matches
   under `packages/tui/src` and none anywhere in the repo's `.ts/.tsx`; the
   old `chalk.rgb(215,119,87)` / `chalk.rgb(99,119,255)` tokens are removed
   from `theme.ts` (confirmed in the diff).
   (e) `render-lines.ts` accent sites intact and sensible: the bullet now
   `theme.accent("⏺")` at `:66` (was `theme.claude`, the only use of that
   token); pre-existing `theme.accent` uses at `:239` (agent-type head `◆`)
   and `:288` (in-progress tool bullet) untouched — the diff only changed
   `:65`–`:66`.
5. **Red-team of the plan's failure modes — none triggered:**
   - *Drift/corrupted edits:* full `git diff main` of the 7 code files shows
     only the planned line changes plus the 4 stale-comment updates the
     Execution section disclosed in advance (theme.ts header,
     render-lines.ts bullet comment, Thinking.tsx + PermissionPrompt.tsx
     const comments). No reflowed unrelated lines, no corrupted strings.
   - *Missed `theme.claude` site:* none (finding 4d); typecheck green.
   - *Wrong import placement / `chalk.hex` typo:* none; typecheck + lint
     green.
   - *Residual hard-coded hex:* none scoped (finding 2); no other brand
     hex (`#06b6d4`) outside `theme.ts:18`.
6. **Test non-vacuity (§9): mutation check performed and it holds.**
   `theme.test.ts` asserts both properties — `accentHex === "#06b6d4"`
   **and** `typeof theme.accent === "function"` (chalk styler present), not
   just a correlate. Mutated `theme.ts` `accentHex` → `"#123456"`:
   `bun test packages/tui/test/theme.test.ts` **FAILED**
   (`Expected: "#06b6d4" / Received: "#123456"`, 0 pass / 1 fail). Reverted:
   **1 pass / 2 expect() calls** — and the working-tree `theme.ts` diff vs
   `main` is byte-identical to the pre-mutation state (revert verified by
   diff). The test pins the property, not the weather.
7. **Scope check: the diff is exactly this task.** `git diff main --stat`
   → 7 code files + the task doc (315-line doc churn is the pre-existing
   "reshaped to the task standard" commit + this Review, not executor work).
   No `theme` config, no OSC-11 probe, no terminal-ownership change (Phase 2
   correctly deferred), no unrelated refactors. The plan said to **keep** the
   local const names `CLAUDE`/`ACCENT` (cosmetic debt) — they were kept
   (`LineInput.tsx:14`, `Thinking.tsx:12`, `CommandPalette.tsx:12`,
   `PermissionPrompt.tsx:7`), exactly as instructed.
8. **Behavioural regression risk: low, and the suite confirms it.** The TUI
   suite alone: **224 pass / 0 fail, 884 expect() calls, 22 files**.
   `grep` across `packages/tui/test` for the old hex, the new hex, and the
   old `rgb(...)` tuples: the only hit is `theme.test.ts:5` itself (the new
   test); no TUI test asserts on the old colour literals or SGR sequences,
   consistent with the plan's "colour is not frame-observable in tests"
   premise. Residual risk: actual on-screen hue is verified only by the
   grep-guard + unit test, not a rendered frame — inherent to the harness,
   noted by the plan; a dark-terminal eyeball before release is still the
   honest final check (could not be done in this environment).

**What holds:** the load-bearing assumption (one hex both paths read), the
target invariant (zero old hex under `packages/tui/src`), all acceptance
criteria, test non-vacuity, and scope discipline.

**What doesn't / caveats:** nothing broken. Cosmetic debt as the plan
accepted: `CLAUDE`/`ACCENT` local consts are now aliases to `accentHex`
(kept deliberately — a later cleanup may rename them). The 4 comment
updates are a tiny, disclosed, behaviour-neutral drift (stale colour
descriptions that would have contradicted the new code) — within the
spirit of the plan, not a violation.

**Executor behaviour:** clean mechanical apply. All 7 sites matched the
plan on first read (no STOPs, no invented text), edits in the plan's
dependency order, red-first test step performed as prescribed, drift
disclosed honestly and up front, verification claims in the Execution
section reproduce exactly on re-run (gate counts, grep-guard, mutation
check). No drift beyond the disclosed comment fixes; no corrupted edits.
