# feat/legacy-docs-migration — move pre-§10 docs into feat/fix/eval and fix stale statuses

> **Status:** done — merged 2026-10-17
> **Branch:** `feat/legacy-docs-migration`
> **Size:** S · **Blast:** contained (Markdown + one code comment; no behaviour) · **Suited:** any model executes; standard Review

## Context

*— claude-opus-5-5, 2026-10-17*

`docs/feat/task-workflow.md:59-64` left "migrate the legacy docs" as a
follow-up. The owner asked to read the remaining loose `docs/*.md` and fix them.

**Repro** (2026-10-17, `git grep` + reading each header against the code):
- `rename-to-tentacle.md` said "non implementato", while its own log said
  "implementato". `git grep -c agent-harness -- '*.ts' '*.tsx' '*.json'`
  returns nothing, so the rename is done.
- `tui-input-editing.md` said "in corso", but its log said "COMPLETO", and
  `App.tsx:19` imports `history.ts`.
- `steering-over-rpc.md` and `pod-ephemeral-binary.md` are not implemented,
  which is correct. `daemon/mapping.ts:104` still drops `steer`, and nothing in
  `packages/` unlinks the binary.
- `pod-attach-resilience.md` is not implemented: there is no keepalive or
  reconnect in `k8s`/`transport`. It had no TODO entry.
- `react-19-migration.md` is still open (React 18.3.1 / Ink 5.0.1). It had no
  TODO entry.
- `perf-resize-relayout.md` is done (`App.tsx:163-257`). It had no status line.
- `docs/eval/README.md` still said an eval lives "on branch `eval/<slug>`",
  which contradicts AGENTS §10.
- AGENTS §7 named the pod command `exec`. The CLI command is `attach`
  (`cli/src/main.ts:373`).

## Implementation

*— claude-opus-5-5, 2026-10-17*

### Design

Classification:

| Doc | → | Status |
|---|---|---|
| perf-resize-relayout, pod-binary-injection, pod-exec-attach | `feat/` | done |
| rename-to-tentacle (+ `-esecution` log) | `feat/` | done |
| tui-input-editing (+ `-esecution` log) | `feat/` | done |
| pod-attach-resilience | `feat/` | not started (follows `task-workflow.md:61`) |
| pod-delete-on-exit | `fix/` | done |
| steering-over-rpc | `fix/` | not started (a silent no-op defect, TODO Block 4) |
| react-19-migration, pod-ephemeral-binary | `eval/` | open |

These stay at the root, because they are references, not tasks: `BUILD.md`,
`F3-remote-control.md`, `F4-pod-execution.md`, `library-bugs.md`, the two
briefs and `TASK-TEMPLATE.md`.

How the docs are handled:
- Each moved doc gets a `> **Status:**` line, verified against the code, and a
  "legacy, not retrofitted" note. The old contradicting "Stato" lines are
  relabelled "Stato originale (superato)". Retrofitting the four sections is
  out of scope: `task-workflow.md:62` calls it busywork.
- Each `*-esecution.md` log is appended to its plan, so there is one doc per
  task. Nothing is deleted from the content.
- Every `docs/<moved>.md` reference is rewritten, including `cli/src/main.ts:372`.
  The historical record `task-workflow.md:60-61` is left as written.

### Failure modes

- **Broken links:** a final `git grep` shows no reference to an old path.

## Execution

*— claude-opus-5-5, 2026-10-17*

- Moved 10 docs with `git mv`, so history follows the files. Merged and deleted
  the 2 `-esecution` logs.
- Rewrote the links in `TODO.md`, `F4-pod-execution.md`, `library-bugs.md`, the
  moved docs and `cli/src/main.ts:372`.
- Fixed `docs/eval/README.md` and AGENTS §7 (`exec` → `attach`, two places).
- Added `TODO.md` Block 9 for the 3 open docs that were not indexed.
- **Not done (by choice):**
  - the Italian docs were not translated;
  - the four-section retrofit was not done;
  - the in-body text of `pod-ephemeral-binary.md` still says `exec`; its
    Status line notes the rename.
- Gate: see Review.

## Review

*— claude-opus-5-5, 2026-10-17 (in-context, same model — allowed for `contained` S)*

**Verdict: APPROVE-WITH-NITS.**
- **Gate:** `bun run check` passes typecheck, lint and test: 680 pass, 1 skip
  (the opt-in live-k8s test), 0 fail.
- **Links:** a `git grep` for every old path finds none outside the historical
  `task-workflow.md:60-61`.
- **Statuses:** each one was checked against the code (see Context), not taken
  from the docs.
- **Nit:** the moved docs keep their old internal shape and language (Italian),
  so they do not match the four-section template. The Status line marks them as
  legacy.
- **Self-review caveat:** the author reviewed its own work.
