# feat/attachments-core — image references in the history, end to end (no producer yet)

> **Status:** implementation (awaiting owner approval of §Owner questions)
> **Branch:** `feat/attachments-core`
> **Type:** feat · **Size:** M · **Blast:** load-bearing (persisted log format + a new critical entry type, `PROTOCOL_VERSION`, providers, agent-loop entry, pod tunnel) · **Suited:** DeepSeek executes (strong-model slot); **mandatory fresh-context Review** red-teaming AGENTS §7 "never half-loads", "model stays on the laptop", "a pod is not trusted"

Umbrella + split + re-verified state: `docs/feat/attachments.md` §Promotion.

## Context

*— claude-opus-5-5, 2026-11-12*

The owner wants a photo dragged into the laptop TUI to reach the model on
every runtime (§Promotion). That needs four sub-tasks (1 → 2a → 2b → 3b). This
one is the foundation and the only one whose mistakes are **silent**: today a
`ChatMessage` carrying image refs loses them at 4 boundaries without an error
(repro *r2*–*r6*), and an older build reading a log with images would
half-load it. It has **no user-visible producer**: the daemon keeps refusing
image prompts (`mapping.ts:128-136`) until 2b. A fake `AttachmentSource`
exercises every path.

Constraints (binding): parent point 18 / D10 (`docs/eval/session-reattach.md`
:355-365, :469) — refs by sha256, history stores refs never bytes, text
placeholder when bytes are missing, only the last K images inline, images
before text. AGENTS §7: strip schemas (never `.strict()`), a new critical log
type is an owner decision + `PROTOCOL_VERSION` bump (`session-log.ts:17-19`).

**Repro** (2026-11-12, bun 1.4.3, `main` @ 27e8b44; run as
`bun /Users/gmeghnag/tentacle/.tentacle/tmp/attachments/boundaries.ts`):

```ts
// boundaries.ts (2026-11-12) — where does an image (wire block) or an
// `attachments` field on a ChatMessage get dropped or refused TODAY?
import { assertTextOnly, ProxyModelProvider, SessionLog } from "@tentacle/daemon";
import { buildPayload } from "@tentacle/providers";
import { ChatMessageSchema, LogMessageEntrySchema, Method, PROTOCOL_VERSION, RequestSchemas } from "@tentacle/protocol";

const ref = { id: "a".repeat(64), mimeType: "image/png", size: 1234 };
const userWithRef = { role: "user", content: "what is in this picture?", attachments: [ref] };
const has = (o: unknown) => typeof o === "object" && o !== null && "attachments" in o;

console.log("0 PROTOCOL_VERSION =", PROTOCOL_VERSION);
try {
  assertTextOnly([{ type: "text", text: "x" }, { type: "image", mimeType: "image/png", data: "iVBO" }]);
  console.log("1 prompt image block: accepted");
} catch (e) {
  console.log("1 prompt image block: REJECTED:", (e as Error).message);
}
const cm = ChatMessageSchema.safeParse(userWithRef);
console.log("2 ChatMessageSchema:", cm.success ? `ok, attachments kept=${has(cm.data)}` : "REJECTED");
const ms = RequestSchemas[Method.ModelStream].params.safeParse({ request: { messages: [userWithRef] } });
console.log("3 model/stream params:", ms.success ? `ok, attachments kept=${has(ms.data.request.messages[0])}` : "REJECTED");
const le = LogMessageEntrySchema.safeParse({ type: "message", seq: 1, id: "i/1", ts: 0, critical: true, message: userWithRef });
console.log("4 log message entry:", le.success ? `ok, attachments kept=${has(le.data.message)}` : "REJECTED");
let seen: unknown = null;
const proxy = new ProxyModelProvider(async (wire) => {
  seen = wire.messages[0];
  return { events: [{ type: "done" }] };
});
for await (const _ of proxy.stream({ messages: [userWithRef as never] })) {
  // drain
}
console.log("5 proxy wire message =", JSON.stringify(seen));
const p = buildPayload("m", { messages: [userWithRef as never] }) as { messages: unknown[] };
console.log("6 anthropic payload message =", JSON.stringify(p.messages[0]));
const log = new SessionLog("inc");
console.log("7 SessionLog ctor ok:", typeof log);
```
```
0 PROTOCOL_VERSION = 22
1 prompt image block: REJECTED: only text content is supported (got image); see docs/eval/attachments.md
2 ChatMessageSchema: ok, attachments kept=false
3 model/stream params: ok, attachments kept=false
4 log message entry: ok, attachments kept=false
5 proxy wire message = {"role":"user","content":"what is in this picture?"}
6 anthropic payload message = {"role":"user","content":"what is in this picture?"}
7 SessionLog ctor ok: object
```

Reading: *r1* the daemon already refuses (good, stays until 2b). *r2*–*r6*:
every boundary drops the field **silently**. *r4* is the persisted-format
hazard: the log entry type is known and critical, so an older build parses it
and silently loses the image.

## Implementation

*— claude-opus-5-5, 2026-11-12*

### Load-bearing assumption

**Every place a `ChatMessage` travels from `Session.send` to a provider's HTTP
body, to the `session/log` wire and to `<uid>.jsonl` either passes the object
whole (spread or cast — an extra field survives) or is one of exactly SEVEN
enumerated sites this plan changes.** If an eighth field-by-field mapper or
schema exists, images vanish silently there and the plan is wrong.

The seven: (1) `ChatMessageSchema` `protocol/src/session.ts:51-79` (strip, *r2*)
· (2) `WireChatMessageSchema` `protocol/src/model.ts:19-24` (strip, *r3*) ·
(3) the log entry schemas `session-log.ts:127-141` (strip via (1), *r4*) ·
(4) `toWireRequest` `daemon/src/proxy-model.ts:57-72` (*r5*) · (5) Anthropic
`buildPayload` `anthropic-provider.ts:360-420` (*r6*) · (6) OpenAI
`toWireMessage` `openai-provider.ts:292-305` · (7) `canonicalMessage`
`session-log.ts:338-352` (fixed field list → digest).

Proof (2026-11-12):
- `rg -n "role: m\.role|role: message\.role|content: m\.content|content: message\.content|role: msg\.role" packages --glob '!**/test/**' --glob '!**/node_modules/**'`
  → only `hooks.ts:719` (hook `new_messages` payload: `{role, content}` by
  contract, out of scope, documented below), `tools/src/skill.ts:105` (reads
  a tool result's text), and sites (4)–(6).
- Spreads that keep extra fields: `core/src/history-validity.ts:116,181`
  (`repairHistory`), `agent/src/agent.ts:1567` (context-usage stamp),
  `agent/src/context-awareness.ts:55-56` (`renderForModel`).
- Casts that keep the object: emitter `daemon/src/session-log.ts:329-331`
  (`wire()`), folds `client/src/session-log-reader.ts:161`,
  `daemon/src/session-log-file.ts:296,365`, laptop handler
  `client/src/remote-client.ts:2736`.
- Constructors build NEW text-only messages and never copy an incoming one
  (compaction, context reset, notes, sub-agent prompt, step-limit nudge):
  `compact.ts:67-69,108-109,276-281`, `context-reset.ts:71-78`, `subagent.ts:434`,
  `agent.ts:326,1470-1476`, `history-validity.ts:338`,
  `persisted-session.ts:253`.

**Executor: re-run the `rg` above and `boundaries.ts` first. A new hit that is
not in this list → STOP and amend this plan (AGENTS §0, §8).**

### Preconditions

| Fact | Evidence |
|---|---|
| TUI always over RPC: every runtime's history crosses `ChatMessageSchema` (seed `session/open{messages}`, `session/log`) | AGENTS §7; `session.ts:808,991`; `session-log.ts:131,140` |
| Model stays on the laptop: in pod modes the provider runs in `RemoteClient.onModelStream*` and receives the parsed wire request by cast, with NO byte source | `remote-client.ts:2730-2743`, `:2891` |
| Strip schemas everywhere; `.strict()` forbidden | `protocol/src/index.ts:8-12` |
| Unknown **critical** log type → reader refuses the whole read/file loudly; file left untouched | `session-log-reader.ts:254-262`; `session-log-file.ts:14-17`; KNOWN = keys of `LOG_ENTRY_CRITICAL` (`reader :76`, `file :97`) |
| A new critical type is an owner decision and bumps `PROTOCOL_VERSION` | `session-log.ts:17-19` |
| core may import protocol | `packages/core/package.json` deps `@tentacle/protocol` |
| Provider tests can capture the HTTP body via injected `fetch` | `select-provider.ts:30`, `CreateModelProviderOptions.fetch` |
| A tunnel-field precedent with tests exists (`stopReason` over `model/stream`) | `protocol/src/model.ts:43-55`; `packages/client/test/model-stream-stop-reason.test.ts` |
| `node:crypto` `createHash` is already used in agent | `agent/src/session-store.ts:8` |

### Design

**D1 — protocol: the ref (source of truth for the shape).** New
`packages/protocol/src/attachment.ts`, exported from `index.ts`:

```ts
export const ATTACHMENT_ID_RE = /^[0-9a-f]{64}$/;            // sha256, lowercase hex
/** What a provider may send as an image. Entry points (Session.send, the TUI) accept ONLY these. */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;                 // owner Q4
export const MAX_IMAGE_BYTES = 3_932_160;                     // 3.75 MiB raw → ≤ 5 MiB base64 (owner Q4)
export const AttachmentRefSchema = z.object({
  id: z.string().regex(ATTACHMENT_ID_RE),
  // A bounded FREE string, never z.enum(IMAGE_MIME_TYPES): refs ride CRITICAL
  // log entries, and an enum would make a newer build's type (image/heic)
  // refuse the whole log (the MessageNote rule, session.ts:34-40).
  mimeType: z.string().min(1).max(64).regex(/^image\/[a-z0-9.+-]+$/),
  size: z.number().int().positive(),
  // Display only, never a path. No control chars.
  name: z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;
export const AttachmentsSchema = z.array(AttachmentRefSchema).min(1).max(MAX_ATTACHMENTS_PER_MESSAGE);
```

Add `attachments: AttachmentsSchema.optional()` to `ChatMessageSchema`
(`session.ts:51`) and to `WireChatMessageSchema` (`model.ts:19`) — with a
one-line doc comment ("user messages only; refs, never bytes;
docs/feat/attachments-core.md"). Both stay strip.

**D2 — protocol: the log (owner Q2 = (a)).** In `session-log.ts`:

```ts
export const LogMediaMessageEntrySchema = z.object({
  ...envelopeShape(), ...critical(),
  type: z.literal("media_message"),
  message: ChatMessageSchema.extend({ attachments: AttachmentsSchema }),   // required here
});
export const LogMediaReplaceEntrySchema = z.object({
  ...envelopeShape(), ...critical(),
  type: z.literal("media_replace"),
  index: z.number().int().nonnegative(),
  message: ChatMessageSchema.extend({ attachments: AttachmentsSchema }),
});
```

- Add both to `KnownLogEntrySchema` and to `LOG_ENTRY_CRITICAL` as `true`;
  update the module comment's v1 table ("v2, owner-approved 2026-11-xx:
  + `media_message`, `media_replace`").
- Helpers (exported, used by EVERY emitter and fold — no other code compares
  to the literal `"message"`/`"replace"` after this change):
  ```ts
  export function hasAttachments(m: { readonly attachments?: readonly unknown[] }): boolean {
    return m.attachments !== undefined && m.attachments.length > 0;
  }
  export function appendEntryType(m: WireChatMessage): "message" | "media_message";   // by hasAttachments
  export function replaceEntryType(m: WireChatMessage): "replace" | "media_replace";
  export function isAppendEntry(e: KnownLogEntry): e is LogMessageEntry | LogMediaMessageEntry;
  ```
- `projectEntry`: `case "media_message":` falls through with `"message"`,
  `case "media_replace":` with `"replace"`.
- `canonicalMessage`: append ONE element **only when** `hasAttachments(m)`:
  `m.attachments.map((a) => [a.id, a.mimeType, a.size, a.name ?? null])`.
  A message without refs must hash byte-identically to today (checkpoints in
  existing files stay valid).
- `DigestibleMessage` gains the readonly `attachments?` shape.

Why new types and not a field on `message`: an older build knows `message`
and strips the field (*r4*) → half-load. An unknown critical type makes it
refuse loudly, only for sessions that contain images (text-only sessions stay
readable by older builds, unlike a header `schemaVersion` bump).

**D3 — protocol version.** `PROTOCOL_VERSION = 23` with a comment line:
"23: image refs on messages (`attachments`) and the critical log types
`media_message`/`media_replace` (docs/feat/attachments-core.md): an older
peer would strip the refs silently". Update every test pinning 22
(`rg -n "toBe\(22\)" packages/*/test`). Regenerate the committed schema:
`bun run schema:export` (`package.json:19`) → `packages/protocol/schema/protocol.json`.

**D4 — core.** `core/src/model.ts`:
```ts
import type { AttachmentRef } from "@tentacle/protocol";
export type { AttachmentRef };
/** Bytes for a ref, or null when this source does not have them (never throw for "absent"; throw only for a transient failure). */
export interface AttachmentSource {
  read(ref: AttachmentRef, signal?: AbortSignal): Promise<Uint8Array | null>;
}
// ChatMessage: readonly attachments?: readonly AttachmentRef[];   (user messages only; non-empty when present)
// ChatRequest: readonly attachments?: AttachmentSource;           (non-serialisable, like `signal`)
```
New `core/src/attachments.ts` (exported from `core/src/index.ts`):
- `export class InvalidAttachmentError extends Error`.
- `export function checkAttachmentRefs(refs: readonly AttachmentRef[]): void`
  — throws `InvalidAttachmentError` unless: `AttachmentsSchema.safeParse(refs).success`,
  every `mimeType` ∈ `IMAGE_MIME_TYPES`, every `size ≤ MAX_IMAGE_BYTES`, ids
  distinct.
- `export const IMAGE_TOKEN_ESTIMATE = 1600;` (≈ a 1568-px image; rounds up,
  `token-counter.ts:6-7` contract).
- `export function attachmentLabel(ref): string` → `name` (control chars
  already excluded by schema, cut to 80 chars) else `mimeType`, then
  ` sha256:<first 12 of id>`.

`HeuristicTokenCounter.countMessages` (`token-counter.ts:38`): `+
IMAGE_TOKEN_ESTIMATE` per ref of a message.

**D5 — agent.**
- `SendOptions.attachments?: readonly AttachmentRef[]` (`session.ts:32`).
- `Session.send` (`session.ts:132`): after the skill check, `const refs =
  opts.attachments ?? []; if (refs.length > 0) checkAttachmentRefs(refs);`
  (throws BEFORE anything is pushed). Then
  `const pushed = text !== "" || refs.length > 0;` and push
  `{ role: "user", content: text, ...(refs.length > 0 ? { attachments: [...refs] } : {}) }`
  when `pushed`; pass `userMessage: pushed` (was `text !== ""`, `:150`).
  The skill rule stays: a skill with empty text still rejects.
- `AgentConfig.attachments?: AttachmentSource` (`agent.ts:485`). Every
  `ChatRequest` the agent builds gets
  `...(this.config.attachments ? { attachments: this.config.attachments } : {})`:
  the loop request (`agent.ts:1178`), the step-limit final request (`:1477`),
  the context count (`:1597`). Nothing wires a source yet (2b does).
- `compact.ts` `renderMessage` (`:25-35`): append
  ` [image: ${attachmentLabel(ref)}]` per ref, so the summary knows an image
  existed. Compaction and `context_reset` keep NO images (owner Q6 = (a)).

**D6 — providers.** New `packages/providers/src/images.ts` (exported from
`index.ts`), pure except for `source.read`:

```ts
export const MAX_INLINE_IMAGES = 5;                       // owner Q4 (last K)
export type ImagePart = { readonly kind: "image"; readonly mimeType: ImageMimeType; readonly base64: string };
export type TextPart = { readonly kind: "text"; readonly text: string };
export type ResolvedImages = ReadonlyMap<string, string>;  // id → base64, ONLY verified bytes
/** Read the last `keep` distinct image refs of USER messages (newest first walk), verify, encode. */
export async function resolveImages(req: ChatRequest, keep = MAX_INLINE_IMAGES): Promise<ResolvedImages>;
/** A user message's parts, images first (D10), then its text if non-empty. */
export function userParts(m: ChatMessage, images: ResolvedImages, vision: boolean, inlined: ReadonlySet<string>): (ImagePart | TextPart)[];
/** Placeholder lines for refs on a NON-user message (never inlined). */
export function strayRefsText(m: ChatMessage): string;
```

- `resolveImages`: no `req.attachments` → empty map. For each selected ref:
  `bytes = await source.read(ref, req.signal)`; `null` → skip; keep only if
  `bytes.length === ref.size` AND `createHash("sha256").update(bytes).digest("hex") === ref.id`;
  base64 via `Buffer.from(bytes).toString("base64")`. Each distinct id read
  ONCE. A throwing source propagates (the stream rejects before `fetch`).
  Refs whose `mimeType ∉ IMAGE_MIME_TYPES` are never read.
- `inlined` = the ids `resolveImages` SELECTED (selection is a separate pure
  `selectInlineIds(messages, keep): Set<string>`, so `userParts` can tell
  "older" from "unavailable").
- Placeholder texts (exact; `L` = `attachmentLabel(ref)`), in the ref's slot:
  | Case | Text |
  |---|---|
  | `vision === false` | `[image omitted: this model does not take images — L]` |
  | mime not in `IMAGE_MIME_TYPES` | `[image omitted: unsupported type <mime> — L]` |
  | not in `inlined` | `[image omitted: only the last 5 images are sent — L]` |
  | selected, not in map | `[image unavailable — L]` |
  | ref on a non-user message | same "unavailable" text, appended to `content` after `\n` (`strayRefsText`) |
- Provider option `images?: boolean` on `AnthropicProviderConfig`
  (default **true**), `OpenAIProviderConfig` (default **false**) and
  `CreateModelProviderOptions` (passed through in `select-provider.ts:57-63`).
  `vision = config.images ?? default`. When `vision === false`,
  `resolveImages` is NOT called (no reads).
- Both providers: `stream()` and `countTokens()` compute
  `const images = vision ? await resolveImages(request) : EMPTY;` then call the
  sync builder with `{ images, vision }` as a new optional LAST parameter
  (default `{ images: EMPTY, vision: true }` so existing test calls compile).
- Anthropic `buildPayload` (`:360`): a `user` message with
  `hasAttachments` → `content: parts.map(p => p.kind === "image"
  ? { type: "image", source: { type: "base64", media_type: p.mimeType, data: p.base64 } }
  : { type: "text", text: p.text })` — never dropped even when `content === ""`.
  Tool-result merge guard: keep a local `const toolTurns = new Set<object>()`
  of the user messages created FOR tool results; merge into `prev` only if
  `toolTurns.has(prev)` (was "any user message with array content", `:379`).
  Non-user with refs: `content + strayRefsText(m)`.
- OpenAI `toWireMessage` (`:292`): user with refs → `content: parts.map(p =>
  p.kind === "image" ? { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.base64}` } }
  : { type: "text", text: p.text })`. Non-user with refs: `content + strayRefsText(m)`.

**D7 — daemon.**
- `proxy-model.ts` `toWireRequest` (`:59-72`): add
  `...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments.map((a) => ({ id: a.id, mimeType: a.mimeType, size: a.size, ...(a.name !== undefined ? { name: a.name } : {}) })) } : {})`.
  The pod sends refs only — never bytes (AGENTS §7).
- `session-log.ts` emitter: `:106` `type: replaceEntryType(message)`; `:115`
  and `:291` `type: appendEntryType(message)`; `replayFromBase` (`:341-342`)
  handles the media types (use `isAppendEntry`).
- `session-log-file.ts`: `laxEntry` (`:142`) — `case "media_message":` with
  `"message"`, `case "media_replace":` with `"replace"`; owes check (`:291`)
  `!isAppendEntry(entry)`; `segmentFromMessages` (`:514`)
  `type: appendEntryType(message)`.

**D8 — client.** `session-log-reader.ts`: owes check (`:156`)
`!isAppendEntry(e)`; `case "message":` (`:173`) also `case "media_message":`.
`remote-client.ts` unchanged: the pod's refs reach the laptop provider with no
`attachments` source → placeholders, no laptop read (2b adds the scoped one).

Not changed (documented limits): `hosted-session.ts` still refuses image
prompts (`assertTextOnly`) — 2b. `tui` — 3b. Hooks' `new_messages`
(`hooks.ts:719`) stay `{role, content}`. Sub-agents get text (`subagent.ts:434`).
Title input uses text (`session-title.ts:64`): an image-only first message
gives `firstUser: ""`, the reply still names it.

### Files (dependency order)

1. `packages/protocol/src/attachment.ts` (new) · `packages/protocol/src/index.ts`
2. `packages/protocol/src/session.ts` (`ChatMessageSchema`) · `packages/protocol/src/model.ts` (`WireChatMessageSchema`)
3. `packages/protocol/src/session-log.ts` (types, critical table, helpers, `projectEntry`, `canonicalMessage`)
4. `packages/protocol/src/version.ts` (23) · tests pinning 22 · `packages/protocol/schema/protocol.json` (`bun run schema:export`)
5. `packages/core/src/model.ts` · `packages/core/src/attachments.ts` (new) · `packages/core/src/index.ts` · `packages/core/src/token-counter.ts`
6. `packages/providers/src/images.ts` (new) · `packages/providers/src/index.ts` · `anthropic-provider.ts` · `openai-provider.ts` · `select-provider.ts`
7. `packages/agent/src/session.ts` · `packages/agent/src/agent.ts` · `packages/agent/src/compact.ts`
8. `packages/daemon/src/proxy-model.ts` · `packages/daemon/src/session-log.ts` · `packages/daemon/src/session-log-file.ts`
9. `packages/client/src/session-log-reader.ts`

No `cli`, no `tui`, no `config` change.

### Failure modes

| Mode | What happens | Converges how | Pinned by |
|---|---|---|---|
| Silent drop at a mapper (*r2*–*r6*) | the reason for the task | D1, D6, D7; the 7-site list | T1, T6, T7, T8, T9, T13 |
| **Version skew**, older peer/pod (`attach` can reuse an older injected binary) | an older peer would strip refs | bump 23 → `VersionMismatch` at `initialize` before any session traffic | T2 (version pin) + existing `version-mismatch.test.ts` |
| Older build reads a `<uid>.jsonl` with images (laptop or `serve`) | unknown critical `media_message` | whole file refused loudly, file left untouched (existing path); text-only sessions still load | T4 |
| Checkpoint drift with images | refs outside the digest would hide divergence | `canonicalMessage` includes refs when present; unchanged otherwise | T2 (literal pin) |
| Model without vision | `images: false` (openai default) | placeholder text per ref, no reads; turn runs. Refusing up-front is 2b/3b (owner Q5) | T8, T9 |
| Bytes missing (no source — the only state until 2b —, resume, pod gone) | — | `[image unavailable — L]`; the session never poisons (history resent every round) | T8, T9 |
| Bytes wrong (corrupt store, a pod answering other bytes in 2b) | — | sha256 + size checked on every resolve → unavailable placeholder | T8 |
| Transient read error / abort | source throws | stream rejects BEFORE `fetch`; history already holds the refs → retry works | T8 (fetch spy not called) |
| HEIC / unknown type in a ref | schema accepts (free string) | never read; `unsupported type` placeholder. Entry points refuse it (`checkAttachmentRefs`; TUI in 3a) | T1, T8, T10 |
| Huge / too many | `MAX_IMAGE_BYTES`, `MAX_ATTACHMENTS_PER_MESSAGE` refused at entry and by schema; only last 5 inlined per request | — | T1, T8, T10 |
| Pod's untrusted output (2b onward; refs on any role, any ids) | laptop provider has no source in this task → nothing read; non-user refs → placeholder line; a malformed ref → strip parse fails → `InvalidParams` on that `model/stream` | loud for malformed, inert otherwise | T7, T8 |
| Image-only prompt | was read as continuation (`session.ts:144`) | pushed when refs non-empty; `userMessage: true` | T10 |
| Invalid ref at `Session.send` | — | `InvalidAttachmentError` before any push; history unchanged | T10 |
| Tool result merged into a multimodal user turn (`anthropic :379`) | — | merge only into tool-built turns | T8 |
| Compaction / `context_reset` | images dropped from the new history | summary transcript carries `[image: L]`; owner Q6 | T12 |
| Context-usage stamp / repair on an image message | spreads keep refs (`agent.ts:1567`, `history-validity.ts:116,181`) | — | T11 |
| Resume (`--resume`, `serve` reload, `/clear` fork) | refs load from the log (fork: `segmentFromMessages` emits media types) | bytes come with 4 (`attachments-durable`); until then placeholder | T4, T5 |
| Sub-agents | parent images not forwarded (text prompt by contract) | documented | — |

### Tests

Property: **the verified bytes of every referenced image reach the provider's
HTTP body, images-before-text, on every path (worker/serve provider and the
pod tunnel); an image that cannot be sent reaches it as a visible placeholder,
never as nothing; and the refs survive the log round trip, refusing older
builds loudly.** "Schema accepts the field" alone is too weak.

No `App` frame test in this sub-task: nothing user-visible changes (the daemon
still refuses image prompts). 3b carries the frame tests (typing/pasting a
path → chip → `[image: name]` row).

Write each test first, show it RED on this branch's base, then implement.

| # | File | Asserts | Red because |
|---|---|---|---|
| T1 | `protocol/test/attachment.test.ts` (new) | `ChatMessageSchema` and `WireChatMessageSchema` keep `attachments` deep-equal; reject bad id, size 0, `[]`, 6 refs, `text/plain`, a control char in `name`; accept `image/heic` (free string) | stripped (*r2*, *r3*) |
| T2 | `protocol/test/session-log.test.ts` | `LOG_ENTRY_CRITICAL.media_message/media_replace === true`; `projectEntry` folds both; `canonicalMessage` of a no-ref message equals a pinned literal string computed on the base; with refs it differs; `PROTOCOL_VERSION === 23` | types absent |
| T3 | `daemon/test/session-log.test.ts` | `commit` of a user message with refs emits `{type:"media_message", critical:true}` with refs; changing it in place emits `media_replace`; a text message still `message`; `replayFromBase` round-trips refs | emitter writes `message` |
| T4 | `daemon/test/session-log-file.test.ts` + `session-log-store.test.ts` | a file `base(count 2)` + `media_message` + `message` loads with refs deep-equal; `segmentFromMessages` uses the media type; the store save→load round-trips refs; a file whose media entry is renamed to an unknown critical type is refused and left byte-identical | refs stripped / unknown type |
| T5 | `client/test/session-log-reader.test.ts` | a page `base(count 1)` + `media_message` + `checkpoint` (digest from the daemon's `projectionDigest`) projects refs and flags NO drift | "base owes 1 messages, got media_message" |
| T6 | `daemon/test/proxy-model.test.ts` | the batch AND chunked wire requests carry `attachments` deep-equal | *r5* |
| T7 | `client/test/model-stream-attachments.test.ts` (new; copy `model-stream-stop-reason.test.ts`) | real `RemoteClient` serving `model/stream` and `model/streamChunked` with a fake laptop provider: `request.messages[i].attachments` deep-equal; `request.attachments === undefined` (a pod's refs read nothing on the laptop) | stripped (*r3*) |
| T8 | `providers/test/anthropic-provider.test.ts` (injected `fetch` body) | 2 refs + text → `[image, image, text]`, `data` = base64 of the source bytes; `content:""` + ref → images only, message present; source `null` → unavailable placeholder; sha mismatch → placeholder; size mismatch → placeholder; `images:false` → no-vision placeholder and `read` never called; 6 refs across turns → oldest gets "only the last 5" text; `image/heic` → unsupported, never read; tool msg after a multimodal user msg → separate user turn; ref on an assistant msg → placeholder line; `read` once per distinct id; throwing source → stream rejects, fetch spy NOT called; `countTokens` body carries the same image blocks | no image blocks (*r6*) |
| T9 | `providers/test/openai-provider.test.ts` | same core cases with `image_url` data URLs; default (no `images`) → no-vision placeholder, no reads | `content` is a string |
| T10 | `agent/test/session.test.ts` | `send("", s, {attachments:[ref]})` appends `{role:"user", content:"", attachments:[ref]}` and runs a model round; `image/heic`, oversize, 6 refs, duplicate id → `InvalidAttachmentError`, history length unchanged, model never called; `send("hi")` message has no `attachments` key | continuation path |
| T11 | `agent/test/context-awareness-loop.test.ts` | with `AgentConfig.attachments = src`, the loop request, the step-limit final request and the `countTokens` request all carry `attachments === src`; after a context-usage stamp the stored user message still has its refs | field absent |
| T12 | `core/test/token-counter.test.ts`, `agent/test/compact.test.ts` | count(text+1 ref) = count(text) + 1600; the summariser transcript contains `[image: cat.png sha256:…]` | ignored |
| T13 | `daemon/test/integration.test.ts` | pod shape: real `Connection` + `RemoteClient`, daemon model = `ProxyModelProvider` → fake laptop provider; `session/open{messages}` seeded with a ref message; a prompt turn → the laptop provider's `ChatRequest.messages` holds the ref deep-equal; `session/log` returns it as `media_message` | stripped at seed (*r2*) |

Mutations (each must turn the named tests red; revert after):
- drop `attachments` in `toWireRequest` → T6, T13
- remove `attachments` from `WireChatMessageSchema` → T1, T7
- emitter uses `"message"` for every message → T3, T4
- remove the media cases from `projectEntry` → T2, T4, T5
- make `canonicalMessage` always append the element → T2 (literal pin)
- skip the sha256 check → T8 mismatch case
- ignore `vision === false` → T8, T9
- revert `Session.send` to `text !== ""` → T10
- revert the tool-merge guard → T8 merge case
- drop `attachments` from one agent `ChatRequest` site → T11

Gate before done: `bun run check` (typecheck → lint → test), lint baseline
clean (AGENTS §4, §6).

### Owner questions

Recommendation first in each.

1. **Protocol bump.** (a) **Bump to 23 in this task** — required anyway by a
   new critical log type, and closes the strip-silently skew with an older pod;
   2a/2b then add methods/fields for free. (b) No bump; rely on capability
   negotiation — leaves the older-peer silent strip open. (c) Bump in 2b with
   the first producer — but the log types land here.
2. **Persisted shape (a `critical: true` decision).** (a) **Two new critical
   types `media_message` / `media_replace`** — older builds refuse only
   sessions that contain images. (b) Bump the log header `schemaVersion` —
   older builds refuse every file a new build writes. (c) A plain field on
   `message` — older builds half-load (violates AGENTS §7).
3. **How the TUI detects a dropped path (3a/3b).** (a) **A paste whose whole
   content is 1..N image paths (escaped spaces, quotes, `file://`, `~`)
   becomes chips; same at submit when the whole input is only image paths
   (terminals that don't bracket a drop); plus `/attach <path>`.** A path
   inside prose stays text (the user may mean the workspace file). (b) Any
   token that is an existing image path, anywhere in the input. (c) Only
   `/attach`.
4. **Caps and downscale.** (a) **No client downscale in v1; ≤ 3.75 MiB raw per
   image (≤ 5 MiB base64), ≤ 5 per message, last K = 5 inlined per request;
   bigger → a clear "shrink it" error; downscale/HEIC convert as sub-task 6.**
   (b) Client downscale to 1568 px now (needs `sips`/ImageMagick: platform
   deps). (c) No caps, let the provider 4xx.
5. **Model without vision.** (a) **`model.images` (default anthropic `true`,
   openai `false`); TUI refuses before uploading and the daemon refuses the
   prompt (2b/3b); the provider placeholder here is the backstop.** (b)
   Placeholder only, the turn runs and the model says it can't see. (c) Send
   anyway.
6. **Images and compaction / `context_reset`.** (a) **They do not survive; the
   summary transcript gets `[image: name]`.** (b) Re-attach the last K images
   to the first post-compaction user message. (c) Keep all.
7. **Parallel branches.** (a) **Allow 3a (new TUI files only) to run beside
   1/2a/2b**; everything else strictly sequential. (b) Strictly one branch at
   a time (AGENTS §10 as written).

## Execution

*(empty — awaiting owner approval)*

## Review

*(empty)*
