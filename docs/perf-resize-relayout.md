# Non-blocking resize re-layout

## Problem (measured)

Every item's wrapped rows are cached per `(item identity, width, …)`
(`render-lines.ts`). A terminal **width** change invalidates every entry, so the
next render's `layoutTranscript` re-wraps the whole transcript synchronously on
the JS thread.

Measured on a realistic long session (584 items / 6277 rows,
`scratchpad/bench-relayout.ts`):

| event | cost |
|---|---|
| warm re-layout (all cache hits) | 0.1 ms |
| width change (cold re-wrap) | ~110 ms |

~110 ms is a visible freeze (the spinner timer and input starve behind it), and a
drag-resize fires many `resize` events → ~110 ms × N. Height-only (rows) changes
do **not** affect wrapping, yet today they also re-render at the same cost path
(cache still warm, so cheap — but they should commit instantly regardless).

Steady-state, scroll and Ctrl+O are already O(items + viewport) after the
windowed-layout work (`layoutTranscript`/`sliceLaid`) and the tool-only cache
scoping — resize is the last O(transcript) synchronous pass.

## Preconditions (verified)

- Only **width** is part of the row-cache key that a resize changes; a warm
  re-layout at the same width is ~0 (`itemRows`, `render-lines.ts`).
- Item layout is pure and the cache is keyed on item identity, so warming it
  off the render path and then committing the new size is race-free: the
  committing render just hits the warm cache.
- `stateRef.current.items` is read fresh at resize time; items are rebuilt
  immutably on updates, so a straggler laid out after the warm (a streaming tail
  that arrived during warming) is a cheap single miss at commit.

## Design

Replace the resize effect (`App.tsx`) with a coalescing, background-warming one:

1. On a `resize` event, read the target `{columns, rows}`.
2. **Height-only** (`columns` unchanged): `setSize` immediately — wrapping is
   unaffected, so the viewport must resize at once.
3. **Width changed**: bump a generation token, then warm the row cache at the new
   width in **time-budgeted chunks** (`warmRowsChunk`, ~6 ms/slice, yielding via
   `setTimeout(…, 0)` so the event loop — spinner, input — never starves). When
   the whole transcript is warm, `setSize(target)`; the committing render is then
   all cache hits (~0.1 ms). A newer resize bumps the token and supersedes the
   in-flight warm (coalescing the drag storm onto the latest size). Unmount /
   re-subscribe also bumps the token, so no `setState` fires after unmount.

During warming the screen keeps the old-width layout (cache-warm, instant). For a
huge session that is a sub-second transient of slightly-mis-fit wrapping instead
of a hard freeze; for a normal session the warm is a few ms (imperceptible).

## Files to change

- `render-lines.ts`: add `warmRowsChunk(items, opts, from, budgetMs): number` —
  lay out items `[from, …)` (populating the cache), stop after the budget, return
  the resume index (`=== items.length` when done). Pure except for the cache it
  warms.
- `App.tsx`: replace the resize `useEffect` with the coalescing/warming version;
  add a `warmGenRef` generation token.

## Tests

- `warmRowsChunk` (pure): a tiny budget lays out a prefix and returns a partial
  resume index; iterating to completion warms the whole transcript, after which a
  `layoutTranscript` at that width does **zero** markdown renders (spy) — i.e. the
  commit is freeze-free. Non-vacuity: the partial index is `< length`.

## Notes / debt

- **Initial paint** of a resumed long session is still one synchronous layout
  (~122 ms) — out of scope here (it is load, not resize); the same warm primitive
  could cover it later.
- Full visible-first virtualization (lay out only on-screen items, lazy `total`)
  would make even the warm unnecessary, but it reworks the scroll/selection model
  (absolute row indices) and is deliberately deferred — higher risk, and it
  collides with the in-flight input-editing branch's `App.tsx` changes.
