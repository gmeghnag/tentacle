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

## Review (Round 1)

*— claude-opus-5-5, 2026-11-25 (fresh context; different model from the executor, claude-sonnet-5-5, but the same Claude family)*

**Verdict: APPROVE-WITH-NITS (PASS).** No HIGH or MEDIUM findings.

**Gate (re-run by the reviewer):** `bun run typecheck` exit 0 · `bun run lint` exit 0 ("Checked 2426 files … No fixes applied") ·
`bun run test` **18331 pass / 5 skip / 0 fail** (1271 files). The diff adds no skip, so all 5 skips were already there and are opt-in.
Narrow run (providers tests + the two new files): 219 pass / 0 fail.

**Premise table**

| Premise | Result |
|---|---|
| `registry.ts:62-64` emits `zodToJsonSchema(…, {target:"openApi3"})`, which writes a boolean `exclusiveMinimum` | TRUE. The trace below shows `"exclusiveMinimum":true,"minimum":0` for `.positive()` |
| `toWireTool` is the only `input_schema` site | TRUE. `rg input_schema` finds only `anthropic-provider.ts:598` in src. The pod path (`daemon/src/proxy-model.ts:87-91`) forwards `parameters` unchanged to the laptop's provider. The `skill` enum filter (`agent/capabilities.ts:118`) builds a `ToolDefinition`. Both reach `toWireTool`, so builtin, MCP (`tool.jsonSchema`), workflow, skill and task tools all go through it |
| OpenAI provider untouched | TRUE. `openai-provider.ts:576` still sends `tool.parameters`, and the diff does not touch the file |
| Symptom (400 on `fs_read`/`shell`/`search`) | Not re-run against the API: the owner's credits are scarce, so I relied on the executor's count_tokens evidence (400 → 200, 4731 tokens). The structural cause was confirmed offline: with main's provider, the new test lists `fs_read.offset`, `fs_read.limit`, `shell.timeout`… `exclusiveMinimum is boolean` |

**Red on main (scratch copy, no checkout):** I made an APFS clone of the worktree in `.tentacle/tmp/anthropic-tool-schemas-review/` and wrote
`git show main:packages/providers/src/anthropic-provider.ts` over the provider. Result: **2 fail / 9 pass**. Both new
regression tests fail: the builtins structural test and the payload test. With the branch's provider restored: green.

**Mutation (scratch copy; the worktree stayed clean, `git status` empty):** no recursion into `properties`/`$defs` → the builtins test fails (0/1).
The `nullable` branch disabled → 3 unit tests fail. Tuple conversion cut short → 1 unit test fails. All tests are non-vacuous.

**End-to-end trace** (a real zod schema → `zodToJsonSchema` openApi3 → `buildPayload`). Each output matches its input's meaning:
`.nullable()` string → `["string","null"]`. A nullable enum also gains `null` in `enum` (without that, null would fail the enum).
A nullable `anyOf` → wrapped in `anyOf[…, {type:null}]`. A tuple becomes `prefixItems`, and its `.rest()` (`additionalItems`)
becomes `items`. `.positive()`/`.lt(10)`/`.gt(1)` → numeric `exclusiveMinimum: 0` / `exclusiveMaximum: 10` / `exclusiveMinimum: 1`.
These are the same bounds, not looser. `required`, `additionalProperties: false` and `minItems`/`maxItems` are kept. Records
(`additionalProperties` holding a schema) are recursed into. Data-valued keywords (`enum`, `default`, `const`, `examples`) are not touched.

**Attacks tried**
1. *Constraint loosening.* A dropped bound happens only for `exclusiveMinimum: true` with no numeric `minimum`, which is malformed
   input that had no bound to begin with. `false` drops only the no-op flag. `required` is never touched. → Nothing found.
2. *Property names that look like keywords* (`nullable`, `items` as property names). Map keys are not treated as keywords, and a unit test pins this. → Nothing found.
3. *Prompt-cache stability.* The output is deterministic, and key order is kept (`{...schema}`, values replaced in place), so the
   tools prefix is byte-stable across requests. → Nothing found.
4. *MCP schemas in older drafts.* `definitions` is recursed into and `$ref`/`$schema` are left as they are (the API accepted them in the executor's
   count_tokens run). `dependencies` is not recursed into: see finding 2.
5. *OpenAI regression.* The conversion runs only in the Anthropic `toWireTool`, and the full suite is green. → Nothing found.

**Findings (all LOW/NIT)**
1. NIT, `anthropic-provider.ts:24-41`: the module's header docblock moved from the top of the file to the middle of the import block
   (after `./images.ts`, attached to the new import). Only the layout changed. Put it back at line 1.
2. LOW, `json-schema-2020.ts:39-45`: `dependencies` (draft-06/07's schema-or-array map) is not in `SCHEMA_MAP_KEYS`.
   The 2020-12 meta-schema still validates `dependencies` for backward compatibility. So a draft-04 MCP schema with a boolean
   exclusive bound inside `dependencies` would still return 400. This is rare (all three conditions at once) and fails loudly, so it is
   not a blocker. Adding it means recursing only into the object values.
3. NIT, `json-schema-2020.ts:36,38`: `prefixItems` is in both `SCHEMA_KEYS` and `SCHEMA_LIST_KEYS`, so it is converted twice.
   This is harmless because the function is idempotent (checked: numeric bounds and an already-removed `nullable` are fixed points), but it is redundant.
4. NIT (doc): the header is not the `Type: … · Size: … · Blast: … · Suited: …` line from AGENTS §10, and `Status` still says `execution`.

**What holds:** a single pure, non-mutating converter at the one Anthropic wire site, covering every tool source. The
schemas keep their meaning. OpenAI is unaffected. The regression test is red on main and green on the branch. The gate is green.
The Anthropic API was not called by this review.

**Executor behaviour:** a small diff in the shape the plan described, an honest Execution section (it says the factory tools were not dumped, and gives the
API spend), and red→green shown. One unrelated change slipped in: the docblock move (finding 1).
