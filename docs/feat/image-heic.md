# feat/image-heic — HEIC/HEIF pictures read and attached like PNG/JPEG

> **Status:** implementation (APPROVED — orchestrator decisions below, owner-delegated 26/11)
> **Branch:** `feat/image-heic`
> **Type:** feat · **Size:** M · **Blast:** load-bearing (the image path: `fs_read`'s image branch and the TUI attach edge; a child process now runs an OS decoder over untrusted bytes on the daemon host and on the laptop) · **Suited:** Opus plan, Sonnet exec, **mandatory fresh-context Opus Review** (red-team the converter's confinement, its output check and the Ink/terminal rule)
> **Changelog:** `changelog.d/image-heic.added.md` — `- **HEIC/HEIF pictures work like PNG/JPEG on macOS.** \`fs_read\` of an iPhone \`.heic\` shows the picture to a vision model (and \`image_view\` zooms into it), and an attached HEIC is converted to JPEG; on a host without macOS's decoder (Linux \`serve\`, a pod) the read or attach is refused with a sentence saying so.`

## Context

*— claude-opus-5-5, 2026-11-26*

Owner 26/11 ~23:30 «aggiungi supporto HEIC subito» (TODO **feat/image-heic**). An iPhone photo is a HEIC. Today a vision model cannot see one:
- `fs_read` sniffs it and refuses it (`packages/tools/src/image-file.ts:87-91`).
- A TUI attach refuses it (`packages/tui/src/attach-files.ts:169-172`, sentence `attach-refusal.ts:57`).
- The phone already converts HEIC → JPEG on the device before sending (`apps/mobile/src/photo-input.ts:158-165`). That path is not touched here.

The image pipeline after the store already handles JPEG end to end. `image_view` has `low` and `region` for a stored `image/jpeg` (`packages/tools/src/image-view.ts:355-365`, JPEG branch from `:465`, 3b). So **a HEIC converted once to JPEG at the entry point gets every image feature with no change after the store.** The same rule holds on the phone: «never sent as HEIC», `photo-input.ts:159-161`.

The core question is **which decoder**. HEIC is HEVC. HEVC is patent-pooled (Access Advance, Via LA), and the open decoders (libheif + libde265) are LGPL-3.0. The owner's TODO prefers the OS's own decoder where there is one, and a clear refusal where there is none, unless an option with acceptable licence, size and speed is benchmarked. § Decoder decision measures what this Mac has.

Constraints (TODO, binding): red tests first. The existing image caps, dedupe and refusal-without-eviction rules apply unchanged. Say exactly what happens on Linux `serve` and in pods.

**Repro** (2026-11-26, `.tentacle/tmp/image-heic/repro.ts`, `bun repro.ts`; `photo.heic` = the CC0 12 MP photo of `docs/feat/image-region-jpeg.md` § Repro, re-encoded to HEIC by `sips`, 1 433 516 B, `ftyp heic`, grid-tiled like an iPhone's):

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readImageFile } from "/Users/gmeghnag/tentacle/.tentacle/worktrees/image-heic/packages/tools/src/image-file.ts";
import { inspectPath, nodeFileProbe } from "/Users/gmeghnag/tentacle/.tentacle/worktrees/image-heic/packages/tui/src/attach-files.ts";
import { refusalText } from "/Users/gmeghnag/tentacle/.tentacle/worktrees/image-heic/packages/tui/src/attach-refusal.ts";

const path = join(import.meta.dir, "photo.heic");
const bytes = new Uint8Array(await readFile(path));
let puts = 0;
const store = { putTool: async () => { puts += 1; return { refused: "repro" }; },
  resolve: () => ({ kind: "none" }), holds: () => false, read: async () => null };
const env = { readBytes: async (_p: string, o?: { readLimitBytes?: number }) =>
  o?.readLimitBytes === undefined ? bytes : bytes.subarray(0, o.readLimitBytes) };
const r = await readImageFile(path, {}, { env, images: store } as never, { maxImageBytes: 3_932_160, maxEdge: 8000 });
console.log(`fs_read: isError=${r?.isError === true} · ${r?.content} · putTool calls: ${puts}`);
const a = await inspectPath(nodeFileProbe(), path);
console.log(`attach: ok=${a.ok} · ${a.ok ? a.kind : refusalText(a.refusal)}`);
```

```
fs_read: isError=true · photo.heic: HEIC/HEIF images are not readable as images yet (heic) — convert it to PNG or JPEG · putTool calls: 0
attach: ok=false · cannot attach /Users/gmeghnag/tentacle/.tentacle/tmp/image-heic/photo.heic: HEIC/HEIF images are not supported yet — export it as PNG or JPEG first (macOS: sips -s format png "…/photo.heic" --out out.png)
```

## Implementation

*— claude-opus-5-5, 2026-11-26*

**APPROVED** (orchestrator, owner-delegated: pick the recommended option). Every choice is under **#### Orchestrator decisions**. No choice weakens an AGENTS §7 trust rule:
- a pod never converts;
- the laptop converts only a file the USER attached, or one a laptop/`serve` session reads from its own host;
- nothing pod-originated reaches the converter.

### Owner questions

None. The decoder follows the owner's stated preference (OS decoder, refusal elsewhere). § Decoder decision shows why no bundled codec qualifies.

### Decoder decision

Measured on this Mac (Apple Silicon, macOS 27.2, Bun 1.4.3), 2026-11-26. Scripts are in `.tentacle/tmp/image-heic/`: `probe.ts`, `probe2.ts`, `probe3.ts`, `probe4.ts`.

| Candidate | New dep / licence | 12 MP HEIC → JPEG | Untrusted bytes | Linux `serve` |
|---|---|---|---|---|
| **macOS `sips` (ImageIO), child process, under `sandbox-exec`** | **None.** It is part of the OS; Apple licenses HEVC; we ship no codec | **127 ms** plain, **142–177 ms** confined (full size); 204–279 ms with `-Z` | separate process, no network, writes only to the user temp dir, no reads under `/Users` `/Volumes` (probe4); a crash or bomb cannot take the daemon down | absent → refusal |
| `Bun.Image` (built-in) | None | 175 ms (it decodes HEIC on macOS, probe.ts) | **native code in the daemon process**: the J1 objection of `image-region-jpeg.md:134-135`. A crash or a decode bomb kills every session, and it cannot be confined | not probed (no Linux here); no reason to expect HEVC |
| `libheif-js` / `heic-decode` (libheif + libde265 → wasm) | **Yes: LGPL-3.0** inside our single compiled binary (relinking obligations), **plus HEVC patent-pool exposure** for a decoder we would distribute | not benchmarked: rejected on licence/patents (TODO's condition) | wasm sandbox | would work |
| Linux `heif-convert` / `ffmpeg` if the user installed one | None (the user's own tool) | — | child process | **follow-up** (Notes) |

What the probes show:

```
probe.ts   encode heic: code 0, 154 ms · heic bytes: 1433516 ftyp: ftypheic
           decode full default: 0 127 ms 2436978 B SOF0 4032x3024 n=3 2x2,1x1,1x1 orient 1
           decode -Z 4096 q85: 0 279 ms 2981355 B SOF0 4096x3072 …      ← -Z UPSCALES
           decode -Z 2048 q85: 0 216 ms 985759 B SOF0 2048x1536
           orient 6: heic 0 2175B → jpeg 0 SOF0 64x48 … exif 6           ← stored frame + EXIF kept
           truncated heic: 0  out: 710 B                                ← exit 0 on a broken input
           Bun.Image heic→jpeg: 1763957 B 175 ms SOF0 4032x3024
probe2.ts  truncated 4000: -g → pixelWidth: 4032 … · convert code 0 · out=710 B undecodable
           garbage after ftyp: -g → pixelWidth: <nil> · convert code 13 "Cannot extract image from file."
           o6.heic boxes: irot true imir false Exif true · displayed size: original 48x64 round trip 48x64
probe3.ts  good full: … inspect ok 4032x3024 · strict ok 4032x3024 o=1
           truncated 4000 / 50% / 90%: code 0 · inspect REFUSED the JPEG has no frame header (SOF) … · strict REFUSED the JPEG is corrupt (it ends before its image data)
probe4.ts  sandbox-exec, empty env: code 0 177 ms out=2390866 B (identical to unconfined)
           write outside the dir: 13 exists: false "Cannot to rename temporary file to /Users"
make-fixtures.ts  encode deterministic true · decode deterministic true
```

**Verdict: `sips` under `sandbox-exec` on macOS; a refusal with a sentence everywhere else.** It needs no dependency, no licence and no patent exposure. It is crash- and memory-isolated from the daemon and from Ink, and it is fast enough. Three measured traps shape the design:
1. **`-Z` upscales.** The size is queried first, and `-Z` is passed only to shrink.
2. **`sips` exits 0 on a truncated HEIC and writes a broken JPEG.** The exit code is never trusted. The output must pass the existing strict checks (`inspectImageFile` + `readJpegHeader`), which do refuse it (probe3), and its long edge must equal the planned one.
3. **`sips` ignores `TMPDIR` and writes its own scratch file in the per-user temp dir.** The sandbox's write allowance is therefore that dir (`getconf DARWIN_USER_TEMP_DIR`, resolved; **not** `os.tmpdir()`, see Execution), not our own sub-dir (probe4, two runs).

### Load-bearing assumption

**A HEIC converted ONCE to a JPEG that passes the existing strict checks can enter the existing JPEG paths unchanged:**
- for `fs_read`: `putTool` as `image/jpeg`, then `image_view` `low`/`region`;
- for a TUI attach: an `image/jpeg` `AttachmentRef`.

So no store, provider, protocol or `image_view` code changes.

Proof by citation:
- the store takes `image/jpeg` (`packages/core/src/tool-images.ts:53-57`, `ToolImagePut.mimeType`);
- `fs_read`'s JPEG path is `inspectImageFile` → `putTool` (`tools/src/image-file.ts:121-133`);
- `image_view` decodes any stored `image/jpeg` for `low`/`region` (`image-view.ts:355-365`, `:465`);
- `image/jpeg` is a wire type (`packages/protocol/src/attachment.ts:25`).

**Prove first (Execution step 0, before any production edit).** Using `.tentacle/tmp/image-heic/photo.heic`:
1. convert it with the exact argv of D3;
2. `putTool` the JPEG into a real `AttachmentStore`;
3. call `image_view` with `detail:"low"` and with `region` = the centre half, through `createImageViewTool`.

Expected: `low` ≤ 768 px with no `HIGH_ONLY_NOTE`, and the region is an `image/jpeg` crop. Paste the output. If it fails, STOP and fix the plan.

### Preconditions

- **Where conversion can run.**
  - `fs_read`'s image branch exists only with a store and vision (`packages/cli/src/wiring.ts:1439-1452`).
  - The store is given only when `images.source === "store"` (`packages/daemon/src/session-host.ts:1733-1735`).
  - So: a worker (laptop) yes; `serve` yes, on its own host; a pod, a sub-agent or `images:false` no. A pod never converts, and no byte travels pod → laptop for this (§7 «a pod is not trusted»).
- **The TUI attach edge runs in the TUI process** (the laptop), through the injected `FileProbe`. The path is `App.tsx:165` `defaultFileProbe = nodeFileProbe()` → `useAttachments.ts:210,261,304` → `inspectPath` (`attach-files.ts:124`). `@tentacle/tui` already depends on `@tentacle/tools` (`packages/tui/package.json:25`).
- **Ink owns the terminal there** (§7 «never write raw to the terminal»). The child's stdio must be piped or ignored, never inherited.
- **The strict checks exist and refuse `sips`'s broken output:**
  - `inspectImageFile` (`core/src/image-file.ts:239-268`);
  - `readJpegHeader` (`core/src/jpeg-decode.ts:292`);
  - evidence in probe3 above.
- **Caps.**
  - `MAX_IMAGE_BYTES` = 15 MiB (`protocol/src/attachment.ts:37`).
  - Model caps: Anthropic 3 932 160 B, OpenAI-compatible 5 MiB (`providers/src/images.ts:46,53`).
  - `imageFileMaxEdge`: 8000 / 1568 (`images.ts:305-310`).
  - `fs_read` gets both from wiring (`wiring.ts:1447-1451`).
  - The JPEG decode budget is 128 MiB. A 4032×3024 4:2:0 JPEG costs 73 253 376 B, which fits (`image-region-jpeg.md` J4; `sips` writes 2×2/1×1/1×1, probe.ts).
- **The phone's own numbers** (TUI attach parity): `PHOTO_MAX_EDGE` = 2048 and quality 0.8 (`apps/mobile/src/photo-input.ts:81,84`). A converted name wears `.jpg` (`photo-input.ts:272-297`, `nameForType`).
- **Core purity.** `@tentacle/core` imports no `node:` module (the phone imports it). Process spawning lives in `@tentacle/tools`.

### Design

**D1 — `packages/core/src/heic.ts` (new, pure, no `node:`).** It holds the ONE truth for both entry points.
- **Constants.**
  - `HEIC_FILE_MAX_EDGE = 4032`: the longest side an `fs_read` conversion keeps. It is the 12 MP class, which fits the JPEG decode budget, so `low`/`region` work on it.
  - `HEIC_ATTACH_MAX_EDGE = 2048`: the phone's `PHOTO_MAX_EDGE`, restated with a comment because mobile is not importable.
  - `HEIC_JPEG_QUALITY = 80`: the phone's 0.8.
  - `HEIC_MAX_PIXELS = 64_000_000`: a 48 MP iPhone ProRAW-class HEIC (8064×6048 = 48.8 MP) passes.
  - `HEIC_MAX_STEPS = 3`.
  - `HEIC_CONVERT_TIMEOUT_MS = 20_000`.
- **`type HeicConverter = (bytes, { maxEdge, maxBytes }) => Promise<HeicConverted | { refused: string }>`**, where `HeicConverted = { bytes, width, height, sourceWidth, sourceHeight }`. The refusal is one sentence with no file name.
- **`heicTarget(size | undefined, maxEdge)`** returns `{ edge, downscale }` or `{ refused }`:
  - no size, or a 0/NaN side → "the HEIC is corrupt (no readable size)";
  - `w·h > HEIC_MAX_PIXELS` → "the HEIC is W×H, over the 64 MP limit";
  - otherwise `edge = min(maxEdge, max(w,h))`, and `downscale = edge < max(w,h)`. It **never upscales** (trap 1).
- **`checkHeicOutput(jpeg, edge)`** returns `ImageFileInfo` or `{ refused }`. All of these must hold:
  - `inspectImageFile(jpeg, { maxEdge: edge })` is ok and gives `image/jpeg`;
  - `readJpegHeader` does not refuse;
  - `max(w,h) === edge`.

  Otherwise → "the HEIC is corrupt or truncated (its decoded JPEG is not whole)" (trap 2).
- **`convertHeicWith({ maxEdge, maxBytes }, ops)`** is the loop (no `bytes` argument: the ops are bound to the input). All the branching is here. `ops = { size(): Promise<{w,h} | { refused } | undefined>, toJpeg(edge | undefined): Promise<Uint8Array | { refused }> }` are injected effects; a `size` refusal (exit ≠ 0, timeout) passes through.
  1. `heicTarget`.
  2. `toJpeg`, passing an edge only when `downscale`.
  3. `checkHeicOutput`.
  4. If `bytes.length > maxBytes`: `edge = floor(edge·0.75)`, `downscale = true`, and repeat from step 2, at most `HEIC_MAX_STEPS` times. Then → `{ refused: imageOverCapReason(size, maxBytes) }`.
- **`heicJpegName(name)`**: `IMG_0001.HEIC` → `IMG_0001.jpg`, `a.heif` → `a.jpg`; a name with no extension is unchanged. This is the phone's rule.
- **`heicFormatLabel(c)`**: `HEIC→JPEG`, or `HEIC 8064×6048→JPEG` when it downscaled.

**D2 — `imageFileMarker` format widened** (`core/src/image-file.ts:287-296`): `format: string`, so that `imageFileMarker(name, w, h, heicFormatLabel(c), jpeg.length, id)` gives `[image IMG_0001.HEIC · 4032×3024 · HEIC→JPEG · 2.4 MB · ref <12> · high only]`. Existing callers pass `"PNG"`/`"JPEG"`, so their bytes are unchanged.

**D3 — `packages/tools/src/heic-convert.ts` (new: the ONE effectful edge).**
- **`createSipsHeicConverter(deps?)`** returns `HeicConverter | undefined`.
  - `deps = { platform, exists, spawn, tmpRoot, timeoutMs }` defaults to `process.platform`, `existsSync`, `Bun.spawn`, the realpath of **`getconf DARWIN_USER_TEMP_DIR`** (corrected in Execution: `os.tmpdir()` follows `TMPDIR`, `sips` does not, so every conversion failed under another `TMPDIR`) and 20 s.
  - It returns **`undefined` unless** `platform === "darwin"` and both `/usr/bin/sips` and `/usr/bin/sandbox-exec` exist (fail closed, decision H3).
- **`defaultHeicConverter()`**: memoised, created once per process.
- **Per call:**
  1. `mkdtemp(tmpRoot/tentacle-heic-)` and write `in.heic`. `sips` never opens the user's path, so a symlink, fifo or rewrite between read and convert cannot change what was checked.
  2. `size` runs `sandbox-exec -p <profile> /usr/bin/sips -g pixelWidth -g pixelHeight in.heic` and parses it with **`parseSipsSize(stdout)`** (exported, pure). `<nil>` → `undefined`.
  3. `toJpeg` runs `sandbox-exec -p <profile> /usr/bin/sips -s format jpeg -s formatOptions 80 [-Z <edge>] in.heic --out out-<n>.jpg`, then reads the output with a stat bound of `MAX_IMAGE_BYTES`. Exit ≠ 0 → `{ refused: "the HEIC could not be decoded (<first stderr line, ≤ 120 chars>)" }`.
  4. `rm -r` the directory in `finally`, on every path.
- **The profile** (probe4, verified; the last two denials added in fix round 1):

  ```
  (version 1)(allow default)(deny network*)(deny file-read* (subpath "/Users") (subpath "/Volumes"))(deny file-write* (require-not (subpath "<realpath tmpRoot>")))(deny process-fork)(deny process-exec* (require-not (literal "/usr/bin/sips")))
  ```

  The path is quoted with `\` and `"` escaped. This is **not** a deny-default sandbox (Notes).
- **The child:** an absolute argv (no shell, no `PATH`), `env: {}`, `stdin: "ignore"`, and `stdout`/`stderr` `"pipe"`, each read with a 64 KiB bound. **Never `inherit`** (Ink, §7).
- **Timeout:** `HEIC_CONVERT_TIMEOUT_MS` → SIGKILL → `{ refused: "the HEIC took over 20 s to decode" }`.
- **At most 2 conversions at once per process** (a small FIFO gate). A batch of HEIC reads cannot fork-bomb the host's memory.

**D4 — `fs_read` (`packages/tools/src/image-file.ts`).** `ImageFileOptions` gains `heic?: HeicConverter`. The `sniffed.kind === "heic"` branch (`:87-91`) becomes:
1. A range → "<path> is an image: no line ranges".
2. No `options.heic` → `<name>: HEIC/HEIF pictures are converted by macOS's own decoder, and this host (<process.platform>) has none — convert it to JPEG first`. This happens on Linux `serve`, or on a Mac without `sandbox-exec`.
3. `readBytes(path, { maxBytes: MAX_IMAGE_BYTES })`. The INPUT bound is the wire's 15 MiB, because the model's cap applies to the OUTPUT. `FileTooLargeError` → the shared `imageOverCapReason` line.
4. `options.heic(bytes, { maxEdge: min(options.maxEdge, HEIC_FILE_MAX_EDGE), maxBytes: min(options.maxImageBytes, MAX_IMAGE_BYTES) })`. A refusal → `<name>: <reason>`, `isError`, nothing stored.
5. `keepImageFile(store, jpeg, { width, height, mimeType: "image/jpeg" }, name)`. The label stays the original name. A store refusal is unchanged (`not kept: …`).
6. The marker (D2) plus `VIEW_HINT`, with 0 refs. This is the PNG/JPEG result shape.

`createFsReadTool` (`builtins.ts:200-223`) passes `heic` through. Its description sentence becomes «A PNG, JPEG or HEIC file (read by its bytes; HEIC is converted to JPEG where macOS's decoder exists) is kept the same way…».

**D5 — Wiring (`packages/cli/src/wiring.ts:1447-1451`).** Add `heic: defaultHeicConverter()` to `createFsReadTool`. It runs in the daemon (worker or `serve`), so the decoder is the daemon host's.

**D6 — TUI attach (`packages/tui/src/attach-files.ts`, `attach-refusal.ts`).**
- `FileProbe` gains `convertHeic?: HeicConverter`. The probe is already «the one edge that touches the host», so no new plumbing: `App.tsx`/`useAttachments.ts` pass the probe as they do today. `nodeFileProbe()` sets `convertHeic: defaultHeicConverter()`.
- In `inspectPath`, the `heic` branch (`:169-172`) becomes:
  1. over `MAX_IMAGE_BYTES` → `too-large`;
  2. no `convertHeic` → `{ reason: "heic", path, why: "HEIC/HEIF pictures are converted by macOS's own decoder, and this computer has none — export it as JPEG first" }`;
  3. otherwise `convertHeic(bytes, { maxEdge: HEIC_ATTACH_MAX_EDGE, maxBytes: MAX_IMAGE_BYTES })`. A refusal → `{ reason: "heic", path, why }`. Success → an `AttachedImage` whose `bytes` and `ref` (`id` = sha256 of the JPEG, `mimeType` from re-sniffing the JPEG, `name` = `heicJpegName(refName(path))`) all describe the JPEG. The «one buffer» invariant (`:18-20`) then holds for what is SENT.
- `AttachRefusal`'s `heic` variant gains `why: string`. `refusalText` → `cannot attach <path>: <why>`. `refusalMeansText` is unchanged (`heic` → false: a real image).

**D7 — What happens where (the TODO's «say exactly»).**

| Host | `fs_read` of a HEIC | Attach a HEIC |
|---|---|---|
| Mac worker (TUI) | converted (≤ 4032 px, ≤ 1568 on OpenAI-compatible) → JPEG in the store; `image_view` `low`/`region` work | TUI converts (≤ 2048 px) → JPEG ref |
| `serve` on macOS, phone or `connect` | same as the worker, on the serve host | phone: converts on the device (unchanged); a Mac `connect` TUI: converts on the laptop |
| `serve` on Linux | refused: «… this host (linux) has none — convert it to JPEG first» | phone: unchanged (works); a Mac `connect` TUI converts on the laptop (works); a Linux TUI: refused with the D6 sentence |
| Pod (`run`/`attach`) | no store → today's text path, unchanged (F8 of image-files) | the laptop TUI converts (Mac) → JPEG ref (works), the same as a JPEG attach today |
| Sub-agent, `images:false`, no vision | unchanged (no image branch) | n/a |

**D8 — No protocol, daemon, store, provider, `image_view` or phone change.** There is no `protocol.d/` note. Clients still refuse `image/heic` refs (`client/test/attach-image.test.ts:195`), and so does the daemon (`daemon/test/attachment-prompt.test.ts:343`). Conversion happens before the wire.

#### Orchestrator decisions

*— claude-opus-5-5 (orchestrator, owner-delegated 26/11), recommended option taken each time*

- **H1 Decoder: macOS's own (`/usr/bin/sips`, ImageIO) in a child process; no bundled codec.** It has zero dependencies, zero licence and zero patent exposure (the OS vendor licenses HEVC). It runs in 127–177 ms for 12 MP. libheif/libde265 is LGPL-3.0 inside a single compiled binary, plus HEVC pool exposure: rejected, as the TODO allowed. `Bun.Image` does decode HEIC on macOS, but in-process native code on untrusted bytes is J1's rejection (`image-region-jpeg.md:134-135`).
- **H2 Convert once at the entry point, to JPEG.** This is the phone's rule. Everything downstream (store, dedupe, caps, providers, `image_view` `low`/`region`) is the already-reviewed JPEG path. Decoding is measured deterministic, so the same HEIC gives the same id and dedupe holds.
- **H3 Confine `sips` with `sandbox-exec`: no network, no reads under `/Users` and `/Volumes`, writes only in the user temp dir. Fail closed if `sandbox-exec` is missing.** ImageIO is a recurring zero-click target, and a model can make the daemon decode any workspace file without a prompt. The confinement costs ≈ 30 ms. `sandbox-exec` is deprecated but present and working on macOS 27 (probe4). If Apple removes it, HEIC is refused with a sentence and a follow-up re-plans; we never silently run unconfined.
- **H4 Sizes.**
  - `fs_read` keeps ≤ 4032 px (and ≤ the model's `imageFileMaxEdge`). That fits the 128 MiB JPEG decode budget, so `low`/`region` work even on a 48 MP HEIC, and a 12 MP photo keeps its full resolution for zooming.
  - The attach keeps ≤ 2048 px at q80, the phone's numbers, for phone/Mac parity.
  - Over the byte cap: ×0.75 up to 3 times (3a's rule), then the shared cap sentence.
- **H5 Linux: refuse with a sentence that names the host; no Linux decoder in this task.** The TODO's own fallback. Using a user-installed `heif-convert`/`ffmpeg` is a follow-up (Notes).
- **H6 Orientation is kept as `sips` writes it:** stored pixels + EXIF Orientation, as for `sips`'s own HEIC (probe2: displayed 48×64 on both sides). `image_view` applies EXIF (3b J5). A real iPhone portrait HEIC is **unverified**: see Notes for the one check.
- **H7 Bounds on the child: 20 s timeout (SIGKILL), at most 2 at once, input ≤ 15 MiB, ≤ 64 MP from the size query, 64 KiB stdio bounds.** A decode bomb then costs one bounded child process, never the daemon.
- **H8 Fixtures: two 64×48 HEICs (2 175 B each) encoded by Apple's encoder from our CC0 JPEG fixtures.** They are installed by `bun /Users/gmeghnag/tentacle/.tentacle/tmp/image-heic/install-fixtures.ts <worktree root>` (sha256-checked, refuses an existing folder; dry run verified: `2 fixtures verified`). They are not made by our code. The 12 MP `photo.heic` stays in scratch, for the bench only.

### Files

Dependency order. There is no protocol, daemon, client, provider or phone file.

0. Fixtures: `packages/core/test/fixtures/heic/` (H8 script).
1. `packages/core/src/heic.ts` (new, D1); `packages/core/src/image-file.ts` (D2: the marker `format: string`); `packages/core/src/index.ts` (exports).
2. `packages/tools/src/heic-convert.ts` (new, D3); `packages/tools/src/image-file.ts` (D4); `packages/tools/src/builtins.ts` (D4: option + description); `packages/tools/src/index.ts` (export `defaultHeicConverter`, `createSipsHeicConverter`).
3. `packages/cli/src/wiring.ts` (D5).
4. `packages/tui/src/attach-files.ts`, `packages/tui/src/attach-refusal.ts` (D6).
5. `changelog.d/image-heic.added.md` (the text in the header).

### Failure modes

| # | Mode | Convergence |
|---|---|---|
| F1 | No decoder (Linux, a non-Mac TUI, `sandbox-exec` missing) | A sentence naming the host. Nothing read past the head; nothing stored |
| F2 | HEIC over 15 MiB | Refused before the body is read (`FileTooLargeError` / `too-large`) |
| F3 | Size query `<nil>`, 0 or garbage (probe2) | «the HEIC is corrupt (no readable size)». `toJpeg` never runs |
| F4 | Declared > 64 MP (bomb) | Refused from the size query; no decode |
| F5 | `sips` exit ≠ 0 | «could not be decoded (<stderr line>)» |
| F6 | **`sips` exit 0 with a broken JPEG** (measured: truncated input) | `checkHeicOutput` refuses: strict checks + long-edge match. Nothing stored |
| F7 | Output long edge ≠ planned (a lying `ispe`, an upscale) | Same refusal as F6 |
| F8 | Output over the model's cap | ×0.75 up to 3 steps, then the shared `imageOverCapReason` sentence |
| F9 | Hang | SIGKILL at 20 s → refusal; directory removed |
| F10 | Any throw mid-convert | `finally` removes the temp directory. A daemon crash mid-convert leaves one `tentacle-heic-*` in the user temp dir (the OS purges it) |
| F11 | Many HEICs at once (a batch of reads, a multi-file paste) | The gate runs 2 at a time; the rest queue; each result is independent |
| F12 | Child writes to stdout/stderr while Ink renders | Piped and bounded, never inherited; nothing reaches the terminal |
| F13 | File swapped or symlinked between sniff and convert | `sips` reads only OUR copy of the bytes we read. The type and size come from that copy and its output |
| F14 | Same HEIC twice | Deterministic decode → same JPEG id → `putTool` dedupe / TUI `duplicate` |
| F15 | Store full | Unchanged `not kept: …` (refusal without eviction) |
| F16 | EXIF Orientation 2–8 | Kept in the JPEG; `image_view` applies it (J5); the region result names it |
| F17 | GPS/EXIF metadata | Kept, as for a JPEG file read or attached today (not a regression; Notes) |
| F18 | Pod-originated request | Impossible: pods have no store (`session-host.ts:1733`), and the laptop TUI converts only what the user attached |
| F19 | Version skew | No wire change. An old TUI still refuses HEIC; an old daemon never sees `image/heic` |
| F20 | A HEIF that is not HEVC (AVC/JPEG-coded `mif1`) | ImageIO decodes what it can; else F5/F6 |

### Tests

Red first (§9): each test is shown failing before its code. Paste the red lines into Execution. Fakes come before real I/O. The ONE live test does not skip anywhere.

- **T1 `core/test/heic.test.ts` (pure).**
  - `heicTarget`: 64×48 at 4032 gives edge 64, no downscale (**no upscale**). 8064×6048 at 4032 gives 4032 with downscale. 4032×3024 at 1568 gives 1568. 8001×8000 gives the 64 MP refusal. `undefined` and 0×10 give the no-size refusal.
  - `checkHeicOutput`:
    - `small-baseline.jpg` (a real fixture) at edge 64 is ok;
    - the same at edge 63 is refused (mismatch);
    - the fixture cut before its SOF is refused, and so is the fixture cut before EOI (crafted refusal cases);
    - a PNG fixture is refused.
  - `convertHeicWith` with fake ops:
    - the happy path calls `toJpeg(undefined)` when no downscale is needed;
    - an over-cap output steps 4032 → 3024 → 2268 → 1701, then refuses with the cap sentence (exactly 4 `toJpeg` calls);
    - a refused `size` never calls `toJpeg`;
    - a broken output is refused.
  - `heicJpegName` (`.HEIC`, `.heif`, no extension); `heicFormatLabel`.
- **T2 `tools/test/heic-convert.test.ts`, fake `spawn`/`exists`.**
  - `platform: "linux"` → `undefined`. Darwin without `sandbox-exec` → `undefined`.
  - The argv starts `["/usr/bin/sandbox-exec", "-p", <profile>, "/usr/bin/sips", …]`. The profile contains `(deny network*)`, the `/Users` read deny, the realpath'd `tmpRoot` write allowance, the fork deny and the exec deny (all but `sips`). `-Z` is present only on a downscale.
  - Spawn options: `env` is `{}`, and stdin/stdout/stderr are never `"inherit"`.
  - A child that never exits is killed at a small injected timeout → refusal.
  - The temp directory is gone after success, after a refusal and after a thrown spawn (`tmpRoot` is a test dir).
  - `parseSipsSize` on the verbatim probe2 outputs (`4032`/`3024`; `<nil>`).
  - The gate: 3 concurrent calls → at most 2 children alive at once.
- **T3 `tools/test/heic-convert.live.test.ts` (real OS, no skip).**
  - On darwin: `defaultHeicConverter()` converts `fixtures/heic/small-orient-6.heic` to a JPEG with `readJpegHeader` 64×48, orientation 6, sniffing as `image/jpeg`. Two runs give the same sha256. A copy cut at 50 % is refused (F6, real `sips`).
  - On darwin, enforced by the OS: under the shipped profile `/usr/bin/true` does not run; with `/bin/bash` in `sips`'s place in the exec rule, the shell runs but cannot fork a subshell.
  - Elsewhere: `defaultHeicConverter()` is `undefined`.
  - Both branches assert, so neither is vacuous.
- **T4 `tools/test/fs-read-image.test.ts` additions** (fake converter + spy store):
  - a HEIC calls `putTool` once with `image/jpeg` and the converter's bytes, and the marker contains `HEIC→JPEG`;
  - the converter receives `maxEdge = min(maxEdge, 4032)` (8000 → 4032, 1568 → 1568) and the model's `maxBytes`;
  - no converter → the host sentence, with no full read;
  - a converter refusal → `<name>: <reason>`, `isError`, no `putTool`;
  - a range → refused; over 15 MiB → refused before the full read.
  - Every existing PNG/JPEG/GIF row stays green, unchanged.
  - **Red today:** the HEIC rows get the «not readable yet» sentence.
- **T5 `tools/test/image-view-region.test.ts` addition (the load-bearing chain).** `fs_read` of `small-orient-6.heic` through a converter fake that returns the real `small-orient-6.jpg` fixture, with a memory `AttachmentStore`. Then `image_view` `region` (top-right quarter) → an `image/jpeg` crop, `EXIF orientation 6 applied`, `of 48×64`.
- **T6 `cli` wiring test** (the existing `image-view-wiring` file): with vision, `fs_read`'s HEIC branch reaches a converter. Inject through the default's seam, or assert that `createFsReadTool` received `heic` (whichever the file's pattern allows). **Mutation:** drop `heic:` from wiring → red.
- **T7 `tui/test/attach-files.test.ts`** (fake probe):
  - with `convertHeic`, `IMG_0001.HEIC` → an image with `mimeType: "image/jpeg"`, `id` = sha256 of the converted bytes, `name: "IMG_0001.jpg"`, `bytes` = the converted bytes, and the converter is called with `maxEdge: 2048`;
  - without `convertHeic` → a `heic` refusal with the «this computer has none» sentence;
  - a converter refusal → its `why`.
  - The existing HEIC tests (`:165-170`, `:552-580`, `attach-app.test.tsx:220-230`, `attach-draft.test.ts:72-80`) keep their probes without a converter, so they still refuse. Update only the sentence they pin. The mixed paste still attaches the PNG and names the HEIC.
- **Mutations (§9; record each in Execution, then revert):**
  - skip `checkHeicOutput` → T1 broken-output and T3 50 %-cut go red;
  - always pass `-Z` → T1 no-upscale / T2 argv;
  - `stdout: "inherit"` → T2;
  - drop `sandbox-exec` from the argv → T2;
  - no `rm` in `finally` → T2;
  - input bound = the model cap instead of 15 MiB → T4;
  - attach ref id from the HEIC bytes → T7.

Gate: the touched test files while iterating; `bun run check` before Review.

Extra validation, pasted into Execution:
- the 12 MP bench through the real `fs_read` → `image_view` path (`photo.heic`): wall time of the conversion, the marker, then `low` and the centre-half `region` result lines;
- a TUI attach of `photo.heic` through `nodeFileProbe()` (size, name, mime).

### Notes / debt

- **Real iPhone HEIC orientation (H6) is unverified.** Our fixtures come from `sips`'s own encoder, which writes `irot` + EXIF. A real portrait iPhone HEIC may differ. One check, at the owner's live test: `fs_read` a portrait iPhone HEIC on the Mac, then `image_view` the top half. It must be the top of the photo as shown in Photos.
- **Linux decoder.** A user-installed `heif-convert` (libheif) or `ffmpeg` on a Linux `serve` could back the same `HeicConverter`, licensed to the user, not to us. Confinement there would need bubblewrap/seccomp, so it is a separate task.
- **Metadata.** The converted JPEG keeps `sips`'s EXIF (GPS included), as a JPEG file or attach does today. Stripping location before a provider sees it is a cross-format privacy choice for every image path, not only HEIC.
- `sandbox-exec` is deprecated by Apple. H3 fails closed; if it disappears, re-plan with an XPC/App Sandbox helper.
- **What the sandbox does not confine (follow-up: a deny-default profile).** The profile is `(allow default)` with named denials. A decoder taken over by its input cannot fork or exec, but `mach-lookup` and XPC stay allowed: it can still message system services (launchd, LaunchServices), and one that starts work on request would run it outside the sandbox. Whether any does for such a caller is untested. Reads outside `/Users` and `/Volumes` and writes anywhere in the user temp dir are also allowed.
- The marker still says `high only` (true of what is stored; `low` is made on demand, 3b's note).

## Execution

*— claude-sonnet-5-5, 2026-11-27*

**Reproduced** on the branch before any edit (`repro.ts`): same two refusals as in Context.

**Step 0 (load-bearing) — PASSED** (`.tentacle/tmp/image-heic/step0.ts`: D3 argv, real `AttachmentStore`, `createImageViewTool`):

```
sips -g -> 0 45 ms   pixelWidth: 4032  pixelHeight: 3024
sips -s -> 0 155 ms  inspect ok image/jpeg 4032×3024, 2390866 B; strict header not refused
247 ms isError=false mime=image/jpeg bytes=88769  photo.heic · 768×576 · low · 87 KB
226 ms isError=false mime=image/jpeg bytes=83385  photo.heic · region 1008,756 2016×1512 of 4032×3024 · sent 768×576 · low · 81 KB
```

**As built, in order:** fixtures (H8 script, `2 fixtures verified`) → `core/src/heic.ts` + marker `format: string` → `tools/src/heic-convert.ts` → `fs_read` branch + option + description → `wiring.ts` → TUI `attach-files.ts` / `attach-refusal.ts` → changelog fragment.

**Red first** (new modules against wrong-answer stubs, so red on assertions):

| Test | Red |
|---|---|
| T1 core | 15 listed `(fail)` on `toEqual`/`toMatchObject` |
| T2+T3 converter | 2 pass / 14 fail |
| TMPDIR (live) | `refused: the HEIC could not be decoded (Error: Cannot write to file …/T/A73E…)` |
| T4 `fs_read` | 13 pass / 7 fail («not readable as images yet») |
| T5 chain | written after D4; red shown by mutation («no HEIC branch») |
| T6 wiring | 9 pass / 1 fail («this host (darwin) has none») |
| T7 attach | 56 pass / 4 fail |

**Drift from Implementation**
1. **Writable dir (D3, trap 3; plan corrected above).** `realpath(os.tmpdir())` broke every conversion when the process had another `TMPDIR`. Now `getconf DARWIN_USER_TEMP_DIR` (`env: {}`), resolved. Re-checked with `TMPDIR` under the temp dir and under `/Users`: both convert.
2. `convertHeicWith` takes no `bytes`; `ops.size()` may return a refusal (so a size-query timeout or exit ≠ 0 is not reported as «corrupt»). Any throw in the converter is a refusal («could not be converted (…)»), never a rejection.
3. Hardening beyond D3: the output is opened `O_NOFOLLOW` and must be a regular file (the child could leave a symlink for the unconfined parent to follow); control characters are stripped from the quoted stderr line.
4. `sipsSandboxProfile` is exported and tested directly: Bun 1.4.3 `realpath` returns ENOENT for a name containing a backslash (such a temp dir fails closed).
5. The changelog fragment says «Linux terminal», not the header's «a pod»: by D7 a pod session keeps the text path and the laptop converts an attach.
6. Existing tests changed: the `inspectPath` HEIC test in `attach-files.test.ts` (new sentence) and `attach-draft.test.ts` (`why`). The paste and App tests are unchanged.

**Mutations** (`.tentacle/tmp/image-heic/mutate.ts`: apply, run, restore):

| Mutation | Result (failing) |
|---|---|
| skip `checkHeicOutput` | 15 pass / 6 fail, incl. T3 50 %-cut and T1 |
| always pass `-Z` | 28/4 (T1, T2 argv) |
| upscale (`edge = maxEdge`) | 16/2 |
| `stdout: "inherit"` | 13/1 (T2) |
| no `sandbox-exec` in argv | 13/1 (T2) |
| no `rm` in `finally` | 12/2 |
| follow an output symlink | 13/1 |
| gate of 3 | 13/1 |
| no SIGKILL | 12/2 |
| writable dir follows `TMPDIR` | 2/1 (T3) |
| input bound = model cap | 19/1 (T4) |
| no HEIC branch | 61/1 (T5) |
| wiring drops `heic:` | 9/1 (T6) |
| attach ref id from HEIC bytes | 59/1 (T7) |

**12 MP bench** (`bench.ts`, real `fs_read` → `image_view`, real attach):

```
anthropic: convert 206 ms · fs_read 210 ms
[image photo.heic · 4032×3024 · HEIC→JPEG · 2.3 MB · ref 79949e605971 · high only]
  image_view 252 ms: photo.heic · 768×576 · low · 87 KB
  image_view 226 ms: photo.heic · region 1008,756 2016×1512 of 4032×3024 · sent 768×576 · low · 81 KB
openai-compatible: convert 286 ms
[image photo.heic · 1568×1176 · HEIC 4032×3024→JPEG · 505 KB · ref 8526291a3527 · high only]
  image_view 58 ms: low 768×576 · 54 ms: region 392,294 784×588 of 1568×1176
attach 305 ms: {"mimeType":"image/jpeg","size":821832,"name":"photo.jpg"}
leftover temp dirs: 0
```

Exact long edge also checked for 4032, 3024, 2268, 2048, 1701 and 1568. (`repro.ts` now shows attach `ok=true`; its `fs_read` line says «darwin has none» only because it passes no converter.)

**Checks:** 408 pass / 0 fail over the 16 covering test files; `biome check` on the changed paths clean; a `tsc` limited to the touched test files and their imports reports errors only in two untouched files (`agent/src/harness/a2a-map.ts`, `tui/src/markdown.ts`; likely the narrowed config). Full gate: not run (orchestrator's). No schema change.

**Gate fix (claude-sonnet-5-5, 2026-11-27): flaky `worker-exit-net` `&` child.** Test fixture only. Its `amp` wait (one `pgrep -f "sleep M"` match) was also true for `sh` itself before its fork. Repro (`.tentacle/tmp/image-heic/stress.ts`: the real fixture, 64 at once): the deciding poll matched only `/bin/sh -c sleep …` in 261/640 instrumented runs, and in one of them the `sleep` (ppid 1, `sh`'s pgid) survived the exit. The fixture now counts only once the `sleep` itself runs; after the fix 896 runs, 0 bad.

**For Review (not changed, outside the Implementation)**
- Exit net (`exec/src/process-group.ts`, pre-existing): from the repro above, a group SIGKILL sent while `sh` is forking can leave the child alive. Not reproduced outside the real fixture (3600 shell-only rounds: 0 leaks).
- Submit does not wait for an attach in progress (`useAttachments.ts` chains attaches only). Enter during a conversion (≈ 300 ms, worst case far longer) sends without the picture and the chip appears afterwards. The shape predates this task; HEIC widens the window. Read from code, not reproduced.
- A turn cancel does not stop a running conversion (no signal in `HeicConverter`); each child is bounded at 20 s, so one conversion at worst ≈ 100 s (size + 4 decodes).
- An output over 15 MiB is refused without the ×0.75 steps (D3's stat bound).
- Unverified: Linux (only through the injected `platform`), a real iPhone portrait HEIC (Notes). No automated test checks that the OS enforces the denials; run once by hand with the shipped `sipsSandboxProfile` (`deny.ts`): control `exit 0, output exists`; read under `/Users` `exit 0, no output`; write outside the temp dir `exit 13, no output`.

### Fix round 1

*— claude-sonnet-5-5, 2026-11-27*

**Finding 1 (MEDIUM): fixed as the Review proposed.** `sipsSandboxProfile` adds `(deny process-fork)` and `(deny process-exec* (require-not (literal "/usr/bin/sips")))`. The module comment, D3, T2, T3 and Notes (what remains) are updated.

- **Red** (tests first, old profile): 16 pass / 3 fail: T2 `Expected to contain: "(deny process-fork)"`; T3 «can start no other program» (`/usr/bin/true` exit 0); T3 «cannot fork» (the subshell printed).
- **Green:** the two converter files 19/0, real conversions included; with `fs-read-image`, `image-view-region`, `attach-files` and `image-view-wiring`: 171 pass / 0 fail. `biome check` on the 3 changed files clean.
- **12 MP** (`rv/e2e.ts`, new profile): `fs_read` 196 ms `4032×3024 · HEIC→JPEG · 2.3 MB`; edge 1568 → `1568×1176`; attach `photo.jpg image/jpeg 821832`; a 4000 B cut refused.

| Mutation (applied, run, reverted) | Result |
|---|---|
| no `(deny process-fork)` | 17/2: T2, T3 «cannot fork» |
| no exec deny | 17/2: T2, T3 «no other program» |
| every exec denied (no `require-not`) | 15/4: T2, two real conversions, «cannot fork» control |

**Not verified:** the escape itself. `rv/escape.sh` (`launchctl submit`) needed an approval this non-interactive run did not get, so neither the escape under the old profile nor its closing was observed; the tests prove only that the OS denies exec and fork. To verify: run `sh rv/escape.sh` with the two new denials added to its `P`; expected: no `escaped` file.

**Gate:** full gate not run (the orchestrator's script).

## Review

*— claude-opus-5-5, 2026-11-27 (fresh context; SAME model family as the planner — shared blind spots possible)*

**Verdict: REQUEST-CHANGES** (one MEDIUM, security claim of H3/D3).

**Gate (touched scope):** 8 touched test files 236 pass / 0 fail; `bun run lint` clean (2760 files); `bun run typecheck` clean. Full `bun run test` not re-run in this pass.

**Findings**
1. **MEDIUM — the `sips` sandbox does not confine a compromised decoder** (`packages/tools/src/heic-convert.ts:76-78`, `sipsSandboxProfile`). The profile is `(allow default)` plus three denies, so `process-fork`, `process-exec*` and `mach-lookup` stay allowed. Failure scenario: a malicious workspace `.heic` (the model can `fs_read` any file without a prompt, H3's own threat) exploits ImageIO; the payload writes a script into the writable user temp dir and runs `/bin/launchctl submit -- <script>` (or `open x.command`). launchd/LaunchServices start it OUTSIDE the sandbox, with full `/Users` read and network access. H3 says "confined" and the doc says "crash- and memory-isolated", but this setup only stops file and network access by the `sips` process itself. **Unverified here:** the probe `.tentacle/tmp/image-heic/rv/escape.sh` (harmless `touch` through `launchctl submit` under the shipped profile, then `launchctl remove`) needed an approval this non-interactive run could not get. Run it once. Fix: add `(deny process-fork)(deny process-exec* (require-not (literal "/usr/bin/sips")))`, check that `sips` still converts, and pin it in T2's profile assertion. In Notes, state what remains (direct mach/XPC to launchd needs a deny-default profile; that is a follow-up).

**Mutations (all red, reverted, `git status` clean):** skip `checkHeicOutput` → 5 fail (T1 + live 50 % cut); drop `sandbox-exec` from argv + drop `rm` in `finally` → 3 fail (T2); attach ref from HEIC bytes → T7 red; `heic: undefined` in wiring → T6 red.

**Attacks tried**
- The child swaps `work/` for a symlink to a user directory, then the `finally` `rm -r` runs: Bun `rm(symlink,{recursive})` unlinks the link and does not follow it (`rv/rmsym.ts`). Holds.
- End-to-end with real `sips` on the 12 MP `photo.heic` (`rv/e2e.ts`):
  - edge 8000 gives `4032×3024 · HEIC→JPEG · 2.3 MB`, `putTool image/jpeg`, 200 ms;
  - edge 1568 gives `1568×1176 · HEIC 4032×3024→JPEG`;
  - an attach gives `photo.jpg image/jpeg`;
  - a 4000 B cut is refused with the "not whole" sentence.

  Holds.
- §7 pod trust: a pod has no store, so there is no conversion (unchanged D7). §7 Ink: every child pipe is `pipe`/`ignore`, never `inherit` (`heic-convert.ts:101-106,135-141`). Holds.
- Premises spot-checked TRUE: `readBytes` takes `maxBytes` (`core/src/execution.ts:49`); attach conversions run one after another (`attach-files.ts:333-334`).

**Scope note:** `packages/cli/test/fixtures/worker-exit-net.ts` (an exit-net flake fix) is outside this task. It is harmless, but it belongs to its own fix.

**Executor behaviour:** a faithful plan-to-code mapping, strong fakes, honest Execution notes on what is unverified. The only weakness is the over-claimed confinement above.
