# feat/repro-workdir — one fixed place for every repro: `.tentacle/tmp/<slug>/`

> **Status:** done — merged 2026-10-17
> **Branch:** `feat/repro-workdir`
> **Size:** S · **Blast:** contained (Markdown only; a rule change, so a `feat`, AGENTS §10) · **Suited:** any model executes; standard Review

## Context

*— claude-opus-5-5, 2026-10-17*

`feat/reproduce-first-briefs` made the executor re-run a task's Repro before
editing, but did not say *where*. AGENTS mentioned `/tmp` in two places (§0
example, §6 TUI repro), and bun cannot resolve bare imports from `/tmp`. That
forced absolute `.bun/<pkg>+<hash>` paths, which drift on every dependency
change. The owner asked that all repros run in `<repo root>/.tentacle/tmp`, to
remove the ambiguity.

**Repro** (2026-10-17, run from `.tentacle/tmp/probe/`, then deleted):
- `import { ModelRequestError } from "@tentacle/providers"` → `workspace import ok function`.
- relative imports of react / ink / ink-testing-library from
  `packages/tui/node_modules`, plus `App.tsx` →
  `render(h(Box,null,h(Text,null,"hello")))` gives `"hello"`, and `App` is `function`.
- `.tentacle/tmp/probe.test.ts` containing a failing test → `bun test` still ran
  681 tests and the sentinel never appeared, so it was not discovered.
- `import "react"` from `.tentacle/tmp` → `Cannot find package 'react'`. React
  lives only in `packages/tui/node_modules`, hence the relative paths.

## Implementation

*— claude-opus-5-5, 2026-10-17*

### Load-bearing assumption

A repro under `.tentacle/` cannot affect the tree or the gate:
- `.gitignore` lists `.tentacle/`;
- `biome.json` sets `useIgnoreFile: true`;
- `tsconfig.json:28` `include` covers only `packages/*/{src,test}`;
- `bun test` discovery: proven by the Repro above.

### Design

- **AGENTS §6:** a new bullet. Repros always run in
  `<repo root>/.tentacle/tmp/<slug>/` (one folder per task, since evals run in
  parallel). Because the folder is gitignored, the script and its output are
  pasted into the doc's Repro.
- **AGENTS §6:** the TUI repro bullet is rewritten with relative imports. This
  replaces the drifting `.bun` absolute paths.
- **AGENTS §0:** the example becomes `.tentacle/tmp`.
- **The briefs and the template** point at AGENTS §6.

### Files

`AGENTS.md`, `docs/EXECUTOR-BRIEF.md`, `docs/REVIEWER-BRIEF.md`,
`docs/TASK-TEMPLATE.md`.

### Failure modes

- **A repro lost because the folder is gitignored:** covered by the
  "paste it into Repro" rule.
- **A repro that needs a pod or cluster:** the script still lives in
  `.tentacle/tmp`; only the target differs.
- **`<repo root>` vs `${PWD}`:** the rule says "repo root" because `PWD` depends
  on where the agent was launched.

### Tests

No code. The Repro above verifies the snippet AGENTS now prescribes.

## Execution

*— claude-opus-5-5, 2026-10-17*

- Applied the Design as written; no drift.
- Re-ran the exact §6 TUI snippet from `.tentacle/tmp/probe/` before writing
  it: it printed `"hello" function`. The probe folder was then deleted.
- `grep` finds no other `/tmp` or `.bun` reference in AGENTS or the briefs.
- Gate: Markdown only (§6), so there is nothing to run.

## Review

*— claude-opus-5-5, 2026-10-17 (in-context; the same model wrote it — allowed for `contained` S, AGENTS §10)*

**Verdict: APPROVE.**
- **Holds:**
  - every premise was proven empirically, not just read;
  - the new TUI snippet is shorter and no longer drifts with `+<hash>`.
- **Not verified:** Claude Code sub-agents have their own scratchpad. The rule
  binds them only if they are given AGENTS/the brief, which is already the case
  via `EXECUTOR-BRIEF`/`REVIEWER-BRIEF`.
- **Self-review caveat:** the author reviewed its own text.
