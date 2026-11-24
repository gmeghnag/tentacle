# feat/image-old-on-demand — old user images become on-demand after 2 turns (slice 2 of image-on-demand)

> **Status:** context
> **Branch:** `feat/image-old-on-demand`
> **Size:** M · **Blast:** load-bearing (agent loop request projection, prompt-cache prefix, compaction interplay) · **Suited:** Opus plan; DeepSeek/Sonnet exec (owner: S/M → deepseek/sonnet); mandatory fresh-context Opus review
> **Changelog:** `changelog.d/image-old-on-demand.changed.md`

## Context

Decided in `docs/eval/image-on-demand.md` (GO-with-conditions; § Owner answers binding — read it all). Owner answer 2: «assolutamente, queste scelte di ottimizzazione sono quello che fa la differenza» — **old user images move to on-demand after N = 2 turns**:
- The images the user attached in the CURRENT turn (and the previous one, N = 2) stay always-sent.
- Older user images are replaced in the REQUEST (a projection, like prune: `packages/agent/src/agent.ts:1053-1060`) by a placeholder line naming the image and how to see it again with `image_view` (the tool of slice 1, `feat/image-view` merged a8de3bfc; `feat/image-files` a0921e4b added file images) — the session log and history are UNTOUCHED.
- Motivation (measured in the eval): ~100-round carry-over of old images and their re-encode on a prefix break.
- Slice 1's seams are the source of truth: the attachment store refs, `image_view(ref, detail)`, the per-provider image token estimate (`model.imageTokens`), `detail` low/high (`model.imageDetail`).

Constraints to verify against the code: the projection must be deterministic per turn so the prompt-cache prefix is stable (it changes only at a turn boundary, never mid-turn); a model without vision gets today's behaviour; pods/sub-agents without a store keep today's behaviour; compaction / context_reset / `/clear` interplay; the TUI/phone transcript keeps showing the images (it is a REQUEST projection only); the placeholder must not be copyable into a write (cf. the prune guard that refused a ⟪pruned by tentacle…⟫ placeholder in fs_multi_edit); the escape hatch `imageToolPolicy: inline` is NOT built pre-emptively (eval Q3).

*— orchestrator (claude-opus-5-5), 2026-11-24*

## Implementation

## Execution

## Review
