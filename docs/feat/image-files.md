# feat/image-files — `fs_read` of .png/.jpg/.jpeg gives the model the image (high only)

> **Status:** implementation (NOT approved — owner Q1–Q2)
> **Branch:** `feat/image-files`
> **Size:** S–M · **Blast:** load-bearing (tool-result shape, the session store's tool-image path) · **Suited:** Opus plan + exec, fresh-context Opus review
> **Changelog:** `changelog.d/image-files.added.md`

## Context

Owner 24/11 («ok»): image files are not visible to the model today. `feat/image-view` (merged a8de3bfc, `docs/feat/image-view.md`) gives on-demand tool images (PDF pages) through `image_view(ref, detail low|high)`, but `fs_read` reads UTF-8 only (`builtins.ts:104,128`), so a .png/.jpg in the workspace never reaches the model. image-view's owner Q1 deferred image files until slices 3a (PNG decode) / 3b (JPEG decoder dependency) because `low` needs a decode to downscale.

This task brings image files forward WITHOUT a decoder: `fs_read` of a `.png` / `.jpg` / `.jpeg` puts the file into the session store through the SAME tool-image path as PDF pages (`putTool`, the 48 MiB sub-cap, refusal without eviction) and answers with the same marker/ref, so `image_view` shows it — **`high` only** (the original bytes; width/height read from the PNG IHDR / JPEG SOFn header, no pixel decode). A `low` request on such a ref says plainly that low is not available for this image yet and serves high (or refuses with a sentence — the plan decides, with a recommendation). `low` arrives with 3a/3b unchanged.

Constraints: reuse image-view's seams (no second image path); model caps (`images.ts` size limits, per-provider image token estimate `model.imageTokens`) apply unchanged; a file over the model's cap is refused with the existing reason line; a non-image or a corrupt header is refused with a sentence, never sent; no new dependency; Mac/phone parity statement (serve sessions too); a model without vision gets today's behaviour.

*— orchestrator (claude-opus-5-5), 2026-11-24*

## Implementation

*— claude-opus-5-5 (planner), 2026-11-24*

**Status: APPROVED** (owner 2026-11-24: Q1 C, Q2 not in this task — see #### Owner answers). Was: NOT approved. Two choices are visible to the owner (### Owner questions, Q1–Q2).
Everything else follows from the Context, the image-view precedents, or a recommendation
below that has no owner-visible trade-off.


#### Owner answers (2026-11-24, binding)

1. **(C)** — `maxEdge` 8000 px on Anthropic, 1568 px on OpenAI-compatible, decided in wiring next to the byte cap.
2. **Not in this task** — PNG/JPEG only; GIF/WebP/HEIC in vision sessions are refused with a sentence naming the type.

Executor: DeepSeek (owner: S/M → deepseek/sonnet); fresh-context Opus review.

*— orchestrator (claude-opus-5-5), 2026-11-24*

### Load-bearing assumption

**An `fs_read` image file goes through image-view's tool-image path unchanged. The only
edit on that path is to widen one TYPE literal: `ToolImagePut.mimeType` goes from
`"image/png"` to `"image/png" | "image/jpeg"`.** Every link after `putTool` already
ignores the MIME type, or already accepts JPEG:

1. **Store.** `putTool` computes each id from the bytes (`withId`,
   `daemon/src/attachment-store.ts:586-589`). It dedupes, reserves session cap + daemon
   cap + tool sub-cap in one step, and refuses without eviction (`:464-500`). It copies
   `input.mimeType` into the ref (`:505-512`). With no `low` variant, `low` IS `high`:
   one id, one reservation (`:466,480`). `resolve` (`:549-565`) and `holds` (`:448-452`)
   look only at ids and sizes, never at the MIME type.
2. **Tool.** `viewImage` (`tools/src/image-view.ts:73-117`) picks `entry.high`/`entry.low`
   and returns `image: variant.ref`. It never reads the MIME type or any bytes.
3. **Agent.** `toolMessage` (`agent/src/agent.ts:285-300`) runs `imageCheck` on the ref.
   That check accepts any member of `IMAGE_MIME_TYPES`
   (`core/src/attachments.ts:92`; `protocol/src/attachment.ts:25`, which includes
   `image/jpeg`).
4. **Provider.** `sendable` (`providers/src/images.ts:259-260`) and `toolResultImages`
   (`:527-529`) test `isKnownImageType(ref.mimeType)` and send `ref.mimeType` as it is.
   The model's byte cap is checked before any read, and an image over it gets the
   existing reason line (`:440-446`).
5. **Persistence / wire.** The message is the same `role:"tool"` message with one ref
   that image-view already writes. `AttachmentRef` accepts `image/jpeg`. No
   `PROTOCOL_VERSION` change, no `protocol.d/` note, no log change.

**Prove first (Execution step 0, before any production edit).** Write a repro in
`.tentacle/tmp/image-files/step0.ts`:
- a real `AttachmentStore`;
- `putTool` of a real 1×1 baseline JPEG (cast past the literal type);
- then `viewImage`, then `toolMessage`, then `AnthropicProvider` and `OpenAIProvider`
  with a recording `fetch`.

Assert exactly 1 image part, with `media_type: "image/jpeg"` on Anthropic and
`data:image/jpeg;base64,` on OpenAI. Do the same for a PNG. If either fails, STOP and fix
the plan (§8). Keep the repro as a test row (T5).

### Preconditions (verified)

- **What happens today.** `fs_read` first sniffs for a PDF (`builtins.ts:192-197`).
  Anything else goes through `ctx.env.readFile`, a UTF-8 decode (`:137`). A PNG
  therefore comes back as mojibake text, and the model never sees an image.
- **When `fs_read` gets the store.** `ctx.images` is set only when wiring has a
  `toolImages` handle AND `imageLimits(...).vision` (`cli/src/wiring.ts:1008-1014`).
  Wiring then swaps in `createFsReadTool({images:true})` (`:1013`).
- **Which sessions have a handle.** The worker and `serve` forward it. The pod factory
  never does (image-view D1, Review "Pod path"). So without vision, in a pod, or in a
  sub-agent (`agent/src/subagent.ts`, no `toolImages`), `ctx.images` is undefined and
  today's behaviour holds by construction.
- **Byte reads.** Only `exec/src/host-execution.ts:484` implements
  `ExecutionEnvironment.readBytes`. `maxBytes` refuses before reading, with
  `FileTooLargeError` (`core/src/execution.ts:44-75`).
- **Header helpers that exist today.**
  - `sniffImageType` (`core/src/image-sniff.ts:94`) picks the type from magic bytes and
    never from the extension.
  - `imageDimensions` (`core/src/artifact-kind.ts:134-151`) reads sizes but does not
    validate. It does not check that the chunk at offset 12 is `IHDR`, does not check
    for truncation, and does not look at the JPEG component count or SOF type. So
    `fs_read` needs a stricter, separate check (D1).
- **`crc32` exists** in `core/src/png.ts:43`.
- **Store dedupe and concurrency.** A second `putTool` of the same bytes returns the
  indexed entry or joins the pending one (`attachment-store.ts:467-474`). The tool
  sub-cap survives a `serve` restart (image-view Fix round 1).
- **`low` today.** `viewImage` labels `low === high` as "already ≤ 768 px"
  (`image-view.ts:104-105`). For a large image file that label would be FALSE (D4
  fixes it).
- **Message text tied to PDFs.** The tool description says "(fs_read of a PDF)"
  (`image-view.ts:37`). The regeneration hint says "(same pages)" (`:39`).

### Design

**D1 — `core/src/image-file.ts` (new, pure, unit-tested).**

The main function is `inspectImageFile(bytes, {maxEdge})`. It returns either
`{ok:true, mimeType:"image/png"|"image/jpeg", format:"PNG"|"JPEG", width, height}` or
`{ok:false, reason}`. The reason is one sentence, and the file's name is not part of it.

- **The type comes from the bytes** (`sniffImageType`), never from the extension. A
  `.jpg` that is really a PNG is stored as `image/png`.
- **PNG checks.** All of these must hold:
  - the 8-byte signature;
  - the first chunk has length 13 and type `IHDR`, and its CRC matches `crc32`;
  - width and height are in 1..65535;
  - bit depth and colour type are a legal pair (PNG spec table);
  - the interlace byte is 0 or 1;
  - an `IEND` chunk sits in the last 1 KiB.

  A file without `IEND` counts as truncated: "the PNG is truncated or corrupt".
- **JPEG checks.** Walk the marker segments (the same walk as `jpegSides`, but here it
  returns the SOF marker, the precision and the component count):
  - accepted SOF markers: `SOF0`, `SOF1`, `SOF2` (baseline, extended, progressive), with
    precision 8 and 1 or 3 components;
  - refused, each with its own sentence: arithmetic-coded `SOF9–15`, lossless or
    hierarchical `SOF3/5/6/7`, 12-bit precision, and 4 components (CMYK/YCCK). Example:
    "a CMYK JPEG — convert it to RGB first";
  - an `SOS` must follow the SOF, and an `EOI` (`FF D9`) must come after the `SOS`. Stuffed
    entropy data cannot contain an unstuffed `FF D9`, so this is reliable. Without `EOI`
    the file counts as truncated.

  Why refuse these: providers' decoders do not reliably accept these variants. A
  provider 400 on an image stays in the history until `maxToolImages` ages it out, so
  every following turn would fail too. Refusing the file up front costs one sentence.
- **Size limit.** `max(width, height) > maxEdge` → "W×H is over the <maxEdge> px limit
  for image files (no downscale yet)". `maxEdge` is set by Q1.
- **One cap sentence.** Add `imageOverCapReason(size, max)` to `core`. It returns the
  existing `<size> is over this model's <max> limit` sentence. Change
  `providers/src/images.ts` `placeholder` (`:444-445`) to call it, so the sentence has one
  source and the provider's output bytes stay identical (the existing provider tests pin
  them).
- **One marker builder.** `imageFileMarker(name, w, h, format, size, id)` returns
  `[image <name> · W×H · <format> · <KB> · ref <id12> · high only]`. `id12` is the first
  `TOOL_IMAGE_REF_CHARS` characters.

**D2 — The `fs_read` image branch (`tools/src/image-file.ts` new, called from
`builtins.ts:130-136`).**
- **Where it runs.** After `readPdf` returns `undefined` and after the existing
  "`pages` applies only to PDFs" refusal, and only when `ctx.images` and
  `ctx.env.readBytes` are both set. Otherwise nothing changes, byte for byte.
- **The head read** is `readLimitBytes: PDF_HEAD_BYTES` (1 KiB). This adds one small read
  per non-PDF `fs_read` in vision sessions only. The PDF path is left alone, so the
  image-view goldens hold.
- **What the head decides.**
  - `sniffImageType` says `image/png` or `image/jpeg` → the image path.
  - It says gif, webp or heic → refuse with a sentence that names the type (Q2).
  - The name ends in `.png`, `.jpg` or `.jpeg` (any case), the bytes are not an image,
    and `!looksLikeTextBytes(head)` → refuse: "<name> is not a PNG or JPEG image (no
    image signature)".
  - Anything else → today's text path. A `.png` file that is really text is read as
    text, the same rule as `notes.pdf` (pdf-read D3).
- **Image path, in order:**
  1. A range (`offset`/`limit` or `path:a:b`) → refuse: "<path> is an image: no line
     ranges".
  2. Read `bytes = readBytes(path, {maxBytes: min(maxImageBytes, MAX_IMAGE_BYTES)})`.
     If it throws `FileTooLargeError`, return
     `[image omitted: ${imageOverCapReason(size, max)} — <name>]` with `isError`.
  3. `inspectImageFile(bytes, {maxEdge})`. On `{ok:false}`, return
     `<name>: <reason>` with `isError`.
  4. Call `putTool({variants:{high:{bytes,width,height}}, mimeType, label:
     sanitizeAttachmentName(name)})`. No `low` variant is passed.
  5. A `{refused}` answer → `[image <name> · W×H · not kept: <reason>]` with `isError`.
  6. On success → `{content: marker + "\n" + one hint line}`. The hint line is "call
     image_view with this ref to see it; only high detail is available for image files".
     **0 refs**, the same as a PDF read.
- **Limits come from wiring.** `maxImageBytes` and `maxEdge` reach the tool through
  `createFsReadTool({images:true, maxImageBytes, maxEdge})`. `wiring.ts:1013` already
  computes `imageLimits(config.provider, config)`. `ToolContext` is unchanged.

**D3 — `ToolImagePut.mimeType` widened** to `"image/png" | "image/jpeg"`
(`core/src/tool-images.ts`). This is a type change only (the load-bearing assumption).

**D4 — `image_view` `low` on a file image: serve `high` with a plain note** (the Context
leaves this to the plan; recommendation below).
- **The rule.** In `viewImage`, when `detail === "low"`, `entry.low.ref.id ===
  entry.high.ref.id`, and `max(w,h) > TOOL_IMAGE_LOW_EDGE`, add the note:
  `· low is not available for this image yet — sent at high`.
- **Fixes a false label.** "already ≤ 768 px" now appears only when that is true.
- **Why this is pure.** The rule depends only on the entry's sizes, so it is also right
  for PDF images: a PDF image has `low === high` only when it is ≤ 768 px.
- **Why serve instead of refuse.** A refusal makes the model spend a round trip to ask
  again with `high`, and it gets the same bytes. Anthropic downscales on its side, so
  sending `high` costs no extra tokens there. The OpenAI-compatible case is decided by
  Q1.
- **Text edits.**
  - The description becomes "(fs_read of a PDF or a PNG/JPEG file)".
  - `REGENERATE` becomes "fs_read the file again to get a fresh ref". The same bytes
    give the same id.

**D5 — Mac/phone parity and session types (presentation unchanged).**
- **Where `fs_read` runs.** Daemon-side, against the session's own store:
  - **worker** (Mac TUI): yes.
  - **`serve`** (the Mac or the phone attached, `connect`): yes, the same code. The
    phone drives a `serve` session, so it gets the feature with no app change.
  - **pods** (`run`/`attach`) and **sub-agents**: no handle, so today's behaviour.
- **Rows.** The `fs_read` row and the existing `image_view` row (`Image <ref>[ · high]`)
  render generically on both the Mac and the phone. No TUI or mobile file changes; the
  existing parity test still applies.

### Files (dependency order; no protocol file)

1. `packages/core/src/image-file.ts` (new), `tool-images.ts` (D3), `index.ts` (exports)
2. `packages/providers/src/images.ts` (`placeholder` calls `imageOverCapReason`; same bytes)
3. `packages/tools/src/image-file.ts` (new), `builtins.ts` (branch + `createFsReadTool`
   options + description sentence), `image-view.ts` (D4 note, description, `REGENERATE`)
4. `packages/cli/src/wiring.ts:1013` (pass `maxImageBytes`, `maxEdge`)
5. `changelog.d/image-files.added.md`

No daemon change. `putTool` takes the widened type as it is.

### Failure modes → convergence

| # | Mode | Convergence |
|---|---|---|
| F1 | File over the model's byte cap | `readBytes` refuses before reading. Result: `[image omitted: <size> is over this model's <max> limit — <name>]` (the shared sentence), `isError`. Nothing stored. |
| F2 | Tool sub-cap (48 MiB) or session store full | `putTool` refuses without reserving or evicting. Result: `[image … · not kept: image store full]`, `isError`. User uploads keep ≥ 52 MiB. |
| F3 | Corrupt or truncated header (bad IHDR or CRC, no IEND, no SOF/SOS/EOI) | `inspectImageFile` refuses with one sentence. Nothing stored or sent. |
| F4 | Huge dimensions (also when the bytes are under the cap) | Refused before storing, against `maxEdge` (Q1). This blocks a provider 400 that would stay in the history. |
| F5 | CMYK, 12-bit, arithmetic or lossless JPEG | Refused with a sentence naming the variant. Progressive `SOF2` and extended `SOF1` (8-bit) are accepted. |
| F6 | `.jpg` that is really PNG (or the reverse) | The MIME type comes from the bytes, so it is stored and sent as what it is. The marker shows the real format. |
| F7 | `.png` that is text / that is unknown binary | Text → today's text path. Binary → "not a PNG or JPEG image". |
| F8 | No vision / pod / sub-agent | No `ctx.images` → today's `readFile` path, byte for byte. |
| F9 | A `serve` restart or worker resume loses the tool index | `image_view` errors with "fs_read the file again". The same bytes give the same id, and `putTool` dedupes onto the stored blob (image-view F3). |
| F10 | `low` asked on a file image | `high` is served with the note (D4). |
| F11 | Concurrent reads of one file | Dedupe or a join in `putTool` (`:467-474`). |
| F12 | A pod or a hostile workspace | No handle in any pod (image-view D1/T7). This task adds no new laptop-side effect. |
| F13 | Version skew | No wire change. A JPEG ref was always a valid `AttachmentRef`. |

### Tests (red first, §9: each row is shown failing before its code)

- **T1 core `image-file.test.ts`:**
  - accepted with the right sizes: a valid PNG, a baseline JPEG, a progressive (`SOF2`)
    JPEG;
  - refused, each with its sentence: a PNG with a bad IHDR CRC, a PNG cut before `IEND`,
    a JPEG cut before `EOI`, a JPEG with no SOF, a CMYK JPEG, a 12-bit JPEG, an
    arithmetic JPEG, a file with `w > maxEdge`;
  - refused at the boundary: an image exactly at `maxEdge` is accepted, one at
    `maxEdge + 1` is refused.
- **T2 core + providers:** `imageOverCapReason` gives the same text as today's
  placeholder (the existing provider tests stay green unchanged).
- **T3 tools `fs-read-image.test.ts`** (fake env with `readBytes`, spy `ToolImageStore`):
  - PNG → a marker with `ref <id12>`, **0 refs**, `putTool` called once with
    `image/png` and no `low`;
  - JPEG → `image/jpeg`;
  - `.jpg` holding PNG bytes → `image/png`;
  - over the cap → the reason line, no `putTool`, no full read;
  - a store refusal → `not kept: …`, `isError`;
  - a range → refused;
  - GIF/WebP → refused (Q2);
  - a `.png` holding text → the text path;
  - **without `ctx.images` → exactly the bytes `readFile` returns today** (golden);
  - a PDF read is unchanged (one existing PDF golden runs again).
- **T4 tools `image-view.test.ts`:**
  - `low` on a 2000×1000 entry with `low === high` → high ref + the not-available note,
    NOT "already ≤ 768 px";
  - a 600×400 entry still says "already ≤ 768 px".
- **T5 providers `tool-images.test.ts`:** a JPEG tool ref → exactly 1 image part, with
  `image/jpeg` on Anthropic and on OpenAI (the step-0 repro, kept).
- **T6 cli `image-view-wiring.test.ts`:**
  - with vision, `fs_read` receives the model's `maxImageBytes` and Q1's `maxEdge`;
  - the pod row stays absent.
  - Mutation: hard-code `maxImageBytes = MAX_IMAGE_BYTES` → this test goes red.
- **T7 daemon `attachment-tool-images.test.ts`:** `putTool` with `image/jpeg` → the ref
  carries `image/jpeg`; a `serve` reload still counts it against the sub-cap.

Mutations to run and record: drop the IEND or EOI check (T1 red); use the extension
instead of the sniff for the MIME type (T3 `.jpg`-is-PNG red); drop the D4 size check
(T4 red).

### Owner questions

1. **Largest side accepted for an image file (`maxEdge`).** `high` is the ORIGINAL file,
   because nothing downscales yet.
   - Anthropic accepts up to 8000 px and downscales on its side, so it costs at most
     about 1600 tokens. A larger image makes it return 400.
   - OpenAI-compatible servers (Qwen/vLLM) take the original. A 4032×3024 phone photo
     can cost about 15k tokens there, while we estimate a flat 3200. The context limit
     could then be crossed without warning.

   Options:
   - **(A)** 8000 px everywhere.
   - **(B)** 1568 px everywhere until 3a/3b. This refuses most phone photos and Retina
     screenshots.
   - **(C)** 8000 px on Anthropic and 1568 px on OpenAI-compatible, decided in wiring
     next to the byte cap.

   **Recommendation: (C).** Claude gets the full value, and Qwen gets no surprise in
   token count. Separately, Anthropic's 3.75 MiB byte cap will still refuse many
   full-size phone JPEGs (F1) until a decoder exists.
2. **GIF and WebP files.** Providers accept both, and the header helpers already read
   their sizes. **Recommendation: not in this task.** Keep the scope to PNG/JPEG, and
   refuse GIF/WebP/HEIC in vision sessions with a sentence that names the type ("GIF
   files are not readable as images yet"), instead of today's mojibake. Adding them
   later only adds two `inspectImageFile` cases.

### Notes / debt

- In sessions without vision or with no store, a PNG still reads as mojibake text,
  because the Context requires today's behaviour there. A plain refusal would be better.
  That is a separate decision.
- `low` for files (a real downscale) arrives with 3a (PNG) and 3b (JPEG). D4's note then
  disappears on its own, because `low` will differ from `high`.
- The flat token estimate does not depend on pixel count. Q1 (C) bounds the risk; it does
  not remove it.

## Execution

*— Claude (Claude Code executor; exact model id not exposed in this environment), 2026-11-24*

Branch `feat/image-files` (worktree `.tentacle/worktrees/image-files`). Implemented in the
Implementation's dependency order; every test row was run RED before its code (records
below), and all three of the plan's mutations plus two of my own were run and reverted.

### Step 0 — the load-bearing assumption, PROVED (repro kept as T5)

`.tentacle/tmp/image-files/step0.ts` (a real `AttachmentStore` → `putTool` with
`mimeType: "image/jpeg"` cast past the old literal → `viewImage` → `checkAttachmentRefs`
→ `AnthropicProvider` and `OpenAIProvider` with a recording `fetch`):

```
png1x1:  OK ref=36d9c02b8b4d id-matches-bytes=true anthropic=[image/png]  openai=[data:image/png;base64,iVBORw0KGg]
jpeg1x1: OK ref=5f9f01ecb3a4 id-matches-bytes=true anthropic=[image/jpeg] openai=[data:image/jpeg;base64,/9j/4AAQS]
```

Both formats reach both providers as EXACTLY one image part with their own MIME type: the
only edit the plan makes on image-view's path (widening `ToolImagePut.mimeType`) is
enough, and no daemon code changed. Kept as T5 in `providers/test/tool-images.test.ts`.

### As built, per slice

1. **`core/src/image-file.ts` (new)** — `inspectImageFile(bytes, {maxEdge})`, the PNG
   checks (signature, a 13-byte `IHDR` with a matching `crc32`, 1..65535 sides, the legal
   depth/colour table, interlace 0|1, an `IEND` in the last 1 KiB), the JPEG walk (frame
   header → `SOS` → `EOI`, with CMYK / non-8-bit / arithmetic / lossless-hierarchical
   each refused by its own sentence), the `maxEdge` bound, plus `imageOverCapReason`,
   `imageFileMarker`, `ImageFileLimits` and `DEFAULT_IMAGE_FILE_MAX_EDGE`.
   `tool-images.ts`: `ToolImagePut.mimeType` widened to `"image/png" | "image/jpeg"` (D3,
   the load-bearing edit). Exported from `core/src/index.ts`.
2. **`providers/src/images.ts`** — `placeholder` calls `imageOverCapReason` (one source
   for the sentence; the provider tests pin the bytes and stayed green unchanged), and
   `imageFileMaxEdge(provider)` (8000 / 1568) sits beside the byte cap (Q1 C).
3. **`tools/src/image-file.ts` (new) + `builtins.ts`** — the branch runs inside the read,
   AFTER the PDF branch and after the "`pages` applies only to PDFs" refusal, and only
   with `ctx.images` + `ctx.env.readBytes`, so every other session is byte-for-byte
   today's. The head decides: PNG/JPEG → the image path; gif/webp/heic → a sentence naming
   the type (Q2); an image extension with non-image, non-text bytes → "not a PNG or JPEG
   image"; anything else → the text path. Then: a range refused, a `readBytes` cap
   refusal → the shared reason line, `inspectImageFile`, `putTool` with `high` only and
   **0 refs**. `createFsReadTool` takes `{maxImageBytes, maxEdge}`. `image-view.ts` D4:
   the `low === high` note now distinguishes a genuinely small picture from an image file
   read at `high` only, and the description/`REGENERATE` text follow.
4. **`cli/src/wiring.ts`** — passes `imageLimits(...).maxBytes` and
   `imageFileMaxEdge(config.provider)`.
5. **`changelog.d/image-files.added.md`**.

**No drift from the Design**, with one shape note: D2 says the head read is
`readLimitBytes: PDF_HEAD_BYTES` on the non-PDF path. My first cut took that head BEFORE
`readPdf`, which made a PDF pay a second read; I moved the branch inside the read (its own
head read, after `readPdf` returned `undefined`), which is what D2's "after `readPdf`
returns `undefined`" says. No protocol file, no `PROTOCOL_VERSION` change, no daemon
change.

### Red-before-green (the exact rows)

- `core/test/image-file.test.ts` — 9 red before the JPEG `SOS`/`EOI` logic and the marker
  landed ("the JPEG is truncated or corrupt" for every accepted case; `2.0 KB` vs
  the real `formatBytes` `2 KB`), green after.
- `tools/test/fs-read-image.test.ts` — the whole file red before the branch (ReferenceError
  on the missing option, then `WEBP`/mojibake assertions), green after.
- `tools/test/image-view.test.ts` — the D4 rows red before `highOnly` existed (a large
  `low === high` entry still said "already ≤ 768 px"), green after.

### Mutations run (production code edited, target test shown red, reverted)

| Mutation | Red |
|---|---|
| drop the PNG `IEND` check | `inspectImageFile: PNG > a PNG cut before IEND counts as truncated` |
| drop the JPEG `EOI` check | `inspectImageFile: JPEG > a JPEG cut before EOI counts as truncated` |
| the extension decides the MIME type | `fs_read … a .jpg holding PNG bytes is stored as image/png` |
| drop D4's size check in `highOnly` | `image_view … a genuinely small picture still says it is already ≤ 768 px` |
| `imageFileMaxEdge` → 8000 everywhere | `an OpenAI-compatible endpoint takes 1568 px: the same file is refused` |
| hard-code `maxImageBytes` in wiring | `the model's own maxImageBytes reaches the read` |

All five touched files were green again after each revert (`598 pass / 0 fail` across the
32 test files of core/tools/providers-images/cli-wiring/daemon).

### Coverage vs the plan's tests

T1 (`core/image-file.test.ts`, 28 rows: accepted PNG / baseline / SOF1 / SOF2 / greyscale,
every refusal, and the `maxEdge` / `maxEdge + 1` boundary), T2 (in the same file, plus the
providers' unchanged goldens), T3 (`tools/fs-read-image.test.ts`, 13 rows: PNG, JPEG,
`.jpg`-is-PNG, over-cap with no full read, store refusal, a range, GIF/WebP, `.png`-is-text,
`.png`-is-binary, the no-store golden, and `images: false` returning the shared constant),
T4 (2 rows in `image-view.test.ts`), T5 (2 rows in `providers/tool-images.test.ts`),
T6 (3 rows in `cli/image-view-wiring.test.ts`), T7 (2 rows in
`daemon/attachment-tool-images.test.ts`). Unverified in this environment: the full
`bun run check` — the orchestrator's script runs it; locally `packages/{core,tools,
providers,daemon}` typecheck clean, and `packages/cli`'s typecheck reports only the 12
pre-existing `SharedAutoAccept`/`RoutingAutoAccept` errors that `main` reports too (none
in `wiring.ts` or the wiring test).

## Review

*— claude-opus-5-5, 2026-11-24* (fresh context; same model family as the planner — shared blind spots possible)

**Verdict: APPROVE-WITH-NITS** (no HIGH/MEDIUM). Scope: `git diff main...HEAD` only.

**Gate.** Touched files: `bun test` core/image-file, tools/fs-read-image, tools/image-view, providers/tool-images, cli/image-view-wiring, daemon/attachment-tool-images → **97 pass / 0 fail**. `bun run lint` clean (2375 files). `bun run typecheck` clean (all three projects — the 12 cli errors Execution mentions do not reproduce here). Full `bun test` not re-run (left to the merge gate).

**Mutations (each red, reverted, `git status` clean after):** range refusal disabled → `a line range on an image is refused` red; `> maxEdge` → `>=` → `an image exactly at maxEdge is accepted` red; wiring `maxEdge` hard-coded 1568 → `anthropic takes 8000 px` red.

**Premises checked.** `"image/png"` literal: no consumer downstream of `putTool` checks it (only `attachment-store.ts:509` copies `input.mimeType`); `readPdf` already does a `readBytes` head read (`builtins.ts:233`), so the image branch adds no new error shape for missing/unreadable paths; `FileTooLargeError.sizeBytes` exists (`core/src/execution.ts:63`). TRUE.

**Attacks tried.** (1) §7 pod/untrusted: image path only when wiring passes `toolImages` AND vision; the shared `fsReadTool` stays text-only; a sub-agent reusing the image variant without `ctx.images` falls through (`builtins.ts` `ctx.images !== undefined` guard) — holds. (2) Real files E2E (`.tentacle/tmp/image-files/review-e2e.ts`, real `HostExecution` + the real `createFsReadTool`): a sips-made JPEG and two repo PNGs → correct markers, `putTool` with `image/jpeg`/`image/png`, `package.json` → today's text byte for byte — holds. (3) JPEG EOI search starts after SOS, so an EXIF thumbnail's `FF D9` (APP1, before SOF) cannot fake completeness; MPF trailing images after the main EOI are accepted — holds. (4) Persistence/wire: the stored ref is an ordinary `AttachmentRef` with `image/jpeg` (already in `IMAGE_MIME_TYPES`); no log/protocol change — holds.

**Nits (not blocking).**
1. `tools/src/image-view.ts` `highOnly` — D4 said "when `detail === "low"`"; as built the note also appears on an explicit `high` call ("low is not available … sent at high"). True but noisy; undeclared drift from D4.
2. `core/src/image-file.ts` `hasIend` — a valid PNG with > 1 KiB of trailing data after `IEND` is refused as "truncated or corrupt" (rare; the plan chose this bound).

**Executor behaviour.** Followed the plan order, recorded red-before-green and six mutations; one honest shape note (branch moved after `readPdf`). The `cli` typecheck caveat in Execution was stale.
