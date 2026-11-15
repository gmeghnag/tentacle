# feat/model-artifacts — the model presents artifacts (images, HTML, PDF, Markdown, files) on the iPhone and the Mac

> **Status:** implementation — **Implementation APPROVED by owner delegation (2026-11-16)**: the owner approved building it and delegated the decisions to the orchestrator for tonight; every decision is under *Owner questions* → *Orchestrator decisions*, and the owner reviews in the morning (mockups: `.tentacle/tmp/model-artifacts/mockups/index.html`).
> **Branch:** `feat/model-artifacts`
> **Size:** L (split into 11 slices, each S or M) · **Blast:** load-bearing (a new model tool, the agent's `ToolContext`, two RPC methods, a new on-disk record beside the `serve` log, an isolated WebView on the phone) · **Suited:** `opus` for the load-bearing / security slices, `deepseek` for the contained / cross-module ones (per slice, below); mandatory fresh-context Review of the whole branch.
> **Changelog:** `changelog.d/model-artifacts.added.md` (written by S9).

## Context

*— claude-opus-5-5, 2026-11-16*

**The ask (owner, 2026-11-16):** "the model can PRESENT me artifacts — images,
HTML pages I open in the app, or other — on the mobile app", with Mac/iPhone
parity (owner rule: a phone session has the Mac session's capabilities).
Approved; decisions delegated to the orchestrator for tonight.

**What exists today (evidence, `main` @ c90f0729):**

- The model has no way to show the user anything but text. Its built-in tools are
  `fs_read`/`fs_write`/`fs_edit`/`fs_multi_edit`/`shell*`
  (`packages/tools/src/builtins.ts:320-328`); a result reaches a client as text
  plus at most a diff or hook resource (`packages/daemon/src/mapping.ts:209-231`).
- Bytes travel only **client → daemon**: `attachment/put` is upload-only, by
  design ("no `attachment/get` / `status` method … nothing reads bytes back over
  the wire", `docs/feat/attachments-upload.md` D1;
  `packages/protocol/src/attachment-upload.ts:1-21`). The phone's thumbnail
  driver waits for exactly such a read: "The transport does not exist yet … So the
  port stays unimplemented until a task adds one — an additive new method"
  (`apps/mobile/src/thumbnails.ts:20-28`).
- `ExecutionEnvironment.readFile` returns a **string** (`packages/core/src/execution.ts:46`;
  `HostExecution.readFile` = `Bun.file(abs).text()`, "Reads are unconfined (by
  design)", `packages/exec/src/host-execution.ts:359-373`) — so no tool can read
  a PNG or a PDF today.
- The app has no WebView, PDF or share module: `apps/mobile/package.json:6-36`
  lists none; `react-native-webview` appears in `bun.lock` only as an *optional
  peer* of `expo` (not installed: absent from `apps/mobile/node_modules` and the
  root `node_modules`). It has `marked` + `screens/transcript/Markdown.tsx`
  (Markdown, native), `expo-file-system` (cache files) and RN core `Share`.
- The floating button the owner wants to turn into the hub
  (`docs/feat/mobile-chrome.md` Design 6, S10: `floating-button.ts`,
  `ui/FloatingActivity.tsx`) is **not on `main` yet** (neither file exists under
  `apps/mobile/src`; only the S1 tokens of mobile-chrome are merged). The hub is
  a separate task (`feat/mobile-hub`) after this one.

**Repro** (that the capability is missing; run 2026-11-16 in the worktree, `main` @ c90f0729):

```
$ rg -n '"present"|artifact/' packages apps --glob '!**/node_modules/**' | wc -l
0
$ rg -n 'readBytes|arrayBuffer\(\)|\.bytes\(\)' packages/core/src/execution.ts packages/exec/src/host-execution.ts | wc -l
0
$ ls apps/mobile/node_modules | rg -c 'webview'
0   (exit 1: no match)
```

No tool, no read-back method, no binary read, no viewer. The executor re-runs
these three on `main` before S1 (all must still print 0).

**Constraints that shape the design:** AGENTS §7 — one session path over RPC
(`createLocalRuntime`); logic in pure modules; persistence split (serve persists
its own; the laptop persists worker/pod logs; pod daemons and the worker never
persist; nothing from a pod is kept lasting on the laptop); a pod is not trusted;
protocol fields/methods are free, update classes and critical log entries are
not; never write raw to the terminal while Ink owns it; don't serialize the RPC
peer.

## Implementation

*— claude-opus-5-5, 2026-11-16*

### Load-bearing assumption

**A bounded, chunked read of a session-scoped, content-addressed blob over the
existing session connection works end-to-end on every runtime — including the
phone over the E2E relay — with no new transport and no `PROTOCOL_VERSION` bump.**
It is the mirror of `attachment/put`, which already proves every leg:

1. A new method is additive: unknown → `MethodNotFound` (AGENTS §7 "Fields and
   methods are free"; `docs/feat/attachments-upload.md` D1 "Version: no bump").
2. A 256 KiB-raw chunk (≈ 349 528 base64 chars, `attachment-upload.ts:24-27`)
   already rides the relay in the other direction: the Noise channel splits an RPC
   frame into ≤ 64 KiB messages (`packages/transport/src/noise-frame.ts:1-17`,
   `MAX_NOISE_MESSAGE = 65_535` at `noise.ts:18`), so the relay's 96 Ki-char
   per-frame cap (`packages/protocol/src/relay.ts:77-99`) never sees an RPC frame
   whole.
3. The daemon dispatches each request without a lock
   (`packages/daemon/src/connection.ts:440-447`, `transport/peer.ts` "void
   handleRequest"), so a 20 MiB read interleaves with `session/prompt`,
   `enqueue` and permission answers instead of blocking them.
4. The phone drives the SAME `RemoteClient` (`apps/mobile/src/connection.ts:3-10`,
   `compose-handle.ts:15-21`), so one `RemoteClient.readArtifact` serves the TUI
   and the app.

**First step of S3 (proves it before anything else):** a repro in
`.tentacle/tmp/model-artifacts/read-roundtrip.ts` — a real `SessionHost` +
`Connection` + `RpcPeer` over a `createChannelPair` wrapped in the Noise channel
pair, a 3 MiB blob put into the store, read back in 12 chunks of 256 KiB with a
`session/enqueue` issued between chunk 3 and 4: assert bytes equal (sha256), the
enqueue answered before the last chunk, no frame > 8 MiB. If it fails, STOP and
report (AGENTS §0).

### Preconditions

Verified against the source (`main` @ c90f0729):

- **P1 — the per-session store seam exists.** `SessionHost.build` creates the
  session's `AttachmentStore` BEFORE the agent and hands it to `createAgent`
  (`packages/daemon/src/session-host.ts:1340-1366`); `serve` gets it disk-backed
  via `persister?.blobs(id)` (`:1349`, `session-persister.ts:496-506`), every
  other host memory-only. The artifact store copies this exactly.
- **P2 — the tool context is built in one place.** `Agent` builds `ToolContext`
  from its config (`packages/agent/src/agent.ts:1171-1177`: `sessionId`, `env`,
  optional `jobs`, `history`); `ToolContext` has optional per-session seams
  (`packages/core/src/tool.ts:118-153`). A new optional `artifacts` member is the
  same shape as `jobs`.
- **P3 — tools are registered per session build**, optional ones conditionally
  (`packages/cli/src/wiring.ts:456,666-676`: `context_reset`, `move_session`).
  Sub-agents get a FILTERED copy of the parent registry
  (`packages/tools/src/subagent-tools.ts:5-9`, `agent/src/subagent.ts:339-362`)
  and their own `ToolContext` — which will carry no `artifacts` sink.
- **P4 — a structured tool detail already reaches every client.**
  `ToolResult.details` (`core/src/tool.ts:22-29`, a union, today `kind:"diff"`)
  → daemon `toolResultContent` (`daemon/src/mapping.ts:209-231`) → client
  `toolResultFromContent` (`client/src/mapping.ts:197-226`) → TUI `ToolItem.detail`
  (`tui/src/state.ts:111-129,453`) rendered at `render-lines.ts:461-462`. An
  older client drops what it does not know and shows the text.
- **P5 — `ToolCallUpdateSchema` is a strip object** (`protocol/src/updates.ts:55-67`,
  module comment `:1-8`): a new optional field is dropped by an older client, no
  update class involved (`UPDATE_CLASS`, `:471-516`, classifies *types*, not
  fields).
- **P6 — the confinement primitives exist.** `HostExecution` resolves real paths
  (`realTarget`, `within`) and confines writes to `root`
  (`exec/src/host-execution.ts:655-686`); `root` = the session's cwd
  (`cli/src/wiring.ts:442-446`). Reads are unconfined today (`:359-360`).
- **P7 — `serve` blob storage pattern.** `SessionBlobs` (`daemon/src/session-blobs.ts:22-79`)
  stores `<uid>.attachments/<sha256>` beside the log; `LogSessionStore` routes
  `putBlob` through the session's queue + lock (`session-log-store.ts:388-403`),
  links blobs into a `/clear` fork after the fork's log lands (`:618`), removes
  them on delete AFTER the log (`:535,921`). Archive keeps them (dispose frees
  memory only, `docs/feat/attachments-durable.md` D2).
- **P8 — connection-scoped lookup.** `this.lookup(sessionId)` resolves only a
  session open on THIS connection (`daemon/src/connection.ts:387-447`), so a read
  cannot reach another session's blobs.
- **P9 — the TUI has a panel registry** where "a new panel is a file plus one
  registry line" (`tui/src/panels/registry.ts:1-20`, `panels/types.ts:17-37`) and
  a chord machine (`tui/src/chord.ts:1-20`, `Ctrl+X Ctrl+S`). `Ctrl+O` is taken
  (expand toggle, `tui/src/idle-warm.ts:2`).
- **P10 — the phone builds history rows from `ChatMessage[]` only**
  (`apps/mobile/src/transcript-history.ts:1-12,44-50`), and the TUI likewise
  (`tui/src/resume.ts:36`): a card on a *reloaded* transcript needs metadata from
  somewhere other than the message — hence `artifact/list` (D4).
- **P11 — the phone's Session info is a pure view-model with per-section pulls**
  (`apps/mobile/src/session-info.ts:1-15,36-45,551`); a section that an older
  daemon cannot serve shows `unsupported` (`:38-45`).
- **P12 — the critical-entry rule.** Adding a critical session-log type needs the
  owner AND a version bump (`protocol/src/session-log.ts:12-22`). **This design
  adds no session-log entry type at all** (D5), so nothing waits on the owner.

### Design

**D0 — vocabulary.** An *artifact* is a named thing the model shows the user. It
has a stable `artifactId` (a slug) and one or more immutable *versions*; each
version is a SNAPSHOT of bytes taken at present time, content-addressed by
sha256. Re-presenting the same `artifactId` = a new version; older versions stay
viewable (owner sketch, kept).

**D1 — protocol (`packages/protocol/src/artifact.ts`, new; exported from `index.ts`).**

```ts
export const ARTIFACT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;   // model slug, or minted "a1", "a2"…
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;          // per version (Owner Q3)
export const ARTIFACT_KINDS = ["image","svg","html","pdf","markdown","text","other"] as const; // closed for CLIENT logic
export const ArtifactMetaSchema = z.object({
  artifactId: z.string().regex(ARTIFACT_ID_RE),
  version: z.number().int().positive(),
  sha256: z.string().regex(ATTACHMENT_ID_RE),
  size: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
  mimeType: z.string().min(1).max(127).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),  // FREE string
  kind: z.string().min(1).max(32),             // FREE on the wire; a client maps an unknown kind → "other"
  title: z.string().min(1).max(120).regex(ATTACHMENT_NAME_RE),
  callId: z.string().min(1).max(256),          // the present call that made it (joins the card)
  createdAt: z.number().int().nonnegative(),   // daemon clock, display only
  source: z.string().max(512).regex(ATTACHMENT_NAME_RE).optional(), // workspace-relative path, display only
  width: z.number().int().positive().max(65535).optional(),          // images, sniffed daemon-side
  height: z.number().int().positive().max(65535).optional(),
});
// artifact/list {sessionId} → {artifacts: ArtifactMeta[]}   (every version, oldest first; ≤ 500, `truncated`)
// artifact/read {sessionId, sha256, offset} → {data: base64 (≤ ATTACHMENT_CHUNK_BYTES raw), size}
```

- `Method.ArtifactList = "artifact/list"`, `Method.ArtifactRead = "artifact/read"`
  + their `RequestSchemas` rows (`methods.ts`, beside `AttachmentPut` at `:158,275`).
- `DomainErrorCode.ArtifactUnavailable = -32020` (next free after
  `PushStoreFailed: -32019`, `jsonrpc.ts:77`) with `data.reason`:
  `"unknown" | "evicted" | "store_failed"` (TS type only, additive like
  `AttachmentRefusedReason`).
- `ToolCallUpdateSchema` gains `artifact: ArtifactMetaSchema.optional()` — a free
  field (P5): an older client drops it and shows the tool's text.
- `mimeType`/`kind` are free strings (the `AttachmentRefSchema` rule,
  `attachment.ts:10-13`): a newer daemon's kind never makes an older client
  refuse a frame. Clients branch on the closed `ARTIFACT_KINDS` via
  `artifactKindOf(meta) → ArtifactKind` (unknown → `"other"`), ONE pure function.
- **No `PROTOCOL_VERSION` bump, no `protocol.d/` note**: two methods, one error
  code, one optional field — all additive. **No new update type** (the live card
  rides `tool_call_update`; the gallery re-reads `artifact/list` on that update),
  so `UPDATE_CLASS` and `client/mapping.ts`'s update switch are untouched except
  the `tool_call_update` reverse mapping of the field (D6).

**D2 — the model tool `present` (`packages/tools/src/present.ts`, new).**

```ts
input: {
  title: string;                       // 1..120, shown on the card
  path?: string;                       // a workspace file (exactly one of path | content)
  content?: string;                    // generated text: HTML / Markdown / SVG / plain, ≤ 2 MiB chars
  kind?: "html" | "markdown" | "svg" | "text";   // for `content` only; default: sniffed
  id?: string;                         // ARTIFACT_ID_RE; same id ⇒ a new version of that artifact
}
```

- `permission: "none"` — presenting is showing the user, never acting; nothing
  auto-opens anywhere (D9/D10). `concurrency`: keys `[{read, path}, {write,
  "artifacts"}]` (serializes presents of one session, parallel with reads).
- `execute`: `ctx.artifacts` absent (sub-agent, one-shot, any build without a
  sink) → `isError` "present is not available here". Otherwise: bytes =
  `ctx.env.readBytes(path, {maxBytes})` (D3) or UTF-8 of `content`; classify
  (`classifyArtifact(bytes, {path, kind})` — pure, magic bytes first: PNG/JPEG/
  GIF/WebP → image (+ width/height), `%PDF-` → pdf, `<svg` → svg, `<!doctype
  html`/`<html` → html, `.md` → markdown, valid UTF-8 → text, else other);
  `meta = await ctx.artifacts.present({...})` (D4); return
  `{ content: "Presented \"<title>\" to the user as artifact <id> v<n> (<kind>, <size>). They open it from the card in the transcript.", details: { kind: "artifact", ...meta } }`.
- Registered in `wiring.ts` beside `context_reset` when `options.artifacts` is
  passed (worker, `serve`, pod daemons — every session-hosting build). It is
  **not** offered to sub-agents (P3: filtered out by name in the child registry
  copy, and the child context has no sink anyway — belt and braces, one test each).
- Errors are loud and model-actionable: "file too large (31.2 MiB > 20 MiB)",
  "outside the workspace — copy it into the workspace first", "looks like a
  secret file (.env) — not presented", "artifact store full for this session
  (200 MiB) — present fewer or smaller files".

**D3 — binary, confined read (`core` + `exec`).**
`ExecutionEnvironment.readBytes?(path, opts: { maxBytes: number }): Promise<{ bytes: Uint8Array; realPath: string }>`
(optional member: an env without it → the tool says "cannot read binary files
here"). `HostExecution.readBytes`:
1. `abs = resolve(defaultCwd, path)`; `real = realTarget(abs)` (symlinks
   followed; loop/dangling → refuse);
2. `within(root, real)` required — **reads by `present` are confined** even
   though `fs_read` is not (Owner Q4): a symlink inside the workspace pointing
   out is refused by its target;
3. `isSecretPath(real)` (pure, `core/src/secret-path.ts`): basename `.env`,
   `.env.*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`/`id_ed25519*`/`id_ecdsa*`,
   `.netrc`, `.npmrc`, `.pypirc`, `credentials*`; any path segment `.ssh`,
   `.aws`, `.gnupg`, `.kube`, `.docker` → refuse;
4. `stat` → regular file only (no FIFO/device/dir), `size ≤ maxBytes` else
   refuse BEFORE reading; read, and re-check `bytes.length` (a file growing
   mid-read is refused, not truncated).

**D4 — the daemon store (`packages/daemon/src/artifact-store.ts`, new).**

```ts
export class ArtifactStore implements ArtifactSink {          // ArtifactSink: core interface used by ToolContext
  constructor(budget: ArtifactBudget, opts?: { disk?: ArtifactDisk; sessionMaxBytes?: number; now?: () => number });
  present(p: { title; bytes; mimeType; kind; callId; source?; id?; width?; height? }): Promise<ArtifactMeta>;
  list(): readonly ArtifactMeta[];                             // every version, oldest first
  read(sha256: string, offset: number): Promise<{ data: string; size: number }>;   // throws ArtifactUnavailable
  dispose(): void;                                             // memory only, never disk (archive keeps)
}
```

- **Snapshot at present time:** the bytes are copied into the store when the tool
  runs; later edits to the workspace file never change a presented version.
- **Versioning:** `id` given and known → `version = last + 1`; unknown or absent
  → new artifact (`id` or minted `a<N>`), version 1. Same id + same sha256 as the
  latest version → no new version (idempotent re-present; returns the latest meta).
- **Memory hosts** (worker, pod daemons): one `ArtifactBudget` per daemon
  (`ARTIFACT_MEMORY_BYTES = 128 MiB`); over budget → evict the OLDEST versions of
  any session (not the one being presented), their metas stay with
  `evicted: true` in `list()` (an internal flag mapped to the client as an
  `ArtifactUnavailable{reason:"evicted"}` on read). Artifacts are not in the
  model's context, so eviction never poisons a session (unlike images,
  `attachments-upload.md` D2).
- **`serve`** (`disk` set, D5): no eviction; `SESSION_ARTIFACT_BYTES = 200 MiB`
  per session on disk; over → the tool's loud "store full" error (Owner Q3).
- `read`: only a sha256 that is in THIS store's list (never an arbitrary blob of
  the session dir); `offset` must be a multiple of `ATTACHMENT_CHUNK_BYTES` and
  `< size`; returns at most one chunk. Synchronous up to the disk read (no lock,
  P8 / AGENTS §7 "don't serialize the RPC peer").
- Wiring (mirrors P1): `SessionHost.build` creates `new ArtifactStore(this.artifactBudget, disk ? { disk } : {})`
  with `disk = this.opts.persister?.artifacts(id)`, passes it to
  `createAgent(..., { artifacts })`; `AgentConfig.artifacts?: ArtifactSink`;
  `ToolContext.artifacts` set at `agent.ts:1171-1177`; `HostedSession` keeps
  `readonly artifacts` and `close()` calls `artifacts.dispose()` beside
  `uploads.dispose()` (`hosted-session.ts:3294`).
- `Connection.onRequest`: `case Method.ArtifactList: return { artifacts: this.lookup(sessionId).artifacts.list() }`
  and `case Method.ArtifactRead: return this.lookup(sessionId).artifacts.read(sha256, offset)`.

**D5 — `serve` durability: a manifest BESIDE the log, not a log entry.**
`<dir>/<uid>.artifacts/` holds `<sha256>` blob files (the `SessionBlobs` code,
parameterised by suffix: `new SessionBlobs(dir, ".artifacts")`) and
`manifest.jsonl`: line 1 = `{"schemaVersion":1}`, then one `ArtifactMeta` per
line, appended + fsync'd. Order on present: blob `tmp+fsync+rename` → manifest
append+fsync → tool result. A crash between leaves an orphan blob (swept at the
next start, D5c) — never a manifest line whose bytes are missing.

Why not a session-log entry (Owner Q1): (a) compaction and `context_reset`
start a new segment (`base`), so per-segment entries would vanish from the
gallery unless `keepSuperseded` — an artifact the user saw must not disappear
because the model's context was compacted; (b) a new log type needs a
criticality decision; a non-critical one would be skipped by older builds and
re-derivation logic would be needed anyway. The manifest is independent of the
conversation, like the attachments blob dir (P7) — which is also why it needs
**no owner sign-off** (no critical type, no wire bump).

- (a) Routed through `LogSessionStore` like `putBlob` (queue + lock):
  `putArtifact(uid, meta, bytes)`, `readArtifactBlob(uid, sha)`,
  `artifactManifest(uid) → ArtifactMeta[] | "refused"`; `SessionPersister.artifacts(id)`
  binds them (`undefined` when blocked → memory store).
- (b) Versioned on its own: an unknown `schemaVersion` → `"refused"`: the store
  starts memory-only for that session, never writes the dir, and the gallery shows
  a one-line "artifacts were written by a newer tentacle". A malformed line is
  skipped (kept on disk), never fatal.
- (c) Lifecycle: **archive** keeps (dispose = memory); **delete** removes the dir
  in `removeLocked` AFTER the log (with the attachments dir); **`/clear` fork**
  links blobs + copies manifest lines for the artifacts whose `callId` occurs in
  the forked messages, after the fork's log lands (beside `:618`); the source
  keeps all its artifacts (the gallery survives `/clear`, Owner Q7); **start-up
  sweep** (beside the attachments sweep, `attachments-durable.md` D3): a
  logless `<uid>.artifacts` dir is removed; a blob not named by its manifest is
  removed.

**D6 — client (`packages/client`).**
- `client/mapping.ts` `tool_call_update`: `artifact` → `ToolResult.details = { kind: "artifact", ...meta }`
  (core union grows `kind: "artifact"`, D2).
- `RemoteClient.listArtifacts(sessionId): Promise<ArtifactMeta[]>` —
  `MethodNotFound` → `ArtifactsUnsupportedError` (the UI says "needs a newer
  tentacle on <computer>").
- `RemoteClient.readArtifact(sessionId, meta, { signal, onProgress }): Promise<Uint8Array>` —
  a pure `client/src/read-window.ts` (window of 2 chunks in flight, offsets
  `0, C, 2C…`), reconnect via `whenLive` (the `upload()` idiom,
  `remote-client.ts:1940-2060,3563`) resuming at the first missing chunk,
  `AbortSignal` cancels. **Trust:** the result is accepted only if every chunk's
  length is exactly `min(C, size - offset)`, the `size` answered equals
  `meta.size`, and sha256 of the whole equals `meta.sha256` — else
  `ArtifactCorruptError` (a hostile pod cannot hand us other bytes than it
  announced, nor make us buffer more than `meta.size`; `meta.size` is itself
  schema-capped at 20 MiB).

**D7 — the card (both frontends; pure view-model, dumb renderer).**
Pure `artifactCard(meta, state) → { glyph, title, line2, action, state }` lives
in **`packages/core/src/artifact-card.ts`** (React-free; imported by the TUI and
the app — the app may import `@tentacle/core`, `apps/mobile/package.json:12`):
`line2` = `"PNG · 1280×720 · 240 KB"` / `"HTML page · 14 KB"` / `"PDF · 2.1 MB"`
/ `"ZIP · 3.4 MB"`, `v2` suffix when `version > 1`, `"from the pod"` mark for an
untrusted origin (TUI pod runtimes), `"no longer available"` when evicted/
unreadable.

**D8 — TUI (Mac).** (mockups: TUI section)
- Card: the `present` tool row renders, instead of the generic tool body, ONE
  card line under the tool header: `▣ <title>` + dim `<line2> · ^X^O open`
  (chosen variant A, two lines total; runner-up B = a boxed 3-line card).
- On reload, `messagesToItems` (`resume.ts:36`) gets an optional
  `artifactsByCall: Map<callId, ArtifactMeta>` (from `listArtifacts`, fetched
  once at open/resume) and attaches `detail` to the matching tool items.
- **Open key:** `Ctrl+X Ctrl+O` (chord, beside `Ctrl+X Ctrl+S`, P9) opens the
  NEWEST artifact; a mouse click on a card line opens that one; `/artifacts`
  opens the **artifacts panel** (new panel kind `artifacts`, one file + one
  registry line): newest first, versions folded under their artifact (`→`
  expands), `enter` open, `s` save a copy to `~/Downloads`, `n` open HTML with
  network allowed (confirm line), `esc` close.
- **Opening = a pure plan + one spawn.** `tui/src/artifact-open.ts` (pure):
  `openPlan(meta, origin) → { kind: "open" | "confirm" | "save-only", file:
  "<sha8>.<ext>", wrap: "csp" | null, app: "default" | "preview" }` — the
  extension comes from OUR kind map (`png jpg gif webp pdf html svg→html md txt`),
  NEVER from the model's name or path; kind `other` is **never** handed to
  `open` (a `.command`/`.app` would execute) → `save-only`. HTML/SVG are written
  wrapped: `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">` prepended
  (the same `artifactCsp()` string the phone uses, in `core`). Bytes are written
  to a per-process `0700` dir under `os.tmpdir()` (removed at exit; never under
  the config dir — **nothing lasting on the laptop**, which matters for pod
  sessions), then `Bun.spawn(["open", file], { stdio: ["ignore","ignore","ignore"] })`
  (`xdg-open` on Linux) — no byte reaches the terminal (AGENTS §7).
- **Pod sessions (untrusted):** `origin = "pod"` → every open is `confirm`
  (a one-line confirm in the dock: `open pod-supplied report.html in your
  browser? network blocked · y/N`), never remembered; `n` (network) is not
  offered for pod HTML; `s` writes to `~/Downloads` only on that explicit key.
- Status line: while a read runs, the existing notice line shows
  `fetching report.html 1.2/3.4 MB`; failure → one notice.

**D9 — iPhone.** (mockups: phone sections)
- **Card in chat** (chosen A: a minimal band row — 40 pt square thumbnail or
  kind glyph, title, `line2`, chevron; no rounded inset card, owner taste;
  runner-up B: a full-width preview tile). Thumbnails: images ≤ 1 MiB fetch
  automatically when the row is visible (the existing `thumbnails.ts` driver,
  its `ThumbnailSource` port finally implemented with `readArtifact`; bounded
  `MAX_IN_FLIGHT`, cancelled when scrolled away); larger images and every other
  kind show the glyph until opened (Owner Q6).
- **Viewers** (full-screen modal, header: ✕, title, `v2 ▾` version picker when
  >1 version, Share ⤴):
  - *Image* — RN `ScrollView` `maximumZoomScale={6}` + `Image` (native pinch,
    double-tap zoom), soft dark ground (no pure black; B1 `#1F1F1E`).
  - *HTML / SVG* — `react-native-webview` **fully isolated**: `source={{ html:
    artifactCsp() + body, baseUrl: "about:blank" }}`, `incognito` (ephemeral
    store: no cookies/storage persist), `sharedCookiesEnabled={false}`, **no
    `onMessage`** (no `window.ReactNativeWebView` bridge is injected without it),
    no `injectedJavaScript`, `onShouldStartLoadWithRequest` allows only the
    initial `about:blank` load (every navigation, `window.open`, `target=_blank`,
    meta-refresh, form post → refused), `allowsLinkPreview={false}`,
    `allowFileAccess={false}`, `mediaPlaybackRequiresUserAction`, `javaScriptCanOpenWindowsAutomatically={false}`,
    `dataDetectorTypes="none"`. Scripts **on**, network **off** by default
    (Owner Q5 — conditional on the escape suite, below). A thin top bar under the
    header: `Network off · Allow` (chosen A); tapping Allow shows a one-sentence
    confirm and reloads WITHOUT the CSP's network clauses — per open, never
    remembered (Owner Q5b). Tapping a link opens nothing; long-press offers
    "Copy link".
  - *PDF* — the same isolated WebView with `source={{ uri: fileUri }}` of the
    cached file, `javaScriptEnabled={false}` (WKWebView renders PDF natively;
    no PDF module needed); continuous scroll (chosen) vs paged (runner-up).
  - *Markdown / text* — the existing native `Markdown.tsx`; text as a
    monospaced block; no WebView (chosen: rendered with a `Source` toggle).
  - *Other* — a sheet: glyph, title, `ZIP · 3.4 MB`, **Share…** (RN core
    `Share.share({ url: fileUri })` → Save to Files, AirDrop…) — never executed.
- **Cache:** bytes land in `FileSystem.cacheDirectory/artifacts/<computerId>/<sha256>`
  (content-addressed; pure LRU plan `artifact-cache.ts`, 200 MB cap); deleted on
  unpair of that computer and when this phone deletes the session. Share uses a
  copy named `<sanitized title>.<ext>`.
- **Gallery** — a self-contained screen with a pure view-model and ONE entry:
  - `apps/mobile/src/artifact-gallery.ts` (pure): `galleryView(list, seen, now, filter) → { sections: [{ day, items: [{ key, card, versions, unseen }] }], unseen: number, empty }`
    (artifacts newest first, versions folded, `unseen` = versions presented after
    this device last opened the gallery or the artifact);
  - `unseenArtifacts(list, seen) → number` — **the count the hub badges**;
  - `artifact-seen-store.ts` — `{v:1, seen: {<computerId>/<sessionId>: {lastGalleryAt, opened: sha[] (≤ 500)}}}`
    behind the `SecureKV` port, the `voice-settings-store.ts` pattern
    (unknown `v` preserved, write refused);
  - **ONE entry function** `openArtifactGallery(nav, { computerId, sessionId, from: "session-info" | "hub" | "card" })`
    in `apps/mobile/src/routes.ts`: pushes the `ArtifactGallery` route (a sheet
    with the session title as header). Session info gets a **row** "Artifacts ·
    3 · 1 new ›" (a new `artifacts` section in `session-info.ts`, its own pull:
    `unsupported` on an older daemon, P11) that calls it with
    `from: "session-info"`. `feat/mobile-hub` calls the same function with
    `from: "hub"` and badges with `unseenArtifacts` — nothing else to wire.
- **Pod sessions on the phone:** the phone only reaches `serve` sessions today
  (`session-runtimes.ts:1-17`), but the viewer treats every artifact as
  untrusted anyway (the isolation above is the same for all origins).

**D10 — never auto-open.** No frontend opens an artifact without a tap/key. A
presented artifact produces a card and a gallery entry only. No push
notification in v1 (Owner Q8).

**What does NOT change:** no `PROTOCOL_VERSION` bump, no new update type, no
session-log entry type, no sidecar field, no `CHANGELOG.md` edit, no provider
code (artifacts never enter the model's context beyond the tool's one-line
result).

### Files

Dependency order (slice in brackets):

1. `packages/protocol/src/artifact.ts` (new) · `methods.ts` (2 methods) ·
   `jsonrpc.ts` (`ArtifactUnavailable`) · `updates.ts` (`ToolCallUpdateSchema.artifact`)
   · `index.ts` · `schema/protocol.json` regenerated by `bun run protocol:bump` at merge, never by hand [S1]
2. `packages/core/src/tool.ts` (`ToolResultDetail` += artifact; `ToolContext.artifacts?`; `ArtifactSink`)
   · `core/src/execution.ts` (`readBytes?`) · `core/src/secret-path.ts` (new) ·
   `core/src/artifact-kind.ts` (new: `classifyArtifact`, `artifactKindOf`, image dims) ·
   `core/src/artifact-card.ts` (new) · `core/src/artifact-csp.ts` (new) ·
   `packages/exec/src/host-execution.ts` (`readBytes`) [S2]
3. `packages/daemon/src/artifact-store.ts` (new) · `session-host.ts` (build) ·
   `hosted-session.ts` (field + dispose) · `connection.ts` (2 cases) · `mapping.ts`
   (`toolResultContent` → `artifact` field) · `packages/agent/src/agent.ts`
   (`AgentConfig.artifacts` → `ToolContext`) · `packages/tools/src/present.ts` (new) ·
   `tools/src/index.ts` · `packages/cli/src/wiring.ts` (register; child filter) [S3]
4. `packages/daemon/src/session-blobs.ts` (suffix param) · `session-log-store.ts`
   (`putArtifact`/`readArtifactBlob`/`artifactManifest`; remove; fork; sweep) ·
   `session-persister.ts` (`artifacts(id)`) · `cli/src/serve.ts` (sweep) [S4]
5. `packages/client/src/read-window.ts` (new) · `remote-client.ts`
   (`listArtifacts`, `readArtifact`) · `client/src/mapping.ts` · `index.ts` [S5]
6. `packages/tui/src/render-lines.ts` (card) · `resume.ts` (`artifactsByCall`) ·
   `panels/artifacts.ts` (new) · `panels/registry.ts` · `panels/types.ts` ·
   `commands/artifacts.ts` (new) · `commands/registry.ts` · `cli/src/local-runtime.ts`
   (expose `listArtifacts`/`readArtifact` on the controller) [S6a]
7. `packages/tui/src/artifact-open.ts` (new, pure) · `tui/src/os-open.ts` (new: temp dir + spawn) ·
   `chord.ts` (`Ctrl+X Ctrl+O`) · dock confirm line [S6b]
8. `packages/cli/src/local-runtime.ts` + `session-saver.ts` (worker sessions only:
   persist artifacts on the laptop, D11) [S10]
9. `apps/mobile/src/artifact-gallery.ts` · `artifact-seen-store.ts` (+ expo binding) ·
   `artifact-cache.ts` · `artifact-viewer.ts` (which viewer, WebView props as data,
   navigation predicate) — all pure [S7]
10. `apps/mobile/package.json` (`react-native-webview`, pinned exact) ·
    `screens/artifacts/ImageViewer.tsx` · `HtmlViewer.tsx` · `PdfViewer.tsx` ·
    `MarkdownViewer.tsx` · `OtherSheet.tsx` · `e2e/flows/30-artifact-escape.yaml` +
    its fixture page [S8]
11. `apps/mobile/src/transcript-rows.ts` / `transcript.ts` / `transcript-history.ts`
    (card row + history join) · `screens/transcript/TranscriptRow.tsx` ·
    `thumbnails.ts` source port · `session-info.ts` (+ `SessionInfoSheet.tsx` row) ·
    `routes.ts` (`openArtifactGallery`) · `screens/ArtifactGallery.tsx` ·
    `changelog.d/model-artifacts.added.md` · `docs/feat/model-artifacts.md` Execution [S9]

**D11 — worker sessions on the laptop (S10).** A worker daemon persists nothing
(§7), so after `--resume` its gallery would be empty. The laptop main thread,
at the save points it already has (turn end, `persistingController`), calls
`listArtifacts` and, for each version not yet in `<uid>.artifacts/`, `readArtifact`
→ `saver.putArtifact` (same `LogSessionStore` ops as S4, laptop store dir).
On resume it re-seeds the new worker's store from that dir (a `seed` option on
`ArtifactStore`, the restore idiom of `attachments-durable.md` D5). **Only for
`kind: "local"` runtimes** — a pod session's artifacts are pod-supplied and are
never written on the laptop (§7); `connect` keeps no laptop copy (serve's is the
truth).

### Failure modes

| Mode | What happens | Converges how | Pinned by |
|---|---|---|---|
| Huge file (31 MiB) | `readBytes` stats first → refused before reading | model gets "too large (31.2 MiB > 20 MiB)"; nothing stored | T2.3, T3.2 |
| File grows during read | length ≠ stat size → refused | model retries | T2.4 |
| Binary / unknown type (`.zip`, `.bin`) | kind `other` | card "ZIP · 3.4 MB"; phone Share; TUI `s` save only — never `open` | T2.6, T6b.2, T7.3 |
| Path outside workspace | real path not `within(root)` | refused, model told to copy it in | T2.1 |
| Symlink in workspace → `~/.ssh/id_rsa` | target resolved first → outside → refused | — | T2.2 |
| Secret-looking file inside workspace (`.env`, `certs/x.pem`) | `isSecretPath` → refused (not overridable by the model) | — | T2.5 |
| FIFO / device / directory | `stat` not a regular file → refused (never blocks on a FIFO) | — | T2.4 |
| `content` > 2 MiB chars | schema refuses the call | model error | T3.2 |
| Sub-agent calls `present` | not in its registry; if reached, no sink → error | — | T3.6 |
| Memory daemon over budget (worker/pod) | oldest versions evicted, meta kept `evicted` | card "no longer available — ask to present again" | T3.4 |
| `serve` session over 200 MiB | tool error "store full" | loud to the model; user deletes old sessions | T4.3 |
| Disk write fails (`serve`) | blob or manifest write throws → tool `isError` "could not store (ENOSPC)" | no manifest line without its blob | T4.2 |
| Crash between blob and manifest | orphan blob | swept at next start | T4.5 |
| Unknown manifest `schemaVersion` | refused; session store memory-only; dir untouched | gallery note "written by a newer tentacle" | T4.4 |
| Relay drops mid-fetch | chunk rejected with link-down → `whenLive` → resume at first missing chunk | viewer progress continues; abort on close | T5.2 |
| Daemon answers wrong size / bytes (hostile pod) | chunk length or final sha mismatch → `ArtifactCorruptError` | viewer: "couldn't verify this file"; nothing cached | T5.3 |
| Daemon announces a 2 GiB artifact | `ArtifactMetaSchema.size ≤ 20 MiB` → frame refused at parse | card not shown (the tool row stays) | T1.2 |
| Old daemon, new app/TUI | `artifact/list` → `MethodNotFound` → `ArtifactsUnsupportedError` | gallery row "needs a newer tentacle on <computer>"; no cards (no field) | T5.4, T9.3 |
| New daemon, old app/TUI | `artifact` field stripped (P5); no list call | the tool row shows the text "Presented …" | T1.3 (strip) |
| Pod HTML tries to escape (fetch/XHR, `<img src=http>`, WebSocket, `<form>`, `location=`, `window.open`, meta refresh, `postMessage` to RN, cookies/localStorage, iframe, WebRTC) | CSP + navigation predicate + incognito + no bridge | escape suite: zero hits on the listener | T8.1 (e2e), T7.2 (pure predicate) |
| WebRTC beacon not blockable by CSP | escape suite RED on `RTCPeerConnection` | **pre-decided fallback**: scripts default OFF with a "Run scripts" tap (Owner Q5) | T8.1 |
| Pod HTML on the Mac | `confirm` every time, CSP-wrapped, network option hidden | user decides per open; nothing remembered | T6b.3 |
| Model-chosen name `../../x.command` | display only (`ATTACHMENT_NAME_RE`), temp file is `<sha8>.<ext from kind>` | — | T6b.1 |
| Session archived (serve) | `artifact/read` on a non-open session → `UnknownSession` | gallery: "Reopen to view" (reopen = explicit `session/open{reopen}`) | T9.4 |
| Session deleted | dir removed with the log | phone deletes its cache entries for that session when IT deletes; other devices' cache ages out (LRU) | T4.6 |
| Compaction / `context_reset` | the `present` messages may leave the context | manifest is independent → gallery keeps them; transcript cards go with their rows | T4.7 |
| `/clear` | fork gets links + manifest lines for its callIds; source keeps all | both galleries complete | T4.8 |
| Two clients open the same artifact | content-addressed reads, idempotent | — | T5.1 |
| Re-present same id, same bytes | no new version | — | T3.3 |
| Viewer closed mid-fetch | `AbortSignal` → no more chunks issued | partial never cached | T5.2 |
| Phone cache full | LRU drop oldest (not the one open) | — | T7.4 |
| Artifact presented while the gallery is open | `tool_call_update.artifact` → controller re-reads `artifact/list` | list grows live; unseen count updates | T9.2 |

### Tests

Red first: every test below is written and shown FAILING (no module / wrong
behaviour) before its code, and one mutation per slice is applied and reverted
(§9). Fakes: `createChannelPair`, the existing `RpcPeer` harness, `FakeWS`, the
`SessionBlobsIo` fake, `SecureKV` fake, ink-testing-library frames.

- **T1 (protocol)** 1 schemas accept a valid meta, refuse `artifactId` `"../x"`,
  a title with `\n`, `size` 0 and > 20 MiB; 2 a `tool_call_update` with an
  oversize `artifact` fails its member; 3 an older-shaped `ToolCallUpdateSchema`
  parse strips `artifact` (forward compat); 4 `RequestSchemas` rows exist;
  `artifactKindOf({kind:"hologram"})` → `"other"`.
- **T2 (read confinement)** with a temp workspace: 1 `../outside.png` refused;
  2 in-root symlink → outside target refused, in-root → in-root allowed; 3 file
  of `maxBytes+1` refused without reading (spy on read); 4 FIFO and directory
  refused; 5 `.env`, `.env.local`, `a/.ssh/config`, `x.pem` refused, `env.md`
  allowed; 6 `classifyArtifact` on PNG/JPEG/GIF/WebP magic (+dims), `%PDF-`,
  SVG, HTML, `.md`, UTF-8 text, random bytes → other.
- **T3 (store + tool)** 1 present → meta v1, `list()` has it, `read` returns the
  chunks that hash to `sha256`; 2 tool errors: too large, `content` too long,
  both/neither of path|content; 3 same id → v2; same id + same bytes → still v1;
  4 budget eviction keeps metas `evicted`, read → `ArtifactUnavailable{evicted}`;
  5 `read` of a sha not in the list → `unknown`, offset not chunk-aligned → error;
  6 sub-agent registry has no `present` and a sink-less context → error;
  7 **load-bearing repro as a test**: read-roundtrip over the Noise channel
  pair with an interleaved `session/enqueue` answered before the last chunk.
- **T4 (serve durability)** 1 restart reload: list + bytes survive; 2 failed
  blob write → no manifest line, tool `isError`; 3 session cap; 4 unknown
  `schemaVersion` → refused, dir bytes unchanged (hash the dir before/after);
  5 orphan blob + logless dir swept at start; 6 delete removes the dir after the
  log; 7 compaction keeps the list; 8 `/clear` fork links exactly its callIds'
  artifacts and the source keeps all.
- **T5 (client)** 1 `readArtifact` assembles + verifies; 2 link drop after chunk
  2 resumes at chunk 3 (no chunk 0–2 re-read), abort stops issuing; 3 a fake
  daemon answering a short chunk / wrong bytes / other `size` → `ArtifactCorruptError`,
  and never buffers > `meta.size`; 4 `MethodNotFound` → `ArtifactsUnsupportedError`;
  5 `client/mapping` rebuilds `details.kind === "artifact"`.
- **T6a (TUI)** ink frames: the card line under a `present` tool row (live and
  after resume via `artifactsByCall`), width 80 and 120, no line overflow; the
  `/artifacts` panel lists newest-first with folded versions; enter calls the
  opener port with that meta.
- **T6b (TUI open)** 1 `openPlan` file names never contain model input
  (`title: "../../x.command"` → `ab12cd34.html`); 2 `other` → `save-only`, never
  `open`; 3 pod origin → `confirm`, no network option; 4 HTML written with the
  CSP prefix as its FIRST bytes; 5 the spawn is called with `stdio` all `ignore`
  (spy) and nothing is written to `process.stdout` (spy).
- **T7 (phone pure)** 1 `galleryView` grouping/fold/unseen; `unseenArtifacts`
  after opening the gallery = 0, after a new version = 1; 2 `allowNavigation`
  predicate: only the initial `about:blank`; `https:`, `data:`, `file:`,
  `javascript:` refused; WebView props as data: `incognito: true`, no
  `onMessage`, `javaScriptEnabled` per kind; 3 `viewerFor(kind)`; 4 cache LRU
  plan; seen-store unknown `v` preserved.
- **T8 (phone native, e2e)** 1 `30-artifact-escape.yaml`: the mock model
  presents `escape.html` (fixture: fetch, XHR, img, CSS `url()`, WebSocket,
  EventSource, `<form>` auto-submit, `location=`, `window.open`, meta refresh,
  `<iframe src>`, `about:blank` iframe + its `RTCPeerConnection`,
  `navigator.sendBeacon`, `window.ReactNativeWebView?.postMessage`,
  `document.cookie` / `localStorage` written then read on reopen) against a
  listener on the e2e host: **zero requests received** and the page's own
  self-report shows every probe blocked; then Allow network → the fetch probe
  arrives (proves the listener works: non-vacuity). 2 image pinch-zoom screen
  shot; PDF renders page 1; Markdown renders a heading.
- **T9 (phone wiring)** 1 card row in a live turn and after reopen; 2 a present
  during an open gallery updates the list + unseen; 3 old daemon → the Session
  info row says unsupported, no crash; 4 archived session → "Reopen to view".
- **T10 (laptop worker durability)** worker `--resume` shows the gallery and
  reads bytes from the laptop dir; a POD runtime writes NOTHING under the laptop
  store (dir absent after a present + save).

### Slices

Each slice is green on its own (narrow tests, then `bun run check`), appends to
Execution, and is S or M. Executor per the orchestrator rule: `deepseek` for
contained / cross-module, `opus` for load-bearing or security-sensitive.

| # | Slice | Size · Blast · Executor | Contents (Files item) | Done when |
|---|---|---|---|---|
| S1 | Protocol | S · cross-module (additive wire) · **deepseek** | 1 | T1 green; `bun run check` |
| S2 | Binary confined read + pure kind/card/CSP helpers | S · load-bearing (security: what leaves the workspace) · **opus** | 2 | T2 green + mutation (drop `within`) |
| S3 | Store + `present` tool + daemon wiring | M · load-bearing (agent `ToolContext`, connection) · **opus** | 3 (repro FIRST) | T3 green incl. T3.7 |
| S4 | `serve` durability | M · load-bearing (§7 persistence) · **opus** | 4 | T4 green + mutation (manifest before blob) |
| S5 | Client list/read + mapping | M · cross-module (trust check on pod bytes) · **opus** | 5 | T5 green + mutation (skip sha check) |
| S6a | TUI card + `/artifacts` panel | M · cross-module · **deepseek** | 6 | T6a green |
| S6b | TUI opener (temp files, CSP wrap, pod confirm, chord) | S · load-bearing (§7 terminal + pod trust) · **opus** | 7 | T6b green + mutation (ext from title) |
| S10 | Laptop durability for worker sessions | M · load-bearing (§7 persistence; pod exclusion) · **opus** | 8 | T10 green |
| S7 | Phone pure modules | M · contained · **deepseek** | 9 | T7 green |
| S8 | Phone viewers + `react-native-webview` + escape suite | M · load-bearing (security isolation; **new native module ⇒ a new dev build**) · **opus** | 10 | T8 green on the simulator; if the build machine cannot build (the known `PushCore` blocker, `mobile-chrome.md` "Not done"), unit tests + the honest "pixels unverified" line, and the escape suite marked PENDING for the Review |
| S9 | Phone wiring: card, history join, thumbnails, Session info row, gallery screen, changelog | M · cross-module · **deepseek** | 11 | T9 green |

Execution order: S1 → S2 → S3 → S4 → S5 → S6a → S6b → S10 → S7 → S8 → S9.
The branch merges once, after S9 and the fresh-context Review.

### Owner questions

1. **Where does artifact metadata live durably?** Options: (a) a manifest beside
   the blobs (`<uid>.artifacts/manifest.jsonl`, own `schemaVersion`); (b) a new
   NON-critical session-log entry `artifact`; (c) a critical one.
   **Recommendation: (a)** — survives compaction/`context_reset` (segments don't
   matter), needs no criticality decision, mirrors the attachments blob dir. (b)
   loses gallery entries at compaction; (c) needs owner + version bump and buys
   nothing.
2. **Live card transport:** a free `artifact` field on `tool_call_update` vs a
   new `display` update type `artifact_presented`. **Recommendation: the field**
   — an older client silently shows the tool text (a new type would show
   "unsupported" once); no `UPDATE_CLASS` change.
3. **Caps:** 20 MiB per version; `serve` 200 MiB per session on disk, no
   eviction (loud "store full"); memory hosts 128 MiB per daemon with oldest-first
   eviction. **Recommendation: as stated.**
4. **Which files may `present` read?** (a) workspace only, secret-looking names
   refused, not overridable; (b) anything, with a permission prompt outside the
   workspace. **Recommendation: (a)** for v1 — a prompt-injected model could
   otherwise ship `~/.aws/credentials` into an HTML page; the model can copy a
   file into the workspace (that write already asks).
5. **HTML default on the phone:** scripts ON + network OFF (CSP + navigation
   block + incognito + no bridge), *if* the escape suite (T8.1) shows zero hits
   including WebRTC; if WebRTC cannot be blocked, scripts default OFF with a
   one-tap "Run scripts". **Recommendation: as stated** (both outcomes
   pre-decided, so S8 does not stop). 5b. "Allow network" is per open, never
   remembered. **Recommendation: per open.**
6. **Image thumbnails in the card:** auto-fetch images ≤ 1 MiB when visible;
   bigger → glyph until opened. **Recommendation: as stated** (bounded by the
   existing thumbnail driver; a 20 MiB image never downloads by itself).
7. **`/clear` and the gallery:** the source keeps every artifact (gallery
   survives `/clear`), the fork gets those of its own messages.
   **Recommendation: as stated.**
8. **Notify on present?** No push / Live Activity in v1; card + unseen badge
   only. **Recommendation: no** (revisit with `feat/mobile-hub`).
9. **Mac open key:** `Ctrl+X Ctrl+O` chord (newest) + click a card + `/artifacts`
   panel. Runner-up: a bare `Ctrl+G`. **Recommendation: the chord** (`Ctrl+O` is
   taken; the chord machine exists; no new global key).
10. **Mac HTML:** open in the default browser from a CSP-wrapped temp copy
    (network blocked, best effort — a browser cannot block WebRTC); pod HTML
    always confirms. Runner-up: Quick Look (`qlmanage -p`, static). **Recommendation:
    browser + CSP wrap** (interactive pages work; residual = a beacon carrying
    only what the page already holds).
11. **Card look** (phone): A minimal band row with 40 pt thumbnail vs B
    full-width preview tile. **Recommendation: A** (owner taste: minimal, no
    inset cards). TUI: A 2-line card vs B boxed 3-line. **Recommendation: A.**
12. **Gallery look:** A list grouped by day vs B thumbnail grid.
    **Recommendation: A** (mixed kinds read better as rows; B shown for images-heavy sessions as runner-up).
13. **Sub-agents may present?** **Recommendation: no** in v1 (their output is
    the report to the parent; keeps one origin per card).

#### Orchestrator decisions (owner delegated 2026-11-16)

1. **(a) manifest beside the blobs** — adopted. *No session-log entry type is
   added, critical or not*, so no slice waits on the owner.
2. **The free `artifact` field on `tool_call_update`** — adopted.
3. **Caps as stated** — adopted (20 MiB / 200 MiB serve / 128 MiB memory).
4. **(a) workspace-only, secrets refused** — adopted.
5. **Scripts on + network off, gated by the escape suite; fallback scripts-off
   pre-decided** — adopted. 5b **per open** — adopted.
6. **Auto-thumbnail ≤ 1 MiB** — adopted.
7. **Gallery survives `/clear`; fork gets its own** — adopted.
8. **No notification in v1** — adopted.
9. **`Ctrl+X Ctrl+O` + click + `/artifacts`** — adopted.
10. **Browser + CSP wrap; pod confirms** — adopted.
11. **Phone card A; TUI card A** — adopted (B variants in the mockups for the owner to switch).
12. **Gallery A (list)** — adopted (B grid in the mockups).
13. **No `present` for sub-agents** — adopted.

**WAITS OWNER:** none.

### Mockups

`.tentacle/tmp/model-artifacts/mockups/index.html` (self-contained, light/dark
toggle; tokens: mobile-chrome light + B1 dark, TUI `theme.ts` palette via the
`gen-v3.ts` helpers). Every visible choice is drawn as at least two labelled
variants side by side with the chosen one marked **chosen**: phone card (A/B, four
kinds each), image viewer (A/B), HTML viewer with the network bar (A top bar / B
bottom pill), PDF (A scroll / B paged), Markdown (A rendered + Source toggle / B
plain), Other (A sheet / B inline), gallery in Session info (A list / B grid),
gallery opened from the floating hub (A half sheet / B full screen), TUI card row
(A / B), TUI artifacts panel (A / B), TUI pod confirm. Render-check output: see
*Mockup render-check* below.

### Notes / debt

- `attachment/read` for the phone's image-attachment thumbnails (12b port,
  `thumbnails.ts:20-28`) can reuse `read-window.ts` in a follow-up; not in scope.
- Live previews / dev-server, video, editing from the phone: out of v1 (owner).
- The hub itself (tap/long-press, haptic, modal) is `feat/mobile-hub`; this task
  only provides `openArtifactGallery` + `unseenArtifacts`.
- mobile-chrome's band primitives (S3/S4) are not on `main`; the gallery and
  viewers use today's `Row`/`Sheet` with the approved tokens and inherit the
  bands when those slices land.
- Browser-side WebRTC on the Mac is a documented residual (Q10).

### Mockup render-check

`bun .tentacle/tmp/model-artifacts/render-check.ts` (2026-11-16): extracts the
page's `<script>`, runs it with `new Function` against a stub `document` (an
element map with `innerHTML`/`addEventListener`, `body.classList`), renders
light, clicks the theme toggle, renders dark; for each it asserts the 25 named
frames, that the 10 choices each carry a CHOSEN frame and an "alternativa" frame,
TUI `<pre>` lines (tags stripped, entities decoded, counted in code points) ≤ 120,
no `undefined`/`NaN`, 19 phone frames, no pure black in dark.

```
PASS [light] body theme class
PASS [light] 25 frames, all 25 expected present
PASS [light] 10/10 choices drawn as chosen + alternative
PASS [light] 6 TUI frames, 86 lines, widest 120 cols (≤ 120)
PASS [light] no "undefined"/"NaN" in 96536 chars
PASS [light] 19 iPhone frames
PASS [light] no pure black in the dark frames
PASS [dark] body theme class
PASS [dark] 25 frames, all 25 expected present
PASS [dark] 10/10 choices drawn as chosen + alternative
PASS [dark] 6 TUI frames, 86 lines, widest 120 cols (≤ 120)
PASS [dark] no "undefined"/"NaN" in 96593 chars
PASS [dark] 19 iPhone frames
PASS [dark] no pure black in the dark frames
ALL PASS
```

## Execution

## Review
