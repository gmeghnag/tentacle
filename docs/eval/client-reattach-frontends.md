# eval/client-reattach-frontends — connect / attach / run use the reconnecting client

> **Status:** split off on 2026-10-19 (owner decision) — implementation planned in the source doc(s) below
> **Branch:** none until promoted (then `feat/client-reattach-frontends`)
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review

---

## Context

Parent: `docs/eval/session-reattach.md` (child 8b). `client-reattach` (8a)
makes `RemoteClient` reconnect and resume, but stays inert until a frontend
passes it a channel factory. This task wires every runtime (`connect`,
`attach`, `run`, in-process worker) through it — keeping AGENTS §7's one
session path — and shows connection state in the Ink `StatusBar` (not
`StatusLine`). It absorbs Layer 2 (reconnect-and-resume) of
`docs/feat/pod-attach-resilience.md` (decision D9).

*— claude-opus-5-5, 2026-10-19*

## Implementation

Planned, source-verified, in `docs/eval/client-reattach.md` — every item
marked **[8b]** (Open question Q11, Design, Files item 11, Tests, Validation
"Manual (8b)"), plus Q7 (`StatusBar`), Q8 (401 via a fetch probe) and Q12
(pod-attach verdict). Depends on: `client-reattach` (8a).

## Execution

## Review
