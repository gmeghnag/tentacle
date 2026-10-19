# eval/protocol-schema-export — export the wire schema as JSON Schema, gated against drift

> **Status:** eval (child of `docs/eval/session-reattach.md`, step 2)
> **Branch:** none until promoted (then `feat/protocol-schema-export`)
> **Type:** eval → feat · **Size:** S · **Blast:** cross-module · **Suited:** a weaker model may execute; standard Review

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

*(empty — filled when promoted)*

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
