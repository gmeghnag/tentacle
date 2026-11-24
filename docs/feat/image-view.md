# feat/image-view — the model looks at images on demand (slice 1 of image-on-demand)

Type: feat · Size: M · Blast: load-bearing (tool-result shape, the session store gains a write path, agent loop) · Suited: Opus plan, executor, fresh-context Opus review

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Decided in `docs/eval/image-on-demand.md` (verdict GO-with-conditions; read it ALL, incl. «### Owner answers» at the end — those are binding). Slice 1 = this task: it SUPERSEDES `docs/feat/pdf-images.md` S3 (owner Q1); tool images (PDF pages extracted by `fs_read`, image files) go into the session's attachment store and the text keeps a marker with a ref; a new `image_view(ref, detail?: "low"|"high")` puts exactly ONE image on the wire (default `low` ≤ 768 px long edge, `high` ≤ 1568 px), with a manual setting `model.imageDetail: "auto"|"low"|"high"` (auto = the model chooses); the per-provider image token estimate (`IMAGE_TOKEN_ESTIMATE`, overridable `model.imageTokens`; Qwen measured ≈3.1k vs 1600) is BUNDLED here (owner Q4). Not in pods, not in sub-agents, not with `images:false`. Images the USER attaches in the current turn are unchanged (always sent). Later slices (NOT here): 2 old user images on demand after 2 turns; 3a `region` PNG; 3b `region` JPEG. Escape hatch `imageToolPolicy: inline` only if the Qwen acceptance shows it is needed.

Execution order (owner): runs after `feat/mobile-native-sheets` merges; `feat/workflows-ui` is running in parallel (core/protocol/daemon/client/cli/tui) — list any file both touch and how to avoid a conflict.

## Implementation

*— claude-opus-5-5 (planner), 2026-11-23*

**Status: NOT approved yet.** The owner approves this plan (§10) before Execution starts.
**Re-size note:** this is **L** by file count (core, providers, daemon, agent, tools, config,
cli, tui, mobile). It stays one branch because no part ships value alone. Blast stays
`load-bearing`, so a strong executor and a fresh-context Review are required.

### Load-bearing assumption

**The bytes `image_view` puts on the wire are exactly ONE ref per call. The tool chooses
that ref from variants whose pixel size was fixed when the image was extracted. The
provider reads the ref from the same per-session store the tool wrote it to. No step in
between can add a ref, cut a list, rescale the image, or read a different store.**
Each link of that chain, verified:

1. **The provider has one byte source.** It is the session's `AttachmentStore`:
   `session-host.ts:1573` creates `uploads`, which is passed as `attachments` at `:1594`
   (and again at `:1685` on a settings rebuild). From there it goes `serve.ts:229` /
   `worker.ts:95` → `wiring.ts:1022` → `AgentConfig.attachments` (`agent.ts:611`) →
   every request (`agent.ts:1550,1889,2049`) → `readSelected` (`providers/src/images.ts:361-402`).
   That function verifies the length and the sha256 before inlining anything (`:393-398`).
   The tool must write to **this same object**. The plan passes it a second time, under a
   write-capable type (D1), from the same two `session-host.ts` sites. A tool write therefore
   cannot land anywhere the provider does not read.
2. **The wire inlines tool refs only through the tool selection:** `selectToolImageIds`
   (`images.ts:169-191`) under `maxToolImages` (default 20, `:34`), then the request-wide
   budget (`:208-256`), then `toolResultImages` (`:478-528`). The provider never resizes.
   The model's per-image cap is checked before any read and gives a reason line
   (`:423-430`). So the pixel size that reaches the model is the stored variant's size, or
   a placeholder.
3. **"A cut ref list" is impossible by construction.** `AttachmentsSchema` allows ≤ 5
   refs (`protocol/src/attachment.ts:29,75-78`) on the wire (`protocol/src/session.ts:205`)
   and in the critical `media_message` entry (`protocol/src/session-log.ts:173`). This
   cap is why pdf-images S3 stopped (`docs/feat/pdf-images.md:919-937`). This plan never
   builds a list: `ToolResult` gains a **singular** `image?: AttachmentRef` (not an array).
   `toolMessage` (`agent.ts:280-292`) turns it into `attachments: [image]`. `fs_read`
   results carry **0** refs: their refs are text in the marker. So no message this
   feature writes can exceed 1 ref, and the type checker enforces it. No
   `PROTOCOL_VERSION` move, no `protocol.d/` note, no log change. The schema already
   accepts refs on any role (`protocol/src/model.ts:20-27`: the "user only" comment is
   not enforced).
4. **The image's detail is bounded at extraction, not at view.** `createImageCollector`
   already box-downscales each kept picture to `maxEdge = 1568`
   (`core/src/pdf-images.ts:299-307,464-485`). D3 adds a second downscale of the same
   decoded pixels to `768` at the same point, while the pixels exist (they are dropped
   right after `add`, `:421-422`). Each variant is its own content-addressed blob.
   `image_view` only **chooses** a variant. No decoder is needed, and `region` stays
   slice 3.
5. **Permission asks: `image_view` raises none, so there is no ask detail to bound or
   truncate.** The tool is `permission: "none"`, like `fs_read` (`builtins.ts:106`), and
   the gate returns before the broker for `"none"` (`agent/src/permission-gate.ts:213-215`).
   The broker, the TUI permission view and the iPhone `PermissionSheet` are never reached.
   The one exception is a user hook that forces `ask` (`:210-213`). Then
   `describeToolCall` (`:33`) falls to its generic branch, and the request's `input` is
   `{ref, detail}`. Both fields are bounded by the input schema (`ref` ≤ 71 chars of
   `[0-9a-f:sha256]`, `detail` an enum), so the ask has nothing long enough to cut. No
   permission file changes. A test pins `permission: "none"` (T9).

**Prove first (Execution step 0, before any production code):** a repro in
`.tentacle/tmp/image-view/` that builds an `AttachmentStore`, writes a PNG into it, puts
a `role:"tool"` message with that single ref into a request through
`AnthropicProvider` / `OpenAIProvider` with a recording `fetch`, and asserts exactly 1
image part in the payload. If this fails, STOP and fix the plan (§8).

### Preconditions (verified)

- No tool image reaches the model today. `fs_read` drops the PNGs (`builtins.ts:208-210`),
  and `ToolResult` has no image field (`core/src/tool.ts:93-116`). So this slice changes
  no existing request byte for sessions without tool images.
- A sub-agent is built without `attachments`/`artifacts` and its tool set is filtered
  (`agent/src/subagent.ts:406-445`). Adding `image_view` to that filter keeps children
  without the tool. A child's `fs_read` has no `ctx.images`, so its markers carry no ref.
- A pod gets the store only when it runs its own model (`serve.ts:1338-1349`;
  `--model-proxy` → `source:"client"`, `cli/src/image-policy.ts:39-41`). The Context
  says "not in pods", so the gate is **explicit**, not structural (D1): only the worker
  (`worker.ts:78-105`) and `serve` (`serve.ts:210-240`) forward the write handle. The pod
  factory (`serve.ts:1338`) never does.
- Result transforms spread the result (`agent/src/result-pipeline.ts:105,189,231,261`,
  `redact.ts:77`), so `image` survives redaction, spill and summaries.
- Prune stubs keep every field but `content` (`agent/src/prune.ts:569-576`). Today a
  stubbed image message would therefore **keep its ref** and the image would still be
  sent. D7 fixes this for `image_view` results.
- The worker's resume restores only USER image refs (`client/src/restore-images.ts:17-35`).
  Tool images are not on laptop disk. That is accepted: they are regenerable (failure
  modes, F3).
- The store never evicts completed blobs (`daemon/src/attachment-store.ts:5-9`). It
  has a 100 MiB per-session cap (`:35`) and a 256 MiB per-daemon cap (`:38`). Tool
  images must not starve user uploads (D2, Owner Q2).
- The heuristic counter charges a flat `IMAGE_TOKEN_ESTIMATE = 1600` per ref
  (`core/src/attachments.ts:130`, `token-counter.ts:44`). No caller passes a counter: the
  agent uses `DEFAULT_COUNTER` (`agent.ts:236,1083,1986,2060`).

### Design

**D1 — The write handle: same object, write-capable type, explicit gate.**
- `core/src/tool-images.ts` (new, pure) defines `interface ToolImageStore { putTool(input:
  {variants: {high: Uint8Array; low?: Uint8Array}; mimeType: "image/png"; label: string}):
  Promise<ToolImageEntry | {refused: string}>; resolve(prefix: string): ToolImageResolve;
  holds(ref): boolean }`.
  - `ToolImageEntry = {high: AttachmentRef; low: AttachmentRef; label: string}`. `low`
    equals `high` when the picture is already ≤ 768 px.
  - `ToolImageResolve = {kind:"found", entry} | {kind:"none"} | {kind:"ambiguous", labels}`.
  - The file also holds the pure prefix normaliser: it strips `sha256:`, lowercases,
    requires 8–64 hex characters, and returns `{refused}` otherwise.
  - `ChatRequest.attachments` stays `AttachmentSource` (read-only,
    `core/src/model.ts:253,266-268`). A provider can never write: this is the S3 Review
    condition (`pdf-images.md:1206-1208`).
- `daemon/src/session-host.ts`: `AgentContext` gains `toolImages?: ToolImageStore`. It is
  set to the **same `uploads`** at `:1594` and `:1685`, under the same
  `images?.source === "store"` condition.
- `cli/src/wiring.ts`: `BuildAgentOptions.toolImages?`. `worker.ts` and `serve.ts`'s
  factory forward `ctx.toolImages`. `podSessionHost` does not.
  - With `toolImages` **and** `imageLimits(config).vision`, the agent gets
    `AgentConfig.toolImages` and `image_view` is registered.
  - Otherwise neither happens.
  - Forgetting a hop turns the feature off. It never opens a hole.

**D2 — `AttachmentStore.putTool` (store side, the only new write path).**
- **Synchronous prefix**, like `put`'s (`:11-17`): verify sha256(bytes) for each variant,
  dedupe on an existing `complete`/`stored` id, then reserve in both caps **plus a
  per-session tool sub-cap** `TOOL_IMAGE_BYTES` (Owner Q2, recommended 48 MiB).
  - On refusal nothing is reserved. It returns `{refused:"image store full"}` and never
    throws: a full store is a marker note, not a failed read.
  - With a disk (`serve`) it awaits `land` (`:295-318`), so a recorded ref names durable
    bytes. A failed land returns `{refused:"image could not be stored"}`.
- A per-store **tool index** `Map<id, ToolImageEntry>` maps BOTH variant ids to their
  entry. `resolve(prefix)` scans it: none, one entry, or several (ambiguous, with labels).
  The index lives on the store, so it survives a settings rebuild (same object, `:1685`).
  It dies with the process (F3).
- User uploads (`put`) never enter the index. `image_view` therefore cannot reach a user
  image in slice 1 (slice 2 widens this deliberately).

**D3 — Extraction makes both variants and their ids (worker side).**
- `PdfImageLimits` gains optional `lowEdge?: number` (768). `createImageCollector` gains an
  injected `sha256?: (b: Uint8Array) => string`. It is injected like `deflate`, so
  `@tentacle/core` stays free of `node:` imports (S2 Review, `pdf-images.md:1118`).
- When both are set, each first-seen kept image encodes the high PNG (unchanged) and, if
  `max(w,h) > lowEdge`, a low PNG from the same `decoded.pixels` via `scaledSize` +
  `downscalePixels` (`pdf-images.ts:202-256`). `PdfPageImage` gains `id?`, `low?`, `lowId?`.
- `maxBytes`/`maxSent` keep counting the high PNG only. The low PNG costs about a quarter
  more, and the store caps bound it (D2).
- `pdf/run.ts:186-191` passes `createHash("sha256")`. `isPageImage`
  (`pdf/extract.ts:55-66`) accepts the new optional fields, typed.
- Marker grammar: `imageMarker(page, w, h, note?)` (`:337-340`) gains the note
  `ref <id[0:12]>` only when an id exists. So without `lowEdge`/`sha256` (a pod, a
  sub-agent, a user-attached PDF, `images:false`) every byte stays as today, and
  existing `pdf-images` tests stay green unchanged.
- With a sink the notes become:
  - kept → `ref a1b2c3d4e5f6`
  - capped → `not kept: per-read cap`
  - plus the footer word `kept for image_view` in place of `sent`.
- The **dense-page hint** (owner answer 6) is ` · full page — detail "high" for small
  text`, appended when the paint box covers ≥ 50 % of the page box (Owner Q3: this proxy
  is the mechanism). `page.view` must be read in `collectPageImages`. The executor
  verifies that `PdfPageLike` exposes it. If it does not, STOP and ask: do not guess.

**D4 — `fs_read` stores, then fixes the text it returns** (`builtins.ts:148-218`).
- With `ctx.images` it passes `images: {...DEFAULT_PDF_IMAGE_LIMITS, lowEdge: 768}` and
  `refs: true` (the worker then hashes).
- After extraction it calls `putTool` once per distinct id, with label
  `<file> p.<N>` (via `sanitizeAttachmentName`, `core/src/attachments.ts:53`).
- An image the store refused gets its marker rewritten from `· ref <id12>]` to
  `· not kept: <reason>]`. The 12-hex id makes the match unique, and every occurrence of
  that id is rewritten.
- `fs_read` returns `{content}` only (0 refs).
- Without `ctx.images`, today's call is unchanged.
- **Scanned PDF** (Owner Q4): with a sink and ≥ 1 kept image, the `no-text` verdict
  (`:205-207`) no longer throws. It returns the verdict message, the markers, and the
  footer, so the model can `image_view` the pages. Without a sink, today's refusal stays.
- The description (`:104`) gains one sentence, only in the sink variant: "call
  `image_view` with a marker's ref when a picture matters to the answer (diagrams,
  charts, scanned pages); skip logos". The sink variant is a second `Tool` object built
  by `createFsReadTool({images:true})`; it never mutates the shared constant.

**D5 — `image_view` tool** (`tools/src/image-view.ts`, new).
- Input: `{ref: string, detail?: "low"|"high"}`, `permission: "none"`,
  `concurrency: read`. The schema is built from `model.imageDetail` (D6):
  - `auto` advertises `detail` (default `low`);
  - `low`/`high` advertise no `detail`, and a stale `detail` is ignored with one note.
- Execute: normalise the prefix, then `ctx.images.resolve`, then pick the variant, then
  `holds(ref)`, then return.
  - Success: `{content: "<label> · <w>×<h> · <low|high> · <KB>", image: ref}`.
    `content` is one line. When `low===high` it says "already ≤ 768 px".
  - Errors (`isError`, no `image`):
    - unknown prefix → "no image <p> in this session — fs_read the file again (same
      pages) to get a fresh ref". PDF extraction is deterministic, so the same bytes
      give the same id (T6).
    - ambiguous → it lists the labels.
    - malformed → it names the expected form.
    - not held → the same regeneration hint.
  - No branch reads bytes. The provider does that, once, verified.

**D6 — Config** (file-only, like `model.maxImageBytes`, `config/src/resolve.ts:551-554`):
- `model.imageDetail: "auto"|"low"|"high"` (default `auto`).
- `model.imageTokens: integer > 0`.
- Both wired in `schema.ts:66-80`, `resolve.ts` (main model `:750-760` and resolved
  `:800-810`), `load.ts:162,893`, `key-docs.ts` (next to `:297`, `carried: "no"`), and
  `cli/src/config-effective.ts:171`.

**D7 — Per-provider image token estimate.**
- `providers/src/images.ts` gains `imageTokenEstimate(provider, override?)`: anthropic
  `1600` (unchanged), openai-compatible `3200` (the measured ≤ 3.1k, rounded UP per the
  counter's never-underestimate contract, `token-counter.ts:5-7`), `override` wins.
- `HeuristicTokenCounter` gains `imageTokens?`. `AgentConfig.imageTokens?` builds the
  agent's own default counter, replacing the module-level `DEFAULT_COUNTER` at
  `agent.ts:1083,1986,2060`. `wiring.ts` passes the estimate.
- The estimate stays flat per ref, so a low variant is over-counted. That is the safe
  direction: prune triggers a little early. Recorded as debt.

**D8 — Prune rule for viewed images** (`agent/src/prune.ts`).
- New `PruneRule` `"viewed_image"`, checked first in `ruleFor` (`:566`) for
  `toolName === "image_view"` with `attachments`.
- The stub drops **`attachments`** and becomes
  `⟪pruned by tentacle: image_view <id12> (<label>) viewed earlier — image_view <id12>
  again to see it⟫`. A pure function of the message, so it is cache-stable (`:27`).
- `estimateGain` (`:678-688`) adds `imageTokens × refs removed` to `tokens` (a new
  `PruneOptions.imageTokens`). Without it the trigger would see a ~0-char gain and never
  fire.
- The provider's tool-image "older" text (`images.ts:521`) changes to "(call image_view
  again to see it)". No tool message carries refs today (eval §2), so no existing request
  byte changes.

**D9 — Agent loop.**
- `toolContext` (`agent.ts:1332-1339`) adds `images: this.config.toolImages` when set.
- `toolMessage` (`:280-292`) adds `attachments: [result.image]` when `image` is set and
  `checkAttachmentRefs([image])` passes. On failure the message becomes an error result
  naming the cause, never a thrown turn.
- `subagent.ts:418-445` excludes `IMAGE_VIEW_TOOL_NAME`.

**D10 — Rows (Mac + iPhone parity, presentation only).**
- `core/src/tool-labels.ts` adds `image_view: "Image"`. It is shared, so the TUI and the
  phone read the same label.
- TUI `toolSubtitle` (`tui/src/render-lines.ts:729-760`) adds the case `image_view` →
  `<ref>` plus ` · high` when `detail === "high"`.
- The phone mirrors it in `SUMMARISED_TOOLS` + `subtitleOf` (`apps/mobile/src/tool-summary.ts:46-120`).
  The existing parity test fails if one side lacks the case.
- The result body is the generic tool body on both sides (the label line). No
  thumbnails (pdf-images Q6). No protocol change: `tool_call`/`tool_result` are
  generic.
- The TUI's and the phone's resume branches render refs only on USER messages
  (`tui/src/resume.ts:110`, `apps/mobile/src/transcript-history.ts:136`), so a tool
  message's ref shows no image chip on either.

### Files (dependency order; no protocol file)

1. `packages/core/src/tool-images.ts` (new), `tool.ts`, `token-counter.ts`, `pdf-images.ts`,
   `tool-labels.ts`, `index.ts`
2. `packages/providers/src/images.ts`
3. `packages/daemon/src/attachment-store.ts`, `session-host.ts`
4. `packages/agent/src/agent.ts`, `prune.ts`, `subagent.ts`
5. `packages/tools/src/image-view.ts` (new), `builtins.ts`, `pdf/run.ts`, `pdf/extract.ts`
   (+ `pdf/options.ts` types), `index.ts`
6. `packages/config/src/schema.ts`, `resolve.ts`, `load.ts`, `key-docs.ts`;
   `packages/cli/src/config-effective.ts`
7. `packages/cli/src/wiring.ts`, `worker.ts`, `serve.ts` (the `serve` factory only)
8. `packages/tui/src/render-lines.ts`; `apps/mobile/src/tool-summary.ts`
9. `changelog.d/image-view.added.md`

**Parallel-branch overlap.**
- `feat/workflows-ui` touches `agent/src/agent.ts` (the core import block and line ~2971),
  `cli/src/wiring.ts` (the import block and ~841), `core/src/index.ts` (one export) and
  `cli/src/local-runtime.ts`.
- `feat/mobile-native-sheets` touches no file here.
- Mitigation: branch from `main` **after** mobile-native-sheets merges, as ordered. Add
  imports on their own lines, never by reflowing the existing lists. If workflows-ui
  merges first, rebase before Review. The expected conflicts are import lines only.

### Failure modes → convergence

| # | Mode | Convergence |
|---|---|---|
| F1 | Model never looks | Descriptive marker + the description sentence. Measured by the Qwen farmaquiz acceptance (≈10 image-only questions, count `image_view` calls). Escape hatch only if it fails (owner answer 3) |
| F2 | Store full / sub-cap hit | `putTool` refuses before reserving. The marker says `not kept: image store full` and the footer counts it. User uploads keep ≥ 52 MiB (Q2). Never a throw |
| F3 | Ref gone (worker resume, serve restart loses the index, `/clear` fork = new store) | `image_view` error + "fs_read again (same pages)". The same PDF gives the same id (T6). An old `image_view` message's ref → the provider's `[image unavailable — label]` (`images.ts:437-438`) |
| F4 | Unknown / ambiguous / malformed / user-upload prefix | Error result, no read (T5). A user upload is not in the tool index |
| F5 | Variant over the model's cap (e.g. a high PNG > 5 MiB on openai) | The existing reason line names the limit (`images.ts:423-430`). The model can ask `low`. The session stays usable |
| F6 | Non-vision / `images:false` / pod / sub-agent | Tool not registered, markers without ref (T7). A stale call after a model switch → `[1 image in this result not sent: this model does not take images]` (`images.ts:486-493`) |
| F7 | View loop | `maxToolImages` ages out old views. The prune rule removes old views' refs (D8). The step budget bounds the loop |
| F8 | Concurrent `fs_read`s put the same image | Synchronous check-and-reserve, dedupe on the id (D2). The second put gets the existing entry |
| F9 | Serve disk write fails mid-read | That image: `not kept: image could not be stored`. The others proceed |
| F10 | Hostile pod | No tool and no write handle in any pod (D1, T7). Laptop `LaptopImages` is unchanged (`client/src/laptop-images.ts:1-22`) |
| F11 | Version skew | No wire change. An older client reloading a `serve` log sees an ordinary `media_message` on a tool message, which the schema has always accepted (T8) |

### Tests (red first — each shown failing before its code, §9)

- **T1 core `pdf-images.test.ts`:**
  - with `lowEdge`+`sha256`: a 2000×1000 image gives high 1568×784 and low 768×384, two
    ids, and the marker `ref <id12>`;
  - a 600×400 image gives `low === high`;
  - without them, the marker bytes equal today's (golden).
- **T2 daemon `attachment-store.test.ts`:**
  - `putTool` verifies the hash;
  - it dedupes;
  - the sub-cap refuses without reserving (`held` unchanged);
  - user `put` still fits after the sub-cap is full;
  - `resolve` gives none / one / ambiguous;
  - both variant ids resolve to one entry;
  - a disk land failure gives `{refused}`.
- **T3 tools `fs-read-pdf.test.ts`:**
  - a PDF with 6+ images returns **0 refs** and 6 marker refs, all `holds`;
  - a store refusal rewrites only that marker;
  - no sink gives today's bytes;
  - a scan with a sink → markers + verdict text (Q4); a scan without a sink → today's
    throw.
- **T4 providers `tool-images.test.ts`:** `image_view` result message → exactly **1**
  image part on Anthropic and on OpenAI-compatible (the step-0 repro, kept as a test).
- **T5 tools `image-view.test.ts`:**
  - low/high pick the right ref;
  - forced `imageDetail` hides `detail`;
  - unknown, ambiguous, malformed and user-upload refs → `isError`, no `image`;
  - a spy store asserts no byte read.
- **T6 determinism:** the same PDF read twice → identical ids (F3's hint holds).
- **T7 cli `wiring.test.ts`:**
  - worker/serve with vision → `image_view` registered;
  - `images:false`, no `toolImages`, and the **pod factory with its own store** → absent;
  - sub-agent tool set excludes it (agent `subagent` test).
  - Non-vacuity by mutation: forward `toolImages` in the pod factory → the test fails.
- **T8 agent `loop-attachments.test.ts` + daemon `attachments-log.test.ts`:**
  - a tool result with `image` → `role:"tool"` message with `attachments:[ref]`;
  - a `media_message` log round-trip (laptop log and `serve` log) restores it;
  - redaction keeps it.
- **T9:**
  - `image_view.permission === "none"`;
  - a forced-ask hook's `PermissionRequest.input` is the bounded `{ref, detail}`.
- **T10 agent `prune.test.ts`:**
  - an old `image_view` result → a stub **without `attachments`**;
  - `estimateGain.tokens` includes `imageTokens`;
  - the stub is byte-stable across two computations.
- **T11 core `token-counter.test.ts` + providers:**
  - `imageTokens` override;
  - openai default 3200, anthropic 1600.
- **T12 tui `render-lines.test.ts` + mobile `tool-summary.test.ts`:** `Image a1b2c3d4e5f6 ·
  high` on both; the parity scan passes.

**Validation:** `bun run check` green (lint baseline 0/0). Then the owner's Qwen
farmaquiz acceptance (F1) on a worker session, and once on `serve`.

### Owner questions (only what the eval did not decide)

1. **Image files (`fs_read` of a .png/.jpg) in this slice?** Today `fs_read` reads UTF-8
   only (`builtins.ts:104,128`). `low` needs a decode to downscale, which means a PNG
   decoder (3a) or a JPEG dependency (3b). **Recommendation: not in slice 1.** Add them
   right after 3a (PNG) / 3b (JPEG), reusing `putTool` and `image_view` unchanged.
2. **Tool-image share of the session store.** **Recommendation: a 48 MiB sub-cap of the
   100 MiB**, refused without eviction (F2), so user uploads always keep ≥ 52 MiB
   (3 max-size images).
3. **"Dense text/table" hint mechanism** (owner answer 6 asks for the hint; no text
   analysis exists). **Recommendation: a full-page proxy:** paint box ≥ 50 % of the page
   area → ` · full page — detail "high" for small text`. Scans and full-page
   tables/figures match it.
4. **Scanned PDFs return their page images instead of the refusal** (when a store and
   vision exist). The eval's tool sentence names "scanned pages", but today the refusal
   (`builtins.ts:205-207`) stops the read before any marker. **Recommendation: yes**:
   the verdict text stays first, so the model still knows there is no text layer.

### Notes / debt

- The flat per-ref estimate over-counts `low` (D7).
- `models.*.imageTokens` is not added: the counter follows the agent's main model at build.
- Images inside user-ATTACHED PDFs stay markers without a ref (the prompt path,
  `daemon/src/prompt-documents.ts`). They are a separate slice if wanted.
- The tool index is not rebuilt on a `serve` restart (F3). A re-read is cheap and
  dedupes on disk.

## Execution

*— claude-opus-5-5 (executor), 2026-11-24*

**Step 0 (load-bearing check) — HOLDS.** `.tentacle/tmp/image-view/step0.ts`: a real
`AttachmentStore`, a 4×4 PNG `put` into it, a `role:"tool"` message with that single ref,
streamed through `AnthropicProvider` / `OpenAIProvider` (`images: true`) with a recording
`fetch`. Output:
```
anthropic image parts: 1 OK
openai image parts: 1 OK
```
Kept as a test: T4 in `providers/test/tool-images.test.ts` (fake source; providers may not
import the daemon).

**As built, in plan order** (all slices DONE):
1. core — `tool-images.ts` (new: `ToolImageStore`, `imageRefPrefix`, `toolImageLabel`,
   `toolImageLimits`, `IMAGE_VIEW_TOOL_NAME`, `TOOL_IMAGE_LOW_EDGE`); `pdf-images.ts`
   (`lowEdge`, injected `sha256`, `id/low/lowId/lowWidth/lowHeight`, `ref <id12>` marker,
   `not kept: per-read cap`, `FULL_PAGE_HINT`, `unkeepImageMarker`, summary `refs`/`refused`,
   footer `kept for image_view`); `tool.ts` (`ToolResult.image`, `ToolContext.images`);
   `token-counter.ts` (`imageTokens`); `tool-labels.ts` (`image_view: "Image"`).
2. providers — `imageTokenEstimate` (1600 / 3200 / override); the aged-out line now says
   "(call image_view again to see it)".
3. daemon — `AttachmentStore.putTool` / `resolve` + `TOOL_IMAGE_BYTES` (48 MiB, option
   `toolMaxBytes`), tool index on the store, joined concurrent puts; `session-host.ts`
   sets `toolImages: uploads` at both `"store"` sites.
4. agent — `toolMessage` → `attachments: [image]` (a ref failing `checkAttachmentRefs` →
   error result); `toolContext.images`; `AgentConfig.toolImages` / `imageTokens` (a
   per-agent `counter` replaces `DEFAULT_COUNTER` at the 3 sites); prune rule
   `viewed_image` (stub without `attachments`, `savedImages`, `estimateGain(…,{imageTokens})`);
   `subagent.ts` excludes `image_view`.
5. tools — `image-view.ts` (new); `fs_read` keeps pictures via `ctx.images`
   (`keepPdfImages`), scan-with-store returns verdict + markers; `createFsReadTool`;
   `pdf/run.ts` (hasher, `page.view` → page area), `pdf/extract.ts` (typed new fields).
6. config — `model.imageDetail`, `model.imageTokens` (schema, resolve, load, key-docs);
   `config-effective.ts` probes.
7. cli — `wiring.ts` (`BuildAgentOptions.toolImages`; with vision: `fs_read` replaced by
   its image variant, `image_view` registered, `toolImages` + `imageTokens` to the agent);
   `worker.ts` and `serve.ts`'s `createServeAgent` forward `ctx.toolImages`;
   `podSessionHost` untouched (destructures only its fields → never forwards).
8. TUI `toolSubtitle` + phone `subtitleOf`/`SUMMARISED_TOOLS`: `image_view` → `<ref>[ · high]`.
9. `changelog.d/image-view.added.md`.

**Drift from Implementation (and why):**
- `ToolImageEntry.high/low` are `ToolImageVariant {ref, width, height}`, and `putTool`'s
  variants are `{bytes, width, height}`: an `AttachmentRef` has no pixel size, and
  `image_view`'s line needs `<w>×<h>`.
- No `refs: true` request flag: `images.lowEdge` is the only switch (the worker always
  injects the hasher; the collector uses it only with `lowEdge`). Fewer moving parts, same
  "no `lowEdge` ⇒ today's bytes" property (golden test).
- D3 STOP-check: `PdfPageLike` did not expose `view`, but pdf.js does
  (`PDFPageProxy.view`, `pdfjs-dist/types/src/display/api.d.ts:1505`, `[x1,y1,x2,y2]`), so
  it was added as an optional structural field — verified, not guessed.
- Footer: `kept for image_view` replaces `sent` whenever the footer prints; it still prints
  only when something needs explaining (unchanged rule). Refusals add `N not kept (see the
  markers)` (`summary.refused`).
- `models.*` entries `omit` `imageDetail`/`imageTokens` (the key-docs mirror would demand
  docs for keys the Notes say are not added); `mainModel` untouched.
- Forced `imageDetail`: the schema is `z.object({ref}).passthrough()` so a stale `detail`
  reaches `execute` and gets the note (a strip schema would silently drop it).
- `putTool` never evicts stale user partials (owner Q2 "refused without eviction").
- T9 forced ask is asserted at `describeToolCall` (what the gate hands the broker on
  `force: "ask"`), not through a hook process. T8's `serve` log is covered by the shared
  `SessionLog` entry + `KnownLogEntrySchema` parse (same format); no file-level serve test.
- Red-before-green (honest): most tests were written alongside their code, not run red
  first. Non-vacuity was shown by mutation instead (below); the provider "older" text test
  and the T7 pod row are red on the pre-change code by construction.

**Mutations (each reverted; `git diff --stat` unchanged after):**
| Mutation | Test that went red |
|---|---|
| T7: pod factory forwards `toolImages` | `image-view-wiring` "a pod daemon running its OWN model … never offered" |
| T1: low variant never computed (`if (true)`) | core `tool-images` "2000×1000 → high…, low…, two ids" |
| T2: tool sub-cap check removed | daemon `attachment-tool-images` "sub-cap refuses WITHOUT reserving" |
| T10: prune stub keeps `attachments` | agent `prune` "stub WITHOUT attachments" |
| T10: `estimateGain` ignores images | agent `prune` "estimateGain counts the dropped image" |
| D9: sub-agent filter lets `image_view` through | agent `subagent-image-view` "general child … does not get it" |
| T8: `toolMessage` drops the image | agent `loop-attachments` (2 rows) |
| T3: refused marker not rewritten | tools `image-view` "a store refusal rewrites only that marker" |

**Narrow verification:** the 26 touched/covering test files → `591 pass, 0 fail`;
`biome check` on every touched tree → clean. Per-package `tsc -p` (core, providers,
config, agent, tools, daemon, apps/mobile): no error in a touched file;
`tsc -p packages/cli` shows only pre-existing errors (that tsconfig lacks
`@tentacle/protocol`/tui paths), none introduced. Full gate: left to the orchestrator's
script (per the budget). No protocol schema change → `protocol.json` not regenerated, no
`protocol.d/` note.

**Debt / unverified:**
- A sub-agent inherits the parent's image-variant `fs_read` description (it names
  `image_view`, which the child lacks); its context has no store, so its markers carry no
  ref. Cosmetic; a swap in `subagent.ts` would fix it.
- The owner's Qwen farmaquiz acceptance (F1) is not run: verify on a worker session and once
  on `serve`.
- Parallel-branch overlap: all new imports are on their own lines (agent.ts, wiring.ts,
  core/index.ts); expected conflicts with `feat/workflows-ui` are import lines only.

### Fix round 1

*— claude-opus-5-5 (executor), 2026-11-24*

**Review finding 1 (MEDIUM, tool sub-cap lost on `serve` restart) — FIXED.** Tool blobs
are now marked on disk, and a reloaded store charges them to the sub-cap again.
- `session-blobs.ts`: `TOOL_MARKS = "tool-ids"`, a file in `<uid>.attachments/` with one
  blob id per line. `write(…, {tool})` appends the id (fsynced) BEFORE the blob lands, so
  a crash between the two leaves a mark with no blob, which charges nothing. A crash never
  leaves a tool blob uncounted. `toolIds(uid)` reads the file synchronously, like `index`,
  and skips lines that are not ids. `link` (a `/clear` fork) carries a source mark with
  its blob. `index` already skips non-id names, so an older build ignores the file, and
  `removeAll` deletes it along with the dir.
- `session-log-store.ts`: the queued `blob` op gets an optional `tool` flag, so the mark
  is written in the session's queue/lock like the blob. Added `toolBlobIds(id)`.
- `session-persister.ts`: `SessionStoreLike.putBlob(…, opts?)` / `toolBlobIds?`.
  `blobs(id)` hands `toolIds` to the store and forwards `opts`.
- `attachment-store.ts`: `AttachmentDisk.toolIds?` and `write(…, opts?: {tool})`. The
  constructor charges `toolBytes`/`toolUsed` for each on-disk blob whose id is marked.
  `putTool` lands its fresh variants with `tool: true`. A user `put` and a `putTool`
  deduped onto an existing blob are never marked.

**Red → green.** The new test `attachment-tool-images` "tool blobs reloaded from disk
still count…" ran on the unfixed store and FAILED on the property: the second store's
`putTool` returned an entry where `{ refused: "image store full" }` was expected. With
the fix it passes. Added alongside it: a reloaded USER blob is not charged; a mark without
its blob charges nothing; a real-files test through `LogSessionStore` + `SessionPersister`
(user 4000 + tool 5000 → restart → `held` 9000, tool 2000 refused, tool 1000 fits under
the 6000 cap); `session-blobs` "tool marks …" (write marks, index skips the file, link
carries the mark).

**Mutations (each reverted; a grep for the mutation text afterwards is empty):**
| Mutation | Red |
|---|---|
| M1 constructor never charges marked blobs (`false &&`) | "tool blobs reloaded…", "real files…" |
| M2 `putTool` lands without the mark (`land(…, false)`) | "tool blobs reloaded…", "real files…" |
| M3 persister drops `toolIds` | "real files…" |
| M4 `link` does not carry the mark | `session-blobs` "tool marks…" |

**Narrow verification:** `attachment-tool-images`, `session-blobs`, `attachments-store`,
`session-log-store`, `serve-log-store` → `94 pass, 0 fail`. `biome check` on the 6
touched files is clean. `tsc --noEmit -p packages/daemon` is clean. Full gate: left to the
orchestrator's script.

**Not changed (reviewer's minor, non-blocking note):** the `.passthrough()` schema of
`image_view`. It is the documented drift that lets a stale `detail` get its note. No HIGH
or MEDIUM asked for a change.

**Debt:** after a restart a marked blob still counts but cannot be reached by `image_view`,
because the tool index (labels, dimensions) is memory-only (review F3). The model re-reads
the PDF, and `putTool` dedupes onto the stored blobs: `existing` is `stored` at the same
size, so nothing new is charged. This dedupe is from reading the code; no test pins it.
No GC of tool blobs (unchanged from before).

## Review

### Owner answers (2026-11-23 ~22:00)

*— claude-opus-5-5 (orchestrator), recording the owner's «ok» to every recommendation*

1. Image FILES (`fs_read` of .png/.jpg): not in slice 1 — right after 3a (PNG) / 3b (JPEG).
2. Tool images: a 48 MiB sub-cap of the 100 MiB session store, refused without eviction.
3. Dense-text hint: the full-page proxy (paint box ≥ 50 % of the page → `· full page — detail "high" for small text`).
4. Scanned PDFs return their page images (verdict text first) when a store and vision exist.

Size: L (by files). **Implementation APPROVED.** Execution after `feat/mobile-native-sheets` merges (owner order).

### Adversarial review (fresh context)

**Verdict: REQUEST-CHANGES** (1 MEDIUM; no HIGH). Scope: `git diff main...HEAD` only.

**Gate (re-run):** `bun run typecheck` clean; `bun run lint` clean (2334 files, 0/0); the 13
touched test files → `370 pass, 0 fail`. Full `bun test` not re-run here (asked: touched files).

**Findings**
1. **MEDIUM — the tool sub-cap (Owner Q2) does not survive a `serve` restart.**
   `packages/daemon/src/attachment-store.ts:195-198` reloads every on-disk blob into `used`,
   but `toolUsed`/`toolBytes` (`:181-182`) start at 0, and nothing deletes blobs (no GC in
   `session-persister.ts:497-508`/`session-log-store.ts:426`). Scenario: a `serve` session
   reads PDFs until the 48 MiB sub-cap is reached. The daemon restarts, and the session reads
   *different* PDFs: another 48 MiB fits (`:481`), because the check sees `toolUsed = 0`.
   After a second restart the session holds about 96 MiB of tool images in its 100 MiB cap,
   and user `attachment/put` is refused. That breaks the binding promise that "user uploads
   always keep ≥ 52 MiB". The orphaned blobs cannot be reached after a reload either (the
   index is gone, F3). Fix options: persist which blobs are tool blobs (e.g. a sidecar list)
   and charge them on reload, or have the owner record this as accepted debt.

**Mutations (each reverted; `git status --porcelain` empty afterwards)**
| Mutation | Result |
|---|---|
| `session-host.ts:1603` stops forwarding `toolImages` | RED: `image-view-wiring` "worker host with vision → offered" |
| `image-view.ts:99` `holds` check disabled | RED: `image-view` "…not-held… → isError" |
The executor's 8 mutations are in Execution. I did not repeat them.

**Attacks tried**
- Pod path (§7 "pod is not trusted"): `serve.ts:1342` destructures only its own fields, so
  `toolImages` never reaches a pod. Holds; T7 pins it.
- Provider write capability: `ChatRequest.attachments` stays `AttachmentSource`, and
  `ToolImageStore` is reached only via `ToolContext`. Holds.
- More than 1 ref per message / protocol: `ToolResult.image` is singular, and `fs_read`
  returns no refs. The log entry is an ordinary `media_message`. No `PROTOCOL_VERSION`
  move is needed. Holds.
- Disk land failure / dispose race in `putTool`: `land` → `drop` releases `toolBytes`.
  After dispose → `{refused}`. Holds.
- Prune: the `viewed_image` stub drops `attachments`, and `estimateGain` counts images.
  Holds (the executor's mutations went red).
- Session-host forwarding: covered end to end (mutation above).

**Executor behaviour:** It said honestly that most tests were not run red first (a §9
deviation) and showed non-vacuity by mutation instead. Its documented drift is accurate.
It missed the restart accounting gap. Minor, not blocking: the forced-detail
`.passthrough()` schema (`image-view.ts:54`) lets extra fields reach a hook-forced ask.
That weakens Load-bearing §5's claim that "nothing long to cut".

**Same model family as the executor and planner (Opus):** this review has fresh context
but shares that family's blind spots. AGENTS §10 recommends a different model for
load-bearing work.

*— claude-opus-5-5, 2026-11-24*
