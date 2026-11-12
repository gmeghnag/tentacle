# feat/attachments-upload — `attachment/put`: chunked, resumable image upload into a session's daemon store

> **Status:** implementation (awaiting owner approval of §Owner questions)
> **Branch:** `feat/attachments-upload`
> Type: feat · Size: M · Blast: load-bearing · Suited: DeepSeek exec + mandatory fresh Opus review

Umbrella: `docs/feat/attachments.md` §Promotion, §Split row 2a. Foundation
(merged): `docs/feat/attachments-core.md` — its `#### Owner answers
(2026-11-12)` bind this task (15 MB per image, no downscale, 5 refs per
message, `PROTOCOL_VERSION` already 23).

## Context

*— claude-opus-5-5, 2026-11-12*

Sub-task 1 put image **refs** (`{id: sha256, mimeType, size, name?}`) into the
history end to end, with an `AttachmentSource` seam that reads the bytes on the
trusted side (`core/src/model.ts`, `providers/src/images.ts`). Nothing yet
**moves the bytes** from a client to the daemon that holds the provider: the
only image path on the wire is the inline `image` prompt block, which the
daemon refuses (`daemon/src/mapping.ts:128-136`), and which could not carry a
15 MB image anyway (≈ 20 MB base64, over the `serve` WS 8 MiB frame cap,
`daemon/src/ws-server.ts:54,224`).

This task adds the transfer and the daemon-side store, and nothing else:

- `attachment/put` — 256 KiB chunks, idempotent, resumable (every ack carries
  `have`, the bytes the daemon holds), sha256 verified daemon-side.
- A per-session, content-addressed, **in-memory** store on the daemon with
  bounded memory (per-session and daemon-wide caps).
- `RemoteClient.upload()` — window W=2 (the measured sweet spot,
  `docs/eval/rpc-flow-control.md:176,196`), resumes across a reconnect.

**Out of scope (seams named in §Design D7):** 2b `feat/attachments-prompt`
(the prompt block, the store as `AgentConfig.attachments`, the laptop scoped
source for `model/stream*`, `model.images`); 4 `feat/attachments-durable`
(bytes on disk, survive restart/`--resume`). No `cli`, no `tui` change: there
is no user-visible producer until 3b.

**Repro** (2026-11-12, bun 1.4.3, this branch = `main` @ 3c27bfd): the
capability is missing — `rg -n "attachment/put|AttachmentPut" packages` → no
hit; a client can only send the refused inline block (core repro *r1*,
`attachments-core.md` §Context). The load-bearing repro is in §Load-bearing
assumption.

## Implementation

*— claude-opus-5-5, 2026-11-12*

### Load-bearing assumption

**The RPC peer dispatches inbound requests concurrently (a slow handler blocks
nothing), and each handler's synchronous prefix runs in frame-arrival order —
so a store `put` that is synchronous from its offset check to its append is
atomic per frame and ordered per connection, with no lock** (AGENTS §7 forbids
one: "Don't serialize the RPC peer").

Source:
- `transport/src/peer.ts:322` — `void this.handleRequest(...)`: not awaited,
  no per-connection mutex.
- `peer.ts:332-352` — `handleRequest` has no `await` before `await
  handler(...)` (method check, sync `safeParse`, cancel controller): the
  handler is CALLED synchronously in arrival order.
- `daemon/src/connection.ts:231-242` — `onRequest` has no `await` before its
  `switch`; the existing sync cases (`session/log`, `job/kill`, …,
  `:264-296`) rely on exactly this ("Synchronous, … no lock, no await").
- `transport/src/channel.ts:36-40` — the in-memory pair delivers each `send`
  in order (one microtask per frame); WS, stdio and port channels are ordered
  byte streams.

Repro (`bun /Users/gmeghnag/tentacle/.tentacle/tmp/attachments-upload/dispatch.ts`,
2026-11-12, bun 1.4.3) — two real `RpcPeer`s on `createChannelPair()`; one
request whose handler awaits 200 ms (a `prompt` stand-in), then 4 `put`
stand-ins whose handler does a synchronous `if (off === have) have += 1`:

```ts
// dispatch.ts (2026-11-12) — load-bearing check for feat/attachments-upload:
// (1) a slow in-flight request does not block later ones (no serialization);
// (2) each handler's SYNCHRONOUS prefix runs in frame-arrival order, so a
//     synchronous store `put` (check offset === have, append) needs no lock.
import { Method } from "@tentacle/protocol";
import { createChannelPair, RpcPeer } from "@tentacle/transport";

const [a, b] = createChannelPair();
const order: string[] = [];
let have = 0;
new RpcPeer(b, {
  onRequest: async (_m, params) => {
    const id = (params as { sessionId: string }).sessionId;
    if (id === "slow") {
      order.push("slow:start");
      await new Promise((r) => setTimeout(r, 200));
      order.push("slow:end");
      return { entries: [] };
    }
    // put-<offset>: synchronous check-and-append, like the planned store.
    const off = Number(id.slice(4));
    if (off === have) have += 1;
    order.push(`${id}:have=${have}`);
    return { entries: [] };
  },
});
const client = new RpcPeer(a);
const t0 = Date.now();
// The result shape is irrelevant (it rejects as "invalid result"): answers are
// timed whether they resolve or reject.
const at = (p: Promise<unknown>, tag: string) =>
  p.catch(() => 0).then(() => `${tag}@${Date.now() - t0}ms`);
const slow = at(client.request(Method.Log, { sessionId: "slow" }), "slow");
const puts = [0, 1, 2, 3].map((o) => at(client.request(Method.Log, { sessionId: `put-${o}` }), `put-${o}`));
const done = await Promise.allSettled([...puts, slow]);
console.log(done.map((d) => (d.status === "fulfilled" ? d.value : `ERR ${d.reason}`)).join(" "));
console.log("order:", order.join(" | "));
console.log("final have =", have);
process.exit(0);
```
```
put-0@1ms put-1@1ms put-2@1ms put-3@1ms slow@203ms
order: slow:start | put-0:have=1 | put-1:have=2 | put-2:have=3 | put-3:have=4 | slow:end
final have = 4
```

Reading: (1) the four puts are answered at 1 ms while the slow request is in
flight — not serialized; (2) they ran in arrival order, each check-and-append
whole — `have` = 4, no rewind. **Consequence for the design:** the store's
`put` must stay synchronous end to end (base64 decode, hasher update, copy,
digest on the last chunk — all sync). An `await` inside it would break the
atomicity this plan relies on; the executor pins it (T2 "sync" case, §Tests).

### Preconditions

| # | Fact | Source |
|---|---|---|
| P1 | An unknown method gets `MethodNotFound` before any handler: a new method is additive; an older daemon refuses it cleanly | `transport/src/peer.ts:333-335`; AGENTS §7 "Fields and methods are free" |
| P2 | Params are parsed by the method's schema before the handler; payloads are strip schemas (never `.strict()`) | `peer.ts:337-342`; `protocol/src/index.ts:8-12` |
| P3 | A session method resolves its session only if it is open **on this connection** (`UnknownSession` otherwise) — the authorization boundary for `put` | `daemon/src/connection.ts:476-486` |
| P4 | `HostedSession.close(reason)` is the single end of a live session: `session/close` / idle reaper / detached cap go through `SessionHost.archive` → `hosted.close()` or `hosted.archive()` → `close("closed")`; `session/delete` → `hosted.close("deleted")`. Idempotent (`this.closed`) | `session-host.ts:540-542,553-558,734-744,861`; `hosted-session.ts:2856-2860,2920-2922` |
| P5 | The name `attachments` is TAKEN on `HostedSession` (the attached-client set) → the store field is `uploads` | `hosted-session.ts:510,2896` |
| P6 | Frame caps: `serve` WS 8 MiB; stdio / port channels uncapped (the check runs only when set). A 256 KiB chunk is 349 528 base64 chars | `ws-server.ts:54,224`; `peer.ts:281-286` |
| P7 | Limits from core: `MAX_IMAGE_BYTES = 15 MiB`, `ATTACHMENT_ID_RE` (lowercase hex sha256) | `protocol/src/attachment.ts:18,36` |
| P8 | `RemoteClient` already has the reconnect idiom for a read: `whenLive(entry)` + generation check, retrying only when the drop was the cause | `client/src/remote-client.ts:1432-1441` |
| P9 | W=2 × 256 KiB keeps control messages at ≈ 0.2–0.35 s behind a bulk transfer on a real link; larger windows only add latency | `docs/eval/rpc-flow-control.md:163,176-177,196` |
| P10 | `PROTOCOL_VERSION = 23` (core); a mixed pair already fails at `initialize` | `protocol/src/version.ts:23-27` |
| P11 | Incremental sha256 is synchronous (`node:crypto` `createHash().update()`), already used in the repo | `agent/src/session-store.ts:8,152` |

### Design

**D1 — protocol (the shared truth).** New `protocol/src/attachment-upload.ts`
(exported from `index.ts`). Not in `attachment.ts`: that file is imported by
`session.ts` (`ChatMessageSchema`), and the put needs `SessionIdSchema`
(`session.ts:22`) — keeping it separate avoids an import cycle:

```ts
export const ATTACHMENT_CHUNK_BYTES = 256 * 1024;                 // raw bytes per put (P9)
const CHUNK_B64_MAX = Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4;  // 349_528
export const AttachmentPutParamsSchema = z.object({
  sessionId: SessionIdSchema,
  id: z.string().regex(ATTACHMENT_ID_RE),           // sha256 of the WHOLE blob
  size: z.number().int().positive().max(MAX_IMAGE_BYTES),
  offset: z.number().int().nonnegative(),
  data: z.string().max(CHUNK_B64_MAX).regex(/^[A-Za-z0-9+/]*={0,2}$/),  // base64; "" = probe
});
export const AttachmentPutResultSchema = z.object({
  have: z.number().int().nonnegative(),   // contiguous bytes held from 0
  complete: z.boolean(),                  // true ⇔ verified and readable
});
```

`Method.AttachmentPut = "attachment/put"` + its `RequestSchemas` row
(`methods.ts:69,129-175`). One domain error, additive:
`DomainErrorCode.AttachmentRefused = -32016` (`jsonrpc.ts:29-50`) with
`data: { reason: "too_large" | "store_full" | "hash_mismatch" | "bad_chunk" }`.
No `mimeType` in `put`: the store holds bytes by hash; the type is the REF's
business, checked where the ref enters (`checkAttachmentRefs` at
`Session.send`, 2b). No `attachment/get` / `status` method: the probe (`data:
""`) is the status, and nothing reads bytes back over the wire (smaller
surface; in pod mode the laptop keeps its own copy — 2b).

**Version: no bump.** A new method + a new error code are additive (P1, P2;
AGENTS §7 "Fields and methods are free"). A v23 daemon from before this task
answers `MethodNotFound`; `upload()` maps it to a specific
`AttachmentsUnsupportedError` ("this daemon cannot receive images — update
it"). No `session/update` variant is added (progress is the client's own acks).

**D2 — daemon: `AttachmentStore` (new `daemon/src/attachment-store.ts`),
synchronous, React/IO-free.**

```ts
export class UploadBudget {               // ONE per daemon (SessionHost), shared by every store
  constructor(readonly maxBytes: number); // default DAEMON_UPLOAD_BYTES (Owner Q1)
  reserve(n: number): boolean; release(n: number): void; get used(): number;
}
export class AttachmentStore implements AttachmentSource {
  constructor(budget: UploadBudget, opts?: { maxBytes?: number /* SESSION_UPLOAD_BYTES */; partialIdleMs?: number; now?: () => number });
  put(p: { id: string; size: number; offset: number; data: string }): { have: number; complete: boolean };  // throws RpcError
  read(ref: AttachmentRef): Promise<Uint8Array | null>;  // the 2b seam: complete + size match, else null
  dispose(): void;                                        // releases every reservation; idempotent
}
```

Entries: `Map<id, Partial | Complete>`. `Partial = { buf: Uint8Array(size),
have, hasher, touchedAt }`; `Complete = { bytes }`. `put` algorithm (all sync,
first matching rule wins):

1. `size > MAX_IMAGE_BYTES` → schema already refused (P2); kept as a guard.
2. Entry `Complete` with `bytes.length === size` → `{have: size, complete:
   true}` (dedupe: a re-attached image transfers zero chunks). With another
   size → `bad_chunk` (the id fixes the size; a client lying about it is broken).
3. No entry → `data === ""` or `offset === 0` required (else ack `{have: 0}`,
   no reservation). Evict partials idle ≥ `partialIdleMs` (default 10 min,
   oldest first) if needed, then reserve `size` in the session cap AND the
   budget; either full → `store_full` (nothing reserved). Create the partial.
   The reservation counts the DECLARED size, so memory is bounded before a
   byte arrives (a peer declaring 15 MiB and sending nothing still pays).
4. Partial with another `size` → `bad_chunk`.
5. `data === ""` (probe) → `{have, complete: false}`, `touchedAt = now`.
6. Decode `data`. `offset + len > size` or `len === 0` → `bad_chunk`, partial kept.
7. `offset + len <= have` → duplicate: ack `{have}`, **no write, no compare**
   (the bytes were already hashed once; a duplicate's bytes never reach `buf`).
8. `offset > have` or `offset < have < offset + len` (a gap or a straddle) →
   ack `{have}`, no write — the client rewinds to `have` (out-of-order converges).
9. `offset === have` → copy into `buf`, `hasher.update(chunk)`, `have += len`,
   `touchedAt = now`. If `have === size`: digest; `=== id` → replace with
   `Complete{bytes: buf}` (no copy; reservation kept), return `complete:
   true`; `!== id` → delete the entry, release its reservation, throw
   `hash_mismatch`.

Caps (Owner Q1): `SESSION_UPLOAD_BYTES = 100 MiB` (≥ one full message: 5 × 15
MiB), `DAEMON_UPLOAD_BYTES = 256 MiB`. Completed blobs are never evicted while
the session lives (a ref in history needs them; eviction would turn into an
`[image unavailable]` placeholder silently) — a full store refuses NEW uploads
loudly instead. Only stale partials are evicted.

**D3 — daemon wiring.**
- `HostedSession`: new trailing constructor param `uploads: AttachmentStore =
  new AttachmentStore(new UploadBudget(DAEMON_UPLOAD_BYTES))` (positional,
  like its siblings, `hosted-session.ts:585-598`; the default keeps every
  existing test constructor compiling); `readonly uploads`; `close()` calls
  `this.uploads.dispose()` beside `this.attachments.clear()` (`:2896`) — the
  single end (P4) covers close, archive, reaper, cap eviction and delete.
- `SessionHost`: owns ONE `UploadBudget` (option `uploadBytes?`, default
  `DAEMON_UPLOAD_BYTES`) and passes `new AttachmentStore(this.budget)` at
  `new HostedSession(` (`session-host.ts:967`).
- `Connection.onRequest` (`connection.ts:242-316`): 
  ```ts
  // Synchronous, holds no lock (AGENTS §7): the store's put never awaits.
  case Method.AttachmentPut: {
    const { sessionId, ...chunk } = params as AttachmentPutParams;
    return this.lookup(sessionId).uploads.put(chunk);
  }
  ```
  `lookup` = open on THIS connection (P3). The store lives with the
  `HostedSession`, not the connection, so a detached-then-reattached `serve`
  client resumes where it stopped.
- `/clear` does not touch the store (the next chat may attach the same image).
  A `serve` restart loses it (memory; durability is sub-task 4) — the client's
  probe then reads `have: 0` and starts over.

**D4 — client: the window as a pure module (AGENTS §7 "logic lives in pure
modules").** New `client/src/upload-window.ts`, React/IO-free:

```ts
export const UPLOAD_WINDOW = 2;
export type UploadStep = { kind: "send"; offset: number; length: number } | { kind: "wait" } | { kind: "done" };
export class UploadWindow {
  constructor(size: number, opts?: { window?: number; chunk?: number; maxSentFactor?: number /* 3 */ });
  ack(sentOffset: number, r: { have: number; complete: boolean }): void;  // throws UploadProtocolError
  next(): UploadStep;          // the next chunk to send, or wait (window full), or done
  rewind(have: number): void;  // after a probe (reconnect)
  get have(): number;          // highest acked contiguous `have` (progress, for 3b)
}
```

Rules: `next` sends from `cursor` while `inFlight < window`; `ack` sets
`acked = max(acked, have)` and, when `have < sentOffset + length` (gap /
reorder / daemon restarted), moves `cursor` back to `have` (in-flight chunks
past it will be acked as gaps and ignored). Violations (a hostile or broken
daemon — a pod is not trusted) throw: `have > size`; `complete && have !==
size`; `have === size && !complete` after the last chunk's ack; bytes sent >
`maxSentFactor × size + window × chunk` (a daemon that keeps answering
`have: 0` cannot make the laptop send forever).

**D5 — `RemoteClient.upload()`** (`client/src/remote-client.ts`, beside
`snapshot`, `:1420`):

```ts
upload(sessionId: string, bytes: Uint8Array, opts?: { signal?: AbortSignal; onProgress?: (have: number, size: number) => void }): Promise<{ id: string; size: number }>;
```

- Before any frame: `size === 0` or `> MAX_IMAGE_BYTES` → `RangeError`;
  `id = sha256(bytes)` computed HERE. The returned `{id, size}` comes from the
  laptop's own bytes, never from a daemon answer.
- Probe (`data: ""`, `offset: 0`) → `complete` ⇒ return at once (dedupe);
  else `window.rewind(have)`.
- Loop: `window.next()` → issue `put` (base64 of `bytes.subarray`) without
  awaiting it; on each settle, `ack` and call `onProgress`; at most 2 puts in
  flight. The control traffic of the same connection (prompt, permission,
  `enqueue`) interleaves between chunks (load-bearing assumption; P9).
- Reconnect (P8 idiom): a put rejected because the channel dropped (`gen`
  changed / `!this.up`) → `await this.whenLive(entry)`, drop the in-flight
  bookkeeping, probe again, `rewind(have)`, continue. Any other rejection
  (`AttachmentRefused`, `UnknownSession`, a violation) → reject `upload()` with
  that error, no retry. `MethodNotFound` → `AttachmentsUnsupportedError`.
- `signal` aborted → stop issuing, reject with an `AbortError`; the daemon's
  partial stays and a later `upload()` of the same bytes resumes from `have`.

**D6 — trust (AGENTS §7).** The upload is laptop → daemon only; the daemon
never names a path, a hash to read, or bytes to fetch — `upload()` takes the
caller's bytes, so a hostile pod can at worst lie in acks, which D4 bounds and
which cannot reach a laptop file. Daemon side, a hostile authenticated peer
(another device on `serve`, same user) can only (a) fill its own sessions'
caps → `store_full` (bounded by the budget) or (b) race different bytes under
the same id into a shared partial → the digest fails, the partial is dropped,
the honest client gets `hash_mismatch` and may retry: a nuisance, never a
wrong image (a `Complete` entry is always the verified bytes of its id). No
daemon-side magic-byte sniff here: the provider gets the ref's declared type,
and the TUI sniffs (3a).

**D7 — seams for later sub-tasks (out of scope here).**
- 2b: `HostedSession.uploads` already `implements AttachmentSource` → 2b sets
  `AgentConfig.attachments = hosted.uploads` (worker / `serve`, where the
  daemon holds the provider) and adds the prompt block. In pod runtimes the
  provider runs on the LAPTOP (`ProxyModelProvider`), so the bytes are needed
  laptop-side, not in the pod (Owner Q2). The laptop scoped source hooks the
  single exit point `RemoteClient.upload()` (or replaces it for pods).
- 4: `AttachmentStore` becomes disk-backed for `serve` behind the same
  `put` / `read` / `dispose` API; `dispose` grows "archive keeps, delete
  removes". The wire does not change.

### Files (dependency order)

1. `packages/protocol/src/attachment-upload.ts` (new) · `protocol/src/index.ts` (export) · `protocol/src/methods.ts` (`Method.AttachmentPut` + `RequestSchemas` row) · `protocol/src/jsonrpc.ts` (`AttachmentRefused`) · `packages/protocol/schema/protocol.json` (`bun run schema:export`)
2. `packages/daemon/src/attachment-store.ts` (new) · `daemon/src/hosted-session.ts` (param, field, `close`) · `daemon/src/session-host.ts` (budget, `:967`) · `daemon/src/connection.ts` (one `case`) · `daemon/src/index.ts` (export)
3. `packages/client/src/upload-window.ts` (new) · `client/src/remote-client.ts` (`upload()`, `AttachmentsUnsupportedError`) · `client/src/index.ts` (export)

No `cli`, `tui`, `agent`, `providers`, `config` change. No `PROTOCOL_VERSION` change.

### Failure modes

| Mode | What happens | Converges how | Pinned by |
|---|---|---|---|
| Disconnect mid-upload | in-flight puts reject; the daemon partial stays (it belongs to the `HostedSession`, not the connection) | `whenLive` → probe → `rewind(have)` → continue; bytes resent ≤ 2 chunks | T5 |
| Duplicate chunk (retry, reconnect overlap) | rule 7: ack, no write | idempotent; final digest unaffected | T2 |
| Out-of-order / gap / straddle | rule 8: ack current `have`, no write | client rewinds to `have` | T2, T4 |
| Hash mismatch (corruption, a racing different-bytes writer) | partial dropped, reservation released, `hash_mismatch` | `upload()` rejects with it; nothing half-stored; never a `Complete` of wrong bytes | T2, T5 |
| Image > 15 MiB / size 0 | client `RangeError` before any frame; daemon schema `InvalidParams` as backstop | — | T1, T5 |
| Session or daemon cap full | `store_full` before any byte is accepted; stale partials (idle ≥ 10 min) evicted first | loud error naming the cap; completed blobs never evicted | T2 |
| Declared-size reservation DoS | a 15 MiB reservation per begun upload, counted at once | bounded by session cap + daemon budget | T2 |
| Concurrent uploads, same id, same bytes (two `serve` clients) | one shared partial, both advance it; acks carry the shared `have` | one `Complete`; the slower client's next ack is `complete` | T3 |
| Concurrent uploads, different ids | independent partials, each reserved | caps apply to the sum | T2 |
| Session closed / archived / reaped / deleted mid-upload | `close()` → `dispose()` releases everything; next put → `UnknownSession` (`lookup`, P3) | `upload()` rejects, no retry; budget back to its prior value | T3 |
| Put for a session not open on this connection | `UnknownSession` | — | T3 |
| `serve` restart | memory store gone | probe reads `have: 0`, upload restarts (durable bytes = sub-task 4) | T5 (fake: fresh store) |
| Older v23 daemon (pre-2a) | `MethodNotFound` | `AttachmentsUnsupportedError`, specific text | T5 |
| Hostile pod / broken daemon acks (`have > size`, `complete` early, `have: 0` forever) | `UploadProtocolError` | bounded sends (`3 × size + window × chunk`); no laptop read anywhere | T4, T5 |
| Malformed base64 / oversize `data` | schema → `InvalidParams` (P2) | partial untouched | T1 |
| Upload aborted (`signal`) | stops issuing; partial kept | a later `upload()` resumes | T5 |
| A slow handler / turn running | puts are sync; the peer is not serialized | control requests answered between chunks | T3, repro |
| Empty upload | `size 0` refused (client + schema `positive()`) | — | T1, T5 |

### Tests

Property: **a blob reaches the daemon store complete, sha256-verified and
byte-identical whatever the drops, duplicates and reorders; it never exists
there half-written or with wrong bytes; memory is bounded by the caps and
returned when the session ends; the laptop never sends more than a bounded
multiple of the blob, whatever the daemon answers.**

All new: write each test first, show it RED (module / method absent — and,
more usefully, red under the mutations below), then implement. Fakes: the
in-memory `createChannelPair` + real `Connection` / `RemoteClient` (copy
`client/test/model-stream-stop-reason.test.ts` for the wiring); a fake daemon
`RpcPeer` for hostile acks; an injected `now` for idle eviction.

| # | File | Asserts |
|---|---|---|
| T1 | `protocol/test/attachment-upload.test.ts` | params: bad id, `size` 0 / > 15 MiB, negative / float offset, `data` over 349 528 chars or non-base64 → reject; `data: ""` ok; result shape; `Method.AttachmentPut` in `RequestSchemas`; `AttachmentRefused === -32016` |
| T2 | `daemon/test/attachment-store.test.ts` | in-order 1 MiB → `complete`, `read(ref)` deep-equal bytes; probe on complete → `{have: size, complete: true}`; **duplicate chunk with DIFFERENT bytes at an old offset leaves the result byte-identical** (proves no write); gap / straddle → `{have}` unchanged; `offset + len > size` → `bad_chunk`; wrong last bytes → `hash_mismatch`, entry gone, `budget.used` back to before; session cap and daemon budget → `store_full` with nothing reserved; stale partial (injected `now` + 10 min) evicted to make room, fresh one not; `dispose()` releases all and is idempotent; `read` of a partial / size-mismatched ref → `null`; **sync**: `put` returns a plain object, not a Promise |
| T3 | `daemon/test/attachment-put.test.ts` (real `Connection`) | put on a session not opened on this connection → `UnknownSession`; after `session/close` and after `session/delete` → `UnknownSession` and the shared budget back to 0; detach + reopen on a second connection → probe returns the earlier `have`; two connections on one session upload the same bytes concurrently → one `Complete`, both end `complete`; a `session/log` request sent between chunks is answered before the last chunk's ack |
| T4 | `client/test/upload-window.test.ts` | in-order acks → offsets 0, 256 Ki, …, `done`; never more than 2 outstanding; an ack with a lower `have` rewinds the cursor; violations (`have > size`, early `complete`, `have: 0` forever) throw; the send bound holds |
| T5 | `client/test/upload.test.ts` (real `RemoteClient` ↔ real `Connection`) | 1 MiB + 1 byte upload → `{id: sha256, size}`, store bytes equal; a channel spy sees ≤ 2 puts in flight; dedupe: second upload of the same bytes sends only the probe; channel dropped after chunk 2 → reconnect (`channelFactory`) → first post-reconnect put is a probe, total bytes sent < size + 3 chunks; fake daemon `MethodNotFound` → `AttachmentsUnsupportedError`; fake hostile daemon (`have: 0` forever) → `UploadProtocolError`, frames bounded; 15 MiB + 1 → `RangeError`, zero frames; abort mid-way → rejects, a later upload resumes from `have` |

Mutations (each must turn the named tests red; revert after):
- drop rule 7's guard (write duplicates) → T2 duplicate-bytes case
- skip the digest compare → T2 mismatch, T5 (wrong id would be `complete`)
- don't release on mismatch / `dispose` → T2 budget, T3 close/delete
- remove `uploads.dispose()` from `HostedSession.close` → T3
- `lookup` replaced by `host.get` in the new case → T3 not-open
- make `put` `async` → T2 sync case
- `UPLOAD_WINDOW = 4` → T4, T5 in-flight
- remove the send bound → T4, T5 hostile (test has its own timeout)
- trust the daemon's `have` on `complete` without `have === size` → T4

Gate before done: `bun run check` (typecheck → lint → test), lint baseline
clean (AGENTS §4, §6). Narrow during iteration: the five files above.

### Owner questions

Recommendation first.

1. **Caps (memory, per daemon process).** (a) **100 MiB per session (≥ one
   full message, 5 × 15 MiB), 256 MiB per daemon; completed blobs live until
   the session ends; a full store refuses new uploads loudly.** (b) Smaller
   (e.g. 64 / 128 MiB) — one full 5-image message could not fit. (c) Spill to
   disk now — that is sub-task 4's design, pulls persistence in.
2. **Pod runtimes (`run`/`attach`): send the bytes into the pod?** (a) **No —
   the provider is on the laptop there (`ProxyModelProvider`), so 2b keeps
   the bytes in the laptop scoped source and sends the pod refs only; this
   task still builds `attachment/put` runtime-agnostic (worker, `serve`,
   future mobile).** (b) Upload into the pod too (15 MB over the k8s exec
   stream for nothing the pod uses). Binds 2b, not this task's code.
3. **Stale partial eviction.** (a) **A partial idle ≥ 10 min is evicted only
   when a new upload needs room** (a laptop asleep for an hour still resumes
   if nothing pushed it out). (b) A timer that evicts at 10 min regardless.
   (c) Never; only session end frees them.

## Execution

*— deepseek-v4.1-flash, 2026-11-12* (round 1 was authored by the same executor;
its `claude-sonnet-4-5` signature was a mis-signature, corrected here after the
review flagged it — see **Fix round 1** below)

**Load-bearing check, re-run FIRST (before any edit).** `bun
/Users/gmeghnag/tentacle/.tentacle/tmp/attachments-upload/dispatch.ts` on this
branch (bun 1.4.3) — identical to the plan's recorded output:

```
put-0@1ms put-1@1ms put-2@1ms put-3@1ms slow@202ms
order: slow:start | put-0:have=1 | put-1:have=2 | put-2:have=3 | put-3:have=4 | slow:end
final have = 4
```

Still holds: the four puts are answered at 1 ms while the slow request is in
flight (no serialization), and each ran its synchronous check-and-append whole,
in arrival order. Every P1–P11 citation was re-read against the code and
matched (`peer.ts:322,333-342`, `channel.ts:36-40`, `connection.ts:242-316` and
its `lookup` at `:476-486`, `hosted-session.ts:2896`, `attachment.ts:18,36`,
`version.ts:23-27`, `remote-client.ts` `whenLive`). Nothing in the plan was
contradicted, so no step was stopped.

**Slice 1 — protocol (DONE).** `packages/protocol/src/attachment-upload.ts`
(new: `ATTACHMENT_CHUNK_BYTES`, `ATTACHMENT_CHUNK_B64_MAX`, params/result
schemas, `AttachmentRefusedReason`), exported from `index.ts`;
`Method.AttachmentPut` + its `RequestSchemas` row; `DomainErrorCode.
AttachmentRefused = -32016`; `schema/protocol.json` regenerated
(`bun run schema:export`, +51 lines). No `PROTOCOL_VERSION` bump, as planned.
Tests: `protocol/test/attachment-upload.test.ts` (11), plus the two
`json-schema.test.ts` fixture rows the drift gate requires.

**Slice 2 — daemon (DONE).** `packages/daemon/src/attachment-store.ts` (new:
`UploadBudget`, `AttachmentStore`, `SESSION_UPLOAD_BYTES`,
`DAEMON_UPLOAD_BYTES`, `PARTIAL_IDLE_MS`); `HostedSession` gained a trailing
`uploads` constructor param (default keeps every existing test constructor
compiling) and `close()` calls `uploads.dispose()` beside
`attachments.clear()`; `SessionHost` owns ONE `UploadBudget` (`uploadBytes?`
option, plus a read-only `uploadBytesUsed` for the tests) and passes
`new AttachmentStore(this.uploadBudget)`; `Connection.onRequest` gained the one
sync case; `daemon/src/index.ts` exports the module.
Tests: `daemon/test/attachment-store.test.ts` (21),
`daemon/test/attachment-put.test.ts` (6).

**Slice 3 — client (DONE).** `packages/client/src/upload-window.ts` (new: pure
`UploadWindow` + `UPLOAD_WINDOW`, `UPLOAD_MAX_SENT_FACTOR`, `UploadProtocolError`,
`UploadAbortedError`), exported from `client/src/index.ts`;
`RemoteClient.upload()` beside `snapshot()`, with the private `pump` /
`putChunk` / `liveGeneration` helpers and `AttachmentsUnsupportedError`
(`ATTACHMENTS_OLD_DAEMON`). `packages/transport/src/index.ts` now also exports
`encodeBase64` (see drift 3).
Tests: `client/test/upload-window.test.ts` (12), `client/test/upload.test.ts`
(14).

**Drift from the Implementation (each with its reason).**

1. **D2's `probe` became a window method, not just a rule.** `put`'s probe
   branch was as planned, but the early-`complete` violation had to apply to the
   PROBE's answer too, and the window was the only place with the blob's size.
   Added `UploadWindow.probe(have, complete)` (throws on an early `complete`,
   else `rewind`s) and `RemoteClient.upload` calls it instead of `finish()` +
   `rewind()` separately. Same behaviour, one place to test it.
2. **D4's rewind rule needed the chunk's own length.** "Rewind when `have <
   sentOffset`" does not fire for a reordered pair (chunk 2 acked with
   `have === CHUNK` while chunk 1 is still in flight), so the client would have
   kept sending from the far cursor and skipped the missing chunk. `ack` now
   rewinds when `have < sentOffset + length` (the chunk's own end), which covers
   gaps, reorders and a straddle; the pure test pins it with a window-2 reorder.
3. **`encodeBase64` — a new export on `@tentacle/transport`.** `RemoteClient`
   is the package the mobile app depends on (`@tentacle/client`), and it has no
   `Buffer`/`btoa` there; the repo already has a dependency-free RFC 4648
   encoder (`transport/src/noise-frame.ts`) written for exactly that reason. It
   is now re-exported from the transport barrel rather than duplicated in
   `client`.
4. **A new seam: `RemoteClientOptions.sha256Bytes?`.** The plan assumed the id
   came from the existing `sha256` option (P11). That seam takes TEXT and
   UTF-8-encodes it, so the digest of anything above `0x7f` differs from the
   digest of the bytes (verified: `sha256(utf8(latin1(bytes))) !==
   sha256(bytes)`), and `upload` would have computed an id the daemon never
   accepts (`hash_mismatch` on every image). The text seam is untouched
   (`readBack` keeps using it); `sha256Bytes` is a second, injected option
   (Bun's `CryptoHasher.update(Uint8Array)` by default), keeping `@tentacle/
   client` node-free and the package's "inject, don't import" rule intact.
5. **`SessionHost.uploadBytesUsed`** (a read-only getter on the shared budget)
   was added beyond the plan's `Files` list so T3 can assert "the budget is back
   to 0" at the daemon level rather than through a store handle the test would
   otherwise have to reach into.
6. **`UploadWindow.rewind` no longer clamps to the previous `acked`.** After a
   drop the daemon is the truth; a LOWER `have` (a restarted store) is real
   progress lost, not a violation — clamping would have made the client send
   from a point the daemon no longer holds.
7. **The bounded-send check moved before the chunk is handed out**, so `sent` can
   never exceed `3 × size + window × chunk` (the plan's bound is on what goes on
   the wire, so an off-by-one chunk would have been a real overrun).
8. **T3's "a `session/log` between chunks is answered before the last ack" was
   strengthened, and a second test was added.** The first version could not fail
   for the property it named (puts are synchronous, so the ordering it checked
   was trivially true — confirmed by mutation: injecting a 30 ms `await` into the
   new `case` left it green). It now asserts the SETTLE order, and a new
   `Gated`-model test holds a `session/prompt` suspended on the model and
   asserts a put is still answered — red under a never-resolving `await` in the
   prompt path (mutation M21).
9. **The `json-schema.test.ts` fixture table needed two rows** for the new
   method (`methods/attachment~1put/params|result`) — the drift gate's "every
   method has a fixture" test. Not named in the plan's `Files`, but required by
   the existing gate.
10. **`daemon/test/attachment-put.test.ts` needs a `hooks/trust` answer** (the
    turn asks its prompting connection before it runs); the test client declines.

**Mutations run (each reverted; the named tests went red, then green again).**
M1 write duplicates instead of skipping (rule 7) → T2 duplicate-bytes. M2
`if (false &&` on the digest compare → T2 `hash_mismatch`. M3 drop the entry but
keep the reservation on mismatch → T2 budget. M4 `dispose()` a no-op → T2
`dispose`. M5 `async put` → T2 happy paths + the sync case. M6 no stale
eviction → T2 stale/fresh. M7 no declared-size reservation → T2 four cap cases.
M8 remove `uploads.dispose()` from `HostedSession.close` → T3 close/delete.
M9 `host.get` instead of `lookup` → T3 not-open + close/delete. M10/M15
`UPLOAD_WINDOW = 4` → T4 window + T5 reconnect (send bound). M11/M17 no send
bound → T4 (both bound cases), T5 hostile. M12 trust `complete` without
`have === size` → T4 early-complete, T5 early-complete. M13 no rewind on a lower
`have` → T4 reorder. M16 the same guard removed via `if (false)` → same as M12.
M18 skip the daemon's digest, T5 side → T2 mismatch (the client's own id and the
store's verification are what make this unreachable from T5 — stated, not
faked). M19 a 30 ms `await` inside the new `case` → **stays green**, reported
honestly: the store's own atomicity is what the sync rule protects, and a
delay before an atomic step cannot be observed through the wire in a test with
no interleaving peer; the property is pinned by T2's sync case (M5) and by the
dispatch repro. M20 a per-connection mutex around `onRequest` → also green for
the same reason (the in-memory channel settles a sync handler in the same
microtask), so it is NOT claimed as covered — M21 (a never-resolving `await` in
the prompt path) is the red proof for the no-serialization test, and the
`dispatch.ts` repro is the direct evidence.

**Gate.** `bunx tsc --noEmit` clean; `bunx tsc -p apps/mobile` clean (the mobile
workspace's deps ARE installed here); `bun run lint` clean (927 files, 0 errors,
0 warnings — the §6 baseline); `bun test` — **7226 pass, 3 skip (the opt-in
k8s/docker/slow ones), 0 fail**, 521 files. `schema/protocol.json` regenerated.
CHANGELOG `Added` under `[Unreleased]`.

## Review

**Verdict: REQUEST-CHANGES** (one HIGH, one MEDIUM). Scope: `git diff
main...HEAD` @ f3317ac only.

#### Findings

1. **HIGH: `upload()` spins forever, starving the event loop, when the link
   drops on a client with no `channelFactory`**
   (`client/src/remote-client.ts:1553`, together with `liveGeneration` beside it).
   The retry condition is `gen !== this.gen || !this.up`. Without a factory,
   `onLinkClosed` → `stop()` sets `up = false` **for good**, and
   `liveGeneration` returns `this.gen` straight away (no `whenLive`). So every
   iteration does probe → `peer.request` on a closed peer →
   `Promise.reject("peer is closed")` → `!this.up` → `continue`. That is a pure
   microtask loop: no timer, render or I/O ever runs again, and `upload()` never
   settles. `signal` cannot rescue it either, because the abort event can't be
   dispatched. Repro (`.tentacle/tmp/attachments-upload/review-spin.ts`: a real
   `Connection`, a plain `createChannelPair` client, the channel closed before
   the 2nd data chunk): `SPIN: 100000 putChunk calls on a dead link; 300ms
   timer never ran`. The same loop also runs WITH a factory when `entry` is
   undefined (an upload to a session this client did not open): the spin
   starves the redial timer, so the link never comes back. Fix direction: retry
   only when a reconnect can happen (`this.channelFactory && entry &&
   !this.stopError`), or else rethrow. Add a red test: a plain link closed
   mid-upload must reject. The Failure-modes table covered "disconnect" only
   with a factory (T5), and no test covers this path.
2. **MEDIUM: T5's "never more than 2 puts in flight" is vacuous**
   (`client/test/upload.test.ts:216`). It asserts `peak <=
   UPLOAD_WINDOW`, the imported constant, so it moves with the code under
   test. Mutation `UPLOAD_WINDOW = 4` leaves this test **green** (only T4's pure
   test and T5's reconnect bound went red). The property "≤ 2 on the wire" is
   claimed (§Tests T5) but not proved end to end. Compare against the literal
   `2`, and re-show red under W=4.

#### Gate (this review)

New files plus `json-schema.test.ts`: **86 pass, 0 fail** (6 files). `bun run lint`:
927 files, clean. I did not re-run the full `bun test` or `typecheck` here, so I
rely on the Execution's numbers (7226 pass / 3 opt-in skips) for those.

#### Mutations (each reverted by its exact inverse edit; `git status --porcelain` empty afterwards)

| # | Mutation | Result |
|---|---|---|
| R1 | rule 7 writes the duplicate (`buf.set` in the duplicate branch) | RED: "a duplicate chunk carrying DIFFERENT bytes leaves the blob byte-identical" |
| R2 | digest compare → `=== "never"` (never mismatch) | RED: "a wrong last chunk is `hash_mismatch`…" (1 of 41) |
| R3 | drop `this.uploads.dispose()` from `HostedSession.close` | RED: "after `session/close` and after `session/delete`: … budget back to 0" |
| R4 | `UPLOAD_WINDOW = 4` | RED: T4 "default window is 2", T5 reconnect; **green: T5 in-flight (finding 2)** |

#### Attacks tried

- **No serialized peer (§7):** the `case` in `connection.ts` is sync, with no
  lock and no await, and `put` is sync end to end (`Buffer.from`,
  `hasher.update`, `digest`). Holds.
- **Pod not trusted:** the id comes from the laptop's own bytes, the returned
  `{id,size}` never comes from an ack, and the send cap is cumulative across
  reconnects (the window is not rebuilt per retry), so drift 6 (no clamp on
  rewind) cannot be used to loop sends. Holds. One weakness, not a finding: a
  lying daemon answering `have:size, complete:false` to a non-last chunk makes
  `upload()` resolve without ever seeing `complete`. That is harmless, because
  a hostile daemon can equally answer `complete:true`.
- **Bounded memory 100/256 MiB:** the declared size is reserved before any
  byte. `fits` checks both caps, and `take` reserves the budget first. On
  mismatch or dispose, `drop` releases. There is one source construction site
  (`session-host.ts:985`, so no stray default budget), and eviction only takes
  this store's stale partials. Holds. By design, another session's completed
  blobs can hold the daemon budget until that session ends (owner Q1a).
- **Hash / duplicate / gap / straddle / out-of-order:** rules 7–8 never write.
  A `Complete` is only ever the verified buffer, and a mismatch drops the
  entry and its reservation. Holds (R1, R2).
- **Disconnect with a factory:** `whenLive` → probe → rewind works (T5 test).
  **Disconnect without a factory: broken (finding 1).**
- **sha256Bytes seam / drift 4:** justified. The text seam UTF-8-encodes, and
  `blob()` contains bytes > 0x7f, so the "laptop's own digest" test would catch
  the wrong seam. Injection and the non-Bun refusal path are untested (nit).
- **Executor drifts 1–10:** I checked each against the code, and each is
  reasoned and in scope. Drift 8's honest report that M19/M20 stayed green is
  correct and to the executor's credit.

#### What holds

The store logic, caps, auth boundary (`lookup`), dispose on the single
`close`, the additive protocol (no bump; `MethodNotFound` →
`AttachmentsUnsupportedError`) and the pure window are sound, and their tests
are non-vacuous under R1–R3.

#### How the executor behaved

Disciplined: it re-ran the load-bearing repro first, documented its drifts
with reasons, and reported vacuous mutations honestly instead of hiding them.
It missed the factory-less drop path and one tautological assertion. Note: the
Execution section is signed `claude-sonnet-4-5`, but the commit says
`(deepseek)`. The signature should name the model that actually executed
(AGENTS §10).

Reviewer: claude-opus-5-5, fresh context. Different family from the executor
(DeepSeek, per the commit).

*— claude-opus-5-5, 2026-11-12*

#### Owner answers (2026-11-12)

Q1 (a) 100 MiB per session / 256 MiB per daemon, kept until session end, explicit refusal when full. Q2 (a) no bytes in a pod: pod runtimes send refs only; `attachment/put` for worker, `serve`, mobile. Q3 (a) a stalled partial (≥ 10 min) is evicted only when space is needed, no timer. Implementation APPROVED.

### Fix round 1

*— deepseek-v4.1-flash, 2026-11-12* (via `tentacle --profile deepseek`; the
`claude-sonnet-4-5` signature on the round-1 Execution above was wrong — that
model did not execute this task)

Both findings fixed; the two fixes needed **three extra tests** beyond the ones
the review named, because the first mutations showed the naive versions to be
vacuous (see Mutations H3/H5).

#### Finding 1 (HIGH) — `upload()` on a dead link must not spin

**Reproduced first**, on the pre-fix code (`review-spin.ts`, the reviewer's own
file, run from `.tentacle/tmp/attachments-upload/`):

```
SPIN: 100000 putChunk calls on a dead link; 300ms timer never ran
```

**Measured first (it decided the test shape):** Bun 1.4.3's per-test timeout
does **not** fire during a microtask-starvation spin — two throwaway tests in
`.tentacle/tmp/attachments-upload/` showed a bounded spin being caught only by
its own `throw` (463 ms), while an unbounded one hung the runner until an outer
`timeout` killed it (`bun_exit=124`). A red test therefore **cannot** rely on a
timeout; it must bound the loop itself. That is what the `breaker` helper in
`upload.test.ts` does: it counts `attachment/put` requests on `RpcPeer.prototype`
and, past a limit, aborts the upload's own `signal` — which `upload()` re-reads
synchronously at the top of each iteration, so a spinning loop *ends* and the
failure lands on an assertion (`expect(guard.count()).toBeLessThan(n)`).

**As built** (`client/src/remote-client.ts`):

- `reconnectable = this.channelFactory !== undefined && entry !== undefined`
  (`:1531`). Retry needs both halves: a factory to dial, and an `entry` whose
  `session/open` is replayed on the new link. Neither alone can bring the link
  back, and both were part of the spin: the no-factory case (`stop()` sets
  `up = false` for good) and the factory-with-no-`entry` case (`liveGeneration`
  returned `this.gen` at once, so the retry re-ran a closed peer immediately).
- Not reconnectable ⇒ `throw new UploadLinkLostError()` at once
  (`:1566`-`:1570`) — the caller gets a clear, actionable error instead of a
  spinner that never stops.
- Reconnectable ⇒ the loop continues, but `liveGeneration` is now **bounded**
  (`:1651`-`:1700`): it waits on `whenLive(entry)` *and* on a
  `this.clock.setTimeout(…, UPLOAD_RECONNECT_MS)` deadline, whichever comes
  first, plus an abort listener so a cancel lands while the link is down. The
  deadline lives in a per-call `wait` object, set at the first drop and cleared
  when a probe is answered — so a genuinely flapping link gets a fresh window per
  real reconnect, while a link that never returns rejects at 30 s with
  `UploadLinkLostError(30_000)` ("did not come back within 30s; … uploading
  again resumes"). `UPLOAD_RECONNECT_MS = 30_000` is in `client/src/constants.ts`
  (same order as `ATTACH_TIMEOUT_MS`).
- `UploadLinkLostError` lives in the **pure** module `upload-window.ts`, beside
  `UploadProtocolError`/`UploadAbortedError`, so all three upload outcomes are
  classified in one React-free place (AGENTS §7).

Why not the reviewer's suggested one-liner (`retry only when channelFactory &&
entry && !stopError`, else rethrow)? It fixes the no-reconnect spin but leaves
the reconnectable case unbounded: a factory that keeps failing redials made
`upload()` wait for ever (redial backoff is capped at 30 s and retried
indefinitely, `link-machine.ts:10-11`), which is the same "never settles" bug
with a working event loop. `!this.stopError` is also implied by
`whenLive` rejecting with it.

#### Finding 2 (MEDIUM) — the in-flight test moved with the code

`client/test/upload.test.ts`: `expect(dial.peak.value).toBeLessThanOrEqual(2)` —
the literal, not the imported `UPLOAD_WINDOW` — plus
`expect(dial.peak.value).toBe(2)`, because `<= 2` alone is also satisfied by a
window of **1** (five chunks would then be fully serial). Both are measured on
the wire by the existing `Dialer` (frames written and not yet answered), so the
number is real concurrency, not the window's own bookkeeping.

#### Red before green (final evidence)

All five new link-loss tests against the **pre-fix** file (`git show
f3317ac:packages/client/src/remote-client.ts`, restored from a backup — no
`git checkout`/`restore`):

```
Received: 201 (fail) no `channelFactory`: a link dropped mid-upload rejects, promptly
Received: 201 (fail) no `channelFactory`, no session of ours either: rejects at once, zero puts
timed out 20s (fail) a factory that cannot reconnect at all: rejects, bounded, never spins
            (fail) an abort while the link is down ends the upload at once
            (fail) a factory, but a session this client never opened: rejects, bounded
 15 pass / 5 fail
```

Green after the fix: `20 pass, 0 fail` (file), `32 pass, 0 fail` with
`upload-window.test.ts`.

#### Mutations (each reverted; `git status --porcelain` back to the same 4 files)

| # | Mutation | Result |
|---|---|---|
| M1 | `UPLOAD_WINDOW = 4` | **RED**: "never more than 2 puts in flight…" (`Received: 4`), "the default window is 2…", T5 reconnect (send bound). This is the mutation the review found the test **green** under |
| H1 | `reconnectable = true` (≈ the original `!this.up → continue`) | **RED**: all three no-reconnect tests (`Received: 201` twice, once from the breaker) |
| H2 | drop the `UPLOAD_RECONNECT_MS` deadline (no timer) | **RED**: "a factory that cannot reconnect at all" fails on `expect(controller.signal.aborted).toBe(false)` at 2.0 s (the test's real-time backstop aborts it) — not a hang |
| H3 | delete the `signal?.addEventListener("abort", …)` in `liveGeneration` | **RED**: "an abort while the link is down…" → `Received value: "still waiting"`. **This mutation was originally GREEN**, so the abort test was added to cover it |
| H5 | `reconnectable = this.channelFactory !== undefined` (drop the `entry` half) | **RED**: "a factory, but a session this client never opened" → no `UploadLinkLostError`. **Originally GREEN**, so that test was added to cover it |
| H6 | restore the pre-fix `remote-client.ts` wholesale | **RED**: the 5 fail / 15 pass table above |

H3 and H5 are the interesting ones: the review named one scenario each for the
two trap shapes, and the first mutation pass showed my first three tests proved
neither. That is the §9 non-vacuity check doing its job.

#### Drift from the Implementation (this round)

11. **`liveGeneration` was given the reviewer's fix *plus* a bound.** The
    Implementation said only that a drop retries "with a factory". A bare
    `channelFactory && entry` guard is not sufficient for the invariant "it
    rejects promptly", because a redial that keeps failing never settles. The
    bound is a new option-independent constant, not a new knob.
12. **New exported error `UploadLinkLostError`** (in `upload-window.ts`) and
    `UPLOAD_RECONNECT_MS` (in `constants.ts`). A rejection needs a class a caller
    can branch on without matching text; the file list in `Files` did not name a
    new public error, but `AttachmentsUnsupportedError` set the precedent, and
    keeping it in the pure module matches the §7 split.
13. **`breaker` / `manualClock` / `fakeUploadDaemon` helpers in the test file.**
    Needed because Bun's timeout cannot fire under a spin (measured above) and
    because the reconnect bound has to be driven by an injected clock. All three
    are local to `upload.test.ts` and use only existing fakes `RpcPeer` /
    `createChannelPair`.
14. **Two of the five new tests exist only because a mutation stayed green**
    (H3 abort-during-wait, H5 factory-without-entry). Reported rather than
    silently dropped, as with M19/M20 in round 1.

**Not covered (stated, not faked):** the `30_000` value itself is not asserted
end to end (the test injects a clock and asserts "settled on its deadline, not
on an abort", so a typo in the constant would pass while a missing deadline
would not); and a reconnect that succeeds *after* the deadline has passed is not
tested — the code path closes it, because `left <= 0` throws before dialling.

**Gate (fix round 1).** `bunx tsc --noEmit` clean; `bun run lint` clean (927
files, 0 errors, 0 warnings — the §6 baseline; one `noUnnecessaryContinue` and
two formatting issues from my edits fixed with `biome check --write`); `bun test`
— **7232 pass, 3 skip (the opt-in k8s/docker/slow ones), 0 fail**, 521 files
(7235 total, +9 from round 1's 7226). No `protocol.json`, `TODO.md`, CHANGELOG or
`PROTOCOL_VERSION` change; no commit.

### Round 2

**Verdict: PASS.** Scope: `git diff e62515c..HEAD` (91391a9), round-1
findings only, plus regressions the fix introduced.

- **Finding 1 (HIGH, spin): fixed.** The round-1 repro `review-spin.ts`, re-run
  on 91391a9, now prints `upload rejected: UploadLinkLostError … ; puts
  sent=3` after 304 ms (before the fix it starved the event loop).
  `reconnectable = factory && entry` cuts both spin shapes, and the bounded
  `liveGeneration` (deadline + abort listener) keeps the reconnectable path
  from waiting forever.
- **Finding 2 (MEDIUM, vacuous W=2): fixed.** The literal `2` and `toBe(2)` are
  now measured on the wire.

**Mutations (this review; each reverted by its exact inverse edit, `git status
--porcelain` empty afterwards):**

| # | Mutation | Result |
|---|---|---|
| MA | `!reconnectable` guard disabled (old unconditional retry) | RED ×3: no-factory drop, no-factory no-session, factory no-session. The breaker ended each one, so the runner did not hang |
| MB | reconnect deadline × 1e6 (effectively none) | RED: "a factory that cannot reconnect at all" (2.0 s backstop) |
| MC | `UPLOAD_WINDOW = 4` | RED: "never more than 2 puts in flight" (green in round 1), plus T5 reconnect |
| MD | abort listener in `liveGeneration` removed | RED: "an abort while the link is down" |

**Gate (this review):** `bun test packages/client packages/protocol` + both
attachment daemon files: **878 pass, 0 fail** (90 files). The upload files
alone: 32 pass / 0 fail. I could not run `bun run lint` or the full suite
here (the run needed an approval I didn't have), so I rely on the fix round's
numbers (lint clean; 7232 pass / 3 opt-in skips).

**Regression check, no HIGH/MEDIUM found.** The success path with a working
reconnect is pinned ("with a reconnect that works, a drop is resumed"). The
deadline resets on every answered probe, so a long healthy upload is never cut
by the 30 s bound. Non-drop errors still rethrow unchanged
(`gen === this.gen && this.up`). One nit, not blocking: when
`liveGeneration` gives up through its timer or an abort, the inner `whenLive`
waiter stays registered until the link comes back or stops. Its later settle
is handled, so this is a small bounded leak per abandoned upload, not a bug.

Reviewer: claude-opus-5-5, fresh context, different family from the executor
(DeepSeek).

*— claude-opus-5-5, 2026-11-12*
