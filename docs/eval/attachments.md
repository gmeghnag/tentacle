# eval/attachments — images and files from any client (sister of the v2 redesign)

> **Status:** implementation drafted (split; sub-task 1 planned) — awaiting owner approval (2026-10-19)
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

> **Owner decisions (2026-10-19):** the open questions below are resolved in
> the parent, `docs/eval/session-reattach.md` §"Owner decisions after the
> children's Implementation drafts" (A–G, D1–D10). Where a question or
> design point here disagrees, the parent decision wins.


*— claude-opus-5-5, 2026-10-19 (draft, awaiting owner approval)*

### Open questions / contradictions

**State table, verified against the code (2026-10-19, `main` @ 4914e9b).** Every
row of the Context table holds; it is incomplete in four places that matter
for the plan:

| Row | Verdict | Evidence / correction |
|---|---|---|
| Wire: `image` (inline base64) and `resource` blocks | holds | `protocol/src/content.ts:13-18`, `:20-26` |
| Daemon drops non-text silently | holds | `daemon/src/mapping.ts:14-19`; repro line 1 below |
| History content is a `string` | holds | `core/src/model.ts:27-34` |
| Providers: no image support | holds | `openai-provider.ts:217-230` (`content` copied as a string), `anthropic-provider.ts:327-337` (plain string for user turns); repro line 5 |
| 8 MiB frame cap | **partly** — the cap exists only on the `serve` WebSocket (`ws-server.ts:40,185`); `peer.ts:261-267` checks it only when `maxFrameBytes` is set, and `startStdioDaemon` (`cli/src/serve.ts:93-97`) does not set it, so the pod path has **no** cap. The head-of-line argument for chunking stands either way (`rpc-flow-control.md`). |
| *(missing)* history has **two** wire mirrors | `protocol/src/session.ts:24-31` (`session/new` seed, `session/snapshot`) is `.strict()` → an unknown field is **rejected**; `protocol/src/model.ts:19-24` (`model/stream`, `model/streamChunked`) is **not** strict → an unknown field is **silently stripped** (repro lines 2-3). |
| *(missing)* the pod tunnel copies messages field by field | `daemon/src/proxy-model.ts:47-62` (`toWireRequest`) — a new `ChatMessage` field is dropped there (repro line 4). It is the **only** field-by-field `ChatMessage` mapper in `packages/*/src` (`rg toolCallId` → every other site passes objects through). |
| *(missing)* token counting is not on any live path | `DefaultContextManager` / `HeuristicTokenCounter` are referenced only inside `packages/core/src` (`rg -n "DefaultContextManager\|HeuristicTokenCounter\|needsCompaction" packages --glob '!**/test/**'`); compaction is manual (`agent/src/session.ts:91`). Counting images is correctness hygiene, not a load-bearing change. |
| *(missing)* `agentCapabilities` is `.strict()` and results are validated | `protocol/src/session.ts:44-49`; `transport/src/peer.ts:413` parses every result against its schema → adding `prompt.image` makes an **old** client reject a **new** daemon's `initialize`. It needs the version bump the v2 plan already budgets ("each breaking child bumps `PROTOCOL_VERSION`", parent §Children). |

**Repro (2026-10-19, bun 1.4.3).** `.tentacle/tmp/attachments-impl/boundaries.ts`
(gitignored; pasted in full). It feeds one image (as a wire block) and one
`ChatMessage` carrying an extra `attachments` field through every boundary the
multimodal history must cross. No network, no keys.

```ts
// boundaries.ts — where does an image (or an `attachments` field on a
// ChatMessage) get dropped TODAY? Each line is one boundary the multimodal
// history must cross. No network, no keys.
import { contentToText, ProxyModelProvider } from "@tentacle/daemon";
import { buildPayload } from "@tentacle/providers";
import { Method, RequestSchemas } from "@tentacle/protocol";

const ref = { id: "a".repeat(64), mimeType: "image/png", size: 1234 };
const userWithRef = { role: "user", content: "what is in this picture?", attachments: [ref] };

// 1. Daemon prompt path: an image block next to text.
const flat = contentToText([
  { type: "text", text: "what is in this picture?" },
  { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
]);
console.log("1 contentToText(text+image) =", JSON.stringify(flat));

// 2. model/stream wire (pod reverse tunnel): WireChatMessageSchema is NOT strict.
const ms = RequestSchemas[Method.ModelStream].params.safeParse({
  request: { messages: [userWithRef] },
});
console.log(
  "2 model/stream params parse:",
  ms.success ? `ok, attachments kept=${"attachments" in (ms.data.request.messages[0] ?? {})}` : "REJECTED",
);

// 3. session/new seed + snapshot wire: ChatMessageSchema IS strict.
const ns = RequestSchemas[Method.NewSession].params.safeParse({ messages: [userWithRef] });
console.log("3 session/new params parse:", ns.success ? "ok" : `REJECTED (${ns.error.issues[0]?.code})`);
const snap = RequestSchemas[Method.Snapshot].result.safeParse({ messages: [userWithRef] });
console.log("3 session/snapshot result parse:", snap.success ? "ok" : `REJECTED (${snap.error.issues[0]?.code})`);

// 4. ProxyModelProvider.toWireRequest copies fields explicitly.
let seen: unknown = null;
const proxy = new ProxyModelProvider(async (wire) => {
  seen = wire.messages[0];
  return { events: [{ type: "done" }] };
});
for await (const _ of proxy.stream({ messages: [userWithRef as never] })) {
  // drain
}
console.log("4 proxy wire message =", JSON.stringify(seen));

// 5. Anthropic payload builder: user message stays a plain string.
const p = buildPayload("m", { messages: [userWithRef as never] }) as { messages: unknown[] };
console.log("5 anthropic payload message =", JSON.stringify(p.messages[0]));

// 6. Size math for one phone photo, and sha256 cost (resolver-side verification).
const bytes = new Uint8Array(5 * 1024 * 1024).map((_, i) => i & 0xff);
const b64 = Buffer.from(bytes).toString("base64");
const t0 = performance.now();
const h = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const t1 = performance.now();
console.log(
  `6 5 MiB raw -> base64 ${(b64.length / 1024 / 1024).toFixed(2)} MiB; sha256 ${h.slice(0, 12)}… in ${(t1 - t0).toFixed(1)} ms`,
);
```
```
1 contentToText(text+image) = "what is in this picture?"
2 model/stream params parse: ok, attachments kept=false
3 session/new params parse: REJECTED (unrecognized_keys)
3 session/snapshot result parse: REJECTED (unrecognized_keys)
4 proxy wire message = {"role":"user","content":"what is in this picture?"}
5 anthropic payload message = {"role":"user","content":"what is in this picture?"}
6 5 MiB raw -> base64 6.67 MiB; sha256 2e7cab6314e9… in 2.0 ms
```

Reading: three of the five boundaries drop a new field **silently** (2, 4, 5),
two reject it **loudly** (3). That asymmetry is what sub-task 1 has to design
around. Line 6: a hash check on every resolve costs ~2 ms per 5 MiB, so
verifying bytes at resolve time is affordable.

**Settled here, with the code as the reason:**

- **Persisted-format migration: none needed.** The new field is optional and
  additive (Design §1). `JsonSessionStore.load` is an unvalidated cast
  (`agent/src/session-store.ts:75`), so every existing file loads exactly as
  today. In the other direction (a file written by a new binary, resumed by an
  old one), the old binary's own strict `ChatMessageSchema` rejects
  `session/new` with `unrecognized_keys` (repro line 3). Every runtime goes
  through that schema (TUI always over RPC, AGENTS §7; `peer.ts:307`), so the
  failure is loud and the file is untouched. Bytes are never persisted, only
  references. `session-store-durability.md` §4 (validated load) can add
  `attachments` to the shape it checks when it lands; neither task blocks the
  other.
- **Where capability comes from: the model config, not the model id.** Today
  the config has no vision field (`config/src/schema.ts:33` is the model block;
  `rg -i "vision|image" packages/config/src` → nothing), and an
  OpenAI-compatible endpoint (llama.cpp, vLLM) cannot be probed for vision
  without a live call. Decision: a new optional `model.images: boolean`, with a
  default per provider kind (`select-provider.ts:12`): `anthropic` → `true`,
  `openai` → `false`. Whoever hosts the model advertises it. That is the daemon
  for worker, `--in-process` and `serve`. In pod modes it is the **laptop**,
  which is both the only client and the model host (`ProxyModelProvider`,
  `cli/src/serve.ts:70-90`), so the TUI reads its own config. Wiring is in
  sub-task 3, because `agentCapabilities` is strict (see table).
- **Where references become bytes: per request, at the provider.** The
  alternative is to resolve in the agent and ship bytes in `ChatRequest`. In
  pod modes that would send every image in the history pod→laptop on **every
  model round** (`agent.ts:207-213` rebuilds the request from the full
  history each iteration; 6.67 MiB of base64 per 5 MiB photo, line 6). With
  references, the bytes cross at most once and the laptop resolves locally.
  This also gives the pod-trust boundary a single place to live (Design §3).

**Open, for the owner (the code does not decide these):**

1. **Unavailable attachment: placeholder or error?** When the bytes are gone
   (session GC'd, pod deleted, `--resume` on another machine), this plan sends
   the model a visible text placeholder (`[image unavailable: …]`) instead of
   failing the turn. A failure would repeat on every later turn, which is the
   session-poison class of `history-validity-invariant.md`. Recommended:
   placeholder. Confirm.
2. **Bytes for `--resume`.** History persists on the laptop (AGENTS §7), but
   the bytes live in the daemon's store and die with the session. Should the
   laptop keep a content-addressed cache of what *it* uploaded, so a resumed
   session still has its images? Recommended: yes, bounded, in sub-task 3.
   Otherwise resume shows placeholders (OK given 1).
3. **Images aging out of the payload.** Every round resends the whole history.
   Ten photos is ~50 MB of base64, past provider request limits, so the turn
   fails on every round until `/compact`. Proposal: send only the last *K*
   images inline (*K* = 5 to start) and use placeholders for older ones. This
   is a pure function of the history, applied in the provider helper. Decide
   *K*, or a per-session cap in sub-task 2 instead.
4. **Interleaving.** The design keeps the text and a list of references, and
   renders the images *before* the text. That is the order the Anthropic docs
   show for vision. It loses "compare [img1] with [img2]" interleaving.
   Acceptable for v2? (Extending later to an ordered `parts` list is additive.)
5. **Images in tool results** (a screenshot tool, `fs_read` of a PNG). Out of
   scope: OpenAI chat completions accept image parts only on `user`
   messages. Follow-up eval if wanted.
6. **Parent's remaining open items**, unchanged: client downscale/HEIC
   recommendation, per-file/per-session caps, `uploads/` confinement, GC on
   close. Each one is placed in a sub-task below, with numbers left to
   calibrate.

**Unverified (no live calls allowed):** the exact error that llama.cpp or vLLM
returns when a non-vision model gets an `image_url` part. Provider-side
per-image and per-request limits are also unchecked: the skill reference
confirms the Anthropic base64 block shape and image-before-text order, but not
the byte limits. Both are verified at execution against the providers' current
docs. The design does not depend on them, because `model.images` defaults to
off for `openai`.

### Split

No XL (AGENTS §10). There are four sub-tasks, one code branch at a time. The
parent's (b) is split in two because "store + upload" and "prompt wiring +
pod-trust source" each pass through a different §7 invariant.

| # | Slug (on promotion) | Scope | Size · Blast | Depends on |
|---|---|---|---|---|
| 1 | `feat/attachments-history` | Multimodal `ChatMessage` (additive `attachments` refs), the `AttachmentSource` seam, both providers, the model-tunnel and session-wire mirrors, compaction/token hygiene, `Session.send` | M · load-bearing (persisted format, agent-loop entry, providers, pod tunnel) | nothing. Can land before or after v2 children 2-8. If `protocol-schema-export` has landed, regenerate the committed schema. |
| 2 | `feat/attachment-store` | Daemon content-addressed store (per-session, hash names, caps), `attachment/put` (chunked, resumable, idempotent), `attachment/status`, `attachment/get` (paged) | M · load-bearing (new RPC methods; writes to the pod's disk on client input) | v2 child 3 (`session-event-stream`), `rpc-flow-control` pacing; GC hooks onto child 4 (`session-registry`) close if landed, else connection close |
| 3 | `feat/attachment-prompt` | Prompt block `{type:"attachment", attachmentId}` → `ChatMessage.attachments` (images) or a workspace path (files); `initialize` capability; laptop-side **scoped** source for the pod tunnel; laptop resume cache (open item 2); `PROTOCOL_VERSION` bump | M · load-bearing (prompt wire, §7 pod-trust) | 1, 2 |
| 4 | `feat/attachment-tui` | TUI: attach by path / paste, resume marker for attachments, display-only rendering of pod-produced attachments | S–M · cross-module | 3. Mobile frontends live in their own eval (parent child 10). |

Why this order. Sub-task 1 is the only one that changes the persisted format
and the provider payloads. It is also the one whose mistakes are **silent**
(repro lines 2, 4, 5). It needs nothing from the store: a fake
`AttachmentSource` exercises every path. It has no user-visible producer, so it
can be merged safely ahead of the v2 sequence. Sub-task 2 gets bytes onto the
daemon but not yet into a turn. It is testable on its own (put/get round-trip),
and it is where the flow-control pacing lands (`rpc-flow-control.md`: W=2 ×
256 KiB). Sub-task 3 joins them. It is also where the pod-trust rule
becomes code, so it comes after both seams exist. The UI comes last.

### Sub-task 1 — `feat/attachments-history`

### Load-bearing assumption

**A single optional `attachments` field on `ChatMessage` is invisible to every
consumer that does not need the bytes. The set of consumers that do need them is
finite and known: the two provider serializers, the pod-tunnel mapper, the two
wire mirrors, and `Session.send`.** If another place copies or rebuilds
`ChatMessage`s field by field, it drops images silently and the plan is wrong.

Proof:
- Every file that touches `ChatMessage`
  (`rg -l ChatMessage packages --glob '!**/node_modules/**'`, 18 source
  files) was checked for how it uses `content`. The **constructors**
  (`agent.ts:141,203,258,282,296,313,340,362,402,417,447,497`,
  `subagent.ts:177`, `compact.ts:53-56,94-95,127`, `main.ts:557`,
  `session.ts:67`) build new text-only messages and never copy an incoming
  one. The **readers** read `content` as text: `compact.ts:25`,
  `session-store.ts:30`, `token-counter.ts:41`, `tui/src/resume.ts:18-41`,
  both providers. The **pass-throughs** forward whole objects:
  `connection.ts:147`, `remote-client.ts:147,156`, `session-host.ts:40`,
  `hosted-session.ts:131`. The only field-by-field mapper is
  `proxy-model.ts:47-62` (repro line 4).
- The wire mirrors: `session.ts:24` (strict → loud) and `model.ts:19`
  (non-strict → silent strip, repro line 2). The laptop handler forwards the
  parsed request by cast (`remote-client.ts:209`), so once the schema knows
  the field it survives.
- The one behavioral trap among the readers: `Session.send` treats empty
  text as "continuation, append nothing" (`session.ts:56-68`). An image-only
  prompt would be dropped there.

The assumption **held** on the code as of 2026-10-19, subject to the four sites
the Design fixes. The executor re-runs `boundaries.ts` and the `rg` sweep on
current `main` first. A new field-by-field mapper means STOP and amend this
plan (§0).

### Preconditions

- TUI always over RPC, single session path (AGENTS §7): every runtime
  validates `session/new` and `session/snapshot` against the same
  `ChatMessageSchema` (`peer.ts:139,307,413`). Fixing that schema covers worker,
  pod and `connect` alike.
- Model stays on the laptop (AGENTS §7): in pod modes the provider runs in
  `RemoteClient.onModelStream` / `onModelStreamChunked`
  (`remote-client.ts:204-213`, `:228-…`), the daemon only proxies
  (`proxy-model.ts:154-185`). So the **laptop** resolves bytes, and the pod
  sends references only.
- Providers already take an injected `fetch` (`select-provider.ts:25`), and
  their tests capture the request body. Anthropic's `buildPayload` is exported
  (`anthropic-provider.ts:287`). OpenAI's is not (`openai-provider.ts:193`),
  so its tests go through the injected fetch.
- Persisted file is an unvalidated cast (`session-store.ts:75`); see "Settled".
- Protocol changes are additive within this sub-task. The version is not
  bumped here, because nothing produces attachments until sub-task 3, which
  bumps it.

### Design

1. **Type (core, the source of truth).** `core/src/model.ts`:
   ```ts
   export interface AttachmentRef {
     readonly id: string;        // sha256, 64 lowercase hex
     readonly mimeType: string;  // image/png | image/jpeg | image/gif | image/webp
     readonly size: number;      // bytes
     readonly name?: string;     // client-supplied, display only, never a path
   }
   export interface AttachmentSource {
     /** Bytes for `ref`, or null when not available (never throw for "absent"). */
     read(ref: AttachmentRef, signal?: AbortSignal): Promise<Uint8Array | null>;
   }
   ChatMessage.attachments?: readonly AttachmentRef[];   // user messages only
   ChatRequest.attachments?: AttachmentSource;           // non-serialisable, like `signal`
   export const IMAGE_MIME_TYPES = [...] as const;
   ```
   It is additive and optional, and it is allowed only on `role: "user"`. A
   source returns `null` for "absent" and throws only for transient failures,
   so it is safe to use without a store.
2. **Agent entry.** `Session.send(text, signal?, attachments?)`. A user message
   is appended when `text !== "" || attachments.length > 0`; the old condition
   was `text !== ""` (`session.ts:66`). The message carries `attachments` only
   when non-empty, so no empty array is ever persisted. Refs are validated
   here by a pure `validateAttachmentRefs` in core (hex id, allowed MIME,
   size > 0). An invalid ref throws **before** the history is touched, so a
   bad ref never enters history or disk. `AgentConfig.attachments?:
   AttachmentSource` is copied into each `ChatRequest` the loop builds
   (`agent.ts:207-213`).
3. **Providers.** A new pure helper `providers/src/attachments.ts`:
   - `collectRefs(messages, keepLast)` returns the refs to inline. It
     implements open item 3, with *K* as a parameter that defaults to
     unlimited until the owner decides.
   - `resolveAttachments(request)` returns a `Map<id, base64 | null>`. It reads
     each distinct id once and verifies `sha256(bytes) === id`; a mismatch
     becomes `null`, so wrong bytes are never sent. It returns all `null` when
     `request.attachments` is absent.
   - `placeholder(ref)` returns the text
     `[image unavailable: <mime>, sha256:<first 12>, <name>]`.

   Each provider's `stream()` awaits the resolution **before** `fetch`, then
   passes the map into its sync payload builder:
   - Anthropic `buildPayload(model, req, maxTokens, images?)`: a user message
     with attachments becomes
     `content: [ {type:"image", source:{type:"base64", media_type, data}} …, {type:"text", text} ]`,
     with the text block omitted when it is empty. An unavailable ref
     becomes a `{type:"text"}` placeholder in its slot. The merge rule for
     tool results (`anthropic-provider.ts:306`) is tightened: it merges into
     the previous message only if that message was **built from tool
     results** (a local `Set` of the arrays it created), not just any user
     message whose content is an array.
   - OpenAI `toWireMessage(message, images)`: same order, using
     `{type:"image_url", image_url:{url:"data:<mime>;base64,<b64>"}}` and
     `{type:"text", text}`.
   - Attachments on a non-`user` message, or a MIME type outside
     `IMAGE_MIME_TYPES`, cause a **throw**. These are programming errors,
     because Session validation (2) makes them unreachable.
4. **Wire mirrors (protocol).** A new `AttachmentRefSchema` (strict, with
   `id: /^[0-9a-f]{64}$/`, `size: int ≥ 1`, `mimeType: z.enum(IMAGE_MIME_TYPES)`,
   `name: string.max(255).optional()`) is added as
   `attachments: z.array(AttachmentRefSchema).min(1).optional()` to **both**
   `ChatMessageSchema` (`session.ts:24`) and `WireChatMessageSchema`
   (`model.ts:19`). `WireChatMessageSchema` also becomes `.strict()`, so the
   *next* field added to the tunnel fails loudly instead of being stripped.
   This does not break current peers, which send only the four known fields
   (`proxy-model.ts:47-62`).
5. **Pod tunnel.** `toWireRequest` (`proxy-model.ts:47`) copies
   `attachments` when non-empty. The laptop handlers need no change in this
   sub-task: the parsed request keeps the field, and with no source the
   provider sends placeholders. Sub-task 3 injects the scoped laptop source.
6. **Hygiene.**
   - `compact.ts:25` `renderMessage` appends ` [attached: N image(s)]` so the
     summary knows an image existed. The images themselves do not survive
     compaction (`compactedHistory` replaces the history), which is a known
     limit.
   - `HeuristicTokenCounter.countMessages` adds a fixed
     `IMAGE_TOKEN_ESTIMATE` (proposal: 1600) per ref. It rounds up, in line
     with its contract (`token-counter.ts:6-7`).
   - `sessionTitle` (`session-store.ts:30`) uses `(image)` when the text is
     empty and an attachment exists.

### Files

Dependency order:

1. `packages/core/src/model.ts` (types, `AttachmentSource`, `IMAGE_MIME_TYPES`)
2. `packages/core/src/attachments.ts` (new: `validateAttachmentRefs`), exported from `core/src/index.ts`
3. `packages/core/src/token-counter.ts`
4. `packages/protocol/src/attachment.ts` (new: `AttachmentRefSchema`), exported from `protocol/src/index.ts`
5. `packages/protocol/src/session.ts` and `packages/protocol/src/model.ts`
6. `packages/providers/src/attachments.ts` (new)
7. `packages/providers/src/anthropic-provider.ts` and `packages/providers/src/openai-provider.ts`
8. `packages/agent/src/agent.ts`, `packages/agent/src/session.ts`, `packages/agent/src/compact.ts` and `packages/agent/src/session-store.ts`
9. `packages/daemon/src/proxy-model.ts`
10. Committed JSON Schema, if `protocol-schema-export` has landed

No change in `client`, `cli` or `tui` in this sub-task.

### Failure modes

- **Silent drop at a mapper** (repro lines 2, 4, 5). This is the reason the
  task exists. It is closed by Design §3-5 and pinned by tests T1, T2, T4, T5.
  The strict tunnel schema turns the next such drop into an error.
- **Image-only prompt read as continuation** (`session.ts:66`). Closed by
  Design §2 and test T7.
- **Bytes unavailable** (no source, store GC'd, resume elsewhere, pod gone).
  The model gets a visible placeholder and the turn proceeds, so the session
  never becomes un-resumable (open item 1).
- **Bytes wrong** (corrupt store, or a pod returning other bytes for a hash in
  sub-task 3). The hash is verified on resolve; a mismatch is handled as
  unavailable. Wrong bytes never reach the model, and the check costs about
  2 ms per 5 MiB (repro line 6).
- **Transient read error** (I/O, abort). The source throws, the stream throws
  **before** `fetch`, and the turn ends with an error. The history is
  untouched because the user message was already persisted as references, so
  a retry works.
- **Version skew.** `run` streams the laptop's own binary (`k8s/src/exec-run.ts:8`).
  `attach` can reuse an older injected one (`cli/src/main.ts:115-117`).
  - Old daemon or old laptop with a new history file: rejected loudly by the
    old strict `ChatMessageSchema` (repro line 3).
  - New pod daemon with an **old laptop**: the old laptop's non-strict tunnel
    schema strips `attachments`, and the model silently gets no image. In
    sub-task 1 this cannot happen in practice, because there is no producer.
    Sub-task 3 closes it with the `PROTOCOL_VERSION` bump: `initialize`
    refuses the mismatch (`connection.ts:181-186`).
- **Too many images in the payload** leads to a provider 4xx on every round.
  Covered by the *K* knob (open item 3). Until the owner decides, *K* is
  unlimited and caps arrive with sub-task 2.
- **Malformed ref on the wire** (`session/new` seed). Rejected by the strict
  schema with `InvalidParams`; nothing is written.
- **Tool-result merge into a multimodal user turn**
  (`anthropic-provider.ts:306`). Today it is reachable only with an invalid
  history (a `tool` message right after a `user` message). It is still closed
  by tracking which arrays were built from tool results, and pinned by test T4.
- **Subagents** receive only the text prompt (`subagent.ts:177`). The parent's
  images are not forwarded. This is a documented limit, not a silent drop: the
  subagent's prompt is text by contract.

### Tests

Red before green (§9). The property being pinned is: **the bytes of every
referenced image reach the provider's HTTP body, in order, on every path; and
an absent image reaches it as a visible placeholder, never as nothing.**
"Schema accepts the field" is too weak a property to test.

| # | Test (file) | Red today because |
|---|---|---|
| T1 | `protocol/test/session.test.ts`, `protocol/test/model.test.ts` (new): both mirrors accept a valid `attachments` and reject a bad id, a bad MIME, an empty array, and an unknown key in a ref. The tunnel schema **rejects** an unknown top-level key. | Repro lines 2-3: rejected or stripped. |
| T2 | `daemon/test/proxy-model.test.ts`: the `ProxyModelProvider` wire request carries `attachments` intact (batch and chunked paths). | Repro line 4. |
| T3 | `daemon/test/integration.test.ts`: real `Connection` + `RemoteClient` + fake laptop provider. A history with refs, seeded via `session/new`, reaches the laptop provider's `ChatRequest.messages` with the refs deep-equal, and `session/snapshot` returns it unchanged. | Strict reject (line 3), then strip (line 2). |
| T4 | `providers/test/anthropic-provider.test.ts` (`buildPayload` + injected fetch): 2 refs + text become `[image, image, text]`, with the base64 equal to the source bytes. Also: empty text gives images only; a `null` source gives a placeholder text block; a hash mismatch gives a placeholder; a ref on an `assistant` message throws; a `tool` message after a multimodal `user` message is **not** merged into it. | No image blocks are built (line 5). |
| T5 | `providers/test/openai-provider.test.ts` (injected fetch): the same cases with `image_url` data URLs. | `content` is a string (`openai-provider.ts:218`). |
| T6 | providers: `source.read` is called once per distinct id per request. A throwing source rejects the stream with the fetch spy **not called**. | The helper does not exist. |
| T7 | `agent/test/session.test.ts`: `send("", s, [ref])` appends `{role:"user", content:"", attachments:[ref]}` and persists it. An invalid ref throws, and the history length is unchanged. | Continuation path: nothing is appended. |
| T8 | `agent/test/agent.test.ts`: a fake model records that `ChatRequest.attachments` is the configured source. | The field does not exist. |
| T9 | `core/test/token-counter.test.ts`: count(text + ref) equals count(text) + `IMAGE_TOKEN_ESTIMATE`. `agent/test/compact.test.ts`: the transcript contains `[attached: 1 image(s)]`. | The images are ignored. |
| T10 | `agent/test/session-store.test.ts`: a record with refs survives save then load deep-equal; a legacy file without the field loads unchanged. | The first half is green today (cast); the second half is a regression pin. |

Non-vacuity by mutation (run each mutation, confirm the named tests fail,
then revert):
- Drop `attachments` in `toWireRequest` → T2 and T3 fail.
- Revert `WireChatMessageSchema` to non-strict → the unknown-key case of T1 fails.
- Revert the `Session.send` condition → T7 fails.
- Have the providers ignore the map → T4 and T5 fail.
- Skip the hash check → the mismatch cases of T4 and T5 fail.
- Revert the merge guard → the merge case of T4 fails.

Gate: full `bun run check` against the lint baseline (AGENTS §4, §6).

### Why, item by item

- **Why an additive `attachments` field and not `content: string | Part[]`.**
  Many readers treat `content` as text (proof above). A union type would make
  the compiler flag most of them, but not template literals:
  `compact.ts:25` would silently render `[object Object]`. The additive field
  leaves every text reader correct as it is, and limits the change to the six
  sites listed. The persisted format needs no migration.
- **Why references in history and bytes resolved at the provider.** The parent
  decided on references. Resolving at the provider means bytes cross the pod
  tunnel at most once instead of once per model round
  (`agent.ts:207-213`). It also puts the laptop-side trust check (sub-task 3)
  at the one place bytes are read.
- **Why `AttachmentSource` lives on `ChatRequest`, not on the provider.** The
  source is per session, and in sub-task 3 it is the **scoped** allowlist of
  what this laptop uploaded. A provider is per process. It follows the
  existing precedent of a non-serializable, per-request field (`signal`,
  `protocol/src/model.ts:9`).
- **Why a placeholder instead of an error for missing bytes.** A failing image
  fails every later turn, because the history is resent every round. The
  placeholder keeps the session alive and tells the model the truth, which is
  not a silent drop.
- **Why verify the hash on read.** The id *is* the hash. Checking it costs
  about 2 ms (line 6), and it means corrupt or substituted bytes can never
  reach the model under the user's identity.
- **Why make the tunnel schema strict now.** It is the boundary that stripped
  the field silently (line 2). Strict makes every future additive field fail
  loudly between mismatched peers, at no cost today.
- **Why images go before text.** That is the order the Anthropic vision
  examples use. OpenAI is order-agnostic. Interleaving is an owner choice
  (open item 4).
- **Why `model.images` defaults to off for `openai`.** A local llama.cpp model
  without a vision projector errors or ignores the image. Opting in is safer
  than finding out from a failed turn.
- **Why sub-task 1 does not bump the protocol version.** No path produces
  attachments yet, so no mixed-version pair can reach the silent case. The
  bump goes with the first producer (sub-task 3), so it happens once.

### Outline of later sub-tasks

**2 — `feat/attachment-store`** (M · load-bearing).
- *Scope:* `AttachmentStore` on the daemon. It is content-addressed, rooted at
  `<daemon state>/attachments/<sessionId>/<sha256>`, and the file name is the
  hash (never client input). It exposes
  `attachment/put {sessionId, sha256, mimeType, size, offset, chunk(base64)}`,
  which is idempotent: a re-sent chunk at an offset already held is acked
  without a write. It also exposes `attachment/status {sessionId, sha256} →
  {have}` for resume, and `attachment/get {sessionId, sha256, offset, limit}`.
- *Integrity and limits:* the hash is verified on the final chunk, and a
  mismatch deletes the partial upload. There are caps per file and per session
  (proposal: 10 MiB and 100 MiB). The MIME allowlist covers images plus a
  "file" class.
- *Lifecycle:* GC on session close (child 4) or on connection close (today).
- *Pacing:* a client sends at most 2 chunks in flight, 256 KiB each, from
  `rpc-flow-control.md` (W=2 measured as the sweet spot). Long transfers must
  not serialize the peer (AGENTS §7).
- *Load-bearing assumption:* concurrent request dispatch
  (`transport/peer.ts`) lets 256 KiB `put`s interleave with `prompt` and
  permission traffic. Prove it with the flow-control eval's harness.
- *Files:* `protocol` (new methods), `daemon/src/attachment-store.ts` (new),
  `daemon/src/connection.ts`, and `client/src/remote-client.ts` (`upload()`
  helper with resume).
- *Key tests:* resume after a dropped connection mid-upload; a duplicate chunk
  is a no-op; a hash mismatch is rejected and removed; a cap is exceeded;
  path traversal in `name` has no effect on the path; GC on close; a `prompt`
  is answered while a 5 MiB upload is in flight.

**3 — `feat/attachment-prompt`** (M · load-bearing).
- *Scope:* a new prompt block `{type:"attachment", attachmentId, mimeType,
  name?}`. The inline `image` block stays rejected (child 3).
  `HostedSession.prompt` maps image refs to `ChatMessage.attachments` and
  file refs to a workspace path. Files are copied from the store to
  `<cwd>/.tentacle/uploads/<sha256>.<ext>`, with confinement checked by
  resolved path. A text line gives the model that path.
- *Capability:* `initialize` → `agentCapabilities.prompt.image` from
  `model.images`. `PROTOCOL_VERSION` is bumped.
- *Pod trust:* the laptop-side `AttachmentSource`, injected into
  `RemoteClient` for `model/stream*`, is **scoped to the hashes this laptop
  uploaded in this session**. A pod-supplied ref outside that set gives a
  placeholder, never a laptop file. Pod-produced attachments are display-only
  (AGENTS §7).
- *Laptop cache:* the bounded laptop-side cache for `--resume` (open item 2).
- *Load-bearing assumption:* in pod modes the laptop is the only client that
  can upload, so "what the laptop uploaded" is exactly the set of images the
  user meant to show. Re-check this against child 4's multi-attach before
  building.
- *Key tests:*
  - A pod daemon requests a ref the laptop never uploaded (raw RPC frame from a
    fake daemon) → placeholder, and the laptop store/cache is not read outside
    the allowlist (spy).
  - An old/new `initialize` mismatch is refused.
  - A file attachment lands under `uploads/` named by hash, and
    `name: "../../x"` stays metadata.
  - An image-only prompt runs a turn.

**4 — `feat/attachment-tui`** (S–M · cross-module).
- *Scope:* attach by path (and by paste where the terminal allows it); show
  upload progress through the single `StatusLine` or an Ink element, never
  raw stdout (AGENTS §7); render a resume marker `[image: name]`
  (`tui/src/resume.ts:17-19`); render pod-produced attachments as inert,
  never auto-opened; hide the control when the capability is off.
- *Load-bearing assumption:* the pure-module rule. Upload state and the view
  model live in a React-free module.
- *Key tests:* `ink-testing-library` frames for the marker and the
  capability-off state; a pure-module test for the upload state machine.

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
