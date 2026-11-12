# feat/attachments-prompt — an image ref in `session/prompt`, resolved where the model runs

> **Status:** implementation — APPROVED (owner night delegation 2026-11-12, see §Orchestrator decisions)
> **Branch:** `feat/attachments-prompt`
> Type: feat · Size: M · Blast: load-bearing (prompt wire, `initialize` capability, agent-factory seam, §7 "a pod is not trusted" / "model stays on the laptop") · Suited: strong model executes + **mandatory fresh-context Review** red-teaming the laptop scoped source and the single-session-path invariant

Umbrella: `docs/feat/attachments.md` §Split row 2b. Built on (merged):
`attachments-core.md` (refs, `AttachmentSource`, provider images, `Session.send`
— its `#### Owner answers` bind), `attachments-upload.md` (`attachment/put`,
`AttachmentStore`, `RemoteClient.upload()` — its Owner answers bind: Q2 (a) **no
bytes in a pod**), `attachments-tui-detect.md` (pure TUI detection; consumed by
3b, not here).

## Context

*— claude-opus-5-5, 2026-11-12*

After 1 and 2a, a ref can live in the history and its bytes can sit in the
daemon's session store — but **nothing joins them**:

- `session/prompt` has no block that names a ref: its `content` is
  `ContentBlockSchema` (`protocol/src/session.ts:287`), text/image/resource only;
  the daemon refuses anything but text (`daemon/src/mapping.ts:128-136`, called
  at `hosted-session.ts:1936`).
- The session store (`HostedSession.uploads`, `hosted-session.ts:430`) is never
  given to the agent: the host's agent factory receives only `modelLink`
  (`session-host.ts:978-981`), so `AgentConfig.attachments`
  (`agent/src/agent.ts:511`) is unset on every runtime → every image would reach
  the model as `[image unavailable — …]`.
- In pod runtimes the provider is the LAPTOP's (`RemoteClient.onModelStream*`,
  `client/src/remote-client.ts:3024,3042,3253`) and it gets the pod's request by
  cast with no byte source; per upload Owner Q2 the bytes must stay on the
  laptop, so the laptop needs its own **scoped** source.
- No client can learn whether a daemon takes images: `agentCapabilities` is
  `{tools, permissions}` (`connection.ts:460`), and `model.images` exists only as
  a provider option (`providers/src/select-provider.ts:41`), not in config
  (`config/src/schema.ts:40-54`).

This task wires those four seams. **No TUI change** — the producer (chips,
`/attach`, progress, `[image: …]` rows) is 3b, which consumes the client API
defined here.

**Repro** (2026-11-12, bun 1.4.3, branch base `main` @ 924186b; run as
`bun /Users/gmeghnag/tentacle/.tentacle/tmp/attachments-prompt/seams.ts`):

```ts
// seams.ts (2026-11-12) — load-bearing check for feat/attachments-prompt:
// where can a ref's bytes be resolved, per runtime, and what is missing today?
import { createHash } from "node:crypto";
import { Agent, Session } from "@tentacle/agent";
import { type ChatRequest, type ModelProvider, PermissionBroker } from "@tentacle/core";
import { Method, PROTOCOL_VERSION, RequestSchemas } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection, ProxyModelProvider, SessionHost } from "@tentacle/daemon";

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const ref = { id: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/png", size: bytes.length };
const env = { id: "e", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), readFile: async () => "", writeFile: async () => {} };
const src = { read: async () => bytes };

// 1. The prompt wire has no attachment block.
const p = RequestSchemas[Method.Prompt].params.safeParse({ sessionId: "S", turnId: "t1", content: [{ type: "attachment", ref }] });
console.log("1 session/prompt{attachment}:", p.success ? "ok" : `REJECTED (${p.error.issues[0]?.code})`);

// 2. A daemon-held provider: AgentConfig.attachments reaches every ChatRequest (core seam).
let seen: ChatRequest | undefined;
const rec: ModelProvider = { id: "rec", async *stream(req) { seen = req; yield { type: "text", delta: "ok" } as never; yield { type: "done" } as never; } };
const s = new Session(new Agent({ model: rec, tools: new ToolRegistry(), env: env as never, attachments: src }), "s");
for await (const _ of s.send("", undefined, { attachments: [ref] })) { /* drain */ }
console.log("2 agent ChatRequest.attachments === source:", seen?.attachments === src, "| msgs:", JSON.stringify(seen?.messages.map((m) => [m.role, m.content, m.attachments?.length])));

// 3. What the host gives its agent factory today, and what initialize advertises.
let ctxKeys: string[] = [];
const host = new SessionHost({
  defaultCwd: "/x",
  createAgent: (_cwd, ctx) => {
    ctxKeys = Object.keys(ctx);
    return { agent: new Agent({ model: rec, tools: new ToolRegistry(), env: env as never }), permissions: new PermissionBroker() };
  },
});
const [a, b] = createChannelPair();
new Connection(b, host);
const client = new RpcPeer(a, { onRequest: async () => ({ trusted: false }) });
const init = (await client.request(Method.Initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } })) as { agentCapabilities: unknown };
await client.request(Method.Open, { sessionId: "S", create: true });
console.log("3 AgentContext keys:", JSON.stringify(ctxKeys), "| agentCapabilities:", JSON.stringify(init.agentCapabilities));
const hosted = host.get("S");
console.log("3b hosted.uploads is a source:", typeof hosted?.uploads.read === "function");

// 4. A laptop-held provider (pod): the pod's proxy never forwards a source.
let wire: unknown;
const proxy = new ProxyModelProvider(async (w) => { wire = w; return { events: [{ type: "done" }] }; });
for await (const _ of proxy.stream({ messages: [{ role: "user", content: "", attachments: [ref] }], attachments: src })) { /* drain */ }
console.log("4 proxy wire keys:", JSON.stringify(Object.keys(wire as object)), "| refs kept:", JSON.stringify((wire as { messages: { attachments?: unknown[] }[] }).messages[0]?.attachments?.length));
process.exit(0);
```
```
1 session/prompt{attachment}: REJECTED (invalid_union_discriminator)
2 agent ChatRequest.attachments === source: true | msgs: [["user","",1]]
3 AgentContext keys: ["modelLink"] | agentCapabilities: {"tools":true,"permissions":true}
3b hosted.uploads is a source: true
4 proxy wire keys: ["messages"] | refs kept: 1
```

Reading: *s1* the capability is missing on the wire. *s2* the core seam works
(an image-only prompt is one user message with its ref, and the source rides
the request). *s3* the store exists but the factory has no way to receive it,
and no client can tell images are possible. *s4* in pod mode refs cross to the
laptop but the source does not (correct: the laptop must supply its own).
(A first run whose fake model replied nothing showed an extra
`"Continue with the task."` user message: that is the agent's empty-round nudge,
`agent.ts:1416-1421`, not an image bug — the fake now replies `ok`.)

## Implementation

*— claude-opus-5-5, 2026-11-12*

### Load-bearing assumption

**The bytes behind a ref are needed only where the provider runs, and each
runtime has exactly ONE place to attach a source there — so the design adds no
second session path, only a source at that place:**

- **(a) daemon-held provider** (worker, `serve`, a pod daemon without
  `--model-proxy`): `AgentConfig.attachments` is carried on all three
  `ChatRequest`s the agent builds (`agent/src/agent.ts:1192,1491,1610`; *s2*).
  The agent is built ONLY by the host's factory, at create
  (`daemon/src/session-host.ts:978`), at `session/update_settings` (`:1039`) and
  for the context probe (`:346`, no session → no store). Today the factory's
  context is `{modelLink, settings?, reuse?}` (`:68-87`; *s3*) → the store must
  ride `AgentContext`.
- **(b) laptop-held provider** (pod `run`/`attach`, `--model-proxy`): every model
  call of a pod session reaches the laptop as `model/stream`,
  `model/streamChunked` or `model/countTokens`, served by exactly three casts in
  `RemoteClient` (`remote-client.ts:3024,3042,3253`, behind `servingModel`
  `:3148-3190`). The pod's `ProxyModelProvider` forwards refs and never a source
  (*s4*), so a laptop-side source attached at those three casts is the only
  thing that can turn a pod's ref into bytes — and it can hold only what the
  laptop itself put there.

Proved: *s2*–*s4* above; `rg -n "createAgent\(" packages/daemon/src` → the three
sites listed; `rg -n "params.request as unknown as ChatRequest"
packages/client/src` → the three casts listed. **Executor: re-run both `rg`
and `seams.ts` first; a fourth factory call or serving cast → STOP and amend
this plan (AGENTS §0, §8).**

Corollary relied on (also proved): `HostedSession.prompt` is synchronous from
its retry check to its ack (`hosted-session.ts:1916-1918`, no `await` before
`this.session.send` at `:1969`), and a store `put` is synchronous
(`attachments-upload.md` §Load-bearing) — so "every ref is held complete" checked
in `prompt` cannot be invalidated before `Session.send` pushes the message; a
completed blob is never evicted while the session lives (upload D2), only
`dispose()` at `close()` drops it (`hosted-session.ts:2909`), which also ends
the turn.

### Preconditions

| # | Fact | Source |
|---|---|---|
| P1 | Payloads are strip schemas; a new optional field and a new method are free; an older daemon refuses an unknown prompt block LOUDLY (`InvalidParams`, discriminated-union parse) | `protocol/src/index.ts:8-12`; `transport/src/peer.ts:337-342`; *s1* |
| P2 | `Session.send(text, signal, {attachments})` validates refs BEFORE any push and runs an image-only prompt as a turn | `agent/src/session.ts:152-170` (`checkAttachmentRefs` at `:155`, `pushed` at `:157`) |
| P3 | A user message with refs is logged as `media_message` (critical) and a `serve` sidecar tail with refs is written v2 — persistence needs nothing new | `attachments-core.md` As-built §1, Review r2 M1 |
| P4 | `HostedSession.uploads` implements `AttachmentSource`; `read` returns bytes only for a complete blob of the ref's size, else `null` | `daemon/src/attachment-store.ts:108,278-284` |
| P5 | Providers verify sha256 + size of every read and enforce the per-provider cap with a visible placeholder (backstop) | `providers/src/images.ts:38,45,118,147`; `anthropic-provider.ts:146-158` |
| P6 | Provider vision defaults: anthropic `images ?? true`, openai `images ?? false` | `anthropic-provider.ts:146`; `openai-provider.ts:168-175` |
| P7 | The TUI drives a session through `RemoteSession.send` → `RemoteClient.prompt` (keyed, re-sent identically after a drop) | `client/src/remote-session.ts:925-937,1177-1183,1480,1573`; `remote-client.ts:1870-1884` |
| P8 | `RemoteClient.upload(sessionId, bytes, {signal, onProgress})` → `{id, size}`, id computed laptop-side from the bytes | `remote-client.ts:1499-1540`; `attachments-upload.md` D5 |
| P9 | Only pod runtimes give `RemoteClient` a model provider: `engine-runtime.ts:114` → `local-runtime.ts:758`; `connect` passes `undefined` (`connect.ts:178`); the worker passes none | grep `new RemoteClient(` |
| P10 | `model/stream*` params carry NO `sessionId` | `protocol/src/model.ts:91-140` |
| P11 | `ModelConfigSchema` is `.strict()` (config, not wire): a new key must be added there, in `resolve`, `load`, `models` (per-entry inheritance) and `key-docs` — the exact path `maxImageBytes` took | `config/src/schema.ts:53-55`; `models.ts:26-71`; `resolve.ts:84-87,410,543,576`; `load.ts:154-157,857`; `key-docs.ts:283,398`; `cli/src/model-provider.ts:28,52,69,159,171` |
| P12 | `AttachmentRefusedReason` is a TS type only (no schema): adding reasons is additive | `protocol/src/attachment-upload.ts:57-58` |

### Design

**Rule: whoever runs the provider holds the bytes.** Daemon-held provider →
bytes in `HostedSession.uploads` via `attachment/put` (2a). Laptop-held provider
(pod `--model-proxy`) → bytes stay in the laptop's `RemoteClient`; the pod gets
refs only (upload Owner Q2). The daemon TELLS the client which case applies;
the client never guesses.

**D1 — protocol (shared truth; no `PROTOCOL_VERSION` bump).**
- `protocol/src/content.ts`: `AttachmentContentSchema = z.object({ type:
  z.literal("attachment"), ref: AttachmentRefSchema })` and
  `PromptContentBlockSchema` = discriminated union of Text, Image, Resource,
  Attachment. `PromptParamsSchema.content` (`session.ts:287`) →
  `z.array(PromptContentBlockSchema).min(1)`. `ContentBlockSchema` (used by
  the `session/update` schemas, `updates.ts:34,40,58`) is UNCHANGED: the block
  is prompt-only and a daemon never emits it, so no update class or
  `client/mapping.ts` change.
- `AgentCapabilitiesSchema` (`session.ts:150-153`) gains `images:
  z.object({ input: z.string().min(1).max(32), maxBytes:
  z.number().int().positive().optional() }).optional()`. Known `input` values:
  `"upload"` (bytes go by `attachment/put`, then refs) and `"client"` (the
  client that serves the model keeps the bytes; refs only). A free string, not
  an enum: a future value must not make an older client refuse the whole
  `initialize` result; an unknown value means "off" client-side (D5). Absent =
  this daemon takes no images.
- `AttachmentRefusedReason` (P12) += `"images_off" | "not_uploaded" |
  "invalid_ref"`, raised with `DomainErrorCode.AttachmentRefused` by `prompt`
  (D3), so 3b branches on a reason, not on text.
- Version: additive (P1). Old client + new daemon: never sends the block. New
  client + old daemon: no `images` capability → refused client-side before any
  upload (D5). Regenerate `schema/protocol.json` (`bun run schema:export`) and
  add the `json-schema.test.ts` fixture rows the drift gate demands.

**D2 — daemon: the policy and the source.**
- `daemon/src/session-host.ts`: `export type ImagePolicy = { readonly source:
  "store"; readonly maxBytes: number } | { readonly source: "client" }`;
  `SessionHostOptions.images?: ImagePolicy` (absent = off, so every existing
  `SessionHost` keeps refusing image prompts) and a `get images()`.
- `AgentContext.attachments?: AttachmentSource` (`:68-87`). `build()` creates
  `const uploads = new AttachmentStore(this.uploadBudget)` BEFORE `createAgent`,
  passes `attachments: uploads` iff `images?.source === "store"`, and hands the
  same `uploads` to `new HostedSession(…)` (`:1014`). `updateSettings` (`:1039`)
  passes `attachments: hosted.uploads` under the same condition (a settings
  sync must not silently drop the source). The context probe (`:346`) passes
  none.
- `AttachmentStore.holds(ref): boolean`: the synchronous twin of `read`'s
  predicate (complete AND `bytes.length === ref.size`); `read` reuses it.
- `connection.ts:460` (`initialize`): `agentCapabilities: { tools: true,
  permissions: true, ...imagesCapability(this.host.images) }` — `store` →
  `{ images: { input: "upload", maxBytes } }`, `client` → `{ images: { input:
  "client" } }`, absent → nothing.

**D3 — daemon: the prompt (`hosted-session.ts:1924-1980`).**
- `mapping.ts`: `splitPrompt(content) → { text, refs }` replaces
  `assertTextOnly` + `contentToText` in `prompt`. Text blocks are joined with
  `"\n"` (today's `contentToText`), attachment blocks become `refs` in order,
  and an `image`/`resource` block raises the SAME `InvalidParams` as today
  (wording now points at the attachment block). `contentToText` stays for its
  other callers.
- In `prompt`, right after the retry check and BEFORE the skill/busy checks (a
  refused prompt records nothing — today's rule), when `refs.length > 0`, the
  sync `checkPromptImages(refs)` throws `RpcError(AttachmentRefused, text,
  { reason })`:
  1. no policy → `images_off`: "this session's model does not take images
     (model.images is off, or the daemon predates images)";
  2. `checkAttachmentRefs(refs)` (core) throws → `invalid_ref`, its message;
  3. `store`: a ref over `maxBytes` → `invalid_ref`, naming
     `attachmentLabel(ref)`, `formatBytes(size)` and the limit; a ref with
     `!uploads.holds(ref)` → `not_uploaded`: "image <label> is not on this
     daemon — upload it again";
  4. `client`: nothing more — the laptop that serves the model is the gate
     (D5, D6); the pod has no bytes to check (upload Owner Q2).
- Then `this.session.send(text, signal, { …, ...(refs.length > 0 ? {
  attachments: refs } : {}) })`. The wake prompt (`:2476`, `[]`) is unchanged.
- `turn_start{prompt: text}` is unchanged (other clients' `[image]` rows are
  3b's display update). `session/enqueue`, `send_now` and steer stay
  TEXT-ONLY (their schemas never take the block).

**D4 — config + cli: who sets which policy (one pure function).**
- `model.images: z.boolean().optional()` on `ModelConfigSchema`, wired through
  `resolve` / `load` / `models` (per-entry inheritance) / `key-docs` exactly
  like `maxImageBytes` (P11); `cli/src/model-provider.ts` passes `images` to
  `createModelProvider` at its three sites.
- `providers/src/images.ts`: `imageLimits(provider: "anthropic" | "openai", o:
  { images?: boolean; maxImageBytes?: number }) → { vision: boolean; maxBytes:
  number }` — the ONE truth for the defaults (P6) and the effective cap
  (`effectiveMaxImageBytes`). Both providers call it instead of their inline
  `?? true` / `?? false`, so the advertised capability cannot disagree with
  what the provider does.
- `cli/src/image-policy.ts` (new, pure): `daemonImagePolicy(config, {
  modelProxy }) → ImagePolicy | undefined` — `modelProxy` → `{ source:
  "client" }`; else `imageLimits(config.provider, config)` → `vision ? {
  source: "store", maxBytes } : undefined`. Called where the three hosts are
  built: `serve.ts:178` (`startDaemon`), `serve.ts:521` (`podSessionHost`),
  `worker.ts:105`.
- The factories forward `ctx.attachments`: `serve.ts:186`, the non-proxy
  branch of `serve.ts:536`, `worker.ts:122` → `buildAgent(…, { …, attachments
  })`; `buildAgent` (`wiring.ts:389`) puts it on the `Agent` config.
  `tunnelledAgent` never gets one (client policy).
- Laptop side (pods): `engine-runtime.ts:114` also computes
  `imageLimits(config.provider, config)`; `local-runtime.ts:758` passes it as
  `RemoteClientOptions.localImages` (only beside a `modelProvider`).

**D5 — client: one entry point for 3b.**
- `client/src/image-input.ts` (new, pure): `imageInput(caps, local: {
  servesModel; vision?; maxBytes? }) → { kind: "upload"; maxBytes } | { kind:
  "laptop"; maxBytes } | { kind: "off"; reason }`:

  | `caps.images` | Result |
  |---|---|
  | absent | off: "this daemon does not take images (its model has no vision, or it predates images — update it)" |
  | `input: "upload"` | upload; `maxBytes = min(caps.maxBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES)` |
  | `input: "client"`, client serves no model | off: "the daemon expects this client to serve the model, and it does not" |
  | `input: "client"`, `local.vision !== true` | off: "this laptop's model does not take images (model.images)" |
  | `input: "client"`, vision | laptop; `maxBytes = local.maxBytes` |
  | any other `input` | off: "unknown image input <input> — update tentacle" |

- `client/src/laptop-images.ts` (new, pure): `class LaptopImages implements
  AttachmentSource` — `add(id, bytes)` (dedupe by id; throws
  `LaptopImagesFullError` past `LAPTOP_IMAGE_BYTES = 100 MiB`; never evicts:
  eviction would silently turn a sent image into a placeholder); `read(ref)` →
  bytes iff the id is held AND `bytes.length === ref.size`, else `null`.
- `RemoteClient`: keeps the LAST handshake's `agentCapabilities` (re-read on
  every reconnect: a replaced pod binary may change it); `readonly images:
  LaptopImages`; `imageInput()` (the table, `servesModel = modelProvider !==
  undefined`); and
  `attachImage(sessionId, bytes, meta: { mimeType; name? }, opts?: { signal?;
  onProgress? }) → Promise<AttachmentRef>`:
  1. `off` → reject `ImagesUnavailableError(reason)`, zero frames;
  2. `size > maxBytes` → reject naming size and limit (`formatBytes`);
     `checkAttachmentRefs([candidate])` fails → reject; zero frames;
  3. `upload` → `await this.upload(sessionId, bytes, opts)`; the ref is built
     from the LAPTOP's bytes, never from a daemon answer;
  4. `laptop` → `id = sha256Bytes(bytes)`, `this.images.add(id, bytes)`,
     `onProgress(size, size)`; no frame.
- `RemoteClient.prompt(…, skill?, attachments?)` (trailing param): `content` =
  `text(prompt)` unless `prompt === ""` with refs, then one `{ type:
  "attachment", ref }` per ref. `RemoteSession.send` opts gain `attachments?`,
  stored on `ActiveTurn`, so every re-send (`remote-session.ts:1480,1573`)
  carries the same refs under the same `turnId`.

**D6 — the scoped laptop source (AGENTS §7: a pod is not trusted).** One
private helper `laptopRequest(request)` = `{ ...(request as ChatRequest),
attachments: this.images }`, used at ALL three serving casts
(`remote-client.ts:3024,3042,3253`). The pod chooses only WHICH refs to name;
the laptop reads only ids it added itself, in this process, through
`attachImage`, and the provider re-verifies sha256 + size (P5). A ref the
laptop never added → `null` → `[image unavailable]`. No laptop file is ever
opened (`LaptopImages` holds bytes, not paths), and the bytes go only to the
laptop's own provider (`model/stream*` returns model events, never bytes).
Scope is per `RemoteClient`, not per session: `model/stream*` has no
`sessionId` (P10) — Orchestrator decision 3.

### Files (dependency order)

1. `packages/protocol/src/content.ts` (`AttachmentContentSchema`, `PromptContentBlockSchema`) · `session.ts` (`PromptParamsSchema.content`, `AgentCapabilitiesSchema.images`) · `attachment-upload.ts` (3 reasons) · `index.ts` · `schema/protocol.json` (`bun run schema:export`) · `protocol/test/json-schema.test.ts` fixture rows
2. `packages/providers/src/images.ts` (`imageLimits`) · `anthropic-provider.ts` · `openai-provider.ts` · `index.ts`
3. `packages/config/src/schema.ts` · `resolve.ts` · `load.ts` · `models.ts` · `key-docs.ts` (`model.images`)
4. `packages/daemon/src/attachment-store.ts` (`holds`) · `mapping.ts` (`splitPrompt`) · `session-host.ts` (`ImagePolicy`, `AgentContext.attachments`, `build`, `updateSettings`) · `hosted-session.ts` (`prompt`, `checkPromptImages`) · `connection.ts` (`initialize`) · `index.ts`
5. `packages/client/src/image-input.ts` (new) · `laptop-images.ts` (new) · `remote-client.ts` (`localImages` option, caps kept, `images`, `imageInput`, `attachImage`, `prompt` refs, `laptopRequest` ×3, `ImagesUnavailableError`) · `remote-session.ts` (`send` opts, `ActiveTurn`) · `index.ts`
6. `packages/cli/src/image-policy.ts` (new) · `model-provider.ts` (`images`) · `wiring.ts` (`buildAgent` option) · `serve.ts` (2 hosts, 2 factories) · `worker.ts` (host, factory → exported `workerAgentFactory`) · `engine-runtime.ts` + `local-runtime.ts` (`localImages`)
7. `CHANGELOG.md` (`Added`) · `TODO.md` (2b line → this doc)

No `tui` change (3b). No `PROTOCOL_VERSION` change. No persisted-format change (P3).

### Failure modes

| Mode | What happens | Converges how | Pinned by |
|---|---|---|---|
| Prompt names a ref never uploaded / upload incomplete (`store`) | `not_uploaded` before anything is recorded | the client uploads again and re-prompts (3b keeps the bytes until the ack) | T4 |
| `serve` restarted between upload and prompt (memory store) | same as above | same; durability = sub-task 4 | T4 |
| Model without vision (`store` daemon, `images` false) | no capability → client refuses before upload; a raw prompt → `images_off` | loud, nothing recorded | T4, T7 |
| Older daemon (pre-2b, same v23) | no `images` capability; a raw prompt with the block → `InvalidParams` (union parse) | client says "update it", zero frames | T1, T7 |
| A daemon advertises an unknown `input` | client treats it as off | no upload, clear text | T5 |
| Hostile pod claims `input: "client"` to a client that serves no model (`connect`) | off | nothing read, nothing sent | T5 |
| Hostile pod names a ref the laptop never added (raw `model/stream` frame) | `LaptopImages.read` → `null` → placeholder | no laptop file opened, no bytes outside the laptop provider | T8 |
| Hostile pod names a laptop-held id with a wrong size | `read` → `null` (size check); provider re-verifies sha (P5) | placeholder | T6, T8 |
| Pod session with two laptop TUIs (resident daemon, multi-attach); the model link is the TUI that did NOT attach the image | that laptop has no bytes → `[image unavailable]` (visible, the session never poisons: core) | documented; laptop CAS cache = sub-task 4 | — (documented) |
| Laptop restarted, `attach` again to a pod session with images | bytes lost (memory) → placeholder | sub-task 4 | — |
| Laptop store full (100 MiB) | `LaptopImagesFullError` from `attachImage` | loud; never evicts | T6 |
| Image over the per-provider cap | refused at `attachImage` (laptop or advertised `maxBytes`) and at `prompt` (`store`) | loud, naming size + limit; provider placeholder stays the backstop | T4, T7 |
| HEIC / bad mime / 6 refs / duplicate ids | `checkAttachmentRefs` at `attachImage` and `prompt` → `invalid_ref` | loud, nothing recorded | T4, T7 |
| Image-only prompt | content = attachment blocks only; `text ""` + refs is a turn (P2) | — | T4, T7 |
| Skill + image-only prompt | the skill rule (`text === ""`) still refuses | unchanged | T4 |
| Drop mid-prompt (keyed re-send) | same `turnId`, same refs; the daemon's retry check answers before any image check | one turn | T7 |
| `session/update_settings` rebuilds the agent | source passed again (`hosted.uploads`) | images keep resolving | T4 |
| Factory forgets `ctx.attachments` (a new host) | images become placeholders silently | pinned per host: T10 asserts each of the 3 cli hosts' turn requests carry the store | T10 |
| Session closed mid-turn | `dispose()` drops bytes; the turn is cancelled by the close | — | existing |
| Reconnect to a replaced pod binary | caps re-read at every handshake | mode follows the new daemon | T7 |
| Main model switched to a non-vision one mid-session | capability is the daemon's start-time config; provider placeholder is the backstop | documented | — |

### Tests

Property: **a ref in `session/prompt` reaches the provider together with a
source that yields exactly its verified bytes — the daemon's store when the
daemon runs the model, the laptop's own `LaptopImages` when the laptop does —
and in every other case it is refused before anything is recorded, or (pod-named
refs the laptop never added) becomes a visible placeholder; the pod never
receives bytes.** "The schema accepts the block" alone is too weak.

No `App` frame test: this task changes nothing a user can see (3b owns the
chips, `/attach` and the frames on the real `App` via ink-testing-library). Write
each test first, show it RED on the branch base, then implement.

| # | File | Asserts | Red because |
|---|---|---|---|
| T1 | `protocol/test/attachment-prompt.test.ts` (new) | `PromptParams` accepts `[text, attachment]` and `[attachment]`, rejects a bad ref; the `session/update` content schemas still reject an attachment block; `AgentCapabilities` parses with `images {input:"upload", maxBytes}`, with an unknown `input`, and without `images` | *s1* |
| T2 | `daemon/test/mapping.test.ts` | `splitPrompt`: texts joined `\n`, refs in order, `image`/`resource` → `InvalidParams`, `[]` → `{text:"", refs:[]}` | absent |
| T3 | `daemon/test/attachment-store.test.ts` | `holds` true only for complete + same size; returns a boolean synchronously | absent |
| T4 | `daemon/test/attachment-prompt.test.ts` (new; real `Connection` + `SessionHost`, factory forwarding `ctx.attachments` to a recording provider; copy `attachment-put.test.ts`) | `store`: put → prompt `[text, ref]` → provider `ChatRequest.attachments === hosted.uploads` and `read(ref)` deep-equals the bytes; the history message carries the ref; `session/log` shows `media_message`. Refusals, each with its `reason`, with the session's turn count + log head unchanged and the same `turnId` later accepted: not uploaded / partial → `not_uploaded`; no policy → `images_off`; over `maxBytes`, `image/heic`, 6 refs → `invalid_ref`. Image-only prompt runs a turn. Skill + image-only → unknown skill. `client` policy: accepted with nothing uploaded, `ChatRequest.attachments` undefined. `initialize` caps for store / client / none. After `session/update_settings` the new agent's requests still carry `hosted.uploads` | block refused; ctx has no source |
| T5 | `client/test/image-input.test.ts` (new, pure) | every row of the D5 table | absent |
| T6 | `client/test/laptop-images.test.ts` (new, pure) | add/read; unknown id → `null`; size mismatch → `null`; dedupe does not double-count; full → `LaptopImagesFullError`, earlier entries still readable (no eviction) | absent |
| T7 | `client/test/attach-image.test.ts` (new; real `RemoteClient` ↔ real `Connection`, frame spy) | `upload` mode: ref id = sha256(bytes), store `holds` it; `off` (host without policy) → `ImagesUnavailableError`, zero frames; oversize vs advertised `maxBytes` → rejected, zero frames; `prompt(…, refs)` frame content `[text, attachment…]`, image-only `[attachment…]`; `RemoteSession.send({attachments})` dropped after send → reconnect re-sends identical content under the same `turnId`, one turn; caps re-read after reconnect to a host with another policy | absent |
| T8 | `client/test/model-stream-attachments.test.ts` (extend core's) | fake pod daemon (raw `RpcPeer`) declaring `input:"client"`; laptop `RemoteClient` with a recording provider and `localImages {vision:true}`: after `attachImage` (zero `attachment/put` frames), `model/stream`, `model/streamChunked` and `model/countTokens` each give the provider a source whose `read(ref)` deep-equals the bytes; a ref the laptop never added (raw frame) → `read` `null`; a held id with a wrong size → `null` | source absent at the casts |
| T9 | `client/test/pod-attachments-e2e.test.ts` (extend core's) | pod shape end to end: real pod `SessionHost` (`images: {source:"client"}`, `ProxyModelProvider`) ↔ laptop `RemoteClient` with a real anthropic provider + injected `fetch`: `attachImage` → `RemoteSession.send("what?", {attachments})` → the HTTP body holds the image block with the base64 of the bytes; the channel spy saw NO `attachment/put` and no frame toward the pod containing the base64 | refs only, no bytes |
| T10 | `cli/test/image-policy.test.ts` (new) + host tests | `daemonImagePolicy`: proxy → client; anthropic default → store 3,932,160; openai default → none; `model.images: true` on openai → store 5 MiB; `maxImageBytes` override. Per host (`startDaemon`'s `serve.ts:114`, `podSessionHost` non-proxy `:503`, the worker's): a turn's `ChatRequest.attachments` is the session's store. `worker.ts` exports nothing today: extract its `createAgent` body into an exported `workerAgentFactory(config, …)` (no behaviour change) so the test can drive it with an injected `createProvider` | factories ignore ctx |
| T11 | `providers/test/images.test.ts`, `config` tests | `imageLimits` defaults and overrides; `model.images` accepted (boolean only), inherited by a `models` entry, passed to `createModelProvider` | absent |

Mutations (each must turn the named tests red; revert after):
- `prompt` skips `checkPromptImages` → T4 (not_uploaded, images_off)
- `holds` ignores the size → T3, T4
- `build()` passes the store regardless of policy, or never → T4 (client policy / store)
- `updateSettings` drops `attachments` → T4 (update_settings case)
- `laptopRequest` used at only 2 of the 3 casts → T8 (the third method)
- `LaptopImages.read` ignores the size → T6, T8
- `imageInput` treats an unknown `input` as `upload` → T5
- `attachImage` uploads in `laptop` mode → T8/T9 (`attachment/put` frame seen)
- `ActiveTurn` not storing refs (re-send without them) → T7
- one cli factory not forwarding `ctx.attachments` → T10
- anthropic provider keeps its inline `?? true` while `imageLimits` says false → T11

Gate before done: `bun run check` (typecheck → lint → test); lint baseline clean
(AGENTS §4, §6). Narrow: the files above.

#### Orchestrator decisions (owner night delegation 2026-11-12)

Each open question decided with the recommended option; one line of reason.

1. **Version bump?** No — a new prompt block, an optional capability field and
   new refusal reasons are additive; an old daemon refuses the block loudly and
   advertises no capability (P1). *Reason:* AGENTS §7 "fields and methods are
   free"; a bump would break the v23 pods for nothing.
2. **Where the block lives:** a prompt-only union (`PromptContentBlockSchema`),
   not `ContentBlockSchema`. *Reason:* the daemon never emits it, so the update
   schemas and `client/mapping.ts` stay untouched.
3. **Laptop scope per client, not per session.** *Reason:* `model/stream*` has
   no `sessionId` (P10); the pod already hosts the session that named the image,
   so a per-session scope would add a wire field without removing any exposure.
4. **`agentCapabilities.images.input` a bounded free string, not an enum.**
   *Reason:* an enum would make an older client refuse a future daemon's whole
   `initialize` (the `MessageNote` / ref-mime rule).
5. **Daemon refusals as `AttachmentRefused` + reason** (not `InvalidParams`).
   *Reason:* 3b must branch (re-upload on `not_uploaded`) without matching text.
6. **Laptop store: bytes in memory, 100 MiB, refuse when full, never evict.**
   *Reason:* mirrors upload Owner Q1 (loud refusal over a silent placeholder);
   holding paths instead would break on vanishing screenshot temp files.
7. **`model.images` in config now, inherited by `models` entries; the effective
   value comes from one `imageLimits()`.** *Reason:* core Owner Q5 (a); one
   truth so capability and provider can never disagree.
8. **Pod daemon without `--model-proxy` = `store`** (its own model).
   *Reason:* the rule "whoever runs the provider holds the bytes"; Owner Q2 is
   about the proxy pods the laptop launches.
9. **`enqueue` / `send_now` / steer stay text-only.** *Reason:* scope; 3b sends
   images only with a prompt and may refuse/hold them while a turn runs.
10. **Multi-attach pod (another laptop is the model link) → placeholder,
    documented.** *Reason:* the umbrella's re-check: bytes live with the laptop
    that attached; the cross-laptop cache is sub-task 4.

**Implementation APPROVED** (owner night delegation, 2026-11-12).

## Execution

*— deepseek, 2026-11-12*

### Load-bearing check, re-run first (per the brief)

Both greps and `seams.ts` match the plan exactly on the branch base:

- `rg -n "createAgent\(" packages/daemon/src` → the three sites
  (`session-host.ts:346,978,1039`); no fourth.
- `rg -n "params.request as unknown as ChatRequest" packages/client/src` → the
  three casts (`remote-client.ts:3024,3042,3253`); no fourth.
- `bun .tentacle/tmp/attachments-prompt/seams.ts` → byte-identical to the plan's
  recorded output (`1 … REJECTED (invalid_union_discriminator)`, `2 … true`,
  `3 AgentContext keys: ["modelLink"] | agentCapabilities: {"tools":true,
  "permissions":true}`, `3b … true`, `4 proxy wire keys: ["messages"]`). The
  capability is genuinely missing; nothing had drifted.

Branch base was `main @ 924186b`, working in
`.tentacle/worktrees/attachments-prompt` (the task's worktree).

### As-built, in the Implementation's order

1. **protocol.** `content.ts`: `AttachmentContentSchema` +
   `PromptContentBlockSchema` (prompt-only union, as decided — `ContentBlockSchema`
   untouched, so no update class and no `client/mapping.ts` change).
   `session.ts`: `PromptParamsSchema.content` takes the prompt union;
   `AgentCapabilitiesSchema.images = { input: string(1..32), maxBytes? }`.
   `attachment-upload.ts`: the three new refusal reasons. Regenerated
   `schema/protocol.json` (`bun run schema:export`) and added fixture rows for
   an attachment-only and a mixed prompt plus both `images` capability shapes;
   the union count went 6 → 7.
2. **providers.** `imageLimits(provider, {images?, maxImageBytes?})` in
   `images.ts` is now the ONE source for both providers' `vision` and effective
   cap; `anthropic-provider.ts` / `openai-provider.ts` dropped their inline
   `?? true` / `?? false` and their cap defaults.
3. **config.** `model.images` on the strict `ModelConfigSchema`, threaded through
   `resolve` → `load` → `models` (per-entry inheritance) → `key-docs` (both
   `model.images` and `models.*.images`) → `cli/model-provider.ts` at its three
   provider sites; README config table regenerated with `bun run docs:config`.
   File-only, exactly like `maxImageBytes`: no `sourceKey`, no `resolved` (the
   key-docs test that pins "no default, no env source" caught my first attempt).
4. **daemon.** `AttachmentStore.holds(ref)` (synchronous twin of `read`'s
   predicate; `read` reuses it). `splitPrompt(content)` in `mapping.ts` replaces
   `assertTextOnly`+`contentToText` in `prompt` only (`contentToText` kept for
   its other callers). `ImagePolicy` + `SessionHostOptions.images` +
   `SessionHost.images`; `AgentContext.attachments`; `build()` creates the store
   before the factory and passes it iff `source === "store"`, then gives the SAME
   store to `HostedSession`; `updateSettings` re-passes `hosted.uploads`;
   the context probe passes none. `HostedSession.prompt` runs `splitPrompt`,
   then `checkPromptImages(refs)` before the skill/busy checks, then
   `session.send(text, signal, { attachments: refs })`.
   `connection.ts` `initialize` advertises `images` from the policy.
5. **client.** New pure `image-input.ts` (the D5 table) and `laptop-images.ts`
   (bytes, dedupe, 100 MiB, `LaptopImagesFullError`, never evicts).
   `RemoteClient`: `localImages` option, caps captured on EVERY handshake,
   `readonly images`, `imageInput()`, `attachImage()`, `prompt(…, attachments)`,
   `ImagesUnavailableError`, and `laptopRequest()` used at all three serving
   casts. `RemoteSession`: `send(…, {attachments})` stored on `ActiveTurn` so
   every keyed re-send carries them.
6. **cli.** New pure `image-policy.ts` with `daemonImagePolicy`;
   `serve.ts` (both hosts), `worker.ts` (host) call it; all three factories
   forward `ctx.attachments` into `buildAgent`, which puts it on the `Agent`
   config. `engine-runtime.ts` `laptopModels()` also returns `localImages`
   (from the same `imageLimits()`), which both `createLocalRuntime` call sites
   spread; `local-runtime.ts` passes it only beside a `modelProvider`.
7. `CHANGELOG.md` (`[Unreleased] ### Added`) and this section. `TODO.md`
   deliberately untouched, per the brief.

### Drift from the Implementation (and why)

- **`worker.ts`'s factory signature.** The plan said "extract its `createAgent`
  body into an exported `workerAgentFactory(config, …)`". As built it is
  `workerAgentFactory(config, ctx, {skillScan})` — the `AgentContext` itself is
  the second parameter, so the `ctx.attachments` forwarding lives INSIDE the
  exported body rather than at the call site. Reason: with the forwarding left at
  the call site, mutation "a cli factory forgets `ctx.attachments`" stayed green
  (the test drove the factory directly, bypassing the call site). Moving it in
  makes the mutation red. No behaviour change.
- **T10's per-host test is split.** A turn driven through `podSessionHost`'s
  non-proxy factory uses a REAL provider built from config, so the round would
  leave the machine; those two tests assert the HOST's policy
  (`podSessionHost` store / client) and the exported worker factory's forwarding
  is pinned end-to-end (turn → request → the session's own store). The
  `startDaemon` host's factory forwarding is therefore pinned by shape and by the
  same `buildAgent` option, not by a turn. Stated as a gap, not as covered.
- **Two existing tests changed meaning, on purpose.** `named-models.test.ts` and
  the T7 case in `model-stream-attachments.test.ts` used to assert that a
  laptop's `model/stream` request carries NO `attachments` field. D6 replaces
  "no source" with "a source scoped to what this laptop itself added", so they
  now assert the stronger property: the field is the laptop's own `LaptopImages`,
  and a pod-named ref reads `null`. Same for `pod-attachments-e2e.test.ts`'s
  `(b)`. The security property ("a pod cannot make the laptop read anything") is
  preserved and now tested directly (T8's stranger-ref and wrong-size cases).
- **`explain.test.ts` counts.** `model` went 10 → 11 direct sub-keys and
  `models` 10 → 12 (it counts the `*` entry's keys too, so `models.*.images` is
  the second). Numbers updated with a comment naming the change.
- **`key-docs.ts` placement.** My first insert put `model.images` inside the
  `models.*` block; `explain` showed `models: 12` vs `model: 11` and the move
  fixed it. Worth noting because the failure mode (a key documented under the
  wrong parent) is silent in every other test.

### Tests (each written first, red on the branch base, then green)

T1 `protocol/test/attachment-prompt.test.ts` (new) · T2 `daemon/test/mapping.test.ts`
(`splitPrompt`) · T3 `daemon/test/attachment-store.test.ts` (`holds`) · T4
`daemon/test/attachment-prompt.test.ts` (new, real `Connection`+`SessionHost`) ·
T5 `client/test/image-input.test.ts` (new) · T6 `client/test/laptop-images.test.ts`
(new) · T7 `client/test/attach-image.test.ts` (new, frame spy) · T8 extended
`client/test/model-stream-attachments.test.ts` · T9 extended
`client/test/pod-attachments-e2e.test.ts` · T10 `cli/test/image-policy.test.ts`
(new) + `cli/test/image-hosts.test.ts` (new) · T11
`providers/test/images.test.ts` (new) + `config/test/model-images.test.ts` (new).

Red-then-green, recorded per slice: slice 1 failed on `AgentCapabilitiesSchema`
returning `images: undefined` and accepting `input: ""` (property failures, not
imports — the first draft used a symbol that did not exist yet and was rewritten
for exactly that reason); slices 2, 4, 5, 6 for the NEW pure modules failed on
the absent symbol (`imageLimits`, `splitPrompt`/`holds`, `image-input.ts`/
`laptop-images.ts`, `image-policy.ts`), which is what the plan's table predicts
for a capability that does not exist; T4/T7/T8/T9's behavioural cases were red on
their assertions (e.g. `hosted.uploads` not reaching the request; the laptop's
source absent at the casts) after the modules existed. One extra non-vacuity
mutation was run against the OLD behaviour directly (M1b: `prompt` restored to
`assertTextOnly` + no refs) — 8 T4 cases go red, so those tests are not passing
by construction on `main`'s shape.

### Mutations (each run, then reverted; site restored from a copy, no git commands)

| # | Mutation | Result |
|---|---|---|
| M1 | `prompt` skips `checkPromptImages` | **RED** — 7 T4 cases (`not_uploaded` ×2, `invalid_ref` ×2, `images_off`, re-try after upload, client-mode `invalid_ref`) |
| M1b | `prompt` → old `assertTextOnly` path | **RED** — 8 T4 cases |
| M2 | `holds` ignores the size | **RED** — T3 + the existing `read`-seam test |
| M3a | `build()` passes the store regardless of policy | **RED** — T4 (`images_off`, client-mode no-source) |
| M3b | `build()` never passes the store | **RED** — T4 (store case, update_settings case) |
| M4 | `updateSettings` drops `attachments` | **RED** — T4 update_settings case |
| M5 | `laptopRequest` at the chunked cast only | **RED** — 5 cases across T7/T8 |
| M5b | `laptopRequest` removed from the `countTokens` cast | **RED** — T8 `countTokens` case (proves the THIRD cast) |
| M6a | `LaptopImages.read` ignores the size | **RED** — T6 + T8 wrong-size |
| M6b | `imageInput` treats an unknown `input` as `upload` | **RED** — T5 forward-compat |
| M7 | `attachImage` uploads in laptop mode | **RED** — 5 T8 cases (incl. the zero-frame assertion) |
| M8 | `ActiveTurn` not storing refs | **RED** — T7 keyed re-send |
| M9a | worker factory forgets `ctx.attachments` | **RED** (after the signature fix above; green before it) |
| M9b | `buildAgent` drops the `attachments` option | **RED** — worker factory test |
| M9c | worker host not given the image policy | **GREEN — uncovered.** `worker.ts`'s host builder is not exported and starts a real MCP/model stack; T10 covers the policy value through `daemonImagePolicy` and `podSessionHost`, not through `worker.ts`'s own `SessionHost(...)` call |
| M10 | anthropic keeps its inline `?? true` beside `imageLimits` | **GREEN — equivalent mutant, not uncovered.** Verified by running both expressions over `{undefined, true, false}` × both providers: identical for every input, and no config can separate them (two copies would only diverge after a future default change; AGENTS §9 forbids a test that cannot fail) |

### Gate

- `bunx tsc --noEmit` — clean.
- `bun run lint` — clean (`biome check .`: 946 files, no fixes applied; matches
  the §6 baseline of 0 errors / 0 warnings).
- `bun test` — **7410 pass, 0 fail, 3 skip** (the three opt-in skips: live-k8s,
  live-docker, real-socket keepalive), 533 files, 70,969 assertions.
- `packages/protocol/schema/protocol.json` regenerated and committed with the
  code changes (the drift gate in `json-schema.test.ts` is green).

### Not verified / left open

- `worker.ts`'s own `SessionHost(...)` policy wiring (M9c). One line; confirmed
  by reading, not by a test, because the builder is inside the worker entry
  point. Extracting it would be the honest fix and is a follow-up.
- T9 uses a stand-in provider rather than the real `AnthropicProvider` (the plan
  named one): `packages/client` does not depend on `packages/providers`, and
  adding that edge for a test would be worse than the gap. The property proved
  is unchanged — the laptop's source arrives at the provider holding the exact
  bytes and the pod never sees the base64 — and the provider side of the same
  seam is covered by `providers/test/anthropic-images.test.ts`.
- Multi-attach pods (another laptop is the model link) still yield a placeholder,
  as decided (Orchestrator decision 10); nothing in this task changes that.


## Review

*— claude-opus-5-5, 2026-11-12* (fresh context; same model as the plan's
author, different from the executor — plan-level blind spots may survive.)

**Verdict: REQUEST-CHANGES**

**Gate (narrow + static):** the 16 touched test files → 220 pass / 0 fail;
`bun run lint` clean (946 files); `bun run typecheck` clean. Full `bun test`
not re-run by this reviewer.

**Findings**

1. **HIGH — a pod decides whether the laptop ships image bytes into it
   (§7 "a pod is not trusted"; upload Owner Q2 (a) "no bytes in a pod").**
   `client/src/image-input.ts:58-60` returns `upload` for `input:"upload"`
   regardless of `local.servesModel`, and `RemoteClient.attachImage`
   (`remote-client.ts:735-737`) then `attachment/put`s the bytes. Every
   laptop-launched pod runs `--model-proxy` (`cli/src/engine-runtime.ts:95`;
   the resident inherits it, `pod-resident.ts:790`), so a laptop that serves
   the model being told `upload` happens only when the pod daemon is lying
   (a replaced binary, or any same-uid process that took over the resident
   socket). *Scenario:* a hostile pod answers `initialize` with
   `images:{input:"upload"}` → 3b's `/attach` of a screenshot uploads its
   bytes into the pod, where any pod process can read them. The gate is the
   pod's own claim, i.e. a daemon-side check used as security. The test
   `client/test/image-input.test.ts:42-47` pins this as intended, so the
   flaw is in the D5 table itself. *Fix:* `servesModel && input === "upload"`
   → `off` (or `laptop`), with a T5 row plus a T8 case (a fake pod declaring
   `upload` to a serving laptop → zero `attachment/put` frames).
2. **MEDIUM — the "factory forgets `ctx.attachments`" failure mode is pinned
   for 1 of 3 hosts, and the worker's policy line not at all.** The plan's T10
   asks for a turn's `ChatRequest.attachments` per host. As built, only
   `workerAgentFactory` is driven end to end. `startDaemon`'s factory
   (`serve.ts:206-217`) and `podSessionHost`'s non-proxy factory
   (`serve.ts:553-566`) are pinned only by shape, and `worker.ts:145-147`
   (`images` on the host) is uncovered (Execution's M9c, green). *Scenario:*
   a refactor drops `...(ctx.attachments ? …)` in `serve.ts`, the suite stays
   green, and every `serve` image becomes `[image unavailable]` with no error.
   Execution states this gap honestly. It still breaks a load-bearing
   failure-mode row. Inject `createProvider` through `podSessionHost` /
   `reloadedHost` (or extract each factory like the worker's) and add the turn
   test.

**Premise spot-checks:** three `createAgent(` sites in `daemon/src` and three
`params.request as unknown as ChatRequest` casts in `client/src`: TRUE.
`prompt` is synchronous from the retry check to `session.send`: TRUE (the
retry check runs before `splitPrompt`/`checkPromptImages`,
`hosted-session.ts:1993-2001`). `model/stream*` carry no `sessionId`: TRUE
(the plan relies on it for per-client scope).

**Mutation (non-vacuity):** removing `laptopRequest` from the
`model/countTokens` cast (`remote-client.ts:3176`) → T8 "model/countTokens
carries it too" FAILS (10 pass / 1 fail). File restored from a scratch copy,
and `git status --porcelain` shows nothing. The executor's mutation table was
not re-run in full.

**Attacks tried**
- A pod lies about `input` to a serving laptop → finding 1.
- A pod names a ref the laptop never added, or the right id at the wrong
  size → `LaptopImages.read` → `null`, and the provider re-hashes. Holds.
- `session/update_settings` under `client` vs `store`: the source is passed
  again only for `store`. Holds.
- A refused prompt leaves no state: refs are checked before skill/busy/turn
  state and before the log. Holds.
- A keyed re-send after a drop carries the refs (`ActiveTurn.attachments`)
  and the retry check answers first. Holds.
- Protocol: the prompt-only union leaves `ContentBlockSchema` and the
  update classes untouched. `images.input` is a free bounded string, and an
  unknown value means off. Additive, so no `PROTOCOL_VERSION` bump needed.
  Holds.

**What holds:** single session path (no new loop, only a source at the
existing seams); the single broker is untouched; the model stays on the
laptop (refs only over `model/stream*`, T9 spies for base64); `imageLimits()`
is one truth shared by provider and capability.

**Executor behaviour:** disciplined and honest. It re-ran the load-bearing
greps first, recorded drift with reasons, called equivalent and uncovered
mutants (M10, M9c) by their names instead of hiding them, and committed no
weakened tests. Finding 1 follows the approved plan, so it is a plan defect,
not an execution one.
