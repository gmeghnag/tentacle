# fix/anthropic-tool-schemas — Tool schemas invalid on the Anthropic API

> **Status:** execution
> **Branch:** `fix/anthropic-tool-schemas`
> **Size:** S · **Blast:** cross-module (the Anthropic provider) · **Suited:** contained-ish; standard Review
> **Changelog:** `changelog.d/anthropic-tool-schemas.fixed.md`

## Context

*— claude-sonnet-5-5, 2026-11-25*

`TENTACLE_MODEL=claude-haiku-5-5 tentacle --profile anthropic "…"` fails on the first request:
`400 invalid_request_error: tools.0.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12`.

**Repro** (`POST /v1/messages/count_tokens`, free, model claude-haiku-5-5, one request per tool of the registry's
`definitions()`): `fs_read`, `shell`, `search` → 400; `fs_write`, `fs_edit`, `fs_multi_edit`, `shell_output`,
`shell_kill`, `chart`, `diagram`, `present` → 200. The failing schemas all contain
`"exclusiveMinimum": true, "minimum": 0` (4 occurrences in the dumped array). Cause: `ToolRegistry.definitions()`
(`packages/tools/src/registry.ts:64`) uses `zodToJsonSchema(..., { target: "openApi3" })`, whose boolean
`exclusiveMinimum` is OpenAPI-3.0/draft-04, invalid in 2020-12 (a number). OpenAI tolerates it.

## Implementation

*— claude-sonnet-5-5, 2026-11-25*

- **Load-bearing assumption:** `toWireTool` (`anthropic-provider.ts`) is the one place a `ToolDefinition` becomes the
  Anthropic wire, so normalising there covers builtins, MCP, workflow and skill tools. Verified: it is the only
  `input_schema` site.
- **Preconditions:** the OpenAI provider reads `tool.parameters` directly and is untouched.
- **Design:** pure module `packages/providers/src/json-schema-2020.ts` `toDraft2020(schema)`: boolean
  `exclusiveMinimum|Maximum` + bound → numeric (false/dangling dropped); `nullable: true` → `"null"` in `type`
  (or `anyOf` when untyped, `enum` gains `null`); tuple `items` → `prefixItems`; recursive over subschema
  keywords only (property *names* like `nullable`/`items` untouched); non-mutating.
- **Files:** `json-schema-2020.ts` (new), `anthropic-provider.ts` (one call), tests below, this doc, changelog fragment.
- **Failure modes:** non-object/array schema → returned as is; `exclusiveMinimum: true` without `minimum` → flag dropped
  (valid, looser); MCP schemas with `$schema` draft-07/`definitions`/`$ref` are accepted by the API (verified below).
- **Tests:** `packages/providers/test/json-schema-2020.test.ts` (one per pattern + payload) and
  `packages/tools/test/anthropic-schemas.test.ts` (every builtin through `buildPayload`, structural 2020-12 check).
  No JSON-schema validator is a dependency, so the check is structural for the known-bad keywords.

## Execution

*— claude-sonnet-5-5, 2026-11-25*

Done as planned. Red on main-equivalent (wire line reverted): 2 fail (builtins test, payload test); green with the fix
(37 pass across provider test files touched/related). Biome clean on changed files; `tsc --noEmit` clean.

- count_tokens, whole array (11 registry tools + a sample MCP tool with `$schema` draft-07, `nullable`, boolean
  `exclusiveMinimum`) after conversion → **200, 4731 input tokens**.
- Smoke (one run, claude-haiku-5-5, run from source because the installed `~/bin/tentacle` predates the fix):
  `fs_read {"path":"sample.txt"}` then the answer `beta` — correct. Usage not printed by the CLI; estimated
  ≈ 2 requests × ~4.8k input tokens + tiny output.
- API spend: count_tokens only (free) + the one smoke (~10k input tokens on haiku, well under a cent).
- Not covered: the factory tools (workflow/skill/task) were not in the dumped array; they go through the same converter.
  Rebuild the installed binary to pick up the fix.

## Review

*(pending)*
