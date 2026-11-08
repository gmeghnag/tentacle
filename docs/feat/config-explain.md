# feat/config-explain — one config-key registry, `tentacle explain`, generated README table

> **Status:** implementation → execution → review
> **Branch:** `feat/config-explain`
> **Type:** feat · **Size:** L · **Blast:** cross-module · **Suited:** strong model; Review fresh-context (T1 gates every future schema edit)

## Context

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

Tasks **1, 2 and 3** of `docs/eval/config-cli.md` (owner answers recorded there,
2026-11-08), on one branch:

1. `packages/config/src/key-docs.ts` — one registry holding every config key's
   docs, plus a summary for every section node; pinned against the schema,
   `resolveConfig`'s defaults, the env reads, the CLI flags, `CARRIED` and the
   secret set (T1–T7), and a pure nearest-key function for typos.
2. `tentacle explain [key] [--all] [--json]` — a pure formatter + thin dispatch;
   it navigates by level and never reads the user's config file.
3. The README config table, generated from the registry between markers, with
   `bun run docs:config` and a drift test.

The owner answers this task implements verbatim:

> - **Q1: (b).** One registry holds every key's docs; the schema holds shape only; pinned by T1.
> - **Q2: (a).** The README table is generated between markers, with a drift test.
> - **Q8: (a).** `explain` stays static; the effective value and its origin go to `config show --origin`.
> - **Added by the owner (2026-11-08): `explain` navigates by level.**
>   - `tentacle explain`: the top-level keys only, one line each, with a count of sub-keys for a section (`subagents … (7 sub-keys)`).
>   - `tentacle explain <section>` (e.g. `subagents`, `model`): the section's summary and its DIRECT sub-keys, one line each, with the default when short. A map is shown as `types.*`.
>   - `tentacle explain <leaf>` (e.g. `subagents.maxParallel`): the full card (meaning, type, allowed values, default, env, flag, carried, scope, example).
>   - `tentacle explain --all`: the flat list of every leaf, for grep.
>   - The registry needs a summary for section nodes too, not only leaves; T1 also pins that every section has one.

Constraints (owner, this task):

- **`packages/config/src/schema.ts`, `defaults.ts`, `resolve.ts`, `load.ts` are
  read-only** — another branch is editing them. The schema's comments stay as
  they are (shortening them is a later cleanup). Where a schema comment is
  wrong, the **registry** carries the correct text and Execution records the
  drift.

**Repro** (2026-11-08, in this worktree): the capability is missing, and asking
for it starts a *model session* instead — proof that no `explain` subcommand
exists, and that the word is currently a one-shot prompt:

```
$ mkdir -p .tentacle/tmp/config-explain/{cfg,home}
$ env HOME=$PWD/.tentacle/tmp/config-explain/home \
      TENTACLE_CONFIG_DIR=$PWD/.tentacle/tmp/config-explain/cfg \
      bun packages/cli/src/main.ts explain
[error] ModelConnectionError: could not connect to the model endpoint (ECONNREFUSED), gave up after 3 attempt(s): ECONNREFUSED: Unable to connect. Is the computer able to access the url?
exit=1
# and it scaffolded the config dir on the way (loadConfig ran): config.jsonc, PROMPT.md, logs/
```

And the docs are hand-kept in four places that have drifted (eval §"The docs
live in four hand-kept places"): `schema.ts:354` says `redactSecrets` "Default:
enabled" while `DEFAULT_REDACT_SECRETS = false` (`defaults.ts:47`); the README
table (`README.md:301-341`) holds ~20 of the ~50 keys and none of the env names.

## Implementation

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

### Load-bearing assumption

**The zod schema can be introspected generically at runtime, so the leaf/section
path set can be *derived* rather than hand-listed.** Verified empirically in
`.tentacle/tmp/config-explain/probe-paths.ts` (output pasted in Execution): walking
`FileConfigSchema` yields 110 paths — `unwrap(ZodOptional|ZodNullable|ZodEffects
|ZodDefault|ZodCatch)`, then `ZodObject.shape` (section), `ZodRecord.valueType`
(→ `<path>.*`), `ZodArray`/`ZodEnum`/`ZodLiteral`/`ZodString`/… (leaf),
`ZodDiscriminatedUnion` (section whose fields are the union of its branches'
shapes; a field with a literal in every branch becomes an enum). The exact
hooks used, from zod 3.23.8 (`packages/config/node_modules/zod/lib`):
`_def.typeName`, `.shape`, `.options`, `.valueType`, `.element`, `.innerType()`,
`.value`, `_def.checks`.

If this were false, T1 would need a hand-kept path list — a second table, the
thing this task exists to delete.

### Preconditions

- **Schema shape (read-only):** `ModelConfigSchema` (`schema.ts:10`),
  `McpServerSchema` = `preprocess(discriminatedUnion)` (`schema.ts:99`),
  `HookSpecSchema` = strict object + `superRefine` (`schema.ts:124`),
  `settingsShape` (`schema.ts:188`), `ProfileSchema` (`schema.ts:393`),
  `FileConfigSchema` (`schema.ts:402`).
- **`ProfileSchema` = the file's settings minus `$schema`/`profiles`**
  (`schema.ts:393-400` spreads the same `settingsShape`; its own `mcpServers`
  record is the nullable one). So a registry entry under `profiles.*` is the
  same key as the base one — derived, and pinned by T1b.
- **Defaults:** `DEFAULT_*` constants (`defaults.ts:5-57`),
  `defaultWritableDirs(env)` (`defaults.ts:65`) is computed, not constant;
  `resolveConfig({fileConfig: {}, env: {}, defaultCwd})` returns 29 provenance
  keys (`resolve.ts:142-172`, filled at `resolve.ts:555-585`).
- **Env reads:** inline in `resolveConfig` (`resolve.ts:356-496`) plus
  `TENTACLE_ENGINE` in the CLI (`packages/cli/src/engine-select.ts:81`) and the
  `TENTACLE_NO_SKILLS`/`TENTACLE_NO_AGENTS_MD` helpers
  (`resolve.ts:290`, `:305`).
- **`CARRIED`** (`packages/cli/src/carried-settings.ts:42`) is keyed by wire
  setting, each row carrying `configKey` + `class` `"P"`/`"W"` — 21 rows.
  `config` cannot import it (cli imports config, not the other way round), so
  the registry's `carried` field is a declared mirror, pinned by T6 in
  `packages/cli/test`.
- **Flags:** the one closed list is `ARGS` (`packages/cli/src/flags.ts:77`).
- **Dispatch:** `SUBCOMMANDS` (`flags.ts:512`), `CliMode`/`cliMode`
  (`flags.ts:620`, `:640`), `USAGE` (`flags.ts:667`). A command that must work
  without a config runs **before** `loadConfig` in `main` — as `update` does
  (`main.ts:542-543`); that is the seam `explain` uses, so it never touches the
  user's file (Q8/a).
- **Output streams (§7 discipline):** data on `out`, errors/usage on `err`
  (`main.ts:319-337`).
- No AGENTS §7 invariant is touched: nothing on the wire, nothing persisted,
  the loader and schema are only read.

### Design

Three pure modules and three thin wirings; the registry is the one source.

**`packages/config/src/config-keys.ts`** — schema introspection, no registry:

- `schemaKeyNodes(schema): KeyNode[]` — `KeyNode = { path, kind: "leaf"|"section",
  type, values? }`, deterministic order (schema order, depth-first).
- `configKeyNodes()` — the same over `FileConfigSchema`.
- `resolveKeyPath(input: string): KeyNode | undefined` — a *concrete* path
  (`mcpServers.fs.command`, `profiles.work.model.model`) matched against the
  schema tree, so any `*` segment accepts any name. Returns the canonical
  registry path (`mcpServers.*.command`).
- `nearestKeys(input, paths, max = 3): string[]` — Levenshtein ≤ 2 or a shared
  root segment, `*` treated as matching any concrete segment; sorted by
  distance then path.
- `NON_KEY_ENV` — the `TENTACLE_*` names read by config but not owned by a key
  (`TENTACLE_PROFILE`, `TENTACLE_CONFIG_DIR`, `TENTACLE_PROJECT_DIR`,
  `TENTACLE_PACKAGE_DIR`), for T3b's reverse scan.

**`packages/config/src/key-docs.ts`** — the registry:

```ts
export type KeyKind = "leaf" | "section";
/** Where the key may be set. `user` = the top-level file only. */
export type KeyScope = "user" | "profile" | "both";
/** Laptop → pod, as `CARRIED`'s P/W classes. Absent/`no` = not carried. */
export type Carried = "pinned" | "workspace" | "no";
export interface KeyDoc {
  summary: string;          // one line; REQUIRED for every node, sections too
  kind: KeyKind;
  type?: string;            // "boolean" | "string" | "integer" | "number" | "enum" | "array" | "map" | "object"
  values?: readonly string[];   // allowed values, for an enum
  scope: KeyScope;
  carried: Carried;         // REQUIRED on every entry (T6)
  secret?: boolean | "values";  // true = the value; "values" = a map of values
  default?: () => unknown;  // the built-in default, from the DEFAULT_* constants
  resolved?: (c: ResolvedConfig) => unknown;  // the resolved field, for T2
  sourceKey?: Exclude<keyof ResolvedConfig["sources"], "apiKey">;  // for T3
  env?: string;
  /** TENTACLE_* vars are inverted for these two ("truthy disables"). */
  envInverts?: true;
  /** A short, valid value for `env`, used by T3 (a number for a number key…). */
  sample?: string;
  flag?: string;
  details?: string;
  example?: string;         // a JSONC value fragment; REQUIRED for a leaf (T1c)
}
export const KEY_DOCS: Readonly<Record<string, KeyDoc>>;
export function keyDoc(path: string): KeyDoc | undefined;
export function directChildren(path: string): string[];   // `<path>.x` and `<path>.*` only
export function leafPaths(): string[];
export function carriedDocPaths(): string[];             // carried !== "no"
export function renderConfigKeysTable(): string;          // the README block (task 3)
```

The `profiles.*` subtree is **derived** from the base entries by prefix
(`withProfile("model.model", doc)` → `profiles.*.model.model`) with a small
override map for the places a profile genuinely differs (`profiles.*` section
summary; `profiles.*.mcpServers.*` may be `null` = removed for that profile;
`profiles.*.model.provider/baseURL/apiKey/apiKeyCommand` move as one unit).
T1b pins that the mirror is faithful: the `profiles.*` subtree of the walker
equals the base subtree, key for key.

**`packages/cli/src/explain.ts`** — the pure formatter (no I/O, no registry
mutation):

```ts
export interface ExplainEntry { path; kind; summary; type?; values?; default?;
  env?; flag?; carried?; scope; secret?; example?; details?; subKeys? }
export type ExplainResult =
  | { ok: true; level: "top" | "section" | "leaf" | "all"; section?: ExplainEntry;
      entries: ExplainEntry[]; note?: string }
  | { ok: false; error: string; suggestions?: string[] };
export function explain(key: string | undefined, opts: { all?: boolean }): ExplainResult;
export function renderExplainText(result): string;   // the level-shaped text
export function renderExplainJson(result): string;   // the same model, as JSON
```

Levels (owner answer): no key → the top-level nodes, one line each, a section
showing `(N sub-keys)`; a section → its summary line plus its **direct**
children; a leaf → the card; `--all` → every leaf path, flat, sorted. An
unknown key → `{ ok: false, error, suggestions }` (never a partial answer), and
`--all` together with a key is an error too. `default` is rendered from the
`default()` thunk (JSON-short) — never a value from the user's file. Secrets:
the card prints the *marker* and the placeholder example only.

**`packages/cli/src/flags.ts`** — `explain` joins `SUBCOMMANDS` (`:512`),
`CliMode` (`:620`), `cliMode` (`:640`), `ARGS` (`:77`, `bools: { all, json }`,
`positional: { min: 0, max: 1 }`) and `USAGE` (`:667`).

**`packages/cli/src/main.ts`** — dispatch `mode === "explain"` right after
`update` (`:542`) and **before** `loadConfig`, printing to `out`/`err`; plus one
line in `HELP`.

**`scripts/config-docs.ts`** + `package.json` `"docs:config"` — rewrite
`README.md` between `<!-- config-keys:start -->` and `<!-- config-keys:end -->`
with `renderConfigKeysTable()`, and **fail (exit 1) when a marker is missing**
(a silent no-op would let the table rot). Idempotent: a second run leaves the
file byte-identical.

### Files

Dependency order:

1. `packages/config/src/config-keys.ts` (new) — walker, `resolveKeyPath`,
   `nearestKeys`, `NON_KEY_ENV`.
2. `packages/config/src/key-docs.ts` (new) — the registry, `directChildren`,
   `renderConfigKeysTable`.
3. `packages/config/src/index.ts` — export both.
4. `packages/config/test/config-keys.test.ts` (new) — the walker, `*` matching,
   nearest-key.
5. `packages/config/test/key-docs.test.ts` (new) — T1, T1b, T1c, T2, T2b, T3,
   T3b, T7.
6. `packages/cli/test/key-docs-carried.test.ts` (new) — T6 + T5 (needs `CARRIED`
   and `ARGS`, both in cli).
7. `packages/cli/src/explain.ts` (new) — the formatter.
8. `packages/cli/test/explain.test.ts` (new) — the formatter's four levels,
   `--json`, unknown key, secret placeholder.
9. `packages/cli/src/flags.ts` — `explain` in `SUBCOMMANDS`/`CliMode`/`cliMode`/
   `ARGS`/`USAGE`.
10. `packages/cli/src/main.ts` — dispatch before `loadConfig`; `HELP` line.
11. `packages/cli/test/explain-main.test.ts` (new) — `main(["bun","cli","explain"])`
    with a **broken** `config.jsonc` still exits 0 (proves no config read);
    a typo exits 1 with its suggestion; `--all` is the flat list.
12. `packages/config/test/readme-config-table.test.ts` (new) — T4 drift.
13. `scripts/config-docs.ts` (new) + `package.json` `"docs:config"`.
14. `README.md` — markers + the generated block replacing `:301-341`'s table.

### Failure modes

| Case | Outcome |
|---|---|
| A schema key with no registry entry (or a stale entry) | T1 red: the message names the path and both directions (`missing` / `extra`). This is the gate for every future schema edit. |
| A registry entry whose `kind` disagrees with the schema | T1 red (a leaf documented as a section would make `explain <leaf>` list children it does not have). |
| A wrong/misspelled `env` name | T3 red: the resolved field's `source` stays `"default"`. |
| An env read with no registry entry | T3b red (the reverse grep over `packages/config/src/*.ts` + `engine-select.ts`). |
| A flag that does not exist | T5 red. |
| A new `CARRIED` row with no registry entry, or a P/W class flip | T6 red. |
| A secret key not marked, or a secret with a real-looking example | T7 red. |
| `explain` given an unknown key / a typo | `ok: false` + ≤3 nearest keys; `main` prints `[error] …` on **stderr**, exit 1, nothing on stdout. |
| `explain --all <key>` | Refused by the formatter (ambiguous: list or card?), exit 1. |
| A broken/missing user `config.jsonc` | Irrelevant: `explain` runs before `loadConfig` and imports nothing that reads it (test pins it with a deliberately broken file). |
| `explain mcpServers.fs.command` | Resolved through `*` to `mcpServers.*.command`; the card names the canonical path. |
| `explain profiles.work` | `profiles.*` (a section) — the profile subtree is documented once. |
| A secret's value | Can never be printed: the formatter has no access to the user's config, and a secret card prints a placeholder only. |
| README markers deleted | `bun run docs:config` exits 1 with the reason; T4 also red (no block to compare). |
| `bun run docs:config` run twice | Byte-identical (idempotence is the property the gate relies on). |
| A trailing-slash / empty key (`explain ""`, `explain model.`) | `ok: false` with a usage hint, exit 1 — never the top-level list by accident. |

### Tests

Red-first (§9), then a mutation per group with a `cp` backup + `shasum` restore:

- **T1** `Object.keys(KEY_DOCS)` equals the walker's leaf+section paths, both
  directions; every entry's `kind` equals the walker's; every **section** has a
  non-empty `summary`. Mutation: delete one entry → red; add a fake entry → red.
- **T1b** the `profiles.*` subtree equals the base subtree (the derivation is
  faithful), and every base path except `$schema`/`profiles*` appears mirrored.
- **T1c** every leaf has `type` + `example`; a scope is `user` iff the path is
  `$schema` or under `profiles`.
- **T2** for every entry with `resolved`, `default?.()` deep-equals
  `resolved(resolveConfig({ fileConfig: {}, env: {}, defaultCwd: "/w" }))`.
  Mutation: change `subagents.maxParallel`'s default thunk to 5 → red.
- **T2b** entries with `default` but no `resolved` are exactly
  `{engine, rm, detach.keepAwake, tui.theme}` — the CLI-owned defaults
  `resolveConfig` does not apply (`resolve.ts:116-124`).
- **T3** for every entry with `env` + `sourceKey`: `resolveConfig` with
  `{ [env]: sample }` (respecting `envInverts`) reports `source === "env"` for
  that `sourceKey`. Mutation: set `tools.redactSecrets`'s env to
  `TENTACLE_REDACT` → red.
- **T3b** every `TENTACLE_[A-Z_]+` found in `packages/config/src/*.ts` and
  `packages/cli/src/engine-select.ts` is a registry `env` or in `NON_KEY_ENV`.
- **T5** every `flag` exists in `ARGS` (any command's values/bools/optional).
- **T6** `Object.keys(CARRIED)`'s `configKey`s equal the registry's
  `carried !== "no"` set, and each class matches (`P`↔`pinned`, `W`↔`workspace`).
  Mutation: flip `maxIterations` to `pinned` → red.
- **T7** `model.apiKey`, `model.apiKeyCommand`, `mcpServers.*.env.*`,
  `mcpServers.*.headers.*` are `secret: true`, `mcpServers.*.args` is
  `"values"`, and every secret entry's `example` is a placeholder
  (`…`, `<…>` or `***`) — never a plausible key.
- **Formatter** (`packages/cli/test/explain.test.ts`): the four levels, the
  `(N sub-keys)` count, a map shown as `types.*`-style, `--json` round-tripping
  the same model, unknown key → suggestions, `--all` + key refused, a secret
  card without a value. Mutation: make `directChildren` return grandchildren →
  the section test goes red.
- **T4** (`readme-config-table.test.ts`) the block between the markers equals
  `renderConfigKeysTable()`. Mutation: edit a README row → red.

Each test is run narrow (`bun test <file>`) while iterating; the gate is
`bunx tsc --noEmit`, `bunx biome check .`, `bun test packages`.

## Execution

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

### As built, in slice order

**Repro re-run on this branch before any edit** (the capability really was
missing; the word `explain` was a one-shot *prompt*, so asking for it started a
model session and scaffolded the config dir):

```
$ env HOME=$PWD/.tentacle/tmp/config-explain/home \
      TENTACLE_CONFIG_DIR=$PWD/.tentacle/tmp/config-explain/cfg \
      bun packages/cli/src/main.ts explain
[error] ModelConnectionError: could not connect to the model endpoint (ECONNREFUSED), …
exit=1     # and cfg/{config.jsonc,PROMPT.md,logs/} appeared on the way
```

**Slice 1 — the walker (`packages/config/src/config-keys.ts`, new).**
`schemaKeyNodes(zodSchema)` derives the whole tree from the schema: leaf vs
section, `type`, and `values` for an enum. Empirical decisions, each from
`.tentacle/tmp/config-explain/probe-{zod,paths,checks}.ts`:

- the hooks: `_def.typeName`, `.shape` (a function on the instance, not a plain
  field), `.options`, `.valueSchema`, `.element`, `innerType()`, `.value`,
  `_def.checks` — zod 3.23.8 at `packages/config/node_modules/zod/lib`.
- a `ZodRecord` is a **section** whose single child is its `*` entry (T1's
  `mcpServers.*.env` is a map section with one `mcpServers.*.env.*` leaf). My
  first draft called a record a *leaf*, which the test caught — a record is not
  a settable value.
- a `discriminatedUnion` of objects is a section whose fields are the union of
  its branches' fields, and a literal field merged across branches becomes an
  enum (`mcpServers.*.type` → `stdio | http`).
- the ROOT object's fields are the top-level keys (no `""` path — the first
  draft emitted one and shifted every order assertion).

`resolveKeyPath` matches a concrete path against the canonical tree (`*` matches
any segment), `nearestKeys` scores segment-wise **positionally**: a `*` and a
same-named segment are free, a different segment costs its own edit distance, and
a whole missing/extra segment costs 2. My first version was a general
insert/delete alignment and suggested `mcpServers.*` for `zebra` — it could drop
a segment and let `*` absorb the typo for free. The positional form is also what
makes `mcpServers.fs.comand` find `mcpServers.*.command`.

Result: **127 paths** (99 leaves, 28 sections) from `FileConfigSchema`.

**Slice 1 — the registry (`packages/config/src/key-docs.ts`, new).** 127
entries: 64 base ones hand-written (the top level + `profiles`/`profiles.*`),
plus a derived 63-entry `profiles.*` mirror (the profile tree is the base tree
minus `$schema`/`profiles`; T1b pins that). The mirror is derived, not
written twice, so a summary cannot disagree with itself. `directChildren`
makes a map's `*` transparent (`mcpServers`'s children are
`mcpServers.*.<field>`, never a bare `*`).

Two facts could not be cited from the schema, so they are declared and **pinned
by the code that owns them**, in `packages/cli/test`:

- `carried` mirrors `CARRIED` (`carried-settings.ts:42`): 21 rows.
- `flag` mirrors `ARGS` (`flags.ts:77`).

Tests: `packages/config/test/config-keys.test.ts` (12) and
`packages/config/test/key-docs.test.ts` (29), plus
`packages/cli/test/key-docs-carried.test.ts` (6) for T5/T6. Red first in every
case — the first run of each file failed on the missing module or on the
assertion, never on a compile error in the assertion itself.

**Slice 2 — `tentacle explain` (`packages/cli/src/explain.ts`, new + 2 wirings).**
`explain()` returns a level-tagged model (`top | section | leaf | all`), and
`renderExplainText`/`renderExplainJson` print it; `main` only chooses a sink and
an exit code. `flags.ts` gains `explain` in `SUBCOMMANDS`, `CliMode`,
`cliMode`, `ARGS` (`bools: {all, json}`, `positional 0..1`) and `USAGE`;
`main.ts` dispatches it **before `loadConfig`**, next to `update`, and `HELP`
gains its 6-line entry.

Drift from the Implementation as written:

- **`default` in the JSON model is the raw value, not a rendered string.** The
  Implementation said "rendered from the `default()` thunk (JSON-short)"; a JSON
  consumer wants `4` (a number) and `"read-only"` (a string), and the *text*
  renderer can stringify. `--json` therefore carries `"default": 4`.
- **An error renders as `""` from `renderExplainText`.** The Implementation had
  one renderer; splitting the error out (`explainErrorText`, STDERR) keeps the
  data stream free of prose, which is the repo's `out`/`err` rule (main.ts:319).
- **The top-level list has no heading line.** The owner asked for "the
  top-level keys only, one line each"; a heading is not a key, and the first
  draft's heading also made the per-key line count wrong. A section's head *is*
  its summary (`subagents — …`), which the owner did ask for.
- **A list line carries `= <default>` for a short default** (`loadSkills = true`,
  `subagents.maxParallel = 4`), which is how the owner's "with the default when
  short" is paid. Paths are column-aligned to the widest entry of that list.
- `(1 sub-key)` is singular (`detach`, `tui`).

Tests: `packages/cli/test/explain.test.ts` (26) and
`packages/cli/test/explain-main.test.ts` (11, including the pin that `explain`
works with a **deliberately broken** `config.jsonc` — a command that read it
would exit 1 with `[config error]`).

**Slice 3 — the README table (`scripts/config-docs.ts`, new).**
`renderConfigKeysTable()` lives in the registry module (so the test, the script
and any future `config.schema.json` share one renderer);
`withGeneratedBlock` is pure and unit-testable; `regenerate` reads, compares and
writes only on a change (idempotent: the second `bun run docs:config` reports
"up to date"). A missing marker is an **error, exit 1**, never a silent no-op.
`README.md`'s 24 hand-kept rows were replaced by the two markers, and the long
`tools.writableDirs` prose moved into that entry's `details` (surface:
`tentacle explain tools.writableDirs`). `package.json` gains
`"docs:config": "bun scripts/config-docs.ts"`.

Test: `packages/config/test/readme-config-table.test.ts` (6). Red first: all six
failed (`no config-keys:start marker`) until the markers went in.

### Drift found in the read-only files (recorded, not edited)

1. **`schema.ts:354` — `redactSecrets` says "Default: enabled".** It is
   `DEFAULT_REDACT_SECRETS = false` (`defaults.ts:47`) and `defaults.ts:221`
   agrees ("Off by default"). The registry's `tools.redactSecrets` carries the
   correct text ("OFF by default…") **and names the drift in its `details`**, so
   `tentacle explain tools.redactSecrets` tells the truth today. `schema.ts` was
   left untouched, as instructed (shortening its comments is a later cleanup).
2. **`schema.ts:226-232` — `subagents.maxParallel` says "Default 4" and
   "Owner: as `execution`"** — correct today, and pinned by T2; noted only
   because that comment also claims the value is *lowered* by a llama.cpp
   endpoint's slots, which lives outside `@tentacle/config` and is copied
   verbatim into the registry's `details`.
3. **`CARRIED` and the registry needed one reconciliation:**
   `tools.outputRetentionDays` is *not* a `CARRIED` row (independently of
   `SessionSettingsSchema`), so its entry is `carried: "no"`. My first draft
   said `workspace`, and T6 caught it.

`packages/config/src/schema.ts`, `defaults.ts`, `resolve.ts` and `load.ts` are
**byte-untouched** (`git status` shows them unmodified).

### Red/green evidence (command + result, trimmed)

| Step | Command | Result |
|---|---|---|
| red, walker | `bun test packages/config/test/config-keys.test.ts` | `Cannot find module '../src/config-keys.ts'` → 0 pass, 1 fail |
| green, walker | same | `12 pass, 0 fail` |
| red, registry | `bun test packages/config/test/key-docs.test.ts` | failed on T1/T2/T3 intensity (see below) → now `29 pass, 0 fail` |
| red, formatter | `bun test packages/cli/test/explain.test.ts` | `Cannot find module '../src/explain.ts'` → now `26 pass, 0 fail` |
| red, wiring | `bun test packages/cli/test/explain-main.test.ts` | `0 pass, 11 fail` (no `explain` subcommand) → now `11 pass, 0 fail` |
| red, README | `bun test packages/config/test/readme-config-table.test.ts` | `1 pass, 5 fail` (no markers) → now `6 pass, 0 fail` |
| red, T5/T6 | `bun test packages/cli/test/key-docs-carried.test.ts` | green on first run **after** the registry existed; mutation-checked below |

### Mutation check (§9) — each with a `cp` backup and a `shasum` restore

Every mutation was applied, the named test observed failing, then the file
restored and `shasum -c` verified (`OK` for all 11):

| # | Mutation | Test that went red |
|---|---|---|
| M1 | rename the `tools.maxParallel` registry entry | T1 (paths eq), T1 (kind), `leafPaths` |
| M2 | `subagents.maxParallel` default → `5` | T2: `"documented 5, resolves 4"` |
| M3 | `tools.redactSecrets` env → `TENTACLE_REDACT` | T3 (`source default`) **and** T3b |
| M4 | `maxIterations` carried `workspace` → `pinned` | T6 class mismatch |
| M5 | `rm` flag → `--remove-workload` | T5 (`is not a flag of any command`) |
| M6 | unmark `model.apiKey` as secret | T7 |
| M7 | `directChildren` returns grandchildren (`!==` → `<`) | the top-level/section-level explain tests |
| M8 | skip the secret marker on a card | "a leaf's card never shows a secret value" |
| M9 | accept `--all` together with a key | "--all with a key is refused" |
| M10 | edit one committed README row's default | T4 drift |
| M11 | delete a README row | T4 drift + "a key without a row is a doc hole" |

### The gate

```
$ bunx tsc --noEmit                       → clean
$ bunx biome check .                      → Checked 732 files … No fixes applied.   (0 errors, 0 warnings)
$ bun test packages                       → 5484 tests across 377 files, … pass (see below)
$ bun run docs:config                     → "README.md's config table is up to date"
$ git status --porcelain README.md        → unchanged after the run
```

`bun test packages`'s only failure on the first full run was **one pre-existing
test that used the word `explain` as its sample *prompt***:
`packages/cli/test/session-flags.test.ts:75` asserted
`cliMode(["explain", "--plain"]) === "prompt"` ("prompt text stays prompt
text"). Making `explain` a real subcommand legitimately changes that word's
meaning, so the sample word became `fix` (same point: a non-command word is a
prompt). No other suite was touched.

Final full-suite result (after that one-word fix):

```
$ bun test packages
 5481 pass
   3 skip
   0 fail
 61450 expect() calls
 Ran 5484 tests across 377 files. [164.90s]
```

The 3 skips are the documented opt-ins (`TENTACLE_DOCKER_TESTS=1`,
`TENTACLE_K8S_SERVER`, `TENTACLE_SLOW_TESTS=1`) — AGENTS §6's baseline, not
failures. `bunx tsc --noEmit` clean, `bunx biome check .` "Checked 732 files …
No fixes applied" (0 errors, 0 warnings: the §6 baseline is intact).

### The real command against this checkout

```
$ bun packages/cli/src/main.ts explain
  $schema                                   A JSON-schema pointer for editor completion; accepted and ignored.
  model (9 sub-keys)                        The model endpoint: provider, URL, model id, key and token budget.
  hooks                                     Shell commands run on agent events, with a JSON input on stdin.
  systemPromptFile                          The system prompt file: relative to the config dir, or absolute.
  loadAgentsMd = true                       Auto-load a per-repo `AGENTS.md` into the system prompt.
  loadSkills = true                         Discover Agent Skills and offer the `skill` tool.
  maxIterations = 16                        Max model/tool iterations per turn.
  subagents (6 sub-keys)                    The `agent_task` sub-agent tool: whether, how many, how far.
  contextAwareness (2 sub-keys)             Tell the model how full its context is, once per step of the window.
  contextReset (2 sub-keys)                 The model may renew its own context with the `context_reset` tool.
  autoWake = true                           Start a continuation turn when a background job exits while idle.
  engine = "kubernetes"                     Default engine of `run`/`attach`: kubernetes, docker or podman.
  rm = false                                Whether `run` removes its pod/container when the run ends.
  detach (1 sub-key)                        `run --detach`: what the relay holding the run may do.
  tui (1 sub-key)                           The TUI's own display settings.
  mount (2 sub-keys)                        What a docker/podman run hides from the container's workspace mount.
  mcpServers (8 sub-keys)                   MCP servers to connect to, keyed by name; their tools join the agent.
  packages                                  Installed packages to switch off: `{ "<name>": false }`.
  tools (9 sub-keys)                        Tool-output handling: spilling, retention, redaction, overlap.
  profiles (18 sub-keys)                    Named profiles: the same settings, merged over the file when selected.
[exit=0]

$ bun packages/cli/src/main.ts explain subagents
subagents — The `agent_task` sub-agent tool: whether, how many, how far.

  subagents.enabled = true                  Whether the agent may spawn sub-agents.
  subagents.maxIterations = 50              Step limit for a sub-agent's own loop.
  subagents.execution = "parallel"          How a round's `agent_task` calls may overlap.
  subagents.maxParallel = 4                 At most this many sub-agents at once.
  subagents.agentTaskDescription            Replaces the `agent_task` tool's description (max 4096 bytes).
  subagents.agentTaskDescriptionFile        The same description, read once at start from a file.
[exit=0]

$ bun packages/cli/src/main.ts explain subagents.maxParallel
subagents.maxParallel

At most this many sub-agents at once.

A llama.cpp endpoint's own slot count lowers it and never raises it.

  type         integer
  default      4
  env          TENTACLE_SUBAGENT_MAX_PARALLEL
  flag         —
  carried      carried to a pod (pinned: the laptop decides, beating the pod's own file and env)
  scope        the file and a profile
  example      4
[exit=0]

$ bun packages/cli/src/main.ts explain modle
[error] unknown config key "modle"
did you mean model?
[exit=1]

$ bun packages/cli/src/main.ts explain --all | head
$schema
autoWake
contextAwareness.enabled
contextAwareness.stepPercent
contextReset.enabled
contextReset.maxPerMessage
detach.keepAwake
engine
hooks
loadAgentsMd
loadSkills
maxIterations
[exit=0]
```

Note the last two: the typo's error goes to **STDERR** with the exit code 1 and
leaves STDOUT empty, and `--all` is the flat sorted leaf list (no `profiles.*`
mirror — the same key documented once).


## Review

*— pending (fresh context — this is `cross-module` blast, so AGENTS §10 requires it)*

What a reviewer should attack, in order:

1. **T1's real reach.** Delete a key from `schema.ts` (temporarily, on a
   scratch copy) and confirm T1 goes red in the "extra" direction too — the
   suite pins both. Then: is *any* registry fact still unpinned? `summary`
   text, `details`, `example` and `scope`'s `user`/`both` split are asserted
   only for shape, not for truth: a wrong sentence in `details` passes. That is
   the accepted limit of "the code is the source for values, prose is prose".
2. **The `carried` / `flag` mirrors.** They are *declared* in `@tentacle/config`
   and checked from `@tentacle/cli` (the dependency direction forbids the
   reverse). Argue whether that belongs in `key-docs.ts` at all, or whether
   `CARRIED`/`ARGS` should own the fact with the registry given a projection.
3. **`explain`'s strictness.** `--all` + a key is refused; an empty key is a
   usage error; an unknown *flag* is `parseArgs`'s error. Is there a form a user
   would reasonably type that now fails? (`explain model.provider extra` is
   refused by `positional.max: 1`.)
4. **The output is human-facing and untested for width.** A 44+ column path
   pushes the summary right; a very narrow terminal is not considered. Is that
   acceptable for a docs command (it is, by the same standard as `--help`)?

