# feat/architecture-docs-folder — move the F3/F4 design docs into `docs/architecture/`

> **Status:** done — merged 2026-10-17
> **Branch:** `feat/architecture-docs-folder`
> **Size:** S · **Blast:** contained (Markdown + one code comment; no behaviour) · **Suited:** any model executes; standard Review

## Context

*— claude-opus-5-5, 2026-10-17*

After `feat/legacy-docs-migration`, the `docs/` root still held the two
subsystem design references, `F3-remote-control.md` and `F4-pod-execution.md`.
They are not tasks. The owner asked to move them into `docs/architecture/` and
update every reference.

**Repro:** `git grep -E "F3-remote-control\.md|F4-pod-execution\.md"` found 13
references across 8 files, including `packages/k8s/src/index.ts:4`.

## Implementation

*— claude-opus-5-5, 2026-10-17*

- `git mv` both files to `docs/architecture/`.
- Rewrite `docs/F3-remote-control.md` and `docs/F4-pod-execution.md` as
  `docs/architecture/…` everywhere. The two bare file names in
  `docs/feat/legacy-docs-migration.md:52,75` are a historical record and are
  left as written.
- Not moved: `BUILD.md` (a how-to, not architecture).

## Execution

*— claude-opus-5-5, 2026-10-17*

- Applied as planned; no drift. 7 files had their references rewritten.
- A final `git grep` finds no `docs/F3-` or `docs/F4-` path left.
- Gate: `bun run check` (see Review).

## Review

*— claude-opus-5-5, 2026-10-17 (in-context, same model — allowed for `contained` S)*

**Verdict: APPROVE.**
- **Gate:** `bun run check` is green.
- **Links:** no old paths remain. The two moved files contain no relative
  Markdown links that the move could break.
- **Follow-up (done, owner OK):** `ARCHITECTURE.md` §5 relabelled F4 as pod execution (the old label "compaction + persistence + permissions" contradicted the F4 doc; those shipped outside the numbering), linked both design docs, dropped the stale "F0 (current)".
