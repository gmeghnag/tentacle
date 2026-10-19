# feat/session-wire-classes — event classes per frame, unknown-event tolerance, required `seq`, wire hygiene, non-text reject

> **Status:** done — reviewed (APPROVE-WITH-NITS), nits fixed, merged to `main` (2026-10-20)
> **Branch:** `feat/session-wire-classes`
> **Type:** feat · **Size:** M (resized from S at Review: 3 packages + protocol, ~10 source files) · **Blast:** load-bearing (every client's decode path; protocol version) · **Suited:** strong model executes; mandatory fresh-context Review (AGENTS §7: protocol + TUI-over-RPC session path)

Child **3a** of `docs/eval/session-event-stream.md` (parent plan of 3a → 3b →
3c), itself child 3 of `docs/eval/session-reattach.md`. The eval keeps the
whole plan for 3a–3c. This doc is 3a's plan as corrected against `main`
@ `c03d394` and supersedes the eval's §3a where they differ (see "Drift from the
eval's §3a").

## Context

*— claude-opus-5-5, 2026-10-19*

Protocol v2 needs a `session/update` stream a client can rely on across daemon
versions and replays. 3a lays the frame-level groundwork the later children
build on. Owner decision **E** (parent §14): the class travels in every frame,
`seq` is required, and the union has a catch-all member, so an unknown
*display* event is skipped while its `seq` still counts. A client must fail
**loudly** on an unknown *mandatory* event. Parent point 18 adds that a
non-text content block must be **rejected explicitly** until attachments land.

Today:
- An unknown update type fails schema validation for the **whole frame**. The
  peer drops it with `onError` (`transport/src/peer.ts:360-363`), and its `seq`
  is lost with it, so a later replay would see a gap: the resync loop that E
  calls out.
- `seq` is optional on the wire (`protocol/src/updates.ts:105`).
- A non-text prompt block is silently dropped (`daemon/src/mapping.ts:14-19`):
  the model answers as if there were no image.
- The exported JSON Schema has no notion of event class. Swift codegen on the
  D7 shape (`oneOf` + `discriminator`) **throws** on an unknown discriminant
  (`docs/feat/protocol-schema-export.md` OQ-4, re-confirmed below).

**Repro** (2026-10-19, `main` @ `c03d394`, `.tentacle/tmp/session-event-stream-3a/missing.ts`):

```ts
import { SessionUpdateParamsSchema } from "@tentacle/protocol";
import { contentToText } from "../../../packages/daemon/src/mapping.ts";
const unknown = SessionUpdateParamsSchema.safeParse({ sessionId: "s", seq: 7, update: { type: "progress", pct: 3 } });
console.log("unknown display frame accepted:", unknown.success);
const noSeq = SessionUpdateParamsSchema.safeParse({ sessionId: "s", update: { type: "steer", text: "x" } });
console.log("frame without seq accepted:", noSeq.success);
const text = contentToText([{ type: "text", text: "what is in this photo?" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
console.log("model receives:", JSON.stringify(text));
```
```
unknown display frame accepted: false
frame without seq accepted: true
model receives: "what is in this photo?"
```

## Implementation

*— claude-opus-5-5, 2026-10-19 (approved by the owner 2026-10-19: parent decisions A–G/D1–D10, plus the catch-all shape G and three separate feat docs decided in-session)*

### Drift from the eval's §3a (verified, owner-approved)

1. **The catch-all shape in the eval is wrong against the merged exporter.**
   The eval proposed `update: z.union([SessionUpdateSchema, UnknownUpdateSchema])`
   and claimed "the export stays representable". It does not:
   - `json-schema.ts` throws `untagged union of non-scalars` for any plain union
     of objects outside `UNTAGGED_ALLOWED`.
   - Every flat or `not`-based catch-all breaks either Swift codegen or strict
     JSON Schema validation (experiment below).

   Adopted shape: **G**, a named
   `SessionUpdateOrUnknown = anyOf[SessionUpdate, UnknownSessionUpdate]`. The
   known union stays the D7 tagged `oneOf`, unchanged, and the wrapper goes
   into `UNTAGGED_ALLOWED`. Cost, accepted: a *known but malformed* event is
   valid against the JSON Schema, because it matches the catch-all. "Known
   type + fails its member ⇒ loud error" is therefore a **client rule**
   (`classifyUpdate` in TS), documented in the schema's description.
2. **`seq` becomes required here** (decision E). The eval only showed it in the
   shared vocabulary, not in §3a's steps.
3. **Annotation name `x-event-class`**: the name `protocol-schema-export`
   reserved for this child (OQ-4). The eval's `x-tentacle-class` is dropped.
4. **The client's per-session handler must be able to fail the turn.** Today it
   accepts only updates (`client/src/remote-client.ts:180`).
5. **The daemon "no `null` in emitted frames" test is dropped.** `ToolCall.rawInput`
   is an opaque `z.unknown()` (`updates.ts:35`) whose model-produced JSON can
   legitimately contain `null`. The rule applies to typed protocol fields, and
   the schema walk (Tests 3) pins exactly those.

### Load-bearing assumption

*A schema shape exists that the exporter accepts, codegen turns into a tagged
enum for known events without throwing on unknown ones, and a strict JSON Schema
validator accepts for every valid frame.* **Proven** by the experiment below:
shape G is the only one of six that holds on all three.

Experiment (`.tentacle/tmp/session-event-stream-3a/`, 2026-10-19,
`swift-openapi-generator` 1.9.0 built in
`.tentacle/tmp/protocol-schema-export-impl/sog`, Swift 6.3.2, `ajv` 8.17.1
draft 2020-12). Three known members (two with **identical** fields, to prove
the `type` const is enforced) plus a catch-all, in six shapes. `gen.ts` (A–C):

```ts
import { mkdirSync, writeFileSync } from "node:fs";
const obj = (tag: string, props: Record<string, unknown>) => ({
  type: "object", additionalProperties: true,
  properties: { type: { type: "string", const: tag }, ...props },
  required: ["type", ...Object.keys(props)],
});
const known = {
  AgentMessageChunk: obj("agent_message_chunk", { content: { type: "string" } }),
  AgentThoughtChunk: obj("agent_thought_chunk", { content: { type: "string" } }),
  Steer: obj("steer", { text: { type: "string" } }),
};
const Unknown = { type: "object", additionalProperties: true, properties: { type: { type: "string" } }, required: ["type"] };
const refs = Object.keys(known).map((k) => ({ $ref: `#/components/schemas/${k}` }));
const mapping = { agent_message_chunk: "#/components/schemas/AgentMessageChunk", agent_thought_chunk: "#/components/schemas/AgentThoughtChunk", steer: "#/components/schemas/Steer" };
const variants: Record<string, unknown> = {
  A_oneOf_disc: { oneOf: refs, discriminator: { propertyName: "type", mapping } },
  B_oneOf_catchall: { oneOf: [...refs, { $ref: "#/components/schemas/UnknownUpdate" }] },
  C_oneOf_disc_catchall: { oneOf: [...refs, { $ref: "#/components/schemas/UnknownUpdate" }], discriminator: { propertyName: "type", mapping } },
};
for (const [name, union] of Object.entries(variants)) {
  const schemas = { ...known, UnknownUpdate: Unknown, SessionUpdate: union,
    SessionUpdateParams: { type: "object", additionalProperties: false, required: ["sessionId", "seq", "update"],
      properties: { sessionId: { type: "string" }, seq: { type: "integer" }, mandatory: { type: "boolean", const: true }, update: { $ref: "#/components/schemas/SessionUpdate" } } } };
  mkdirSync(`gen/${name}`, { recursive: true });
  writeFileSync(`gen/${name}/openapi.json`, JSON.stringify({ openapi: "3.1.0", info: { title: "t", version: "1" }, paths: {}, components: { schemas } }, null, 2));
  writeFileSync(`gen/${name}/openapi-generator-config.yaml`, "generate:\n  - types\naccessModifier: public\nnamingStrategy: idiomatic\n");
}
```

`gen2.ts` derives D (flat catch-all, `type: {not: {enum: knownTags}}`) and E
(the same catch-all nested: `oneOf[SessionUpdate(oneOf+discriminator), UnknownSessionUpdate]`).
F is E with the `not` moved to object level. **G** is E with no `not` and the
wrapper as `anyOf`:

```ts
// G, from E's file
const s = d.components.schemas; s.UnknownSessionUpdate.properties.type = { type: "string" };
s.SessionUpdateOrUnknown = { anyOf: s.SessionUpdateOrUnknown.oneOf };
```

Swift driver (`main.swift`, built against the generated `Types.swift` with
local `swift-openapi-runtime`):

```swift
import Foundation
let cases: [(String, String)] = [
  ("message", #"{"sessionId":"s","seq":1,"update":{"type":"agent_message_chunk","content":"hi"}}"#),
  ("thought", #"{"sessionId":"s","seq":2,"update":{"type":"agent_thought_chunk","content":"hm"}}"#),
  ("steer", #"{"sessionId":"s","seq":3,"update":{"type":"steer","text":"x"}}"#),
  ("unknown display", #"{"sessionId":"s","seq":4,"update":{"type":"progress","pct":3}}"#),
  ("unknown mandatory", #"{"sessionId":"s","seq":5,"mandatory":true,"update":{"type":"permission_request","id":"p"}}"#),
  ("malformed steer", #"{"sessionId":"s","seq":6,"update":{"type":"steer"}}"#),
]
for (label, json) in cases {
  do {
    let p = try JSONDecoder().decode(Components.Schemas.SessionUpdateParams.self, from: Data(json.utf8))
    print("\(label.padding(toLength: 18, withPad: " ", startingAt: 0)) seq=\(p.seq) mandatory=\(String(describing: p.mandatory)) -> \(String(describing: p.update).prefix(110))")
  } catch { print("\(label.padding(toLength: 18, withPad: " ", startingAt: 0)) THROWS \(String(describing: error).prefix(90))") }
}
```

`ajv.ts` compiles each variant's `$defs` (with the OpenAPI-only `discriminator`
keyword removed) under Ajv2020 and validates the same frames.

Results (abridged, verbatim lines):

```
=== A_oneOf_disc (today's D7 shape)
message            seq=1 mandatory=nil -> agentMessageChunk(...)
thought            seq=2 mandatory=nil -> agentThoughtChunk(...)
unknown display    THROWS DecodingError.keyNotFound: Key 'type' not found in keyed decoding container. Path: update.
unknown mandatory  THROWS DecodingError.keyNotFound: Key 'type' not found in keyed decoding container. Path: update.
=== B_oneOf_catchall
unknown display    seq=4 mandatory=nil -> UnknownUpdate(... _type: "progress" ...)
== B_oneOf_catchall: message=INVALID, thought=INVALID, unknown display=valid, unknown mandatory=valid, malformed steer=valid
=== C_oneOf_disc_catchall
unknown display    THROWS DecodingError.keyNotFound: Key 'type' not found ...
== D_flat_exclusive / E_nested_exclusive: message=valid, thought=valid, unknown display=valid, unknown mandatory=valid, malformed steer=INVALID
warning: Schema "not ()" is not supported, reason: "schema type", skipping [context: foundIn=Components.Schemas.UnknownSessionUpdate (...)/type]
unknown display    seq=4 mandatory=nil -> UnknownSessionUpdate(Run.Components.Schemas.UnknownSessionUpdate(additionalProperties: ...   <- `type` lost
=== F_nested_objnot
warning: Schema "not ()" is not supported ... skipping [context: foundIn=Components.Schemas.SessionUpdateParams (...)/update]   <- whole field dropped; build fails
=== G_nested_anyof
== G_nested_anyof: message=valid, thought=valid, unknown display=valid, unknown mandatory=valid, malformed steer=valid
public struct SessionUpdateOrUnknown { public var value1: Components.Schemas.SessionUpdate?; public var value2: Components.Schemas.UnknownSessionUpdate? }
message            seq=1 mandatory=nil -> SessionUpdateOrUnknown(value1: Optional(Run.Components.Schemas.SessionUpdate.agentMessageChunk(...
thought            seq=2 mandatory=nil -> SessionUpdateOrUnknown(value1: Optional(Run.Components.Schemas.SessionUpdate.agentThoughtChunk(...
steer              seq=3 mandatory=nil -> SessionUpdateOrUnknown(value1: Optional(Run.Components.Schemas.SessionUpdate.steer(...
unknown display    seq=4 mandatory=nil -> SessionUpdateOrUnknown(value1: nil, value2: Optional(Run.Components.Schemas.UnknownSessionUpdate(_type: "progr...
unknown mandatory  seq=5 mandatory=Optional(true) -> SessionUpdateOrUnknown(value1: nil, value2: Optional(...UnknownSessionUpdate(_type: "permi...
malformed steer    seq=6 mandatory=nil -> SessionUpdateOrUnknown(value1: nil, value2: Optional(...UnknownSessionUpdate(_type: "steer...
```

Reading G:
- Known events decode into the D7 tagged enum (`value1`). The `type` const
  is enforced: `thought` is not mis-decoded as `message`.
- Unknown events decode into `value2` with `type` preserved, and the
  envelope's `seq`/`mandatory` are readable.
- `ajv` accepts every valid frame.
- A Swift client's rule:
  - `value1` → handle;
  - otherwise known `type` → error (malformed);
  - otherwise `mandatory` → error ("update the app");
  - otherwise skip.

  This is the same rule as the TS `classifyUpdate`.

### Preconditions

- The peer validates every inbound notification against `NotificationSchemas`
  and drops a failing frame with `onError` (`transport/src/peer.ts:355-363`).
  `session/update` maps to `SessionUpdateParamsSchema`
  (`protocol/src/methods.ts:83`).
- The client routes updates in one place,
  `RemoteClient`'s `onNotification` (`client/src/remote-client.ts:88-102`). It
  special-cases `background_exit` (`:94-100`), with a single per-session
  handler (`:67,180-186`). The only caller is `RemoteSession.send`
  (`client/src/remote-session.ts:72,93`).
- The daemon builds every frame in one place: `HostedSession.emit`
  (`daemon/src/hosted-session.ts:84-91`, `seq` always set). `replayFrom` reads
  `p.seq ?? 0` (`:81`).
- The prompt path is `Connection.prompt` → `hosted.prompt(params.content)`
  (`daemon/src/connection.ts:216-223`) → `contentToText`
  (`hosted-session.ts:102`). `PromptParamsSchema.content` is any
  `ContentBlock[]` with min 1 (`protocol/src/session.ts:91-96`).
- An `RpcError` thrown in a handler reaches the remote client with its code
  and message. Only non-`RpcError`s are redacted to "internal error"
  (`transport/src/peer.ts:333-345`).
- The exporter: plain unions of non-scalars throw unless listed in
  `UNTAGGED_ALLOWED` (`protocol/src/json-schema.ts:85-88,175-185`).
  Discriminated unions become `oneOf` + `discriminator` (`:174-203`). Strip
  objects export as `additionalProperties: true` (header comment, `:16`).
- `null` sites in the protocol: `BackgroundExit.exitCode` (`updates.ts:76`) and
  the JSON-RPC error response `id` (`jsonrpc.ts:93`). Nothing else
  (`rg "nullable|z.null" packages/protocol/src`).
- `PROTOCOL_VERSION = 1` (`protocol/src/version.ts`). The daemon refuses a
  mismatch at `initialize` (`daemon/src/connection.ts:184-188`).
- `AsyncQueue.fail` after close is a no-op, and so is `push` (`client/src/queue.ts:13-15,34-36`).
  A turn failed by a stream error therefore ignores the later `prompt`
  response.

### Design

**Protocol (`protocol/src/updates.ts`).**
- `export type UpdateClass = "display" | "mandatory"`, plus
  `export const UPDATE_CLASS: Readonly<Record<SessionUpdate["type"], UpdateClass>>`
  with every existing type set to `"display"`. A `Record` makes a new variant
  without a class a compile error. `permission-events` / 3b add the first
  mandatory ones.
- `export function isKnownUpdateType(type: string): type is SessionUpdate["type"]`
  is `Object.hasOwn(UPDATE_CLASS, type)`. **`hasOwn`, not `in`**: a frame
  with `type: "toString"` must not count as known.
- `UnknownSessionUpdateSchema = z.object({ type: z.string().min(1) })` (strip,
  so it exports open). Its `.describe()` carries the client rule.
- `SessionUpdateOrUnknownSchema = z.union([SessionUpdateSchema, UnknownSessionUpdateSchema])`.
  Order matters: zod returns the first match, so a valid known event parses
  as its member.
- `SessionUpdateParamsSchema`:
  - `seq: z.number().int().nonnegative()` (required);
  - `mandatory: z.literal(true).optional()` (omitted for display; never
    `false`, one encoding per state);
  - `update: SessionUpdateOrUnknownSchema`;
  - stays `.strict()`.
- `PROTOCOL_VERSION` 1 → 2.

**Exporter (`protocol/src/json-schema.ts`).**
- Add `"#/$defs/SessionUpdateOrUnknown"` to `UNTAGGED_ALLOWED`, with a comment
  pointing to this doc's experiment.
- `ProtocolSource` gains `updateClasses: Readonly<Record<string, string>>`
  (default `P.UPDATE_CLASS`). After `rewriteUnions`, every member `$def` of
  `SessionUpdate`'s discriminator mapping gets `"x-event-class": <class>`.
- The export throws if a mapping tag has no class, or if a class names a tag
  that is not in the mapping (loud, both directions).
- Regenerate `schema/protocol.json`.

**Daemon.**
- `daemon/src/mapping.ts`:
  - `toUpdateParams(sessionId, seq, update, classes = UPDATE_CLASS): SessionUpdateParams`,
    pure. It sets `mandatory: true` iff `classes[update.type] === "mandatory"`
    and omits it otherwise. The injectable `classes` makes the flag testable
    while every real type is display.
  - `assertTextOnly(content)` throws
    `RpcError(JsonRpcErrorCode.InvalidParams, "only text content is supported (got <type>); see docs/eval/attachments.md")`
    on the first non-text block.
- `hosted-session.ts`:
  - `emit` uses `toUpdateParams`;
  - `prompt` calls `assertTextOnly(content)` **before** the controller check,
    so a rejected prompt starts nothing, records nothing and does not hit
    `TurnInProgress`;
  - `replayFrom` drops `?? 0`.

**Client.**
- `client/src/mapping.ts`: `classifyUpdate(params: SessionUpdateParams): { kind: "update"; update: SessionUpdate } | { kind: "ignore" } | { kind: "error"; error: Error }`,
  pure. The cases, in order:
  1. `SessionUpdateSchema.safeParse(params.update)` succeeds → `update`.
  2. Otherwise, a known `type` (`isKnownUpdateType`) → `error`,
     "malformed `<type>` update".
  3. Otherwise `params.mandatory` → `error`, "unknown mandatory update
     `<type>`: the daemon is newer than this client, update tentacle".
  4. Otherwise → `ignore`.

  The re-parse is one small discriminated-union parse per frame, next to the
  `JSON.parse` the frame already paid for.
- `client/src/remote-client.ts`:
  - handlers become `SessionStreamHandler = { update(u: SessionUpdate): void; fail(e: Error): void }`;
  - `onNotification` classifies each frame:
    - `ignore` → return. Silence is the contract for unknown *display*
      events (parent §14). Logging them would spam `onError` with every
      frame from a newer daemon.
    - `error` → `onError(error)`, plus `handlers.get(sessionId)?.fail(error)`.
    - `update` → today's routing (`background_exit` → exit listeners, else
      `handler.update`).
- `client/src/remote-session.ts`:
  - `fail` → `queue.fail(error)` plus `client.cancel(id)`, so the daemon
    does not keep running a turn nobody can render (state converges: the
    turn ends cancelled daemon-side, failed client-side, loudly);
  - `update` → today's `updateToEvent` path.

**No change** to TUI/CLI rendering, the agent, `Connection`, or the transport.

### Files

Dependency order:
1. `packages/protocol/src/updates.ts`, `packages/protocol/src/version.ts`,
   `packages/protocol/src/json-schema.ts`, `packages/protocol/schema/protocol.json`
   (regenerated).
2. `packages/daemon/src/mapping.ts`, `packages/daemon/src/hosted-session.ts`.
3. `packages/client/src/mapping.ts`, `packages/client/src/remote-client.ts`,
   `packages/client/src/remote-session.ts`.
4. Tests: `packages/protocol/test/updates.test.ts`,
   `packages/protocol/test/json-schema.test.ts`, `packages/protocol/test/session.test.ts`
   (version literal, if it pins it), `packages/daemon/test/mapping.test.ts`,
   `packages/daemon/test/integration.test.ts`, `packages/client/test/mapping.test.ts`,
   `packages/client/test/remote.test.ts`.
5. Docs on this branch: `ARCHITECTURE.md` (schema section: the catch-all and
   the client rule) and this doc. `docs/eval/session-event-stream.md` §3a gets
   a pointer here, with the drift. `TODO.md` index line.

### Failure modes

- **Unknown display event (newer daemon)** → ignored, nothing logged, `seq`
  received. Seq tracking itself is `client-reattach`'s.
- **Unknown mandatory event** → `onError` and the in-flight turn fails
  loudly. The client also cancels it so the daemon does not run it
  unobserved. With no turn in flight → `onError` only.
- **Known type, malformed** (daemon bug or skew) → loud error, the same path
  as unknown mandatory. It is never rendered half-parsed and never ignored.
- **`type` is an `Object.prototype` key** (`"toString"`, `"__proto__"`) →
  treated as unknown (`hasOwn`), not as known.
- **Frame without `seq`** → schema reject at the peer, `onError`. This is
  breaking, so the version bump covers it.
- **`mandatory: false` on the wire** → schema reject: one encoding per state.
- **Prompt with an image/resource block** → `InvalidParams` with the block
  type. No turn starts, so the model is never called, and no
  `TurnInProgress` is masked.
- **Prompt mixing a text and an image block** → rejected whole, never
  partially run.
- **Version skew** (v1 client ↔ v2 daemon) → `VersionMismatch` at
  `initialize`, never a mid-stream decode error.
- **Exporter drift**: a new update variant without a class → compile error
  (`Record`). A class for a removed tag → export throws. The wrapper
  removed from `UNTAGGED_ALLOWED` → export throws.

### Tests

Red on `main` first for each, then green. Mutations listed must turn the named
test red.

1. **Protocol schema.** `SessionUpdateParamsSchema` must:
   - accept an unknown type, with and without `mandatory: true`;
   - reject a missing `seq` (red today) and `mandatory: false`;
   - keep parsing a valid known event as its member.

   `isKnownUpdateType("toString") === false`. Mutation: `in` instead of
   `hasOwn` → red.
2. **`classifyUpdate` table** (client): known valid → update; known
   malformed → error; unknown display → ignore; unknown mandatory → error;
   `type: "toString"` → ignore. Mutations, each → red: drop the mandatory
   check; drop the known-malformed check.
3. **Wire hygiene** (`json-schema.test.ts`): walk the exported document. The
   set of pointers carrying `type: "null"` must be **exactly**
   `{BackgroundExit.exitCode, the JSON-RPC error-response id}`. A test that
   adds `.nullable()` to a fake field must turn it red (fake `ProtocolSource`,
   as the existing tests do).
4. **Exporter.**
   - `SessionUpdateOrUnknown` is `anyOf` of the two `$ref`s;
   - `SessionUpdate` is still `oneOf` + `discriminator`;
   - every member has `x-event-class` equal to `UPDATE_CLASS`;
   - a fake source with a missing class throws, and so does one with an
     extra class;
   - removing the `UNTAGGED_ALLOWED` entry throws.

   Drift test regenerated.
5. **Daemon frame builder.** `toUpdateParams` sets `mandatory: true` iff the
   class table says so. Test it with an injected table (steer → mandatory),
   so the test is not vacuous while all real types are display, and with the
   real table (no frame carries the key). Integration: every frame of a full
   turn carries an integer `seq`, strictly increasing by 1.
6. **Non-text reject** (integration, `harness()`): `prompt` with
   `[text, image]` → `InvalidParams`, the message names `image`,
   `model.calls.length === 0`, and a following text prompt runs normally (no
   leaked controller). Red today: the turn runs with the image stripped.
7. **Client end to end** (`remote.test.ts`, raw `RpcPeer` daemon as in the
   existing tests):
   - an unknown display frame mid-turn is ignored and the turn completes;
   - an unknown mandatory frame mid-turn fails `send` with the "daemon is
     newer" error, `onError` gets it, and the fake daemon receives
     `session/cancel`;
   - a malformed known frame fails the turn.

   Red today: the peer drops the unknown frame (`onError`
   "invalid params"), and the mandatory case **hangs** instead of failing.
   Guard it with a timeout.
8. **Codegen validation** (manual, pasted in Execution): run
   `swift-openapi-generator` on the real regenerated `protocol.json`, as
   OpenAPI components, plus the G driver extended to the real envelope. Check
   that `x-event-class` does not break generation and that known/unknown/
   mandatory frames decode as in the experiment.

Gate: `bun run check` green (typecheck, lint clean baseline, full tests with
only the opt-in live-k8s skip).

## Execution

*— claude-opus-5-5, 2026-10-19*

Order followed: protocol → exporter → daemon → client. For each slice the
tests were written first and shown red on the unchanged code, then
implemented.

As built:
- **Protocol** (`protocol/src/updates.ts`):
  - `UpdateClass`, `UPDATE_CLASS`, `isKnownUpdateType` (`Object.hasOwn`);
  - `UnknownSessionUpdateSchema` (its description carries the client rule);
  - `SessionUpdateOrUnknownSchema`;
  - `SessionUpdateParamsSchema` with required `seq`,
    `mandatory: z.literal(true).optional()` and the wrapper;
  - `PROTOCOL_VERSION` 1 → 2.
- **Exporter** (`protocol/src/json-schema.ts`):
  - the `UNTAGGED_ALLOWED` entry;
  - `ProtocolSource.updateClasses` (default `P.UPDATE_CLASS`);
  - `annotateUpdateClasses`, which throws on a missing or an extra class;
  - `schema/protocol.json` regenerated.
- **Daemon**:
  - `mapping.ts`: `assertTextOnly` and `toUpdateParams` (injectable class
    table);
  - `hosted-session.ts`: `emit` uses `toUpdateParams`, `prompt` calls
    `assertTextOnly` before the busy check, and `replayFrom` drops `?? 0`.
- **Client**:
  - `mapping.ts`: `classifyUpdate`;
  - `remote-client.ts`: `SessionStreamHandler {update, fail}`, and
    `onNotification` classifies each frame (ignore / error → `onError` + fail /
    update → today's routing);
  - `remote-session.ts`: `fail` → `queue.fail` + `client.cancel(id)`.
- **Docs**: an `ARCHITECTURE.md` paragraph (frame classes, catch-all, the
  client rule, null sites); a 3a pointer and drift note in
  `docs/eval/session-event-stream.md`; the `TODO.md` index line.

**Drift from Implementation** (each one forced by the code, none changes the
design):
1. **The exporter's untagged-union allowlist was path-based**, and the guard
   also fires where the union is *used* (`#/$defs/SessionUpdateParams/properties/update`),
   not only at its `$def`. The two existing entries never hit this because
   nothing references them. The guard now allows by **schema identity** (the
   `_def`s of the named schemas listed in `UNTAGGED_ALLOWED`); the usage site
   is emitted as a `$ref` anyway. The error message still names the path.
   Mutation M7 shows that removing the entry still throws.
2. **New type `KnownSessionUpdateParams`** (protocol): `SessionUpdateParams`
   with `update: SessionUpdate`. With the catch-all, `SessionUpdateParams["update"]`
   no longer narrows on `type`, which is correct for a receiver. The emitter
   (daemon: `UpdateSink`, `toUpdateParams`, the replay buffer) and the daemon
   tests use the known-only type. It is a subtype, so the wire is unchanged.
3. **Version literal in a test not listed in Files**: `client/test/auth.test.ts`
   asserted `protocolVersion === 1`. It now uses `PROTOCOL_VERSION`, and so do
   the daemon integration `INIT` and handshake assertion. The raw fake peers in
   the `transport`/`cli` tests send `1` to peers that do not check it; they are
   unchanged.
4. **A vacuous assertion caught during red-before-green**: the class-annotation
   test first used `toEqual`. That passes on `main`, because `toEqual` treats
   an `undefined` property as absent. It is now `toStrictEqual` plus a
   non-empty check, and is shown red on `main`.
5. **The "display unknown event is skipped" client test was green on the branch
   before the client change**: the protocol change alone stops the peer
   dropping the frame, and `updateToEvent` returns `null` for an unknown type.
   On `main` the frame is dropped with `onError`. Mutation M6 (restore
   `main`'s `update: SessionUpdateSchema`) turns it red.

**Gate** (`bun run check`, after the mutation run restored the sources):
typecheck clean; `biome check .` clean (266 files, baseline 0/0); `bun test`
816 pass, 1 skip (the opt-in live-k8s), 0 fail, 817 tests across 95 files.

**Non-vacuity** (`.tentacle/tmp/session-event-stream-3a/mutate.py`): one
mutation at a time on the named test files, sources restored after each.

```
M1 hasOwn -> in: RED — 2 fail                    (isKnownUpdateType own-keys test; classifyUpdate "toString")
M2 drop mandatory check: RED — 2 fail            (classifyUpdate table; e2e mandatory fails the turn + cancels)
M3 drop known-malformed check: RED — 2 fail      (classifyUpdate table; e2e malformed fails the turn)
M4 never set mandatory: RED — 1 fail             (toUpdateParams with injected table)
M5 no non-text reject in prompt: RED — 1 fail    (integration: InvalidParams, model never called)
M6 no catch-all (main's union): RED — 5 fail     (protocol frame tests; e2e unknown display skipped / mandatory)
M7 catch-all not allowlisted: RED — 7 fail       (export throws: drift gate, agreement, union shape, …)
M8 no class annotation: RED — 4 fail             (drift; annotation; missing/extra class guards)
M9 fail without cancel: RED — 2 fail             (e2e mandatory + malformed: daemon receives session/cancel)
M10 seq optional again: RED — 1 fail             (seq is required)
```

Not covered by a test, on purpose: calling `assertTextOnly` *after* the busy
check. Both orders reject and record nothing; only the error code differs
while a turn runs. The order is pinned by a comment, not a test.

**Codegen validation (Tests 8)**, on the real regenerated `protocol.json` (2026-10-19,
`swift-openapi-generator` 1.9.0, Swift 6.3.2). `$defs` were wrapped as
OpenAPI 3.1 components, then the generated types were built and run with a
driver over real frames:

```
   1 warning: Schema "null" is not supported ... BackgroundExit/exitCode         (pre-existing)
   1 warning: Schema "null" is not supported ... JsonRpcErrorResponse/id         (pre-existing)
message            seq=1 mandatory=nil -> SessionUpdateOrUnknown(value1: Optional(...SessionUpdate.agentMessageChunk(...
thought            seq=2 mandatory=nil -> SessionUpdateOrUnknown(value1: Optional(...SessionUpdate.agentThoughtChunk(...
bg exit null       seq=3 mandatory=nil -> SessionUpdateOrUnknown(value1: Optional(...SessionUpdate.backgroundExit(...
unknown display    seq=4 mandatory=nil -> SessionUpdateOrUnknown(value1: nil, value2: Optional(...UnknownSessionUpdate(_type: "progress", ...
unknown mandatory  seq=5 mandatory=Optional(true) -> SessionUpdateOrUnknown(value1: nil, value2: Optional(...UnknownSessionUpdate(_type: "permission_requ...
malformed chunk    seq=6 mandatory=nil -> SessionUpdateOrUnknown(value1: nil, value2: Optional(...UnknownSessionUpdate(_type: "agent_message_c...
no seq             THROWS DecodingError.keyNotFound: Key 'seq' not found in keyed decoding container. ...
```

`x-event-class` produces no warning. Known events decode into the tagged enum
and unknown ones into the catch-all with `type` preserved. A frame without
`seq` is refused.

## Review

*— claude-opus-5-5, 2026-10-20*

**Verdict: APPROVE-WITH-NITS.** The design holds and every new test is shown
non-vacuous. Nothing below blocks the merge. Findings 2–3 are pre-existing gaps
that 3b (the first mandatory event) must close; they are not defects of 3a.

**Reviewer / executor:** reviewed by `claude-opus-5-5` in a fresh context. The
executor was **also `claude-opus-5-5`**: same model, so shared blind spots are
possible. A load-bearing task would ideally get a different-model pass
(AGENTS §10).

### Findings

1. **Orphaned JSDoc** (nit, code): `client/src/remote-client.ts:42-43`. The
   comment `/** A background-job exit surfaced by the daemon, outside any turn. */`
   now sits directly above the new `SessionStreamHandler` doc, so
   `BackgroundExitNotice` (`:49`) lost its comment. Move the new interface
   below `BackgroundExitNotice`, or move the comment back onto it.
2. **An envelope-invalid frame never reaches the class rule** (pre-existing,
   carry into 3b). A frame that fails `SessionUpdateParamsSchema` is dropped at
   the peer (`transport/src/peer.ts:360-363`), so `classifyUpdate` and
   `handler.fail` never run. That covers: no `seq`, `type: ""`, an `update`
   that is not an object, `mandatory: false`. Reviewer trace case 4: a frame
   with `mandatory: true` but no `seq` arrives mid-turn. The result is
   `onError` "invalid params" and the turn **keeps waiting** until `prompt`
   resolves. This matches the plan ("schema reject at the peer, `onError`") and
   is harmless today, because no update is mandatory. Once 3b adds a
   mandatory event, though, a broken envelope around it is a hang. A
   `session/update` dropped by the peer should then also fail that session's
   in-flight turn.
3. **"No turn in flight → `onError` only" is silent in two runtimes**
   (pre-existing). The in-process worker (`cli/src/local-runtime.ts:219-227`)
   and `connect` (`cli/src/connect.ts:21`) construct `RemoteClient` without
   `onError`. Only the pod runtimes pass it (`pod-runtime.ts:293,479`). In the
   default worker runtime, an idle unknown-mandatory or malformed frame
   (e.g. a malformed `background_exit`) therefore vanishes. Worth a `TODO.md`
   line.
4. **A malformed `background_exit` fails the unrelated in-flight turn**
   (observation). `background_exit` is not turn-scoped, but the known-malformed
   rule sends it to `handler.fail` (`remote-client.ts:102-105`). The turn then
   fails and is cancelled daemon-side (trace case 3). This is loud, so it is
   consistent with the design, but nothing documents it and no test covers it.
   The idle error path (no handler installed) is also untested. Both work in
   the trace.
5. **Forward-compat stops at the top-level `type`** (observation, document
   it). Suppose a newer daemon nests a new `ContentBlock` variant inside a
   *known* event, e.g. `agent_message_chunk{content:{type:"video"}}`. The rule
   classifies that frame as "malformed", so the turn fails and is cancelled.
   On `main` the frame was only dropped. Extending a nested enum is therefore a
   breaking change (version bump), and the members' "not `.strict()`" comment
   (`updates.ts:5-7`) does not cover it. One sentence in `ARCHITECTURE.md`
   would make this explicit.
6. **Premise line drift** (doc). Content is TRUE, but the lines are off on
   `main`@`c03d394`:
   - "`updates.ts:111`": `seq` is at `:105`;
   - "`json-schema.ts:152-160`": those lines are `collectDefinitions`; the
     untagged-union guard is at `:175-185`.
7. **Doc metadata** (nit):
   - the header still reads "Status: implementation … execution next";
   - `Size: S` is understated. The change touches 3 packages plus the protocol,
     ~10 source files, with design; §10 calls that `M`. The `load-bearing`
     blast rating is correct.
8. **Not re-verified by the reviewer:** Tests 8 (Swift codegen on the real
   `protocol.json`). The output pasted in Execution is taken on trust. To
   verify, rerun the `sog` driver from `.tentacle/tmp/protocol-schema-export-impl/`.

### Gate (reviewer's own run)

`bun run check` exit 0:
- `tsc --noEmit` is clean;
- `biome check .`: "Checked 266 files … No fixes applied" (baseline 0/0);
- `bun test`: **816 pass, 1 skip (opt-in live-k8s), 0 fail, 2554 expect(),
  817 tests across 95 files**.

This matches Execution.

### Premise table (checked on `main`@`c03d394` via a temporary `git worktree`)

| Premise | Verdict |
|---|---|
| Context Repro: unknown display frame rejected, no-`seq` frame accepted, image silently dropped | **TRUE**. Re-run on `main` prints `false / true / "what is in this photo?"`. On the branch the schema lines flip to `true / false`. The reject itself lives in `assertTextOnly`. |
| Peer drops an invalid notification with `onError` (`peer.ts:355-363`) | TRUE |
| `session/update` → `SessionUpdateParamsSchema` (`methods.ts:83`) | TRUE |
| `seq` optional (`updates.ts:111`) | TRUE in content; the line is `:105` (F6) |
| `contentToText` drops non-text (`daemon/mapping.ts:14-19`) | TRUE |
| Single routing point + `background_exit` special case + one handler (`remote-client.ts:67,88-102,180-186`) | TRUE |
| Only caller `RemoteSession.send` (`remote-session.ts:72,93`) | TRUE (`rg setUpdateHandler`: only those two sites, all packages incl. cli/tui) |
| `emit` sets `seq`; `replayFrom` uses `?? 0` (`hosted-session.ts:79-91`) | TRUE |
| Prompt path `Connection.prompt` → `hosted.prompt` → `contentToText` (`connection.ts:216-223`, `hosted-session.ts:102`) | TRUE |
| `PromptParams.content` min 1 (`session.ts:91-96`) | TRUE |
| `RpcError` passes through, others redacted (`peer.ts:326-345`) | TRUE |
| Untagged-union guard (`json-schema.ts:152-160`) | TRUE in content; the guard is at `:175-185` (F6) |
| `null` sites only `exitCode` (`updates.ts:76`) + error `id` (`jsonrpc.ts:93`) | TRUE (`rg "nullable\|z.null"`) |
| `PROTOCOL_VERSION = 1`, daemon refuses mismatch (`connection.ts:184-188`) | TRUE |
| `AsyncQueue.fail`/`push` no-op after close (`queue.ts`) | TRUE |
| Drift 1: the path-based allowlist cannot pass the usage site | **TRUE**. Mutation R1 (restore `main`'s `!UNTAGGED_ALLOWED.includes(at)`) makes 7 tests fail with an export throw. |

### Mutation non-vacuity

Script: `.tentacle/tmp/session-wire-classes-review/mutate.py`. Each mutation
is applied alone, the named test files are run, and the source is restored.

- **The executor's M1–M10, re-run: all RED.** Fail counts were 2/2/2/1/1/8/7/4/2/1.
  M6 fails 8 tests here (vs. 5 in Execution) because I also ran
  `json-schema.test.ts`.
- **Reviewer's own mutations: all RED.**
  - R1, identity → path allowlist: 7 fail.
  - R2, error not routed to `handler.fail`: 2 fail (e2e mandatory and
    malformed).
  - R3, `mandatory` accepts `false`: 2 fail.
  - R4, extra class not rejected: 1 fail.
  - R5, ignored frames logged to `onError`: 1 fail.
  - R6, `seq` not incremented: 1 fail (integration).
  - R7, `onError` not called on error: 1 fail.
  - R8, `.nullable()` on `Steer.text`: 2 fail (wire-hygiene and drift).
- **Tree byte-identical afterwards:** `git diff | shasum` =
  `1a773349fbfbc904068d96e6c376cf089174945a` before and after. The task doc
  hash was unchanged until this Review was written.

### Attacks tried

1. **Can the identity allowlist leak other unions?**
   (`.tentacle/tmp/session-wire-classes-review/identity.ts`, with fake sources
   built on the real exports.) **Holds.**
   - These throw:
     - a fresh inline union of objects;
     - a *structural clone* `z.union([SessionUpdate, UnknownSessionUpdate])`
       used inline;
     - the allowed union with `.describe()` used inline (a new `_def`);
     - a different union exported under the allowed *name*. It throws at the
       real usage site, because `SessionUpdateParams` still references the
       original.
   - These are accepted and emitted as `$ref: #/$defs/SessionUpdateOrUnknown`:
     the allowed union reused inline, and the same union wrapped in
     `.optional()`.
   - zod 3.23 `.describe()` and the other wrappers copy `_def`, so no unrelated
     schema can share one. The gate remains name-based for whatever is exported
     under an allowed name, exactly as the old path-based gate was.
2. **Is there a zod ⇔ ajv disagreement the perturbation test misses?**
   (`agree.ts`) **Agree on all 14.** The perturbation never produces some
   cases, so I added them:
   - `mandatory: false` and `mandatory: "true"`;
   - `update` null or an array;
   - `type` empty or a number;
   - `type: "toString"` and an own `"__proto__"` key;
   - `seq` 2^60 and `1.0`;
   - known-malformed with `mandatory`;
   - a known event with a new nested content type;
   - a malformed `background_exit`;
   - a missing `update`.

   Shape G accepts known-malformed frames, as documented. The client rule in
   `UnknownSessionUpdate.description` matches `classifyUpdate` and
   `ARCHITECTURE.md`.
3. **Silent or hung paths in the client** (`e2e.ts`: a raw `RpcPeer` daemon
   driving the real `RemoteClient`/`RemoteSession`).
   - Idle unknown-mandatory: `onError`, no cancel, nothing hangs.
   - Idle malformed `background_exit`: `onError`, exit listeners not called.
   - Mid-turn malformed `background_exit`: the turn throws "malformed
     background_exit", and the daemon gets `session/cancel` (F4).
   - Mid-turn mandatory frame without `seq`: dropped at the peer, the turn
     waits until `prompt` resolves (F2).
   - A fail arriving after the queue closed is a no-op (`queue.fail`), plus a
     harmless extra `session/cancel`. The late `prompt` response after a
     fail is ignored (`push` no-op).
   - No unhandled rejection: `prompt` has its own rejection handler.
4. **§7 TUI-over-RPC / one session path:** **Holds.**
   - `setUpdateHandler` has a single caller (`remote-session.ts:72,101`).
   - `cli`/`tui` never touch it.
   - All 4 runtimes construct the same `RemoteClient` (`local-runtime.ts:120`,
     `connect.ts:21`); no parallel path was added.
   - The peer still dispatches concurrently, and `classifyUpdate` is sync.
5. **Hard-coded version 1 in production code:** **none.**
   - `rg protocolVersion` outside tests finds only
     `PROTOCOL_VERSION`-derived sites (`remote-client.ts:146`,
     `connection.ts:184-192`). The schema field is a plain `int`.
   - The remaining `1` literals live in transport/protocol/cli tests and in
     one `remote.test.ts` fake daemon. The client never checks the daemon's
     returned version, and those fakes do not check the client's. A real
     v1 ↔ v2 pair fails at the daemon's `initialize` check, on either side of
     the skew.

### What holds

- Shape G: the known union stays tagged `oneOf` + discriminator, the wrapper
  is `anyOf`, `x-event-class` is on every member, and the guards fire in both
  directions.
- Required `seq` and the single encoding of `mandatory`.
- `hasOwn` known-type check.
- Non-text reject runs before the busy check, and no turn leaks.
- `KnownSessionUpdateParams` keeps the daemon emitter narrow without touching
  the wire.
- The client rule is implemented once, pure, in `client/src/mapping.ts`, which
  respects the §7 pure-module rule.
- The fail path fails loudly **and** cancels daemon-side.
- No §7 invariant is broken. `PROTOCOL_VERSION` is bumped as the breaking
  change requires.

### How the executor behaved

- Worked in plan order, and reported every drift honestly with its cause.
  Drift 1 is real: R1 proves it.
- Caught and fixed its own vacuous `toEqual` assertion (drift 4).
- Disclosed that one e2e test is green before the client change (drift 5),
  with a mutation that makes it red.
- Its gate and mutation figures reproduce exactly.
- Misses:
  - line-number drift in two premises;
  - stale status/size metadata;
  - the orphaned doc comment;
  - no test for the idle error path or the non-turn-scoped malformed event.
- No overclaiming found.

### Post-review fixes

*— claude-opus-5-5, 2026-10-20 (applied without a further review, on the owner's instruction)*

- F1: the orphaned `BackgroundExitNotice` doc comment moved back above its
  interface (`client/src/remote-client.ts`).
- F2, F3: carried into 3b as explicit constraints
  (`docs/eval/session-event-stream.md` §3b, top).
- F4: two new e2e tests (`client/test/remote.test.ts`). The first pins that a
  malformed `background_exit` mid-turn fails and cancels that turn. The second
  pins that, with no turn in flight, a stream error reaches `onError` only.
  Both pin behaviour that already existed, so they were not red first; the
  second was shown non-vacuous by mutation (dropping the `onError` call turns
  it red).
- F5: `ARCHITECTURE.md` now states that the tolerance is top-level `type`
  only, and that extending a nested enum is a breaking change.
- F6, F7: line references corrected (`updates.ts:105`,
  `json-schema.ts:175-185`); Status updated; Size resized S → M.
- F8 (Swift codegen not re-verified by the reviewer): unchanged; the code it
  checks did not change after the run.
