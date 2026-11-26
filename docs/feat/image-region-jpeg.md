# feat/image-region-jpeg — `image_view` crops and zooms JPEG pictures (slice 3b of image-on-demand)

> **Status:** implementation (APPROVED — orchestrator decisions below, owner-delegated 26/11)
> **Branch:** `feat/image-region-jpeg`
> **Size:** M · **Blast:** cross-module (core + tools; a parser of untrusted bytes runs on the daemon thread; a module the repo already pins is newly imported on the daemon side; no protocol, persistence-format or §7 invariant change) · **Suited:** Sonnet executes (S/M routing); **mandatory fresh-context Opus Review** (red-team the strict header walk and the decode budget, not just the happy path)
> **Changelog:** `changelog.d/image-region-jpeg.added.md`

## Context

*— claude-opus-5-5, 2026-11-26*

The owner's answers of 23/11 (`docs/eval/image-on-demand.md:248-249`) are binding.
Answer 5: «`region` crop/zoom: slice 3, as TWO tasks — PNG first (our PDF page
images), JPEG second (decoder dependency decision)». Answer 6: `detail` is `low`
(long edge ≤ 768 px, the default) or `high` (≤ 1568 px), chosen by the model or
forced by `model.imageDetail`. This is **3b: JPEG**.

3a (`feat/image-region-png`, merged `ff443975`) built the whole pipeline:
1. the contract (`region` as fractions, `image-view.ts:60-70`);
2. the store read (`ToolImageStore.read`, `packages/core/src/tool-images.ts:76`);
3. `regionBox` / `cropPixels` / `renderRegion` (`packages/core/src/image-region.ts:43-152`);
4. the one-decode slot and the `image-decode` claim (`image-view.ts:92-99,136-142`);
5. D5 (`low` of a high-only picture, with a fallback to `high` + note, `image-view.ts:339-347,379-380`).

It left JPEG out on purpose, with the error at `image-view.ts:370-375` (3a's
O7). Two promises wait on a JPEG decoder:
- a zoom into a photo, a scanned page or a screenshot saved as `.jpg`;
- `low` for JPEG files, which today are served at `high` with
  `HIGH_ONLY_NOTE` (`image-view.ts:189,340-347`; promised in
  `docs/feat/image-files.md:12`).

The open question the eval left is **which decoder** (the task brief: compare a
pure-JS decoder, alternatives, Bun built-ins; benchmark on a real 12 MP phone
photo; justify on supply chain). That comparison is § Decoder decision below.

**Repro** (2026-11-26, `.tentacle/tmp/image-region-jpeg/repro.ts`, run with `bun repro.ts` from that folder; it imports the WORKTREE by absolute path — 3a's review found `../../../packages` hits the main checkout):

```ts
// feat/image-region-jpeg repro (worktree paths, not the main checkout): today a JPEG
// `region` is an error, and `low` of a high-only JPEG is served at high with a note.
import { createImageViewTool } from "/Users/gmeghnag/tentacle/.tentacle/worktrees/image-region-jpeg/packages/tools/src/image-view.ts";
import type { ToolImageStore } from "/Users/gmeghnag/tentacle/.tentacle/worktrees/image-region-jpeg/packages/core/src/index.ts";

const bytes = new Uint8Array(await Bun.file("photos/iphone-12mp.jpg").arrayBuffer());
const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const ref = { id, mimeType: "image/jpeg", size: bytes.length, name: "IMG_7364.jpg" } as const;
const variant = { ref, width: 4032, height: 3024 };
const entry = { high: variant, low: variant, label: "IMG_7364.jpg" };
let reads = 0;
const store: ToolImageStore = {
  putTool: async () => ({ refused: "not in this repro" }),
  resolve: (p) => (id.startsWith(p) ? { kind: "found", entry } : { kind: "none" }),
  holds: () => true,
  read: async () => {
    reads += 1;
    return bytes;
  },
};
const tool = createImageViewTool("auto", { maxImageBytes: 3_932_160 });
const ctx = { images: store, history: [] } as unknown as Parameters<typeof tool.execute>[1];
const show = (label: string, r: { content: unknown; isError?: boolean; image?: { id: string } }) =>
  console.log(`${label}: isError=${r.isError === true} image=${r.image?.id.slice(0, 12) ?? "-"} · ${String(r.content)}`);
show("region", await tool.execute({ ref: id.slice(0, 12), region: { left: 0.25, top: 0.25, width: 0.5, height: 0.5 } }, ctx));
show("low", await tool.execute({ ref: id.slice(0, 12), detail: "low" }, ctx));
console.log("store.read calls:", reads);
```

```
region: isError=true image=- · region needs a PNG picture; this one is JPEG (JPEG regions come later) — call image_view without region
low: isError=false image=387fff2f75ec · IMG_7364.jpg · 4032×3024 · low · 2.7 MB · low is not available for this image yet — sent at high
store.read calls: 0
```

The photo: `photos/iphone-12mp.jpg` = Wikimedia Commons
`20200801_021532_things_places_IMG_7364.jpg`, **CC0**, EXIF Make/Model `Apple
iPhone X`, Orientation 1, 4032×3024 baseline 4:2:0, 2 801 647 bytes, sha256
`387fff2f75ec554d2b19f1e6f6fda06b790a537a95b783c01ce724182dfe93bf` (found by
`fetch-list.ts`, a Commons API query for 4032×3024 iPhone JPEGs; it stays in
scratch, it is not committed).

## Implementation

*— claude-opus-5-5, 2026-11-26*

**APPROVED** (orchestrator, owner-delegated: "close tonight, pick the recommended
option"). Every open choice is recorded under **#### Orchestrator decisions**
with its reason. No owner question is left open: an acceptable option exists.

### Decoder decision (the question the eval left open)

All measured on this Mac (Apple Silicon, Bun 1.4.3), 2026-11-26. Scripts:
`.tentacle/tmp/image-region-jpeg/{bench,check-fx,encode-bench,probe2,probe3}.ts`.
- Each candidate ran in its own process.
- "Peak" is `process.resourceUsage().maxRSS` growth over one decode (`--once`),
  measured after `Bun.gc(true)`.
- Δ is the per-sample absolute difference against `Bun.Image`'s decode, which
  is byte-identical to mozjpeg/libjpeg-turbo (the jSquash row: mean 0, max 0).
  `djpeg`, `jpegtran` and `python3` needed an approval this session could not
  give.
- The progressive copy is the same photo re-encoded by `Bun.Image`
  (`progressive: true`, q90).

| Candidate | New dep? Licence · version | 12 MP baseline, cold | 12 MP progressive, cold | Peak of one decode | Δ vs libjpeg-turbo (photo) | CMYK / progressive / EXIF | Untrusted bytes |
|---|---|---|---|---|---|---|---|
| **pdf.js `JpegImage`** (`pdfjs-dist/legacy/image_decoders`) | **No** — `pdfjs-dist` `6.5.438` is already pinned exactly (`packages/tools/package.json`), Apache-2.0, `"scripts": {}` | **207 ms** | 336 ms | **+79 MiB** (+78 progressive) | mean 0.15, max 14 | yes (Adobe) / yes / no (we parse it) | JS, memory-safe; already decodes the JPEGs inside PDFs in our PDF worker |
| `jpeg-js` | Yes — BSD-3-Clause `0.4.4`, no deps, `scripts.test` only | 261 ms | 359 ms | +191 MiB (+189) | mean 0.48, max 14 | yes / yes / no | JS; has its own `maxMemoryUsageInMB` |
| `@jsquash/jpeg` (mozjpeg → wasm) | Yes — Apache-2.0 + codec licences `1.6.0`, a `.wasm` asset to embed in the binary | 95 ms | 145 ms | +143 MiB; wasm memory never shrinks | exact (0 / 0) | yes / yes / opt-in | C in a wasm sandbox |
| `Bun.Image` (Bun 1.4.3 built-in, verified: `probe2.ts`) | No | 349 ms, incl. a PNG round-trip: **no crop, no raw-pixel output** | — | +275 MiB | reference | ? / yes / `autoOrient` | **native code** parsing untrusted bytes in the daemon process |
| `sharp`, macOS `sips` / ImageIO | Rejected unmeasured | | | | | | `sharp`: native addon with an install step (fails "no install scripts"). `sips`: macOS only, while `serve` runs on Linux |

The output re-encode of a photo crop (`encode-bench.ts`; the photo's centre
half, downscaled by our box filter):

```
1568×1176: downscale 32 ms · PNG 3.60 MB 84 ms · JPEG q85 (Bun.Image) 0.33 MB 38 ms
768×576: downscale 10 ms · PNG 0.91 MB 19 ms · JPEG q85 (Bun.Image) 0.09 MB 9 ms
```

Our filter-None PNG of a `high` photo crop is 3.60 MB. That is just under
Anthropic's 3 932 160 B cap (`packages/providers/src/images.ts:46`), so a
noisier photo would hit 3a's ×0.75 step-down every time. Every request also
re-sends the image as base64 until it is pruned. JPEG output is 11× smaller.

**Verdict: decode with pdf.js `JpegImage`; encode the OUTPUT with `Bun.Image`'s
JPEG encoder (falling back to our PNG).**
- pdf.js needs no new dependency and is already pinned, licensed and
  script-free.
- It has the lowest peak memory, and it is memory-safe JavaScript on untrusted
  bytes.
- It is maintained by Mozilla, and it already runs on untrusted JPEGs in this
  product (PDF images, `packages/tools/src/pdf/pdf-worker.ts:15,22`).
- Its speed is within 25 % of jpeg-js. jSquash is 2× faster but adds a
  dependency and a wasm asset, and its heap grows and never shrinks.
- `Bun.Image` is not fit to DECODE untrusted bytes here. It runs native code on
  them, and it can neither crop nor hand back pixels.
- It is fit to ENCODE our own pixels: that input is trusted, the encode runs
  off the JS thread, and the dependency is zero.

Probed facts the design leans on (`probe3.ts`, verbatim):

```
import 7 ms, console writes at import: 0
small, default verbosity: decoded 64×48×3 (9216 bytes)
photo cut at 60%, default verbosity: decoded 4032×3024×3 (36578304 bytes)
small with garbage entropy data: THROWS JpegError: JpegImage.parse - no frame data found.
not a jpeg: THROWS JpegError: SOI not found
photo cut at 60%, verbosity 0: decoded 4032×3024×3 (36578304 bytes)
console writes during decodes at default verbosity: 2 [ "warn: Warning: JpegImage.parse - reached the end of the image data without finding an EOI marker (0xFFD9).",
  "warn: Warning: JpegImage.parse - unexpected data, current marker is: a4c9"
]
console writes during the decode at verbosity 0: 0
Bun.Image in a Worker: function
```

What this shows:
- pdf.js is **lenient**: a truncated file decodes, with grey fill. So our
  header walk must require EOI first.
- At its default verbosity pdf.js **writes to the console**, which breaks the
  §7 rule "never write raw to the terminal". It must be bound at verbosity 0.
- `Bun.Image` exists inside a Worker (the in-process daemon runs in one).

pdf.js against the reference decoder on every fixture (`check-fx.ts`, stored
orientation):

```
small-baseline         pdf.js 64×48×3 · Bun.Image 64×48 rgba · mean |Δ| 1.782 max 22
small-progressive      pdf.js 64×48×3 · Bun.Image 64×48 rgba · mean |Δ| 1.782 max 22
small-gray             pdf.js 64×48×1 · Bun.Image 64×48 rgba · mean |Δ| 0.069 max 1
small-444              pdf.js 64×48×3 · Bun.Image 64×48 rgba · mean |Δ| 0.151 max 3
small-rgb-colorspace   pdf.js 64×48×3 · Bun.Image 64×48 rgba · mean |Δ| 0.069 max 1
small-orient-6         pdf.js 64×48×3 · Bun.Image 64×48 rgba · mean |Δ| 1.782 max 22
photo-progressive      pdf.js 4032×3024×3 · Bun.Image 4032×3024 rgba · mean |Δ| 0.164 max 11
```

The larger Δ on the small 4:2:0 files is the chroma upsampling: pdf.js uses
nearest, libjpeg uses "fancy" upsampling. Strong colour edges in a 64×48
picture show it. It is invisible at photo scale (0.15).

### Load-bearing assumption

**pdf.js `JpegImage` allocates only for the frame that our strict header walk
read, so a decode-cost check made from that header, BEFORE `parse`, bounds the
decode.** If this fails, a lying file allocates gigabytes on the daemon thread
and takes every session down: the decode-bomb class 3a closed for PNG.

Where pdf.js allocates, verified in the pinned legacy build
(`packages/tools/node_modules/pdfjs-dist/legacy/image_decoders/pdf.image_decoders.mjs`):
- **At the SOF segment.** `prepareComponents(frame)` (`:8891`) allocates one
  `Int16Array(64 · blocksPerColumnForMcu · (blocksPerLineForMcu + 1))` per
  component (`:8645-8657`). The IDCT output is written back into it
  (`buildComponentData`, `:8606-8617`).
- **In `getData`.** It allocates `width · height · numComponents` bytes
  (`:9010`). YCbCr → RGB is converted in place.
- So the cost is
  `Σ_c 2·64·(mcusPerColumn·v_c)·(mcusPerLine·h_c + 1) + W·H·N`. For the 12 MP
  4:2:0 photo that is **73 253 376 B ≈ 69.9 MiB**, which agrees with the
  measured +79 MiB peak.

Three ways pdf.js could see a different frame than our walk, each closed by
the strict walk (D2):
1. **DNL.** A DNL marker in the first scan whose height differs from the SOF
   makes pdf.js **re-parse with that height** (`:8153-8159` → `:8938-8942`,
   `frame.scanLines = dnlScanLines || sofScanLines` at `:8861`). Up to 65 535
   rows the header never declared. The walk refuses a DNL in the first scan.
2. **Segment lengths.** pdf.js advances through SOF, SOS, DHT and DRI by what
   it parses, not by the segment length (`:8849-8891`, `:8893-8915`). A
   segment whose declared length disagrees with its content desynchronises the
   two walks. The walk requires exact lengths.
3. **Unknown marker.** On a marker byte below `0xC0`, pdf.js scans forward for
   the next marker (`:8959-8963`). The walk refuses any marker outside the set
   it knows.

After the SOF, a second SOF throws in pdf.js (`:8852`), so the first SOF that
both walks reach is the one that allocates.

**Prove first (Execution step 0, after the fixtures are installed, before any
production code).** A scratch test `.tentacle/tmp/image-region-jpeg/step0.test.ts`:
- `JpegImage` from the legacy module decodes `small-baseline.jpg` at 64×48×3;
- the same file with `FF DC 00 04 01 00` (DNL, height 256) spliced into its
  first scan's entropy data decodes at **64×256**, the re-parse happens;
- `setVerbosityLevel(0)` silences a truncated file.

Paste the output into Execution. If the DNL re-parse does NOT happen, the walk
still refuses DNL; note it and continue. If the decode or the import fails,
STOP and fix the plan (§8).

### Preconditions

- **Where the tool exists — unchanged by this task.**
  - It is registered only with a store AND vision
    (`packages/cli/src/wiring.ts:1379-1399`).
  - The store is given only when `images.source === "store"`
    (`packages/daemon/src/session-host.ts:1699-1700,1798-1799`).
  - So a pod whose model runs on the laptop, a sub-agent and `images:false`
    have no tool. **No pod decodes, and no byte travels pod → laptop** (§7
    "compute next to the code, identity with the user").
  - On `connect`, the `serve` daemon decodes from its own store.
- **Which bytes a ref can name** (3a's preconditions, re-verified):
  - a tool entry (`image-view.ts:264-272`): its `high` is a JPEG only for an
    image FILE. `fs_read` stores the original bytes after `inspectJpeg`, which
    accepts SOF0–2, 8-bit, 1 or 3 components, EOI present, and refuses CMYK
    (`packages/core/src/image-file.ts:208-251`). Its long edge is up to
    `imageFileMaxEdge` = 8000 px on Anthropic, 1568 elsewhere
    (`packages/providers/src/images.ts:305-310`);
  - a user's own image (`image-view.ts:275-283`), never inspected: it can be
    CMYK, progressive, EXIF-rotated, GIF or WebP (`IMAGE_MIME_TYPES`,
    `packages/protocol/src/attachment.ts:25`). The phone resizes a photo to
    2048 px unless "send original" is on (`apps/mobile/src/photo-input.ts:81,174-184`).
- **The provider sends the stored bytes as they are**, EXIF included: base64
  with the ref's `mimeType` (`packages/providers/src/images.ts:484-485,539-541`).
  Whether a provider honours EXIF Orientation is not documented. See
  decision J5.
- **The store takes a JPEG.** `ToolImagePut.mimeType` is
  `"image/png" | "image/jpeg"` (`packages/core/src/tool-images.ts:55`).
- **Byte caps.** The model's per-image cap: Anthropic 3 932 160 B,
  OpenAI-compatible 5 MiB (`images.ts:46,53`). It reaches the tool as
  `maxImageBytes` (`wiring.ts:1395-1397`), bounded by `MAX_IMAGE_BYTES` =
  15 MiB (`attachment.ts:37`, `image-view.ts:121`).
- **Detail.** `TOOL_IMAGE_LOW_EDGE = 768` (`tool-images.ts:19`); `high` =
  `DEFAULT_PDF_IMAGE_LIMITS.maxEdge` (1568, `image-view.ts:406`); never
  upscaled (`scaledSize`).
- **Decode budget and serialisation.** `MAX_PNG_DECODE_BYTES` = 128 MiB
  (`packages/core/src/png-decode.ts:22`). It is checked INSIDE `decodePng`, so
  no caller can skip it (`png-decode.ts:367-380`). One decode runs at a time
  per tool instance (`image-view.ts:122-125`).
- **Core purity.** `@tentacle/core` imports no `node:` module and no
  third-party decoder: the phone imports it (`png-decode.ts:11`). Codecs are
  injected (`Inflate`, `png-decode.ts:19`; `Deflate`, `png.ts:15`). pdf.js is
  a dependency of `@tentacle/tools` only.
- **The pinned module.** `pdfjs-dist` is exactly `6.5.438` (no range) in
  `packages/tools/package.json`, `"license": "Apache-2.0"`, `"scripts": {}`.
  `legacy/image_decoders/pdf.image_decoders.mjs` exports `JpegImage` and
  `setVerbosityLevel` (`:9627`). The package ships no typings for that module
  (`types/src/core/jpg.d.ts` covers only the internal file): use the
  `@ts-expect-error TS7016` pattern of `pdf-worker.ts:14-15`.
- **`Bun.Image`.** Bun ≥ 1.4.3 (`package.json` `engines`) has it
  (`probe2.ts`): `jpeg({quality})`, `bytes()`, and no `crop`/`extract`/`raw`.
  The repo's typings (`@types/bun` 1.1.14) do not declare it: reach it through
  one narrow local type.
- **Presentation is already done.** The TUI and phone subtitles add
  ` · region` for any `region` (`packages/tui/src/render-lines.ts:784-785`,
  `apps/mobile/src/tool-summary.ts:124-130`). Nothing to change.

### Design

**D1 — Contract.** Unchanged: `image_view({ ref, detail?, region? })`, fractions
0–1 (3a O1). Three texts change:
- the description sentence (`image-view.ts:78`): "`region` zooms into part of
  a PNG **or JPEG** picture … never enlarged";
- the field text (`image-view.ts:70`): "A part of a PNG or JPEG picture …";
- the refusal for any other type (GIF/WebP user images): "region needs a PNG
  or JPEG picture; this one is GIF — call image_view without region".

**D2 — `packages/core/src/jpeg-decode.ts` (new, pure).**
- **Move here from `image-file.ts`:** `isSof` and the frame rules of
  `inspectJpeg` (`image-file.ts:153-154,213-234`), as
  `jpegFrameRefusal(frame) → string | null`. `inspectJpeg` imports and calls
  it: **no behaviour change for `fs_read`** (same sentences). This is 3a's
  `PNG_DEPTHS` move: one truth.
- **`readJpegHeader(bytes)`** → `JpegHeader` or `{ refused }`. Never throws.
  It is the STRICT walk, region path only:
  - SOI.
  - Then, up to the first SOS, ONLY these markers:
    - `FF` fill;
    - APPn `E0–EF` and COM `FE`: skipped by length;
    - DQT `DB`: every table exactly 65 or 129 bytes, precision nibble 0/1,
      and the tables fill the length exactly;
    - DHT `C4`: every table 17 + Σ counts, filling the length exactly;
    - DRI `DD`: length 4;
    - SOF `C0–CF`: the first one only, a second one refuses.
  - Any other marker refuses: "the JPEG has an unexpected marker FFxx".
  - SOF: length = 8 + 3·N. The frame passes `jpegFrameRefusal` (this is where
    CMYK, 12-bit, arithmetic, lossless and hierarchical are refused). Every
    `h`, `v` is in 1…4. W, H ≥ 1 (H = 0, "height set later by DNL", refuses).
  - SOS: length = 6 + 2·Ns, and every selector names a frame component.
  - **The first scan's entropy data:** walk it, skipping `FF 00` and
    `FF D0–D7`. The first other marker ends it. If that marker is `FF DC`
    (DNL), refuse.
  - **Amended in Execution (claude-sonnet-5-5, 26/11; the two rules above were
    not enough, see Execution step 0):**
    - the marker ending the first scan must be one of `D9`, `C4`, `DA`, `DB`,
      `DD`, `E0–EF`, `FE`; anything else, `FF 01–BF` included, refuses
      ("unexpected marker FFxx"): pdf.js SKIPS a marker under `C0`, takes a
      following restart marker and reads on, DNL included;
    - a fill byte directly after an APPn/COM segment refuses ("unexpected
      layout"): pdf.js (`readDataBlock`) then searches the segment's PAYLOAD
      for a marker and parses what it finds. Fill bytes elsewhere stay allowed.
  - EOI `FF D9` somewhere after the first scan's start, as `inspectJpeg`
    requires (`image-file.ts:235-246`).
  - **EXIF:** from the first APP1 starting `Exif\0\0`, the IFD0 tag `0x0112`
    (SHORT, count 1), with both byte orders. A malformed, truncated or
    out-of-range EXIF gives orientation 1 and never refuses: EXIF is
    ancillary, as `eXIf` is for PNG.
  - Result: `{ width, height, components: 1|3, progressive, sampling:
    [{h,v}…], orientation: 1…8 }`.
- **`jpegDecodeCost(header)`** = the formula in § Load-bearing assumption.
  `MAX_JPEG_DECODE_BYTES = MAX_PNG_DECODE_BYTES` (one value: the slot is
  shared).
- **`JpegDecoder = (bytes: Uint8Array) => { width; height; components; pixels:
  Uint8Array }`**, synchronous, may throw (injected).
- **`decodeJpeg(bytes, header, decoder)`** → `DecodedPng` (8-bit `gray`/`rgb`,
  the same type the region code takes) or `{ refused }`. In order:
  1. the cost check FIRST: over 128 MiB → "the JPEG is W×H: decoding it needs
     N MiB, over the 128 MiB limit", **decoder not called**;
  2. the decoder call; a throw → "the JPEG is corrupt (<message, ≤ 120
     chars>)";
  3. the output must be exactly the header's W×H×components, else "the JPEG
     is corrupt (decoded size differs from its header)".

**D3 — Orientation geometry (`packages/core/src/image-region.ts`, pure).**
- **`orientedSize(W, H, o)`.** For o = 5…8 the sides swap.
- **`storedBox(box, W, H, o)`.** It maps a box in DISPLAYED pixels to the
  axis-aligned box in STORED pixels (all 8 orientations are axis-aligned
  isometries). Displayed `(dx, dy)` maps to stored:

  | o | stored (sx, sy) | o | stored (sx, sy) |
  |---|---|---|---|
  | 1 | (dx, dy) | 5 | (dy, dx) |
  | 2 | (W−1−dx, dy) | 6 | (dy, H−1−dx) |
  | 3 | (W−1−dx, H−1−dy) | 7 | (W−1−dy, H−1−dx) |
  | 4 | (dx, H−1−dy) | 8 | (W−1−dy, dx) |

  (W×H = stored size.) **The oracle wins over this table:** T4 checks it
  against `Bun.Image`'s `autoOrient` on `small-orient-1…8`.
- **`orientPixels(pixels, w, h, channels, o)`.** It turns a STORED-frame crop
  into the displayed frame. o = 1 returns the same buffer.

**D4 — Rendering with an injected, possibly async encoder (`image-region.ts`).**
- Factor the crop → opaque-alpha drop → `scaledSize`/`downscalePixels` step
  out of `renderRegion` into a private helper. `renderRegion` (sync, PNG)
  stays byte-for-byte the same for its caller and its tests.
- Add `renderRegionWith({ decoded, box, maxEdge, maxBytes, encode })`, async,
  where `RegionEncoder = (width, height, pixels, color) =>
  Promise<Uint8Array>`. It has the same ×0.75 step-down (≤ 3) and the same
  refusal sentence as `renderRegion`.

**D5 — Codecs bound daemon-side (`packages/tools/src/image-codecs.ts`, new).**
- **Static import** of `pdfjs-dist/legacy/image_decoders/pdf.image_decoders.mjs`,
  like `pdf-worker.ts:14-15`: a static specifier is what the compiled binary
  embeds. `setVerbosityLevel(0)` runs once at module load, before any decode.
- **`decodeJpegPixels: JpegDecoder`:**
  `new JpegImage(); parse(bytes); getData({ width, height, forceRGB: components
  === 3 })`. It returns gray for 1 component.
- **`createJpegEncoder(image = bunImage())`** → a `RegionEncoder` that does
  `encodePng` with a level-0 deflate (`deflateSync(raw, {level: 0})`), then
  `new Bun.Image(png).jpeg({ quality: 85 }).bytes()`.
  - The resolved encoder also reports the mime it produced.
  - When `Bun.Image` is absent, or its terminal rejects, it encodes the PNG
    instead (`encodePng` + `deflateSync`) and reports `image/png`.
  - `bunImage()` reads `(Bun as unknown as { Image?: BunImageCtor }).Image`
    through one narrow local type, no `any`.

**D6 — The tool (`packages/tools/src/image-view.ts`).** In `viewDecoded`, the
source mime picks the pipeline. The PNG branch is unchanged. The new JPEG
branch, inside the same `slot`:
1. `store.read`; `null` → `gone` (as today).
2. `readJpegHeader` → `{refused}` → `fail(...)`.
3. `(dw, dh) = orientedSize(W, H, o)`. The box is the whole picture, or
   `regionBox(region, dw, dh)` in DISPLAYED pixels (3a's `regionBox`,
   unchanged). Judged from the header: **nothing is decoded for a refused
   box**.
4. `decodeJpeg(bytes, header, decodeJpegPixels)`; the cost check is inside it.
5. `cropPixels(decoded, storedBox(box, W, H, o))` → `orientPixels(…, o)` → a
   `DecodedPng` of the box's displayed size.
6. `renderRegionWith({ decoded: thatCrop, box: whole crop, maxEdge, maxBytes,
   encode: jpegEncoder })`.
7. `putTool({ variants: { high: … }, mimeType: <the encoder's mime>, label:
   "<label> region" })`; the id choice of `image-view.ts:427-430` stays.

The result reads like the PNG one, with two differences:
- `of <W'>×<H'>` is the DISPLAYED size;
- ` · EXIF orientation <o> applied` is appended when o ≠ 1.

`needsDownscale` (`image-view.ts:340-347`) accepts `image/jpeg` too. That gives
D5 of 3a for JPEG files, with 3a's fallback rule (`unmade`, `:379-380`): a
refused header, decode, render or put on a no-region `low` serves `high` +
`HIGH_ONLY_NOTE`, never an error.

`concurrency` is unchanged: a region claims `{write,"image-decode"}`, and the
slot serialises D5.

**D7 — Memory, honestly.** The peak is the decoder's cost (≤ 128 MiB, checked)
plus at most one crop copy plus one oriented copy (each ≤ W·H·3). An unrotated
whole-picture box copies nothing (`cropPixels` and `orientPixels` return the
same buffer). The 12 MP photo: ≈ 70 MiB decode + ≤ 35 MiB. Drop the reference
to the full decode before `renderRegionWith`, so the GC may reclaim it during
the encode.

**D8 — No protocol, wiring, TUI or phone change.** `tool_call` / `tool_result`
are generic. `createImageViewTool`'s options are unchanged (the encoder and
decoder are module-level bindings, and tests reach them through
`image-codecs.ts`'s exports). No `protocol.d/` note.

#### Orchestrator decisions

*— claude-opus-5-5 (orchestrator, owner-delegated 26/11), recommended option taken each time*

- **J1 Decoder: pdf.js `JpegImage` from the already-pinned `pdfjs-dist` 6.5.438 (legacy `image_decoders`).** No new dependency, licence or install script. It has the lowest measured peak (+79 MiB vs +143…+275), is memory-safe JS, is maintained by Mozilla, and already decodes untrusted JPEGs in our PDF path. jpeg-js is slower, uses 2.4× the memory and would be a new dependency. jSquash adds a wasm asset and a heap that never shrinks. `Bun.Image` runs native code on untrusted bytes and cannot crop.
- **J2 Output of a JPEG region: JPEG q85 encoded by `Bun.Image` from our own pixels; PNG if `Bun.Image` is absent or rejects.** It is 11× smaller than our filter-None PNG (0.33 vs 3.60 MB at 1568 px), so it stays clear of Anthropic's 3.9 MB cap and is lighter on every re-sent request. The input is our own PNG, so the native-code concern of J1 does not apply. PNG regions keep PNG output: text and screenshots should stay lossless.
- **J3 A strict header walk before the decode (exact segment lengths, a closed marker set, no DNL in the first scan, EOI required).** It makes the header we cost the frame pdf.js allocates (§ Load-bearing assumption). A file this refuses is something a real encoder does not write; D5 falls back, and an explicit region gets one sentence.
- **J4 Budget: the same 128 MiB as PNG, from pdf.js's own allocation formula, checked inside `decodeJpeg` before the decoder is called.** It fits a 12 MP phone photo (≈ 70 MiB) and up to ≈ 21 MP at 4:2:0 or ≈ 14 MP at 4:4:4. A 48–50 MP photo is refused with W×H and both MiB figures. D5's `low` then falls back to `high` + note.
- **J5 EXIF Orientation is APPLIED: `region` fractions refer to the picture as displayed, and the result says `EXIF orientation N applied`.** Every viewer, `Bun.Image` (`autoOrient` default) and the user's own screen show the picture rotated. The crop is sent without EXIF, so what the model gets is unambiguous, and a frame mismatch is visible in the note rather than silent. Whether each PROVIDER rotates the uncropped original is unverified: see debt.
- **J6 CMYK, 12-bit, arithmetic, lossless and hierarchical are refused from the header with `fs_read`'s sentences (one shared rule).** `fs_read` already refuses them as "not reliably accepted by provider decoders" (`image-file.ts:203-206`), so only a user upload can carry one. pdf.js's Adobe-CMYK colours cannot be checked against a real CMYK fixture tonight.
- **J7 The decode runs synchronously on the daemon thread, inside the existing one-at-a-time slot.** It takes 0.21 s for a 12 MP baseline, 0.34 s progressive, and ≈ 0.6 s at the budget cap. This is the same trade as 3a's O10, and a worker hop is debt. The in-process runtime's daemon is already off the render thread.
- **J8 `low` for high-only JPEG files ships here (3a's D5 + fallback, extended).** `docs/feat/image-files.md:12` promised it with 3b, and `low` is the owner's default (answer 6).
- **J9 Fixtures: 13 small files (≈ 2.6 KB each), made tonight by INDEPENDENT encoders (`Bun.Image`, mozjpeg via jSquash in scratch) from the CC0 photo, installed by `install-fixtures.ts` (a bun script with sha256 checks).** Real files from encoders that are not ours. The 3a executor was blocked for rounds on `curl`/`tar`/`cp`, and this script needs only `bun`. Arithmetic, CMYK and DNL cases are crafted header bytes: they test OUR walk's refusal, and nothing is decoded.
- **J10 Damaged entropy data is decoded as pdf.js does, once the strict header and EOI pass (grey or partial blocks); it is not refused.** Providers decode such files the same way, and the crop shows the damage. Refusing it would need a second, stricter decoder.

### Files

Dependency order (no protocol, daemon, client, cli, TUI or phone file):
0. **Fixtures:** `bun /Users/gmeghnag/tentacle/.tentacle/tmp/image-region-jpeg/install-fixtures.ts`
   writes `packages/core/test/fixtures/jpeg/` (13 `.jpg` + `README.md`: provenance,
   CC0 licence line, encoder per file, sha256). It checks every sha256 and refuses
   an existing folder. Dry run verified tonight: `13 fixtures verified`.
1. `packages/core/src/jpeg-decode.ts` (new): D2.
2. `packages/core/src/image-file.ts`: import `isSof` / `jpegFrameRefusal` (from `:153-154,213-234`), no behaviour change.
3. `packages/core/src/image-region.ts`: D3, D4.
4. `packages/core/src/index.ts`: export the new module and functions.
5. `packages/tools/src/image-codecs.ts` (new): D5.
6. `packages/tools/src/image-view.ts`: D1, D6 (`viewDecoded` JPEG branch, `needsDownscale`, texts).
7. Tests (below). `changelog.d/image-region-jpeg.added.md`:
   `- **image_view zooms into JPEG pictures.** A \`region\` of a photo or other JPEG is sent at up to the chosen detail, oriented as the photo is displayed; \`low\` now works for JPEG files.`

### Failure modes

| Mode | Convergence |
|---|---|
| Region outside the picture (`left`/`top` ≥ 1) | 3a's `regionBox` error on the DISPLAYED size; nothing decoded, nothing stored |
| Region spilling past an edge | Clamped; `clamped to the picture's edge` (3a) |
| Zero / negative / > 1 size | Schema refuses (`positive()`, `max(1)`, `image-view.ts:60-68`) |
| Tiny region (< 8 px a side) | 3a's "N×M px — too small" |
| Huge image | Cost from the header; > 128 MiB → error with W×H and both MiB figures; **decoder never called**. D5 falls back to `high` + note |
| Lying header (DNL height, SOF/SOS/DHT/DQT/DRI length ≠ content, unknown marker, second SOF) | Strict walk refuses before decode: "the JPEG has an unexpected layout (<what>)" |
| Corrupt file (no SOI, no SOF before SOS, no EOI / truncated, sampling factor 0 or > 4, decoder throw, decoded size ≠ header) | One sentence `<label>: the JPEG is corrupt (<what>)`, `isError`; never throws; nothing stored |
| Damaged entropy data with a valid header + EOI | Decoded leniently (J10); the crop shows it |
| CMYK / YCCK, 12-bit, arithmetic, lossless, hierarchical | Header refusal with `fs_read`'s sentence (J6); D5 falls back |
| Progressive | Decoded (fixture + 12 MP bench) |
| Grayscale (1 component), 4:4:4, RGB colour space (Adobe/`RGB` ids) | Decoded, each pinned by a fixture |
| EXIF Orientation 2–8 | Applied (J5); box mapped to stored pixels, only the crop rotated; result names it |
| Malformed EXIF | Orientation 1; never a refusal |
| pdf.js console output | Verbosity 0 at bind (D5); a test spies on the console (§7 "never write raw to the terminal") |
| Output over the byte cap | 3a's ×0.75 step-down (≤ 3, noted), then the refusal suggesting a smaller part or `low` |
| Detail cap | `low` ≤ 768, `high` ≤ 1568 long edge; a forced setting wins; never upscaled |
| `Bun.Image` missing / encode rejects | PNG output (`image/png`), same caps |
| Store full / disk write fails | `putTool` `{refused}` → "the region was not kept: …" (region) or `high` + note (D5) |
| Bytes gone (`read` → `null`) | "no longer held" (unchanged, both kinds of call) |
| GIF / WebP user image + region | Error naming the type; nothing read |
| Two regions in one batch | `image-decode` write claim + slot (unchanged) |
| Pod (`client` images), sub-agent, `images:false` | No store → no tool (unchanged); no pod decodes |
| `connect` to `serve` | The serve daemon decodes from its own store |
| Daemon-thread blocking | ≤ 0.35 s at 12 MP, ≈ 0.6 s at the cap (J7); debt: a worker |

### Tests

Red first (§9): each test is shown failing before its code, and the failure is
pasted into Execution. Use fixtures only from `packages/core/test/fixtures/jpeg/`.
**Never forge a fixture with our own code**; crafted bytes are only for the
refusal cases named below. If `install-fixtures.ts` fails, STOP and report: do
not regenerate the files.

- **T1 `core/test/jpeg-decode.test.ts`: header.**
  - Every fixture gives its W×H, components, sampling and `progressive`.
    `small-orient-N` gives orientation N; the others give 1.
  - The 12 MP-shaped synthetic SOF (4032×3024, 2×2/1×1/1×1) has cost exactly
    **73 253 376**.
  - The real fixtures must all pass the strict walk (a real encoder's output).
    If any is refused, STOP: the walk is wrong, not the file.
- **T2 strict-walk refusals.** Each is crafted from `small-baseline.jpg` bytes,
  and each must give `{refused}` with a sentence, while a spy `JpegDecoder` given
  to `decodeJpeg` is **not called**:
  - DNL `FF DC 00 04 01 00` in the first scan;
  - SOF length + 1 (with a pad byte);
  - DHT length − 1;
  - DQT with a 3rd table cut short;
  - `FF 10` segment before SOS;
  - SOF with h = 0;
  - SOF with 4 components (CMYK sentence);
  - SOF9 (arithmetic sentence);
  - precision 12;
  - EOI removed (truncated);
  - malformed EXIF (IFD offset past the end) → orientation 1, accepted.
- **T3 budget before decode.** A valid strict header claiming 60000×60000 →
  refused, decoder spy not called. A decoder returning the wrong size, or one
  that throws → `{refused}`, no throw.
- **T4 `core/test/image-region.test.ts` additions.**
  - `orientedSize` for 1…8.
  - `storedBox` for the displayed top-right quarter under each o.
  - `orientPixels` on a hand-labelled 3×2 RGB array, for each o
    (hand-written expected arrays).
  - `renderRegionWith`: a spy encoder gets the ≤ 768/1568 size, a small crop
    is not enlarged, and a tiny `maxBytes` forces the step-down then the
    refusal.
  - Every existing `renderRegion` test stays green, unchanged.
- **T5 `tools/test/image-codecs.test.ts`.**
  - Every fixture decodes through `decodeJpegPixels` at its size, and its mean
    |Δ| against `Bun.Image(bytes, {autoOrient:false})` is ≤ 2.0, max ≤ 32
    (measured 1.78/22 worst).
  - **The orientation oracle:** for N = 1…8,
    `orientPixels(decode(small-orient-N), N)` equals
    `Bun.Image(small-orient-N)` (`autoOrient` on) at the same tolerance, at
    the swapped size for 5–8.
  - A truncated fixture through the binding writes **nothing** to
    `console.log/warn/error/info/debug` (spied).
  - `createJpegEncoder(undefined)` → PNG bytes and `image/png`. The real
    encoder → `FF D8` and `image/jpeg`.
- **T6 `tools/test/image-view-region.test.ts` additions** (a real memory
  `AttachmentStore`, 3a's pattern):
  - A JPEG entry + region gives an `image` that is not the entry's refs, with
    mime `image/jpeg`, the expected size, and
    `store.resolve(crop.id.slice(0,12))` found.
  - `small-orient-6` + the top-right displayed quarter: the result contains
    `EXIF orientation 6 applied` and `of 48×64`, and the crop's pixels match
    the oracle's same quarter (tolerance as T5).
  - A CMYK, strict-walk or over-budget JPEG + region → an error, store usage
    unchanged. The same files under default `low` → `high` + `HIGH_ONLY_NOTE`,
    not an error.
  - `low` on a high-only JPEG larger than 768 px gives ≤ 768 px and no note.
    Every fixture is 64×48, so the test makes that entry itself:
    `new Bun.Image(small-baseline).resize(1600, 1200).jpeg().bytes()` (the
    independent encoder, never our code), `putTool` as a high-only
    `image/jpeg`.
  - A GIF user image + region → an error naming GIF.
  - A forced setting accepts a region on a JPEG.
  - A full store → error (region) and `high` + note (D5).
  - Every existing `image-view*.test.ts` stays green, unchanged. (Amended in
    Execution: four tests in `image-view-region.test.ts` pinned the behaviour
    D1/J8 replace, and were rewritten.)
- **Mutations (§9; recorded in Execution, reverted):**
  - drop the DNL check → T2 DNL;
  - accept a SOF length mismatch → T2;
  - move the cost check after the decode → T3 (the spy is called);
  - swap orientations 6 and 8 → T4 and T5;
  - no `setVerbosityLevel(0)` → the T5 console test;
  - `needsDownscale` PNG-only → the T6 D5 tests;
  - the encoder always PNG → the T6 mime test;
  - box not mapped through `storedBox` → the T6 orient-6 test.

Gate: `bun test` on the touched files while iterating; `bun run check`
(typecheck incl. `apps/mobile` + `apps/relay`, lint, parallel test) before
Review. Extra validation, pasted into Execution:
- **The 12 MP bench through the real tool path.** A JPEG entry of
  `photos/iphone-12mp.jpg`, region = the centre half, at `high` and `low`:
  wall time, result line, output bytes.
- **Bundling.** `bun build packages/tools/src/image-codecs.ts --target bun
  --outdir .tentacle/tmp/image-region-jpeg/bundle`, then show that the output
  contains `JpegImage`. This shows the static specifier is embedded.

### Notes / debt

- **Provider EXIF behaviour (J5).** A cheap check would settle it: ONE Haiku
  call per provider, with `small-orient-6` upscaled to ≥ 200 px, asking which
  corner a marked feature is in (owner credits; orchestrator only, never a
  reviewer). If a provider does NOT rotate the whole original, the model's
  frame and the region's frame disagree for orientations 2–8. The note makes
  it visible, but it is not fixed. The fix would then be a per-provider flag,
  or normalising the original's orientation when it is stored.
- The decode runs on the daemon thread (J7). A worker hop (like the PDF worker)
  if `serve` with many sessions shows stalls.
- `fs_read` still refuses a JPEG over `maxEdge` ("no downscale yet",
  `image-file.ts:280-285`). With a decoder it could store a downscaled
  `high`. That changes what `fs_read` stores, so it is a follow-up (3a left the
  same for PNG).
- The image-file marker still says `high only` (`image-file.ts:306-315`): true
  of what is STORED. `low` is made on demand.
- CMYK user uploads stay refused for regions (J6). If they show up in
  practice, add a real CMYK fixture and lift the refusal (pdf.js decodes
  Adobe CMYK).

## Execution

*— claude-sonnet-5-5, 2026-11-26*

### Repro (before any edit)

`bun .tentacle/tmp/image-region-jpeg/repro-exec.ts` (the plan's `repro.ts` with an
absolute photo path, so it runs from the worktree) gave the Context's output
verbatim: `region` → `isError=true · region needs a PNG picture; this one is
JPEG…`; `low` → the 2.7 MB original `· low is not available for this image yet —
sent at high`; `store.read calls: 0`. `install-fixtures.ts`: `13 fixtures
verified`, installed.

### Step 0: the load-bearing check — holds, but the planned walk had two holes

Scratch `step0.ts` / `step0b.ts` (scripts, not a `.test.ts`). `step0b.ts` records
the `Int16Array` sizes pdf.js allocates; DNL height 65280, file 64×48:

```
1 small-baseline: 64×48×3 · coefficient arrays 3456,960,960
2 DNL at start of the first scan: THROWS JpegError: unexpected marker ffdc · coefficient arrays 3456,960,960,4700160,1305600,1305600
A FF 10 · FF D0 · DNL after the entropy data: THROWS JpegError: unexpected marker ff10 · coefficient arrays 3456,960,960,4700160,1305600,1305600
B APP1(payload = a 64×65280 JPEG) · FF fill · the real 64×48 JPEG: 64×48×3 · coefficient arrays 4700160,1305600,1305600,3456,960,960
C APP1(payload = one SOF) · FF fill: THROWS JpegError: Only single frame JPEGs supported · coefficient arrays 4700160,1305600,1305600
truncated, default verbosity: console writes 1 · verbosity 0: console writes 0
```

- `JpegImage` decodes the fixture at 64×48×3; verbosity 0 silences truncation.
- **Drift from the plan's step 0:** the DNL re-parse happens (second set of
  arrays) but then THROWS instead of decoding at 64×256: the re-parse reads the
  same DNL again. The allocation precedes the throw, so the risk is as stated.
- **A and B pass the walk as D2 wrote it** (exact lengths, EOI present, A's
  first scan ends at `FF 10`, not DNL; B's fill byte was allowed) and make pdf.js
  allocate for a frame the walk never costed. D2 is amended above; both have T2
  tests.

### As built (plan's order; each slice red on stubs, then green)

0. Fixtures: `packages/core/test/fixtures/jpeg/`.
1–2. `core/src/jpeg-decode.ts` (new): `isSof`, `jpegFrameRefusal` (moved),
   `readJpegHeader`, `jpegDecodeCost`, `decodeJpeg`. `core/src/image-file.ts`
   imports the two moved rules. Red 42/43 fail on stubs; green with
   `image-file.test.ts` unchanged (71 pass).
3–4. `core/src/image-region.ts`: `orientedSize`, `storedBox`, `orientPixels` (one
   `storedPoint` table), `RegionEncoder`, `renderRegionWith`, shared private
   `cutPart` / `nextEdge` / `tooDetailed`. Exported from `core/src/index.ts`.
   Red 12 fail; green (97 pass across the three core files).
5. `tools/src/image-codecs.ts` (new): `decodeJpegPixels` (verbosity 0 at load),
   `createJpegEncoder`, `bytesOf` (moved from `image-view.ts`). Red 27/27;
   green 27/27.
6. `tools/src/image-view.ts`: D1 texts; `makeFromPng` / `makeFromJpeg` /
   `jpegPart` behind the same slot; `needsDownscale` takes JPEG. Red 28 fail;
   green.
7. Tests (`core/test/jpeg-decode.test.ts`, additions to `image-region.test.ts`,
   `tools/test/image-codecs.test.ts`, `tools/test/support/jpeg-oracle.ts`,
   `image-view-region.test.ts`), `changelog.d/image-region-jpeg.added.md`. No
   schema, protocol, TUI or phone change.

### Drift

- D2: the two amendments above.
- `createJpegEncoder(null)` means "no `Bun.Image`" (the plan wrote
  `undefined`, which a default parameter would replace). It returns a
  `PictureEncoder` giving `{ bytes, mimeType }`; the tool adapts it to core's
  `RegionEncoder`.
- Four existing tests rewritten (JPEG region error → corrupt-JPEG sentence; the
  user's-own-JPEG error → GIF/WEBP errors plus a JPEG crop; the description
  sentence; the high-only-JPEG note test, which now reads the bytes and asserts
  nothing is stored).
- T6's orientation oracle runs for all 8 (plan: 6), at mean |Δ| ≤ 4 (the crop is
  lossy twice).

### Mutations (each applied, run, reverted)

| Mutation | Failing tests |
|---|---|
| no DNL check | T2 "a DNL marker in the first scan" + "…after a restart marker and a fill byte": `Received: "ACCEPTED 64×48"` (2 fail) |
| any marker may end the first scan | T2 "junk under FFC0…", "a marker that cannot end a first scan": `ACCEPTED 64×48` (2) |
| fill allowed after APP/COM | T2 both smuggling cases: `ACCEPTED 64×48` (2) |
| SOF length mismatch accepted | T2 "a SOF length one over its content" (1) |
| cost check after the decode | T3 "over the budget…": `Expected: 0, Received: 1` (1) |
| orientations 6 ↔ 8 | T4 `storedBox` ×2, `orientPixels` 6 and 8; T5 oracle 6 and 8 (6) |
| no `setVerbosityLevel(0)` | T5 "a truncated file writes NOTHING to the console" (1) |
| `needsDownscale` PNG-only | T6 the three `low` cases + "bytes the store no longer returns" (4) |
| encoder always PNG | T6 crop, orientations 1–8, the three `low` cases, user JPEG (13) |
| box not mapped through `storedBox` | T6 orientations 2–8 (7; mean Δ 62–83 vs ≤ 4) |

### Evidence

```
bun test (the 8 core/tools image files)            220 pass, 0 fail
bun test agent/test/{subagent-image-view,loop-old-images}.test.ts   13 pass, 0 fail
bunx biome check packages/core packages/tools/{src,test}            no issues
tsc -p <scratch tsconfig over the touched files + imports>          clean
```

12 MP photo through the real tool path (`bench-tool.ts`, memory
`AttachmentStore`, one cold process per call):

```
region-high: 306 ms · image/jpeg 325240 B · IMG_7364.jpg · region 1008,756 2016×1512 of 4032×3024 · sent 1568×1176 · high · 318 KB
region-low:  248 ms · image/jpeg  85738 B · … · sent 768×576 · low · 84 KB
low:         271 ms · image/jpeg  89786 B · IMG_7364.jpg · 768×576 · low · 88 KB
whole-high:  321 ms · image/jpeg 344741 B · region 0,0 4032×3024 of 4032×3024 · sent 1568×1176 · high · 337 KB
maxRSS growth during the call (second runs): region-high +175 MiB, low +94 MiB
```

The `region-high` peak is above D7's estimate (≈ 105 MiB): `maxRSS` also counts
the uncollected garbage, the level-0 PNG and `Bun.Image`'s own buffers; it was
not broken down.

Bundling (`bundle-check.ts`, `Bun.build` of `image-codecs.ts`, `target: "bun"`):
`452445 chars · "class JpegImage" true · bare pdfjs specifier left false`. The
compiled binary itself was not built.

### For Review (found while executing; NOT changed — outside the approved plan)

1. **CPU is unbounded by the memory budget: many progressive scans.** Each tiny
   AC scan walks every block, on the daemon thread (`scan-cost.ts`, 4032×3024,
   33 bytes per scan): 1 scan 84 ms · 100 scans 137 ms · 1000 scans (33 KB)
   789 ms. Linear ⇒ extrapolated, not measured: about 85 s for a 4 MB file and
   over 5 min for a 15 MB user upload. J7's "≈ 0.6 s at the cap" does not hold
   for such a file. A fix would need a cap on `FF DA` markers (or a worker with
   a deadline): an orchestrator decision. Repeated selectors in one scan (Ns up
   to 255) are the same class; D2 does not bound Ns.
2. **The legacy pdf.js build now loads on the daemon side** (`@tentacle/tools`
   import, 8 ms, no console writes): `globals-probe.ts` shows it adds
   `__core-js_shared__` and `pdfjsImageDecoders` and wraps
   `Function.prototype.toString`; no other probed builtin is replaced.

### Gate

Not run by the executor: the full `bun run check` is the orchestrator's script.

## Review

*— <model-id>, <date>*

(Not started.)
