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
  `{ content: "Presented \"<title>\" to the user as artifact <id> v<n> (<kind>, <size>). They open it from the card in the transcript.", details: { kind: "artifact", artifact: meta } }` (nested, not spread — the meta has its own `kind`; fixed in S2).
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
- `client/mapping.ts` `tool_call_update`: `artifact` → `ToolResult.details = { kind: "artifact", artifact: meta }` (nested: S2)
  (core union grows `kind: "artifact"`, D2).
- `RemoteClient.listArtifacts(sessionId): Promise<ArtifactListResult>` (`{ artifacts, truncated? }`:
  the wire's `truncated` is passed on, never dropped — changed from `ArtifactMeta[]` in S5) —
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
  browser? no fetch/XHR · it can still navigate away · y/N`), never remembered;
  `n` (network) is not offered for pod HTML; `s` writes to `~/Downloads` only on
  that explicit key.
  The line claims only what the wrap keeps: CSP blocks sub-resources and
  fetch/XHR, but it does **not** govern top-level navigation (`location =`, a
  meta refresh, `window.open`), so the prompt says so rather than promising
  "network blocked" (S6a review finding 3).
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
  and never buffers > `meta.size` (the read reply's own `size` is bounded at
  `MAX_ARTIFACT_BYTES` on the wire, but it is still checked against `meta.size`
  before it sizes anything); 4 `MethodNotFound` → `ArtifactsUnsupportedError`;
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

*— deepseek-v4-pro (executor, S1), 2026-11-16*

### S1 — Protocol: DONE

**Load-bearing check re-run first** (the Context's Repro, worktree `feat/model-artifacts`,
`main` merged @ `8ea2bb97`):

```
$ rg -n '"present"|artifact/' packages apps --glob '!**/node_modules/**' | wc -l
4      # NOT the capability: relay-secret.ts's `read.kind === "present"` /
       # `{ kind: "present"; text }` (4 hits, unrelated file). No `present` tool,
       # no `artifact/*` method, no artifact module.
$ rg -n 'readBytes|arrayBuffer\(\)|\.bytes\(\)' packages/core/src/execution.ts packages/exec/src/host-execution.ts | wc -l
0
$ ls apps/mobile/node_modules | rg -c 'webview'
0   (exit 1: no match)
```

Verdict: the capability is still missing. One drift from the doc's expectation:
the first command prints **4**, not 0 — those four hits are `relay-secret.ts`'s
`kind: "present"` discriminant (a secret-prompt read state), unrelated to this
feature; the artifact surface itself is absent (no `artifact/` method, no
artifact module, no `present` tool). Not a blocker, the plan's assumption holds.

**As built** (dependency order, protocol only — no other slice touched):

1. `packages/protocol/src/artifact.ts` (new, 162 lines): `ARTIFACT_ID_RE`,
   `MAX_ARTIFACT_BYTES` (20 MiB), `MAX_ARTIFACT_LIST` (500), the closed
   `ARTIFACT_KINDS` + `ArtifactKind`, `ArtifactMetaSchema`/`ArtifactMeta`,
   `artifactKindOf` (the ONE narrowing of the wire's free `kind`, unknown →
   `"other"`), `ArtifactList{,Params,Result}Schema`,
   `ArtifactRead{,Params,Result}Schema`, `ArtifactUnavailableReason` (TS type).
   `title`/`source` use `ATTACHMENT_NAME_RE`; `sha256` uses `ATTACHMENT_ID_RE`;
   the read chunk reuses `ATTACHMENT_CHUNK_B64_MAX`/`ATTACHMENT_CHUNK_BYTES`
   (imported, not redefined — one source of truth for the chunk size).
   `mimeType`/`kind` are FREE strings, exactly as D1 asks.
2. `packages/protocol/src/index.ts`: one export line (`./artifact.ts`).
3. `packages/protocol/src/jsonrpc.ts`: `DomainErrorCode.ArtifactUnavailable =
   -32020` (next free after `PushStoreFailed: -32019`), doc'd with its reasons.
4. `packages/protocol/src/methods.ts`: `Method.ArtifactList` = `"artifact/list"`,
   `Method.ArtifactRead` = `"artifact/read"` + their two `RequestSchemas` rows.
5. `packages/protocol/src/updates.ts`: `ToolCallUpdateSchema.artifact:
   ArtifactMetaSchema.optional()` — the free field, `tool_call_update` stays
   `display` in `UPDATE_CLASS` (untouched), no new update type, so no
   `protocol.d/` note and no `PROTOCOL_VERSION` edit (still 24).
6. `packages/protocol/schema/protocol.json`: regenerated with
   `bun run protocol:bump` (the merge command: no notes, so it refreshed the
   schema; `x-protocol-version` still 24). It now carries `ArtifactListParams`,
   `ArtifactListResult`, `ArtifactMeta`, `ArtifactReadParams`,
   `ArtifactReadResult`, the two `methods` rows, `ArtifactUnavailable: -32020`,
   and the `artifact` property on `ToolCallUpdate`.
7. `packages/protocol/test/json-schema.test.ts`: fixtures for both new methods
   (`artifact~1list`, `artifact~1read`), so the zod ⇔ JSON Schema agreement test
   covers them. Adding a method without its fixture fails that test's
   "every method … has a fixture" case — an existing gate, not a new one.

**Red before green** (`packages/protocol/test/artifact.test.ts`, new, 19 tests /
86 assertions), written before the module and run first:

```
$ bun test packages/protocol/test/artifact.test.ts
 2 pass
 17 fail      # every fail on its OWN assertion (missing schema → `undefined` /
              # `toBe(true)` mismatch), not on an import or compile error
```

Green after (same file): `19 pass, 0 fail, 86 expect() calls`.

**Test coverage against T1** (`### Tests`): T1.1 = the six `ArtifactMetaSchema`
cases (valid meta; slug has no traversal/uppercase; `title` refuses `\n`/`\t`/
ESC and caps at 120; `size` 0 / negative / fractional / `MAX+1` refused;
sha256/version; free `kind`/`mimeType`; dims bounded; unknown field stripped).
T1.2 = an oversize `artifact` (and a bad title/artifactId) makes the whole
`tool_call_update` frame invalid. T1.3 = `ToolCallUpdateSchema.omit({artifact})`
parses a NEW frame and strips the field (forward compat). T1.4 = both
`RequestSchemas` rows exist and are the same schema objects; both methods are
also listed and parse in `json-schema.test.ts`; `artifactKindOf({kind:
"hologram"})` → `"other"`. Plus: `ArtifactUnavailable` is -32020 and unique,
`UPDATE_CLASS.tool_call_update` is still `display`, `KNOWN_UPDATE_TYPES` has no
`artifact_presented`.

**Failure-mode tests, as the plan's table demands for this slice:**

- *"Daemon announces a 2 GiB artifact → `ArtifactMetaSchema.size ≤ 20 MiB` →
  frame refused at parse"* — pinned twice: on the schema and on the frame
  (`a meta the schema refuses makes the FRAME invalid`). **Mutation-verified**:
  dropping `.max(MAX_ARTIFACT_BYTES)` turned exactly those two cases red
  (`17 pass, 2 fail`), then restored.
- *"New daemon, old app → the `artifact` field stripped"* — pinned by the
  omit-shape case. **Mutation-verified**: deleting the field from
  `ToolCallUpdateSchema` turned all three field cases red (`16 pass, 3 fail`),
  then restored.
- *A newer daemon's `kind`/`mimeType` must never refuse a frame* (the free-string
  rule, `attachment.ts:10-13`). **Mutation-verified**: making `kind`
  `z.enum(ARTIFACT_KINDS)` turned exactly that case red (`18 pass, 1 fail`),
  then restored.
- *Additive only* — no version bump, no new update kind, one free field, one
  error code, two methods.

**Drift from Implementation — two, both small and reconciled:**

1. `ArtifactListResult`'s `truncated` is `.optional()` and the schema caps
   `artifacts` at `MAX_ARTIFACT_LIST`, where D1's comment wrote "≤ 500,
   `truncated`". Making the CAP a schema rule (not a store convention) is what
   T1.1 asks ("refuse … > 20 MiB"-style bounds) and what the JSON-Schema export
   needs; `truncated` stays optional because a list that fits says nothing
   (the repo's "omit a field there is no value for" rule,
   `session.ts:700-703`). No wire meaning changes: still "every version, oldest
   first".
2. `ArtifactReadResultSchema.size` carries `.max()`-less
   `z.number().int().positive()` — a chunk's total size is the VERSION's size,
   already capped by `ArtifactMetaSchema.size`; capping it a second time would
   duplicate the constant. T1.1's "size 0 and > 20 MiB" case applies to the META
   (where it is pinned) and the read's `0` is refused.

No other divergence. Nothing in S2–S9 was implemented (no `readBytes`, no
`present`, no store, no client, no TUI/phone code) — `rg` over the tree still
shows only the protocol surface added here.

**Gate** (worktree root):

```
$ bunx tsc --noEmit                    → exit 0
$ bun run lint                         → Checked 1664 files. No fixes applied. (0 errors, 0 warnings — the §6 baseline)
$ bun test                             → 12027 pass, 5 skip, 0 fail (12032 tests, 860 files, 450 s)
```

The 5 skips are pre-existing opt-in gates, none new and none touched by this
slice: `packages/k8s/test/integration.live.test.ts` (no `TENTACLE_K8S_SERVER`),
`packages/docker/test/integration.live.test.ts` (no `TENTACLE_DOCKER_TESTS`),
`packages/cli/test/workload-shell-live.k8s.test.ts` + `session-hop.docker.test.ts`
(the same two opt-ins), and `ws-server.test.ts`'s real-socket keepalive
(`TENTACLE_SLOW_TESTS`) — checked one by one (`bun test` on them alone:
`0 pass, 2 skip` for the cli pair). `confinement.test.ts`'s `skipIf(isRoot)`
cases RUN here (uid 501: `46 pass, 0 fail`). No test added by S1 is skipped.
`bun run protocol:bump` run: no `protocol.d/` notes ⇒ `PROTOCOL_VERSION` stays
24, schema refreshed.

**Changelog:** `changelog.d/model-artifacts.added.md` — ONE bullet. The plan says
S9 writes it; the brief for THIS slice requires one fragment and forbids a second
task-level file, so the fragment is written here, as a user-visible feature note
for the whole feature (S2–S9 add no further fragment to it). `CHANGELOG.md` and
`TODO.md` untouched.

**Unverified / next:** the read path itself (chunked `readArtifact`, resume,
sha256 verification) is S5's, and the load-bearing round-trip repro is S3's (T3.7);
this slice only proves the wire shapes they will bind to. There is nothing in S1
that can be verified end-to-end without those.

### S2 — Binary confined read + pure kind/card/CSP helpers: DONE

*— claude-opus-5-5 (executor, S2), 2026-11-16*

**Check re-run first** (the Context's second Repro line is the one S2 closes; S3
owns the whole-path round-trip repro):

```
$ rg -n 'readBytes|arrayBuffer\(\)|\.bytes\(\)' packages/core/src/execution.ts packages/exec/src/host-execution.ts | wc -l
0
$ rg -n 'secret-path|isSecretPath|classifyArtifact|artifactCsp|artifactCard' packages --glob '!**/node_modules/**' | wc -l
0
```

Still missing, so the slice is not stale.

**As built** (in dependency order, core first and then exec):

1. `packages/core/src/secret-path.ts` (new): `isSecretPath(path)` is pure and
   case-insensitive, and splits on `/` and `\`. It matches the D3 list
   (basenames `.env`, `.env.*`, `*.pem|.key|.p12`, `id_rsa*|id_ed25519*|id_ecdsa*`,
   `.netrc|.npmrc|.pypirc`, `credentials*`, and any directory segment
   `.ssh|.aws|.gnupg|.kube|.docker`).
2. `packages/core/src/artifact-kind.ts` (new): `classifyArtifact(bytes, {path?, kind?})`
   and `imageDimensions(bytes, mime)`. The image magic reuses `sniffImageType`
   (`image-sniff.ts`) instead of a second copy. Dimensions come from the PNG
   IHDR, the GIF screen descriptor, JPEG SOFn (marker walk), and WebP
   VP8/VP8L/VP8X. A truncated header or a side outside 1..65535 gives no
   dimensions, never a guess. The order is: image/PDF magic → known archive
   signature (zip/gzip ⇒ `other` + precise mime) → invalid UTF-8 or NUL ⇒ `other`
   → the caller's text `kind` hint → text sniff (`<!doctype html`/`<html`,
   `<svg`/`<?xml…<svg`) → extension (`.html/.htm/.svg/.md/.markdown`) → `text`.
3. `packages/core/src/artifact-card.ts` (new): `artifactCard(meta, {state?, origin?})`
   returns `{kind, glyph, title, line2, action, state}`, plus `formatArtifactSize`
   (decimal B/KB/MB). The kind is narrowed through S1's `artifactKindOf`. `other`
   gets `action: "save"` (never `open`) and `unavailable` gets `none`. `line2`
   carries the `vN` suffix, `from the pod`, and `no longer available`.
4. `packages/core/src/artifact-csp.ts` (new): `artifactCspPolicy({network?})`,
   `artifactCsp()` (the `<!doctype html><meta http-equiv=CSP …>` prefix) and
   `wrapArtifactHtml(body)`. The offline policy is exactly the D8 string. The
   network-on variant opens img/style/font/script/connect/media to `*` and keeps
   `frame-src`, `form-action` and `base-uri` at `'none'`.
5. `packages/core/src/tool.ts:23-70`: `ToolResultDetail` is now a union with
   `{kind:"artifact", artifact: ArtifactMeta}`. It adds a `ToolDiffDetail` alias
   (`:43`), the `ArtifactPresentInput` and `ArtifactSink` interfaces (`:66`),
   and `ToolContext.artifacts?` (`:169`).
6. `packages/core/src/execution.ts:55`: an optional
   `readBytes?(path, {maxBytes}) → {bytes, realPath}` member.
7. `packages/core/src/index.ts`: the four new modules are exported.
8. `packages/exec/src/host-execution.ts`: `WorkspaceReadError` with a `reason`
   (`:109`), and `OPEN_READ = O_RDONLY|O_NOFOLLOW|O_NONBLOCK` (`:187`).
   `readBytes` (`:429`) and `confineRead` (`:496`) do the following, in order:
   - resolve the real path with `realTarget` (dangling or looping ⇒ `unresolvable`);
   - require it `within(root)` (root only, `writableDirs` do NOT count) ⇒ `outside`;
   - run `isSecretPath` on the workspace-relative real path ⇒ `secret`;
   - `open` with `OPEN_READ` (ENOENT ⇒ `missing`, ELOOP ⇒ `unresolvable`);
   - `fstat`: anything but a regular file ⇒ `not_file`;
   - re-confine the path, which must still name the same dev/inode ⇒ `outside` or `changed`;
   - `size > maxBytes` ⇒ `too_large`, refused BEFORE any read
     (`file too large (3.2 MiB > 2 MiB)`);
   - read up to `size+1` bytes, and refuse (`changed`) if the length read ≠ `size`.

   A new TEST SEAM `beforeRead` (`:74`) sits beside the existing `beforeOpen`,
   whose doc now also covers reads.
9. Consumers of the widened union are narrowed to `ToolDiffDetail`, a type-only
   change: `packages/tools/src/builtins.ts` (`makeDiff`),
   `apps/mobile/src/diff-view.ts`, `transcript-rows.ts` (`ToolRow.diff`) and
   `apps/mobile/test/diff-view.test.ts`. One behavioural line,
   `apps/mobile/src/transcript.ts:504-505`: a row's `diff` is set only for a
   `kind:"diff"` detail. An artifact detail used to be taken as a diff there
   (it would have crashed `diffView` on `.patch`). The daemon, TUI and CLI
   consumers already narrowed on `kind`, so tsc made no other change.

**Tests:** these were written first and run RED, with every new file failing on
`Cannot find module` (core) or the missing `readBytes`/`WorkspaceReadError` (exec).
For a feat that is the capability being absent, so I did not add stub modules.
Non-vacuity is proved by the mutations below instead. Green after:

- `packages/core/test/secret-path.test.ts` (5), `artifact-kind.test.ts` (8),
  `artifact-card.test.ts` (6), `artifact-csp.test.ts` (5).
- `packages/exec/test/read-bytes.test.ts` (16). This covers T2.1 (`../`,
  absolute outside); T2.2 (in-root link → out refused, in → in allowed,
  symlinked dir out, writableDirs don't widen, dangling/loop/missing, a file
  swapped for a link at `beforeOpen`, a PARENT DIR swapped for a link at
  `beforeOpen`); T2.3 (`maxBytes+1` refused with the `beforeRead` spy at 0,
  exactly `maxBytes` OK with the spy at 1, the MiB message); T2.4 (growth during
  the read, FIFO via `mkfifo`, directory, `.`); T2.5 (`.env`, `.env.local`,
  `a/.ssh/config`, `x.pem` refused and `env.md` allowed, a link to `.env`
  refused by its target, a workspace under `…/.docker/project` still works).
  T2.6 is in `artifact-kind.test.ts`.
- `apps/mobile/test/transcript.test.ts`: +1, "an artifact detail is never taken
  as a diff".

**Mutations** (`.tentacle/tmp/model-artifacts/s2-mut/mut.ts`: apply, run that
file, copy the original back, assert restored; `git diff --stat` identical
before and after):

```
M1 drop within (plan target)                 11 pass, 5 fail  (../outside, link out, dir link out, writableDirs, dir swap)
M2 drop isSecretPath                         14 pass, 2 fail
M3 drop re-confine after open                15 pass, 1 fail  (parent-dir swap)
M4 drop O_NOFOLLOW on read                   16 pass, 0 fail  ← see note
M5 drop size check                           14 pass, 2 fail
M6 truncate instead of refusing growth       15 pass, 1 fail
M7 drop regular-file check                   15 pass, 1 fail  (FIFO/dir)
M8 no beforeRead seam (spy vacuity)          14 pass, 2 fail
M9 reads allowed in writableDirs             15 pass, 1 fail
M10 secret check on the full real path       15 pass, 1 fail  (workspace under .docker)
M11 secret: no dir segments                   2 pass, 3 fail
M12 secret: case-sensitive                    4 pass, 1 fail
M13 kind hint before binary magic             7 pass, 1 fail
M14 archive sig not checked before text       7 pass, 1 fail
M15 extension before %PDF- magic              7 pass, 1 fail
M16 card: other is openable                   4 pass, 2 fail
M17 card: wire kind not narrowed              5 pass, 1 fail
M18 csp: connect-src * offline                3 pass, 2 fail
M19 csp: network-on opens frames              4 pass, 1 fail
M20 csp: wrap appends instead of prepends     4 pass, 1 fail
M21 mobile: any detail is a diff             30 pass, 1 fail
```

M4 note: `O_NOFOLLOW` is belt and braces. A final-component link swapped in
after the check is ALSO caught by the post-open re-confinement (step 4), which
M3 proves load-bearing. With `O_NOFOLLOW` dropped, a swap to an in-root
non-secret file reads that file, which is something the caller could read
anyway. The property "nothing outside the root or secret is read" holds without
it, so M4 surviving is expected. I did not add a mechanism-only test.

**Drift from Implementation (all reconciled, plan text fixed where wrong):**

1. **`details: { kind: "artifact", ...meta }` was a bug in the plan.** The meta
   has its own `kind` (`"image"`, `"html"`…), so the spread clobbered the
   discriminant. The detail is now NESTED, `{ kind: "artifact", artifact: meta }`,
   and D2 and D6 are edited to say so. S3 (tool) and S5 (`client/mapping.ts`)
   must build it nested.
2. **Secret check on the WORKSPACE-RELATIVE real path**, where D3 said
   `isSecretPath(real)`. With the absolute path, a workspace that itself lives
   under `~/.docker/…` or `~/.kube/…` would refuse every file. A symlink is
   still judged by its target. Pinned by M10.
3. **Additions to D3's list:** `*.pfx` and `id_dsa*` (the same class of key
   files). Matching is case-insensitive.
4. **A post-open re-confinement and an `O_NOFOLLOW|O_NONBLOCK` open**, not in
   D3, which only said "stat → regular file". Without the re-check, a
   check→open race (a parent dir swapped for a link) escapes the root. The
   residual, a swap and swap-back between the re-check and the read, is the
   same one the writes document.
5. **`artifactKindOf` stays in `@tentacle/protocol`** (S1 put it there), where
   Files item 2 listed it under `core/artifact-kind.ts`. One narrowing function,
   not two.
6. **Classification extras:** zip/gzip signatures are checked before the text
   path (`PK\x03\x04` decodes as UTF-8), and HEIC is `other` (`image/heic`, not
   every viewer renders it). An explicit text `kind` hint never turns binary
   bytes into a viewable kind.
7. **`ToolDiffDetail` alias + mobile narrowing** (item 9): Files item 2 didn't
   list these, but tsc requires them once the union grows. They are type-only
   apart from the one line in `transcript.ts`, which is pinned by M21.
8. **Changelog:** no new fragment. `changelog.d/model-artifacts.added.md` (S1)
   already covers the feature, including "confined to the workspace,
   secret-looking names refused". The brief says ONE fragment.

**Carried to S3:** the store must emit metas that pass `ArtifactMetaSchema`. In
particular `callId` ≤ 256 (round-2 review note), and `ArtifactPresentInput.callId`
is unclamped in `core`. `present` maps `WorkspaceReadError.message` to its
`isError` text, and the messages are already model-actionable.

**Gate** (worktree root):

```
$ bun run typecheck   → exit 0 (tsc --noEmit, apps/mobile, apps/relay)
$ bun run lint        → Checked 1688 files. No fixes applied. (0/0, the §6 baseline)
$ bun test            → 12172 pass, 5 skip, 0 fail (12177 tests, 876 files, 447 s)
```

The 5 skips are the same pre-existing opt-in count S1 enumerated (k8s ×2,
docker ×2, `TENTACLE_SLOW_TESTS`), and none was added here. No schema changed,
so `protocol.json` was not regenerated, and no `protocol.d/` note was written
(no wire change).

**Unverified:** the FIFO/`O_NONBLOCK` and `O_NOFOLLOW` behaviour was proven on
macOS (APFS) only. Linux semantics are the same per POSIX, but CI on Linux is
the check.

#### S2 re-verification (re-spawned executor)

*— claude-opus-5-5 (executor, S2 re-spawn), 2026-11-16*

This executor was spawned again for S2 and found the slice already built and
uncommitted in the tree. It did not re-implement anything. It re-checked the work
against the current tree and changed no production or test code:

- Narrow tests: the 7 S2 files → `80 pass, 0 fail`.
- Mutations: all 21 were re-run with the same scratch runner, and each count matches
  the table above, including M1, the plan's target (`drop within`), at
  `11 pass, 5 fail`. M4 survives as documented. M6's pattern no longer matched
  the multi-line `throw` (the runner skipped it and did not run it), so it was
  re-keyed on the `if` line alone and gave `15 pass, 1 fail` ("a file that grows
  during the read is refused, not truncated"). `git diff --stat` was identical
  before and after, so the tree was restored.
- Gate: `bun run typecheck` → exit 0 · `bun run lint` → `Checked 1688 files. No
  fixes applied.` · `bun test` → `12172 pass, 5 skip, 0 fail` (12177 tests, 876
  files, 446 s). The skips are the 5 opt-in ones, and the gate is unchanged from the S2 gate above.
- Changelog: `changelog.d/model-artifacts.added.md` (S1) is the slice's one
  fragment. No second fragment was added. No schema changed, so `protocol.json`
  was left as is.

### S3 — Store + `present` tool + daemon wiring: DONE

*— claude-opus-5-5 (executor, S3), 2026-11-16*

**Starting state, stated honestly.** This executor found S3 already built and
uncommitted in the tree, with no Execution entry: a previous S3 executor stopped
before writing one. That executor wrote the code and the tests. They were not
written red-first in this session, so non-vacuity rests on the mutation table
below: every target fails its test when the code is removed. This executor
re-verified the work against the plan, strengthened T3.7 (below) and wrote this
entry. No production code changed in this pass.

**Load-bearing check, re-run first**
(`.tentacle/tmp/model-artifacts/read-roundtrip.ts`: `RpcPeer` ↔ `RpcPeer` over
`createChannelPair` wrapped in the Noise pair, 3 MiB in 256 KiB chunks):

```
chunks=12 sha-equal=true
order=enqueue,chunk0,chunk1,chunk2,chunk3,chunk4,chunk5,chunk6,chunk7,chunk8,chunk9,chunk10,chunk11
enqueue-before-last=true maxRpcFrame=349591 maxRawNoiseFrame=87383
PASS
```

The plan asks for this check with a real `SessionHost` + `Connection`. The
scratch script stubs the daemon side. The real-daemon version is the test T3.7
(`packages/daemon/test/artifact-connection.test.ts`), which goes `present` →
`artifact/list` → 12× `artifact/read` over the Noise pair and asserts the
sha256, the RPC frame < 8 MiB and the raw Noise frame < 96 Ki chars (the relay
cap).

**As built (Files item 3, in dependency order)**

- `core/src/tool.ts`: re-exports `ARTIFACT_ID_RE`, `ATTACHMENT_NAME_RE` and
  `MAX_ARTIFACT_BYTES` from `@tentacle/protocol`, so `tools` keeps no second copy
  of the bounds.
- `daemon/src/artifact-store.ts` (new): `ArtifactBudget` (one per daemon,
  oldest-first eviction across sessions), `ArtifactStore` (snapshot copy,
  versioning, idempotent re-present, minted `a<N>` that skips model ids, every
  meta checked against `ArtifactMetaSchema` before it is stored, `callId` clamped
  to 256, 0 bytes refused, an invalid `source` dropped, `read` limited to this
  store's list and to aligned offsets with no lock) and `artifactListResult`
  (≤ `MAX_ARTIFACT_LIST`, the newest kept, `truncated`).
- `daemon/src/session-host.ts`: `artifactBudget` (`opts.artifactBytes ??
  ARTIFACT_MEMORY_BYTES`), a store per session built before the agent and passed
  as `AgentContext.artifacts`, the same store on a settings sync, and
  `artifactBytesUsed`.
- `hosted-session.ts`: `readonly artifacts`, and `close()` disposes it.
- `connection.ts`: the `artifact/list` and `artifact/read` cases through
  `this.lookup` (P8).
- `mapping.ts`: `details.kind === "artifact"` → `tool_call_update.artifact`.
- `daemon/src/index.ts`: exports the store.
- `agent/src/agent.ts`: `AgentConfig.artifacts` → `ToolContext.artifacts`.
- `agent/src/subagent.ts`: `present` is filtered out of the child registry and
  out of the type check.
- `tools/src/present.ts` (new) and `tools/src/index.ts`.
- `cli/src/wiring.ts`: `BuildAgentOptions.artifacts` registers `present`.
- `worker.ts` and `serve.ts` (`createServeAgent`, `tunnelledAgent`, both
  `podSessionHost` branches): forward `ctx.artifacts`.

**Drift from the Implementation (and why)**

1. The child filter lives in `agent/src/subagent.ts`, where the existing
   `context_reset`/`move_session` filters are. Files item 3 says `wiring.ts`.
   That was the wrong file, and `subagent.ts` is the one place the registry is
   copied (P3).
2. Files item 3 did not list `worker.ts`, `serve.ts` or `daemon/index.ts`. The
   factories must forward `ctx.artifacts`, or `present` is never offered.
   `cli/test/artifact-hosts.test.ts` pins each factory (M16 and M17).
3. The context-usage probe (`SessionHost` `contextUsage`) builds a throwaway
   store, so its tool count matches a real session's. It disposes the store in
   `finally`.
4. The `ArtifactStore` constructor has no `disk` or `sessionMaxBytes` yet. Those
   belong to S4 (D5), and S3 is memory-only on every host, `serve` included.
5. When a `ToolContext` has no `toolCallId`, the meta's `callId` falls back to
   `"present"`. The agent always sets it, so this only applies to direct calls.
6. **T3.7 was strengthened.** The inherited test sent the enqueue between
   chunks 2 and 3 and checked only that it was answered before chunk 11. That is
   a weak correlate (§2). The new mutation M19 serializes `RpcPeer`'s inbound
   requests, and that test still passed (`2 pass, 0 fail`). The test now holds
   every read from chunk 3 on until the enqueue is answered, and sends the
   enqueue after chunk 3. A serializing daemon deadlocks, and a 2 s race catches
   it. M19 now gives `1 pass, 1 fail` (`artifact-connection.test.ts`, the race
   assertion).

**Tests (T3.1–T3.7):** `daemon/test/artifact-store.test.ts` (T3.1, T3.3,
T3.4, T3.5, list cap), `tools/test/present.test.ts` (T3.1 via the tool; T3.2
too large / outside / secret, content > 2 MiB, both/neither, title/id schema,
empty file, store full, env without `readBytes`; T3.6 no sink),
`agent/test/subagent.test.ts` (T3.6 registry), `agent/test/agent-artifacts.test.ts`,
`cli/test/artifact-hosts.test.ts`, and `daemon/test/artifact-connection.test.ts`
(T3.7, the live `artifact` field, the P8 cross-connection refusal, the `unknown`
sha, the budget returned on close, the same store across a settings sync).
Narrow run: `77 pass, 0 fail` (6 files).

**Mutations** (`.tentacle/tmp/model-artifacts/s3-mut/mut.ts` and
`mut-serial.ts`). Each was applied, its tests run, then restored, and the
restore was asserted byte-equal. `git diff --stat` was the same before and after.

```
M1 read: no offset alignment check               13 pass, 1 fail
M2 budget evicts NEWEST not oldest               13 pass, 1 fail
M3 no idempotent re-present                      12 pass, 2 fail
M4 no snapshot copy                              13 pass, 1 fail
M5 read: unknown sha not refused                 18 pass, 2 fail
M6 no callId clamp                               13 pass, 1 fail
M7 no wire-schema check of the meta              13 pass, 1 fail
M8 mapping drops the artifact field              5 pass, 1 fail
M9 close does not dispose artifacts              5 pass, 1 fail
M10 settings sync builds on a NEW store          5 pass, 1 fail
M11 agent: ToolContext without artifacts         2 pass, 6 fail
M12 sub-agent registry keeps present             37 pass, 1 fail
M13 present: no sink check                       10 pass, 1 fail
M14 present: path read with the text readFile    9 pass, 2 fail
M15 present: detail spread (discriminant clobbered) 15 pass, 2 fail
M16 wiring: worker drops ctx.artifacts           4 pass, 2 fail
M17 wiring: pod proxy drops artifacts            5 pass, 1 fail
M18 wiring: present offered without a store      5 pass, 1 fail
M19 RpcPeer serializes inbound requests (T3.7)   before: 2 pass, 0 fail · after the fix: 1 pass, 1 fail
```

**Schema / version / changelog:** no protocol schema changed in S3, so
`protocol.json` was not regenerated and no `protocol.d/` note was written. The
one fragment is still `changelog.d/model-artifacts.added.md` (S1), which already
describes `present`. No second fragment was added.

**Gate** (worktree root):

```
$ bunx tsc --noEmit   → exit 0   (bun run typecheck incl. mobile + relay → exit 0)
$ bun run lint        → Checked 1700 files in 522ms. No fixes applied. (0/0, the §6 baseline)
$ bun test            → 12236 pass, 5 skip, 0 fail (12241 tests, 883 files, 445 s)
```

The 5 skips are the same opt-in ones as in S1/S2. None was added.

**Unverified:** none for this slice. The `serve` disk copy (D5) is S4's.

### S5 — Client list/read + mapping: DONE (gate RED only on S4's uncommitted files)

*— claude-opus-5-5 (executor, S5), 2026-11-16*

**Starting state.** The tree held S4 work in progress: modified
`daemon/src/session-blobs.ts` and `session-log-store.ts`, plus untracked
`daemon/src/session-artifacts.ts` and `daemon/test/artifact-manifest.test.ts`
(last written 09:41; no S4 executor running; no S4 Execution entry). S5 touches
none of these files and they were left exactly as found. They are the only
cause of the red gate below.

**Load-bearing check, re-run first:**

```
$ bun .tentacle/tmp/model-artifacts/read-roundtrip.ts
chunks=12 sha-equal=true
order=enqueue,chunk0,chunk1,…,chunk11
enqueue-before-last=true maxRpcFrame=349591 maxRawNoiseFrame=87383
PASS
$ bun test packages/daemon/test/artifact-connection.test.ts   → 6 pass, 0 fail
```

**As built, in order:**

1. `packages/client/test/read-window.test.ts` (new, 11 tests) — RED: module absent.
2. `packages/client/src/read-window.ts` (new, pure): `ReadWindow` (window 2;
   `next` → `read{offset}` | `wait` | `done`; `accept` checks the reply's `size`
   against the META's, then the base64 TEXT length, then strict decode (canonical
   only), then the decoded length, and only then copies into a buffer sized from
   the meta; `rewind` forgets in-flight reads, so the next read is the first
   MISSING chunk; `finish` requires every chunk and the sha256). Errors:
   `ArtifactCorruptError`, `ArtifactReadAbortedError` (`name: "AbortError"`),
   `ArtifactLinkLostError`. The constructor refuses a non-integer, 0 or
   > `MAX_ARTIFACT_BYTES` size with `RangeError` before any buffer exists. → 11/11 green.
3. `packages/client/test/mapping.test.ts` +1 test (T5.5). RED on its assertion
   (`details` undefined), then `client/src/mapping.ts` `tool_call_update`:
   `update.artifact` → `details: { kind: "artifact", artifact }` (nested). Green.
4. `packages/client/test/artifacts.test.ts` (new, 15 tests): T5.1 against a
   real `SessionHost` + `Connection` (bytes presented daemon-side, then list +
   verified read, progress, two concurrent reads, the daemon's
   `ArtifactUnavailable` passed through). T5.2: a tapped `Dialer` drops the link
   right after the 3rd answer; chunks 0–2 are read exactly once and the first
   read on the new link is chunk 3. An abort mid-read issues no further read; an
   already-aborted signal issues zero reads. T5.3 against a fake daemon: an honest
   control, then a short chunk (not retried), wrong bytes, another `size`, a
   2 GiB `size` (refused by the wire schema), a meta over the cap (`RangeError`,
   zero reads). T5.4: `MethodNotFound` on list and on read →
   `ArtifactsUnsupportedError`; `truncated` passed through. RED at load (exports
   absent).
5. `packages/client/src/remote-client.ts`: `ArtifactsUnsupportedError` +
   `ARTIFACTS_OLD_DAEMON`, `ArtifactReadOptions`, `listArtifacts` (read-only;
   waits out a drop with a factory, like `snapshot`), and `readArtifact` +
   `pullArtifact` + `issueArtifactRead`, the `upload()`/`pump` idiom (a failing
   read is captured, rethrown after its siblings settle, then `rewind` → resume).
   An abort wakes a pending wait at once (the race includes the signal).
   Corrupt/abort errors are final, never retried. `liveGeneration` and
   `throwIfAborted` take an optional `LinkErrors` (default: the upload's), so a
   read reports `ArtifactLinkLostError` / `ArtifactReadAbortedError` and not
   upload words. Uploads are unchanged. `client/src/index.ts` exports
   `read-window.ts`. → 51/51 green on the three files; `bun test packages/client`
   790 pass, 0 fail.

**Drift from Implementation (and why):**

- `listArtifacts` returns `ArtifactListResult` (`{ artifacts, truncated? }`), not
  `ArtifactMeta[]`. Returning only the array would silently drop the wire's
  `truncated`. D6 is updated to match. **S6a/S9 use `.artifacts`.**
- `packages/transport/src/index.ts` now also exports `decodeBase64`. That file is
  not in Files item 5. It is the existing strict, canonical-only decoder of the
  Noise framing, reused so a pod cannot pass two different texts for one chunk.
- A reply that fails the wire schema (e.g. a 2 GiB `size`) reaches the caller as
  the peer's `RpcError` ("invalid result for artifact/read"), not as
  `ArtifactCorruptError`. It is rejected either way and nothing is sized from it.
  A UI shows "couldn't verify" for both (S6a/S9).
- No changelog fragment was added: `changelog.d/model-artifacts.added.md` (S1)
  already describes the verified, resumable chunked read. The rule is one
  fragment per slug+category.

**Mutations** (each applied, run on `artifacts.test.ts` + `read-window.test.ts`,
reverted; `grep -c "false &&"` = 0 after):

```
M1 (plan target) skip the sha256 check in finish   24 pass, 2 fail (wrong bytes: client + window)
M2 skip reply.size === meta.size                   24 pass, 2 fail (other size: client + window)
M3 skip both chunk-length checks                   23 pass, 3 fail (short chunk ×2, long chunk)
M4 rewind also forgets held chunks (restart at 0)  24 pass, 2 fail (drop resumes at chunk 3 ×2)
M5 drop the in-loop abort check                    14 pass, 1 fail (abort issues no further read)
T5.5 shown red before its code (no mapping)        24 pass, 2 fail (the T5.5 assertion; + artifacts.test.ts at load)
```

**Schema / version:** no protocol schema changed (S1 made all the wire
changes), so `protocol.json` was not regenerated and there is no `protocol.d/` note.

**Gate** (worktree root):

```
$ bunx tsc --noEmit     → 24 errors, ALL in S4's WIP: daemon/src/session-artifacts.ts (1),
                          daemon/src/session-log-store.ts (2), daemon/test/artifact-manifest.test.ts (21);
                          0 in packages/client or packages/transport
  tsc -p apps/mobile    → 2 errors, both daemon/src/session-log-store.ts (S4 WIP); tsc -p apps/relay → 0
$ bun run lint          → 1 error: formatting in daemon/test/artifact-manifest.test.ts (S4 WIP); S5 files clean
$ bun test              → 12336 pass, 5 skip, 6 fail (12347 tests, 891 files, 446 s);
                          all 6 fails are "LogSessionStore artifacts (T4)" in artifact-manifest.test.ts
```

The 5 skips are the same count as S3's (the opt-in ones). The gate goes green
once S4 is finished or that WIP is set aside. This executor did neither (only
S5 was in scope).

**Unverified:** that the gate is green with S4 finished. To check: re-run `bun run
check` after S4's executor lands its slice.

## Review

*— claude-opus-5-5, 2026-11-16* (fresh-context reviewer; a different model family from the S1 executor, deepseek-v4-pro)

### S1 — Protocol: REQUEST-CHANGES (2 MEDIUM, both small)

**Scope:** `git diff main...HEAD`, slice S1 only (protocol + its tests + changelog fragment).

**Gate:** `bun test packages/protocol` → 440 pass, 0 fail (46 files); `bun run lint` →
clean (1664 files); `bun run typecheck` → clean (root, mobile, relay).

**Findings**

1. **MEDIUM — vacuous test for the per-chunk cap** (`packages/protocol/test/artifact.test.ts:203-205`,
   cap at `packages/protocol/src/artifact.ts:135`). The over-cap case is `${chunk}AAAA` where
   `chunk` = base64 of 256 KiB. 262 144 mod 3 = 1, so `chunk` ends in `==`, and the
   `={0,2}$` regex refuses the string mid-padding — the `.max(ATTACHMENT_CHUNK_B64_MAX)`
   is never what fails it. Mutation M6 (drop `.max(ATTACHMENT_CHUNK_B64_MAX)`) → **0 fail**.
   This is the bound a hostile pod's `artifact/read` reply hits, and §9 says a test that
   passes on both is no proof. Fix: an over-cap string that is valid base64, e.g.
   `"A".repeat(ATTACHMENT_CHUNK_B64_MAX + 4)`, and show it red under M6.
2. **MEDIUM — `ArtifactReadResultSchema.size` is unbounded** (`packages/protocol/src/artifact.ts:137`).
   The module header (`:13-21`) claims "every field is bounded … neither a client nor a UI can
   be made to buffer more than [20 MiB]", but a read reply's `size` takes any positive integer.
   Failure: a pod answers `artifact/read` with `{data:"…", size: 2_147_483_648}`. A client
   (S5) that sizes its buffer or its progress from the read result rather than the meta gets
   a 2 GiB announcement through the schema. Fix: `.max(MAX_ARTIFACT_BYTES)` plus a test.
   S5 must still check that `size === meta.size`. Note it in the plan's T5.

**Mutation (non-vacuity), each reverted, `git status` clean afterwards:** M1 drop the `artifact`
field → 3 fail · M2 no size cap → 2 · M3 id allows `/` `.` → 1 · M4 `artifactKindOf`
passthrough → 1 · M5 title without the control-char check → 2 · M6 no chunk cap → **0 (finding 1)** ·
M7 no list cap → 1 · M8 `source` without the control-char check → **0** (nothing tests `source`'s
control chars; add one with finding 1) · M9 read `sha256` free → 1.

**Premises checked:** P5 (`ToolCallUpdateSchema` is a strip object, so an older client drops
`artifact`): TRUE, and the test's `.omit` emulation holds. `UPDATE_CLASS.tool_call_update ===
"display"`: TRUE. `-32020` is unique and free: TRUE. The chunk constants reuse
`attachment-upload.ts:26-29`: TRUE. The relay round-trip (load-bearing assumption 2–3) is S3's
repro and is not verifiable in S1.

**Attacks tried**
- *Older client vs a new frame:* stripped, parses. Holds.
- *An invalid nested meta kills the whole `tool_call_update`:* `classifyUpdate`
  (`client/mapping.ts:63-67`) turns a malformed known type into a turn error. That is loud,
  not silent, so it is by design, but S2 must emit only metas that pass `ArtifactMetaSchema`.
  In particular `callId` is capped at 256 (`artifact.ts:80`) while `toolCallId` is unbounded
  (`updates.ts:58`), so S2 must clamp or check it. Not a finding for S1.
- *Future loosening:* raising `MAX_ARTIFACT_BYTES` or widening `ARTIFACT_ID_RE` later makes
  older clients fail the turn (finding: none now). It is a meaning change and needs a
  `protocol.d/` note. Worth one line in Notes/debt.
- *Bidi/format chars in `title`:* `ATTACHMENT_NAME_RE` blocks only `\p{Cc}`. Same as the
  existing attachment-name rule, so not new in S1.

**Executor behaviour:** clean, scoped and honest. The two drifts (`protocol.json` refreshed
on the branch via `protocol:bump`; changelog written in S1, not S9) are declared and harmless.
Its tests are mostly non-vacuous (7/9 mutations caught), but it did not mutation-check the
cap it most needed to.

### Fix round 1

*— claude-opus-5-5, 2026-11-16*

Both findings FIXED, each with a test shown RED before the fix and a
mutation-check after it (§9). No other behaviour changed; the tree's only
production edit is ONE added bound in `artifact.ts` (plus the docstring above it
and the regenerated `protocol.json`); everything else is test.

**Finding 1 — MEDIUM, vacuous per-chunk-cap test. FIXED.**
`packages/protocol/test/artifact.test.ts:210-216`: the over-cap case is now
`"A".repeat(ATTACHMENT_CHUNK_B64_MAX + 4)` — valid, unpadded base64, so the
padding regex accepts it and only `.max` can refuse it. (The right bound is also
asserted to PASS at exactly `ATTACHMENT_CHUNK_B64_MAX`, so the case cannot go
green by the cap being wrong in the other direction.) **M6 re-run (cap dropped at
`artifact.ts:142`): `19 pass, 1 fail`, failing at `artifact.test.ts:216:84` — the
assertion of the cap, not an import/compile error.** Reverted; `git diff` clean
of the mutation.

The same round also closes M8 (0 fail in the review), which the review folded
into finding 1: `packages/protocol/test/artifact.test.ts:73-78` is a new case for
`MetaSchema.source` — `"a\nb"`, `"a\tb"`, `"x\u001b[2J"`, `"a".repeat(513)` all
refused, `"docs/a.html"` accepted. **M8 re-run (`source`'s `regex(ATTACHMENT_NAME_RE)`
dropped at `artifact.ts:85`): `19 pass, 1 fail` at `artifact.test.ts:75:52`.**
Reverted.

**Finding 2 — MEDIUM, unbounded `ArtifactReadResultSchema.size`. FIXED.**
`packages/protocol/src/artifact.ts:144` — `.max(MAX_ARTIFACT_BYTES)`, and the
docstring above it says why (a client may size a buffer from the read reply, so
a 2 GiB announcement must fail to parse; S5 still checks `size === meta.size`).
Test: `artifact.test.ts:218-223` — `size` of `0`, `-1`, `1.5`, `maxBytes + 1`
and `2_147_483_648` refused, `maxBytes` accepted. **Red before the fix:**
`bun test packages/protocol/test/artifact.test.ts` → `19 pass, 1 fail`, at
`artifact.test.ts:221:63` (the `size` loop). **M2' (the new cap dropped):
`19 pass, 1 fail`, same line 221.** Reverted → `20 pass, 0 fail`.

**Consequent: generated schema.** The `size` bound changes the exported JSON
Schema, so the drift gate (`packages/protocol/test/json-schema.test.ts`) went
red on the zod edit alone (`440 pass, 1 fail`, "protocol.json is stale").
`bun run schema:export` regenerated it — a one-line diff, `"maximum": 20971520`
on the read result's `size`. No hand-edit, and no `PROTOCOL_VERSION` move: a
narrowed bound on a NEW field of a NEW method is not a break for any peer that
existed before it (there is no peer that ever sent an unbounded `size`).

**Plan note (the review asked for it):** T5 (`docs/feat/model-artifacts.md:576-580`)
now states that the read reply's `size` is bounded on the wire *and* still
checked against `meta.size` before sizing anything.

**Gate** (worktree root, after the fixes):

```
$ bunx tsc --noEmit    → exit 0
$ bun run lint         → Checked 1664 files in 459ms. No fixes applied. (0/0 — the §6 baseline)
$ bun test             → 12028 pass, 5 skip, 0 fail (12033 tests, 860 files, 446 s)
```

The 5 skips are the same pre-existing opt-in gates the S1 executor enumerated
(k8s ×2, docker ×2, `TENTACLE_SLOW_TESTS`), re-checked here one file at a time:
`5 skip, 0 fail` across those six files, none added by this round.
`packages/protocol` alone: `441 pass, 0 fail` (was 440 — the new `source` case).

**Unverified / next:** unchanged from S1 — the read path (chunked `readArtifact`,
resume, sha256) is S5's, and T5.3's "never buffers > `meta.size`" is S5's test,
not this slice's; this round only pins the wire bound it relies on.

### Round 2

*— claude-opus-5-5, 2026-11-16* (same fresh-context reviewer as round 1; a different model family from the executor)

**Verdict: PASS.** Both round-1 findings are fixed, and the fix diff (`bbd4058b`) introduces no regressions.

- **Finding 1 (vacuous chunk-cap test): fixed.** The test now uses `"A".repeat(ATTACHMENT_CHUNK_B64_MAX + 4)`, which is valid base64, so only the cap can reject it. `B64_MAX` = 349 528, a multiple of 4. Mutation M6 (drop `.max(ATTACHMENT_CHUNK_B64_MAX)`) went from 0 to **1 fail**.
- **Finding 2 (unbounded read `size`): fixed** at `artifact.ts:144` with `.max(MAX_ARTIFACT_BYTES)`. `protocol.json` regenerated (`maximum: 20971520`). New mutation M10 (drop that max) → **1 fail**.
- **`source` gap: fixed.** M8 (drop the control-char check) went from 0 to **1 fail**. New M11 (drop `.max(512)`) → **1 fail**.
- **Regression sweep:** M1–M11 each make at least one test fail. Each mutation was reverted, and `git status` was clean afterwards. The fix diff touches only the read-result schema, its tests and the regenerated JSON. Nothing else on the wire changed.
- **Gate:** `bun test packages/protocol` → 441 pass, 0 fail. `bun run lint` clean (1664 files). `bun run typecheck` clean.
- **Carried to S2/S5 (not S1 findings):** S2 must keep `callId` ≤ 256 characters. S5 must still check that the read's `size` equals `meta.size`.

## Review

*— claude-opus-5-5, 2026-11-16*

### S2 — Binary confined read + pure kind/card/CSP helpers: PASS (no HIGH/MEDIUM)

This was a fresh-context review of `git diff main...HEAD`, limited to S2. The reviewer is the same model family as the S2 executor, so blind spots the two share can survive both passes.

- **Gate (narrow):** the 7 S2 test files → `80 pass, 0 fail`. `bun run lint` → `Checked 1688 files … No fixes applied.` `bun run typecheck` → clean. The full `bun test` was not re-run here; Execution reports `12172 pass, 5 skip`.
- **Mutations** (`.tentacle/tmp/model-artifacts/rev-s2/mut.ts`; each one was reverted, and the tree stayed clean):
  - drop `within` (the plan's target) → 5 fail
  - judge the secret check on the link path instead of the target → 2 fail
  - drop the post-read length check → 1 fail
  - make the size cap off by one → 1 fail
- **§7 "what leaves the workspace" (`host-execution.ts` `readBytes`/`confineRead`):** the code checks, in order: the real path, then root-only `within`, then the secret check on the workspace-relative target, then an `O_NOFOLLOW|O_NONBLOCK` open, then `fstat` is a regular file, then a re-confine with a dev/ino match, then size before the read, then length = size. Every listed failure mode (T2.1–T2.5) is pinned. A path with the wrong case on macOS is refused, never let through.
- **Attacks that found nothing:**
  - A hardlink to `~/.ssh/id_rsa` inside the workspace is read. Making one needs an approved shell command, and that command could just as well `cp` the key, so nothing new is exposed.
  - `.ENV` and `.env.` are refused.
  - A text `kind` hint never overrides binary magic.
  - The CSP prefix comes first, and the offline policy has no `media-src`, so media falls back to `default-src 'none'`.
  - A blob worker is blocked, because `worker-src` falls back to `script-src 'unsafe-inline'`.
  - Nested `details` keeps the discriminant. Its consumers narrow it, and the mobile line is pinned.
- **Carried forward:**
  - **S6b:** an SVG wrapped with the HTML prefix must be written as `.html`. Under `.svg`, the meta CSP is not honoured, and the file is no longer valid XML.
  - **S3:** clamp `callId` to ≤ 256 characters, and refuse a 0-byte file, because `ArtifactMetaSchema` refuses `size` 0.
- **Executor behaviour:** the report is honest. Documented drift (nested detail, relative-path secret check) matches the code, and the surviving M4 mutation is explained correctly.

## Review

*— claude-opus-5-5, 2026-11-16*

### S3 — Store + `present` tool + daemon wiring: PASS (no HIGH/MEDIUM)

This was a fresh-context review of `git diff main...HEAD`, limited to S3. The reviewer is the same model as the S3 executor (only the context is fresh), so blind spots the two share can survive both passes.

- **Gate (narrow):** the 6 S3 test files → `77 pass, 0 fail`. `bun run lint` → `Checked 1700 files … No fixes applied.` `bun run typecheck` → clean. The full `bun test` was not re-run here.
- **Reviewer mutations** (`.tentacle/tmp/model-artifacts/rev-s3/mut.ts`, on `artifact-store.ts`; each was reverted, the file came back byte-equal, and `git status` stayed clean):
  - `evicted()` keeps the blob → 2 fail
  - the idempotent re-present skips restoring an evicted blob → 1 fail
  - the `offset >= size` check is dropped → 1 fail
  - The executor's M1–M19, including M19 (a serialized `RpcPeer` deadlocks T3.7), match the tests as written.
- **§7 invariants:**
  - **Don't serialize the RPC peer: holds.** `artifact/list` and `artifact/read` take no lock (`connection.ts:462-469`), and T3.7 deadlocks under serialization.
  - **Connection scoping (P8): holds.** Both cases go through `this.lookup`.
  - **Pod not trusted:** pod metas stay in the pod store. Nothing is gated on the laptop in S3, and the laptop-side checks belong to S5.
  - **Persistence:** `details` are not written to `ChatMessage`, and `toolResultContent` is unchanged, so no log format changed.
- **Attacks that found nothing:**
  - A negative or unaligned offset: refused by `ArtifactReadParamsSchema` (`nonnegative().int()`) and the alignment check.
  - A sub-agent reaching the store: the child `Agent` is built without `artifacts`, `present` is filtered out by name in both places, and no config-spreading clone of an `Agent` exists.
  - A settings sync losing the store: the rebuild reuses the same store (`hosted.artifacts`).
  - The context-usage probe leaking budget: its throwaway store charges nothing and is disposed in `finally`.
  - Cross-session eviction while another session is mid-read: the read answers `evicted`, which is the planned behaviour.
- **Nit (LOW, not blocking; for S5/S6a):** re-presenting the same `id` with the same bytes returns the PRIOR meta (`artifact-store.ts:154-158`). That meta keeps the earlier call's `callId` and `title`, so after a reload the second call's row joins no card. A joiner keyed on `callId` must accept this, or the store must record the new `callId`.
- **Executor behaviour:** the report is honest. It admits the code was inherited without red-first and makes up for it with mutations. The drift (child filter in `subagent.ts`, the factories forwarding the store) is real and was needed.

## Review

*— claude-opus-5-5, 2026-11-16* (fresh context; same model as the S5 executor, so blind spots may be shared)

### S5 — Client list/read + mapping: PASS (no HIGH/MEDIUM in S5 code)

- **Tests:** `artifacts.test.ts` + `read-window.test.ts` + `mapping.test.ts` → 51 pass, 0 fail.
- **Mutation (the plan's target):** skip the sha256 check in `ReadWindow.finish` → 24 pass, 2 fail ("right lengths, wrong bytes" in client and window). Reverted from a scratch copy; `git status` is clean.
- **Gate:** `bun run lint` → 1 error, and `bun run typecheck` → 24 errors. All of them are in S4's work in progress (`daemon/src/session-artifacts.ts`, `session-log-store.ts`, `daemon/test/artifact-manifest.test.ts`). Commit `72e5d036` committed that work together with S5. There are 0 errors in `packages/client` or `packages/transport`. **This is not an S5 finding, but it blocks the merge:** S4 must be finished, or its files taken out of the commit, before `bun run check` can pass.
- **Attacks tried (none found a HIGH/MEDIUM):**
  1. Hostile pod: every reply is checked before it can size or fill anything. The buffer is sized from `meta.size` (`read-window.ts:79-86`). The reply's `size` is compared with the meta's. The base64 length is checked before decoding, decoding is strict, and the decoded length is checked too. The client's chunk size (`min(C, size-offset)`) matches the daemon's slicing (`artifact-store.ts:193-199`).
  2. Drop/abort races in `pullArtifact`: every task resolves, and its failure is captured and rethrown only after `allSettled`. A failure always stops new reads before the next `next()`, and `rewind` runs only after the pull returns. An abort wakes the race and stops new reads. The answers still in flight land in a window that is then thrown away. No loop runs forever: each retry either gets a new answer, which accepts a chunk, or runs into the reconnect deadline.
  3. Mapping: `details.kind === "artifact"` does not break any consumer. Every reader checks the kind first (`daemon/mapping.ts:233`, `tui/render-lines.ts:461`, `tui/commands.ts:521`, `mobile/transcript.ts:505`). `present` produces no diff detail for it to overwrite.
  4. §7 pod trust: the sha256 check only shows that the bytes match the meta, and the meta also comes from the pod. That is the intended scope (it proves consistency, not where the bytes came from). Opening pod bytes safely is S6b/S8's job.
- **Executor behaviour:** the report is accurate. The drift it lists (`ArtifactListResult`, exporting `decodeBase64`) is real and justified. The one thing it got wrong: it says it "left exactly as found" S4's work in progress, yet that work went into the same commit.

### S6a — TUI card + `/artifacts` panel: DONE

*— deepseek-v4-pro (executor, S6a), 2026-11-16*

**Load-bearing check, re-run first** (`.tentacle/tmp/model-artifacts/read-roundtrip.ts`,
worktree root, unchanged by this slice):

```
$ bun .tentacle/tmp/model-artifacts/read-roundtrip.ts
chunks=12 sha-equal=true
order=enqueue,chunk0,chunk1,…,chunk11
enqueue-before-last=true maxRpcFrame=349591 maxRawNoiseFrame=87383
PASS
```

**Starting state.** The tree carried S4's work in progress (`daemon/src/session-artifacts.ts`,
`daemon/src/session-log-store.ts`, `daemon/src/session-blobs.ts`,
`daemon/test/artifact-manifest.test.ts`) — the same files S5 recorded. S6a touches
none of them and left them exactly as found; they are the only cause of the
non-green gate below.

**As built, in order** (red shown before each green):

1. `packages/tui/test/artifacts-panel.test.ts` (new, 21 tests) — RED at load
   (`Cannot find module '../src/panels/artifacts.ts'`).
2. `packages/tui/src/artifacts-panel.ts` (new, pure): `artifactGroups` (one group
   per `artifactId`, NEWEST PRESENTED first by its newest version's `createdAt`,
   versions newest-first, a `createdAt` tie broken on the id so two daemons
   reporting one millisecond still order stably), `artifactsTreeGroups` (a head
   per artifact + its other versions as children), `artifactsTitle`
   (`artifacts · 5`, `+` when the daemon cut the list), `artifactsView` (rows, or
   the honest `loading…` / `No artifacts in this session.` note), `artifactAt`
   (the ONE `enter` decision: the meta UNDER the cursor — a head is its newest
   version, a folded child is `versions[child + 1]`), `artifactsByCall` (the
   resume join keyed on `callId`, newest version winning), `needsArtifactJoin`
   (only a `present` row still waiting for its card asks the daemon at all),
   `withArtifactDetails` (same array back when nothing joined),
   `artifactsListError` (an older daemon is a fact, not a stack trace).
3. `packages/tui/src/panels/artifacts.ts` (new): the descriptor — `view`, `apply`,
   `click` through the shared tree mechanic, and a `key` that turns `enter` into
   the `openArtifact` EFFECT carrying the decided meta (never an index the App
   resolves again) and answers `switch` with `NOTHING` (Space has no meaning on
   an artifact). One registry line in `panels/registry.ts`; one field + the
   `artifactsPanel` constructor in `panels/types.ts`; re-exported by `panel.ts`.
4. `packages/tui/src/keys/effects.ts` + `execute.ts`: the `openArtifact` effect
   and its one host call. `keys-execute.test.ts` did not need a row (the effect
   carries a meta object; its wiring is pinned end-to-end by T6a in
   `app-artifacts.test.tsx` instead).
5. `packages/tui/test/artifact-card.test.ts` (new, 16 tests) — RED on its
   assertions (no card; `messagesToItems` took no map). Then
   `packages/tui/src/render-lines.ts`: `artifactBody` — ONE row under the tool
   header, `▣ <title>  <line2> · ^X^O open`, cut by CELLS so it cannot wrap into a
   second row (`truncateCells`; the title keeps its room first, so a narrow
   terminal loses the tail, never the name); `other` offers
   `s · save to ~/Downloads` and never `open`; the `pod` mark comes from the
   RUNTIME (`RenderOptions.spillInPod`, the one "this daemon runs in a pod" the
   renderer already receives), never from the meta. `resume.ts` `messagesToItems`
   gained the optional `artifactsByCall` and joins the card's detail onto the
   row its `callId` names. `core/src/tool-labels.ts` += `present: "Present"`.
6. `packages/tui/test/app-artifacts.test.tsx` (new, 9 tests, ink frames) — RED.
   Then the wiring: `SessionController.listArtifacts?()` + `readArtifact?()`,
   `AppProps.openArtifact`, `commands/artifacts.ts` + one registry line, the
   `openArtifact` host method in `App.tsx` (absent seam → `NO_ARTIFACT_OPENER`,
   never a silent swallow), and the mount join inside the EXISTING watch effect
   (no new `useEffect`: the 22-effect pin holds).

**Registry pins updated (each a decision the slice makes, not a drive-by):**
`commands-registry.test.ts` and `app-commands.test.tsx` (18 → 19 built-ins),
`panels-registry.test.ts` (the fourth kind), `app-panels-structure.test.tsx` (the
registry line, now read as a LIST so a fourth entry does not need a literal
rewrite), `app-session-link-structure.test.ts` (the watch effect's deps), and the
cli's `subagent-panel-controller.test.ts` GUARD (both new controller members —
that guard is what caught `readArtifact` being declared in the plan's Files item
but never exposed on the controller; `RemoteSession`, `PersistingController`, the
runtime wrapper and the guard's expected list now all carry it).

**Drift from Implementation (and why):**

- **`RenderOptions.spillInPod` carries the pod origin, not a per-item field.** The
  plan's D7/D8 put `"from the pod"` on the card, and the natural first cut was an
  `ToolItem.artifactOrigin: "local" | "pod"` field. That is a value a
  pod-supplied meta could influence, and it duplicates a fact the renderer is
  already given (the runtime's `daemonInPod`, threaded as `spillInPod`). The
  origin is now read from the runtime alone. `ToolItem` gained no field at all:
  the planned `artifactState` is S6b's (only a REFUSED READ establishes
  `unavailable`), so adding it now would have been dead code.
- **The mount join is conditional (`needsArtifactJoin`).** Unconditional, every
  session — a fresh one, one with no `present` row — made an `artifact/list` call
  at mount (caught by T6a's own `seen` assertion, which saw two lists for one
  command). It now asks only when a `present` row is still waiting for its card,
  so the resume path is free where it can change nothing.
- **`artifactsPanel(view, now)` takes the list and the stamp separately**, not a
  `{artifacts, now}` object: `now` is the PANEL's read time, not the daemon's
  answer, and mixing it into `ArtifactsData` made `truncated` a field of two
  different things.
- **`app-panels-structure.test.tsx` reads the registry LIST, not a literal.** The
  literal was a one-line `[a, b, c]` at three kinds; at four, Biome formats it
  across lines, and a literal pin would then fail for a FORMATTING reason rather
  than a wiring one. It now counts one `<kind>Kind` per kind inside the list.
- **`panels/tree.ts` `withTree` is generic over any `{ tree }`** (was `<P extends
  TreePanel>`): `/artifacts` is a tree-mimic panel with its own `kind`, and
  narrowing it to `TreePanel` would have meant a second copy of the same
  identity-preserving write.

**Mutations** (each applied, run on the named files, reverted; `git diff` on the
touched files afterwards showed only the real change, and `grep -c 'if (false)'`
= 0 on both mutated modules). Script: `.tentacle/tmp/model-artifacts/s6a-mut.sh`.

```
M1 (plan target) enter ignores the folded version     28 pass  1 fail
M2 (plan target) groups keep the wire order            28 pass  1 fail
M2b sort reversed                                      25 pass  4 fail
M3 (planned)     join keeps the FIRST version          28 pass  1 fail   [see note]
M3' (replacement) join keys on artifactId, not callId  28 pass  1 fail
M4 (plan target) card never offers save                27 pass  2 fail
M5               old-daemon message stops naming one   28 pass  1 fail
M6               join overwrites an EXISTING detail    28 pass  1 fail
M7               Enter never reaches the opener         8 pass  1 fail
M8               pod mark dropped                      28 pass  1 fail
```

*Note on M3:* `meta.version >= seen.version` → `>` survived, and it is a VACUOUS
mutation, not a weak test — two versions of one artifact never share a number, so
`>` and `>=` accept exactly the same inputs. It is replaced by M3' (key the map on
`artifactId` instead of `callId`), which fails as it should. The "newest version
wins" property itself is pinned by the order-independence case in
`artifact-card.test.ts` (`artifactsByCall([v2, v1])` returns v2), which M2b does
not cover: M2b is the GROUP order, that one is the JOIN's choice.

**Red-before-green, explicitly:** the format and resume tests were RED on their
own assertions on the unmodified tree (7 fails in `artifact-card.test.ts`: no
card row, no `v2`, no save tail, no pod mark, and the join absent), the panel
tests were RED at module load, and the frame tests were RED on the missing card,
the missing command and the missing opener — each captured above in the order
they were written.

**Schema / version / changelog:** no protocol schema changed (S1 made every wire
change; this slice only CONSUMES `ArtifactListResult`/`ArtifactMeta`), so
`protocol.json` was not regenerated and there is no `protocol.d/` note.

`changelog.d/model-artifacts.changed.md` (new, one bullet). S1's
`model-artifacts.added.md` is this slug's `added` bullet and it describes the
`present` tool, the store and the wire — not the Mac surface this slice builds.
A second bullet under the same slug but a DIFFERENT category is a different
filename, so nothing collides (AGENTS §10: two tasks collide only by reusing one
slug+category), and it keeps the release note honest: what a Mac user gains here
(the card, the resume join, `/artifacts`, the save-only path) is a change to the
TUI, not another new capability. `scripts/test/changelog-guard.test.ts` +
`changelog.test.ts` → 21 pass on it.

**Gate** (worktree root):

```
$ bunx tsc --noEmit   → 24 errors, ALL in S4's WIP (daemon/src/session-artifacts.ts,
                        session-log-store.ts, daemon/test/artifact-manifest.test.ts);
                        0 in tui, core, client, cli
$ bun run lint        → 1 error, formatting in daemon/test/artifact-manifest.test.ts (S4 WIP);
                        every S6a file clean
$ bun test packages/tui     → 2381 pass, 0 fail (169 files)
$ bun test packages/cli     → 3408 pass, 2 skip, 0 fail (232 files)
$ bun test packages/client  → 790 pass, 0 fail
$ bun test packages/core    → 387 pass, 0 fail
$ bun test (full)           → 12374 pass, 5 skip, 6 fail (12385 tests, 894 files, 441 s);
                              all 6 fails are "LogSessionStore artifacts (T4)" in
                              artifact-manifest.test.ts (S4 WIP, `putArtifact` absent)
```

The 5 skips are the same opt-in ones as S3/S5's. Every S6a test is green.

**Unverified:** a green `bun run check` — the same blocker S5 recorded, because
S4's WIP is still in the tree (this executor was told to implement S6a only, and
does not touch, stash or commit another slice's files). To check: re-run
`bun run check` once S4 lands.

### S6b — TUI opener (temp files, CSP wrap, pod confirm, chord): DONE (gate RED only on S4's committed daemon files)

*— claude-opus-5-5 (executor, S6b), 2026-11-16*

**Load-bearing check, re-run first** (unchanged script):

```
$ bun /Users/gmeghnag/tentacle/.tentacle/tmp/model-artifacts/read-roundtrip.ts
chunks=12 sha-equal=true
order=enqueue,chunk0,chunk1,…,chunk11
enqueue-before-last=true maxRpcFrame=349591 maxRawNoiseFrame=87383
PASS
```

**Starting state.** Tree clean at `0422f7c3`. S4's daemon files (committed in
`72e5d036`) still fail `tsc` (24) and Biome (1); S6b touches no daemon file
(`git diff --quiet HEAD -- packages/daemon` holds).

**As built, in order** (each test file RED before its code):

1. `tui/test/artifact-open.test.ts` (18) — RED at load (module absent). Then
   `tui/src/artifact-open.ts` (pure): `openPlan(meta, origin, intent)` →
   `{kind: open|confirm|save-only, file: "<sha8>.<ext>"|null, wrap: csp|null, network}`,
   the extension from OUR map only (`png jpg gif webp heic` by mime, `html` for
   html AND svg, `pdf md txt`; any other image mime and `other` → `save-only`);
   `artifactStep` (the ONE decision per key: notice / confirm / open / save);
   `saveName` (the source's or title's last segment, its own extension DROPPED,
   `[A-Za-z0-9 ._-]`, no leading dot, then OUR extension: open map, else
   `zip gz tar json csv txt` by mime, else `bin`); `wrapArtifactBytes` (CSP prefix
   as the first bytes); `newestArtifact(items)` (the chord's target).
2. `tui/test/os-open.test.ts` (9) — RED at load. Then `tui/src/os-open.ts`:
   `createArtifactOpener(deps)` — ONE lazy `mkdtemp` dir under `os.tmpdir()`
   (`tentacle-artifacts-*`), removed by a `process.once("exit")` handler; file
   `0600`; `Bun.spawn(["open"|"xdg-open", path], {stdio: ignore×3})`, a non-zero
   exit rejects; it re-checks the plan file against `^[0-9a-f]{8}\.[a-z]{2,4}$`
   before any write. `save` writes to `~/Downloads` with `wx`, `name (n).ext` on a
   clash, and refuses a name with a separator or a leading dot.
3. Chord: `chord.test.ts` + `keys-layers.test.ts` rows RED on their assertions.
   `chord.ts` gains the `openArtifact` action (`Ctrl+X` then `Ctrl+O` in the
   window; a bare `Ctrl+O` still passes to the expand toggle);
   `layer-precedence.ts` maps it to the `openNewestArtifact` effect.
4. Confirm: `keys-layers.test.ts` "artifact-confirm" (5) RED. New layer
   `artifactConfirmLayer` right after `quitConfirm`, BEFORE the chord and the
   permission prompt (only a plain `y` is yes, `quitConfirmKey`'s rule); its
   `KeySnapshot.artifactConfirm()` getter, `KeyLayerName`, `PURE_LAYERS`,
   `LAYER_ORDER` (now 16, pinned in `keys-route.test.ts` with the reason), the
   `answerArtifactConfirm` / `openNewestArtifact` effects + `KeyHost` methods
   (`keys-execute.test.ts` rows). `app-layout.ts`: `confirmShown` = quit OR
   artifact confirm drives the four sites that were `quitConfirm !== null`
   (`app-layout.test.ts` pins the slot: 3 rows, no dock). `AppView.tsx` paints it
   with the existing `QuitConfirm` row.
5. Panel: `artifacts-panel.test.ts` (2) RED. `panels/artifacts.ts`: plain `s` →
   `openArtifact{intent:"save"}`, `n` → `{intent:"network"}` on the meta under
   the cursor; `ARTIFACTS_HINT` names both.
6. App: `app-artifacts.test.tsx` (10 new, ink frames) RED — the App threw on the
   missing snapshot getter, then on its assertions. `App.tsx`: `runArtifact`
   (a thin executor of `artifactStep`: notice → `pushNotice`; confirm →
   `setArtifactConfirm`; open/save → `controller.readArtifact` (verified bytes)
   → the port; any rejection → ONE notice); origin = `shownInPod` (the runtime's
   fact, never the meta); `answerArtifactConfirm` clears the line and opens ONLY
   the plan it showed. `run.tsx` passes `createArtifactOpener()`.

**Real-filesystem check** (`.tentacle/tmp/model-artifacts/s6b-realfs-parent.ts`:
real `mkdtemp`/`writeFile`/exit handler in a child process, spawn stubbed so no
browser opens; the parent checks the dir after the child exits):

```
argv=["open","/var/folders/…/T/tentacle-artifacts-SSLi9w/ab12cd34.html"]
dirMode=700 fileMode=600
first=<!doctype html><meta http-equiv="Content-Security-Policy" co
existedDuring=true removedAtExit=true
```

**Drift from Implementation (and why):**

- **The port is the OS half only.** S6a's `AppProps.openArtifact(meta) => void`
  ("the runtime decides") is replaced by `AppProps.artifactOpener: ArtifactOpener`
  (`open(plan, bytes)`, `save(request, bytes)`). The App owns the controller
  (`createSession`) and the confirm row, so the decision (pure `artifactStep`) and
  the verified read run there; `startTui` never holds the controller. S6a's two
  frame tests were moved to the new port (same assertions plus the planned file).
- **`OpenPlan` has no `app: "default" | "preview"`; it has `network`.** The
  extension already selects the handler; `open -a Preview` would override the
  person's choice and does not exist on Linux.
- **The confirm is a new key layer in the quit dialog's slot**, not a dock line:
  that slot is the one that owns the screen and is decided BEFORE the permission
  prompt, so a `y` can never approve an ask that opened under it (mutation M9).
- **Panel `s` / `n` are built here.** D8 lists them; S6a built only `enter`.
- **A saved HTML/SVG copy is CSP-wrapped too** (as `.html`), so double-clicking
  it later in `~/Downloads` is still offline; saved names never keep the model's
  extension (`run.command` → `run.bin`).
- **The chord's target is the newest card in the transcript** (`newestArtifact`),
  not the daemon's list: instant, and it is the card that shows `^X^O`. After a
  `/clear` it says so and points at `/artifacts`.
- **Kind narrowing goes through `artifactCard(meta).kind`** (core): the TUI
  depends on protocol for TYPES only (`@tentacle/protocol` is not a runtime dep).
- **Changelog:** S6a's `model-artifacts.changed.md` bullet already covers the Mac
  surface; it is extended (opener, chord, `s`/`n`, pod confirm) rather than adding a
  third fragment for one slug.

**Not done (debt, deliberately):**

- **Click on a card line** (D8) — not in Files item 7 nor T6b. `tool-hit.ts`
  resolves only a call's HEADER row (`LaidItem` carries no row role), so a card
  click needs a row-role in the layout first. The header click still toggles the
  call; `Ctrl+X Ctrl+O` and `/artifacts` open.
- **The `fetching report.html 1.2/3.4 MB` status line** (D8): the TUI has no
  transient status-line seam (notices are permanent transcript rows). A failure is
  one notice, a save is one notice, a successful open is silent.
- **No quarantine xattr on a saved copy**: a pod-supplied `.zip` saved with `s` has
  no Gatekeeper quarantine. Residual of an explicit key; candidate follow-up.

**Mutations** (each applied with Edit, the named file run, reverted with Edit; a
grep for every mutated token afterwards found none):

```
M1 (plan target) ext from the title            artifact-open             16 pass 2 fail
M2 `other` handed to an opener (bin)           artifact-open+app         30 pass 5 fail
M3 pod opens without confirm                   artifact-open+app         32 pass 3 fail
M4 pod page planned with the network           artifact-open             17 pass 1 fail
M5 CSP wrap dropped                            artifact-open+os-open     23 pass 4 fail
M6 spawn stdio inherit                         os-open                    8 pass 1 fail
M7 save flag `w` (overwrites)                  os-open                    8 pass 1 fail
M8 plan-file name guard removed                os-open                    8 pass 1 fail
M9 confirm layer after permission              keys-layers               35 pass 1 fail
M10 confirm never cleared (remembered)         app-artifacts             16 pass 1 fail
M11 pod bytes read before the `y`              app-artifacts             16 pass 1 fail
M12 origin ignored (always local)              app-artifacts             15 pass 2 fail
M13 Enter accepted as yes                      keys-layers               35 pass 1 fail
```

**Schema / version:** no protocol schema changed; `protocol.json` not
regenerated; no `protocol.d/` note.

**Gate** (worktree root):

```
$ bun test <the 9 S6b tui files>          190 pass 0 fail
$ bunx tsc --noEmit                        24 errors, ALL in packages/daemon
    (src/session-artifacts.ts, src/session-log-store.ts, test/artifact-manifest.test.ts) — 0 in tui
$ bun run lint (biome check .)             1 error: format, packages/daemon/test/artifact-manifest.test.ts
$ bunx biome check packages/tui changelog.d   333 files, clean
$ bun test                                 12507 pass · 5 skip · 6 fail — all 6 "LogSessionStore artifacts (T4)"
$ git diff --stat HEAD -- packages/daemon packages/protocol   (empty: S6b touches neither)
```

Every red is S4's (committed in `72e5d036`, as recorded at "Starting state"); S6b adds
none. The gate goes green when S4's fix round lands, not in this slice.

#### S6b re-verification (re-spawned executor)

*— claude-opus-5-5 (executor, S6b re-spawn), 2026-11-16*

The as-built above was already in the tree with the gate unfilled; it was verified,
not redone. Load-bearing check re-run: `read-roundtrip.ts` → `PASS` (same output as
above). Plan-target mutation re-applied independently — `openExt` returning the
title's extension when it has one: **5 fail / 39 pass** across `artifact-open`,
`os-open`, `app-artifacts` (T6b.1 ×3, T6b.3 save, the `other`-never-opened frame);
reverted, 44 pass / 0 fail, no mutation token left in `tui/src`. The 5 skips (baseline
names 3 opt-in) are not S6b's: the 9 S6b files run 0 skips.

## Review

### S6a + S6b — TUI card, `/artifacts`, opener: REQUEST-CHANGES (3 MEDIUM)

*— claude-opus-5-5 (fresh-context reviewer), 2026-11-16. Same model family as the S6b executor (fresh context only): shared blind spots are possible.*

**Gate.** 16 touched test files (tui S6a/S6b + registry/layer pins + cli
`subagent-panel-controller`): **279 pass, 0 fail**. `bun run typecheck`: 24 errors,
all in `packages/daemon` (S4: `session-artifacts.ts` 1, `session-log-store.ts` 2,
`test/artifact-manifest.test.ts` 21). `bun run lint`: 1 error (format,
`daemon/test/artifact-manifest.test.ts`, S4). Neither has an error in tui, core or cli.

**Findings**

1. **MEDIUM — the SVG CSP wrap is not pinned by any test** (`tui/src/artifact-open.ts:94`).
   Mutation `wrapOf` → `kind === "html"` only (SVG unwrapped) → **44 pass / 0 fail** across
   `artifact-open`, `os-open`, `app-artifacts`. The only SVG case (`artifact-open.test.ts:54`)
   checks the file NAME. Failure: a regression writes a pod SVG as `ab12cd34.html` with NO
   CSP, and it opens with scripts and full network. Fix: assert `wrap: "csp"` for svg in
   `openPlan`/`artifactStep(save)`, plus one `os-open` write whose first bytes are the prefix.
2. **MEDIUM — cards (and `^X^O`) are lost on every history replace.** The join runs only in
   the mount watch effect (`App.tsx:1493`). `resetHistory`/`appendHistory` →
   `historyItems` → `messagesToItems(messages)` with no map (`state.ts:693`), reached by the
   activity snapshot after a dropped link (`useSessionLink.ts:347`), by `history_reset`
   (`state.ts:707`), and by `/sessions` swaps (`swapSession`, `useSessionLink.ts:555`, which
   doesn't re-run the effect). Failure: the link drops and resyncs, or the user switches to a
   session with artifacts. The `present` rows go plain, and `Ctrl+X Ctrl+O` says "No artifact in
   this transcript". This contradicts T6a ("after resume"). Fix: run the
   `needsArtifactJoin` → `listArtifacts` join after each history commit/swap, with a frame test.
3. **MEDIUM — the pod confirm says "network blocked", which is untrue** (`artifact-open.ts:130`).
   CSP does not govern top-level navigation. A wrapped `file://` page with scripts on
   can still `location = "https://x/?b"`, use `<meta http-equiv=refresh>` or `window.open`.
   The phone has a navigation predicate and an escape suite (T7.2/T8.1); the Mac has
   neither, and no test. Failure: the user approves a pod page because the prompt says
   "network blocked", and the page beacons out or redirects to a phishing page. Fix: honest
   wording (for example "no fetch/XHR; it can still navigate away"), or scripts off for pod
   HTML (Owner Q5's fallback). The plan's "network blocked" claim (D8) needs the same fix.

**Mutations (reviewer's own; applied by script, restored byte-identical, `git status` clean):**
A SVG unwrapped → 44/0 (**survives**: finding 1) · B `saveName` keeps a leading dot → 43/1 ·
C `newestArtifact` reversed → 42/2. The executor's M1–M13 were not re-run. M1 was re-run
independently by the S6b re-spawn.

**Attacks tried, nothing found:** a model title or path in the temp name (`<sha8>` +
our ext; `PLAN_FILE_RE` re-guard at `os-open.ts:88`); `other` sent to an opener (save-only
in both layers); the origin taken from the meta (it is `shownInPod`, `App.tsx:522`;
engine TUIs pass `daemonInPod: true`, `cli/main.ts:1440`); pod bytes read before `y`
(`runArtifact` confirms first); the confirm `y` approving a permission ask (the layer sits
before `permission`, `layers.ts:50`); terminal writes (stdio ignore ×3); a save that
overwrites (`wx`, numbered names); a leading-dot or separator save name (two guards).

**Holds:** §7 terminal (no raw write), single broker (untouched), pod trust for the open path
(origin from the runtime, confirm every time, not remembered, no network offer, temp dir
`0700` under `os.tmpdir()`, removed at exit). **Residual, not counted above:** a pod `.zip`
saved with `s` has no quarantine xattr, so Gatekeeper is bypassed for an `.app` inside it.
The executor declared this debt, and it should be tracked in TODO.

**Executor behaviour:** both executors recorded their drift and debt honestly and ran
broad mutation sets. The SVG-wrap gap and the history-replace path were missed: both are
cases they did not test, not false claims.

### Fix round 1

*— claude-opus-5-5 (executor), 2026-11-16.*

Three MEDIUM, no HIGH. All three FIXED; each with a regression test shown RED on the
pre-fix code, and each fix mutation-checked (below).

**1 MEDIUM — the SVG CSP wrap was unpinned → FIXED.**
Tests first (`artifact-open.test.ts`, new block "T6b.1 — an SVG is WRAPPED, not merely
renamed"): `openPlan(svg).wrap === "csp"` for both origins, the `open` step's
`plan.wrap`, the pod confirm's `your browser` branch, the `save` step's `wrap: "csp"`, and
`wrapArtifactBytes` prefixing the SVG body. Plus `os-open.test.ts`: an SVG plan really
writes the prefix at the END of the write path (the reviewer only had a name assertion).
RED: mutation `wrapOf → kind === "html"` (the reviewer's own mutation A) → **5 fail** in
`artifact-open.test.ts`, all on `Expected: "csp" / Received: null`; the pre-existing
name-only SVG cases stayed GREEN — the same blind spot the review found. Green restored
(33/0). Second mutation on the write path (`if (wrap !== "csp" || true)`) → 3 fail
(the HTML case, the new SVG case, and the save), reverted.

**2 MEDIUM — cards lost on every history replace → FIXED.**
Root cause confirmed: the join lived only in App's mount watch effect (`App.tsx:1493`),
while `resetHistory`/`appendHistory` → `historyItems` → `messagesToItems(messages)` kept no
map (`state.ts:693`), so a resync (`useSessionLink.ts:347`), a `history_reset` in a turn
(`useTurnDriver.ts:608`), and a `/sessions` swap all rebuilt plain rows.

Design (reuse-the-seam, AGENTS §7): the per-session knowledge is now an explicit object,
`ArtifactJoin` (`byCall` + a `pending` latch), held by App in `artifactJoinRef` and
mutated in ONE place — `artifact-join.ts`'s `checkArtifacts` (pure decisions stay in
`artifacts-panel.ts`: `joinKnownArtifacts` re-attaches from an existing map;
`withArtifactDetails` now also FILLS that map, `next`). Call sites: the mount effect
(App), `commitHistory`'s tail (so every warmed commit joins, `useTurnDriver.ts:528`), the
streaming loop's `history_reset`/`context_reset` branch (`useTurnDriver.ts:617`), the
`history` activity's commit compute, and `swapSession` (`forgetArtifacts()` then
`joinCards`). App's `joinCards` also re-attaches on the async answer, repainting.

Tests (`app-artifacts.test.tsx`, new block "S6a review finding 2"): a `history` replace
keeps the card; a SECOND replace keeps it (so "once per watched session" cannot pass); a
resync **inside a turn** (`history_reset` → the driver path) keeps it; `Ctrl+X Ctrl+O`
finds it (no "No artifact" notice); a `/sessions` swap re-joins the NEW session's list; a
swap does not carry the old session's card across a repeated `callId`; a burst of three
replaces asks the daemon ONCE. All 7 RED before the fix (4 on the first run, then 2 more
after the fakes were completed — the chord test needed `readArtifact`, the swap test
`detach`; both were test-harness gaps, stated here rather than hidden).

Mutations (each applied, run on `app-artifacts.test.tsx`, reverted):
- **M2a** drop `joinCards` from `commitHistory`'s tail → 4 fail (all but the in-turn one).
- **M2b** drop the driver's `history_reset`/`context_reset` branch → 1 fail, exactly the
  in-turn test.
- **M2c** drop `forgetArtifacts()` from `swapSession` → 1 fail, exactly the cross-session
  `callId` test (this mutation SURVIVED at first: the cross-session case had no test, so
  one was added — non-vacuity by mutation, §9).
- **M2d** drop the `pending` latch → 1 fail, the burst test (`Expected: 1, Received: 3`).
- **M2e** drop the inner `joinCards` in the `history` activity's compute (tail intact) →
  **0 fail**: it is a warm-ordering nicety (the cards are already in the warm), not a
  property. Recorded rather than claimed as tested.

**3 MEDIUM — the pod confirm said "network blocked", which is untrue → FIXED.**
`confirmText` (`artifact-open.ts:130`) now says `scripts on · no fetch/XHR · it can still
navigate away`, and the plan's D8 claim was corrected in this doc (the reviewer asked for
both). Tests: the pure confirm text must NOT contain "network blocked" and must carry both
true clauses, and the App frame test asserts the same on the rendered line. RED by
mutation: restoring the old wording → 2 fail (the pure test and the frame test), reverted.
The module header's "never with the network" claim was narrowed to what the wrap keeps.

**Drift from the Implementation:** none of the three changes contradicts it; the extra
surface is `artifact-join.ts` (new, pure around one request) and the two optional
parameters on `resetHistory`/`appendHistory`/`withArtifactDetails` (additive, existing
callers unchanged). `resume.ts`'s `messagesToItems` signature is unchanged.

**Gate.** `bunx tsc --noEmit`: **0 errors outside `packages/daemon`**; the 24 that remain
are all S4's committed WIP (`session-artifacts.ts` 1, `session-log-store.ts` 2,
`daemon/test/artifact-manifest.test.ts` 21) — the same 24 the S6a/S6b review recorded, not
mine. `bun run lint`: **1 error, `daemon/test/artifact-manifest.test.ts` format** (S4's,
also pre-existing); every file I touched is clean (`biome check` on my 12 files: clean).
`bun test`, per package (the full-suite invocation HANGS in this environment at 0% CPU
**and does so on a pristine `main` worktree too** — `main-ro`: `EXIT=124` at 120 s, same
single-line output — so it is environmental, not this change):

```
agent      634 pass  0 fail   (59 files)      docker    154 pass  0 fail
cli       2627 pass  0 fail   (162, 2 opt-in) exec      121 pass  0 fail
client     806 pass  0 fail   (73)            k8s        86 pass  0 fail (1 opt-in)
config     452 pass  0 fail                   mcp       124 pass  0 fail
core       426 pass  0 fail                   protocol  467 pass  0 fail
providers  161 pass  0 fail                   tools     378 pass  0 fail
transport  150 pass  0 fail                   tui      2503 pass  0 fail  (175 files)
daemon    1316 pass  6 fail — ALL S4's `LogSessionStore artifacts (T4)` WIP, untouched here
```

The 6 daemon failures are the artifact-store methods whose types do not exist yet (the same
files as the 24 tsc errors); `git status` on `packages/daemon` is clean, so none is mine.

**Unverified:** the mobile project's typecheck (`tsc -p apps/mobile`, which pulls tui sources
in through the parity tests) is **RED at 10 errors**, and it is the BRANCH's, not this
round's: with my six `packages/tui/src` files temporarily reverted to HEAD (backups, no git
operation) the same command still reports **10**, the identical set (`app-types.ts`,
`artifact-open.ts` ×2, `artifacts-panel.ts`, `keys/effects.ts`, `panels/artifacts.ts`,
`panels/types.ts`, `resume.ts`, and 2 in daemon's S4 `session-log-store.ts`). My only change
here is a shared `ArtifactCardMap` alias (so `state.ts` needs no new protocol import); with
it, this round adds NO mobile error of its own. Cause: those tui files' `@tentacle/protocol`
imports do not resolve under the Expo config (the tui package does not depend on it).
A fix is a separate task (thread the type through, or give the Expo project a path), so it
is left as debt, not silently re-declared green. Verify: `bunx tsc -p apps/mobile --noEmit`
on this tree and on HEAD's `packages/tui/src`.



### Round 2

*— claude-opus-5-5 (fresh-context reviewer), 2026-11-16* — **PASS (no HIGH/MEDIUM)**. Reviewed `git diff HEAD~1` (`d053d755`).

**Each finding, by mutation** (script `.tentacle/tmp/model-artifacts/rv-mut2.ts`, five tui files; every file restored byte-identical, `git status` clean):
- F1 SVG unwrapped → **84 pass / 5 fail**. Fixed and now pinned (`artifact-open.test.ts` SVG block, `os-open.test.ts`).
- F3 confirm text reverted to "network blocked" → **87/2**. Fixed: `artifact-open.ts:136` now says "no fetch/XHR · it can still navigate away".
- F2 cards on history rebuilds: commit-tail join removed (`useTurnDriver.ts` `joinCards({`) → **83/6**; `history_reset`/`context_reset` join removed → **88/1**; `forgetArtifacts()` on swap removed → **88/1**; the answer's fold removed (`artifact-join.ts`) → **82/7**. Fixed.

**Gate.** `bun test packages/tui`: 2503 pass, 0 fail. `bun run typecheck`: 24 errors, all S4 daemon files (unchanged from round 1). `bun run lint`: 1 error, the S4 `daemon/test/artifact-manifest.test.ts` format (unchanged). None is in this diff.

**LOW (not blocking):**
- (a) `artifact-join.ts` `checkArtifacts`: the answer is folded into `join.byCall` BEFORE `onLearned`'s session check. A list still in flight across a `/sessions` swap therefore re-fills the just-cleared map with the OLD session's metas. With a repeated `callId` (the file's own premise), that attaches a wrong card; opening it then fails loudly (`unknown`) and opens nothing. Fix: capture the session and skip the fold when it changed.
- (b) The swap's own re-join (`useSessionLink.ts` `stateRef.current = joinCards(stateRef.current)`) survives deletion → 89/0. A kept transcript after a swap is unpinned (the eager open's commit join covers the common path).

**Regressions checked:** the streaming hot path is unchanged (the join is gated on `history_reset`/`context_reset`); `joinKnownArtifacts` returns the same array on a no-op; still one in-flight request per burst (`pending`).

## Execution

### S7 — Phone pure modules: DONE

*— deepseek-v4.1-flash (`rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`), 2026-11-16*

**Load-bearing check, re-run first** (`.tentacle/tmp/model-artifacts/read-roundtrip.ts`,
run from the worktree root):

```
$ bun /Users/gmeghnag/tentacle/.tentacle/tmp/model-artifacts/read-roundtrip.ts
chunks=12 sha-equal=true
order=enqueue,chunk0,chunk1,…,chunk11
enqueue-before-last=true maxRpcFrame=349591 maxRawNoiseFrame=87383
PASS
```

The roundtrip holds unchanged: a 3 MiB blob reads back over `RpcPeer` ↔ `RpcPeer`
through the Noise channel pair in 12 × 256 KiB chunks, an interleaved
`session/enqueue` is answered before the last chunk, and no raw Noise frame
exceeds 65535 bytes. Nothing in S7 touches that path.

**Capability check** (S7 absent before this slice):

```
$ ls apps/mobile/src/artifact-*.ts
(no such file)
$ rg -c "galleryView|viewerFor|allowNavigation|unseenArtifacts" apps/mobile/src apps/mobile/test
apps/mobile/src/hub-session.ts:1        # hub's own field, unrelated
apps/mobile/src/hub-actions.ts:8        # `unseenArtifacts` as a hub CTX field
apps/mobile/test/hub-actions.test.ts:10
$ grep -c "react-native-webview" apps/mobile/package.json
0
```

`hub-actions.ts:53` already declared an `unseenArtifacts: number` on the hub's
context, but nothing computed it (it is a field the hub's `count` badge reads;
`feat/mobile-hub` supplies it). S7 supplies the function.

**As built, in order** (red shown before each green):

1. **`apps/mobile/test/artifact-gallery.test.ts`** (new, 16 tests) — RED at load
   (`Cannot find module '../src/artifact-gallery.ts'`).
2. **`apps/mobile/src/artifact-gallery.ts`** (new, pure): `artifactDay` (`Today`
   / `Yesterday` / `2026-11-12`, a daemon clock ahead of the phone clamped to
   `Today`), `unseenArtifacts` (ARTIFACTS with something new, never versions — the
   hub badge's unit), `galleryView` (one row per artifact, newest PRESENTED first
   by its newest version's `createdAt` with an id tie-break, versions folded into
   a count, `all` newest-first, day sections in order, `filter` case- and
   space-insensitive on the TITLE only, `empty` covering both "none" and "no
   match"), `gallerySummary` (`2 artifacts · 2 new` / `1 artifact` / `No
   artifacts`). Rows carry `@tentacle/core`'s `artifactCard` — the SAME view-model
   the Mac renders — so a kind is narrowed once and an unknown kind reads as
   `other`.
3. **`apps/mobile/test/artifact-seen-store.test.ts`** (new, 14 tests) — RED at
   load (module missing).
4. **`apps/mobile/src/artifact-seen-store.ts`** (new): the `{v:1, seen:{…}}`
   record behind `SecureKV` (the `voice-settings-store.ts` pattern),
   `sessionKey(computerId, sessionId)`, `seenFor`, `markGalleryOpened` (forward
   only), `markArtifactOpened` (dedupe, `MAX_OPENED = 500` oldest-dropped),
   `ArtifactSeenPreserved` for an unknown `v` / garbage / unreadable Keychain.
5. **`apps/mobile/src/artifact-seen-expo.ts`** (new, wiring only): the Keychain
   adapter plus the app's ONE `ARTIFACT_SEEN` holder (`load`/`current`/`set`/
   `subscribe`), so the gallery and the Session info row read one in-memory copy
   instead of a native round-trip per render.
6. **`apps/mobile/test/artifact-viewer.test.ts`** (new, 14 tests) → then
   **`apps/mobile/src/artifact-viewer.ts`** (new): `viewerFor` (kind → viewer +
   scripts, an unknown/prototype kind → `none`), `allowNavigation` (the initial
   `about:blank` is the ONLY allowed load), `htmlViewerProps` (CSP-prefix first,
   network per open, the isolation flags as DATA, no `onMessage`, no
   `injectedJavaScript`), `pdfViewerProps` (file uri, scripts off, same
   isolation), `networkBarLabel`, `viewerSubtitle`, `viewerTarget`.
7. **`apps/mobile/test/artifact-cache.test.ts`** (new, 14 tests) →
   **`apps/mobile/src/artifact-cache.ts`** (new): `planCache` (LRU, the version a
   viewer HOLDS never evicted, `wontFit` when it cannot fit — and then NOT taken),
   `touch`/`forget`/`missingFrom`, `cacheDir`/`cachePath` (computer id sanitized:
   no traversal), `shareName`, `ARTIFACT_CACHE_BYTES = 200 MB`.

**T7 coverage** (the plan's own list): T7.1 `galleryView` grouping/fold/unseen +
`unseenArtifacts` (gallery opened → 0, a new version → 1) ✓ ·
T7.2 `allowNavigation` (only `about:blank`; `https:`/`data:`/`file:`/
`javascript:`/`blob:`/`about:srcdoc`/case/whitespace variants refused) + props as
data (`incognito: true`, no `onMessage`, `javaScriptEnabled` per kind) ✓ ·
T7.3 `viewerFor` ✓ · T7.4 cache LRU plan + seen-store unknown `v` preserved ✓.

**Drift from the Implementation (and why)**

1. **The gallery route entry (`openArtifactGallery`) was written and then
   removed.** D9 places it in `routes.ts`, but the Files list puts `routes.ts` +
   `screens/ArtifactGallery.tsx` in **item 11 (S9)**. Writing it here would have
   duplicated S9's work and pre-empted S9's `RootStackParams` decision, so S7
   ships the FOUR pure modules item 9 names and no route.
2. **`artifact-viewer.ts` was written before its test** (module first, then the
   test file) — the one violation of red-first in this slice. Compensated with
   four mutations of that file (M1–M4 below), each RED: the tests are not
   vacuous. Every other module had its test shown failing at load first.
3. **A malformed ENTRY inside a valid v1 record is tolerated (dropped), not
   refused.** The plan's T7.4 says only "seen-store unknown `v` preserved". My
   first test asserted the stricter rule (any malformed entry ⇒ unwritable) and
   failed against the intended behaviour; the decided rule is the fail-safe one:
   an unknown `v` refuses (its fields may mean something else), a bad entry in a
   record this build understands is dropped — which can only make an artifact
   look NEW, never hide it, and refusing would burn the record forever. Pinned by
   the "a malformed ENTRY inside a valid record is dropped" test.
4. **`isUnseen` uses `>=`, not `>`** — a found bug, not a preference: a version
   presented in the *same millisecond* the gallery opened may have missed the
   list that open fetched. The fail-safe direction is a false "new" (a badge)
   over a false "seen" (an artifact hidden for good). Mutation M7 (`>=` → `>`)
   is RED on the new boundary test.
5. **Two boundaries the plan did not name**, added because they are decisions a
   `.tsx` would otherwise make: `gallerySummary` (the header line, so the sheet
   formats nothing) and `shareName` (a Share sheet name from the title, with the
   kind's extension when the title has none) — both pure, both tested.
6. **Times are formatted in UTC** (`clockTime`, `artifactDay`). The plan says
   nothing; a phone's timezone is not a fact a unit test can hold, and the
   daemon's `createdAt` is already the record's only clock, so one timezone beats
   a mixed one. The section labels are the mockups' (`Today`/`Yesterday`).

**Changelog: deliberately no new fragment.** S7 is pure modules with no wiring —
nothing a person can see changes until S8/S9 render them. Both fragments this
task owns already exist (`changelog.d/model-artifacts.added.md` — the capability,
which names the gallery and the phone viewers; `changelog.d/model-artifacts.changed.md`
— the Mac's card and panel), and a third would be a slug+category collision or a
mirror of internal work, which AGENTS §10 says the changelog is not. The `added`
bullet's "a gallery lists every version … on the Mac and the iPhone" is what S7's
modules serve; S9 remains the slice that makes it true on the phone.

**Mutations (AGENTS §9 non-vacuity).** Script
`.tentacle/tmp/model-artifacts/s7-mut.sh`, one property broken at a time, the
narrow file run, the file restored from a copy; `git status` after the run shows
exactly the 9 new files and the baseline re-runs at 58 pass / 0 fail:

```
M0  baseline (4 files)                                          58 pass 0 fail
M1  allowNavigation: only javascript: refused (any other scheme) 13 pass 1 fail
M2  javaScriptCanOpenWindowsAutomatically: true                  12 pass 2 fail
M3  an onMessage bridge added to the props                       12 pass 2 fail
M4  HTML not CSP-wrapped (body alone)                            12 pass 2 fail
M5  eviction drops the version a viewer HOLDS                    12 pass 2 fail
M6  a version that cannot fit is still taken                      13 pass 1 fail
M7  isUnseen `>=` → `>` (same-instant version reads seen)         15 pass 1 fail
M8  `opened` ignored (a reopened version stays new)              13 pass 3 fail
M9  versions counted instead of artifacts (the badge)            14 pass 2 fail
M10 a future daemon clock reads Tomorrow (day >= → ==)           15 pass 1 fail
M11 seen-store: an unknown `v` is written over                   13 pass 1 fail
M12 seen-store: `opened` unbounded                               13 pass 1 fail
M13 computer id not sanitized (a traversal in the cache dir)     13 pass 1 fail
M0' after restores                                              58 pass 0 fail
```

**Gate.** The tree carried S4's work in progress before this slice
(`packages/daemon/src/session-artifacts.ts`, `session-log-store.ts`,
`session-blobs.ts`, `daemon/test/artifact-manifest.test.ts`) — the same files S5
and S6a recorded as the only non-green cause. S7 touched none of them and left
them exactly as found; they are the only cause of the RED below.

- `bunx tsc --noEmit`: 21 errors, **all** S4's daemon files (none matches
  `session-log-store|artifact-manifest.test|session-artifacts|session-blobs|serve.ts`
  → 0 remaining). `bunx tsc -p apps/mobile`: clean. `-p apps/relay`: clean.
- `bun run lint`: 1 error, S4's `daemon/test/artifact-manifest.test.ts` format —
  the same one S6a's round 2 recorded, unchanged. The 9 new S7 files: `biome
  check` clean.
- `bun test` (full suite, once): **13193 pass, 5 skip, 7 fail**. The 5 skips are
  the documented opt-ins' cases. Of the 7 fails, SIX are S4's
  `packages/daemon/test/artifact-manifest.test.ts` (its store methods
  `putArtifact`/`artifactManifest`/`sweepArtifacts` do not exist yet — the same
  file whose type errors the gate reports) and the seventh was S7's own, below.
- **S7 caught one real cross-check failure of its own in that run**:
  `apps/mobile/test/pairing-guards.test.ts` — "only the wiring files import the
  Keychain" enumerates every `expo-secure-store` importer, and the new
  `artifact-seen-expo.ts` was a sixth. Fixed by adding it to that list (the
  guard's own comment pattern, extended) — the pure `artifact-seen-store.ts`
  stays free of the native import, which is exactly what the guard protects.
  After the fix: `bun test apps/mobile` **2345 pass, 0 fail**; the only remaining
  full-suite failure is S4's file, and every S7 test passes.
- S7's own files: 58 pass, 0 fail (4 files).

### Fix round 1

*— claude-opus-5-5 (executor), 2026-11-16*

**S10 implemented; the two MEDIUMs fixed.**

**Scope.** The three review findings, in the order the review listed them. The
branch was red before this round (S4's store ops were committed without their
code); it is green after it, and S10 — the HIGH, found unimplemented — is now
built, pinned by T10, and mutation-checked.

**Finding 3 (MEDIUM, gate red) — FIXED first, because everything else is
verified on a green gate.** The S4 coverage the review found missing from
`LogSessionStore` is implemented: `putArtifact`/`readArtifactBlob`/
`artifactManifest`/`artifactOwners`/`sweepArtifacts`
(`packages/daemon/src/session-log-store.ts:451,459,474,480,485`), the
`artifactStore` field (`:630`, `options.artifacts ?? new SessionArtifacts(dir)`),
the `artifact`/`sweepArtifacts` run() cases (`:611`), the artifacts dir named on
a failed op, `removeLocked` also dropping `artifactStore.removeAll(id)`, `/clear`
fork artifact linking (`linkForkArtifacts`/`callIdsOf`, `:288,706`), and the
`directory` getter (`:333`) `main.ts` needs. `packages/daemon/test/artifact-manifest.test.ts`
is **8 pass, 0 fail**; the file was also formatted (it had been committed
unformatted, which is the lint half of the review's gate finding).

**Finding 2 (MEDIUM, `cacheDir`) — FIXED.**
`apps/mobile/src/artifact-cache.ts:135-144`: a dot-only id (`..`, `.`, `...`) has
each dot turned into `_` and an empty id becomes `_`, so `cacheDir` can never
name `artifacts/..` (the cache root) or `.`. Test
`apps/mobile/test/artifact-cache.test.ts:117` ("a DOT-ONLY id never names the
cache root or its parent") asserts the four ids, and was shown RED first: with
the OLD sanitizer restored as a mutation (`const name = safe`) it fails —
**14 pass, 1 fail** — and green on the fix: **15 pass, 0 fail**.

**Finding 1 (HIGH, S10/D11 never implemented) — IMPLEMENTED + pinned.**
The laptop keeps each artifact version beside the log, at the save points
`persistingController` already has, and a resumed worker session's store is
seeded from that copy. Files (`file:line` is post-execution):

- `packages/daemon/src/artifact-store.ts:59` — `ArtifactSeed` (`metas`,
  `read(sha256,size)`); `:139-155` the ctor takes `{seed}`, wire-checks each meta
  through `ArtifactMetaSchema` (a meta the wire would refuse is never listed) and
  keeps the latest version per `artifactId`; `:257-271` `load()` reads a seeded
  version lazily on the first `artifact/read`, refuses a length ≠ `meta.size`,
  charges the budget through `hold`, and answers `ArtifactUnavailable{evicted}`
  when the copy is gone, short or over budget.
- `packages/daemon/src/session-host.ts:263` `SessionHostOptions.artifactSeed`,
  used at `:1456` in the one `build()` site.
- `packages/cli/src/laptop-artifacts.ts` (new) — `artifactsToKeep` (`:23`, dedupe
  by `sha256`) and `laptopArtifactSeed` (`:59`, `"refused"`/empty → `undefined`,
  and only a sha256 the manifest names is ever read).
- `packages/cli/src/local-runtime.ts:421-495` — `LaptopArtifacts` (fetch what the
  daemon lists and the laptop lacks, ONE notice, never throws);
  `:547,627,636-661` the `artifacts?: LaptopArtifacts` controller param,
  `keepArtifacts()` inside `flush()`, and `flushed()` awaiting both `running` and
  `keeping`; `:1034` `LocalRuntimeDeps.keepArtifacts`; `:1332-1345` the one build
  site (`undefined` unless `keepArtifacts === true`); `:1664,1702` the worker's
  `artifactsDir` in the bootstrap; `:1748` `keepArtifacts: true` at the worker's
  `createLocalRuntime` call — **the ONE place that decides**, so a pod
  `run`/`attach` and `connect` keep nothing.
- `packages/cli/src/session-saver.ts:223,231` — `putArtifact` (resolves at once
  for a removed uid or a store without it, REJECTS when the write failed) and
  `artifactManifest`; `SaveTarget` extended.
- `packages/cli/src/worker-bootstrap.ts:17` `artifactsDir`; `worker.ts:56`
  `laptopSeedFrom` (read-only `LogSessionStore`), `:140,155` the host option,
  `:216,241` the bootstrap destructure and the seed.
- `packages/cli/src/main.ts:2185` passes `sessions.store.directory`.

**T10 tests** — `packages/cli/test/artifacts-durable.test.ts` (new, 11 tests):

1. present → turn end → `<uid>.artifacts/` holds the blob (under its sha256) and
   `manifest.jsonl` with one line, through `LogSessionStore.artifactManifest`;
2. `--resume` on a fresh host seeded from that dir: `openSeeded` +
   `listArtifacts` list the version from the seed alone, and `readArtifact`
   returns the exact bytes (lazily — no turn ran);
3. a seeded meta whose blob was deleted → `readArtifact` rejects
   `ArtifactUnavailable{reason:"evicted"}`, never bytes;
4. a seeded blob SHORTER than its meta → the same refusal (`load()`'s size
   check), never a truncated artifact;
5. **pod exclusion (§7)**: the same present + save through a runtime WITHOUT
   `keepArtifacts` leaves NO `<uid>.artifacts` dir and an empty manifest, while
   the log itself IS saved (the store is the laptop's normal one);
6. `startWorkerRuntime` posts `artifactsDir` in the bootstrap (a fake worker, so
   no process is spawned);
7. **end to end over the REAL worker boundary**: a spawned worker, a scripted
   OpenAI-compatible server whose first turn calls `present`; the blob+manifest
   land in the laptop dir, then a second worker started with `--resume` lists and
   reads it back;
8. `artifactsToKeep` dedupe (one sha256 under two ids fetched once, held skipped);
9. an older daemon (`ArtifactsUnsupportedError` from `artifact/list`) → nothing
   kept and NO notice (a daemon without the method must not warn every turn);
10. a failing disk → exactly ONE notice across three save points;
11. a `"refused"` manifest → never written, never seeded.

**Red before green — the honest form.** Finding 3 has a true red-first: the S4
test file (`packages/daemon/test/artifact-manifest.test.ts`) was committed RED —
it called `putArtifact`/`artifactManifest`/`sweepArtifacts`, which did not exist,
so it failed six cases AND broke `tsc` — and the store ops were written to make
it green (**8 pass, 0 fail**).

For S10 (finding 1) the honest form is different, and worth saying plainly: the
S10 code was already in the tree at this round's start (implemented, untested),
so its tests are **test-after**, not red-first. What stands in their place is the
mutation table below. It is not merely "a mutation fails a test": each row
restores a piece of the *pre-S10* behaviour — no keep at the worker's call site,
no dir in the bootstrap, no seed forwarded, no lazy read, no seeded metas, no
write — and BOTH the narrow tests and the end-to-end worker test go red. A test
written against the un-implemented branch would fail for exactly those reasons.
Two failures seen while writing them (`listArtifacts` returning `[]` before an
open) were my own test bug, and are why test 2 and the e2e do the `openSeeded()`
the TUI does.

**Mutation table** (each mutation applied alone, the file restored afterwards and
its `md5` checked against the pre-mutation value; the counts are what that run
reported — the file had 10 tests for the first rows and 11 for the later ones,
because the SHORT-blob case and the `"refused"`-seed half were added while
mutation-testing):

| Mutation | Result |
|---|---|
| `keepArtifacts: true` dropped at the worker's `createLocalRuntime` call (`local-runtime.ts:1748`) | 9 pass, **1 fail** (e2e: `[]` vs `["report"]`) |
| `artifactsDir` not posted in the bootstrap (`:1702`) | 8 pass, **2 fail** (the bootstrap test + e2e) |
| `laptopSeedFrom`'s manifest read → `() => []` (`worker.ts:61`) | 7 pass, **3 fail** |
| `SessionHost` seed not forwarded (`session-host.ts:1456`) | 7 pass, **4 fail** |
| `if (this.seed) return undefined` in `load()` (lazy read dropped) | 8 pass, **2 fail** (`evicted` on a resume) |
| seeded metas not pushed in the ctor (`artifact-store.ts:146`) | 7 pass, **3 fail** |
| `load()`'s length check dropped | 10 pass, **1 fail** (the SHORT blob) |
| `keepArtifacts()` removed from `flush()` (`local-runtime.ts:627`) | 6 pass, **5 fail** |
| the write path → `Promise.resolve()` (`:1341`) | 6 pass, **5 fail** |
| `LaptopArtifacts.save()` returns before fetching (`:464`) | 5 pass, **6 fail** |
| the ONE-notice guard dropped (`:487`) | 10 pass, **1 fail** |
| `artifactsToKeep`'s dedupe dropped | 7 pass, **4 fail** |
| `laptopArtifactSeed` reads `"refused"` as ours | 10 pass, **1 fail** (`metas.map is not a function`) |
| `artifact/list`'s error rethrown instead of swallowed | 10 pass, **1 fail** |
| the POD exclusion → `deps.keepArtifacts === true` replaced by `true` | 9 pass, **1 fail** (T10 §7) |

**Drift from the Implementation, declared:**

- **The save point is `flush()`, not "turn end".** The plan said turn end; the
  controller has six save points (a committed round, turn end, a title, the
  switches, a compaction, idle) and `flush()` is the one function all of them
  call. Keeping artifacts there costs nothing extra (fetches are coalesced onto
  their own detached promise and `flushed()` awaits both), and it makes the
  gallery survive a crash mid-turn, not just a clean quit.
- **The worker is handed the store DIR, not an in-memory seed.** The plan's
  "re-seed the new worker's store from that dir" is implemented as
  `artifactsDir` in the `WorkerBootstrap`, read by a plain read-only
  `LogSessionStore` (`laptopSeedFrom`). An in-memory handoff is impossible across
  the worker boundary (the seed is bytes, and the pool is 128 MiB), and this
  keeps the read lazy: the worker touches the disk only when a version is
  actually opened.
- **`--resume` needs an open.** `listArtifacts` on a session that nothing has
  opened returns the empty list by design (`remote-session.ts:652`), so T10 does
  the `openSeeded()` the TUI does. The seed is in the store BEFORE the open (it
  is the `SessionHost.build()` site), so the resumed gallery is complete on the
  first read.
- `wiring.test.ts:627`'s broker grep-guard was widened to `\{\s*permissions,\s*saver`:
  the added `artifactsDir` line makes Biome break the argument object over
  several lines, and the guard was pinned to one-line formatting. It still
  asserts the SAME identifier in both places (`new PermissionBroker(` count 1,
  and the `permissions,` argument to `startTui`).

**Gate (this round, on the final tree).**
`bunx tsc --noEmit` — **clean**. `bunx tsc -p apps/mobile` — clean.
`bunx tsc -p apps/relay` — clean. `bun run lint` — **clean** (1823 files, no
fixes applied; the S4 test file the review flagged is formatted now).
`bun test` (full suite, run twice: once mid-round, once last on the final tree
after the doc and changelog edits — same result) — **13258 pass, 5 skip, 0 fail**
(13 snapshots, 88955 expect() calls, 945 files). The 5 skips are the documented
opt-ins (live-k8s, live-docker, the real-socket keepalive). Narrow on the final
tree: `artifacts-durable` 11 pass, 0 fail; `local-runtime` + `artifacts-durable`
90 pass, 0 fail; `daemon/test` 1344 pass / 1 skip / 0 fail; `daemon/test/artifact-manifest`
8 pass, 0 fail; `apps/mobile/test/artifact-cache` 15 pass, 0 fail;
`apps/mobile` whole 2346 pass, 0 fail; `scripts/test/changelog-guard` 5 pass,
0 fail; and the four narrow test files together (`artifacts-durable`,
`wiring`, `artifact-cache`, `artifact-manifest`) 76 pass, 0 fail.

**Residual / debt (declared, not fixed here):**

- No wire change and no `protocol.d/` note: `artifact/list`/`artifact/read`
  already existed, and the seed is daemon-internal. `PROTOCOL_VERSION` is
  untouched.
- The laptop copy is kept for EVERY version the daemon lists, including ones a
  session never opened (the plan's "what a save point has to fetch"); there is
  no laptop-side artifact byte cap, unlike images' `LAPTOP_IMAGE_BYTES`. A
  worker session that presents many 20 MiB files grows its dir until
  `tentacle`'s normal session cleanup — worth a cap in a later task.
- The pod exclusion is enforced by `keepArtifacts` being set at exactly ONE call
  site (`local-runtime.ts:1748`), not by a type: a future pod path that sets it
  would silently write a pod's artifacts on the laptop. T10's §7 test pins the
  absence today; a compile-time split (a `LocalRuntimeDeps` variant only the
  worker can build) is the stronger form.
- S10 is `load-bearing` (§7 persistence + pod exclusion), so per AGENTS §10 it
  needs a **fresh-context Review** of this round, not an in-context one.

**One test fixed on the way (not a code drift):** `packages/cli/test/wiring.test.ts:627`
— the single-broker grep-guard was pinned to ONE-LINE formatting of main.ts's
runtime call, which the added `artifactsDir` line made Biome re-wrap. Widened to
`\{\s*permissions,\s*saver`; it still asserts one `new PermissionBroker(` in the
block and the `permissions,` argument to `startTui`, so the invariant is
unchanged and still non-vacuous (the mutation already recorded in its comment —
`permissions: new PermissionBroker()` at the `startTui` call — still fails it).



## Review

### S10 + S7 — REQUEST-CHANGES (1 HIGH, 2 MEDIUM)

*— claude-opus-5-5, 2026-11-16* (a fresh context, and a different model family from the deepseek executor)

**Gate.** `bun test` on the 5 touched mobile files: 70 pass, 0 fail. `bun run typecheck`: RED,
because `packages/daemon/test/artifact-manifest.test.ts` calls `putArtifact`/`artifactManifest`/
`sweepArtifacts`, which do not exist on `LogSessionStore` (S4's test was committed without its code).
`bun run lint`: RED, 1 format error in that same file. Neither failure comes from S7/S10, but HEAD is not green.

**Findings**
1. **HIGH: S10 was never implemented.** `git diff main...HEAD` has no D11 code. `ArtifactStore` has
   no `seed` option (`packages/daemon/src/artifact-store.ts`), `session-saver.ts` is untouched,
   nothing calls `listArtifacts`→`putArtifact` at the laptop's save points, and there is no T10
   test. The only S10-adjacent lines are the S6a pass-through (`packages/cli/src/local-runtime.ts:770-775`),
   and their own comment says "neither is persisted". There is no S10 Execution section either.
   *Scenario:* a model presents in a worker session → quit → `--resume`: the gallery/`/artifacts`
   are empty and the persisted cards point at artifacts that no longer exist. The pod-exclusion
   half of T10 ("a POD runtime writes nothing under the laptop store") is also unpinned, so a
   later S10 has no regression net for the §7 "pod is not trusted" rule.
   S10 is `load-bearing` and was assigned to opus. It needs its own Execution and a fresh-context Review.
2. **MEDIUM: `apps/mobile/src/artifact-cache.ts:138`.** `cacheDir` sanitizes with
   `[^A-Za-z0-9._-]`, which keeps a computer id of `..` or `.` whole, so `cacheDir("..")` is
   `artifacts/..`, the cache root. *Scenario:* the planned session-delete step
   (`missingFrom` doc, `:121-125`) removes "a computer's directory", and for that id it would
   wipe the whole artifacts cache (and more, depending on how the caller joins the path). The
   test (`artifact-cache.test.ts:112`) checks only `../../etc`, where the `/` is replaced.
   The fix is to refuse or escape a dot-only id, and add a test for it.
3. **MEDIUM: gate red on HEAD (S4).** See Gate above. The S7 Execution blames "S4's work in
   progress", but those files are COMMITTED on the branch, so the branch cannot merge as it is.

**Mutation (independent).** `allowNavigation` → `url !== undefined`: 13 pass, 1 fail (RED).
Reverted, and `git status` is clean. The executor's M1–M13 table matches this one data point.

**Attacks tried, finding nothing:** `planCache` with `keep` equal to the LRU entry and
`incoming.size > cap` (both handled, no partial write). `viewerFor` with a prototype or unknown
kind goes through `artifactKindOf` to `none`. The PDF props force scripts off whatever the
input. The HTML props put the CSP first, with no `onMessage`/`injectedJavaScript` keys.

**Executor behaviour:** S7 is careful and honest about its drift: test-after for the viewer,
compensated by mutation. But it left S10 silently skipped, although the plan's execution order
puts S10 *before* S7.

### Round 2

*— claude-opus-5-5, 2026-11-16*

**Verdict: PASS (no HIGH/MEDIUM).** The fix commit is `b7b3403a`.

- **Gate:** `bun run typecheck` is clean and `bun run lint` is clean (1823 files). Full `bun test`: 13258 pass, 5 skip (the opt-ins), 0 fail.
  The touched files (`artifacts-durable`, `artifact-manifest`, `artifact-store`, `artifact-cache`, `wiring`): 90 pass, 0 fail.
- **Finding 1 (S10 missing) is fixed.** The laptop now keeps each presented version at the same save points as the log: `LaptopArtifacts` in `local-runtime.ts`, writing through `SessionSaver.putArtifact` → `LogSessionStore`.
  A resumed session gets its artifacts back through the worker-only `artifactSeed` (`worker.ts:241`, read-only, lazy).
  `keepArtifacts: true` and `artifactSeed` are set ONLY on the worker path (`local-runtime.ts:1748`, `worker.ts`; grep finds no pod or `connect` site).
  A seeded blob is read only for a sha the manifest names, has its size checked, and is charged to the budget.
  `mint()` skips seeded ids, and a re-present of a seeded id gets `last+1`.
- **Finding 2 (`cacheDir` dot-only ids) is fixed** (`artifact-cache.ts`): a dot-only or empty name is replaced with `_`.
- **Finding 3 (gate red) is fixed:** S4's store methods now exist and the format error is gone.
- **Mutations (independent, each RED, then reverted; `git status` clean):**
  - laptop copy always on (pod path): the T10 pod test fails;
  - drop the seed's size check: the "SHORT blob" test fails;
  - drop the dot-only escape: the round-2 `cacheDir` test fails.
- **Nit (not blocking):** `session-log-store.ts:730` has `*/ function indexOfId(` on one line (Biome accepts it, but it reads oddly).
