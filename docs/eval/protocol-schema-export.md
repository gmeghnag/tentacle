# eval/protocol-schema-export — export the wire schema as JSON Schema, gated against drift

> **Status:** implementation drafted — awaiting owner approval (2026-10-19)
> **Branch:** none until promoted (then `feat/protocol-schema-export`)
> **Type:** eval → feat · **Size:** S–M (was S: verification added a union rewrite, a type guard and a zod⇔JSON-Schema agreement test; still one package + a re-export) · **Blast:** cross-module (no runtime/wire change; touches `protocol`, a `transport` re-export, root scripts, `bun.lock`) · **Suited:** a weaker model may execute; standard Review

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** publish the protocol's wire contract as JSON
Schema, generated from the zod schemas (which stay the single source of truth),
so a non-TypeScript client (Swift, Kotlin) or an external integrator can
generate types from it, and so every wire change is visible as a diff.

Facts: the protocol already has complete method maps — `RequestSchemas`
(params + result per method, `protocol/src/methods.ts:60`) and
`NotificationSchemas` (`:78`). `zod-to-json-schema` 3.23.5 is already a repo
dependency (`packages/tools/package.json:13`, used in `tools/src/registry.ts:10`)
and matches zod 3.23.8. The schemas use no `.transform/.refine/.preprocess`; the
only JSON-Schema-sensitive construct is `.default()` (`protocol/src/session.ts:39,46,47`),
which makes a field optional on input but required on output.

Placed before the event-stream child on purpose: v2's breaking changes then
show up as reviewable diffs of the exported schema from the first one.

## Implementation

> **Owner decisions (2026-10-19):** the open questions below are resolved in
> the parent, `docs/eval/session-reattach.md` §"Owner decisions after the
> children's Implementation drafts" (A–G, D1–D10). Where a question or
> design point here disagrees, the parent decision wins.


*— claude-opus-5-5, 2026-10-19 (draft, awaiting owner approval)*

Verified against `main` @ `4914e9b`, bun 1.4.3, macOS. Experiments ran in
`.tentacle/tmp/protocol-schema-export-impl/` (gitignored); scripts and output
are pasted below. No repo file other than this doc was changed.

### Open questions / contradictions

Four points where verification contradicts or extends the Review. Each has a
recommendation; the plan below follows the recommendation, so approving the
plan approves these unless the owner says otherwise.

- **OQ-1 — the load-bearing assumption is false as worded; the fix is cheap.**
  The Review assumed `zod-to-json-schema` renders the discriminated unions as
  `oneOf` + `const` and that *quicktype* turns that into a tagged enum. Both
  halves are false: the library emits **`anyOf`** (exp 1), and quicktype
  collapses the union into **one struct with every field optional** whether
  the input is `anyOf` or `oneOf`, even with an OpenAPI `discriminator`
  (exp 3) — a quicktype limitation, not a shape problem. What *does* work: the
  same `$defs` with each discriminated union rewritten to **`oneOf` of named
  `$ref`s + `discriminator: {propertyName, mapping}`** produce a real tagged
  Swift `enum` with Apple's `swift-openapi-generator` 1.9.0 (exp 8), and a TS
  tagged union with `json-schema-to-typescript` (exp 4). **Recommendation:**
  adopt that shape (Design §3); name `swift-openapi-generator` (via an OpenAPI
  3.1 wrapper of `$defs`), not quicktype, as the reference codegen. Kotlin
  (`openapi-generator`) is expected to behave the same (it keys on the same
  `discriminator`) but was **not** verified.
- **OQ-2 — "input shape for params, output shape for results" does not match
  the wire.** The peer validates only *inbound* payloads and sends the
  sender's raw value: request params are checked but the raw `params` is sent
  (`packages/transport/src/peer.ts:139-143`, `:182`), results are sent as the
  handler returned them, unvalidated (`peer.ts:322`), notifications are never
  validated outbound (`peer.ts:213-222`). So what is *on the wire* in either
  direction is whatever the validator's **input** shape accepts — a result
  with a `.default()` field omitted is legal and the TS receiver fills it on
  parse. Exporting the output shape for results would promise Swift a field
  the contract does not guarantee. **Recommendation:** export the input shape
  everywhere, keep the `default` keyword (exp 1 shows it is emitted) so a
  decoder knows the fill value, and state it in the file's `$comment`. The only
  `.default()` in a result is `AgentCapabilities.tools/permissions`
  (`protocol/src/session.ts:46-47`), which our daemon always sends
  (`daemon/src/connection.ts:190`); `session-event-stream`'s wire-hygiene step
  (parent point 15) can make them plain required fields if Swift ergonomics
  matter. This also halves the design: one `$defs` set, not an input and an
  output copy of every schema that contains a default.
- **OQ-3 — the contract is incomplete without its error codes, and they live
  in the wrong package.** A Swift client must branch on `UnknownSession`,
  `VersionMismatch`, `TurnInProgress` (and v2 adds e.g. `PermissionNotPending`),
  but `DomainErrorCode` lives in `@tentacle/transport`
  (`transport/src/errors.ts:10-19`), which `protocol` cannot import (transport
  depends on protocol, `errors.ts:7`). **Recommendation:** move
  `DomainErrorCode` into `protocol/src/jsonrpc.ts` next to `JsonRpcErrorCode`
  (`:16`), re-export it from `transport/src/errors.ts` so the three import
  sites (`daemon/src/hosted-session.ts:16`, `daemon/src/connection.ts:32`,
  `transport/test/peer.test.ts:4`, plus `daemon/test/integration.test.ts:14`)
  stay untouched, and emit both maps as `errorCodes` in the file. ~10 lines;
  no behaviour change. If declined, drop Files step 2 and the `errorCodes` key.
- **OQ-4 — input to `session-event-stream`, not resolved here.** Parent
  point 14 says a client MUST ignore an unknown *display* event. The generated
  Swift decoder **throws** `unknownOneOfDiscriminator` on an unknown `type`
  (exp 8, `default:` branch). So "ignore unknown display events" cannot come
  from naive codegen: the event-stream child must specify how a generated
  client tolerates them (e.g. decode `seq`/`type` first and decode `update`
  only for known types, or an explicit catch-all member in the schema). The
  event-class annotation itself (Review: "mark each variant's class") is also
  that child's: this task builds no unused seam for it; the expected hook is a
  protocol-exported `Record<discriminant, "display" | "mandatory">` that the
  exporter emits as `x-event-class` on each member `$def`.

Minor correction to the Review: zod-to-json-schema is *added* to
`@tentacle/protocol`, not moved — `tools` keeps it, it uses it at runtime
(`tools/src/registry.ts:10`).

### Load-bearing assumption

**The exported schema can be shaped so that a mainstream non-TS code generator
produces an exhaustive tagged enum for each discriminated union
(`SessionUpdate`, `ContentBlock`, `PermissionOutcome`, `WireStreamEvent`), and
the shaping does not change what the schema accepts.** Proved below, with the
correction of OQ-1.

Exp 1 — what the library emits by default (excerpt):

```ts
// exp1.ts
import { zodToJsonSchema } from "../../../packages/tools/node_modules/zod-to-json-schema/dist/esm/index.js";
import * as P from "../../../packages/protocol/src/index.ts";
const show = (l: string, v: unknown) => console.log(`--- ${l}\n${JSON.stringify(v, null, 1)}`);
show("ContentBlockSchema (defaults)", zodToJsonSchema(P.ContentBlockSchema, { $refStrategy: "none" }));
show("ClientCapabilitiesSchema", zodToJsonSchema(P.ClientCapabilitiesSchema, { $refStrategy: "none" }));
show("SteerSchema passthrough-strategy", zodToJsonSchema(P.SteerSchema));
show("SteerSchema strict-strategy", zodToJsonSchema(P.SteerSchema, { removeAdditionalStrategy: "strict" }));
const { z } = await import("../../../packages/protocol/node_modules/zod/lib/index.mjs");
show("object with z.function() field", zodToJsonSchema(z.object({ a: z.string(), f: z.function() })));
show("transform", zodToJsonSchema(z.object({ a: z.string().transform((s: string) => s.length) })));
```
```
--- ContentBlockSchema (defaults)        -> { "anyOf": [ {type:"object", properties:{ type:{type:"string",const:"text"}, ...}}, ... ] }
--- ClientCapabilitiesSchema             -> { properties:{ streaming:{type:"boolean", default:true} }, additionalProperties:false }   (not required)
--- SteerSchema passthrough-strategy     -> "additionalProperties": false
--- SteerSchema strict-strategy          -> "additionalProperties": true
--- object with z.function() field       -> { properties:{ a:{type:"string"} }, required:["a"] }   <- field f silently DROPPED
--- transform                            -> { properties:{ a:{type:"string"} } }                   <- transform silently ignored
```

Exp 3 — quicktype 23.0.170 on the named-`$defs` schema, `anyOf` and
`oneOf`+`discriminator` variants: identical, collapsed output (TS shown; the
Swift output is the same single `struct SessionUpdate` with optionals):

```
$ bunx quicktype@23.0.170 -s schema update-refs-oneof.json --lang typescript --just-types --top-level SessionUpdateParams
export interface SessionUpdate {
    content?:          ContentBlock[] | ContentBlock;
    type:              SessionUpdateType;
    rawInput?:         any;
    status?:           string;
    title?:            string;
    ...every member's fields, all optional...
}
```

Exp 4 — `json-schema-to-typescript` 15.0.4 on the same file (`anyOf` and
`oneOf` give identical output):

```ts
export type SessionUpdate =
  AgentMessageChunk | AgentThoughtChunk | ToolCall | ToolCallUpdate | Plan | AgentUsage | BackgroundExit | Steer;
export interface ToolCall { type: "tool_call"; toolCallId: string; title: string; status: ToolCallStatus; rawInput?: unknown; [k: string]: unknown; }
```

Exp 8 — `swift-openapi-generator` 1.9.0 (built from the tag), on the exported
`$defs` wrapped unchanged as OpenAPI 3.1 `components.schemas` (only `$ref`
prefix rewritten `#/$defs/` → `#/components/schemas/`), config
`generate: [types]`:

```ts
// exp8.ts (wrapper)
const wrap = (defs: unknown) => JSON.stringify({ openapi: "3.1.0", info: { title: "tentacle", version: "1" },
  paths: {}, components: { schemas: defs } }, null, 2).replaceAll("#/$defs/", "#/components/schemas/");
```
```
=== oneOf + discriminator (the planned shape)
        @frozen public enum SessionUpdate: Codable, Hashable, Sendable {
            case agent_message_chunk(Components.Schemas.AgentMessageChunk)
            case agent_thought_chunk(Components.Schemas.AgentThoughtChunk)
            case agent_usage(Components.Schemas.AgentUsage)
            case background_exit(Components.Schemas.BackgroundExit)
            case plan(Components.Schemas.Plan)
            case steer(Components.Schemas.Steer)
            case tool_call(Components.Schemas.ToolCall)
            case tool_call_update(Components.Schemas.ToolCallUpdate)
            ...
                switch discriminator {
                case "agent_message_chunk": self = .agent_message_chunk(try .init(from: decoder))
                ...
                default:
                    throw Swift.DecodingError.unknownOneOfDiscriminator(...)
=== anyOf (what the library emits)
        public struct SessionUpdate: Codable, Hashable, Sendable {
            public var value1: Components.Schemas.AgentMessageChunk?
            ...
            public var value8: Components.Schemas.Steer?
$ grep 'public enum \(ContentBlock\|PermissionOutcome\|WireStreamEvent\|SessionUpdate\)\b' Types.swift
551:  @frozen public enum ContentBlock ...   1509: @frozen public enum PermissionOutcome ...
2115: @frozen public enum SessionUpdate ... 2790: @frozen public enum WireStreamEvent ...
```

So the tagged enum depends on `oneOf` + `discriminator.mapping` + every member
being a **named** `$ref` — all three are exporter post-processing (Design §2,
§3). The "does not change what the schema accepts" half is exp 9 below: Ajv
and zod agree on every payload. Not verified: compiling the generated
`Types.swift` (needs the `swift-openapi-runtime` package); a Kotlin generator.

### Preconditions

- **Complete method maps, all named.** `RequestSchemas`
  (`protocol/src/methods.ts:63`, 9 methods) and `NotificationSchemas` (`:82`,
  4 notifications); every params/result schema in them is a named
  `export const …Schema` of the package index (`protocol/src/index.ts:8-15`) —
  verified: the prototype's name lookup found all 22 (exp 5 did not throw).
- **Only these zod kinds are used** in exported schemas: string, number, boolean,
  object, array, discriminatedUnion, union (`RequestIdSchema`,
  `jsonrpc.ts:28`), literal, enum, optional, nullable, default, unknown, null.
  No `.transform/.refine/.preprocess/.lazy` (grep, and the prototype's guard did
  not fire).
- **Strip vs strict objects carry meaning.** `updates.ts:5-7`: update members
  are deliberately *not* `.strict()` so new optional fields don't break older
  clients; params/results are `.strict()` (e.g. `session.ts:31,41,57`). The
  export must keep that difference (`additionalProperties: true` vs `false`),
  which needs `removeAdditionalStrategy: "strict"` — the library default maps
  strip objects to `false` (exp 1; `zod-to-json-schema` `Options.js`
  `removeAdditionalStrategy: "passthrough"`, `parsers/object.js`
  `decideAdditionalProperties`).
- **Intentional "anything" fields.** `z.unknown()` at `updates.ts:35`
  (`rawInput`), `model.ts:29` (tool `parameters`), `model.ts:114` (`$/progress`
  `value`), and the JSON-RPC envelope `jsonrpc.ts:37,47,56,65`. They export as
  `{}` — correct, but the set must be pinned (Design §4).
- **The library silently drops what it cannot represent.** Unsupported kinds
  return `undefined` (`parseDef.js:147-150`) and the object parser skips an
  `undefined` property (`parsers/object.js:31`) — exp 1 `z.function()` field
  vanished. Its `override` option is the hook to make this loud (verified:
  returning `ignoreOverride` delegates; returning `undefined` instead turned
  **every** def into `{}` in a first prototype run — itself a demonstration of
  why the `{}` check in Design §4 is needed).
- **Version pins.** `zod-to-json-schema` 3.23.5 (`tools/package.json:13`,
  `bun.lock:399`, peer `zod ^3.23.3`) and zod 3.23.8 (`protocol/package.json`).
- **Gate layout.** `tsconfig.json` includes only `packages/*/src` and
  `packages/*/test`, so the exporter lives in `src/` to be typechecked;
  `import.meta.main` has precedent (`cli/src/main.ts:572`). Biome formats and
  checks JSON (`biome.json` `formatter`; `files.ignore` does not cover
  `packages/protocol/schema`): verified that raw `JSON.stringify(…, null, 2)`
  **fails** `biome check` (it collapses short arrays such as `required`) and
  the `biome format` output passes:
  ```
  $ biome check --vcs-use-ignore-file=false raw.json   ->  × Some errors were emitted while running checks.
  $ biome check --vcs-use-ignore-file=false real.json  ->  Checked 1 file in 7ms. No fixes applied.
  ```
- No AGENTS §7 invariant is touched: no wire change, no runtime import (the
  exporter is not re-exported from `protocol/src/index.ts` and the package
  `exports` only `"."`, so no daemon/client/TUI bundle loads it).

### Design

One pure module, `packages/protocol/src/json-schema.ts`:

```ts
export interface ProtocolSource {            // injectable seam for the guard tests
  exports: Record<string, unknown>;          // default: `import * as P from "./index.ts"`
  requestSchemas: Record<string, { params: ZodTypeAny; result: ZodTypeAny }>;
  notificationSchemas: Record<string, ZodTypeAny>;
  version: number;
  errorCodes: Record<string, number>;        // OQ-3: { ...JsonRpcErrorCode, ...DomainErrorCode }
}
export const UNKNOWN_ALLOWED: readonly string[];   // JSON pointers of intentional `{}` (§4)
export function buildProtocolJsonSchema(src?: ProtocolSource): ProtocolJsonSchema;
export function serializeProtocolJsonSchema(doc: ProtocolJsonSchema): string; // JSON.stringify(…, null, 2) + "\n"
if (import.meta.main) { /* write ../schema/protocol.json */ }
```

1. **Named definitions.** Every export whose key ends in `Schema` and is a
   `ZodType` becomes `$defs[<key minus "Schema">]` (68 defs today, incl. the
   JSON-RPC envelope a Swift client also needs). A zod instance exported under
   two names → throw (ambiguous name).
2. **Synthesized names for anonymous union members.** For each
   `ZodDiscriminatedUnion` def, an option that is not itself a named export
   gets `<UnionName><PascalCase(discriminant value)>` — today
   `PermissionOutcomeSelected/Cancelled` (`permission.ts:39-42`) and
   `WireStreamEventText/Reasoning/ToolCall/Done` (`model.ts:45-50`). A
   collision with an existing name → throw. This avoids touching protocol
   source to name them.
3. **Generate, then rewrite unions.** `zodToJsonSchema(z.object({}), {
   definitions, definitionPath: "$defs", removeAdditionalStrategy: "strict",
   override })`, take `$defs`. Then each discriminated-union def
   `{anyOf: [$ref…]}` becomes `{oneOf: [$ref…], discriminator: {propertyName,
   mapping: {<const>: <$ref>}}}`. Assert every member has the discriminant as a
   required `const`, and that the mapping covers every member (zod already
   rejects duplicate discriminants at construction). `oneOf` ≡ `anyOf` here
   because distinct required `const`s make members mutually exclusive.
4. **Guards — fail loudly, never emit a silent hole.**
   - `override` throws `unrepresentable zod type <ZodX> at <path>` for any
     typeName outside the allowlist of the Preconditions (transform, refine,
     function, date, bigint, lazy, map, set, …), then returns `ignoreOverride`.
   - After generation, walk every schema position (skipping the `properties`
     container itself): a `{}` whose JSON pointer is not in
     `UNKNOWN_ALLOWED` → throw with the pointer. Today's 7 entries:
     `ToolCall/properties/rawInput`, `WireToolDefinition/properties/parameters`,
     `ProgressParams/properties/value`, `JsonRpcRequest/properties/params`,
     `JsonRpcNotification/properties/params`,
     `JsonRpcSuccessResponse/properties/result`, `JsonRpcError/properties/data`
     (exp 4 output below, `EnqueueResult/properties` being the empty container).
   - Every `$ref` must match `^#/\$defs/[A-Za-z0-9]+$`; a path ref (the
     library's fallback for a reused *anonymous* schema) → throw "export it
     under a name".
   - A method/notification schema that is not a named def → throw.
5. **Document shape** (one file, `packages/protocol/schema/protocol.json`):
   ```
   { "$schema": "https://json-schema.org/draft/2020-12/schema",
     "$comment": "Generated by `bun run schema:export` from @tentacle/protocol (zod is the source of truth) — do not edit. Shapes are the INPUT shape a receiver's validator accepts; `default` = value a receiver fills when the field is absent. Objects with additionalProperties:true may gain optional fields without a version bump.",
     "title": "tentacle wire protocol",
     "x-protocol-version": 1,
     "errorCodes": { "InvalidParams": -32602, …, "UnknownSession": -32003, … },
     "methods":       { "<method>": { "params": {"$ref"}, "result": {"$ref"} } },
     "notifications": { "<method>": { "params": {"$ref"} } },
     "$defs": { … } }
   ```
   One file for the current version; older versions live in git history
   (pre-public, no v1 peers to serve — parent "no compat shims").
6. **Determinism.** Object keys sorted recursively, `required` arrays sorted;
   other arrays (union members, enum values) keep source order. So reordering
   fields in a zod object is *not* a diff, a semantic change is. Verified:
   two builds byte-identical (exp 5).
7. **Script + format.** Root `package.json`:
   `"schema:export": "bun packages/protocol/src/json-schema.ts && biome format --write packages/protocol/schema/protocol.json"`.
   The drift test compares **parsed** JSON (`toEqual`), so Biome's layout never
   matters to it, and `bun run lint` keeps the committed file formatted.

Prototype (exp 4/5/6/9 import it) — the executor rewrites it typed, without
`any` (Biome `noExplicitAny` is an error), reading `typeName` through a narrow
cast:

```ts
// proto-export.ts (abridged; full file in the tmp folder)
const SUPPORTED = new Set(["ZodString","ZodNumber","ZodBoolean","ZodObject","ZodArray","ZodDiscriminatedUnion",
  "ZodUnion","ZodLiteral","ZodEnum","ZodOptional","ZodNullable","ZodDefault","ZodUnknown","ZodNull"]);
// 1. defs from every `*Schema` export (throw on alias); 2. synthesize union member names
const out = zodToJsonSchema(z.object({}), { definitions: defs, definitionPath: "$defs",
  removeAdditionalStrategy: process.env.MUTATE_STRATEGY ?? "strict",
  override: (def) => { if (!SUPPORTED.has(def.typeName)) throw new Error(`unrepresentable zod type ${def.typeName}`); return ignoreOverride; } });
// 3. anyOf -> oneOf + discriminator{propertyName, mapping}; 5. wrap methods/notifications as $refs; 6. sortKeys
```
```
$ bun exp4.ts
def count: 68
synthesized: [ "PermissionOutcomeSelected", "PermissionOutcomeCancelled", "WireStreamEventText",
  "WireStreamEventReasoning", "WireStreamEventToolCall", "WireStreamEventDone" ]
non-name refs: []
empty {} schemas: [ "#/$defs/EnqueueResult/properties", "#/$defs/JsonRpcError/properties/data",
  "#/$defs/JsonRpcNotification/properties/params", "#/$defs/JsonRpcRequest/properties/params",
  "#/$defs/JsonRpcSuccessResponse/properties/result", "#/$defs/ProgressParams/properties/value",
  "#/$defs/ToolCall/properties/rawInput", "#/$defs/WireToolDefinition/properties/parameters" ]
$ bun exp5.ts
deterministic across two builds: true bytes: 26725 lines: 1303
```

### Files

Dependency order (protocol → transport → root); nothing in daemon, client,
cli or tui.

1. `packages/protocol/package.json` — add `devDependencies`:
   `"zod-to-json-schema": "3.23.5"` (same pin as `tools`), `"ajv": "8.17.1"`
   (test only). devDependencies, not dependencies: only the exporter script and
   the test use them; no runtime import path reaches `json-schema.ts`. Then
   `bun install` → `bun.lock` changes (commit it).
2. *(OQ-3)* `packages/protocol/src/jsonrpc.ts` — move `DomainErrorCode` here
   (after `JsonRpcErrorCode`, `:16`); `packages/transport/src/errors.ts` —
   replace the definition (`:10-19`) with `import { DomainErrorCode } from
   "@tentacle/protocol"` + `export { DomainErrorCode }`; `ErrorCode` (`:21`)
   unchanged.
3. `packages/protocol/src/json-schema.ts` — new, Design §1–§7. **Not** added
   to `index.ts`.
4. `packages/protocol/schema/protocol.json` — new, generated by step 6 (never
   hand-written).
5. `packages/protocol/test/json-schema.test.ts` — new, Tests below.
6. `package.json` (root) — script `schema:export` (Design §7).
7. `ARCHITECTURE.md` — one paragraph under the protocol section: where the
   schema is, that it is generated, how to regenerate, the OpenAPI-wrap recipe
   for Swift (exp 8 wrapper). (Rides this branch, AGENTS §10 carve-out (b).)

### Failure modes

- **A zod schema changes, the file is not regenerated** → drift test red with
  `protocol.json is stale — run \`bun run schema:export\` and commit the diff`.
  Converges: the PR carries the schema diff.
- **`PROTOCOL_VERSION` bumped without regenerating** → `x-protocol-version`
  differs → same drift red.
- **Unrepresentable construct added** (`.transform`, `.refine`, `z.date()`,
  `z.lazy` …) → export throws naming the zod kind; the drift test, which calls
  the same builder, is red too. Never a silently dropped field (exp 1). The
  author either rewrites the schema or extends the allowlist *and* the
  agreement fixtures in the same PR.
- **A new `z.unknown()` field** → `{}` at an unlisted pointer → throw with the
  pointer. Adding it to `UNKNOWN_ALLOWED` is a visible, reviewed decision.
- **A reused anonymous sub-schema** → the library emits a path `$ref`
  (`#/$defs/X/properties/y`), which breaks codegen naming → throw "export it
  under a name".
- **Alias export / synthesized-name collision / method schema not exported**
  → throw with both names.
- **Non-determinism** (key order, Map iteration) → keys and `required` sorted;
  comparison is structural; exp 5 shows byte-identical rebuilds.
- **Biome reformat or a hand-edit** of the committed file → lint catches
  formatting; the drift test (structural) catches content edits.
- **zod ⇔ JSON Schema divergence** (the schema accepts something zod rejects
  or vice versa) → the agreement test (T2). Known residual: equivalence is
  tested on a corpus, not proven; and string length semantics differ (zod
  counts UTF-16 units, Ajv code points) — harmless today because the only
  string bound is `.min(1)`; a future `.min(n>1)`/`.max()` on strings should
  add an astral-character fixture.
- **`zod-to-json-schema` upgraded** → output may change → drift red, the diff
  shows exactly what moved; exact pin prevents a silent float.
- **Generated client meets an unknown discriminant** → throws (exp 8). Not
  this task's to fix; OQ-4 hands it to `session-event-stream`.
- **Empty input**: `EnqueueResult` is `z.object({}).strict()` → exported as an
  object with no properties and `additionalProperties: false`; covered by the
  agreement fixtures (`{}` accepted, `{x:1}` rejected).

### Tests

All in `packages/protocol/test/json-schema.test.ts` (iterate with
`bun test packages/protocol/test/json-schema.test.ts`). Ajv instance:
`new Ajv2020({ strict: true })` with `addVocabulary(["discriminator",
"x-protocol-version", "errorCodes", "methods", "notifications"])` — verified
this compiles the document in strict mode (exp 6); Ajv's own
`discriminator: true` option is **not** usable (it rejects the `mapping`
annotation context: `strict mode: missing type "object" for keyword
"discriminator"`, exp 7), and is unnecessary — `oneOf` validates.

- **T1 — drift (the gate).** `expect(buildProtocolJsonSchema()).toEqual(
  JSON.parse(readFileSync(<schema/protocol.json>)))`, with the failure message
  naming `bun run schema:export`. *Red first:* write the test before step 6 →
  red (file missing); generate → green; then change one field (e.g. make
  `SteerSchema.text` optional) → red; revert.
- **T2 — zod ⇔ JSON Schema agreement (the exact property: the exported schema
  accepts exactly what the peer's zod validation accepts).** One valid fixture
  per method params, per method result and per notification params; a
  **coverage assertion** that every key of `RequestSchemas` × {params,result}
  and of `NotificationSchemas` has a fixture (so a new method fails until it
  gets one). Each fixture expanded mechanically — at every object level: add
  `__extra: 1`, delete each key, replace each leaf with a wrong-typed value —
  and for every payload `zod.safeParse(v).success === ajvValidate(v)`. Pointer
  per entry: `p#/methods/<method with "/" → "~1">/params`. Prototype result:
  ```
  $ bun exp9.ts                           -> strategy=strict: 89 payloads, 0 disagreements
  $ MUTATE_STRATEGY=passthrough bun exp9.ts
  DISAGREE zod=true ajv=false notif session/update: {"sessionId":"s","seq":3,"update":{"type":"tool_call_update",…,"__extra":1}}
  …
  strategy=passthrough: 89 payloads, 8 disagreements
  ```
  (6 fixtures in the prototype; the real test has ~26.) This subsumes the
  Review's "real frames from the daemon integration tests": every real frame
  already passes zod on the receiving peer (`peer.ts:307,360,413`), and T2
  shows zod and the schema agree — so no daemon test needs Ajv. Stated limit:
  agreement on a corpus, not a proof.
- **T3 — tagged-union shape (the property the codegen needs, OQ-1).** For every
  `ZodDiscriminatedUnion` export: its `$def` has `oneOf` (no `anyOf`),
  `discriminator.propertyName === <zod discriminator>`, mapping keys == the set
  of member discriminant values, every mapping target a named `$ref` that
  exists in `$defs`. Also: no `$ref` anywhere fails `^#/\$defs/[A-Za-z0-9]+$`.
- **T4 — guards, through the injectable `ProtocolSource`** (a tiny fake module
  object, no real I/O): a `z.function()` field → throws `/unrepresentable/`; a
  `.transform()` → throws; an extra `z.unknown()` field → throws with its
  pointer; the same anonymous object used in two places → throws `/export it
  under a name/`; one schema under two export names → throws; a method whose
  schema is not exported → throws.
- **T5 — determinism.** Two builds: `serializeProtocolJsonSchema(a) ===
  serializeProtocolJsonSchema(b)`; and a doc built from a fake source whose
  object declares fields in reverse order serializes identically.
- **T6 — version and error codes present.** `x-protocol-version ===
  PROTOCOL_VERSION`; `errorCodes.UnknownSession === -32003` (OQ-3).

**Non-vacuity by mutation** (§9; executor runs each, records red, reverts):
`removeAdditionalStrategy` back to the default → T2 red (8 disagreements,
shown above) and T1 red; skip the `oneOf` rewrite → T3 red; make `override`
return `ignoreOverride` without the allowlist check → T4 `z.function` case red
(the field is silently dropped, exp 1); delete the `{}` walk → T4 unknown case
red; drop `required` sorting and reverse a field order in the fake source → T5
red.

**Gate** before done: `bun run check` (typecheck → lint → test) green against
the §6 baseline (lint 0/0; all tests pass except the opt-in live-k8s skip).

### Why, item by item

(Only decisions not already argued in the Review.)

- **Why `oneOf` + `discriminator` instead of what the library emits.** Exp 8:
  that is the difference between `enum SessionUpdate { case tool_call(…) }`
  and a struct of eight optionals. `discriminator` is an OpenAPI keyword, an
  annotation for plain JSON Schema (validators ignore it once declared as
  vocabulary), so it costs nothing to validators and is what Swift/Kotlin
  generators key on.
- **Why name every exported schema as a `$def` (not only the method roots).**
  Generators name types after `$defs`; without names the library inlines or
  emits path refs and Swift gets `Value1Payload`-style names that change when
  an unrelated field moves. Export names are already the protocol's
  vocabulary, so the generated types read like the TS ones.
- **Why synthesize member names instead of exporting them from protocol.**
  Two unions have inline members today; naming them in the exporter is
  deterministic and keeps this task free of protocol source edits. If an owner
  prefers explicit exports, it is a mechanical follow-up (the synthesized
  names become real ones, zero schema diff).
- **Why `removeAdditionalStrategy: "strict"`.** The library default exports a
  non-strict zod object as `additionalProperties: false`, contradicting the
  documented forward-compat of update members (`updates.ts:5-7`): a Swift
  client generated from it would reject a field a newer daemon adds. T2 proves
  the strict strategy is the one that matches zod (0 vs 8 disagreements).
- **Why an allowlist guard rather than a denylist.** The library's failure mode
  is silence (a dropped field, an ignored transform); a denylist misses the
  next unhandled kind. With an allowlist, any construct not yet thought about
  stops the export until someone decides.
- **Why the agreement test instead of recording daemon frames.** It tests the
  exact property (schema accepts ≡ zod accepts) including the reject side,
  which recorded frames never exercise (they are all valid); it needs no
  daemon dependency in the protocol package; and the perturbation corpus is
  what caught the strategy mutation.
- **Why Ajv as a dev dependency.** It is the only way to test the schema's
  semantics rather than its text; pure JS, test-only, exact pin. Without it,
  T1 would only prove "file == generator output", never "generator output ==
  wire contract".
- **Why the exporter in `src/` with `import.meta.main`, not `scripts/`.** Root
  `scripts/` is Biome-ignored and outside `tsconfig` `include`; the exporter is
  the contract's code, so it is typechecked and linted like the rest.
- **Why not re-export it from `index.ts`.** It would make
  `zod-to-json-schema` reachable from every consumer of the protocol (daemon,
  client, compiled binary) for a build-time concern.
- **Why one file, not one per version.** Pre-public with no v1 peers to serve
  (parent: no compat shims); git history holds every version and each breaking
  child's PR shows its diff — the reason this child exists.

## Execution

*(empty — an eval)*

## Review

*— claude-opus-5-5, 2026-10-19*

**Recommend promoting.** Scope:
- A script in `@tentacle/protocol` that walks `RequestSchemas` and
  `NotificationSchemas` (+ `PROTOCOL_VERSION`) and writes one committed file,
  e.g. `packages/protocol/schema/protocol.json`, keyed by method with
  `params`/`result`, plus shared `$defs` (content blocks, updates).
- Export the **input** shape for params and the **output** shape for results
  (`.default()` fields: optional in, required out) — state it in the file.
- A test (runs in `bun test`, so the gate catches it): regenerate in memory and
  `expect(...).toEqual(committed)`. Drift → red with "run `bun run
  schema:export`".
- Move `zod-to-json-schema` into `@tentacle/protocol`'s own dependencies (exact
  pin, same version as `tools`).
- Mark each `session/update` variant's class (display / mandatory, parent
  point 14) as a schema annotation once the event-stream child introduces it.

**Why, item by item.**

- **Why export at all, when both ends already share the zod module.** Today
  drift is impossible because the daemon and every client import the same
  `@tentacle/protocol`. The v2 goal includes clients that *cannot* import it: a
  Swift app, possibly Kotlin, an external ACP-style integrator. Without a
  machine-readable contract they hand-write their types by reading TypeScript,
  and the first silent mismatch (a field renamed, optional vs nullable, a new
  union member) surfaces as a decode failure on a phone in a user's hands —
  the most expensive place to discover it.
- **Why generate from zod instead of writing JSON Schema by hand.** Two hand-
  maintained sources of truth drift; that is the failure mode this task exists
  to prevent. zod is what the peer actually validates against
  (`RequestSchemas`, `protocol/src/methods.ts:60`), so a schema generated from
  it is, by construction, exactly what the daemon accepts.
- **Why a committed file plus a drift test, not "generate at release".** The
  committed file turns every wire change into a reviewable diff in the PR that
  makes it. v2 lands as several breaking children; each one's PR then shows
  precisely what changed on the wire, and an *accidental* change (a refactor
  that renames a field) is caught in review instead of by a client.
- **Why this child comes before the event-stream child.** So the v1 export is
  committed as the baseline and the first breaking v2 change already appears as
  a schema diff. Done after, the v2 changes would arrive as one undiffable blob.
- **Why the input shape for params and the output shape for results.**
  `.default()` (`protocol/src/session.ts:39,46,47`) makes a field optional for
  the sender and always present for the receiver. One shape for both directions
  misleads one side: a Swift client would either be forced to send a field the
  daemon does not need, or treat as optional a field that is always there.
- **Why sorted keys and a loud failure on unrepresentable schemas.** Unsorted
  output makes the drift test flaky, and a flaky gate gets ignored. An
  unrepresentable schema silently exported as `{}` means "anything goes",
  which a code generator turns into an untyped blob — the opposite of a
  contract, and invisible until a client misbehaves.
- **Why move `zod-to-json-schema` into `@tentacle/protocol`.** The protocol
  package must not depend on `tools` to describe itself; a dependency belongs
  to the package that uses it. Exact pin, same version, per repo practice.
- **Why the discriminated-union check is the load-bearing assumption.** The
  value of the export is code generation. If `SessionUpdateSchema` comes out as
  an untagged `anyOf`, a generator produces one struct with every field
  optional: the Swift client loses the exhaustive `switch` over update types —
  exactly where handling *mandatory* events (parent point 14) lives.

Load-bearing assumption to prove first: `zod-to-json-schema` renders the
`discriminatedUnion`s (`SessionUpdateSchema`, `ContentBlockSchema`) as `oneOf`
with a `const` discriminant that a codegen (quicktype) turns into a tagged enum
— check with one generated Swift/TS type before committing to the format.

Failure modes: non-deterministic output (key order) → flaky gate: sort keys;
a schema that cannot be represented → fail the export loudly, never emit `{}`.

Tests: drift test above, shown red by editing one schema field (non-vacuity);
a round-trip test that a sample of real frames from the daemon integration
tests validates against the exported schema with a JSON Schema validator — or,
if adding a validator is too heavy, defer that and state it.
