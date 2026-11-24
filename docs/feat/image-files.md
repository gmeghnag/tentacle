# feat/image-files — `fs_read` of .png/.jpg/.jpeg gives the model the image (high only)

> **Status:** context
> **Branch:** `feat/image-files`
> **Size:** S–M · **Blast:** load-bearing (tool-result shape, the session store's tool-image path) · **Suited:** Opus plan + exec, fresh-context Opus review
> **Changelog:** `changelog.d/image-files.added.md`

## Context

Owner 24/11 («ok»): image files are not visible to the model today. `feat/image-view` (merged a8de3bfc, `docs/feat/image-view.md`) gives on-demand tool images (PDF pages) through `image_view(ref, detail low|high)`, but `fs_read` reads UTF-8 only (`builtins.ts:104,128`), so a .png/.jpg in the workspace never reaches the model. image-view's owner Q1 deferred image files until slices 3a (PNG decode) / 3b (JPEG decoder dependency) because `low` needs a decode to downscale.

This task brings image files forward WITHOUT a decoder: `fs_read` of a `.png` / `.jpg` / `.jpeg` puts the file into the session store through the SAME tool-image path as PDF pages (`putTool`, the 48 MiB sub-cap, refusal without eviction) and answers with the same marker/ref, so `image_view` shows it — **`high` only** (the original bytes; width/height read from the PNG IHDR / JPEG SOFn header, no pixel decode). A `low` request on such a ref says plainly that low is not available for this image yet and serves high (or refuses with a sentence — the plan decides, with a recommendation). `low` arrives with 3a/3b unchanged.

Constraints: reuse image-view's seams (no second image path); model caps (`images.ts` size limits, per-provider image token estimate `model.imageTokens`) apply unchanged; a file over the model's cap is refused with the existing reason line; a non-image or a corrupt header is refused with a sentence, never sent; no new dependency; Mac/phone parity statement (serve sessions too); a model without vision gets today's behaviour.

*— orchestrator (claude-opus-5-5), 2026-11-24*

## Implementation

## Execution

## Review
