# eval/attachments — images and files from any client (sister of the v2 redesign)

> **Status:** eval (sister of `docs/eval/session-reattach.md`, step 9)
> **Branch:** none until promoted
> **Type:** eval → feat · **Size:** L → split (see Review) · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (persisted format, agent loop, providers, AGENTS §7)

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** how a client (TUI, React Native, Swift) sends
images the model must see, and files the agent must work on.

State today:

| Layer | State | Evidence |
|---|---|---|
| Wire | `image` (inline base64) and `resource` blocks exist | `protocol/src/content.ts` |
| Daemon | keeps text only, **drops other blocks silently** | `daemon/src/mapping.ts:14-19` |
| History | message content is a `string` | `core/src/model.ts:29` |
| Providers | no image support | no `image_url`/image block in `packages/providers` |
| Transport | 8 MiB frame cap; base64 adds a third | `daemon/src/ws-server.ts:40` |

Two different needs: (1) **images for the model** (vision — a screenshot, a
whiteboard photo): multimodal content to the provider; (2) **files for the
workspace** (a CSV, a log): the model needs a path, not bytes — the agent reads
it with its tools.

## Implementation

*(empty — filled when promoted)*

## Execution

*(empty — an eval)*

## Review

*— claude-opus-5-5, 2026-10-19*

Decisions already fixed by the parent (point 18), so v2 does not need a v3:
- Content blocks reference an attachment by **content hash**
  (`attachmentId` = sha256), never inline bytes in `prompt`.
- Bytes travel by a separate **chunked, resumable, idempotent** upload
  (`attachment/put {sha256, mimeType, size, offset, chunk}`, ~256 KiB chunks
  interleaved with other traffic; "how many bytes of X do you have?" on
  re-attach) **over the same RPC channel** — no side HTTP endpoint, since pod
  modes only have the exec stream (one session path, AGENTS §7). Relates to
  `docs/eval/rpc-flow-control.md`.
- History stores references; a content-addressed store on the daemon keeps the
  bytes; clients fetch on demand (`attachment/get`). Snapshots stay small.
- Until built, non-text blocks are rejected explicitly (in
  `session-event-stream`).

Still to decide: capability advertisement (`initialize` →
`agentCapabilities.prompt.image` from the configured model, so a client can
hide the button); client-side downscale/convert (HEIC → JPEG/PNG, long side
≈1500 px) as a protocol recommendation; upload confinement (`uploads/` under the
workspace, names = hash, original name as metadata only, size caps per file and
per session); attachment lifetime (tied to the session, GC on close); persisted
history format change and its migration (`docs/eval/session-store-durability.md`).

**Why, item by item (for the decisions above and those still open).**

- **Why reference by content hash.** The same screenshot sent twice is stored
  once; the hash identifies the bytes independently of any upload attempt, so
  an interrupted upload resumes ("how many bytes of X do you have?") and a
  retry is idempotent; and the daemon can verify integrity on completion.
- **Why chunked upload, separate from `prompt`.** A 6 MB image in one frame
  blocks every other event on the single WebSocket (head-of-line), restarts
  from zero when a mobile link drops, and runs into the 8 MiB frame cap
  (`ws-server.ts:40`) once base64 adds a third.
- **Why over the RPC channel and not a side HTTP endpoint.** Pod `run` /
  `attach` have only the exec stream: an HTTP endpoint would work on `serve`
  and not on pods — a second path (AGENTS §7) plus a second authentication
  surface to secure.
- **Why history stores references, not bytes.** Base64 images inside
  `ChatMessage`s would inflate every snapshot, every persisted session file and
  every re-attach — the opposite of the paged snapshot's goal.
- **Why reject until built.** Silent drop (today) makes the model answer as if
  the image were not there while the user believes it saw it.
- **Why advertise the capability in `initialize`.** Not every configured model
  supports vision. Hiding the button beats uploading 5 MB to then get an error.
- **Why downscale and convert on the client.** Providers downscale large images
  anyway; sending 12 MP wastes bandwidth, battery and tokens. HEIC — the iPhone
  default — is not accepted by providers. The figures (~1500 px long side,
  ~256 KiB chunks) are proposals to calibrate, not decisions.
- **Why hash-based names under `uploads/`.** A client-chosen file name is a path
  traversal waiting to happen (`../../.ssh/authorized_keys`); the hash is safe
  by construction, and the original name stays as metadata.
- **Why attachments live and die with the session.** Otherwise the store only
  grows; tying GC to `close` reuses the lifecycle the registry already defines.
- **Why pod-produced attachments are display-only.** Bytes from the pod are
  pod-supplied data (AGENTS §7): auto-opening them on the laptop or phone would
  let the pod act on the user's device.

Proposed split when promoted: (a) multimodal `ChatMessage` content in core +
image support in providers (load-bearing: persisted format, compaction, token
counting, `docs/eval/history-validity-invariant.md`); (b) attachment store +
chunked upload/get; (c) client UI (per frontend).

Pod-trust: uploads flow user → pod, the safe direction; an attachment the
*pod* produces and the laptop fetches is pod-supplied data — display only,
never auto-opened.
