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


### Fix round 1

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

All of Sonnet's round-1 findings are addressed. Nothing under `schema.ts`,
`defaults.ts`, `resolve.ts` or `load.ts` was touched (`git diff --stat` over them
is empty); no other package's tests were weakened — the one existing test that
changed shape ("one line per key") now asserts the same property at a width
where it must hold, and a new test pins the 80-column form.

**MEDIUM 1 — the one wrong entry, and the check that would have caught it.**

I first measured the whole registry against the schema walker rather than
reading the one entry (`.tentacle/tmp/config-explain/typecheck2.ts`): comparing
every path's `type` and `values` with `configKeyNodes()` found exactly two
mismatches, and they are one setting (`mcpServers.*.readOnlyTools` and its
`profiles.*` mirror):

```
MISMATCH mcpServers.*.readOnlyTools: reg enum [hint|none] vs schema enum|array [hint|none]
checked 127, bad 2
```

Every other `mcpServers.*` entry and every other map entry (`env.*`,
`headers.*`, `packages.*`, `profiles.*`) was correct; the probe is the evidence,
not my reading. The schema is `z.union([z.literal("hint"), z.literal("none"),
z.array(z.string().min(1))])` (`schema.ts:58-62`), so the registry is now
`type: "enum | array"`, keeping `values: ["hint", "none"]` as the literals of the
union, and the summary names all three forms.

The "better" half of the reviewer's suggestion is taken: **T1 now compares
`type` and `values` with the walker** (`key-docs.test.ts`, "each entry's `type`
and `values` are the schema's, not a second opinion"). Union members are
compared as SETS (`enum | array` == `enum|array`), a section's absent `type`
means `object`. Red on the round-1 code with exactly the two paths above, green
after the fix. That is the check that makes this class of error impossible
rather than fixed once.

**MEDIUM 2 / O1 — the subcommand trade-off, with the way back.**

Owner decision (orchestrator, pending the owner): accept `explain` as a
subcommand. What was missing is the escape hatch, in three places, each tested:

- `README.md` "Ways to run": a `tentacle -- explain how config works` line and a
  paragraph: a first word that names a subcommand IS that subcommand, so a
  one-shot prompt that starts with one needs `--` first.
- `HELP` (`main.ts`): `tentacle -- <prompt...>` now says "for a prompt that
  starts with '-' **or with a subcommand word**", with the example.
- The error itself. Two paths, because a user can type it two ways:
  - `tentacle explain how config works` → `parseArgs` refuses the extra
    positionals (`flags.ts`'s `positional.max: 1`); `main.ts` now appends
    `to send this as a prompt, use: tentacle -- explain how config works`
    beside the usage line.
  - `tentacle explain "how does X work"` → one argument, so it reaches
    `explain()` as an unknown key; a key containing whitespace is a sentence,
    not a typo, so `explain()` reports `prompt: true` instead of guessing keys
    (a single misspelt word still gets its suggestions — pinned), and `main`
    prints the same line.
  `promptHint()` is the one place the sentence is built, and `main.ts` calls it
  with `promptWords(args)` — the argv after `tentacle` as typed, flags dropped —
  so both paths print the prompt the OLD build would have sent:
  `tentacle -- explain how config works` (`explain` included, because that is
  what the user's own words were). `explain.ts` stays free of `process.argv`;
  it reports the intent, `main` owns the argv.

**LOW 3 — T1's message says what to do.**

`missing` is now
`add an entry for "<key>" in packages/config/src/key-docs.ts`, the mirror is not
listed (it is derived by `derive()`, so naming it was noise), and the reverse
direction says `remove the entry for "<key>" from packages/config/src/key-docs.ts`.
The message builder is a named function (`missingEntries`/`extraEntries`) so it
is asserted directly; mutating it back to a bare path list makes 2 tests red.

**LOW 4 — `tools.redactSecrets` details.**

The `(The comment above the schema's `redactSecrets` says "Default: enabled" …)`
parenthesis is gone. The entry states the true default — off — and nothing else;
the schema-comment drift stays recorded in Execution, where it belongs.

**LOW 5 — `tools.writableDirs`' real default.**

`KeyDoc` gained `defaultText`: the default as TEXT, for a default that is
runtime state. `renderDefault()` (README table) and `explain` (list line and
card) both prefer it, so the table, the card and the list cannot disagree. The
entry reads `the system temp dir ($TMPDIR) and /tmp`; the `default()` thunk
stays (T2 still pins it against `resolveConfig`'s real resolution). The
provider-dependent defaults got the same treatment while I was there, because
they were the same bug: `model.baseURL` (both providers) and `model.maxTokens`
(unset → provider-decided, `64000` for anthropic) — that is LOW 7's fact too.
And `systemPromptFile` shows its real default (`PROMPT.md` in the config dir).

**LOW 6 — width.**

`renderExplainText` takes `{ width }`; `main.ts` passes
`io.columns ?? process.stdout.columns` (a new `CliIO.columns` seam), so the
formatter stays pure. Default 80.

- A list line wraps its summary under the summary column, so the path stays a
  left margin; when a path is wider than the column allows, the summary goes
  under it rather than pushing the line out.
- A card wraps its summary, its `details` and every labelled field, the
  continuation indented under the label — so `explain tools.writableDirs` (a
  ~1200-character `details`) is now prose at 80 columns instead of one 1261-
  column line.
- The column is capped at `width - 24`, so a narrow terminal shrinks the column
  instead of overflowing it.

Tests: at 80 columns every level (top, `model`, `subagents`, `tools`,
`mcpServers`, `profiles`) has no line over 80, five leaf cards including the
longest `details` have none, 60 and 70 columns work, and the default (no width
given) equals 80. `explain-main.test.ts` repeats it through `main()` with
`columns: 80` and with no width at all.

**LOW 7 — the facts the hand table had.**

`git show main:README.md` against the generated table, row by row, was run as a
script rather than by eye (`.tentacle/tmp/config-explain/tablediff.ts`, output
in the terminal log). Every fact the old table carried and the first generated
one dropped is back, in the registry entry that owns it:

| Lost fact | Where it lives now |
|---|---|
| `writableDirs` env is `:`-separated, empty = `[]` | new `KeyDoc.envNote`, shown in the table and on the card |
| `writableDirs` default is `$TMPDIR` and `/tmp` | `defaultText` (LOW 5) |
| `readOnlyTools`'s array form and `hint` = `readOnlyHint` | summary + `type: "enum | array"` |
| `maxTokens` 64000 for anthropic, omitted for openai | `defaultText` |
| `baseURL`'s anthropic default | `defaultText` |
| `systemPromptFile` default `PROMPT.md`, env is inline not a path | `defaultText` + `envNote` |
| `tools.execution`'s "writes and `shell` alone" | summary |
| `subagents.execution`'s "they share one workspace" | summary |
| `engine`: an unknown value is refused | summary |
| `contextReset.enabled`: asked like any other tool | summary |
| `tui.theme`: never carried to a pod | summary |
| `model.model`: `--model` beats it, for that command | summary |
| `subagents.agentTaskDescription` family: 4096 bytes, types appended, not both | summary |
| `subagents.maxParallel`: a llama.cpp server lowers it | summary |

A regression test (`readme-config-table.test.ts`, "the facts the old HAND table
carried are still in the generated one") lists each as `[path, fact]` and fails
if its row stops carrying it — red on the round-1 registry, green now. The long
`writableDirs` prose stays in `details` (a card), which is where the eval said
it should go; the table keeps the summary, and the README now says where to read
the rest (`tentacle explain <key>`).

**O2 — `$schema` last.**

Kept and explainable, listed at the END of the top-level list
(`topLevelKeys()` moves it), not first. Two tests pin the position (one on the
model, one through `main()`).

**Red/green evidence (each red before the change, green after):**

- The two README tests, against the OLD registry with the README regenerated:
  **2 failed** (the hand-table facts, the `["/tmp"]` default).
- Every other assertion was shown red by a MUTATION of the current code (the
  table below), not by the stash run — that run is weaker here, because
  `explain.test.ts` cannot even import the old module. Where it did run (the
  stash of the three source files), 10 failed in `key-docs`/`explain-main`,
  exactly the new assertions.

**Gate:**

- `bunx tsc --noEmit` — clean.
- `bunx biome check .` — clean (0 errors, 0 warnings). `--write` fixed a few
  formatting nits in the new code.
- `bun test packages` — **5510 pass · 3 skip · 0 fail** (5513 tests, 377 files).
  The 3 skips are the opt-in ones (live k8s, live docker, the real-socket
  keepalive); none is a new failure. The round-1 baseline was 5481 pass (5484
  tests), so the 29 new tests are all green and no existing test was removed —
  the one that changed shape still asserts the same property (see LOW 6).
- `bun run docs:config` — "up to date"; a second run writes no bytes, and T4
  asserts that idempotence as text.

**Mutation check (§9), each with a `cp` backup and a restore, final test code:**

| Mutation | Result |
|---|---|
| `renderExplainText` ignores `width` (`const width = 100000`) | red: 6 (four `explain.test.ts` width tests, both `explain-main` ones) |
| `topLevelKeys()` returns the schema order (`$schema` first) | red: 2 (`$schema` last, model and `main`) |
| `shortDefault` ignores `defaultText` | red: 2 (`["/tmp"]` shown, card/table text) |
| the `writableDirs` `defaultText` deleted from the registry | red: 4 (card, table text, T4 drift, T2) |
| `explain()` guesses keys for a sentence again | red: 3 (both hint tests, the quoted-argv one) |
| the T1 message builder back to a bare path list | red: 2 (the message test, the extra direction) |
| `readOnlyTools` back to `type: "enum"` | red: 1 (T1 type/values, both trees reported in the one message) |

**Red on the round-1 code.** `git stash push` of the three source files, then
the three test files: **10 failed** in `key-docs`/`explain-main` (T1's type
check, the two runtime-default tests, the two prompt-hint tests, four width
tests, `$schema` last, `--help`). `explain.test.ts` could not run at all on the
old code (it imports `promptHint` and passes `{ width }`, which did not exist) —
which is why the mutation table above is the evidence for those, not the stash
run: a test that errors instead of failing proves nothing on its own.

**Not verified, and how to:** the wrap at a width the terminal reports but the
`CliIO` seam cannot carry (a real resize mid-command) — `process.stdout.columns`
is read ONCE, when the command renders, which is the same "read now" discipline
`StatusLine` uses. A resize during the print is not followed; that is the
command's whole output, one write, so there is nothing to redraw.


## Review

*— claude-sonnet-5-5, 2026-11-08* (fresh context; a different model family from the
executor, deepseek-v4.1-flash)

**Verdict: REQUEST-CHANGES** — small. 0 HIGH · 2 MEDIUM · 5 LOW · 2 owner questions.
No design flaw. The mechanism (T1–T7, the pure formatter, no config read, the
generated README) holds. One registry entry is wrong, and a dispatch regression
needs an owner decision.

### Gate (re-run)

- `bunx tsc --noEmit`: clean. `bunx biome check .`: clean (0 errors, 0 warnings).
- `bun test packages`: **5481 pass · 3 skip · 0 fail** (5484 tests, 377 files). The 3 skips are the opt-in ones.
- **Untouched files:** `git diff main...HEAD --stat` over `schema.ts`, `defaults.ts`, `resolve.ts`, `load.ts` is empty. The owner constraint holds.
- I did not run `bun run docs:config` (it writes `README.md`; blocked here). The idempotence evidence is T4: the committed block equals `renderConfigKeysTable()`, so a run is a no-op.

### Findings

**MEDIUM**

1. **A wrong registry entry: `mcpServers.*.readOnlyTools`** (`packages/config/src/key-docs.ts:647-657`).
   - It is documented as `type: "enum"`, `values: ["hint","none"]`.
   - The schema is a union: `"hint" | "none" | string[]` (`schema.ts:58-62`).
   - `explain mcpServers.*.readOnlyTools` therefore shows two allowed values and hides the array form. Only `details` mentions the array.
   - T1 and T1c cannot catch it: `type` and `values` are checked for presence, not for truth.
   - **Fix:** `type: "enum | array"`, or `type: "array"` with `values` marked as the two literals. Better, derive a leaf's `type` from the walker and have T1 compare it. Today the walker computes `KeyNode.type`, but `type` and `values` in the registry are not compared with it.
   - **Check:** this is the only wrong entry I found. I read the whole registry (`key-docs.ts`) against `resolve.ts`'s env reads, `defaults.ts` and `schema.ts`. T2, T3, T5 and T6 all pass, so defaults, env names, flags and carried classes are code-pinned.
   - The prose I verified by hand: hooks `timeout` 600 s (`packages/agent/src/hooks.ts:26`); anthropic `maxTokens` 64000 (`anthropic-provider.ts:38`); the apiKey precedence (`resolve.ts:491-502`); the `mount.hide` default list (`schema.ts:321`).

2. **`tentacle explain <prompt words>` changes behaviour**, see owner question O1.
   - I measured it, so it is listed here as well.
   - `tentacle explain how config works` now exits 1 with `unexpected argument "config"`.
   - `tentacle explain "how does X work"` exits 1 with `unknown config key`.
   - Before: `cliMode` returned `"prompt"` and the words went to the model.

**LOW**

3. **T1's message says what is missing but not what to do** (`packages/config/test/key-docs.test.ts:35-37`).
   - Mutation: I added `subagents.fakeNewKey` to the schema. T1 went red with `missing: ["profiles.*.subagents.fakeNewKey","subagents.fakeNewKey"]` and `subagents.fakeNewKey: schema leaf, registry undefined`. The path is clear.
   - The test does not say "add the entry to `FILE_KEYS` in `key-docs.ts`; the `profiles.*` mirror is derived". The `profiles.*` line is noise for the author of the other branch.
   - **Fix:** add a custom message, e.g. `"add <path> to FILE_KEYS (key-docs.ts); profiles.* is derived"`, and drop the `profiles.*.` entries from `missing`.
   - **Also:** `type` and `values` per leaf are not compared to the walker's `KeyNode` (see finding 1).

4. **The `tools.redactSecrets` details leak an internal pointer** (`key-docs.ts:747`).
   - It tells the end user: "(The comment above the schema's `redactSecrets` says 'Default: enabled' … see docs/feat/config-explain.md, Execution.)".
   - The drift is real: the schema comment at `schema.ts:354` says enabled, while `DEFAULT_REDACT_SECRETS` is `false`.
   - The user does not need that sentence, and it will rot once the schema comment is fixed.
   - **Fix:** remove the parenthesis from `details`. The drift stays recorded in Execution, which is enough.

5. **The `tools.writableDirs` default is shown as `["/tmp"]`** (`key-docs.ts:825`; README; card).
   - It comes from `defaultWritableDirs({})`. Its own `details` says the real default is `$TMPDIR` and `/tmp`, and on macOS `$TMPDIR` is non-empty.
   - It is not wrong enough to be a bug. The card should say `$TMPDIR, /tmp`, or the default thunk should be omitted and `details` carry it.

6. **Width.**
   - At 80 columns, the top-level list uses up to 108 columns, because the path column is padded to 42. The mcpServers line is 108 wide and wraps into the summary column.
   - Leaf `details` are single lines of up to ~2000 characters (`explain tools.writableDirs`). The terminal wraps them, so they are readable but not formatted.
   - **Fix:** wrap `details` and summaries at the terminal width, with a default of 80 and `process.stdout.columns` read only in `main.ts`, passed in so the formatter stays pure. Or accept it (the executor's own open question 4).

7. **README lost facts the old table had.**
   - The old row for `tools.writableDirs` said the env is `:`-separated and that empty means `[]`.
   - The old row for `readOnlyTools` listed the array form.
   - The old `maxTokens` row said "64000 for anthropic", and its Default column is now `—`.
   - The `baseURL` default now shows openai's only.
   - **Fix:** put the env format in `details`, where a card shows it; use the `Meaning` column for the one-liners that need it. Optional: `$schema` is listed as a top-level key and in `--all`; consider hiding it from `explain` (see O2).

### Owner questions

**O1. `explain` is now a subcommand, so a one-shot prompt that starts with "explain" no longer works.**
- Evidence: the two commands above. The edit to `session-flags.test.ts:75` is justified: it swapped the prompt-text example from `explain --plain` to `fix --plain`. It does not weaken anything, because the same assertion (a subcommand-looking word is prompt text) still runs on `fix`. It also records the behaviour change.
- The same trade-off already exists for `update`, `install`, `rm` and `ps`. A first word that names a subcommand is the subcommand.
- **Recommendation:** accept it. It is a natural-language word, so `explain how X works` will be typed. Add a one-line note in `README` and `HELP`: to send a prompt that starts with "explain", start it with another word (I did not check whether the repo has an explicit prompt flag). If the owner does not want that, the alternative is `tentacle config explain` (task 4 of the eval) and no `explain` top-level.

**O2. Should `$schema` be listed by `explain`?**
- It is accepted and ignored; the registry documents it as a user-only leaf. It shows in the top-level list and in `--all`.
- **Recommendation:** keep it. A user who finds it in their file can ask what it is. If the list should be only the keys that do something, filter it in `topLevelKeys` and keep it explainable by name.

### Mutations (§9)

| Test | Mutation | Result |
|---|---|---|
| T1 | A new schema key `subagents.fakeNewKey` added to `schema.ts` (backup, restore, shasum `2ccb87ea…` identical) | red: 2 fail (missing + kind) |
| T3 | `tools.redactSecrets` env changed to `TENTACLE_REDACT` in `key-docs.ts` (shasum `f3e3134a…` identical after restore) | red: T3 (`source default`) and T3b both fail |
| T4 | README `maxIterations` default 16 → 17 (shasum `4f05b78e…` identical after restore) | red: drift test fails |

`git status` was clean after each restore.

### Attacks tried

- **Secrets.**
  - `model.apiKey`, `model.apiKeyCommand`, `mcpServers.*.env.*`, `mcpServers.*.headers.*` are `secret: true`; `mcpServers.*.args` is `"values"`.
  - A card prints the marker and a placeholder example (`"sk-…"`, `"***"`, `"Bearer <token>"`). No path in the formatter takes a config value. Nothing found.
- **Never reads the user's config.** `explain` runs before `loadConfig` (`main.ts`), like `update`, and the formatter imports only the registry. I read the dispatch (`main.ts`) and `explain.ts`'s imports; I did not trace file access at runtime. The dedicated test (`explain-main.test.ts`) uses a broken `config.jsonc`. Nothing found.
- **Unknown key and typos.** `explain subagnts.maxParalel` gives `did you mean subagents.maxParallel?` on stderr, exit 1. `explain ""` gives exit 1 and a usage hint. `explain mcpServers.fs.env.TOKEN --json` resolves through `*` to the canonical path. Nothing found.
- **Levels.** Top level, section (direct children only; `mcpServers (8 sub-keys)`, `model (9)` counted correctly), leaf card, `--all` (flat sorted list of leaf paths) all behave as the owner's addition says. The formatter is pure: `explain.ts` has no I/O or `process` use, and it is unit-tested (`explain.test.ts`).
- **Profile mirror.** `profiles.*` is derived from the base entries. T1b pins it key for key, and the derivation overrides only `mcpServers.*` details. Nothing found.
- **Carried and flags.** T5 checks every `flag` against `ARGS`; T6 compares with `CARRIED` in both directions and per class. Sample cards match `carried-settings.ts`.

### What holds

- One registry, schema untouched, byte-identical protected files, 7 test groups that go red on the mutation of the fact they pin.
- Defaults come from the real `resolveConfig`; env names from its provenance. This is where a doc is most likely to rot, and it cannot.
- Residual risk the executor named and I agree with: prose (`summary`, `details`, `example`) and `type`/`values` are checked for shape, not truth. Finding 1 is exactly such an entry.

### How the executor behaved

- It followed the protocol: red before green, mutations with backup and shasum, drift recorded rather than the read-only files edited (it found the `redactSecrets` comment drift and left `schema.ts` alone, as the owner required).
- Its open questions in this section were honest and aimed at the right places.
- It missed: the `readOnlyTools` union (the one wrong entry), and the prompt regression; it noticed the second only as "a form a user would reasonably type" without measuring.
- It left an internal doc pointer in user-facing text (finding 4).

### Executor's suggested attack list (answered above)

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


## Review — round 2

*— claude-sonnet-5-5, 2026-11-08* (fresh context; the same model as the round-1
reviewer, a different family from the executor, deepseek-v4.1-flash)

**Verdict: PASS.** 0 HIGH · 0 MEDIUM · 0 LOW · 0 owner questions. Every
round-1 finding is fixed, tested, and the tests go red on my mutations.

### Gate (re-run)

- `bunx tsc --noEmit`: clean. `bunx biome check .`: 732 files, no fixes.
- `bun test packages`: **5510 pass · 3 skip · 0 fail** (5513 tests, 377 files). The 3 skips are the opt-in ones.
- Protected files: `git diff main...HEAD --stat` over `schema.ts`, `defaults.ts`, `resolve.ts`, `load.ts` is empty. The owner constraint holds.
- `bun run docs:config`: **not run** (it writes `README.md`; blocked here). Evidence instead: T4 (the committed block equals `renderConfigKeysTable()`) passes, so a run is a no-op. Unverified by execution; verify with `bun run docs:config && git status --short`.

### Round-1 findings

| # | Fixed? | Evidence |
|---|---|---|
| M1 `readOnlyTools` type | yes | `key-docs.ts` entry is `type: "enum \| array"`; `explain mcpServers.fs.readOnlyTools` prints `type enum \| array`, `values hint \| none`, and the `["read_file", "list_dir"]` example. New T1 test "type and values are the schema's" compares members against the walker. |
| M2 / O1 prompt words | yes | `explain how config works` → exit 1, `unexpected argument "config"` + `to send this as a prompt, use: tentacle -- explain how config works`. `explain "how does X work"` → exit 1, same hint, no "did you mean". HELP documents `--`. |
| L3 T1 message | yes | `missingEntries`/`extraEntries` say what to do and skip the derived `profiles.*` mirror; two tests pin the text. |
| L4 internal pointer | yes | The `redactSecrets` details no longer mention `docs/feat/…`. |
| L5 `writableDirs` default | yes | Card: `default the system temp dir ($TMPDIR) and /tmp`. Matches `defaults.ts:66` (`TMPDIR \|\| TMP \|\| TEMP \|\| /tmp`). |
| L6 width | yes | `renderExplainText(result, {width})`, 80 by default, `process.stdout.columns` read only in `main.ts`. Tests at 80 and 60 for every level and the long cards. |
| L7 README facts | yes | `envNote`, `defaultText`, richer summaries; a test lists 13 facts the old hand table had and checks each in the generated row. |
| O2 `$schema` | yes | Kept, listed last in `explain` (confirmed in the output), explainable by name. |

### Mutations (§9)

| Test | Mutation | Result |
|---|---|---|
| T1 type/values vs walker | `readOnlyTools` `type: "enum \| array"` → `"enum"` in `key-docs.ts` | red: `registry enum [hint\|none], schema array\|enum [hint\|none]`, for the base and the `profiles.*` path (1 fail). Restored; shasum `4e167e01…` identical. |
| 80-column wrap | `word.length <= limit` → `<= limit + 1` in `explain.ts` `wrap()` | red: 4 fail in `explain.test.ts` (width tests, e.g. the 60-column and path-wider-than-column ones). Restored; shasum `6516fde3…` identical. |

`git status` was clean after both restores.

### Re-sampled entries (not sampled in round 1)

`model.baseURL` (`resolve.ts:363-365`, `defaults.ts:5,7`: both URLs correct) ·
`model.maxTokens` (omitted for openai, 64000 for anthropic: `defaults.ts:134-136`) ·
`systemPromptFile` (`PROMPT.md` in the config dir, `load.ts:553,577-580`; the env
is inline, `load.ts:375`, `resolve.ts:391`) · `tools.writableDirs` (default and
`:`-separated env, `resolve.ts:184,486`, `defaults.ts:232-234`) ·
`subagents.execution` (default `parallel`, `defaults.ts:147`) ·
`subagents.maxParallel`, `subagents.enabled`, `tools.execution`,
`tools.redactSecrets`, `engine`, `tui.theme` (cards read; defaults pinned by T2/T3).
No wrong entry found.

### Output check

- `explain`, `explain subagents`, `explain tools.writableDirs`: read in full. Every line is ≤ 80 columns, wrapped under the summary column. `explain modle` → exit 1, `did you mean model?`.
- I could not run a script over *all* paths and widths (running a scratch file was blocked); the coverage is the executor's width tests (every level + the longest cards at 80 and 60) plus my mutation on `wrap()`, which they caught.

### Attacks tried

- A `defaultText` contradicting a value default: guarded by the new test (numbers/booleans only); no entry violates it.
- The prompt hint on a quoted sentence: `explain "how does X work"` is handled in the dispatch (`prompt: true`), not only in `parseArgs`. Works.
- `explain` reading the user's config: unchanged from round 1 (dispatch before `loadConfig`).
- A new prose lie in the changed summaries (`subagents.execution`, `tools.execution`, `readOnlyTools`): checked against `defaults.ts` and the round-1 reading. None.

### Notes (not findings)

- The card prints `` (`:`-separated; empty = `[]`) `` with nested backticks; cosmetic.
- `promptWords` drops words that start with `-` and does not shell-quote, so for a prompt with shell metacharacters the printed `tentacle -- …` line may need quoting. The common case (plain words) is exact.

### How the executor behaved

- It fixed all nine items in one commit, and added a test for each, including the stronger T1 I had suggested (a comparison with the walker) — the right answer to finding 1, not a patch of the one entry.
- It did not touch the protected files and did not widen scope. It put the O1 answer where the user needs it (the error), not only in HELP.
