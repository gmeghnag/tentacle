# feat/image-region-png — `image_view` crops and zooms PNG pictures (slice 3a of image-on-demand)

> **Status:** implementation (APPROVED — orchestrator decisions below, owner-delegated 26/11)
> **Branch:** `feat/image-region-png`
> **Size:** M · **Blast:** cross-module (the `ToolImageStore` seam gains `read`; an untrusted-bytes parser runs on the daemon thread; no protocol, persistence-format or §7 invariant change) · **Suited:** Sonnet/DeepSeek executes (S/M routing); **mandatory fresh-context Opus Review** (a parser of untrusted bytes with memory caps — red-team the caps, not just the happy path)
> **Changelog:** `changelog.d/image-region-png.added.md`

## Context

*— claude-opus-5-5, 2026-11-26*

Decided in `docs/eval/image-on-demand.md` § Owner answers (23/11), binding:
answer 5 — «`region` crop/zoom: slice 3, as TWO tasks — PNG first (our PDF page
images), JPEG second (decoder dependency decision)»; answer 6 — `detail` is
`low` (long edge ≤ 768 px, default) or `high` (≤ 1568 px), chosen by the model
or forced by `model.imageDetail`. This is **3a: PNG**. Slices 1
(`feat/image-view`), `feat/image-files` and 2 (`feat/image-old-on-demand`) are
merged; their docs are the source of truth for the tool, the refs, `detail`
and the store's caps.

Why: `image_view` today can only pick a whole stored variant
(`packages/tools/src/image-view.ts:195-218`); it "never reads a byte"
(`image-view.ts:6-7`). A dense PDF page or a browser screenshot at `low`
(768 px) is often unreadable, and `high` (1568 px) costs ~4× the tokens for the
whole page when the model needs one table cell. A region lets the model send
**fewer pixels at higher effective resolution**. Two promises also wait on a PNG
decoder: `low` for image FILES ("`low` for files … arrives with 3a (PNG)",
`docs/feat/image-files.md:315-316`; today a file is `high only`,
`packages/core/src/image-file.ts:309-322`, `image-view.ts:114,122-127`).

What exists: `packages/core/src/png.ts` is an **encoder only** — 8-bit
gray/RGB/RGBA, filter None, one IDAT (`png.ts:1-9,69-112`), with `crc32`
(`png.ts:43-50`). The PDF path already has a box downscale and the size rule
(`packages/core/src/pdf-images.ts:202-255`). `node:zlib` inflate is available to
the daemon-side tools package (`packages/tools/src/pdf/run.ts:8` imports
`node:zlib`), but `@tentacle/core` must stay `node:`-free — the phone imports it
(`png.ts:5-8`; e.g. `apps/mobile/src/tool-steps.ts` imports `@tentacle/core`).

**Repro** (2026-11-26, `.tentacle/tmp/image-region-png/repro.ts`, run with `bun repro.ts` from that folder):

```ts
// feat/image-region-png repro: image_view has no region, core has no PNG decoder.
import * as core from "../../../packages/core/src/index.ts";
import { createImageViewTool } from "../../../packages/tools/src/image-view.ts";

const input = { ref: "a1b2c3d4e5f6", region: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } };
for (const setting of ["auto", "high"] as const) {
  const tool = createImageViewTool(setting);
  console.log(`${setting}: parsed =`, JSON.stringify(tool.inputSchema.parse(input)));
  console.log(`${setting}: description mentions region =`, tool.description.includes("region"));
}
const pngExports = Object.keys(core).filter((k) => /png/i.test(k));
console.log("core PNG exports:", pngExports.join(", "));
```

```
auto: parsed = {"ref":"a1b2c3d4e5f6"}
auto: description mentions region = false
high: parsed = {"ref":"a1b2c3d4e5f6","region":{"x":0.5,"y":0.5,"width":0.5,"height":0.5}}
high: description mentions region = false
core PNG exports: PNG_CHANNELS, encodePng
```

So today a `region` is **silently dropped** under `auto` (strip schema,
`image-view.ts:58-61`) and **silently ignored** under a forced setting
(`.passthrough()`), and the whole picture is sent — a model that asked for a
zoom gets no signal that it did not get one. No decoder exists.

Probe of the runtime this plan leans on (same folder, `zlib-probe.ts`, Bun 1.4.3, this Mac):

```
sync over cap throws: RangeError ERR_BUFFER_TOO_LARGE
sync exact cap ok 10000000
async over cap throws: RangeError ERR_BUFFER_TOO_LARGE
async inflate 48MB ms 34
truncated throws Error Z_BUF_ERROR
JS paeth unfilter 48MB ms 237
```

i.e. `inflate`/`inflateSync` honour `maxOutputLength` (a zip bomb is cut, not
allocated), a truncated stream throws, async inflate runs off the JS thread,
and the JS unfilter costs ≈ 5 ms/MB on the daemon thread.

## Implementation

*— claude-opus-5-5, 2026-11-26*

**APPROVED** (orchestrator, owner-delegated: "close tonight, pick the
recommended option"). Every open choice is recorded under
**#### Orchestrator decisions** with its reason.

### Load-bearing assumption

**The process that runs `image_view` holds the picture's bytes and can read
them, and a crop written back through `putTool` behaves like every other
`image_view` image: the provider inlines it, and its OWN id resolves for a
later `image_view` (so the prune stub's "image_view <id12> again" still
works).** If any link fails, a region would need a new byte path or a new
store write — a different, larger task.

Each link, verified:
1. **Same object, readable.** The tool gets the store as `ctx.images`
   (`packages/agent/src/agent.ts:1452`), "the SAME object as `attachments`"
   (`agent.ts:680-685`); the daemon passes one `uploads` for both
   (`packages/daemon/src/session-host.ts:1689-1691`). That class already
   implements `read(ref)` — memory or disk, size-checked, `null` never a throw
   (`packages/daemon/src/attachment-store.ts:174,426-438`). Only the TYPE the
   tool sees lacks it: `ToolImageStore` = `putTool` / `resolve` / `holds`
   (`packages/core/src/tool-images.ts:69-74`).
2. **A crop is a normal `image_view` image.** `putTool` takes any PNG bytes
   with a size, computes the sha256 id itself, dedups, reserves under the
   session cap + the 48 MiB tool sub-cap, refuses without eviction
   (`attachment-store.ts:54,464-542`), and indexes the high id
   (`attachment-store.ts:517-520`) — so `resolve(prefix)` finds it
   (`attachment-store.ts:549-564`). The result's `image` becomes the tool
   message's one attachment (`packages/core/src/tool.ts:117-122`,
   `agent.ts:296-309`), exactly as `browser_shot` does it today
   (`packages/tools/src/browser.ts:865-875`).
3. **The prune stub names the attachment's id** (`packages/agent/src/prune.ts:197-205,608-614`),
   i.e. the crop's own id — resolvable by link 2.

**Prove first (Execution step 0, before production code):** a scratch test in
`.tentacle/tmp/image-region-png/step0.test.ts` (run with `bun test <path>`)
over a real memory `AttachmentStore`: `putTool` a PNG made by `encodePng`;
`await store.read(entry.high.ref)` returns byte-identical bytes;
`store.resolve(entry.high.ref.id.slice(0, 12))` is `{kind:"found"}`. Paste the
output into Execution. If any fails, STOP and fix the plan (§8).

### Preconditions

- **Where the tool exists.** Registered only with a store AND vision
  (`packages/cli/src/wiring.ts:1376-1394`); the store is given only when
  `images.source === "store"` (`session-host.ts:134-140,1689-1691`). A pod
  whose model runs on the laptop (`"client"`), a sub-agent, and `images:false`
  have no tool — unchanged by this task, so **no pod ever decodes, and no byte
  travels pod → laptop** (§7 "compute next to the code, identity with the
  user"). On `connect`, the `serve` daemon holds the store and decodes there.
- **Which bytes a ref can name.** A tool entry (`resolve`, `image-view.ts:173-194`)
  or the conversation's own user image (`image-view.ts:93-113,190-191`); both
  live in the same store, and `holds` is checked before use
  (`image-view.ts:141,199`). PDF pages' `high` is ≤ 1568 px
  (`pdf-images.ts:305-313`); image files and browser shots are `high` only, up
  to `imageFileMaxEdge` = 8000 px on Anthropic, 1568 elsewhere
  (`packages/providers/src/images.ts:305-309`, `wiring.ts:1390,1410`).
- **Byte caps.** The model's per-image cap: Anthropic 3,932,160 B, OpenAI-
  compatible 5 MiB (`images.ts:46,53`), passed to tools as
  `imageLimitValues.maxBytes` (`wiring.ts:1379,1389`); the wire's own
  `MAX_IMAGE_BYTES` = 15 MiB (`packages/protocol/src/attachment.ts:37`), also
  `putTool`'s per-variant bound (`attachment-store.ts:482`).
- **Detail.** `TOOL_IMAGE_LOW_EDGE = 768` (`tool-images.ts:18-19`); `high` = 1568
  (`pdf-images.ts:311`); `scaledSize` never upscales (`pdf-images.ts:202-216`);
  `downscalePixels` is a box filter over 8-bit channels (`pdf-images.ts:219-255`).
- **Concurrency.** `concurrency` receives the call's input
  (`packages/core/src/tool.ts:284-286`); `image_view` claims `read` on
  `"tool-images"` today (`image-view.ts:71`). `putTool` is safe under
  concurrent puts (pending map + synchronous reservation,
  `attachment-store.ts:467-504`).
- **Core purity.** `@tentacle/core` imports no `node:` module (`png.ts:5-8`);
  codecs are injected (`Deflate`, `png.ts:14-15`).
- **Fakes.** Test files that build a `ToolImageStore` (they must gain `read`):
  `rg -l putTool packages --glob '**/test/**'` → `tools/test/{image-view,image-view-user,fs-read-image,builtins,browser,concurrency}.test.ts`,
  `agent/test/{loop-attachments,loop-old-images}.test.ts`,
  `daemon/test/attachment-tool-images.test.ts`.

### Design

**D1 — Contract.** `image_view({ ref, detail?, region? })`, `region` =
`{ left, top, width, height }`, each a **fraction 0–1 of the picture** (O1).
Schema: `left`/`top` `min(0).max(1)`, `width`/`height` `positive().max(1)`;
declared in BOTH schemas (auto and forced, `image-view.ts:58-61`) so it is
never stripped. Description gains one sentence: "`region` zooms into part of a
PNG picture: fractions 0–1 of its size, e.g. `{left:0.5, top:0, width:0.5,
height:0.5}` = the top-right quarter; the part is sent at up to the detail's
size, never enlarged." No `region` ⇒ today's code path, byte for byte.

**D2 — `packages/core/src/png-decode.ts` (new, pure).** `Inflate = (bytes,
maxOutputLength) => Promise<Uint8Array>` (injected; must reject past
`maxOutputLength`).
- `readPngHeader(bytes)` → `{ width, height, depth, colorType, interlace,
  palette?, transparency?, idat: Uint8Array[], rawBytes, outColor }` or
  `{ refused }`. Walks every chunk: signature; IHDR first, 13 bytes; **every
  chunk's CRC** (`crc32`, `png.ts:43`); legal depth/colour pairs (the same table
  as `image-file.ts:49-56` — move it to `png-decode.ts` and import it back, one
  truth); compression/filter method 0; interlace 0/1; PLTE required for type 3
  (length % 3 = 0, ≤ 256 entries); tRNS kept; consecutive IDATs; IEND present;
  an unknown CRITICAL chunk (uppercase first letter) refuses; ancillary chunks
  (gAMA, iCCP, sRGB, eXIf, acTL…) are ignored. `rawBytes` = the exact inflated
  size from the header (non-interlaced: `H × (1 + ceil(W·bpp/8))`; Adam7: the
  sum over the 7 non-empty passes).
- `pngDecodeCost(header)` = `rawBytes + W·H·outChannels`; the caller refuses
  above `MAX_PNG_DECODE_BYTES` (O4) **before any inflate**.
- `decodePng(bytes, inflate)` → `{ width, height, color: PngColor, pixels }` or
  `{ refused }`; never throws on bad bytes. `inflate(concat(idat), rawBytes)`;
  a reject or a length ≠ `rawBytes` = corrupt. Unfilter types 0–4 (any other
  byte = corrupt), per pass for Adam7, then expand to 8-bit:
  16-bit → high byte; gray 1/2/4 → scaled to 0–255; palette → RGB (RGBA with
  tRNS; an index past the palette = corrupt); gray/RGB tRNS key (compared at
  the file's depth) → RGBA; gray+alpha → RGBA. `outColor` is `gray`, `rgb` or
  `rgba` (`encodePng`'s set, `png.ts:12`).

**D3 — `packages/core/src/image-region.ts` (new, pure).**
- `regionBox(region, W, H)` → `{ x, y, width, height, clamped }` in pixels of
  the source picture (`x = floor(left·W)`, `x1 = ceil(min(1, left+width)·W)`,
  same for y), or `{ refused }`: `left ≥ 1` / `top ≥ 1` ("starts at the
  picture's edge"); a side `< MIN_REGION_PX = 8` ("N×M px — too small; pick a
  larger part"). `clamped` when `left+width > 1` or `top+height > 1` (O3).
- `cropPixels(pixels, W, H, channels, box)` — returns `pixels` itself when the
  box is the whole picture.
- `renderRegion({ decoded, box, maxEdge, maxBytes, deflate })` → `{ png, width,
  height, scaledForBytes }` or `{ refused }`: crop; drop alpha when every alpha
  is 255 (O5); `scaledSize` + `downscalePixels` to `maxEdge` (never up);
  `encodePng`; while `png.length > maxBytes`, long edge × 0.75, at most 3 times,
  then refuse "the region is too detailed to send under this model's N MB
  image limit — pick a smaller part or detail low".

**D4 — The tool (`packages/tools/src/image-view.ts`).** `createImageViewTool(setting,
{ maxImageBytes })` (default `MAX_IMAGE_BYTES`); `node:zlib` `inflate`
(promisified) and `deflateSync` are bound here, never in core. With `region`,
after today's resolve/holds checks pick the source:
- tool entry → `entry.high` (O2); user image → its own ref (no variants exist,
  `image-view.ts:129-133`);
- `mimeType !== "image/png"` → error "region needs a PNG picture; this one is
  JPEG (JPEG regions come later) — call image_view without region" (O7);
  nothing read;
- `ctx.images.read(ref)` → `null` ⇒ today's "no longer held" sentence;
- `readPngHeader` → `regionBox` (on the header's size) → `decodePng` (the cost
  check lives inside it, before its inflate) → `renderRegion`
  *(fixed in Execution: the first draft decoded before `regionBox`, against
  § Failure modes "nothing decoded")* with `maxEdge` = 768 or 1568 by the resolved detail (forced setting wins, as
  today, `image-view.ts:195-196`) and `maxBytes = min(maxImageBytes,
  MAX_IMAGE_BYTES)`;
- `putTool({ variants: { high: { bytes: png, width, height } }, mimeType:
  "image/png", label: "<label> region" })` (O9); `{refused}` ⇒ error "the
  region was not kept: <reason>";
- result: `content` = `<label> · region <x>,<y> <w>×<h> of <W>×<H> · sent
  <ow>×<oh> · <detail> · <size>` + ` · clamped to the picture's edge` /
  ` · scaled down to fit the image limit` when they apply; `image` = the crop's ref.
`concurrency(input)`: with `region` →
`[{read,"tool-images"},{write,"image-decode"}]`; else today's claim. One decode
at a time (O4) is also held by a promise slot inside the tool instance around
read → decode → render. *(Fixed in Execution: `concurrency` sees only the
input, `packages/core/src/tool.ts:284-286`, so it cannot know a call takes the
O8 `low` path; the slot covers it.)*

**D5 — `low` for a high-only PNG (O8).** When the resolved detail is `low`, the
entry is high-only (`highOnly`, `image-view.ts:122-127`) and its mime is PNG,
run D4 with the whole-picture box at 768 px instead of serving `high` with
`HIGH_ONLY_NOTE`. A high-only JPEG keeps today's note. User images keep D3 of
image-old-on-demand ("sent as attached") unchanged.
*(Fixed in fix round 1, review finding 2: when D5's downscale cannot be made —
header or decode refused, over the budget or the byte cap, not kept by the
store — the call answers as before D5: `high` + `HIGH_ONLY_NOTE`, never an
error. § Failure modes' error rows apply to an explicit `region`. Bytes gone is
"no longer held" for both.)*

**D6 — Seam (`packages/core/src/tool-images.ts`).** `ToolImageStore` gains
`read(ref: AttachmentRef): Promise<Uint8Array | null>` (required — O11).
`AttachmentStore` already satisfies it (`attachment-store.ts:426`); fakes add it.

**D7 — Presentation.** TUI `toolSubtitle` (`packages/tui/src/render-lines.ts:785-788`)
and its phone mirror (`apps/mobile/src/tool-summary.ts:125-128`) append
` · region` when the args carry one. No protocol change: `tool_call` /
`tool_result` are generic; no `protocol.d/` note.

#### Orchestrator decisions

*— claude-opus-5-5 (orchestrator, owner-delegated 26/11), recommended option taken each time*

- **O1 Coordinates: fractions 0–1, not pixels.** The model may have seen the `low` (768) or the `high` (1568) variant; pixels read off one and applied to the other crop the wrong area silently, fractions mean the same on both.
- **O2 Crop the `high` variant; never upscale.** It is the most pixels we keep; enlarging adds tokens and no information — "zoom" = the part at up to the detail's size.
- **O3 Overflow clamps with a note; empty/tiny refuses.** A box spilling past the edge has an obvious intent; a box starting at the edge or under 8 px has none.
- **O4 Decode budget `MAX_PNG_DECODE_BYTES = 128 MiB` (inflated stream + 8-bit output), checked from the header before inflate; one region decode at a time per batch (`image-decode` write claim).** Fits a 5K RGBA screenshot (≈ 118 MiB) and every PDF page (≤ 20 MiB); the inflate's `maxOutputLength` = the header's exact size makes a lying IDAT a refusal, not an allocation.
- **O5 Output channels minimal (opaque RGBA → RGB, palette expanded) and a ×0.75 step-down (≤ 3) before refusing over the byte cap.** The encoder is filter-None (`png.ts:2-3`), so a photo-like 1568² crop can exceed Anthropic's 3.9 MB; stepping down beats a refusal.
- **O6 Decode every legal PNG (1/2/4/8/16-bit, palette + tRNS, gray+alpha, Adam7); ignore gAMA/iCCP/sRGB/eXIf.** Image files and user uploads can be any of them; refusing a legal PNG would be arbitrary, and each case is a few lines plus a fixture.
- **O7 A JPEG `region` is an error result naming 3b; no JPEG byte is parsed.** CMYK, progressive and EXIF-orientation handling belong to the decoder-dependency decision of 3b.
- **O8 `low` for high-only PNG files/screenshots ships here.** The same pipeline at the whole-picture box; `image-files.md:315-316` promised it with 3a and `low` is the owner's default (answer 6).
- **O9 The crop goes through `putTool` (labelled `<label> region`) — not an unindexed write.** The prune stub re-views by the crop's own id (link 3); dedup makes a repeated crop free in the store.
- **O10 Async `inflate` with `maxOutputLength`, sync `deflateSync` for the ≤ 1568² output.** Inflate is the big buffer and runs off the JS thread; the encode is bounded by the detail cap. Worker offload of the unfilter is debt (below).
- **O11 `read` is a REQUIRED member of `ToolImageStore`.** The one real implementer already has it; an optional member would add a branch for a case that does not exist.
- **O12 Fixtures: the official PngSuite (Willem van Schaik; its licence permits use, copy and redistribution for any purpose), a named subset committed with a README (source URL, licence line, sha256 per file).** Real files from an independent encoder; our own `encodePng` writes only 8-bit filter-None and would test the decoder against itself.

### Files

Dependency order (no protocol, daemon, client or persistence file):
1. `packages/core/src/png-decode.ts` (new) — D2; PNG depth table moved here.
2. `packages/core/src/image-file.ts` — import the depth table (`:49-56`), no behaviour change.
3. `packages/core/src/image-region.ts` (new) — D3.
4. `packages/core/src/tool-images.ts` — `ToolImageStore.read` (D6).
5. `packages/core/src/index.ts` — export the two new modules (next to `png.ts`, `:44`).
6. `packages/tools/src/image-view.ts` — D1, D4, D5.
7. `packages/cli/src/wiring.ts:1393` — `createImageViewTool(config.imageDetail ?? "auto", { maxImageBytes: imageLimitValues.maxBytes })`.
8. `packages/tui/src/render-lines.ts:785-788`, `apps/mobile/src/tool-summary.ts:125-128` — D7.
9. Test fakes listed in Preconditions — add `read`.
10. Tests + fixtures (below); `changelog.d/image-region-png.added.md`, e.g. `- **image_view zooms into PNG pictures.** A `region` (fractions of the picture) sends just that part, at up to the chosen detail; `low` now works for PNG files and screenshots.`

### Failure modes

| Mode | Convergence |
|---|---|
| Region outside the picture (`left`/`top` ≥ 1) | Error result naming the bounds; nothing decoded, nothing stored |
| Region spilling past an edge | Clamped; the result says `clamped to the picture's edge` |
| Zero/negative size | Schema refuses (`positive()`); the zod message reaches the model as today's input errors do |
| Tiny region (< 8 px a side after mapping) | Error "N×M px — too small; pick a larger part" |
| Pixel coordinates passed (> 1) | Schema refuses (`max(1)`); the description says "fractions 0–1" |
| Huge picture | Cost from the header only; > 128 MiB → error naming W×H and both MiB numbers, `inflate` **never called** |
| IDAT bigger than the header says (bomb) | `maxOutputLength` = exact size → reject → "corrupt (more image data than its header declares)" |
| Corrupt file (signature, any CRC, missing IHDR/IDAT/IEND, truncated stream, filter byte > 4, palette index out of range, unknown critical chunk) | One sentence `<label>: the PNG is corrupt (<what>)`, `isError`; never throws; nothing stored |
| Interlaced / 16-bit / 1–4-bit / palette / tRNS / gray+alpha | Decoded (O6), each pinned by a fixture |
| APNG | Default image (IDAT) only; animation chunks ignored |
| JPEG (CMYK, progressive, EXIF orientation…) | `region` → error naming 3b; plain views unchanged (O7) |
| PNG `eXIf` orientation | Ignored: coordinates and the crop are in stored-pixel orientation. Debt if a provider is found to rotate a whole PNG view by `eXIf` |
| Output over the byte cap | ×0.75 step-down ≤ 3 times (noted), then an error suggesting a smaller part or `low` |
| Detail cap | `low` ≤ 768, `high` ≤ 1568 long edge; a forced setting wins; never upscaled |
| Store full (48 MiB tool sub-cap) / disk write fails | `putTool` `{refused}` → "the region was not kept: <reason>"; no eviction (image-view owner Q2); nothing on the wire |
| Bytes gone (`read` → `null`) | Today's "no longer held — fs_read the file again…" |
| Two regions in one batch | Serialized by the `image-decode` write claim; same crop twice → `putTool` dedup/pending join (`attachment-store.ts:467-474`) |
| Pod (`client` images), sub-agent, `images:false` | No store → no tool (unchanged); no pod decodes, no pod → laptop bytes |
| `connect` to `serve` | The serve daemon decodes from its own store; the laptop only renders the row |
| In-process worker | Memory store; a crop is bounded by the sub-cap like any tool image |
| `serve` reload | Tool index is not rebuilt on reload (pre-existing: the constructor only charges marked ids, `attachment-store.ts:205-210`; `toolIndex` is set only by `putTool`, `:518-519`) → a crop's ref answers today's "no image … in this session" like any tool image |
| Daemon-thread blocking | Unfilter ≈ 5 ms/MB (measured) → ≤ ~0.5 s at the cap; a PDF page ≈ 40 ms. Debt: a worker |

### Tests

Red first (§9): each test is shown failing before its code, and its failure
pasted into Execution. Fixtures under `packages/core/test/fixtures/png/` (O12):
`basn0g01 basn0g02 basn0g04 basn0g08 basn0g16 basn2c08 basn2c16 basn3p01
basn3p08 basn4a08 basn6a08 basn6a16 basi0g08 basi2c08 basi3p08 basi6a08
tbbn3p08 tbrn2c08 f00n2c08 f01n2c08 f02n2c08 f03n2c08 f04n2c08 xs1n0g01
xcrn0g04 xhdn0g08 xcsn0g01 xd0n2c08 xdtn0g01` (≈ 30 files, < 1 KiB each).
**If the executor cannot fetch PngSuite, STOP and ask the orchestrator to drop
the archive into `.tentacle/tmp/image-region-png/`** — do not forge fixtures
with `encodePng`.

- **T1 `core/test/png-decode.test.ts` — formats.** Every `basn*`/`basi*`/`t*` decodes
  to its 32×32 size and expected `color`. **Pair oracles** (independent of our
  code): each `basi*` decodes to the same pixels as its `basn*` twin (Adam7);
  `f00…f04n2c08` decode identically (all five filters) — the executor confirms
  the pairs share a picture by PngSuite's docs before relying on it, else uses
  spot pixels. `tbbn3p08` has some alpha 0; 16-bit spot pixels = the high byte
  of the sample read by hand (hex pasted in the test comment).
- **T2 corrupt.** Every `x*` fixture → `{refused}` with a sentence; no throw.
- **T3 budget before inflate.** An IHDR (valid CRC) claiming 60000×60000 → refused
  and an `inflate` spy **was not called** — the exact property "before".
- **T4 bomb.** A 16×16 header whose IDAT is `deflateSync` of 10 MB → refused;
  the real `node:zlib` inflate with `maxOutputLength` is used.
- **T5 `core/test/image-region.test.ts`.** `regionBox`: mapping (floor/ceil),
  clamp flag, `left ≥ 1` and < 8 px refusals; `cropPixels` exact bytes on a
  known pattern; `renderRegion`: long edge ≤ 768/1568, a small crop is NOT
  enlarged, opaque RGBA → RGB, a tiny `maxBytes` forces the step-down then the
  refusal.
- **T6 `tools/test/image-view-region.test.ts`** (real memory `AttachmentStore`,
  the pattern of `daemon/test/attachment-tool-images.test.ts`): a PNG entry +
  region → `image` ≠ the entry's refs; `decodePng` of the stored crop equals
  the expected pixels; `store.resolve(crop.id.slice(0,12))` finds it (the prune
  stub re-view); JPEG entry + region → error and store usage unchanged; corrupt
  stored PNG → error, nothing stored; store full → error; forced setting
  accepts `region`; a region on a user PNG works; `low` on a high-only PNG →
  ≤ 768 px, no `HIGH_ONLY_NOTE`; `low` on a high-only JPEG → today's note.
  Every existing `image-view*.test.ts` stays green unchanged (no-region path
  byte-identical).
- **T7 concurrency.** With `region` the claims include `{write,"image-decode"}`;
  without, today's single read claim.
- **T8 presentation.** TUI `toolSubtitle` and the phone `subtitleOf` show
  `· region` (both existing test files).
- **Mutations (§9, recorded in Execution, reverted):** drop the cost check → T3
  fails; swap two Adam7 pass offsets → T1 fails; skip the clamp → T5 fails;
  serve `entry.high` on a region → T6 fails.

Gate: `bun test` on the touched files while iterating; `bun run check` (and
`tsc -p apps/mobile` within it) before Review.

### Notes / debt

- The unfilter runs on the daemon thread (≤ ~0.5 s at the cap). A worker hop
  (like the PDF worker) if serve with many sessions shows stalls.
- `encodePng` writes filter None only: adaptive filters would shrink crops
  and make the O5 step-down rarer. Separate small task.
- `fs_read` still refuses a PNG over `maxEdge` ("no downscale yet",
  `image-file.ts:288-293`): with a decoder it could store a downscaled `high`.
  Out of scope here (it changes what `fs_read` stores); a follow-up.
- JPEG region + `low` for JPEG files: 3b.

## Execution

*— claude-sonnet-5-5, 2026-11-26*

**Status: PARTIAL — T1/T2 (PngSuite) are missing. Do not merge until they pass.**

**Step 0 (load-bearing check): PASS** (`.tentacle/tmp/image-region-png/step0.test.ts`):

```
read length 405 put length 405
resolve kind found
 1 pass
 0 fail
```

**Repro.** On main (unchanged): `auto: parsed = {"ref":"a1b2c3d4e5f6"}`, no
`region` in the description, core exports `PNG_CHANNELS, encodePng`. On this
branch (`repro-after.ts`, with the contract's `left/top` keys): `region` kept
under `auto` and `high`, description names it, `decodePng` / `readPngHeader`
exported.

**Blocked: fixtures (O12).** `curl` of
`http://www.schaik.com/pngsuite/PngSuite-2017jul19.tgz` needed a permission
approval nobody could give; not worked around, nothing forged.
`packages/core/test/png-decode.test.ts` holds T1/T2 and **35 tests there fail**
("fixture … is missing"), so the gate is red on purpose. To finish:
1. drop the named subset into `packages/core/test/fixtures/png/` with the README
   (source URL, licence line, sha256 per file);
2. run that test file; confirm by PngSuite's docs that `basi*` are the twins of
   `basn*`;
3. add what needs the files: the `f00…f04n2c08` identity check (only if they
   share a picture, else spot pixels) and the hand-read 16-bit spot pixels
   (hex in the comment) — **not written yet**;
4. re-run M2 so T1 itself is shown red.

**Meanwhile (not a substitute for T1/T2).**
- In-tree "hand-computed from the spec" cases: filters 0–4, 1/2/4/16-bit, tRNS,
  palette, gray+alpha, the spec's 8×8 Adam7 diagram. Added after the decoder,
  so their non-vacuity is M2/M11, not a red-first run.
- Scratch differential against `pngjs@3.4.0` (`differential.test.ts`): 239 real
  PNG files and 1440 random ones (every depth/colour pair, both interlace
  methods) → 0 mismatches (16-bit within 1: pngjs rounds, we take the high byte).
- Timing (4096×3072 RGBA, ≈ 48 MB): 52 ms (None) … 315 ms (Paeth).

**As built, in order.**
1. `core/src/png-decode.ts` (D2); `PNG_DEPTHS` moved there, `image-file.ts` imports it.
2. `core/src/image-region.ts` (D3); exports in `index.ts`.
3. `ToolImageStore.read` (D6); `read` added to the test fakes.
4. `tools/src/image-view.ts` (D1/D4/D5); `viewImage` stays the synchronous
   no-decode decision, so the existing tests are unchanged apart from fakes.
5. `cli/src/wiring.ts` passes `maxImageBytes`; D7 in TUI and phone; changelog.

No schema or protocol change.

**Red before green.** `png-decode.test.ts` on a stub: 68 fail, 0 pass.
`image-region.test.ts` on a stub: 11 fail, 1 pass (same-buffer crop).
`image-view-region.test.ts` on the old tool: 25 fail, 5 pass (unchanged
behaviour, plus the LOW-variant case, shown red by M5). T8: 4 fail → green.
The wiring test was added after its edit (M7).

**Drift from Implementation.**
- The two plan fixes marked in D4.
- The 128 MiB check is inside `decodePng`, so no caller can skip it.
- `regionBox` snaps float noise by 1e-9 (`0.07 × 100` is 7 px, not 8).
- After `putTool` the tool sends the variant whose id is the rendered bytes'
  sha256: a whole-picture `low` region of a PDF page renders the stored `low`
  bytes, and the store then answers with that entry, whose `high` is bigger.
- A user image's crop is labelled from the ref's name (else `image`), not
  `attachmentLabel`, whose sha would name the source in the crop's prune stub.
- One extra test: `maxImageBytes` through wiring (`image-view-wiring.test.ts`).

**Mutations (each applied, run, restored; `mutate.ts`).**

| Mutation | Failing test |
|---|---|
| M1 drop the cost check | T3 (both budget cases) |
| M2 swap two Adam7 pass offsets | hand-computed Adam7; also the pngjs differential. **T1 pending** |
| M3 skip the clamp | T5 clamp |
| M4 serve `entry.high` on a region | 18 tool tests |
| M5 always send `entry.high` after the put | equal-to-stored-LOW |
| M6 no decode slot | one-decode-at-a-time |
| M7 wiring drops `maxImageBytes` | wiring cap |
| M8 inflate not capped at the header size | T4 |
| M9 no CRC check | IHDR / IDAT / IEND CRC |
| M10 no D5 downscale | the three D5 cases |
| M11 Paeth always `b` | every-filter case |

**Checks.** Touched and related tests (32 files): 614 pass, 35 fail — all 35 are
the missing-fixture tests. `biome check` clean (run over `packages apps`, wider
than the changed files). `tsc` on a scratch config covering the changed files:
nothing in them (two messages in untouched files, `a2a-map.ts` and
`markdown.ts`, which look like artefacts of that config; the gate decides). Full
gate and `tsc -p apps/mobile` not run (the orchestrator's).

**For the Review / owner (plan followed, not changed).**
- D5 can turn a view that used to work into an error: a default `low` of a
  high-only PNG now fails when it is over the decode budget (Anthropic accepts
  files up to 8000 px) or the 48 MiB tool sub-cap is full; before, `high` was
  sent with a note. With a forced `model.imageDetail: low` such a file cannot be
  viewed at all. A fallback to `high` + note would be a design change.
- Re-viewing a `high` crop by its own id at the default `low` downscales it
  again (a further stored picture); the prune stub does not say `detail`.
- The `low` downscale is stored as `<label> region` (D4's label, followed).

**Gate-fix round (claude-sonnet-5-5, 2026-11-26) — still PARTIAL.**
- `e2e-gate` tag test: fixed. The branch predates `771517b1` on `main`; its
  `TODO.md` sections were copied verbatim. `e2e-gate.test.ts`: 41 pass.
- PngSuite: **not fixed, STOP** (plan § Tests). The `curl` download again
  required a permission approval; no other route was tried. The archive is not
  in `.tentacle/tmp/image-region-png/`. `png-decode.test.ts`: 41 pass, 35 fail
  (34 missing fixtures + the folder-contents test).
- Needed from the orchestrator/owner: put `PngSuite-2017jul19.tgz`
  (`http://www.schaik.com/pngsuite/PngSuite-2017jul19.tgz`) in
  `/Users/gmeghnag/tentacle/.tentacle/tmp/image-region-png/`, then steps 1–4
  above.

### Fix round 1

*— claude-sonnet-5-5, 2026-11-26* — still **PARTIAL** (finding 1).

**Finding 1 (HIGH, PngSuite): not fixed.** The archive is not in
`.tentacle/tmp/image-region-png/` and no copy is in the worktree. A search
outside it needed a permission approval, and the download was already blocked in
both earlier rounds, so it was not tried again. Nothing forged. The 35 tests
stay red; Execution steps 1–4 (with M2 on T1) remain, as does the step "Needed
from the orchestrator/owner" above.

**Finding 2 (MEDIUM, D5 fallback): fixed** (`tools/src/image-view.ts`,
`viewDecoded`). With no `region`, a refused header / decode / render / put now
returns today's `serve` of `high` + `HIGH_ONLY_NOTE`; with a `region` the
errors are unchanged. `read` → `null` stays "no longer held" for both. D5 in
Implementation says so.

**Red before green** (`image-view-region.test.ts`, before the edit): 31 pass,
7 fail, each on the result assertion (an `isError` sentence where the `high` ref
was expected): over budget at default / asked / forced `low`, unparsable PNG,
corrupt stream, byte cap, full store. After: with `image-view`,
`image-view-user` and `concurrency`, 66 pass, 0 fail.

**Mutations** (`mutate-fix1.ts`; file restored, verified):

| Mutation | Failing tests |
|---|---|
| F1 a D5 refusal is an error again | the 7 fallback tests |
| F2 an explicit region falls back too | 6 region error tests |
| F3 a full store does not fall back | D5 full store |
| F4 gone bytes fall back too | both "bytes … no longer returns" tests |

**Checks.** `biome check` on the two changed files: clean. `png-decode`,
`image-region`, wiring, sub-agent and provider tool-image tests: 85 pass, 35
fail (all in `png-decode.test.ts`, the fixtures). Gate not run (the script's).

### Gate-fix round after fix round 1

*— claude-sonnet-5-5, 2026-11-26* — still **PARTIAL**, no code or test change.

The gate failures shown are the missing PngSuite fixtures. `png-decode.test.ts`:
41 pass, 35 fail. No archive or fixture is in the worktree or in
`.tentacle/tmp/image-region-png/`, and the download command again needed a
permission approval; not worked around, nothing forged, no test skipped.
To unblock, the orchestrator/owner runs:

```sh
curl -fL -o /Users/gmeghnag/tentacle/.tentacle/tmp/image-region-png/PngSuite-2017jul19.tgz \
  http://www.schaik.com/pngsuite/PngSuite-2017jul19.tgz
```

Then Execution steps 1–4.

## Review

*— claude-opus-5-5, 2026-11-26* (fresh context; same model family as the planner, different from the executor)

**Verdict: REQUEST-CHANGES.**

**Findings**

1. **HIGH — gate red, T1/T2 absent** (`packages/core/test/png-decode.test.ts`; no
   `packages/core/test/fixtures/png/`). Touched files: 352 pass, **35 fail**, every
   one a PngSuite test ("fixture … is missing"). The plan's only independent
   oracle (O12) is unproven, and the `f00…f04` identity and 16-bit hand-read spot
   pixels are not written. Execution itself says "Do not merge". Fix: drop the
   archive in `.tentacle/tmp/image-region-png/`, then Execution steps 1–4.
2. **MEDIUM — D5 makes a view that works today fail** (`packages/tools/src/image-view.ts:145`,
   `needsDownscale` `:340`; the refusal comes from `packages/core/src/png-decode.ts:377`).
   Trace (`.tentacle/tmp/image-region-png/review-e2e{,-branch}.test.ts`, a flat
   8000×4500 RGB PNG of 111 KB, stored high-only — legal on Anthropic,
   `ANTHROPIC_MAX_IMAGE_EDGE = 8000`): **main** →
   `big.png · 8000×4500 · low · 111 KB · low is not available for this image yet — sent at high`;
   **branch**, default `low` →
   `big.png: the PNG is 8000×4500: decoding it needs 206 MiB, over the 128 MiB limit` (isError),
   and with `model.imageDetail: low` the file **can never be viewed** (no `detail`
   to escape with; the message does not even suggest `high`). Same for a PNG this
   strict parser refuses but a provider accepts, and for a full 48 MiB sub-cap.
   Not in § Failure modes. Fix: when D5 (not an explicit `region`) is refused, fall
   back to today's `serve` of `high` + `HIGH_ONLY_NOTE`; add a test (budget-over
   high-only PNG at default and forced `low` → the `high` ref, not an error).

**Gate (this review).** `bun run lint`: clean (2596 files). `bun run typecheck`
(incl. `apps/mobile`, `apps/relay`): clean. Touched + fake-updated test files
(12): 352 pass / 35 fail (all PngSuite). Full `bun run test` not run: red already
on the fixtures.

**Mutations** (applied together, run, restored by file copy; `git status` clean
after): decode cost check disabled → both T3 tests fail; `unfilter` ignoring the
row above → the every-filter test fails; region ignored (whole box always) → 10
region tests fail. Non-vacuous for these; the Adam7/PngSuite pair oracles stay
unproven (finding 1).

**Attacks tried.**
- Decompression bomb / lying header: cost judged from IHDR before inflate,
  `maxOutputLength` = exact raw size, short output refused (`png-decode.ts:376-404`). Holds.
- Region outside / tiny / float noise: `regionBox` refuses before any decode
  (`image-view.ts` reads the header, then the box, then decodes). Holds.
- Two regions in one batch, and D5 (whose input the scheduler cannot tell
  apart): `image-decode` write claim + per-instance `oneAtATime` slot. Holds.
- §7 "compute next to the code / pod not trusted": the tool exists only with a
  daemon-side store (unchanged registration); no pod decodes, no new wire field,
  no protocol note needed. Holds.
- `TODO.md` copy of `771517b1`'s sections: same lines at the same place as
  `main` (both at :97/:126) → no duplicate on merge.
- Peak memory is above the stated "most one decode may allocate" (crop +
  opaque-alpha copy in `renderRegion` come on top), ≈ 2–3× at worst; below
  MEDIUM, noted only.

**Executor behaviour.** Honest: it stopped at the fixture blocker instead of
forging fixtures, marked the status PARTIAL, recorded its drifts and raised the
D5 regression itself for the Review. Note for future repros: scripts in
`.tentacle/tmp/<slug>/` importing `../../../packages/...` hit the MAIN checkout,
not the worktree — a branch "after" repro must use the worktree's absolute path.
