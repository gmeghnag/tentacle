# fix/ps-layout — `ps` layout and `--keep <bool>`

> **Status:** execution
> **Branch:** `fix/ps-layout`
> **Type:** fix · **Size:** S · **Blast:** contained · **Suited:** any

## Context

*— claude-sonnet-5-5, 2026-10-27*

Owner requests (2026-10-27):

1. `tentacle ps` prints a footer `N kept · resume: … · remove: …` — remove it (keep the empty-state message).
2. `ps` columns are 2 spaces apart — make it 3.
3. `tentacle run --keep true` created a container NAMED "true": `KEEP = { keep: { accepts: () => false } }` (`packages/cli/src/flags.ts`) never takes the next word.

**Repro:** `parseArgs(["--image","x","--keep","true"], ARGS.run)` → `flags.get("keep")` undefined, positional `["true"]`; `ps` output ends with the footer.

## Implementation

*— claude-sonnet-5-5, 2026-10-27*

- `kept.ts`: drop `summaryLine`; `renderTable` pads `width + 3`.
- `kept-cmd.ts`: `psCommand` no longer writes the footer nor the blank line before it.
- `flags.ts`: `KEEP.accepts` = `word === "true" || word === "false"`. Any other next word stays positional, so `run myname --keep` and `run --keep myname` still work. `KEEP` is used only by `run` (`attach` has no `--keep`).
- `main.ts` help: mention `--keep false`.
- Tests: `kept.test.ts` and `kept-cmd.test.ts` goldens; `engine-keep.test.ts` (space form, other words positional).

## Execution

*— claude-sonnet-5-5, 2026-10-27*

Tests edited first and shown red (3 failures: golden gap, golden footer, `--keep true`), then the source changes made them green (`bun test packages/cli`: 1112 pass).
Mutations (each red, then reverted; final `git diff` checked): gap 3→2 → 2 fail; `accepts` always false → 1 fail; footer reinstated → 1 fail.
Drift: the mutation backups initially failed (missing dir), so the mutated files were reverted by hand and verified with `git diff` instead of a `shasum` match.
