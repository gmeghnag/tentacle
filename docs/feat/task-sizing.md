# feat/task-sizing — size & blast-radius on every task

> **Status:** done — merged to `main` (58b39f2) · status synced by audit 2026-10-19
> **Branch:** `feat/task-sizing`
> **Size:** S · **Blast:** contained · **Suited:** any model + standard review

## Context

*— claude-opus-4-8, 2026-10-16*

The task standard (AGENTS §10) said nothing about how big or how risky a task is.
That matters here because the codebase is worked by a MIX of models — a strong
one and a local Qwen3 27B — and the dangerous combination is a *high-reach*
change made by a *weak* model (the silent-breakage class we already hit:
`fs_edit` corruption, session poisoning). We want a cheap, objective label on
every task that (a) communicates scope and (b) routes execution/review by risk.

Decision (owner, 2026-10-16): size each task on **two independent axes** — effort
and blast radius — and derive who executes + how hard Review is.

## Implementation

*— claude-opus-4-8, 2026-10-16*

- **Size (effort):** `S | M | L`. No `XL` — an XL task is split into S/M/L
  sub-tasks (keeps "one legible branch").
- **Blast radius (reach if it breaks):** `contained | cross-module |
  load-bearing`, defined by *what it touches* — `load-bearing` anchored to the
  existing **AGENTS §7 invariants** (objective, so even a weak model can apply
  it mechanically).
- **Derived routing/review:** `load-bearing` (any size) or `L` → strong model +
  mandatory fresh-context Review red-teaming the §7 invariant; `contained` S–M →
  a weaker model + standard Review.
- Recorded as a one-line metadata block at the top of each doc and in the
  `TODO.md` index: `Type: … · Size: … · Blast: … · Suited: …`.

Why two axes, not one S/M/L/XL: effort and risk are orthogonal (a one-line RPC
peer change is S + load-bearing; a big isolated UI pile is L + contained).
Collapsing them hides the risk signal, which is the one we most need.

Files: `AGENTS.md` §10 (the two axes + the routing rule), `docs/TASK-TEMPLATE.md`
(the metadata line + an inline legend).

## Execution

*— claude-opus-4-8, 2026-10-16*

On branch `feat/task-sizing`:

- `AGENTS.md` §10: added the "Size every task on two independent axes" bullet
  (Size S/M/L, no XL→split; Blast contained/cross-module/load-bearing anchored to
  §7) and the "Blast radius gates who executes and how hard Review is" bullet.
- `docs/TASK-TEMPLATE.md`: added the `Size/Blast/Suited` line to the header block
  + an HTML-comment legend.
- This doc as the record (metadata applied to itself: S · contained).

**Drift:** none. Did **not** retrofit the metadata line onto already-closed task
docs (`task-workflow.md`) — deliberate; new/open tasks carry it. `TODO.md` index
retrofit to the `Type · Size · Blast · Suited` shape is a follow-up.

## Review

*— claude-opus-4-8, 2026-10-16*

Adversarial pass:

- **Gate:** docs-only (AGENTS + template + this doc); no TS/JS, Biome skips
  Markdown → `bun run check` unaffected; ran it: green.
- **Red-team:**
  - *Can a weak model actually apply `blast` consistently?* Mostly yes, because
    it is a checklist ("does it touch a §7 invariant? a protocol schema? a
    persisted format? the terminal/IO path?") rather than a vibe — which was the
    design goal. Edge cases (is a shared util "cross-module" or "load-bearing"?)
    resolve by erring upward: when unsure, label the higher blast (safer
    routing). Worth stating that tie-break — added implicitly via "a seam many
    depend on" = load-bearing.
  - *Self-review-in-context*, again — fine for this `contained/S` process doc; a
    `load-bearing` task would require the fresh-context Review this very change
    mandates.
  - *Does "no XL" lose information?* No — it converts an unhelpful label into an
    action (split), which the one-branch rule needs anyway.
- **Verdict:** holds. Follow-up: retrofit `TODO.md` entries to the metadata shape.
