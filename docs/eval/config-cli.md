# eval/config-cli — `tentacle explain` and `tentacle config` (set / get / list / unset)

> **Status:** eval — awaiting the owner's answers (Q1–Q9 below)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval → feat · **Size:** L if promoted, split into 5 tasks (below) · **Blast:** from `contained` (explain) to `cross-module` (registry, README gate) · the write path is `cross-module`, not load-bearing (no §7 invariant, no wire change) · **Suited:** per the split table

## Context

*— claude-sonnet-5-5, 2026-11-08*

**The question.** The owner (2026-11-08) wants two commands:

1. `tentacle explain [key.path]`: no argument lists every settable key with a
   one-line summary. With a key it shows meaning, type, allowed values, default,
   env var, CLI flag, whether it is carried to a pod/serve, profile and
   project-config scope, and an example. Nested keys work (`tools.writableDirs`,
   `subagents`).
2. `tentacle config key.subkey=<value>`: sets a value in the config.

Decide: where the key docs live (one source), how `config` writes safely, what
secrets do, and how the work splits. Verified on `main` @ `bcdb956`; nothing was
run, all by reading.

### What exists today (verified)

- **The user file** is `<configDir>/config.jsonc` (`defaults.ts:73`
  `CONFIG_FILENAME`). The dir is `TENTACLE_CONFIG_DIR` > `XDG_CONFIG_HOME` >
  `~/.config/tentacle` (`load.ts:455-466`). The first run scaffolds a fully
  commented template (`load.ts:555-559`, `DEFAULT_CONFIG_JSONC` at
  `defaults.ts:97`). So the file **has comments**, and a user edits it by hand.
- **JSONC is parsed with `jsonc-parser`** (`load.ts:10`), already a dependency of
  `@tentacle/config` (`packages/config/package.json:11`). That library also has
  `modify` + `applyEdits`, which edit text in place and keep comments, order and
  indentation. Not used yet; the API is from the library's docs, not yet
  exercised here.
- **Read without side effects:** `readFileConfig` (`load.ts:51`, exported through
  `index.ts:15`) parses, validates and folds the profile and does *nothing else*:
  no scaffold, no prompt file, no `apiKeyCommand` run (`load.ts:48-50`). The new
  commands must use this seam, never `loadConfig`, which runs the key command
  (`load.ts:516`) and scaffolds. `tentacle update` already does the same
  ("must work even when config.jsonc is broken", `main.ts:542-543`).
- **Validation:** `FileConfigSchema` is `.strict()` (`schema.ts:402-410`), every
  nested object too. An unknown key is an `unrecognized_keys` issue; the loader
  reports only `issues[0]` (`load.ts:85-90`).
- **Profiles** live inside the same file under `profiles.<name>` with the same
  settings (`schema.ts:393-409`). `--profile` is a flag of session-starting
  commands only (`docs/feat/config-profiles.md`, amended 2026-11-03).
- **Config is read once at start**, not hot-reloaded. A context reset re-reads
  prompt and skills, not `config.jsonc` (`load.ts:276-279`; project-config eval
  rule 7).

### What `bun run schema:export` is

It is **the protocol, not the config**. `package.json:19` runs
`packages/protocol/src/json-schema.ts`, which writes
`packages/protocol/schema/protocol.json` from `@tentacle/protocol` (header,
`json-schema.ts:1-23`). The config schema is not exported: there is no
`config.schema.json`, although `$schema` is accepted "so editors can offer hints"
(`schema.ts:404-405`) and points at nothing. `zod-to-json-schema` is used by the
protocol package only. `.describe(` appears **nowhere** in `packages/config/src`
(grep, 0 hits). So today no description reaches any machine-readable output; the
docs are `/** */` comments (`schema.ts`), which only a reader of the source sees.

### The docs live in four hand-kept places, and they have drifted

| Place | What | Drift found |
|---|---|---|
| `schema.ts` `/** */` | meaning, defaults in prose | `:354` says `redactSecrets` "Default: enabled"; `DEFAULT_REDACT_SECRETS = false` (`defaults.ts:47`). `defaults.ts:221` says "Off by default" (right). Already noted in `docs/eval/project-config.md` Notes |
| `defaults.ts` `DEFAULT_CONFIG_JSONC` (`:97-256`) | commented template, uses the `DEFAULT_*` constants | the only copy that interpolates constants (so it cannot drift on values) |
| `resolve.ts` | env names, inline, one `parseX` per key (`:356-496`) | 27 distinct `TENTACLE_*` names; no table |
| `README.md:297-340` | table of ~20 keys | 10 env names checked (`TENTACLE_AUTO_WAKE`, `_REDACT_SECRETS`, `_DEDUP_OUTPUT`, `_TABULATE_JSON`, `_SUMMARIZE_OUTPUT`, `_MAX_OUTPUT_CHARS`, `_TOOL_OUTPUT_RETENTION_DAYS`, `_CONTEXT_WINDOW`, `_SUBAGENT_MAX_ITERATIONS`, `_NO_AGENTS_MD`): **0 appear in the README**. Its precedence line (`:299`) omits profiles |

The schema has about 42 leaf keys plus three maps (`profiles`, `mcpServers`,
`packages`) and the element fields of `hooks` and of an MCP server.

**Repro** (the capability is missing): `tentacle explain` and `tentacle config`
are not subcommands (`flags.ts:519-541` lists the dispatch set: `hooks`,
`package`, `install`, …). Not run. The executor re-runs
`bun packages/cli/src/index.ts explain` on current `main` before any edit.

## Analysis

*— claude-sonnet-5-5, 2026-11-08*

### A1. Single source of truth for key docs

Facts per key that `explain` needs, and where each comes from today:

| Fact | Today | zod can hold it? |
|---|---|---|
| type, allowed values, ranges | the schema | yes (derivable) |
| meaning, example | comments | `.describe()` text only |
| default | `DEFAULT_*` constants (`defaults.ts:5-57`) | no (some are computed: `defaultWritableDirs`, `defaults.ts:65`; the base URL follows the provider, `resolve.ts:362-364`) |
| env var | inline in `resolve.ts` | no |
| CLI flag | `flags.ts` `ARGS` specs | no |
| carried to a pod | `CARRIED` table (`carried-settings.ts:42`, 21 keys, class P/W) | no |
| scope (file / profile / project) | `settingsShape` shared by profile and file (`schema.ts:188`, `:393-399`); project-config class L/P/W/C is in the project-config eval, not code | no |

**Options.**

- **(a) `.describe()` on every zod leaf.** Text sits next to the shape and
  `zod-to-json-schema` would carry it into a JSON schema. But env, flag, carry
  and scope are not zod concepts, so a registry is needed anyway: two places per
  key. Walking `McpServerSchema` (a `preprocess` + `discriminatedUnion`,
  `schema.ts:99-105`) and `superRefine` objects for descriptions is the fragile
  part; whether `zod-to-json-schema` handles them was not verified.
- **(b) one typed registry, all docs in it (recommended).** A new
  `packages/config/src/key-docs.ts`: `Record<KeyPath, KeyDoc>`, with
  `KeyDoc = { summary, details?, example, env?, flag?, carried?: "pinned"|"workspace"|"no", scope, secret?, default?: () => unknown, kind? }`.
  The schema keeps shape and validation only. The `/** */` comments in
  `schema.ts` shrink to a pointer. Map keys use a `*` segment (`profiles.*.model`).
- **(c) generate docs from the schema comments.** Needs a TS-AST parse. Rejected:
  heavier than (b) and still no env or flag.

**Why (b):** one place holds everything `explain` prints; the entries are
declarative data, so a test can pin them against the code (A2). `.describe()` can
still be *emitted* later: a generator injects the registry's `summary` into the
JSON schema by path.

**Pinning (the "no key missing" test).** A pure walker lists the schema's
leaf paths (descend `ZodObject`, unwrap `optional`/`effects`, `ZodRecord` →
`*`, `ZodArray` → leaf). Test T1: `leafPaths(FileConfigSchema)` equals
`Object.keys(KEY_DOCS)` minus the entries marked `group: true`. Adding a schema
key without docs fails; so does a stale doc entry.

**JSON schema for editors.** Out of scope for the first tasks, but cheap after
the registry: `bun run config:schema` writes `config.schema.json` from the zod
schema with descriptions injected from the registry, plus a drift test like the
protocol's. Then `$schema` finally points at something. Own task (see split).

**README table.** Generate it. Put `<!-- config-table:start/end -->` markers
around the table; `bun run docs:config` rewrites between them from the registry;
test T4 reads `README.md` and fails if the block differs from the generated text
(the same shape as the protocol schema drift test). The long `writableDirs` prose
(`README.md:318`) moves into that entry's `details`; the table keeps `summary`.
The table also gains every key the README lacks today. This replaces the
hand-kept table, so it is a doc change bundled with code (rides the code branch,
AGENTS §10).

### A2. Defaults, env vars, flags without a second hand table

The registry **is** the one table; the question is how tests pin its facts to
the code that really behaves:

- **Default.** `default` is a thunk over the same `DEFAULT_*` constants
  (`import { DEFAULT_MAX_ITERATIONS } from "./defaults.ts"`). T2: for every
  entry with a `resolved` accessor, `resolveConfig({fileConfig: {}, env: {}, …})`
  returns that default. This pins the 29 keys in `ResolvedConfig.sources`
  (`resolve.ts:~125-155`). Keys outside `sources` (`engine`, `rm`, `tui.theme`,
  `detach.keepAwake`, `mount.*`) have a documented `default` text only ("unset →
  CLI default"), as `resolve.ts:116-124` already says.
- **Env.** T3: for each entry with `env`, run `resolveConfig` with
  `{[env]: <valid example>}` and assert the field's `source === "env"`. A wrong
  or misspelled env name fails. The reverse direction (an env read in
  `resolve.ts` that no entry names) is a text check: T3b greps
  `TENTACLE_[A-Z_]+` in `resolve.ts` + `load.ts` and requires each to appear in
  the registry or in a short `NON_KEY_ENV` list (`TENTACLE_PROFILE`,
  `TENTACLE_CONFIG_DIR`, …). That is a grep-style test, acceptable here because
  the alternative is a second table.
- **Flag.** `flag` text per entry (`--profile`, `--model`, `--engine`,
  `--rm`, `--context-window`, `--auto-title`). T5: each named flag exists in
  `flags.ts` `ARGS`. Needs the registry to live where `flags.ts` is visible: the
  test sits in `packages/cli/test`, the registry in `config`. Fine, `cli` imports
  `config`.
- **Carried.** T6: `Object.keys(CARRIED)` (21) equals the keys whose entry has
  `carried !== "no"`. Free once the registry exists.

### A3. `config` semantics

**Which file.** Default: **the user file `<configDir>/config.jsonc`**, the only
file there is today. Flags:

- `--profile <name>` writes under `profiles.<name>.` of the same file. Profiles
  are inside the user file, not separate files (`schema.ts:408`), so there is no
  second path. It must be a flag *after* the command, like the other session
  flags (config-profiles amendment).
- **Project config** (`.tentacle/config.jsonc`) does not exist in code; it is the
  open eval. Until Q1 of `project-config.md` is answered, `config` has **no**
  project target. If Q1 = yes, add `--project` later as a separate small task;
  it must accept only the W allowlist and refuse the rest with the same message
  the loader gives (so `config` never writes a file the loader would then
  ignore). `explain`'s scope line is written from the registry's `scope` field
  now ("user file, profile") and gains "project" per Q6 and Q11 when decided.
- A running session is not touched: see A6.

**Value parsing.** `tentacle config key=value`: split at the **first** `=`.
The value is parsed by the schema's type for that key, not by guessing:

| Key type | Accepts | Example |
|---|---|---|
| boolean | `true`/`false` | `autoWake=false` |
| integer | decimal | `maxIterations=-1` |
| enum | a listed value | `tools.execution=parallel` |
| string | raw text; no quotes needed | `model.baseURL=http://localhost:8080/v1` |
| array | a JSON array, or `a:b` is **not** split | `tools.writableDirs='["/tmp","~/x"]'` |
| object / map entry | a JSON object | `mcpServers.fs='{"command":"mcp-fs"}'` |

Rule: if the leaf's schema is boolean/number, parse that way; if string, take
the text as is; if array or object, `JSON.parse` the text. A JSON string with
quotes (`"a:b"`) for a string leaf is accepted too (starts with `"` and parses),
so a leading quote never silently becomes part of a path. Because the type comes
from the schema, `maxIterations=true` is a type error, not a stored string. The
walker from A1 gives the leaf schema; no separate type table.

**Unset.** `tentacle config --unset key` (and `tentacle config unset key`), not
`key=`. `key=` is a legal empty string for a string key (the schema's `min(1)`
rejects it, so an empty value is an error, with a hint to use `--unset`). `null`
is not a value in this schema, except inside a profile's `mcpServers`
(`schema.ts:396`), which the map rule below covers (`--null`, see A5).

**Validate before write.** Steps: read the file text → `parse` (jsonc-parser) →
apply the change to the parsed object in memory → `FileConfigSchema.safeParse` →
only on success compute the text edit and write. On failure print the schema
message (all issues, not only `issues[0]` as the loader does, `load.ts:85`) and
exit 1 with the file untouched. The same check runs on the *whole* result, so a
cross-field rule (`agentTaskDescription` vs `…File`, `schema.ts:250-260`) is
enforced too.

**Keep formatting, order and comments.** The format allows comments (the
scaffold is full of them), so a `JSON.stringify` rewrite would erase the user's
notes. Use `jsonc-parser`'s `modify(text, path, value, {formattingOptions})` +
`applyEdits`: it edits only the touched node, appends a new key at the end of its
object, and leaves everything else byte for byte. A new top-level section is
added after the last existing key. Consequence: the scaffold's commented
`// "maxIterations": 16,` stays as is, and a set adds a real line below the
block, not in place of the comment. Acceptable; say so in the output. Verify with
a round-trip test (T10).

**Atomic write.** Temp file in the same directory + `rename`, mode of the
original (default `0600` for a new one since it may hold a key). The repo has the
pattern several times: `run-state.ts:143` `writeAtomic`, `kept-index.ts:55-61`,
`session-store.ts:516`; the write-tmpdir feature's atomic replace is for agent
tools, not reusable here. Reuse `run-state.ts`'s helper if it is exported, else
the 10-line pattern; do not import the tool's. A symlinked `config.jsonc` (a
dotfiles repo) must be written **through** the link: `realpath` first, rename
the temp over the real file, never replace the link. Refuse a path that is not a
regular file.

**Also `get` and `list`?** Yes, small and they share the reader:

- `tentacle config get key` prints the value **as stored in the file** (or
  "not set in <file>" with the default shown). One line, machine-friendly
  (`--json`).
- `tentacle config list` prints the keys set in the file, one `key = value` per
  line, secrets masked. `--profile x` lists that profile.
- `tentacle config path` prints the file path (useful with the scaffold).

`tentacle config key=value` stays the owner's literal form (the argument has an
`=`); `tentacle config set key value` is the same thing and `set`/`unset`/`get`/
`list`/`path` are words, so no key collides (no key is named `get`). A key path
never contains `=` or a space, so the two forms are unambiguous.

### A4. Secrets

Secret keys: `model.apiKey` (a literal key, `schema.ts:37`); `model.apiKeyCommand`
(not a secret itself but it runs code and may embed one: `pass show x` is fine,
`curl -H "Authorization: Bearer sk-…"` is not); `mcpServers.*.env.*` and
`mcpServers.*.headers.*` (e.g. `Authorization: Bearer …`, `schema.ts:73`, `:87`);
`mcpServers.*.args` (a token passed as an argument). The registry marks each with
`secret: true` (for a map of values, `secret: "values"`). T7 pins: `apiKey` is
secret.

- **Never printed.** `explain` prints docs and an example with a placeholder
  (`sk-…`); `get`/`list` print `***` for a secret leaf (and for every value under
  `env`/`headers` of an MCP server, plus `args` entries that look like a
  secret are not guessed, they are masked wholesale: `args: [***]`). `--reveal`
  is not offered; a user opens the file. `ResolvedConfig` already keeps secret
  values out of `sources` ("never includes secret values", `resolve.ts:~123`),
  the same rule.
- **Setting a secret.** `tentacle config model.apiKey=sk-…` leaks into shell
  history and `ps`. Rule: for a `secret` leaf the value must **not** come from
  argv. Accepted forms: `tentacle config model.apiKey -` (read stdin to EOF,
  trim one trailing newline); with no value on a TTY, a hidden prompt; a plain
  `key=value` for a secret leaf is refused with the safe forms and an advice to
  prefer `apiKeyCommand` (`schema.ts:33-37` already discourages `apiKey`). The
  warning also appears on a successful set: "stored in plaintext in <path>, mode
  0600". `--allow-argv-secret` is not provided (nothing to opt into).
- **File mode.** If the existing file is group/world readable and the key being
  set is `apiKey`, warn (do not chmod silently).
- **Errors never echo a value.** A type error on a secret leaf names the key
  only.

### A5. Map keys

Notation in `explain` and in messages: `*` for the free segment: `profiles.*.model`,
`profiles.*.model.model`, `mcpServers.*.command`, `packages.*`,
`subagents.types.*.model` (planned, `subagent-live.md` C1/Q6: `models.*` map and
`subagents.types.<t>.model`, plus `subagents.selectableModels`). `explain
mcpServers.fs.command` resolves `fs` against `*`; `explain mcpServers` explains
the map and lists `mcpServers.*.<field>`.

`set` creates entries by path: `config profiles.work.model.model=x` creates
`profiles.work` and `model` when missing (jsonc-parser `modify` creates the
parents). Rules:

- A map entry's **name** is validated as a plain name (`[A-Za-z0-9_.-]`, non-empty)
  to keep the dotted path unambiguous. A name containing `.` cannot be addressed
  with the dotted form today (profile `a.b`); allow a bracket form
  `profiles["a.b"].model` later, not now (debt).
- Creating an `mcpServers.<name>` from one leaf (`mcpServers.fs.command=mcp-fs`)
  is valid: `McpServerSchema` infers `type` (`schema.ts:99-105`). Creating one
  from `…url=` infers `http`. Whole-object set is the JSON form.
- `--null` sets `null`, valid only for `profiles.*.mcpServers.*` (removes the
  base server for that profile, `profile.ts:25-33`); the schema decides, the CLI
  does not special-case it.
- `config --unset profiles.work` removes the whole profile; it asks for
  confirmation on a TTY unless `--yes` (it destroys config).
- The final path segment must exist in the schema for a closed object (typo →
  nearest suggestion, below); under a `*` segment any name is fine.

### A6. Live session, serve, pod

Config is read **once at start** of each process (`load.ts:276-279`). So a
change **never** applies to a session that is already running. `config` prints
what it applies to, derived from the registry's `carried`/`scope`:

- "Applies to sessions started after this. A running `serve` daemon keeps its
  value until restarted." (`serve` reads at start.)
- Carried keys (`carried !== "no"`): "On `run`/`attach` the laptop's value is
  carried to the pod when a session is opened; existing sessions keep theirs"
  (`session.ts:394`, config-carry).
- Not-carried keys (e.g. `tools.writableDirs`, `README.md:318`; `tui.theme`):
  "Not carried: a pod uses its own."
- `connect` clients: the value is the `serve` host's; `config` on the laptop
  changes nothing there (`connect` sends nothing, project-config eval table).

`explain` shows the same facts as static text; `config` prints one line after a
successful write. No hot reload is proposed here.

### A7. Precedence: show the effective value

`explain <key>` stays **static**: docs only, no I/O except reading the registry,
so it works with a broken config and in CI. The effective value and its origin
is a **separate command**: `tentacle config show [key] [--profile x] [--origin]`.
It uses `loadConfig`-free parts: `readFileConfig` + `resolveConfig` (pure) with
the process env, and prints `value  (source)` per key. `Source` today is
`env | file | default | carried` (`resolve.ts:40`); a profile value is reported as
`file` because the fold erases it (`profile.ts:56-58`). To show "profile" the
fold needs to tag which keys came from the profile: a small change in
`applyProfile`'s output (a `fromProfile: Set<path>` side result), not in
`resolveConfig`. `repo`/`container` come with `feat/project-config`
(its rule 10 adds them to `Source`). So `--origin` is **phase 2**: first
`config show` with `env|file|default`, then profile, then project as the sources
exist. Secrets are masked in `show` as in `list`. This is not `explain`'s job:
`explain` answers "what does this key mean", `show` answers "what is it right now".

### A8. Nearest-key suggestion

Unknown key → list candidates by edit distance over the registry's paths (with
`*` matching): `unknown key "tools.writableDir"; did you mean tools.writableDirs?`
(Levenshtein ≤ 2 or shared prefix; at most 3 suggestions). A pure function in the
same module as the walker; the same function serves `explain`, `get`, `set`.

## Interaction with `docs/eval/project-config.md`

This task does not decide Q1, Q5–Q11. How it touches them:

- **Q1 (repo file at all):** only decides whether `--project` ever exists. The
  commands work fully without it. The registry gets a `scope` field now with
  values `user | profile`, plus `project` filled in later.
- **Q2/Q3 (task-7 pin, carry W):** none; `carried` is read from the existing
  `CARRIED` table (`carried-settings.ts:42`), pinned by T6.
- **Q5 (per-repo model):** `explain model.model` will say "project: no" or "yes"
  from the registry. If Q5 flips, one registry field changes.
- **Q6 (profile vs repo order):** only matters to `config show --origin`
  (phase 2). `explain` states the order text from one string in the registry
  header.
- **Q7 (invalid repo file ignored):** `config --project` must refuse to write
  anything the loader would ignore. Needs the allowlist from `ProjectConfigSchema`
  (the project-config slice 2); until then no `--project`.
- **Q8 (discovery):** `config --project` writes to the git root's
  `.tentacle/config.jsonc`, same rule; `config path --project` prints it.
- **Q9 (MCP):** `explain mcpServers` says "C-class: user file only; never in a
  repo file". Registry text, changes with the answer.
- **Q10 (sub-agent definitions):** none (definitions are `.md` files, not keys).
- **Q11 (`loadProjectConfig` opt-out key):** a new key lands in the schema and is
  caught by T1 until documented. Good: the pin does its job.

`docs/eval/subagent-live.md` adds `models.*`, `subagents.types.*.*`,
`subagents.selectableModels`; each lands with its registry entry or T1 fails.
That is the rule going forward: **a schema key without an entry does not merge**.

## Failure modes

| Case | Outcome |
|---|---|
| Invalid existing file (syntax) | `get`/`list`/`set` refuse with the file path and the parse error (`load.ts`'s `parseConfigFile`); **no write**. `explain` ignores the file entirely and still works. |
| Existing file fails the schema (e.g. an old unknown key) | `set` refuses: writing would leave an invalid file; message names the offending key and says fix by hand or `--unset` it. `--unset` of the broken key itself is allowed (validate the *result*). |
| Unknown key | Error with up to 3 nearest suggestions; nothing written. |
| Type error / out of range | The schema's message (all issues), `key` named, value omitted for secrets; nothing written. |
| Missing config dir / file | `set` creates the dir (`mkdir -p`, `0700`) and the file; a new file starts as `{}` + the key, **not** the commented scaffold (that is `loadConfig`'s job on the next run; the scaffold only creates a file that is missing, `load.ts:557`). `get`/`list` on a missing file: "no config file at <path>", exit 0 for `list`, 1 for `get` of an unset key. |
| Read-only file or dir | `EACCES`/`EROFS` surfaced with the path and no temp file left; exit 1. |
| Concurrent edit (editor open, or two `config` runs) | Read-modify-write window. Write only if the file's mtime+size is unchanged since the read (re-stat right before `rename`); else retry once from the re-read, then fail "changed while editing". An editor with the file open can still overwrite a later save; documented, not locked (a lock file would be new state for a rare case). |
| Symlinked config | Written through the link (A3). |
| Config on a pod | `config` edits the laptop's file only; it never dials a pod. |
| Secret via argv | Refused (A4). |
| Key is `$schema` | Allowed as a string; `explain` says it is ignored. |
| Value looks like JSON but key is a string | Taken as text (type from schema), so `model.model='"x"'` stores `"x"` with quotes only if the user gives a JSON string; documented in `--help`. |
| `profiles.x` set while `--profile` also given | Error: the path already names a profile (ambiguous). |

## Proposed split into tasks

*— claude-sonnet-5-5, 2026-11-08*

In dependency order. No XL. Nothing here touches the protocol, persistence or
a §7 invariant, so none is `load-bearing`; the config loader is only *read*
(`readFileConfig`) and the schema is not changed, but T1's pin touches every
future schema edit, hence `cross-module` for the registry.

| # | Task | Size | Blast | Suited | Notes |
|---|---|---|---|---|---|
| 1 | `feat/config-key-docs`: `key-docs.ts` registry (~45 entries), the schema leaf walker, nearest-key function, tests T1–T6, comments in `schema.ts` shortened to pointers; fixes the `redactSecrets` comment drift | L | cross-module | strong model; Review fresh-context (it gates all later schema edits) | The big one: writing ~45 accurate entries. Could split by section (model/tools/subagents/...) but it is one file and one pin; keep as one L. |
| 2 | `feat/explain-cmd`: `tentacle explain [key]`, list + detail + map `*` + suggestions, plain output, `--json` | M | contained | weaker model OK; standard Review | New subcommand in `flags.ts` dispatch + a pure formatter. No file I/O. Needs 1. |
| 3 | `feat/config-readme-gen`: markers in `README.md`, `bun run docs:config`, drift test T4; optional `config.schema.json` export + test | M | cross-module | any; standard Review | Docs bundled with code. Needs 1. Can run parallel to 2. |
| 4 | `feat/config-set`: `config set/unset/get/list/path`, jsonc `modify` edit, validate-before-write, atomic write, masking, stdin secret, map creation, tests T7–T12 | L | cross-module | strong model; mandatory fresh-context Review (writes the user's only config; secrets) | Needs 1 (types from the walker, secret flags). Could split `get/list` (S) from `set/unset` (M) if the owner prefers smaller branches. |
| 5 | `feat/config-show`: `config show [key] [--origin]`, profile tagging in `applyProfile`, later `repo`/`container` | M | cross-module | any strong; standard Review | Needs 4's reader; the profile tag touches `profile.ts` (pure, tested). `--origin` repo parts wait for `feat/project-config`. |

One code task at a time (AGENTS §10): they run 1 → 2 → 3 → 4 → 5, each merged
before the next. Task 1 should wait for the in-flight `feat/session-log-laptop-store`
to merge if it touches `schema.ts` (it should not; check at start).

### Tests the plan must name

- **T1** leaf-path set of `FileConfigSchema` equals the registry keys (mutation:
  add a schema key; remove an entry).
- **T2** defaults: `resolveConfig` on empty input equals each entry's `default`.
- **T3/T3b** env: each named env sets `source: "env"`; every `TENTACLE_*` read in
  `resolve.ts`/`load.ts` is in the registry or `NON_KEY_ENV`.
- **T4** README block equals the generated block.
- **T5** each named flag exists in `ARGS`. **T6** `CARRIED` keys equal the
  registry's carried set. **T7** `model.apiKey`, `mcpServers.*.env/headers` are
  marked secret.
- **T8** `set` refuses before writing: type error, unknown key (with
  suggestion), cross-field error; file bytes unchanged (compare hash).
- **T9** a secret via argv is refused; via stdin accepted; `list`/`get` print
  `***`; an error message never contains the value (assert on the whole output).
- **T10** round trip: a file with comments, odd indent and key order, after a
  `set` and an `--unset`, differs only on the touched node.
- **T11** atomic: the rename is the only visible change (inject an fs that
  fails the rename; no temp file left, target intact); a symlink target keeps
  its link; read-only → clean error.
- **T12** concurrent: the file changed between read and write → retry then fail,
  no lost edit. Use an injected clock/fs, not real timing.

Each fix-style test is shown failing first (AGENTS §9); T8–T12 are mutation
checked (e.g. validate after write → T8 red).

## Owner questions

*— claude-sonnet-5-5, 2026-11-08*

**Q1. Where do key docs live?** (a) `.describe()` on zod leaves + a registry for
the rest; (b) one registry holding all docs, schema holds shape only, pinned by
T1; (c) keep comments. **Recommend (b)**: one place for everything `explain`
prints; zod cannot hold env/flag/carry; (a) has two places per key.

**Q2. README config table: generated?** (a) generated between markers + drift
test; (b) hand-kept with a check that every key appears; (c) leave. **Recommend
(a)**; the table already lacks keys and env names.

**Q3. Default target of `tentacle config key=value`?** (a) the user file, with
`--profile x` for a profile; (b) the active profile if `TENTACLE_PROFILE` is set;
(c) a prompt each time. **Recommend (a)**: explicit and predictable; an env var
silently redirecting writes is a trap. No project target until
`project-config` Q1 is answered.

**Q4. Unset syntax?** (a) `--unset key` / `config unset key`; (b) `key=` means
unset; (c) `key=null`. **Recommend (a)**: `key=` collides with an empty string
and `null` is a real value only in profile `mcpServers`.

**Q5. Value parsing?** (a) typed by the schema leaf (bool/number/string as is,
array/object as JSON); (b) always JSON (`name='"x"'`); (c) always string. **Recommend
(a)**: no quoting for the common case, and a wrong type is an error.

**Q6. Secrets set via argv?** (a) refuse, accept stdin (`-`) or a hidden prompt;
(b) accept with a warning; (c) no way to set a secret via the CLI. **Recommend
(a)**; plus a pointer to `apiKeyCommand`.

**Q7. Command surface?** (a) `explain` + `config set/unset/get/list/path` and the
literal `config key=value`; (b) only `explain` and `config key=value`; (c) add
`config show --origin` in the same release. **Recommend (a)** now, `show` as
task 5 later: `get`/`list` are tiny, share the reader, and the owner will want
them the first time a set goes wrong.

**Q8. Is the effective value (with origin) part of `explain`?** (a) no, a
separate `config show --origin`; (b) yes, `explain key` also prints "current:
… (file)". **Recommend (a)**: `explain` stays static, offline and safe on a
broken config; `show` reads files and env and needs masking.

**Q9. Edit style: preserve comments and layout (jsonc `modify`) or rewrite the
file?** (a) preserve; (b) rewrite as plain JSON, with a warning that comments are
lost. **Recommend (a)**: the scaffold is a commented guide the user reads; a
rewrite would erase it on the first `set`. Cost: depends on `jsonc-parser`'s
edit API (already a dependency); T10 pins it.

## Implementation

*(empty until promoted)*

## Execution

*(empty until promoted)*

## Review

*— claude-sonnet-5-5, 2026-11-08 (author; not a fresh-context review)*

**Verdict: open, awaiting the owner's answers (Q1–Q9).**

Checked by reading `main` @ `bcdb956`: the schema, `resolve.ts` env reads,
`load.ts` read/scaffold paths, `readFileConfig`, `schema:export`'s real target,
the README table, the project-config and profile docs. **Not checked:** nothing
was run. Unverified, each with its cheap test:

- `jsonc-parser`'s `modify` keeps comments and indentation as assumed — a
  10-line script on the scaffold file (the first step of task 4).
- `zod-to-json-schema` copes with `McpServerSchema` (preprocess + union) — one
  call in task 3.
- `.optional()` after `.describe()` keeps the text (only if Q1 = (a)).
- The README "0 of 10 env names" count is a grep of 10 hand-picked names, not a
  full audit; task 1's T3b is the full one.
- The `run-state.ts:143` helper may not be exported; task 4 checks.

Weak points for the Review that task 4 needs: secret handling end to end (shell
history, `ps`, error text, `list`), the read-modify-write race, and the
symlinked-config case.

## Owner answers

*— claude-opus-5-5 (orchestrator, recording the owner's answers), 2026-11-08*

All nine follow the recommendation:
- **Q1: (b).** One registry holds every key's docs; the schema holds shape only; pinned by T1.
- **Q2: (a).** The README table is generated between markers, with a drift test.
- **Q3: (a).** `config` writes to the user file by default; `--profile x` targets a profile; no project target until `project-config` Q1.
- **Q4: (a).** Unset is `config unset key` / `--unset key`.
- **Q5: (a).** A value is typed by the schema leaf: bool, number and string as is, arrays and objects as JSON.
- **Q6: (a).** A secret given on argv is refused; it is read from stdin (`-`) or a hidden prompt, with a pointer to `apiKeyCommand`.
- **Q7: (a).** `explain` + `config set/unset/get/list/path` + the short form `config key=value`; `show --origin` is task 5. The owner likes the `set`/`unset` pair.
- **Q8: (a).** `explain` stays static; the effective value and its origin go to `config show --origin`.
- **Q9: (a).** Comments, layout and key order are preserved (jsonc `modify`).
- **Added by the owner (2026-11-08): `explain` navigates by level.**
  - `tentacle explain`: the top-level keys only, one line each, with a count of sub-keys for a section (`subagents … (7 sub-keys)`).
  - `tentacle explain <section>` (e.g. `subagents`, `model`): the section's summary and its DIRECT sub-keys, one line each, with the default when short. A map is shown as `types.*`.
  - `tentacle explain <leaf>` (e.g. `subagents.maxParallel`): the full card (meaning, type, allowed values, default, env, flag, carried, scope, example).
  - `tentacle explain --all`: the flat list of every leaf, for grep.
  - The registry needs a summary for section nodes too, not only leaves; T1 also pins that every section has one. Part of `feat/explain-cmd` (task 2), with the section summaries in task 1.
