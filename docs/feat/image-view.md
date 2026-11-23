# feat/image-view — the model looks at images on demand (slice 1 of image-on-demand)

Type: feat · Size: M · Blast: load-bearing (tool-result shape, the session store gains a write path, agent loop) · Suited: Opus plan, executor, fresh-context Opus review

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Decided in `docs/eval/image-on-demand.md` (verdict GO-with-conditions; read it ALL, incl. «### Owner answers» at the end — those are binding). Slice 1 = this task: it SUPERSEDES `docs/feat/pdf-images.md` S3 (owner Q1); tool images (PDF pages extracted by `fs_read`, image files) go into the session's attachment store and the text keeps a marker with a ref; a new `image_view(ref, detail?: "low"|"high")` puts exactly ONE image on the wire (default `low` ≤ 768 px long edge, `high` ≤ 1568 px), with a manual setting `model.imageDetail: "auto"|"low"|"high"` (auto = the model chooses); the per-provider image token estimate (`IMAGE_TOKEN_ESTIMATE`, overridable `model.imageTokens`; Qwen measured ≈3.1k vs 1600) is BUNDLED here (owner Q4). Not in pods, not in sub-agents, not with `images:false`. Images the USER attaches in the current turn are unchanged (always sent). Later slices (NOT here): 2 old user images on demand after 2 turns; 3a `region` PNG; 3b `region` JPEG. Escape hatch `imageToolPolicy: inline` only if the Qwen acceptance shows it is needed.

Execution order (owner): runs after `feat/mobile-native-sheets` merges; `feat/workflows-ui` is running in parallel (core/protocol/daemon/client/cli/tui) — list any file both touch and how to avoid a conflict.

## Implementation

## Execution

## Review
