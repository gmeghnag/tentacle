# feat/tui-brand-color — TUI accent → cyan

> **Status:** implementation (ready to execute)
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

*— <executor model-id>, <date>*

<!-- Qwen fills this: the edits actually applied, in order, the `bun run check`
result, the grep-guard output, and ANY drift from the Files section (and why).
If an old-string did not match, record that you stopped and what you found. -->

## Review

*— <reviewer model-id>, <date> (fresh context — executor was a weak model)>*

<!-- Fill after execution: re-run `bun run check` and the grep-guard; confirm the
single-source invariant (no stray hex, both paths read accentHex); eyeball a dark
terminal if possible; note how the executor behaved (clean mechanical apply? any
drift/corruption?). Cosmetic debt to note: the `CLAUDE`/`ACCENT` local consts are
now aliases to accentHex — a later cleanup may rename them. -->
