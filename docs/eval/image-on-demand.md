# eval/image-on-demand — let the model decide when to LOOK at an image

Type: eval · Size: — · Blast: cross-module (agent loop request projection, providers, tools, TUI/iPhone placeholders) · Suited: Opus

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Owner 23/11 ~12:45: «avrebbe senso permettere al modello di decidere da solo se "guardare" un'immagine?» → «sì, facciamo partire l'eval appena possibile».

Today (verified 23/11): tentacle never parses images itself (no OCR, no captioning). `model.images` (`packages/config/src/key-docs.ts:307`; OpenAI-compatible default false, anthropic true — `packages/providers/src/openai-provider.ts:55-73`) decides whether image blocks are SENT; with `true`, user attachments always go, and tool-result images (e.g. `pdf-images`) are inlined newest-first up to `maxToolImages`; with `false` PDFs leave placeholders and image prompts are refused. Scanned PDFs: no OCR («no extractable text — it looks scanned», `packages/core/src/pdf-text.ts:510-516`). The owner's default model is a local Qwen3.8 27B on llama.cpp with `images: true` (a local vision model is slow per image). `feat/smart-compaction` (contextPrune, ON in the owner's config, live A/B today 14:07) prunes old tool results with stubs — images are not covered yet.

Orchestrator's proposal discussed with the owner: (1) images the USER attaches in the current turn are ALWAYS sent (explicit intent; no extra round trip); (2) images from TOOLS (PDF pages, image files read from disk, browser screenshots) and OLD images in the history become a placeholder (what it is, size, where from) plus a tool `image_view(ref, region?)` the model calls to see it — with crop/zoom for dense pages. Benefits: tokens/latency (esp. local vision), context budget, prefix-cache stability, zoom. Risk: a weak model never looks — mitigate with descriptive placeholders and a system-prompt rule.

## The question to decide

Should tentacle adopt image-on-demand, in which exact shape (which images are always sent / on demand / pruned; the tool's contract incl. region and size caps; placeholders' text; how it composes with `maxToolImages`, `images:false`, `pdf-images`, contextPrune stubs, sub-agents, pods — the image bytes live on the laptop or in the pod? §7), what it costs vs saves (measure or estimate with the token-usage log on real sessions: how many image tokens are inlined and never referenced), what the owner sees (TUI/iPhone rows for an `image_view` call), and the failure modes (a model that never looks, a ref that no longer exists, a huge image, a non-vision model calling it). End with a verdict GO / GO-with-conditions / NO-GO, the smallest first slice, and owner questions each with a recommendation.

## Review

*— claude-opus-5-5, 2026-11-23*

**Verdict: GO-with-conditions.** Build image-on-demand as the shape of
pdf-images **S3**, which has not been built yet. Do not build it as a layer on
top of an inline-everything path. User images attached in the current turn stay
always-sent. Old user images move to on-demand only in slice 2, after an owner
decision.

### 1. What is true today (one correction to Context)

- **No tool image reaches the model today.** S1 (the provider seam) and S2
  (markers only) were merged. S3 (wire the bytes) **stopped at its
  load-bearing check** and was never executed (`docs/feat/pdf-images.md:906-959`).
  `fs_read` drops the PNGs: «Their PNGs stop here … until the tool has a sink
  (S3)» (`packages/tools/src/builtins.ts:208-217`). `ToolResult` has no
  `attachments` field (`packages/core/src/tool.ts:93-95`). The Context sentence
  "tool-result images (e.g. `pdf-images`) are inlined newest-first up to
  `maxToolImages`" describes what the provider *can* do
  (`packages/providers/src/images.ts:169-191`), not what happens. So the
  "tool images on demand" half of the proposal saves nothing today. Its value is
  that it **unblocks S3 and fixes S3's design** (§3).
- **S3's blocker.** `MAX_ATTACHMENTS_PER_MESSAGE = 5`
  (`packages/protocol/src/attachment.ts:29`) backs `ChatMessage.attachments` and
  the critical `media_message` log entry. One `fs_read` can produce up to 32
  images. S3 therefore needed either a cap of 5 per read or a protocol + log bump
  (owner decision (a)/(b), still open, `pdf-images.md:939-955`). **Image-on-demand
  removes this blocker.** `image_view` returns **one** ref per tool message, so it
  stays within 5, needs no schema change and no `PROTOCOL_VERSION` move.
- **User images:** the newest 5 distinct user refs are re-inlined on **every**
  request (`images.ts:25-26,139-161`). Older ones get a placeholder
  (`images.ts:434-435`). The history holds refs, never bytes
  (`images.ts:1-8`). Bytes are verified by sha256 at read time
  (`images.ts:391-399`).
- **Estimates:** `HeuristicTokenCounter` charges `IMAGE_TOKEN_ESTIMATE = 1600`
  per ref (`packages/core/src/token-counter.ts:43-45`,
  `packages/core/src/attachments.ts:130`). That figure also drives contextPrune's
  trigger.

### 2. Measured cost (owner's real stores, read-only)

Method: a Grep over `~/.config/tentacle/sessions` (51 projects) and
`~/.config/tentacle/daemon`. No file was modified and no content was printed
beyond ref metadata and `usage` numbers. The scratch script
`.tentacle/tmp/eval-image-on-demand/scan.ts` was not run (the bun run was
denied). The counts below come from Grep alone.

| Store | Sessions with images | Image refs | Where they sit |
|---|---|---|---|
| laptop `sessions/` | 1 | 1 PNG, 1.79 MB (2-message session) | user |
| `daemon/` (serve, mostly the phone) | 6 | 8 JPEG/PNG, 107 KB–4.97 MB | user |
| **tool messages anywhere** | **0** | **0** | (S3 not built, confirms §1) |

- **How often each image was re-sent.** For each image I counted the later
  `user`/`tool` messages in the same log. Each one ends a model request, so this
  is an upper bound on resends. The results were 102 and 100 (the two images of
  `de3ef43f`), 92 and 48 (`b8fb3bc0`), 50, 13, 2 and ~2. That totals **≈ 409
  image inclusions after the first send, for 8 images.** No session had more than
  2 images, so all of them stayed inside K = 5 and were re-sent every round.
- **Tokens per image on the owner's model (real).** Daemon session `15edb63b`,
  round 0, `Qwen3.8-27B-UD-Q6_K_XL`, user message with one 1.14 MB JPEG:
  `promptTokens 25542`, `cachedPromptTokens 22434`, `messages 2`. The uncached
  part is 3,108 tokens, and that covers the image plus the user's text. So
  **one image is ≤ ~3.1k tokens on Qwen3.8.** That is nearly 2× the 1,600 the
  counter assumes. Baselines with no image, same model, `messages 2`: 13,113–13,181
  tokens in laptop sessions (`07813345…`, `stale-taskrun-repro…`).
  Anthropic: about 1.6k at most for a 1568-px image, using the documented
  ≈ w·h/750 rule. The repo uses the same figure (`attachments.ts:126-130`); it was
  not re-verified live here.
- **What that means:** ≈ 409 × 1.6–3.1k ≈ **0.65–1.3 M prompt-token
  inclusions** across those sessions, and nearly all of them were served from the
  prefix/KV cache. **Today the real cost is not encode time.** It is (a) window
  space, 1.6–3.1k per image on every request for the rest of the session, and
  (b) a **re-encode on every prefix break**: compaction, a contextPrune batch
  that stubs a message before the image, or the 6th user image pushing out the
  oldest. A local vision encoder is slow per image.
- **"Inlined and never referenced"** cannot be measured from the log. Nothing
  records whether a later answer used the picture. The structural evidence: the
  two images in `de3ef43f` were attached at messages 6 and 10, and then carried
  through ~100 tool rounds of other work.
- **The scenario that matters is prospective: S3 as designed.** farmaquiz has
  ~27 images per 100 pages (`pdf-images.md:932-933`). With inline-all, the newest
  20 tool images go on every request (`images.ts:34`). That is 20 × ~3.1k ≈
  **62k tokens per request on Qwen**, larger than the owner's entire typical
  prompt (13–45k measured). Every 21st image also shifts the selection in
  mid-history (`images.ts:177-189`), which breaks the prefix and re-encodes up to
  19 images. On demand, the request carries only the pictures the model asked for.

### 3. The shape (answer to "which exact shape")

| Image | Policy |
|---|---|
| User attachment, current turn | **Always sent** (unchanged; explicit intent) |
| User attachment, older turns | Slice 1: unchanged (newest 5). Slice 2 (owner Q2): a placeholder with `image_view` after N turns, as a request **projection** like prune (`packages/agent/src/agent.ts:1053-1060`), so the history and log are untouched |
| Tool images (PDF pages, later image files and screenshots) | **On demand only**: put in the session store, never inlined by the producing tool. The marker carries a ref |
| `image_view` results | Ordinary tool results with 1 ref, inlined by the existing tool path (`images.ts:169-191,478-528`) under `maxToolImages`. Old ones age out with today's reason line, or get pruned by contextPrune (stub, no refs: `pdf-images.md:396`) |

**Tool contract (slice 1):** `image_view({ ref: string })`.
- `ref` is the id prefix printed in the marker (12 hex characters). It is
  resolved **only against this session's store**. An ambiguous prefix returns an
  error that lists the matching labels.
- The result is `content` = one label line (`p.3 · 640×480 · 212 KB · from
  fs_read report.pdf`) plus `attachments: [ref]`.
- Size caps are the existing ones: an entry point accepts ≤ 15 MiB, and the
  model's own cap is checked before any read (`images.ts:258-266,423-430`). A
  PDF PNG is ≤ 8 MiB per read.
- `region` (crop/zoom) is **not in slice 1.** `core/src/png.ts` is an encoder
  only (`png.ts:2`). A crop needs a PNG decode (zlib inflate, cheap) and, for
  JPEG, a decoder dependency. That is slice 3, with a cap on the output size
  (≤ 1568 px long edge).

**Marker text:** today's grammar `[image p.N · W×H]`
(`packages/core/src/pdf-images.ts:336-339`) gains `· ref a1b2c3d4e5f6` only when
a store exists. In a pod, with no vision or in a sub-agent, it stays as it is
now. The `fs_read` description (`builtins.ts:104`) gets one sentence: "call
`image_view` when a picture matters to the answer (diagrams, charts, scanned
pages); skip logos." The rule lives with the tool, not as a global system-prompt
line. A model without the tool never sees it.

**Composition:**
- `images:false` → the tool is not registered (the advertised tool list gates
  it on `imageLimits().vision`, `images.ts:287-296`) and markers carry no ref. A
  stale call after a model switch still gets the existing one-line reason
  (`images.ts:486-493`).
- `maxToolImages` keeps its meaning: how many *viewed* images stay inlined.
- `pdf-images` → S3 shrinks to "put the PNGs in the store, add a ref to the
  marker".
- contextPrune → `image_view` results are normal prune candidates outside the
  protected tail (`prune.ts:23-24,86`). The stub should say "image_view <ref> to
  see it again".
- Compaction → refs are already summarized as `[image: …]`
  (`packages/agent/src/compact.ts:43`).
- **Sub-agents** → `subagent.ts` passes no `attachments` source (only
  `contextPrune`, `subagent.ts:474-516`), so they get no tool and no ref. The
  parent can view.
- **Pods (§7)** → the tool runs in the pod, where the store is pod-side. A
  `client`-mode pod gets no store, hence no sink and no tool, **by
  construction** (`pdf-images.md:1200-1201`). The bytes never travel pod → laptop
  in v1. `LaptopImages` serves only ids the laptop itself added
  (`packages/client/src/laptop-images.ts:1-22`). A pod → laptop byte path stays
  the separate §7 task (`pdf-images.md` Q5).

**What the owner sees:** a normal tool row, `Image p.3 · report.pdf`. The TUI
needs one `toolSubtitle` case (`packages/tui/src/render-lines.ts:730-739`) and
the phone one `tool-summary.ts` case (`apps/mobile/src/tool-summary.ts:78`). An
unknown tool already falls back to the generic row, so nothing breaks without
these. No protocol change: `tool_call` and `tool_result` updates are generic.
Thumbnails are not in v1 (pdf-images Q6 already deferred them).

### 4. Smallest first slice: `feat/image-view` (S3 superseded)

Type: feat · Size: M · Blast: load-bearing (tool-result shape, the session
store gains a write path, agent loop) · Suited: Opus exec + fresh-context
Review.

Files, in dependency order:
1. `packages/core/src/model.ts`: an optional write `putComplete(bytes, meta) → ref`
   on the store side of `AttachmentSource`, typed so the provider cannot call it
   (S3 Review note, `pdf-images.md:1206-1208`).
2. `packages/core/src/tool.ts`: `ToolResult.attachments?` with ≤ 1 ref per
   result, which is far below the cap of 5. `ToolContext.images?` exposes the sink
   plus a lookup.
3. `packages/daemon/src/attachment-store.ts`: implement `putComplete` against the
   same 100 MiB budget (`attachment-store.ts:35`), deduplicated by sha256.
4. `packages/agent/src/agent.ts`: build `ToolContext.images` from
   `config.attachments` (no new factory hop, `pdf-images.md:962-973`), and copy a
   result's `attachments` onto the `role:"tool"` `ChatMessage`.
5. `packages/tools/src/builtins.ts` + `packages/core/src/pdf-images.ts`:
   `fs_read` puts the PNGs it already extracts into the store and adds the ref to
   the marker. A new `image_view` tool is registered only with a store and
   vision.
6. TUI / phone subtitle cases (presentation only).

**Tests (red first):**
- a PDF read with 6+ images produces **no** inline image and ≤ 0 refs on its
  message
- `image_view(ref)` puts exactly 1 image on the wire on both providers
- an unknown, foreign or ambiguous ref is an error result, and nothing is read
- no store (pod / sub-agent) or `images:false` → tool absent, markers without a
  ref
- a persistence round-trip of a tool message with 1 ref
- a prune stub over an `image_view` result carries no ref

### 5. Failure modes

| Mode | Convergence |
|---|---|
| **Weak model never looks** | A descriptive marker (page, size, position in the text) + the tool-description rule. Measure it: the acceptance re-runs the farmaquiz blind test with Qwen and counts `image_view` calls against image-dependent questions. If the rate is low, fall back per model with a config `images.toolPolicy: "inline" \| "on-demand"` (owner Q3) |
| **Ref no longer exists** (resume in the in-process worker: tool-put blobs are not on laptop disk, `packages/cli/src/laptop-blobs.ts:19`; store full) | An error result naming the cause plus the regeneration hint "fs_read <path> pages N again". PDF extraction is deterministic, so it yields the same sha256. **Verify with a test in slice 1** |
| **Huge image** | Existing caps before any read: 15 MiB entry, the model's cap gives a reason line (`images.ts:423-430`), PDF PNG ≤ 8 MiB. `region` is deferred, not faked |
| **Non-vision model calls it** | Not registered. A stale call gets the existing "does not take images" line (`images.ts:486-493`). Never an error loop |
| **Model views 20+ images in a loop** | `maxToolImages` ages out old views (reason line «read it again», `images.ts:521`). The step budget bounds the loop |
| **Hostile pod names a laptop id** | Out of reach in v1: a pod has no tool. User refs from a pod keep today's scope (the pod chooses only the id, `pdf-images.md:1020`) |
| **Counter underestimates Qwen images** (1600 vs ≤ 3.1k measured) | Not new, but it delays prune. Debt: a per-provider estimate (owner Q4) |

### 6. Owner questions (one at a time; each with a recommendation)

1. **Supersede pdf-images S3 with this slice?** This drops S3's open (a)/(b)
   decision and its protocol bump. **Recommendation: yes.** On-demand avoids the
   5-ref cap by construction and the 62k-token-per-request case, and it costs
   about the same files as S3.
2. **Old user images on demand (slice 2)?** **Recommendation: yes, after N = 2
   turns**, as a request projection (the log is untouched). It addresses the
   measured ~100-round carry-over and the re-encode on a prefix break. The image
   in the current turn stays always-sent.
3. **A per-model escape hatch** `images.toolPolicy` (default `on-demand`)?
   **Recommendation: yes, but only if** the Qwen farmaquiz acceptance shows it
   looks less than it should. Do not add it pre-emptively.
4. **Fix the image token estimate for local VL models** (3.1k measured vs 1600)?
   **Recommendation: yes, a small separate fix**, an `IMAGE_TOKEN_ESTIMATE` per
   provider, overridable via `model.imageTokens`. It is independent of this
   eval.
5. **`region` crop/zoom?** **Recommendation: slice 3**, PNG-only first (inflate is
   cheap). JPEG waits for a dependency decision.

**Unverified:** Anthropic's per-image token rule was taken from the repo comment
(`attachments.ts:126-130`), not re-checked live. The ≤ 3.1k figure for Qwen
includes the user's text in that message.


### Owner answers (2026-11-23)

*— claude-opus-5-5 (orchestrator), recording the owner, one question at a time*

1. **Supersede pdf-images S3 with `feat/image-view`: YES** («assolutamente d'accordo»). The (a)/(b) cap decision and its protocol bump are dropped.
2. **Old user images on demand after N = 2 turns (slice 2): YES** («assolutamente, queste scelte di ottimizzazione sono quello che fa la differenza»). The current turn's images stay always-sent; the log is untouched (request projection only).
3. **Per-model escape hatch (`imageToolPolicy: inline`): NOT now** — only if the Qwen farmaquiz acceptance (≈10 questions answerable only from an image; count `image_view` calls) shows Qwen skips looking (owner «ok», 23/11).
4. **Image token estimate per provider (`IMAGE_TOKEN_ESTIMATE`, overridable `model.imageTokens`; Qwen measured ≈3.1k vs 1600): YES, BUNDLED into `feat/image-view`** (owner: «metti insieme») — not a separate fix.
5. **`region` crop/zoom: slice 3, as TWO tasks** — PNG first (our PDF page images), JPEG second (decoder dependency decision) (owner, 23/11).
