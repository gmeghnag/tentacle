# feat/pdf-images — PDF images in the model's context, next to the text

> **Status:** implementation (plan written, NOT approved — see Owner questions)
> **Branch:** `feat/pdf-images`
> **Size:** L → split into S1 · S2 · S3 (each M, each mergeable alone) · **Blast:** load-bearing (provider payloads for tool results, the tool-result shape, the session's image store) · **Suited:** Opus executes S1 and S3 (load-bearing) with mandatory fresh-context Review; S2 (contained: tools + core pure) may go to a weaker model with standard Review
> **Changelog:** `changelog.d/pdf-images.added.md` (written by S3, the slice that makes images reach the model; S2 adds `changelog.d/pdf-image-markers.added.md` for the markers + the size cap)

Metadata (TODO.md row): `Type: feat · Size: L (S1 M · S2 M · S3 M) · Blast: load-bearing · Suited: Opus plan + exec S1/S3, fresh-context Review`

## Context

*— claude-opus-5-5, 2026-11-21*

`fs_read` on a PDF returns text only: the worker (`packages/tools/src/pdf/run.ts:51-106`)
calls `getTextContent()` per page and `buildPageText` (`core/src/pdf-text.ts:118`);
nothing looks at the page's images. A quiz, a datasheet, a scanned page: the
picture that carries the meaning never reaches the model. The owner wants each
page's images extracted with their position, a `[image p.N · W×H]` marker at
their place in the reading order, the PNGs given to vision models and only the
markers to text-only models. Tiny/repeated images (logos, headers) skipped,
caps per read. A scanned PDF (a page = one image) falls out of the same path:
it overlaps **feat/mobile-pdf-ocr** (TODO.md:56), which OCRs on the phone; with
this task a vision model can read the scan itself through `fs_read`, but an
*attached* scan from the phone still goes through `attachedPdfText`
(`core/src/pdf-text.ts:552`) and is still refused — that path is mobile-pdf-ocr's,
not this task's (see Notes).

Acceptance (owner, 20/11): a BLIND test on the owner's
`~/github/gmeghnag/farmaquiz/solo_domande.pdf` against the ground truth of the
owner's PyMuPDF script (`estrai_immagini.py`, nearest-by-y image ↔ "Domanda N"),
`immagini/<N>.png`, 405 files. Owner data: never copied into the repo.

### Facts measured for this plan (2026-11-21)

- `solo_domande.pdf` is **64,902,081 B (61.9 MiB) and 1479 pages**. Today
  `fs_read` refuses it outright: `MAX_PDF_BYTES = 50 MiB` (`core/src/pdf-text.ts:21`,
  enforced `tools/src/pdf/extract.ts:136`). → Owner Q3.
- pdf.js 6.5.438 (the pinned one) sees **406 image paints** over the 1479
  pages, all `paintImageXObject`, decoded kinds RGB_24BPP (379) and
  RGBA_32BPP (27); none smaller than 64 px; full-document walk incl. decoding
  every image: 12.0 s (≈ 0.8 s per 100-page read).
- **Every one of the 406 decoded images is pixel-identical** (same W×H, same
  RGB bytes, alpha dropped) to a ground-truth PNG. 405 GT files hold 403
  distinct pixel contents: two images are reused for two different questions
  (e.g. one picture on p.30 and p.31). → "repeated" must NOT mean "seen twice".
- Rule "the image belongs to the last `Domanda N` above it in reading order"
  agrees with the GT for 404/406 paints; the 2 disagreements are exactly the
  two reused pictures (my lookup was pixel → one file name; with (question,
  pixels) pairs they agree). So a reading-order marker placement can score
  405/405 on this file.
- The GT PNGs are `doc.extract_image(xref)` output (PyMuPDF re-encodes Flate
  streams to PNG); our encoder will not produce the same bytes → the match is
  on **decoded pixels**, not bytes (D7).

**Repro** (run 2026-11-21 in `.tentacle/tmp/pdf-images/`, on `feat/pdf-images` = `main` 63d76f3e):

`payload.ts` — the load-bearing check (does a TOOL message carrying image refs reach the model as an image today?):

```ts
const W = "/Users/gmeghnag/tentacle/.tentacle/worktrees/pdf-images/packages";
const { buildPayload: anthropicPayload, OpenAIProvider, resolveImages, selectInlineIds } = await import(`${W}/providers/src/index.ts`);
const { createHash } = await import("node:crypto");
const png = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]);
const id = createHash("sha256").update(png).digest("hex");
const ref = { id, mimeType: "image/png", size: png.length, name: "p1-img1.png" };
const messages = [
  { role: "user", content: "read doc.pdf" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "fs_read", arguments: '{"path":"doc.pdf"}' }] },
  { role: "tool", content: "Q1 ... [image p.1 · 10×10]", toolCallId: "c1", attachments: [ref] },
];
const source = { read: async () => png };
const req = { messages, attachments: source };
console.log("selected for inline (user-only walk):", [...selectInlineIds(messages)]);
const images = await resolveImages(req);
console.log("resolved:", images.size);
const a = anthropicPayload("m", req, 1000, { images, vision: true, inlined: selectInlineIds(messages), maxImageBytes: 1e7 });
console.log("ANTHROPIC tool turn:", JSON.stringify((a.messages as any[]).at(-1)));
let body: any;
const p = new OpenAIProvider({ baseUrl: "http://x/v1", model: "m", images: true, fetch: (async (_u: string, init: any) => { body = JSON.parse(init.body); return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }); }) as any });
try { for await (const _ of p.stream(req as any)) {} } catch (e) { console.log("stream err", String(e)); }
console.log("OPENAI tool msg:", JSON.stringify(body?.messages.at(-1)));
```

```
selected for inline (user-only walk): []
resolved: 0
ANTHROPIC tool turn: {"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":"Q1 ... [image p.1 · 10×10]"}]}
OPENAI tool msg: {"role":"tool","content":"Q1 ... [image p.1 · 10×10]\n[image unavailable — p1-img1.png sha256:4353a1de7e0d]","tool_call_id":"c1"}
```

Two findings: (1) the seam exists but stops at USER messages; (2) the Anthropic
mapper **silently drops** refs on a tool message (no placeholder — the OpenAI
mapper at least says "unavailable"). (2) is a latent silent drop today (only a
pod could put refs on a tool message); S1 fixes it.

`ops.ts` — feasibility on the owner's PDF (read in place, never copied): walks
each page's operator list with the CTM, fetches the decoded image object,
hashes its pixels and looks the hash up in the GT set; also prints the page's
`Domanda N` positions. (`bun ops.ts <from> <to>`)

```ts
const W = "/Users/gmeghnag/tentacle/.tentacle/worktrees/pdf-images/packages/tools/node_modules/pdfjs-dist/legacy/build";
(globalThis as any).pdfjsWorker = await import(`${W}/pdf.worker.mjs`);
const pdfjs = await import(`${W}/pdf.mjs`);
const { inflateSync } = await import("node:zlib");
const { createHash } = await import("node:crypto");
const { readdirSync, readFileSync } = await import("node:fs");
const GT = `${process.env.HOME}/github/gmeghnag/farmaquiz/immagini`;
// minimal PNG decoder → RGB bytes (8-bit, color types 2/6/0, no interlace)
function decodePng(b: Uint8Array) { const dv = new DataView(b.buffer, b.byteOffset); let p = 8, w=0,h=0,ct=0; const idat: Uint8Array[] = [];
  while (p < b.length) { const len = dv.getUint32(p); const t = String.fromCharCode(...b.subarray(p+4,p+8)); const d = b.subarray(p+8,p+8+len);
    if (t==="IHDR"){w=dv.getUint32(p+8);h=dv.getUint32(p+12);ct=b[p+17];} if(t==="IDAT")idat.push(d); p+=12+len; }
  const raw = inflateSync(Buffer.concat(idat)); const bpp = ct===6?4:ct===2?3:ct===0?1:ct===4?2:3; const stride=w*bpp; const out=new Uint8Array(h*stride);
  for(let y=0;y<h;y++){const f=raw[y*(stride+1)];const row=raw.subarray(y*(stride+1)+1,(y+1)*(stride+1));for(let x=0;x<stride;x++){const a=x>=bpp?out[y*stride+x-bpp]:0,up=y?out[(y-1)*stride+x]:0,c=x>=bpp&&y?out[(y-1)*stride+x-bpp]:0;let v=row[x];
   if(f===1)v+=a;else if(f===2)v+=up;else if(f===3)v+=(a+up)>>1;else if(f===4){const pp=a+up-c,pa=Math.abs(pp-a),pb=Math.abs(pp-up),pc=Math.abs(pp-c);v+=pa<=pb&&pa<=pc?a:pb<=pc?up:c;}out[y*stride+x]=v&255;}}
  return { w, h, ct, rgb: toRgb(out, w*h, bpp) }; }
function toRgb(px: Uint8Array, n: number, bpp: number) { if (bpp===3) return px; const o=new Uint8Array(n*3); for(let i=0;i<n;i++){ if(bpp===1||bpp===2){o[i*3]=o[i*3+1]=o[i*3+2]=px[i*bpp];} else {o[i*3]=px[i*4];o[i*3+1]=px[i*4+1];o[i*3+2]=px[i*4+2];}} return o; }
const key = (w: number, h: number, rgb: Uint8Array) => `${w}x${h}:${createHash("sha256").update(rgb).digest("hex").slice(0,16)}`;
const gt = new Map<string,string>(); for (const f of readdirSync(GT)) { const d = decodePng(readFileSync(`${GT}/${f}`)); gt.set(key(d.w,d.h,d.rgb), f.replace(".png","")); }
const data = new Uint8Array(readFileSync(`${process.env.HOME}/github/gmeghnag/farmaquiz/solo_domande.pdf`));
const doc = await pdfjs.getDocument({ data, isEvalSupported:false, disableFontFace:true, useSystemFonts:false, useWorkerFetch:false, stopAtErrors:false, verbosity:0 }).promise;
const from = Number(process.argv[2] ?? 1), to = Math.min(doc.numPages, Number(process.argv[3] ?? 5));
console.log("pages", doc.numPages, "gt images", readdirSync(GT).length, "gt distinct pixel keys", gt.size);
const OPS = pdfjs.OPS; let total=0, matched=0; const t0 = performance.now();
for (let n = from; n <= to; n++) {
  const page = await doc.getPage(n); const ol = await page.getOperatorList(); const vp = page.getViewport({ scale: 1 });
  let ctm = [1,0,0,1,0,0]; const stack: number[][] = []; const imgs: string[] = [];
  const mul = (m: number[], n2: number[]) => [m[0]*n2[0]+m[1]*n2[2], m[0]*n2[1]+m[1]*n2[3], m[2]*n2[0]+m[3]*n2[2], m[2]*n2[1]+m[3]*n2[3], m[4]*n2[0]+m[5]*n2[2]+n2[4], m[4]*n2[1]+m[5]*n2[3]+n2[5]];
  for (let i = 0; i < ol.fnArray.length; i++) { const fn = ol.fnArray[i], a = ol.argsArray[i];
    if (fn===OPS.save) stack.push(ctm); else if (fn===OPS.restore) ctm = stack.pop() ?? ctm; else if (fn===OPS.transform) ctm = mul(a, ctm);
    else if (fn===OPS.paintImageXObject || fn===OPS.paintInlineImageXObject) { total++;
      const obj: any = fn===OPS.paintInlineImageXObject ? a[0] : await new Promise(r => (a[0].startsWith("g_")?page.commonObjs:page.objs).get(a[0], r));
      const y = vp.height - (ctm[5] + ctm[3]/2); // top-origin centre y
      let k = "?"; if (obj?.data) { const kind = obj.kind; const bpp = kind===3?4:kind===2?3:1; k = key(obj.width,obj.height,toRgb(obj.data,obj.width*obj.height,bpp)); }
      else if (obj?.bitmap) k = `bitmap ${obj.width}x${obj.height}`;
      const q = gt.get(k); if (q) matched++; imgs.push(`${obj?.width}x${obj?.height} kind=${obj?.kind} y=${y.toFixed(0)} gt=${q ?? "-"}`); } }
  const tc = await page.getTextContent(); const qs = tc.items.filter((it: any) => /Domanda/.test(it.str)).map((it: any) => `${it.str.trim()}@${(vp.height-it.transform[5]).toFixed(0)}`);
  if (imgs.length) console.log(`p${n}`, imgs.join(" | "), "\n   ", qs.join(" "));
  page.cleanup();
}
console.log({ total, matched, ms: Math.round(performance.now()-t0) });
```

```
$ bun ops.ts 1 100000 > full.txt; head -1 full.txt; tail -5 full.txt
pages 1479 gt images 405 gt distinct pixel keys 403
{ total: 406, matched: 406, ms: 12041 }
(excerpt)
p30 154x73 kind=2 y=108 gt=69      Domanda 68@308 Domanda 67@77
p31 154x73 kind=2 y=74 gt=69       Domanda 70@221 Domanda 69@43 Domanda 71@390
p32 138x69 kind=2 y=97 gt=72 | 173x100 kind=2 y=302 gt=73    Domanda 73@260 Domanda 72@73
p38 161x97 kind=3 y=301 gt=85      Domanda 84@78 Domanda 85@269
```

`rule.ts` over `full.txt` (last question above the image vs nearest):
`{ n: 406, prevOk: 404, nearOk: 404 }`, misses `p30 y=108 gt=69 above=67` and
`p88 y=103 gt=196 above=194` — both the reused pictures (pixel→name lookup
collision), not placement errors.

## Implementation

*— claude-opus-5-5, 2026-11-21*

### Load-bearing assumption

**A tool result can carry images to the model through the existing image-ref
seam (`ChatMessage.attachments` + `AttachmentSource` + `providers/src/images.ts`),
per provider, without a second image path.** Verdict, per provider:

| Provider | Can a tool result carry an image? | Evidence | What we do |
|---|---|---|---|
| **Anthropic** (`anthropic-provider.ts`) | **Yes, natively**: a `tool_result` block's `content` may be an array of `text` + `image` (base64) blocks — the documented computer-use pattern returns screenshots exactly this way (Anthropic tool-use docs, `tool_result` content). Today the mapper sends `content: message.content` (a string) and drops refs | `anthropic-provider.ts:444-474` (tool branch never looks at `attachments`); repro above | S1: tool message with refs → `tool_result.content = [text, image…]` |
| **OpenAI-compatible** (DeepSeek, local qwen/llama.cpp, vLLM; `openai-provider.ts`) | **No**: a `role:"tool"` message's content is text (string or text parts); image parts are only valid on `user` messages. DeepSeek's chat models take no images at all; the local Qwen3 27B is text-only | `openai-provider.ts:399-439` (image parts built only for `role === "user"`); `imageLimits` defaults `vision=false` for openai (`images.ts:141-147`) | S1: `vision=false` (the default) → markers only + one honest line; `model.images: true` (a VL model) → a **wire-only** `user` message right after the run of tool messages, carrying the images (Owner Q1) |
| **Pod `--model-proxy`** (laptop provider, pod tool) | Refs reach the laptop (`model/stream` carries them), but the laptop's `LaptopImages` serves only ids the laptop added itself (`client/src/laptop-images.ts:1-22`) → `[image unavailable]` | AGENTS §7 "model stays on the laptop" / "a pod is not trusted" | v1: markers only in pod runs, honestly labelled; a pod→laptop byte path is a separate task (Owner Q5) |

The ONE property that must hold for S1 to be right: **the provider inlines a
tool message's refs into the request the model sees, only from bytes it verified
(sha256 + size), within a bounded per-request budget, and every ref it does not
inline leaves a visible trace.** That property is pinned by the S1 tests.

### Preconditions (verified)

- History holds refs, never bytes; a ref's id is the sha256 of its bytes and the
  provider re-verifies (`providers/src/images.ts:1-18`, `resolveImages` `:162-200`).
- The log already stores refs on ANY role: `appendEntryType` keys on
  `hasAttachments` only (`protocol/src/session-log.ts:391-399`) → a tool message
  with refs rides the existing critical `media_message` entry. **No log-format
  change, no `PROTOCOL_VERSION` bump** (S3 adds a round-trip test to prove it for
  `role:"tool"`).
- `ChatMessageSchema` already carries `attachments` on any role
  (`protocol/src/session.ts:200-205`); `toolMessage` builds the tool
  `ChatMessage` field by field (`agent/src/agent.ts:280-292`) — one place to add refs.
- The session's image store: `AttachmentStore implements AttachmentSource`
  (`daemon/src/attachment-store.ts:146`), per session, bounded by
  `SESSION_UPLOAD_BYTES` 100 MiB / `DAEMON_UPLOAD_BYTES` 256 MiB (`:33-37`), passed to the
  agent as `attachments` only when the image policy is `store`
  (`daemon/src/session-host.ts:1565,1653`); the policy is `store` only when the
  model has vision (`cli/src/image-policy.ts:43`). → reuse it as the tool's
  sink: no vision ⇒ no sink ⇒ the tool extracts no bytes at all.
- Compaction drops images by design (owner Q6 of attachments-core): the summary
  sees `[image: label]` (`agent/src/compact.ts:41-44`). Smart-compaction prune
  replaces a tool message with a fresh object without `attachments`
  (`agent/src/prune.ts:146-185`) → a pruned read loses its images, as it should.
- The PDF worker is killable, memory-watched and concurrency-capped
  (`tools/src/pdf/extract.ts:65-107,118-232`); no network (`quiet.ts`). Image
  decoding happens inside it, so a hostile image costs the same worker.
- Anthropic's per-image cap is already enforced before any read
  (`ANTHROPIC_MAX_IMAGE_BYTES`, `images.ts:42`); per-request image count: the
  API documents a per-request maximum (100 images on the Messages API, and a
  smaller max dimension when many images are sent) — **TO VERIFY against the live
  docs at S1 execution**; our budget (Q2: 20) stays well below it.

### Design

**D1 — Extraction in the worker (S2).** `runExtraction` (`run.ts:51`) gains, per
wanted page, `page.getOperatorList()` and a walk of `fnArray/argsArray` that
tracks the CTM (`save`/`restore`/`transform`) and, on `paintImageXObject` /
`paintInlineImageXObject` (and `paintImageXObjectRepeat`, one paint per
position), records `{page, bbox in page space (top-origin), objId}`; the object
comes from `page.objs` / `page.commonObjs` (`g_…` ids) — inline images carry it in
the args. The walk itself is a **pure function** over `(fnArray, argsArray, OPS)`
in `core/src/pdf-images.ts` (testable without pdf.js); the worker only resolves
objects. `pdfDocumentOptions` adds `isOffscreenCanvasSupported: false` (and
`isImageDecoderSupported: false` if present in 6.5.438 — verify) so pdf.js hands
back raw `data` (kinds 1/2/3), never an `ImageBitmap`; a pinned test as for every
other flag (`options.ts:8`). `paintImageMaskXObject` (stencil masks: a fill
colour through a 1-bit mask, mostly glyph-like) is **not** extracted in v1.

**D2 — Placement in the reading order (S2, pure, core).** `buildPageText`
(`pdf-text.ts:118`) orders text items; a new `buildPageTextWithImages(items,
images)` inserts each kept image's marker as a pseudo-item at its bbox
(top-y, x) so it lands where the reading order puts it: after the text line whose
baseline is above the image's top, before the next. No layout hint, nothing
quiz-specific. Marker grammar (one line of its own):
`[image p.N · W×H]` (pixel size of the PNG sent), variants
`[image p.N · W×H · same as p.M]` (repeat, no bytes), `[image p.N · W×H ·
not sent: <reason>]` (cap reached, undecodable, too small to matter is NOT
marked — skipped silently by rule, counted in the footer). A footer line per read
when anything was skipped/capped: `[images: 27 sent, 2 repeats, 3 tiny skipped,
1 over the per-read cap — read fewer pages to get the rest]`.

**D3 — Filters and caps (S2, pure; numbers = Owner Q4).** Skip an image whose
smaller side < 24 px or area < 32×32 px (rules, bullets). "Repeated" = the same
decoded pixel hash ≥ 3 times in this read (headers, logos): first occurrence
sent, the rest marked `same as p.M` with no bytes. Two occurrences are NOT
repeats (the farmaquiz reused pictures prove the need). Caps per read: ≤ 32
images sent, ≤ 8 MiB of PNG in total; beyond, markers say `not sent: per-read
cap`. A sent image's long edge is ≤ 1568 px (box downscale, pure JS); each PNG
also ≤ the model's per-image cap (S3 checks against `imageLimits` before the
put).

**D4 — PNG without native deps (S2, pure).** `core/src/png.ts`: encoder for
gray / RGB / RGBA 8-bit, filter 0 per row (or None/Sub adaptive — measure),
CRC32 table, `zlib.deflateSync` (Bun's `node:zlib`, works in a Worker; JS, no
native addon of ours). Kind 1 (`GRAYSCALE_1BPP`, packed bits) is unpacked to
8-bit gray first. Alpha (kind 3, an applied SMask) is kept (RGBA PNG); the scorer
compares RGB only (D7).

**D5 — The worker's answer (S2).** `PdfExtractedPage` gains
`images: PdfPageImage[]` (`{marker, png?: Uint8Array, width, height}`) and the
response transfers the PNG buffers (`postMessage(answer, transfer)`).
`formatPdfText` (`pdf-text.ts:312`) emits the markers in place. The 400k-char
text cap is unchanged; images have their own caps (D3). In S2 the bytes are
dropped at `readPdf` (`builtins.ts:150`): the model gets markers only (= exactly
what a text-only model gets after S3), and the acceptance runs.

**D6 — The tool's sink (S3).** `ToolContext` gains
`attachments?: AttachmentSink` (`core/src/tool.ts:164-201`) —
`put(bytes, mimeType, name): AttachmentRef | {refused: reason}` — bound by the
daemon to the session's `AttachmentStore` through a new SYNCHRONOUS
`putComplete(id, bytes)` that verifies the sha256, reserves from the same
`UploadBudget`, and (serve) hands the blob to the same `AttachmentDisk`
(`attachment-store.ts:20-26`). Absent when the image policy is off (no vision) or in a pod
(Q5). `ToolResult` gains `attachments?: readonly AttachmentRef[]`, `toolMessage`
(`agent.ts:280`) copies it onto the tool `ChatMessage`. A refused put (store
full) turns that marker into `not sent: the session's image store is full` —
never a silent drop.

**D7 — Providers (S1).** `selectInlineIds` (`images.ts:88`) stays the USER
selection (K=5). A second, separate selection `selectToolImageIds(messages,
keep=20)` walks tool messages newest-first (Owner Q2). `resolveImages` resolves
the union (each id read once, verified). Mapping:
- Anthropic: a tool message with refs → `tool_result.content = [{type:"text",
  text: content}, …image blocks for inlined refs, …a text line per ref not
  inlined (reason)]`; consecutive tool results still collapse into one user turn
  (`anthropic-provider.ts:447-473`). No vision → the single line
  `[N images in this result not sent: this model does not take images]`.
- OpenAI-compatible: tool message keeps its string content (+ one reason line
  per ref not inlined). With vision on, after the LAST tool message of a run, a
  wire-only `user` message `[{type:"text", text:"Images from the tool results
  above (call c1: p.1 #1, …)"}, …image_url parts]`. Never written to history,
  rebuilt identically each request (cache-stable).
- `strayRefsText` stays for assistant/system refs. The Anthropic silent drop of
  refs on a tool message is gone in both directions (inlined or reason line).

**D8 — Clients (S3).** No protocol change: the live tool row shows the result
text, which carries the markers; a reload projects `media_message` with
`role:"tool"` — S3 proves the TUI's and the phone's projections render it as a
normal tool row (text), not as a user image chip. Thumbnails of tool images on
the phone/TUI are out of scope (Owner Q6).

**D9 — The blind acceptance (S2, outside the gate).** `scripts/pdf-images-score.ts`
(Owner Q7) — takes `<pdf> <gt-dir>` as arguments, holds no owner data:
1. Runs the REAL extraction (`runExtraction` with real pdf.js, in-process, the
   same code the worker runs) over the whole PDF in 100-page reads (`pages:
   "1-100"`, …), exactly as a model would page through it, with the default
   caps. No layout hint: the extractor knows nothing about "Domanda".
2. Concatenates the formatted text; for each marker that carries a PNG, the
   question = the last `Domanda (\d+)` occurring BEFORE the marker in that text
   (the scorer's only knowledge of the GT naming). Pair = (question,
   pixelKey(PNG)).
3. GT pairs: each `<gt-dir>/<N>.png` → (N, pixelKey). pixelKey = `W×H` +
   sha256 of the decoded 8-bit RGB bytes (alpha dropped, gray expanded) — exact
   decoded-pixel equality, honest across encoders (both sides lossless; the
   repro shows 406/406 equal). Not perceptual: a perceptual match would hide a
   wrong decode.
4. Score = |GT pairs ∩ extracted pairs| / |GT pairs| (405). Prints every miss
   (question, GT size, what was found near it instead) and every extra pair
   (extracted, not in GT) — listed, never averaged away.
5. Pass bar: **≥ 401/405 (99 %) with every miss explained** (Owner Q8). The
   measured ceiling is 405/405 (reading-order rule 404/406 paints, 2 diffs = GT
   reuse artifacts).
The scorer must bypass `MAX_PDF_BYTES` only if Owner Q3 is refused; with Q3
accepted, it is also run once through `fs_read` itself (a `bun` script calling
`fsReadTool.execute` with a local env) to prove the real path.

### Slices (each mergeable alone, in this order)

- **S1 — providers carry tool-result images** (M · load-bearing · Opus +
  fresh Review). D7 only. No producer yet: tests build histories with tool refs
  by hand. Fixes the Anthropic silent drop. Mergeable alone: no behaviour change
  until something puts refs on a tool message (today only a hostile pod could —
  and then it now gets a reason line instead of a silent drop).
- **S2 — extraction, markers, PNG, acceptance** (M · contained · any model +
  standard Review). D1–D5, D9; Q3 cap raise. `fs_read` text gains markers; no
  bytes leave the tool. Mergeable alone: a better text read.
- **S3 — wire the bytes** (M · load-bearing · Opus + fresh Review). D6, D8:
  tool sink, store `putComplete`, `ToolResult.attachments`, `toolMessage`, the
  persistence round-trip, client projections. After S3 a vision model sees the
  pictures.

### Files (dependency order)

S1: `packages/providers/src/images.ts` (tool selection, reason lines) ·
`anthropic-provider.ts` (tool_result content array) · `openai-provider.ts`
(wire-only follow-up user message) · tests `providers/test/images.test.ts`,
`anthropic-provider.test.ts`, `openai-provider.test.ts` (extend; names to match
the existing files).

S2: `packages/core/src/png.ts` (new) · `core/src/pdf-images.ts` (new: CTM walk,
filters, caps, markers — pure) · `core/src/pdf-text.ts` (`MAX_PDF_BYTES` per Q3,
`buildPageTextWithImages`, `formatPdfText` markers/footer) · `core/src/index.ts`
· `tools/src/pdf/options.ts` (types, flags) · `tools/src/pdf/run.ts`
(operator list + objs) · `tools/src/pdf/pdf-worker.ts` (transfer list) ·
`tools/src/pdf/extract.ts` (reply validation incl. images) ·
`tools/src/builtins.ts` (`fs_read` description; drop bytes) ·
`scripts/pdf-images-score.ts` (new, not in the gate) · tests
`core/test/png.test.ts`, `core/test/pdf-images.test.ts`, `tools/test/pdf-*.test.ts`.

S3: `packages/core/src/tool.ts` (`AttachmentSink`, `ToolResult.attachments`) ·
`daemon/src/attachment-store.ts` (`putComplete`) · `daemon/src/hosted-session.ts`
/ `session-host.ts` (bind the sink when policy = store) · `agent/src/agent.ts`
(`toolMessage` copies refs) · `tools/src/builtins.ts` (put PNGs, markers on
refusal) · client/TUI/mobile projections only if the S3 test shows a wrong
render · tests in `daemon/test`, `agent/test`, `client/test`, `tui/test`.

### Failure modes

| Case | What happens | Converges how / test |
|---|---|---|
| Encrypted PDF | unchanged: `PasswordException` → `encrypted` refusal (`run.ts:40-46`) | existing test |
| JBIG2 / CCITT / DCT (JPEG) | decoded by pdf.js in JS → raw pixels → our PNG | S2 synthetic PDF with a DCT image (JPEG bytes built in-test) |
| JPX (JPEG 2000) | pdf.js 6 decodes JPX through a wasm module it may try to load — with no fetch it can fail → that image's marker says `not sent: undecodable (JPX)`; text unaffected | S2 test with a JPX stream: marker present, read succeeds; verify behaviour first |
| CMYK / Indexed / ICC / Decode arrays | pdf.js converts to RGB in the worker | S2 synthetic Indexed + DeviceGray images; pixel assertions |
| SMask / Mask | applied by pdf.js → kind 3 RGBA → RGBA PNG | S2 test, alpha preserved |
| Inline images (`BI…ID…EI`) | `paintInlineImageXObject`, object in args | S2 synthetic inline image |
| Stencil masks (`paintImageMaskXObject`) | not extracted (v1) — documented, counted nowhere (they are glyph-like) | S2 test pins "no marker" |
| Huge image (scan 2480×3508, or a bomb 30000×30000) | decoding happens in the worker under the RSS watchdog (`too-much-memory`) and timeout; a kept image is box-downscaled to 1568 px | S2 downscale unit test; watchdog tests exist |
| 0 images | text identical to today (byte-for-byte) | S2 regression test on the existing text fixtures |
| 500-page PDF | unchanged page caps (100/read, `MAX_PAGES_PER_READ`); image caps per read; footer tells the model to read fewer pages for the rest | S2 cap tests |
| 1479-page / 62 MiB (farmaquiz) | refused today (50 MiB); Q3 raises to 100 MiB, the RSS watchdog stays the real bound | acceptance run |
| Text-only model | no sink ⇒ no bytes extracted to the store; markers in text; provider adds no image | S1 (vision false line), S3 (no sink ⇒ no put) |
| OpenAI-compatible VL model | wire-only follow-up user message | S1 |
| Pod run | markers only + `[image unavailable — …]` per ref if any reached the laptop; nothing read from the pod | S3 test (no sink in pod) + existing pod ref tests |
| Store full / budget refused | marker `not sent: the session's image store is full`; read succeeds | S3 |
| Compaction | images dropped, summary names them (`compact.ts:41-44`) | S3 test: a tool message with refs renders `[image: …]` in the summary input |
| Prune (smart compaction) | replacement has no refs → images gone with the result | S3 test |
| Mid-read cancel | `signal` → `worker.terminate()` (`extract.ts:160-174`); nothing was put (puts happen after the reply) | S3: abort before reply ⇒ store untouched |
| Resume / reload | refs in `media_message`; bytes from the store (serve: disk-durable; worker: as user images do) or `[image unavailable]` — never a poisoned session | S3 round-trip test |
| Session log size | refs only (~150 B each) in the log; bytes in the store / blob dir, bounded by the session cap | S3 asserts the log line holds no base64 |
| Version skew (older client/peer) | no new wire shape; `media_message` already known to every peer since v23 | none needed (no bump) |
| Phone/TUI render | tool row shows text + markers; a reload of a tool `media_message` renders as a tool row | S3 projection tests |

### Tests (red before green; mutation targets)

S1 (`providers/test`):
- Anthropic: tool message with a verified ref → `tool_result.content` holds an
  `image` block with that base64 (RED today: the repro output). Mutation: map
  the tool branch back to `content: message.content` → fails.
- Anthropic: ref with wrong bytes/sha → text reason line, no image (RED today:
  silent drop). Mutation: drop the reason line → fails.
- Tool budget: 25 tool refs → newest 20 inlined, 5 reason lines; user K=5
  unaffected by tool refs (mutation: share one budget → fails).
- OpenAI vision on: follow-up user message after the last tool message of a run,
  images in order; vision off: no image part anywhere, one line (mutation:
  attach parts to the tool message → fails).
- Parallel tool results still collapse into one Anthropic user turn.

S2 (`core/test`, `tools/test`; synthetic PDFs built in-test, like the existing
pdf tests do):
- PNG: encode → decode with a tiny test decoder → identical pixels, for gray,
  RGB, RGBA, 1×1, odd widths; CRC of IHDR known value.
- CTM walk: nested `save/transform/restore` → expected bbox; inline + XObject.
- Placement: two text blocks with an image between them → marker between
  (mutation: append markers at page end → fails).
- Filters: 10×10 skipped; same image ×2 both sent; ×3 → 1 sent + 2 `same as`
  (mutation: threshold 2 → the ×2 test fails).
- Caps: 40 images → 32 sent, footer; 8 MiB cap.
- Real worker on a synthetic 3-page PDF with RGB, Indexed+SMask, inline images:
  markers and decoded pixels.
- `isOffscreenCanvasSupported:false` pinned in `options.ts` test.
- 0-image PDF: text unchanged (byte-equal to today's output — RED-proof by
  running the test on main first).
- Acceptance (outside the gate): `bun scripts/pdf-images-score.ts
  ~/github/gmeghnag/farmaquiz/solo_domande.pdf ~/github/gmeghnag/farmaquiz/immagini`
  → score, misses, extras pasted into Execution. Non-vacuity: run it with
  placement mutated to "page end" → the score must drop sharply.

S3 (`daemon/test`, `agent/test`, `client/test`, `tui/test`):
- fs_read with a sink → `ToolResult.attachments` refs whose ids = sha256 of the
  PNGs in the store; the tool `ChatMessage` carries them (mutation: drop the
  copy in `toolMessage` → fails).
- End-to-end in-process: fake Anthropic provider captures the request → image
  block inside the tool_result for a synthetic PDF.
- No sink (no vision / pod) → no put, markers only.
- Store full → `not sent: … full`, read OK.
- Persistence: tool message with refs → `media_message` line, reload equal, no
  base64 in the log.
- Compaction/prune drop the refs; summary input names them.
- TUI/phone projection of a tool `media_message`: a tool row (ink-testing-library
  frame; the mobile projection's pure module).

### Owner questions

**Owner decisions 2026-11-21** (one at a time): Q1 yes (wire-only `user` message, vision only with `model.images: true`) · Q2 yes, 20 newest tool images, **configurable** · Q3 yes, `MAX_PDF_BYTES` 100 MiB, **configurable** · Q4 yes, filters/caps as stated, **numbers configurable** · Q5 yes, pods markers only (byte path = later task) · Q6 yes, text + markers only (thumbnails = later task, mockups first) · Q7 yes · Q8 yes, ≥ 401/405 · Q9 S1 → S2 → S3.

1. **OpenAI-compatible endpoint with a vision model (`model.images: true`):**
   tool messages cannot carry images there. **Recommendation:** a wire-only
   `user` message right after the run of tool messages with the images (rebuilt
   identically every request, never in history); with `images` off (the
   default, DeepSeek, local Qwen3 27B) → markers only.
2. **How many tool images per request reach the model?** **Recommendation:**
   the newest 20 tool-result images, a budget separate from the 5 user images
   (`MAX_INLINE_IMAGES`); older ones become `[image omitted: older tool image
   — p.N]` (re-reading the pages brings them back).
3. **`MAX_PDF_BYTES` 50 MiB refuses your 62 MiB farmaquiz PDF.**
   **Recommendation:** raise to 100 MiB in S2; the per-worker RSS watchdog
   (512 MiB) remains the real memory bound.
4. **Filters and caps per read.** **Recommendation:** skip side < 24 px or
   area < 32×32; "repeated" = same pixels ≥ 3 times in the read (sent once);
   ≤ 32 images and ≤ 8 MiB PNG per read; long edge downscaled to ≤ 1568 px.
5. **Pod runs (`run`/`attach`, model on the laptop):** pod-extracted images
   cannot reach the laptop's provider without a new pod→laptop byte path (a
   §7 trust decision). **Recommendation:** v1 = markers only in pods; the
   byte path is its own later task.
6. **What the phone/TUI show for a tool result with images.**
   **Recommendation:** v1 = the text with markers, plus nothing else; thumbnails
   on the tool row are a separate follow-up task.
7. **Where the acceptance scorer lives.** **Recommendation:**
   `scripts/pdf-images-score.ts`, generic (paths as arguments, no owner data),
   committed so it can be re-run; not part of `bun test`.
8. **Pass bar of the blind test.** **Recommendation:** ≥ 401/405 (99 %) correct
   (question, pixels) pairs, every miss and every extra listed and explained;
   the measured ceiling is 405/405.
9. **Slice order.** **Recommendation:** S1 → S2 → S3 (prove the load-bearing
   provider seam first); S2 may run before S1 if you want the markers and the
   acceptance score sooner — they do not touch the same files.

### Notes / debt

- feat/mobile-pdf-ocr overlap: after S3 a vision model reads a scanned PDF via
  `fs_read` (one page = one image). A scan ATTACHED from the phone still goes
  through `attachedPdfText` and is refused; making attachments carry page
  images would reuse S2+S3 on the prompt path — decide in mobile-pdf-ocr
  whether to OCR on the phone or send page images.
- A pod→laptop image byte path (Q5) and tool-image thumbnails (Q6) are follow-ups.
- `paintImageMaskXObject` (stencil masks) is not extracted; vector drawings are
  not images and are not rendered (no canvas without native deps).

## Execution

### S1 — providers carry tool-result images

*— claude-opus-5-5, 2026-11-21*

**Load-bearing check re-run first** (`bun .tentacle/tmp/pdf-images/payload.ts` on
`645db3df`, before any edit): output identical to the Context's Repro
(`selected … []`, `resolved: 0`, Anthropic `tool_result.content` a bare string = the
ref silently dropped, OpenAI `[image unavailable — …]`). Held → proceeded.

**As built** (all in `packages/providers`):
- `src/images.ts` — `MAX_TOOL_IMAGES = 20`; `selectToolImageIds(messages, keep)`
  (newest-first, distinct, tool messages only; returns id → the NEWEST tool
  message carrying it, its one inline slot); `resolveImages(req, keep, max,
  toolKeep = 0)` reads the user ∪ tool selections, each id once, same
  sha256+size verification; `ImageBuildOptions` gains optional `toolInlined` /
  `toolKeep`; `buildImageOptions(request, limits, toolKeep)` (the one place both
  providers build options; no vision ⇒ zero reads, as before);
  `toolImageBudget(maxToolImages)`; `toolResultImages(m, options)` → inlined
  images (with labels) + one reason line per ref not inlined (older than the
  budget, same image in a newer result, over cap, unsupported type,
  unavailable), or ONE line `[N images in this result not sent: this model does
  not take images]` without vision; `toolResultText(content, lines)`.
  `userParts` now inlines only ids in the USER selection (`inlined.has`), so the
  tool selection's bytes can never widen the user's K. `placeholder` takes the
  "older" wording as a parameter. `imageLimits` unchanged (its shape is pinned
  and consumed by the daemon).
- `src/anthropic-provider.ts` — `toolResultBlock`: no refs → unchanged string
  content (byte-identical, cache-stable); refs with ≥1 inlined image →
  `content: [text (if non-empty), …image blocks, text of reason lines]`; refs
  with none inlined → string + reason lines. Consecutive results still collapse
  into one user turn. `maxToolImages?` config. `imageOptions` → `buildImageOptions`.
- `src/openai-provider.ts` — `wireMessages`: a tool message stays a string
  (+ reason lines); with vision, after the LAST tool message of a run, ONE
  wire-only `user` message `[images from the tool results above — call c1:
  <label>, …; call c2: …]` + `image_url` parts in order. Never in history; rebuilt
  identically per request. `maxToolImages?` config. `imageOptions` → `buildImageOptions`.
- Tests: `test/tool-images.test.ts` (new, 10 tests: both providers end-to-end on
  the captured body via injected `fetch`) and `test/tool-image-select.test.ts`
  (new, 4 pure tests: selection, single read per id, user K isolation).
- `changelog.d/pdf-images.added.md` (one bullet, owner's instruction; S3 should
  extend it rather than add a second fragment).

**Red before green** — the new e2e file run against HEAD's three source files
(mine set aside in `.tentacle/tmp/pdf-images/s1-new/`, then restored):
`1 pass, 9 fail` — every Anthropic test and the two OpenAI vision tests fail on
the assertion; the 1 pass is "OpenAI wrong bytes → unavailable line", which is
already today's behaviour. After: `10 pass`. (The pure file imports new exports,
so it cannot be red on HEAD by assertion; its property is covered by M5.)

**Mutations** (each applied, run, reverted from the scratch copy; `rg MUTATION`
empty afterwards):
| # | Mutation | Result |
|---|---|---|
| M1 | Anthropic tool branch back to `content: message.content` | 7 fail |
| M2 | `toolResultImages` drops every reason line | 5 fail (both providers) |
| M3 | tool budget shares the user's K (`5 − user selected`) | 2 fail (25→20 budget, maxToolImages) |
| M4 | OpenAI puts image parts on the tool message, no follow-up | 1 fail (vision-on order test) |
| M5 | `userParts` drops the `inlined.has` guard | 1 fail (user K isolation) |

**Verification (narrow, per the token budget):** `bun test packages/providers`
→ 185 pass, 0 fail; `bunx tsc --noEmit -p packages/providers` clean; `bunx biome
check` on the 5 changed files clean. Repro after: OpenAI wire carries the image
in the follow-up user message; Anthropic's hand-built options in the repro carry
no tool selection, so it now shows a reason line instead of the silent drop.
No protocol schema touched → `protocol.json` not regenerated; no `protocol.d/` note.

**Drift from Implementation (and why):**
- Tests are two NEW files instead of extending `images.test.ts` /
  `anthropic-provider.test.ts` / `openai-provider.test.ts`: the e2e file must use
  only `AnthropicProvider`/`OpenAIProvider` so it can run on HEAD for the red
  proof; the pure file holds what imports new exports.
- "Configurable" (Q2) is done at the PROVIDER config level (`maxToolImages`);
  the user-facing config key (`model.maxToolImages` in `packages/config` +
  `select-provider.ts` + `cli/config-effective.ts`) is NOT wired — outside S1's
  file list. Follow-up: wire it in S3 or a small task.
- Added dedup across results (same id in two tool results → inlined once, in the
  newer; the older gets a reason line). Not in D7, but needed for the plan's own
  property "within a bounded per-request budget": without it, re-reading the same
  page N times would send N copies past the budget.
- The reason line for an older tool image reads `only the newest 20 tool-result
  images are sent (read it again to see it)`, not Q2's `older tool image — p.N`
  (the ref label is the file name; the page lives in the S2 marker).
- **Not verified:** Anthropic's per-request image maximum (Preconditions "TO
  VERIFY"): the docs lookup was not available in this session. Our max per
  request is 5 + 20 = 25 (dedup makes it a hard bound); verify against the live
  Messages API docs (vision page, "images per request") before S3 ships.
- Pod note for Review: a pod can put on a tool message a ref whose id the laptop
  itself attached (`LaptopImages` serves only those); the laptop would now inline
  that user image again inside a tool_result. Same "the pod chooses only the id"
  scope as user refs from a pod today; no new bytes leave the laptop.

## Review

### S1 — fresh-context adversarial review

**Verdict: REQUEST-CHANGES** (one MEDIUM, no HIGH).

**Gate (narrow, as the brief scoped it):** `bun test packages/providers` → 185 pass,
0 fail; `bun run lint` clean (2220 files); `bun run typecheck` clean (root + mobile +
relay). Full `bun test` was not re-run in this pass.

**Findings**
1. **MEDIUM — the per-request image budget counts images but not the provider's
   per-request limits** (`packages/providers/src/images.ts:34` `MAX_TOOL_IMAGES = 20`,
   `:211-221` `buildImageOptions`). A request may now carry 5 user + 20 tool images.
   Before S1 the most it could carry was 5 × `ANTHROPIC_MAX_IMAGE_BYTES` (3.93 MB raw ≈
   5.2 MB base64 ≈ 26 MB), which is under the Messages API's 32 MB request limit. After
   S1 the bound is ≈ 131 MB. On top of that, more than 20 images in one request lowers
   Anthropic's per-image dimension limit to 2000×2000 px, and user images are not
   downscaled. Failure scenario (once S3 adds a producer): three PDF reads at the S2
   8 MiB per-read cap put about 20 tool images worth ≈ 24 MiB raw in the window, and
   the user attached one 3000 px screenshot earlier. Every later request then gets a
   413/400. The same refs are selected again on every turn, so the session is poisoned.
   That is the outcome `maxImageBytes`' own doc comment says must never happen. This
   is the plan's own "TO VERIFY" (Execution, "Not verified"): it was left open, and the
   load-bearing property "within a bounded per-request budget" only bounds the count.
   Fix before S3 ships: add an aggregate raw/base64 byte budget across user ∪ tool
   inlining (older images fall back to reason lines). Also either cap the total at 20
   for Anthropic or guarantee every image inlined alongside them is ≤ 2000 px. Add
   tests for both.

**Mutation non-vacuity:** the cross-result dedup was mutated so the owner check was
always false and every result inlined its own copy → 1 fail ("the same picture in two
results is sent ONCE"). Reverted from the scratch copy; `git status` was empty
afterwards. The executor's M1–M5 were not re-run.

**Attacks tried (no finding):**
- Anthropic consecutive-result collapse: still one user turn (`anthropic-provider.ts:482-495`).
- No-refs `tool_result`: still the byte-identical string (cache-stable).
- Empty-content text block left out (400 avoided).
- User K isolation: `userParts` checks `inlined.has` (`images.ts:323`).
- Same id twice in one result: sent once.
- Pod-supplied tool refs: the laptop still serves only ids it attached itself (§7 "pod not trusted"). The pod chooses only the id, same scope as before; no new bytes leave the laptop.
- No protocol or persistence surface touched.
- OpenAI wire-only `user` message may sit next to a real `user` turn (user, user). The OpenAI-compatible endpoints accept that; noted, not a finding.

**Executor behaviour:** honest. It flagged the unverified Anthropic limit itself and
documented its drifts (new test files, dedup, config not wired). Reviewer is the same
model family as the planner (claude-opus-5-5), in a fresh context only.

*— claude-opus-5-5, 2026-11-21*
