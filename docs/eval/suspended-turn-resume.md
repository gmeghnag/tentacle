# eval/suspended-turn-resume — a turn suspended on a permission survives a `serve` restart

> **Status:** split off on 2026-10-19 (owner decision) — implementation planned in the source doc(s) below
> **Branch:** none until promoted (then `feat/suspended-turn-resume`)
> **Type:** eval → feat · **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review

---

## Context

Parent: `docs/eval/session-reattach.md` (point 8, decision D). A pending
permission suspends its turn with **no timeout** until a human answers; the
owner requires that suspension to survive a `serve` restart. Two children
planned the same work independently — `daemon-side-persistence` Part B and
`permission-events` slice 7b — so it is one task, after both of them.

Until this lands, `daemon-side-persistence` Part A closes a turn suspended at
restart honestly as "not executed" (never as a denial nobody gave).

Decided constraints (parent): D4 — a permission asked inside a sub-agent is
not resumable (in-memory conversation); the sub-agent gets an explicit
"interrupted" result. D5 — "allow always" grants are lost on restart.
D1 — the restarted daemon is a new `epoch`, so clients resync.

*— claude-opus-5-5, 2026-10-19*

## Implementation

Planned, source-verified, in the two source docs — read both; this doc is
their single execution unit:

1. `docs/feat/daemon-side-persistence.md` — every item marked **[B]**
   ("Part B — `suspended-turn-resume`" in Design, Files, Tests; the
   `resumeFrom` prototype in Load-bearing assumption).
2. `docs/eval/permission-events.md` — "Slice 7b — suspension survives a
   `serve` restart" and its Files/Tests entries.

Where they overlap, reconcile in favour of the persistence doc's resume
mechanism (it carries the prototype evidence) and the permission doc's wire
(`permission_request` re-emitted with the **same** `requestId` after rebuild).
Depends on: `daemon-side-persistence` (Part A) and `permission-events` (7a).

## Execution

## Review
