# feat/attachments-durable — image bytes survive restart, resume, archive and re-attach

> **Status:** implementation APPROVED (owner answers 2026-11-13: all (a))
> **Branch:** `feat/attachments-durable` (off `main` @ e9e7036: core, upload, tui-detect, prompt, tui merged)
> **Type:** feat · **Size:** M · **Blast:** load-bearing (persistence §7: the `serve` store gains files beside `<uid>.jsonl`, the laptop store gains files beside its logs; the laptop-held pod source widens from "this process" to "this laptop's disk"; §7 "a pod is not trusted") · **Suited:** strong model executes + **mandatory fresh-context Review** red-teaming the pod scope (D5) and the archive/delete/fork lifecycle (D2)

Umbrella: `docs/feat/attachments.md` §Split row 4. Binding owner answers:
`attachments-core.md` §Owner answers (2026-11-12); `attachments-upload.md`
§Owner answers (Q1 caps, **Q2 no bytes in a `--model-proxy` pod**, Q3);
`attachments-prompt.md` §Orchestrator decisions (3: laptop scope per client).

## Context

*— claude-opus-5-5, 2026-11-13*

After 3b the owner goal works **inside one process lifetime**: every byte store
is memory only.

| Holder | Today | Lost when | Evidence |
|---|---|---|---|
| daemon `HostedSession.uploads` (worker, `serve`, non-proxy pod) | `AttachmentStore`, a `Map` in memory | `serve` restart; any `--resume` (worker restarts empty); archive → reopen | `daemon/src/attachment-store.ts:1-22,109`; built fresh for new AND restored sessions at `session-host.ts:1016` (`restore` → `build`, `:859-873`); dropped at `hosted-session.ts:2981` |
| laptop `RemoteClient.images` (`--model-proxy` pods) | `LaptopImages`, a `Map` in memory | laptop TUI exits; `attach` again; a 2nd TUI on the same laptop is the model link | `client/src/laptop-images.ts:33-34`; `remote-client.ts:772,1699,1721-1723` |

The refs themselves ARE durable (core: critical `media_message` in both logs),
so after any of those events the history still names the image and every model
round silently re-sends it as `[image unavailable — L]` (core D6 placeholder).
The earlier docs deferred exactly this here: core FM "Resume" (`attachments-core.md:375`),
upload D3/D7 (`attachments-upload.md:256,326-328`), prompt FMs (`attachments-prompt.md:353,360-361`),
tui FM (`attachments-tui.md:326`).

**Repro** (`.tentacle/tmp/attachments-durable/resume-bytes.ts`, run 2026-11-13 on
`feat/attachments-durable` = `main` @ e9e7036): a real `SessionHost` (store
policy) + `Connection` + raw `RpcPeer`; `session/open{create, messages}` seeded
with `[{user, "what is this?", attachments:[ref]}, {assistant}]` — exactly what
`--resume` sends (`local-runtime.ts:854-860` → `remote-session.ts:389`).

```
1 holds after open (resume seed): false
2 turn after resume names the ref: true
3 turn after resume, source.read(ref): null
4 probe on resumed session: {"have":0,"complete":false}
5 re-upload ack: {"have":5,"complete":true} holds: true
6 next turn, source.read(ref) equals bytes: true
```

Lines 1–3 are the bug (ref in history, no bytes → placeholder every round);
4–6 prove the load-bearing assumption below.

<details><summary>resume-bytes.ts (full)</summary>

```ts
// attachments-durable load-bearing repro: a session (re)opened from a history
// that holds an image ref has NO bytes on the daemon (today's gap), and the
// EXISTING attachment/put on that same session restores them for the next turn.
import { createHash } from "node:crypto";
import { Agent } from "@tentacle/agent";
import { type ChatRequest, type ModelProvider, PermissionBroker } from "@tentacle/core";
import { Method, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection, SessionHost } from "../../../packages/daemon/src/index.ts";

const env = {
  id: "e",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};
const bytes = new TextEncoder().encode("a png");
const id = createHash("sha256").update(bytes).digest("hex");
const ref = { id, mimeType: "image/png", size: bytes.length, name: "a.png" };
const reqs: ChatRequest[] = [];
const model = {
  id: "rec",
  async *stream(r: ChatRequest) {
    reqs.push(r);
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  },
} as unknown as ModelProvider;
const host = new SessionHost({
  defaultCwd: "/x",
  images: { source: "store", maxBytes: 4 << 20 },
  createAgent: (_c, ctx) => ({
    agent: new Agent({
      model,
      tools: new ToolRegistry(),
      env: env as never,
      ...(ctx.attachments ? { attachments: ctx.attachments } : {}),
    }),
    permissions: new PermissionBroker(),
    settingsReport: { carried: {}, overridden: {} },
  }),
});
const [d, c] = createChannelPair();
new Connection(d, host);
const peer = new RpcPeer(c, {
  onNotification: () => {},
  onRequest: async (m) => (m === Method.HooksTrust ? { trusted: false } : null),
});
await peer.request(Method.Initialize, {
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { streaming: true },
});
// The resume seed: the laptop's history, an image message + its reply.
await peer.request(Method.Open, {
  sessionId: "S",
  create: true,
  messages: [
    { role: "user", content: "what is this?", attachments: [ref] },
    { role: "assistant", content: "a cat" },
  ],
});
const hosted = host.get("S");
if (!hosted) throw new Error("no session");
const turn = async (t: string) => {
  await peer.request(Method.Prompt, {
    sessionId: "S",
    turnId: t,
    content: [{ type: "text", text: "again" }],
  });
  await new Promise((r) => setTimeout(r, 30));
};
console.log("1 holds after open (resume seed):", hosted.uploads.holds(ref));
await turn("t1");
const first = reqs.at(-1);
console.log("2 turn after resume names the ref:", JSON.stringify(first?.messages[0]?.attachments) === JSON.stringify([ref]));
console.log("3 turn after resume, source.read(ref):", await first?.attachments?.read(ref));
const probe = await peer.request(Method.AttachmentPut, { sessionId: "S", id, size: bytes.length, offset: 0, data: "" });
console.log("4 probe on resumed session:", JSON.stringify(probe));
const ack = await peer.request(Method.AttachmentPut, {
  sessionId: "S",
  id,
  size: bytes.length,
  offset: 0,
  data: Buffer.from(bytes).toString("base64"),
});
console.log("5 re-upload ack:", JSON.stringify(ack), "holds:", hosted.uploads.holds(ref));
await turn("t2");
const got = await reqs.at(-1)?.attachments?.read(ref);
console.log("6 next turn, source.read(ref) equals bytes:", got ? Buffer.from(got).equals(Buffer.from(bytes)) : got);
process.exit(0);
```

</details>

**Constraints.** §7 persistence: the main thread owns the laptop store, `serve`
also persists, pod daemons and the worker NEVER persist; nothing is purged
automatically; `connect` keeps no laptop copy. §7 trust: a pod chooses refs,
never bytes or paths; a laptop read for a pod is gated by a laptop-published
allowlist. Upload Owner Q2: no bytes into a `--model-proxy` pod. Pre-public:
breaking is allowed, but nothing here needs it (no wire change, no log change).

## Implementation

*— claude-opus-5-5, 2026-11-13 (draft, awaiting owner approval — NOT approved)*

### Load-bearing assumption

**Durability needs NO wire change and NO log change: bytes restored into a
session's store AFTER it is (re)opened — by the existing `attachment/put` on the
client side, or by a disk-backed store on the daemon side — are resolved by the
next model round for refs that were already in the restored history.** The
provider re-reads the source on every round (`resolveImages` per request, core
D6) and never caches "absent".

Proved by the repro (Context): on a session created from a seeded history, the
probe returns `have: 0` (line 4), one `attachment/put` completes it (line 5),
and the next turn's `source.read(ref)` yields the exact bytes (line 6) for the
ref the seed carried — no new method, no re-prompt, no log rewrite. Code
backing it: the agent passes the SAME source object on every request
(`AgentConfig.attachments`, set once from `ctx.attachments` —
`session-host.ts:1016` builds the store BEFORE the agent); the store's `read` is
a live lookup (`attachment-store.ts:278-281`). If this were false (e.g. the
source captured at open), every design below would need a re-prompt or a
history rewrite instead.

### Preconditions

| # | Fact | Source |
|---|---|---|
| P1 | ONE construction site for every session's store, new or restored: `build()` (restore calls it) | `session-host.ts:859-873,1016` |
| P2 | The store's single end is `HostedSession.close` → `uploads.dispose()`; it runs for close, archive, reaper, detached cap AND delete — so `dispose` alone cannot tell "keep" from "remove" | `hosted-session.ts:2978-2981`; upload P4 |
| P3 | `serve` delete = `persister.remove(id)` (tombstone first, then `store.remove`) → `LogSessionStore.removeLocked` deletes state, log, asides under the session's lock, in its queue | `session-host.ts:614,620`; `session-persister.ts:557-575`; `session-log-store.ts:370-376,892-910` |
| P4 | `serve` archive keeps the files (`persister.archive` writes state + log), nothing removed; reopen reloads via `restore` | `session-host.ts:795-806,859` |
| P5 | `/clear` fork goes through `LogSessionStore.fork(sourceId, unit)` on BOTH sides (laptop `SessionSaver.keepFork`, serve `persister.fork`) | `session-log-store.ts:413-415`; `session-saver.ts:98`; `session-host.ts:815-823` |
| P6 | The laptop store dir is `<configDir>/sessions/<projectKey(cwd)>/`; the SAME `LogSessionStore` class backs `serve`'s `daemonStoreDir` | `tui-sessions.ts:71-76`; `main.ts:987`; `serve.ts:157-166` |
| P7 | Both stores read only `<uid>.jsonl` / `<uid>.state.json` / asides / temps / locks by name pattern; any other entry in the dir is ignored by every scan (`ids`, `daemonFiles`, `sweep`) — an older build skips a `<uid>.attachments/` dir | `session-log-store.ts:1014-1035,1153-1167,1218-1229` |
| P8 | The laptop runtimes that persist (worker, pod `run`/`attach`) all go through `createLocalRuntime` → `persistingController`, whose `attachImage` is the single laptop-side image seam; `connect` does NOT use it (its own target, no laptop copy) | `local-runtime.ts:325,511-516,864`; `connect.ts:268` |
| P9 | `RemoteClient.attachImage` decides upload vs laptop-held from the daemon capability and is idempotent by id (upload probe dedupes; `LaptopImages.add` no-ops a held id) | `remote-client.ts:1661-1702`; `attachment-store.ts:144-147`; `laptop-images.ts:58-61` |
| P10 | The pod's three serving casts read ONLY `this.images` via `laptopRequest` | `remote-client.ts:1721-1723,3176,3195,3407` |
| P11 | The provider verifies sha256 + size on every byte string it inlines → a corrupt or truncated file is a visible placeholder, never a wrong image | core D6, `providers/src/images.ts` (`resolveImages`) |
| P12 | Inbound requests are dispatched concurrently (`void this.handleRequest`); a handler may await AFTER its synchronous prefix without serializing the peer | `transport/src/peer.ts:322,332` |
| P13 | `AttachmentRefusedReason` is a TS-only union → a new reason is additive on the wire | `protocol/src/attachment-upload.ts:58-72` |
| P14 | Resume = `client.newSession(record.messages, uid, …)` (lazy seeded open); attach = `newSession(…, {attach})` with the laptop's record when it has one | `local-runtime.ts:850-863,912-922,974` |
| P15 | Only the last `MAX_INLINE_IMAGES = 5` distinct user-message image ids are ever sent per request (`selectInlineIds`) | `providers/src/images.ts:26,88-95` |

### Design

**Rule (unchanged from prompt D-rule): whoever runs the provider holds the
bytes — now on disk too, where that holder already persists.** `serve` persists
its own (D1–D3). The laptop persists the images IT attached, for the runtimes
whose logs it already keeps (D4), and restores them through the one existing
entry point, `attachImage` (D5) — or, for a `--model-proxy` pod, serves them
from its own disk under a laptop-published scope (D6). Worker and pod daemons
still persist nothing (§7). `connect` keeps no laptop copy (§7; Owner Q3).

**D1 — on-disk layout (shared by laptop and `serve`; Owner Q1).** Beside a
session's log: `<dir>/<uid>.attachments/<sha256>` — the raw bytes, file name =
the verified id (never client input), written `tmp + fsync + rename` (temp
`.<sha256>.tmp-<pid>-<hex>` inside that dir, swept like the store's temps).
Self-verifying (P11), so no header and no schema version; an older build
ignores the dir (P7). No change to `<uid>.jsonl`, the sidecar, or any log entry
type (Owner Q2). New pure-ish module `daemon/src/session-blobs.ts`:

```ts
export const BLOB_DIR_SUFFIX = ".attachments";
export class SessionBlobs {                       // one per LogSessionStore dir
  constructor(dir: string);
  /** Ids + sizes on disk for `uid` (sync readdir+stat; names failing ATTACHMENT_ID_RE skipped). */
  index(uid: string): Map<string, number>;
  read(uid: string, id: string): Promise<Uint8Array | null>;   // ENOENT → null
  write(uid: string, id: string, bytes: Uint8Array): Promise<void>;  // idempotent: present at same size → no-op
  link(fromUid: string, toUid: string, ids: Iterable<string>): Promise<void>;  // hardlink, copy on EXDEV/EPERM; missing → skipped
  removeAll(uid: string): Promise<void>;          // rm -r <uid>.attachments
}
```

`LogSessionStore` owns one and routes its mutations through the session's
existing per-id queue + lock (P3): new ops `putBlob(uid, id, bytes)`; `remove`
(`removeLocked`) also `removeAll(uid)` — AFTER the log (a cut-short remove
leaves blobs with no log, swept by D3, never a log with missing blobs); `fork`
also `link(source, newId, idsOf(unit))` AFTER the new log lands (`idsOf` = the
refs of the unit's `media_message`/`media_replace` entries). Reads
(`readBlob`, `blobIndex`) go straight to `SessionBlobs` (content-addressed
files are immutable once renamed in).

**D2 — `serve`: a disk-backed `AttachmentStore` (same API).**
`AttachmentStoreOptions.disk?: { index: Map<id,size>; write(id, bytes): Promise<void>; read(id): Promise<Uint8Array|null> }`
(absent = today's memory store: worker, pod daemons, every existing test).
- Construction: `SessionHost.build` (P1) passes
  `disk: this.opts.persister?.blobs(id)` — `SessionPersister.blobs(id)` binds
  `store.blobIndex(id)` / `putBlob` / `readBlob`; `undefined` when blocked or
  the id is unsafe (then memory, as today). So new AND restored sessions get it
  from the one site.
- Entries gain `{ kind: "stored"; size }` (bytes on disk, nothing in memory) and
  `Complete` gains `landing: Promise<void> | null`. Seeded from `disk.index` at
  construction (every on-disk blob is `stored`).
- `put` stays SYNCHRONOUS up to and including the append (the load-bearing rule
  of `attachment-store.ts:11-16`, P12). Rule 2 (dedupe) also matches `stored`.
  At rule 9's verified completion with `disk`: entry = `Complete{bytes, landing
  = disk.write(id, bytes)}`; `put` returns `landing.then(() => ack)` — the ack
  is sent only once the file is durable. When it lands: entry → `stored{size}`,
  the memory reservation (`UploadBudget`) is released, the per-session disk
  count keeps `size`. If it fails: entry dropped, both reservations released,
  the ack REJECTS `AttachmentRefused{reason:"store_failed"}` (P13, additive) with
  the OS message; the client's `upload()` surfaces it as today's refusals (3b:
  chip keeps its bytes, Enter retries).
- `holds(ref)` = `stored` at `ref.size`, or `Complete` with `landing === null`
  (memory store). A blob still landing is NOT held → a racing prompt from
  another client gets `not_uploaded` (never a ref whose bytes could vanish in a
  crash). A concurrent duplicate final chunk / probe on a landing entry returns
  the same `landing.then(ack)`.
- `read(ref)`: `stored` → `disk.read(id)` (size re-checked; provider re-verifies
  sha, P11); landing → the memory bytes.
- Caps (Owner Q4): `SESSION_UPLOAD_BYTES` (100 MiB) now counts `stored` +
  partials + landing; the daemon `UploadBudget` (256 MiB) counts only what is
  in MEMORY (partials + landing). So a `serve` session holds ≤ 100 MiB on disk;
  disk across sessions is unbounded, like logs (§7 "nothing purged
  automatically").
- `dispose()` (P2) releases memory only — never touches disk. Archive therefore
  KEEPS the blobs (P4); delete removes them through `persister.remove` →
  `store.remove` (D1). No new lifecycle hook: the existing two paths already
  split keep vs remove.

**D3 — `serve` start-up sweep.** In `startDaemon`, beside the orphan-state
sweep (`serve.ts:283-287`): every `<uid>.attachments` dir whose uid has no log
(`daemonFiles().logs`) AND is tombstoned → `removeAll`. A logless,
non-tombstoned dir (a session that uploaded but crashed before its first log
write) is removed too, at the same start-up pass (Owner Q5): no session is
live before the host serves, and a session that never wrote a log has no
history that could name the blob. The laptop store does NOT sweep
(several processes share it; Owner Q5).

**D4 — laptop: keep what this laptop attached (worker + pods, P8).**
`persistingController.attachImage` (`local-runtime.ts:511-516`), today a pure
forward, becomes:
1. `ref = await inner.attachImage(bytes, meta, options)` (unchanged decision:
   upload or laptop-held, P9);
2. `await saver.putBlob(uid, ref.id, bytes)` — through `SessionSaver` →
   `LogSessionStore.putBlob` (queue + lock, D1); bounded by
   `FLUSH_ON_EXIT_TIMEOUT_MS`; skipped once `saver.removed` has the uid or
   `saving` is false (a hand-over: whoever saves the log saves blobs);
3. return `ref`.
The write lands BEFORE the ref is returned, so before it can enter any history
(and hence before any log entry naming it). A failed/timed-out write does not
fail the attach (the image works in this run): ONE notice per session through
`deps.notify` (Owner Q6 wording): `⚠ image <label> could not be saved on this
laptop — after a restart the model will see it as unavailable (<error>)`.
Per-session laptop cap: the same 100 MiB as `LAPTOP_IMAGE_BYTES`, checked by
`blobIndex` sum before writing; over → the same notice with "laptop image store
for this session is full". Never evicts (core/prompt rule).

**D5 — laptop: restore into the daemon after an open (upload mode).** One pure
function `client/src/restore-images.ts`:

```ts
/** Ids to restore after an open: the ones a provider would inline (P15), newest first. */
export function imagesToRestore(history: readonly ChatMessage[], keep = MAX_INLINE_IMAGES): AttachmentRef[];
```

(refs of user messages in `selectInlineIds` order, deduped by id, carrying the
newest ref's `mimeType`/`name`). In `persistingController`, a memoized
`restoring: Promise<RestoreReport> | null` started by the controller's FIRST
`send`/`sendNow`/`attachImage` and awaited before it goes on:
- history = the seed (`record.messages`, resume) or the record the controller
  was built with (attach, P14); empty or no refs → nothing.
- per ref: `bytes = await saver.readBlob(uid, ref.id)`; `null` → `missing`;
  else `await inner.attachImage(bytes, {mimeType, name})` — the ONE existing
  entry point: it opens the session first (memoized), probes (zero chunks when
  the daemon already holds it, e.g. a pod daemon that outlived the laptop),
  uploads otherwise, or adds to `LaptopImages` in laptop mode; its errors →
  `failed`.
- `RestoreReport{restored, missing, failed}` → at most ONE notice (Owner Q6):
  `⚠ <n> earlier image(s) of this session are not on this laptop — the model
  sees them as unavailable` / `… could not be re-sent: <first error>`. The send
  proceeds either way (placeholders, never a poisoned session — core).
- Only `upload`/`laptop` modes do anything; `off` → skipped silently (the
  existing `images_off` notice path covers it).
This is what fixes the repro's lines 1–3 for worker `--resume` and pod
`run --resume`/`attach` after a laptop restart.

**D6 — laptop: a scoped disk fallback for `--model-proxy` pods (§7).** D5
already refills `LaptopImages` for the TUI that sends. It does NOT cover a pod
whose model link is a laptop process that never sends (a 2nd TUI on the same
laptop, multi-attach), nor a model call that runs before the first send (a pod
turn resumed by the daemon, e.g. a suspended turn re-asked on attach). So `LaptopImages` gains an optional fallback:

```ts
constructor(opts: { maxBytes?: number; fallback?: (ref: AttachmentRef) => Promise<Uint8Array | null> })
allowSession(uid: string): void   // scope: sessions THIS client built (persistingController calls it)
```

`read(ref)`: memory hit → bytes; else `fallback(ref)` which reads
`saver.readBlob(uid, ref.id)` for each uid in the allowed set (≤ a handful),
first hit wins; the provider re-verifies (P11). The scope is the laptop's OWN
publication: `<uid>.attachments/` is written ONLY by D4 (bytes this laptop's
user attached to that uid) and by `fork` linking from such a dir — never from
pod data (the laptop's log of a pod session IS pod-supplied, so the scope must
not come from refs in that log; §7 "an allowlist of what the laptop itself
published"). Per client, not per session: `model/stream*` has no `sessionId`
(prompt Orchestrator decision 3; same exposure analysis — every allowed uid is
a session of the pod this client is serving). Never opens a path derived from
pod input: `uid` from the laptop's own set, `id` checked against
`ATTACHMENT_ID_RE` before any `join`.

**D7 — what does NOT change.** No `PROTOCOL_VERSION` bump, no new method, no
new update kind, no log entry type, no sidecar field (Owner Q2). `connect`
(Owner Q3). Compaction / `context_reset` still drop images from the new
history (core Owner Q6); their blobs stay with the session until delete
(Owner Q4). Sub-agents unchanged.

### Files (dependency order)

1. `packages/protocol/src/attachment-upload.ts` — `AttachmentRefusedReason += "store_failed"` (TS only, P13). No schema export change.
2. `packages/daemon/src/session-blobs.ts` (new) · `session-log-store.ts` (`putBlob`/`readBlob`/`blobIndex`; `removeLocked` + `fork` op extended; blob temps in `sweep`) · `index.ts` (export)
3. `packages/daemon/src/attachment-store.ts` (`disk` option, `stored`/landing, `holds`/`read`/caps, `store_failed`) · `session-persister.ts` (`blobs(id)`) · `session-host.ts` (`build` passes `disk`) · `connection.ts` (`put` case returns the store's value — may now be a promise; comment kept)
4. `packages/client/src/restore-images.ts` (new, pure) · `laptop-images.ts` (`fallback`, `allowSession`) · `remote-client.ts` (construct `LaptopImages` with a fallback from `RemoteClientOptions.imageFallback?`) · `index.ts`
5. `packages/cli/src/session-saver.ts` (`putBlob`, `readBlob`, respects `removed`) · `local-runtime.ts` (`persistingController.attachImage` + restore memo + `allowSession`; `imageFallback` wired to the saver) · `serve.ts` (D3 sweep) · `package.json` (devDependency `ink-testing-library@4.0.0`, Owner Q8)
6. `CHANGELOG.md` (`Added`: images survive restart/resume) · `TODO.md` (row 4 → this doc) · `docs/feat/attachments.md` §Split row 4 link

No `tui` source change: notices already render through `deps.notify` /
`NoticeHub` (`local-runtime.ts:717`), and the `[image: name]` rows come from 3b.

### Failure modes

| Mode | What happens | Converges how | Pinned by |
|---|---|---|---|
| `serve` restart | store seeded from `<uid>.attachments/` (D2) | refs resolve; no client action | T3, T4 |
| `serve` archive → reopen | `dispose` frees memory only; reopen `restore` → `build` seeds from disk | refs resolve | T4 |
| `serve` delete | tombstone → `removeLocked` removes state, log, asides, THEN blobs | dir gone; a crash between → logless dir swept at next start (D3) | T2, T5 |
| `serve` `/clear` fork | new archived session; `fork` links its refs' blobs after its log lands | fork reopen resolves its images; deleting the source keeps the fork's links | T2, T4 |
| Crash after the blob's ack, before any log names it | blob on disk, no log ref | harmless; swept at start if the session never wrote a log | T5 |
| Crash before the blob lands | ack never sent → client sees a drop → `upload()` reconnect re-probes (`have` restarts) | re-uploaded | T3 |
| Disk write fails (full, EACCES) | entry dropped, reservations released, ack rejects `store_failed` | loud at the chip; retry; no ref can name unlanded bytes | T3 |
| Prompt racing a landing blob (2nd client) | `holds` false → `not_uploaded` | that client re-uploads (dedupes on the landed blob) | T3 |
| Corrupt / truncated blob file | `read` size check, provider sha check | `[image unavailable — L]`, never a wrong image | T3 |
| `serve` session over 100 MiB on disk | `store_full` before a byte | loud; delete the session | T3 |
| Older build reads the store dir | ignores `<uid>.attachments/` (P7); refuses image sessions anyway (core critical types) | — | T2 (scan ignores dir) |
| Older build deletes a session | leaves `<uid>.attachments/` | swept by the next new-build start (D3: logless) | T5 |
| Laptop write fails / cap full (D4) | attach still works this run | one notice; after restart placeholder | T6, T8 |
| Laptop `--resume` of a pre-feature session | no blob → `missing` | one notice; placeholders | T7, T9 |
| Re-attach while the daemon still holds the bytes (a non-proxy pod daemon that outlived the laptop TUI) | probe → complete, zero chunks | — | T7 |
| Restore fails mid-way (link drop) | `attachImage` reconnect idiom; persistent failure → `failed` | one notice; send proceeds | T7 |
| Session removed on the laptop (`saver.remove`) while a blob write is queued | queue order: write then remove, or `removed` skips it | no orphan dir | T6 |
| Hostile pod names an id held by ANOTHER laptop session not in scope | fallback reads only allowed uids | `null` → placeholder | T10 |
| Hostile pod injects a `media_message` with a foreign id into the laptop's log | scope is the blob dir written by D4, not the log | `null` unless this laptop attached it to an allowed uid | T10 |
| Hostile pod names `../x` / non-hex id | ref schema refuses on parse; `SessionBlobs` re-checks `ATTACHMENT_ID_RE` before `join` | no path opened | T1, T10 |
| Two TUIs on one laptop, model link never sends | D6 fallback reads disk | image resolves | T10 |
| `--model-proxy`: restore must not ship bytes into the pod | `attachImage` in laptop mode sends zero frames (prompt T8/T9) | — | T7 (zero `attachment/put`) |
| Fork on the laptop (`/clear`) | same `fork` op links blobs | resume of the fork restores its images | T2, T9 |
| Hardlink impossible (EXDEV, FS without links) | copy | — | T1 |

### Tests

Property: **after any restart, resume, archive→reopen, fork or re-attach, a ref
in the restored history reaches the provider with a source yielding exactly its
verified bytes — from `serve`'s disk, from a laptop re-upload, or from the
laptop's own disk under its own scope — or, when the bytes are truly gone, ONE
visible notice and a placeholder; a delete leaves no bytes; a pod can read
nothing the laptop did not attach to a session this client opened.** "The file
exists on disk" alone is too weak: every test asserts at the provider's
`ChatRequest.attachments.read(ref)` (or an injected-`fetch` body), as the repro
does.

Write each test first, show it RED on the branch base, then implement.

| # | File | Asserts | Red because |
|---|---|---|---|
| T1 | `daemon/test/session-blobs.test.ts` (new) | write → index/read round-trip; write twice no-op; bad id refused before any fs call (spy); `link` hardlinks (same inode) and falls back to copy when `link` throws `EXDEV` (injected); missing source id skipped; temp left by a dead pid swept | module absent |
| T2 | `daemon/test/session-log-store.test.ts` (extend) | `remove` deletes `<uid>.attachments/` after the log (op order spy) and under the lock; `fork` links exactly the unit's ref ids, after the new log; `ids()`/`daemonFiles()` ignore the dir (a store with only a blob dir lists nothing) | no blob ops |
| T3 | `daemon/test/attachment-store.test.ts` (extend; fake `disk`) | completion ack resolves only after `disk.write` resolves (deferred promise); `holds` false while landing, true after; landed entry released from `UploadBudget.used`, still counted in the session cap; failing write → rejects `store_failed`, budget back to prior; seeded `index` → `holds` + `read` from `disk.read`; disk bytes of wrong size → `null`; duplicate final chunk during landing returns the same ack; `put` before landing stays sync (a 2nd chunk in the same tick is ordered); memory mode (no `disk`) byte-identical behaviour (existing suite green) | no `disk` option |
| T4 | `daemon/test/attachment-durable.test.ts` (new; real `SessionHost` + `SessionPersister` + `LogSessionStore` on a temp dir + `Connection`; copy `attachment-prompt.test.ts` + the serve persister tests) | upload + image prompt → stop host → new host on the same dir reloads → next turn's `read(ref)` = bytes (the serve-restart repro); archive → `session/open{reopen}` → same; `/clear` fork → reopen the fork → same; `session/delete` → dir gone | store memory only |
| T5 | `cli/test/serve-persistence.test.ts` (extend) | start-up sweep: tombstoned logless dir removed, logless non-tombstoned removed, dir WITH a log kept | no sweep |
| T6 | `cli/test/session-saver.test.ts` (extend) | `putBlob` lands; skipped after `remove(uid)`; queued write then remove → no dir | absent |
| T7 | `cli/test/local-runtime.test.ts` (extend; real `RemoteClient` ↔ in-memory `Connection` + store-policy host, frame spy) | `attachImage` writes the blob BEFORE resolving (deferred saver); resume of a record with an image ref + the blob on the laptop: first `send` re-uploads (one `attachment/put` sequence) BEFORE `session/prompt`, and the provider's `read(ref)` = bytes; only `imagesToRestore` ids are uploaded (6 images → 5); blob missing → one notice, prompt still sent; daemon already holding → probe only, zero data chunks; laptop mode (`localImages`, client-policy fake pod) → zero `attachment/put` frames, `LaptopImages.holds` true | no restore |
| T8 | `cli/test/local-runtime.test.ts` | failing `putBlob` → attach resolves with the ref, exactly ONE notice per session across two failures | forward only |
| T9 | `cli/test/attach-durable-app.test.tsx` (new). REAL `App` (from `@tentacle/tui`, a cli dependency: `cli/package.json:26`) mounted with ink-testing-library exactly like `tui/test/attach-app.test.tsx:120-135`, but `createSession` = the REAL `createLocalRuntime(…).createSession` over an in-memory channel to a store-policy `SessionHost`, a `SessionSaver` on a temp dir holding a record with an image message + its blob, and `notify` → the App's `NoticeHub`. It lives in `cli` because `tui` cannot import `cli` (dependency direction); cli has no `ink-testing-library` today (no `cli/node_modules` entry) → add it as a cli devDependency at the tui's pinned 4.0.0 (Owner Q8) | frames: resumed session shows the `[image: a.png]` row; typing `again⏎` → the recorded provider request read(ref) = bytes, and the frame shows no warning; same with the blob deleted → the notice text `earlier image(s) of this session are not on this laptop` appears in a frame, once | no restore, no notice |
| T10 | `client/test/laptop-images.test.ts` + `model-stream-attachments.test.ts` (extend) | fallback reads only `allowSession` uids (spy: a blob under a non-allowed uid on disk → `null`, fallback for that uid never called); memory hit never calls fallback; raw-frame pod naming a foreign id or one injected via its `session/log` → `null`; non-hex id → no fs call; two `RemoteClient`s on one laptop dir: the non-attaching one serves `model/stream` with the bytes | no fallback |
| T11 | `client/test/restore-images.test.ts` (new, pure) | newest-first, dedupe, last 5, non-user refs ignored, empty history → `[]` | absent |

Mutations (each must turn the named tests red; revert after):
- `put` returns the ack without awaiting `landing` → T3, T4
- `holds` true while landing → T3
- `dispose()` also removes the disk dir → T4 (archive → reopen)
- `removeLocked` skips `removeAll` → T2, T4 (delete)
- `fork` op does not link → T2, T4 (fork)
- `build` omits `disk` for restored sessions only → T4 (restart)
- `persistingController.attachImage` writes the blob after returning → T7
- restore runs after `inner.send` instead of before → T7
- `imagesToRestore` returns all ids → T7 (6 → 5), T11
- `LaptopImages` fallback ignores the allowed set (scans every dir) → T10
- scope taken from the refs in the laptop's log instead of the blob dirs → T10 (injected ref)
- notice sent per failure, not once → T8, T9
- sweep removes dirs that have a log → T5

Gate before done: `bun run check` (typecheck → lint → test), lint baseline clean
(AGENTS §4, §6). Narrow during work: the files above.

### Owner questions

Recommendation first in each. Nothing here is approved until answered.

1. **On-disk layout.** (a) **Per session, beside its log: `<dir>/<uid>.attachments/<sha256>`, raw bytes; `/clear` fork hardlinks (copy fallback); delete removes the dir with the log** — one lifecycle with the session, no reference counting, same code for laptop and `serve`. (b) One content-addressed pool per project dir (`<dir>/attachments/<sha256>`) with GC by scanning every log's refs — dedupes across sessions, but GC must parse every log (incl. archived) and races live writers. (c) Bytes inside the log (base64 entries) — bloats every log read/rewrite and the 256 KiB `session/log` pages.
2. **Log / critical entries.** (a) **No log change at all: no new entry type, no `critical` change, no header `schemaVersion` or `DAEMON_STATE_VERSION` bump** — refs are already critical (`media_message`), bytes are files an older build ignores (P7). (b) A non-critical `blob` entry naming each stored id (lets a reader know bytes exist without listing the dir) — more surface for no consumer today.
3. **`connect` → `serve`.** (a) **No laptop copy (AGENTS §7 as written): the `serve` disk store is the truth; a `serve` that lost a blob → placeholder.** (b) Also keep a laptop cache for `connect` and re-upload on open — contradicts "connect keeps no laptop copy" (an AGENTS §7 edit).
4. **Retention and caps.** (a) **Kept until the session is deleted — archive keeps, compaction/`context_reset` keep (the superseded refs may still be viewed), nothing purged automatically (§7). Per-session cap 100 MiB on disk on both sides (same number as today's memory cap); no daemon-wide or laptop-wide disk cap (logs have none). The 256 MiB daemon budget counts only bytes in memory.** (b) Also a global LRU disk cap (e.g. 1 GiB per store dir) evicting the oldest sessions' blobs — silent placeholders later, against the "never evict" rule of 2a/2b. (c) Drop a session's blobs when compaction removes their last ref — saves disk, loses them for `keepSuperseded` viewing and a future "re-attach after compaction".
5. **Orphan sweep.** (a) **`serve` removes, at start-up before serving, blob dirs whose uid has no log (tombstoned or never logged); the laptop never sweeps** (several processes share its dir; orphans there are a crash before a session's first save — rare, small). (b) Laptop sweeps too, under the session lock, dirs with no log older than 1 day. (c) No sweep anywhere.
6. **User-visible notices (wording, frequency).** (a) **At most one notice per session per event:** laptop save failed — `⚠ image <label> could not be saved on this laptop — after a restart the model will see it as unavailable (<error>)`; restore — `⚠ <n> earlier image(s) of this session are not on this laptop — the model sees them as unavailable` / `⚠ <n> earlier image(s) could not be re-sent: <first error>`. A successful restore is silent. (b) Also a success line (`↻ restored 3 images`). (c) Silent (placeholders only).
7. **Restore scope and timing (upload mode).** (a) **Only the ids a provider would send (last 5, `selectInlineIds`), started by the controller's first send/attach and awaited before it** — no cost for a session that is only viewed; the first prompt after a resume waits for ≤ 5 uploads (≤ 75 MiB worst case on a slow pod link, shown as the turn's wait). (b) Eagerly at open in the background (faster first prompt, uploads for sessions only viewed). (c) Every image of the session.
8. **Test placement for the App frame test (T9).** (a) **`cli/test/attach-durable-app.test.tsx` + `ink-testing-library@4.0.0` as a `cli` devDependency** — the only package that can host REAL `App` + REAL `createLocalRuntime`. (b) Keep frame tests in `tui` with a fake controller and pin the restore logic only in `cli` unit tests (weaker: the frame would not prove the real controller's notice reaches the App).
9. **Laptop pod scope (D6).** (a) **Per `RemoteClient`: the uids it built, reading only `<uid>.attachments/` written by this laptop's attaches (and fork links)** — matches prompt Orchestrator decision 3. (b) Per session: needs a `sessionId` on `model/stream*` (a wire field) for no reduction in exposure (all allowed uids are sessions of the same pod). (c) No disk fallback: a 2nd TUI as model link keeps showing placeholders.

## Execution

*(empty — Implementation not approved yet)*

## Review

*(empty)*

#### Owner answers (2026-11-13)

Q1–Q9 all (a), as recommended. Implementation APPROVED.
