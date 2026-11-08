# feat/config-set — `tentacle config set/unset/get/list/path` (jsonc-preserving edits, secrets, atomic write)

> **Status:** implementation → execution → review → **round 2 (review fixes) → re-review**
> **Branch:** `feat/config-set` (stacked on `feat/config-explain`, not yet merged)
> **Type:** feat · **Size:** L · **Blast:** cross-module · **Suited:** strong model; mandatory fresh-context Review (writes the user's only config file; secrets)

## Context

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

Task **4** of `docs/eval/config-cli.md` (owner answers recorded there,
2026-11-08), and only task 4: `config show --origin` is task 5 and is **not**
here. It builds on task 1 (`packages/config/src/key-docs.ts`: one registry per
key, `secret`/`carried`/`scope`/`type`) and task 2 (`packages/cli/src/explain.ts`:
the level navigation, `nearestKeys` reuse, the `out`/`err` split), both on the
parent branch `feat/config-explain`.

**What the eval binds** (sections A3, A4, A5, A6, "Failure modes", T8–T12):

- **Owner Q3 = (a).** `config` writes the user file `<configDir>/config.jsonc`;
  `--profile <name>` targets `profiles.<name>.` **in the same file** (profiles
  live inside the user file, `schema.ts:393-400`); no project target.
- **Owner Q4 = (a).** Unset is `config unset <key>` / `--unset <key>`; `key=`
  is a legal empty value (which the schema then rejects: a string leaf is
  `min(1)`, `schema.ts:37`), with a hint to use `unset` instead.
- **Owner Q5 = (a).** The value is typed by the **schema leaf**: boolean/number
  parsed, string taken as is (a leading `"` that parses as a JSON string is that
  string), array/object as JSON.
- **Owner Q6 = (a).** A secret given on argv is **refused**; accepted from stdin
  (`-`) or a hidden prompt, with a pointer to `apiKeyCommand`.
- **Owner Q7 = (a).** `explain` + `config set/unset/get/list/path` + the
  shorthand `config <key>=<value>`.
- **Owner Q9 = (a).** Comments, layout and key order are preserved (jsonc
  `modify`), verified by T10.

**The capability is missing:**

```
$ bun packages/cli/src/main.ts config list
[error] unknown option --config        ← `config` is not a subcommand
$ bun packages/cli/src/main.ts --help | grep -c 'tentacle config'
0
```

(the run is in Execution; `cliMode`'s word list is `flags.ts:516-527`, and
`ARGS`/`USAGE` have no `config` entry).

**Repro / first experiment (the eval's own open question, now answered).** The
eval's Review lists "`jsonc-parser`'s `modify` keeps comments and indentation as
assumed" as **unverified**, with "a 10-line script on the scaffold file" as the
cheap test. Run first (`.tentacle/tmp/config-set/probe-modify-proof.ts`, output
pasted in Execution): on the real commented scaffold, every op changes **only
the touched node** — the shared prefix and suffix are byte-identical (e.g. a new
`subagents.maxParallel` inserts exactly `"subagents": {\n "maxParallel": 3\n},\n`
after the last existing key), a change to an existing leaf changes only the
literal (`"qwen3"` → `"qwen3-coder"`), and a set→unset round trip is **identical
to the original text**. So the eval's assumption holds; the plan stands.

Two more facts the probe established, which the design must respect (they are
`jsonc-parser` 3.3.1 behaviour, not opinion):

- `modify` **throws** on a non-object document (`Can not add index to parent of
  type number`) and on a delete from an empty document — so the edit planner
  must parse and refuse first, never let the throw escape.
- `modify` with `insertSpaces: true, tabSize: 2` on a **tab-indented** file
  emits *mixed* indentation for the new node (`\t...` original, two spaces new).
  So the planner must **detect** the file's indent (`tabSize`/`insertSpaces`)
  and EOL and pass them in.

## Implementation

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

### Load-bearing assumption

**A text edit computed from the parsed document can be validated *before* the
write, and the written text can be re-parsed to prove it equals the value that
was validated.** Two separate code paths touch the value — the in-memory apply
(what `FileConfigSchema` validates) and `jsonc-parser`'s `modify` (what lands on
disk) — so the plan only stands if they can be forced to agree. The cheap test
is in the probe and then in T10b: after `modify` + `applyEdits`, re-parse the
new text and compare its value at the path with the applied value; a mismatch is
refused, never written. If this could not be checked, `set` would write text
nobody validated (`config.jsonc` is the user's only config; a silent mismatch
would be the `fs_edit`-corruption class AGENTS §9 warns about).

### Preconditions

Verified in this tree (branch `feat/config-set`, `1685601`):

- **The registry has what `set`/`get`/`list` need.** `keyDoc(path)` gives
  `{ type, values, secret, scope, carried, default, defaultText }`
  (`packages/config/src/key-docs.ts:932`; the fields at `:64-127`). Probe
  output: `model.apiKey` → `secret: true`, `mcpServers.*.env.*` → `secret: true`,
  `mcpServers.*.args` → `secret: "values"`, `subagents.maxParallel` →
  `type: "integer", carried: "pinned"`, `tools.writableDirs` → `type: "array",
  carried: "no"`.
- **A concrete path resolves to the schema's canonical one**, `*` matching any
  map name: `resolveKeyPath("mcpServers.fs.env.TOKEN")` →
  `mcpServers.*.env.*` (`config-keys.ts:253`); `mcpServers.fs` → the section
  `mcpServers.*`. Unknown/typo'd paths return `undefined` — the one gate for
  "the final segment must exist in the schema" (eval A5).
- **The nearest-key function exists and is the explain one**: `nearestKeys(input,
  paths, max = 3)` (`config-keys.ts:339`), already used by `explain`
  (`explain.ts:163`); `allPaths()` in `explain.ts:105` merges the registry paths
  with the walker's.
- **The whole-file schema is the same object the loader uses**:
  `FileConfigSchema` (`schema.ts:402`), strict, with `profiles` as
  `z.record(ProfileSchema)` (`:407`) and the cross-field rule on
  `subagents.agentTaskDescription` vs `…File` (`:250-257`) — validating the
  *whole* result enforces it (eval A3).
- **The loader's own read path** (read-only, *not* edited, per the task's hard
  constraint): `readAndValidateConfigFile` (`load.ts:78`) parses with
  jsonc-parser and reports **`issues[0]` only** (`load.ts:85`); `config` must
  report **all** issues, so it does its own validate and reuses only the
  *shape* of the message. `configDirFromEnv()` (`load.ts:445`) →
  `resolveConfigDir` (`load.ts:452`) honours `--config-dir`›`TENTACLE_CONFIG_DIR`
  ›`XDG_CONFIG_HOME`›`~/.config/tentacle`; `CONFIG_FILENAME` = `config.jsonc`
  (`defaults.ts:73`).
- **The scaffold is written only when the file is missing** (`load.ts:556-558`,
  `DEFAULT_CONFIG_JSONC` at `defaults.ts:97`), i.e. `config set` creating a file
  is the only writer of a *new* file, and it starts as `{}` + the key (eval's
  "Missing config dir / file" row).
- **No reusable exported atomic writer.** `run-state.ts:143` `writeAtomic` is
  **not exported** (`function`, not `export function`), and
  `kept-index.ts:55-61`'s variant is a local `writeFileSync`+`renameSync` with no
  mode/symlink/re-stat handling. So a small helper in the CLI package (eval A3's
  "else the 10-line pattern; do not import the tool's").
- **Streams (§7 discipline):** data on `out`, everything else on `err`
  (`main.ts:339-350`); `explain` and `update` run **before** `loadConfig`
  (`main.ts:571-616`, `loadConfig` at `:631`) — `config` must too, since it has
  to work on a *broken* file.
- **The TTY decision is already available** as `terminal`/`canAsk`
  (`main.ts:440,447`) and `io.readStdin` (`main.ts:381,1008`), `io.ask`
  (`main.ts:388`), `isYes` (`workspace-mount.ts:776`).
- No AGENTS §7 invariant is touched: nothing on the wire, no protocol, no
  persistence format, no terminal ownership (no Ink here). The blast is
  `cross-module` because two packages change and because it writes the user's
  only config file.

### Design

Layers, smallest first; **all decisions are pure**, the I/O is one thin module
with an injectable seam (AGENTS §7).

**1. `packages/config/src/config-edit.ts` — the plan of the edit (pure).**

```ts
export type EditOp = { kind: "set"; value: unknown } | { kind: "delete" };
export type ParsedText =
  | { ok: true; value: unknown }
  | { ok: false; error: string };                 // ALL jsonc parse errors, offsets
export function parseConfigText(text: string, path: string): ParsedText;
/** Every issue of the WHOLE result, as `path: message` (not just issues[0]). */
export function validateFileConfig(value: unknown): { ok: true; config: FileConfig }
  | { ok: false; issues: readonly string[] };
/** The in-memory apply, on a deep copy: creates parents, refuses a non-object parent. */
export function applyEdit(value: unknown, segments: readonly string[], op: EditOp):
  { ok: true; value: unknown } | { ok: false; error: string };
export function readPath(value: unknown, segments: readonly string[]): { found: boolean; value?: unknown };
export function planConfigEdit(input: {
  text: string; segments: readonly string[]; op: EditOp;
}): { ok: true; text: string; config: FileConfig; value: unknown }
 | { ok: false; error: string; issues?: readonly string[] };
```

`planConfigEdit` is the eval's order, in one pure function: parse → apply in
memory → `validateFileConfig` on the whole result → `modify` + `applyEdits`
(indent/EOL detected by `formattingOf(text)`) → **re-parse the new text and
assert the value at the path equals the applied one** (the load-bearing
assumption) → also assert the *rest* of the document is unchanged in memory
(compare the new parse's value with the applied value, whole-tree equality).
`modify` throwing (non-object root, delete in an empty document) is caught and
become a `{ ok: false }`, never an escape.

`formattingOf(text)`: `insertSpaces` = the file does not indent with tabs,
`tabSize` = the first indented line's space count (1–8, default 2), `eol` =
`\r\n` if the text contains it, else `\n`. This is what the probe proved is
needed (mixed indentation otherwise).

**2. `packages/config/src/config-value.ts` — typing, secrets, masking (pure).**

```ts
export type TypedValue = { ok: true; value: unknown } | { ok: false; error: string };
/** Owner Q5: the leaf's schema type decides; `"…"` on a string leaf is that string. */
export function typeConfigValue(doc: KeyNode, text: string): TypedValue;
/** `true` = the VALUE is a credential; `"values"` = every value below it is. */
export function secretOf(path: string): true | "values" | undefined;
/** Setting this key from argv leaks it (T9)? `apiKeyCommand` is not a credential. */
export const ARGV_REFUSED_SECRETS: (doc: { path: string; secret?: true | "values" }) => boolean;
/** The value as `get`/`list` may print it: `***`, `[***]`, or the JSON form. */
export function renderStored(value: unknown, segments: readonly string[]): string;
/** `list`'s lines: the file flattened to leaf paths, secrets masked. */
export function flattenStored(value: unknown, prefix?: readonly string[]): readonly { path: string; text: string }[];
/** A5: a map entry's name must be a plain name, so the dotted form stays unambiguous. */
export function checkSegments(input: string): { ok: true; segments: string[] } | { ok: false; error: string };
/** A6: the one line printed after a write, from `carried`/`scope`. */
export function appliesToText(doc: KeyDoc, opts: { profile?: string }): string;
```

Typing table (owner Q5, `typeConfigValue`):

| leaf `type` | accepts |
|---|---|
| `boolean` | `true` / `false` exactly, else `must be true or false` |
| `integer` | `/^-?\d+$/`, else `must be an integer` |
| `number` | a finite decimal, else `must be a number` |
| `enum` | one of `values`, else `must be one of: a, b, c` |
| `string` | raw text; a leading `"` that `JSON.parse`s to a string **is** that string (`"a b"` → `a b`); otherwise the text as is |
| `array` | `JSON.parse`, must be an array, else `must be a JSON array, e.g. [...]` |
| `map` /**section** | `JSON.parse`, must be a JSON object |
| `enum \| array` | the enum members, else the array form |
| anything else | `JSON.parse` |

Secrets (owner Q6, eval A4): `secretOf(path)` reads the registry
(`keyDoc(resolveKeyPath(path)?.path)?.secret`) — so it covers the `profiles.*`
mirror for free. `renderStored` masks a node with `secret: true` as `***`, an
array under `secret: "values"` as `[***]`, and recurses objects, so
`get mcpServers.fs` prints `{"command":"mcp-fs","args":[***],"env":{"TOKEN":***}}`.
`flattenStored` walks plain objects into `a.b.c` leaf lines and stops at arrays
(`hooks` prints as JSON) and at any node whose doc is a secret (the whole
subtree becomes one masked line — never a partial leak).

**3. `packages/cli/src/config-args.ts` — the arg parser (pure).**

```ts
export type ValueSource = { from: "argv"; text: string } | { from: "stdin" } | { from: "prompt" };
export type ConfigOp =
  | { kind: "set"; key: string; value: ValueSource }
  | { kind: "unset"; key: string }
  | { kind: "get"; key: string }
  | { kind: "list" }
  | { kind: "path" };
export type ConfigArgs =
  | { ok: true; op: ConfigOp; profile?: string; json: boolean; yes: boolean }
  | { ok: false; error: string };
export function parseConfigArgs(
  positional: readonly string[],
  flags: ReadonlyMap<string, string>,
  bools: ReadonlySet<string>,
): ConfigArgs;
```

Rules: the first word is `set`/`unset`/`get`/`list`/`path`, else the word is the
shorthand `key=value` (split at the **first** `=`; owner Q5/A3) — a word without
`=` is an error naming the forms; a key never contains `=` or a space, so the
two forms cannot be confused. `set k=v` is accepted as the same shorthand (the
key cannot contain `=`). `--unset k` behaves like `unset k` and conflicts with a
positional command (`--unset and a command word: give one`). A `set` value of `-`
→ stdin; a missing value → `prompt` (the runner decides: a terminal gets the
hidden prompt, a pipe gets stdin, eval A4's "with no value on a TTY"). `get`/
`unset`/`path`/`list` take no extra words; `path`/`list` take no key. Too many
words → `unexpected argument`.

**4. `packages/cli/src/config-run.ts` — the write path and the thin I/O.**

```ts
export interface ConfigFs {                    // the seam T11/T12 inject
  readText(path: string): string;              // throws (ENOENT/EACCES) — the caller names it
  stat(path: string): { mode: number; mtimeMs: number; size: number; kind: "file" | "other" };
  lstatKind(path: string): "file" | "symlink" | "other" | "missing";
  realpath(path: string): string;
  ensureDir(dir: string): void;                // mkdir -p, mode 0700
  writeTemp(path: string, text: string, mode: number): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}
export async function runConfig(input: {
  op: ConfigOp; profile?: string; json: boolean; yes: boolean;
  configPath: string; fs?: ConfigFs; ask?: (prompt: string) => Promise<string>;
  readStdin?: () => Promise<string>; readSecret?: (prompt: string) => Promise<string>;
  isStdinTerminal: boolean;
}): Promise<{ code: number; out: string; err: string }>;
```

Flow for `set`/`unset` (the read-modify-write, eval A3 "Validate before write"
and the "Concurrent edit" failure mode):

1. **Target resolution**: if the path exists and is a symlink → `realpath` (the
   link stays; write through it). Not a regular file (`lstatKind` other) →
   refuse (`<path> is not a regular file`). Missing → the file will be created;
   `ensureDir(dirname)` (0700).
2. **Read** the text + `stat` (`mtimeMs`, `size`) — the "as read" stamp.
   Missing file: text `` (parsed as `{}`).
3. **Value**: for `set`, the secret gate first (`ARGV_REFUSED_SECRETS` → the
   refusal below), then stdin/prompt, then `typeConfigValue`.
4. **Plan**: `planConfigEdit({ text, segments, op })` — parse, apply, validate
   the whole file, edit the text, re-verify. Any failure → `code 1`, nothing
   written.
5. **Confirm** for a destructive unset (a section: the value at the path is an
   object, or the target is a whole profile): a TTY asks y/N (`--yes` skips);
   **not** a TTY without `--yes` → refuse with `pass --yes`.
6. **Mode**: an existing file keeps `stat.mode & 0o777`; a new file is `0600`
   (it may hold a key, eval A3).
7. **Write**: `writeTemp(dir, text, mode)` in the **same dir** as the real path
   (dot-prefixed: `.config.jsonc.<uuid>.tmp`), then **re-stat** and compare
   `mtimeMs`+`size` with step 2; changed → delete the temp, re-read and retry
   **once**; changed again → `changed while editing` (`code 1`). Then `rename`.
   Any throw → `remove(temp)`, the target intact, `code 1` with the path.
8. **Report** (A6): `set <key> = <text> in <path>` + `appliesToText(...)`, or
   `unset <key> in <path>` + the same line; secrets add
   `stored in plaintext in <path>, mode 0600`; a group/world-readable file when
   setting a secret adds a `[warning]` on `err` (never a silent `chmod`).

`get`/`list`/`path` read only (no lock, no write): parse (`list` needs no schema
validity — it is the command that helps fix a broken file), then
`readPath`/`flattenStored` + `renderStored`.

**5. Wiring (thin).** `flags.ts`: `config` into `SUBCOMMANDS` (`:516`),
`CliMode` (`:625`), `cliMode` (`:646`), `ARGS.config` (`:77`: `values: {profile,
unset}`, `bools: {json, yes}`, `positional: {min: 0, max: 3}`), `USAGE.config`
(`:674`). `main.ts`: dispatch **before** `loadConfig`, next to `update`/`explain`
(`:571-616`), build the `runConfig` input from `configDirFromEnv()`, the
`parsed` flags, `terminal.stdin`, `io.readStdin`, `io.ask`; print `out`/`err`,
return `code`; the `config` prefix on the `unexpected argument` prompt hint
(`main.ts:513-519`) as `explain` has it. `HELP` (`main.ts:142`) gains the
`config` block.

### Files

Dependency order:

1. `packages/config/src/config-edit.ts` (new) — pure edit plan.
2. `packages/config/src/config-value.ts` (new) — pure typing/secret/masking.
3. `packages/config/src/index.ts` — two `export *` lines.
4. `packages/config/test/config-edit.test.ts`, `config-value.test.ts` (new).
5. `packages/cli/src/config-args.ts` (new) — pure argv → op.
6. `packages/cli/src/config-run.ts` (new) — `ConfigFs` seam + orchestration.
7. `packages/cli/src/hidden-input.ts` (new) — the no-echo line reader (A4's
   third safe form; it is a `readline` wrapper, so it needs injectable streams to
   be testable at all).
8. `packages/cli/src/flags.ts` — `ARGS.config`, `SUBCOMMANDS`, `CliMode`,
   `cliMode`, `USAGE`.
9. `packages/cli/src/main.ts` — dispatch + `HELP` + the prompt hint + the
   `readSecret` default.
10. `packages/cli/test/config-args.test.ts`, `config-run.test.ts`,
    `config-main.test.ts`, `hidden-input.test.ts` (new).
11. `README.md` — the "Editing config from the CLI" paragraph (outside the
    `<!-- config-keys:start/end -->` block, so `bun run docs:config` stays a
    no-op).

**Not edited** (hard constraint): `packages/config/src/schema.ts`,
`defaults.ts`, `resolve.ts`, `load.ts`. `config` therefore re-implements, in
~10 lines each: the config-dir resolution (`configDirFromEnv` is *read*, not
copied, from `load.ts:445` — it is exported), the parse-error message, and the
whole-file validate with **all** issues (`load.ts:85` has only `issues[0]`).
Log the latter in Execution as the copy-debt it is.

### Failure modes

Every row of the eval's table, plus what the design does:

| Case | Behaviour |
|---|---|
| Invalid existing file (syntax) | `get`/`list`/`set`/`unset` refuse: `<path>: <all parse errors>`; no write. |
| Existing file fails the schema | `set` refuses and names the offending key (`fix it by hand, or: tentacle config unset <key>`); `unset` **of that key** is allowed (the *result* is validated). |
| Unknown key / typo | `<key>: <nearestKeys, ≤3>` on `err`, exit 1, nothing written (the same function `explain` uses). |
| Type error / out of range | all schema issues, key named, **value omitted for a secret**; nothing written. |
| Missing dir/file | `set`/`unset` create dir (`0700`) + file (`0600`, `{}` + the key); `get`/`list` print `no config file at <path>` (exit 1 for `get`, 0 for `list`). |
| Read-only file/dir | `EACCES`/`EROFS` with the path, temp removed, exit 1. |
| Concurrent edit | re-stat (`mtimeMs`+`size`) right before `rename`; changed → re-read and retry **once**; then `changed while editing`, exit 1. Never a lost edit. |
| Symlinked config | written **through** the link (`realpath`, temp in the real dir, rename over the real file); the link stays. |
| Config on a pod | `config` edits the laptop's file only; it never dials anything. |
| Secret via argv | refused, naming only the key, with the two safe forms + the `apiKeyCommand` pointer. |
| Key `$schema` | allowed as a string (`scope: "user"`, so refused with `--profile`). |
| Value looks like JSON but key is a string | `model.model='"x"'` stores `"x"` (type from the leaf); `model.model=x` stores `x`. |
| `profiles.x` with `--profile` | error: the key already names a profile (ambiguous). |
| `key=` (empty) | the schema's message + `to remove a key, use: tentacle config unset <key>`. |
| Delete a section | confirmation on a TTY (destroys config); `--yes` skips; no TTY and no `--yes` → refused. |
| Non-object document (`[]`, `5`) | refused before `modify` (which would throw). |

### Tests

Red first (AGENTS §9), narrow file per slice; each group mutation-checked with a
`cp` backup + `shasum`, restored byte-identically.

- **`packages/config/test/config-edit.test.ts` — T10 (round trip) and the plan.**
  A commented fixture with odd indent (4 spaces, then a tab file) and key order:
  after a `set` and an `unset`, the text differs **only** on the touched node
  byte for byte (assert on the shared prefix/suffix lengths, not on a "contains"
  check); a set→unset round trip `toBe(original)`; an existing leaf changes only
  its literal; a new key appends inside its object and after the last top-level
  key; a cross-field violation (`subagents.agentTaskDescription` +
  `…File`) is refused by the whole-file validate (T8's third leg); every parse
  error is reported, not the first; a non-object root is refused; the re-parse
  check (`planConfigEdit` returns a value equal to the text's).
- **`packages/config/test/config-value.test.ts` — the A3 typing table and
  masking.** Each row of the table: `boolean`/`integer`/`number`/`enum`/`string`
  (raw, and `"a b"` → `a b`)/`array`/`object`/map; a wrong type is an error
  naming the key's type; `renderStored` masks `model.apiKey` as `***`, `args` as
  `[***]`, every `env`/`headers` value as `***`, and recurses an object;
  `flattenStored` never emits a secret substring (T9's masking half);
  `appliesToText` for a `pinned`, a `workspace` and a `no` key (A6).
- **`packages/cli/test/config-args.test.ts`** — the parser: `set k v`,
  `k=v` split at the **first** `=` (`model.baseURL=http://x:1/v1` →
  `http://x:1/v1`), `k=` (empty), `set k -` → stdin, `set k` → prompt, `--unset`
  ≡ `unset` and its conflict, `get`/`list`/`path`, `--profile`/`--json`/`--yes`,
  a word with no `=` → the error naming the forms, too many words.
- **`packages/cli/test/config-run.test.ts` — T11 (atomic/symlink) and T12
  (concurrent), with a fake `ConfigFs`.**
  T11: `rename` throws → the target is byte-identical, `remove(temp)` was called,
  exit 1, the temp name never left; a symlink → `realpath` is the target, the
  link is untouched, the temp is in the **real** dir; a new file is `0600` in a
  new `0700` dir; a non-regular file is refused. T12: `stat` reports a changed
  `mtimeMs` once → the edit is re-applied from the re-read text (a *second*
  plan, not the first) and written; changed on both attempts → `changed while
  editing`, nothing renamed, exit 1.
- **`packages/cli/test/config-main.test.ts` — T8/T9 end to end through `main()`
  with a temp `TENTACLE_CONFIG_DIR`.**
  T8: a type error, an unknown key (with the suggestion) and a cross-field error
  each exit 1 with the file's **sha** unchanged (`config.jsonc` byte-identical);
  a schema-invalid file + `unset` of the broken key succeeds. T9: a secret via
  argv is refused **and the whole `out`+`err` never contains the value**;
  `printf 'sk-test\n' | config model.apiKey -` stores `sk-test` (one trailing
  newline trimmed) and prints `stored in plaintext`; `get`/`list` print `***` and
  never the value; the file mode is 0600. Plus the failure-mode rows: broken
  syntax, missing file (`get` 1 / `list` 0), `path`, `--profile`, the
  `profiles.x` + `--profile` ambiguity, `$schema` in a profile refused,
  `key=` + the `unset` hint, unsetting a section without `--yes` (no TTY) refused
  and with `--yes` done.
- **`packages/cli/test/args.test.ts`-style wiring check** (inside
  `config-main.test.ts`): `cliMode(["config", …]) === "config"`, `USAGE.config`
  exists, `HELP` contains `tentacle config`, and `--help` lists it.

**Mutation per group** (each: `cp` backup, `shasum` before/after, restore):
validate **after** the write → T8 red; drop the mask → T9 red; replace
`applyEdits` with `JSON.stringify` → T10 red; drop the re-stat → T12 red; write
the temp in `dirname(configPath)` instead of the real path → T11's symlink leg
red; skip `remove(temp)` → T11 red.

## Execution

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

### Repro on the new branch before any edit

```
$ TENTACLE_CONFIG_DIR=./.tentacle/tmp/config-set/cfg bun packages/cli/src/main.ts config list
[error] ModelConnectionError: could not connect to the model endpoint (ECONNREFUSED) …
exit=1
$ bun packages/cli/src/main.ts --help | grep -c 'tentacle config'
0
```

`config` was not a subcommand at all: `cliMode`'s word list (`flags.ts:516-527`)
had no `config`, so the word became a one-shot PROMPT and the CLI tried to reach
a model. That is the capability gap, and the README/HELP divergence the whole
eval exists to close.

### The probe first (the eval's unverified assumption)

`.tentacle/tmp/config-set/probe-modify-proof.ts` on the real scaffold, before a
line of the feature. Each op, printing the common prefix/suffix lengths and only
the changed region:

```
== set subagents.maxParallel = 3 (new section)
  prefix 393B identical, suffix 88B identical
  changed: ""
        →  "  \"subagents\": {\n    \"maxParallel\": 3\n  },\n"
  reparse: errors=0 value={"model":{},"subagents":{"maxParallel":3}}
== set maxIterations = 20 (new top-level key)
  prefix 393B identical, suffix 88B identical
  changed: ""
        →  "  \"maxIterations\": 20,\n"
== set tools.writableDirs = [..] (array)
  changed: ""
        →  "  \"tools\": {\n    \"writableDirs\": [\n      \"/tmp\",\n      \"~/x\"\n    ]\n  },\n"
== set model.model = qwen3 (into an existing section with comments)
  prefix 242B identical, suffix 239B identical
  changed: ""
        →  "\"model\": \"qwen3\"\n    "
== then change model.model again (existing leaf)
  prefix 257B identical, suffix 245B identical
  changed: ""
        →  "-coder"
== unset subagents.enabled (keeps the sibling)
  changed: "  \"enabled\": true\n  "
        →  ""
```

So the eval's assumption holds — `modify` + `applyEdits` touches only the node
and everything else is the same bytes.

`.tentacle/tmp/config-set/probe-edge2.ts` then found three things the design had
to respect, all `jsonc-parser` 3.3.1 behaviour:

1. On a **tab-indented** file with the default `{insertSpaces: true, tabSize: 2}`
   it emits a MIXED-indent node (`\t"model": {…\n  },\n  "maxIterations": 20`).
   → `formattingOf(text)` reads `insertSpaces`/`tabSize`/`eol` from the file.
2. `modify` **throws** on a non-object document (`Can not add index to parent of
   type number`) and on a delete from an empty document. → `applyEdit` refuses
   first; the `modify` call is inside a `try` and its throw becomes a refusal.
3. jsonc-parser reports `""` and a comment-only file as a **parse error**
   (`error: 4` at offset 0). → `parseConfigText` treats a
   `stripComments(text).trim() === ""` document as `{}`, which is what a file
   with no setting in it means (the scaffold invites a user to leave comments
   only).

### As built, in slice order

1. `packages/config/src/config-edit.ts` — the pure edit plan, exactly the
   `planConfigEdit` of the Implementation; `formattingOf`, `sameValue`,
   `readPath`, `applyEdit`, `parseConfigText`, `validateFileConfig` beside it.
   The re-parse + `sameValue` re-check after `applyEdits` is the load-bearing
   check, and it is a *safety net*, not decoration: the text edit and the
   in-memory apply are two code paths, so the plan refuses rather than writes a
   text that does not hold the value it validated.
2. `packages/config/src/config-value.ts` — the A3 typing table over the
   walker's `KeyNode.type`, `secretOf`/`isArgvRefusedSecret` from the registry,
   `renderStored`/`flattenStored` masking, `checkSegments`, `appliesToText`.
   `+2` lines in `packages/config/src/index.ts`.
3. `packages/cli/src/config-args.ts` — argv → `ConfigOp` (both forms, `--unset`,
   `-` = stdin, no value = prompt, the profile ambiguity).
4. `packages/cli/src/config-run.ts` — `ConfigFs` (the T11/T12 seam),
   `nodeConfigFs` (the only `node:fs` mutator holder), the read → plan →
   confirm → write flow, `get`/`list`/`path`.
5. `packages/cli/src/flags.ts` — `ARGS.config`, `SUBCOMMANDS`, `CliMode`,
   `cliMode`, `USAGE.config` (`+13` lines, no existing entry changed).
6. `packages/cli/src/main.ts` — dispatch right after `explain` and **before**
   `loadConfig`; the `config` prefix on the `unexpected argument` prompt hint;
   the `HELP` block; the `readSecret` default (item 7), on a terminal only.
7. `packages/cli/src/hidden-input.ts` — the no-echo line reader (`readHiddenLine`),
   wired in `main` as `readSecret`'s default **only when stdin is a terminal**.
8. Tests (6 files) + the README paragraph (`### Editing config from the CLI`,
   after the generated block, so `bun run docs:config` still leaves the tree
   clean).

Tests: `packages/config/test/config-edit.test.ts` (25),
`config-value.test.ts` (23), `packages/cli/test/config-args.test.ts` (17),
`config-run.test.ts` (15), `config-main.test.ts` (31),
`hidden-input.test.ts` (3) — 114 new tests.

### Drift from the Implementation (and why)

- **Line numbers in Implementation/Preconditions are pre-edit** (they were
  verified against `1685601`). `flags.ts` grew by 13 lines and `main.ts` by ~66,
  so anything below `flags.ts:176` / `main.ts:571` moved down; a Review should
  `rg` the symbol, not trust the number.

- **`isArgvRefusedSecret` is not `secret !== undefined`.** `model.apiKeyCommand`
  is `secret: true` in the registry (it *can* embed a credential), but the eval's
  A4 names it as the PREFERRED alternative to `apiKey`, so refusing an argv value
  for it would remove the safe path. The rule is: a key whose own value is a
  credential is refused; `apiKeyCommand` is not.
- **`flattenStored` sorts by path** instead of keeping the file's key order. The
  Implementation said "in the file's own order"; a stable, sorted `list` is what
  a user greps, and the *file* keeps its order either way (nothing here writes).
  `list --profile x` lists `profiles.<name>.…` paths, so the line says where the
  setting lives.
- **`--profile x` + a key that names a profile** is refused in `config-args.ts`
  (`profiles.…`, `$schema`), not by the schema. The schema would reject it with a
  confusing "unrecognized key", and the eval asks for a clear ambiguity error.
- **A hidden prompt had no in-repo precedent** (`grep setRawMode` finds nothing:
  the TUI does its own raw mode, and the CLI's only question is `askLine`, which
  echoes). So it is a small module of its own, `hidden-input.ts`
  (`readHiddenLine`): a `readline` interface whose `_writeToOutput` is muted, the
  prompt on stderr, a newline after, `""` on Ctrl+C/EOF. `main` makes it the
  `readSecret` default **only on a terminal** and only when no seam is injected,
  so a pipe still means stdin-as-value and a test can inject its own reader. The
  `_writeToOutput` mute is a non-public field — the tested contract is the
  OBSERVABLE one (the typed value never appears on the output stream), so a
  readline change that renames the field fails `hidden-input.test.ts` rather than
  leaking silently.
- **`ensureDir` uses `mode: 0700` through `mkdirSync`**, which is what the eval
  asks; the umask can only narrow it.
- **The `get` "not set" message prints the default** from the registry
  (`defaultText` first), which is a small extra over the Implementation's "shows
  the default".

### Red/green evidence (command + result, trimmed)

Slice 1 (`config-edit`), before the module existed the file did not compile; the
first RED run was against the module with its validate-on-the-result dropped, and
three assertions failed as the plan predicted:

```
$ bun test packages/config/test/config-edit.test.ts
error: Expected to contain: "subagents.enabled"
Received: "the result would not be valid config (1 issue)"
error: Expected to contain: "not a JSON object"
Received: "cannot edit the file: Can not add index to parent of type null"
error: Expected: true   Received: false          (empty document as {})
(fail)  … 3 tests
```

Each of those was a real gap in the module (the issue line does not carry the
`schema.ts:250` message's key path; `modify`'s throw beat `applyEdit`'s refusal
for `null`; a comment-only document was a parse error), so the fix went into the
*code*, not the assertion — except two assertions that were measuring the wrong
bytes and were corrected to the honest property (the changed region of a leaf
change starts *inside* the literal, and the tab-indent case is an exact-text
compare rather than a prefix/suffix window).

Slice 2 (`config-value`) was written test-first: 23 tests, all red on the
missing module (`Cannot find module '../src/config-value.ts'`), green after.

Slice 3 (`config-args`): 17 tests, two reds on genuine design questions, not
typos —
`tentacle config modle` (a bare unknown word) is *the documented safe form* for
a secret, so it parses and is refused later by key resolution; and `--` never
reaches `config-args` (parseArgs strips it), so the test was corrected.

Slice 4 (`config-run`): 14 tests, 2 reds — the fake's `writeTemp` returned
`void`, and a missing-file `unset` says "is not set in `<path>`" (which creates
nothing) rather than "no config file", because the file *is* allowed to be
absent for a set.

Slice 5 (`config-main`, through `main()`): 28 tests; the reds found four real
bugs — a backtick in `HELP` (a template literal, so the file did not even
parse), the written path not being the `profiles.work.…` one in the success
line, the empty-value hint being lost because a `string` leaf's `min(1)` fails in
the *whole-file* validate rather than in the typer, and the mode warning.

### Mutation check (§9) — each with a `cp` backup and a `shasum` restore

| # | Mutation | Killed by |
|---|---|---|
| M1 | validate AFTER the edit (`config-edit.ts`: the pre-write `validateFileConfig` replaced by a cast) | `config-edit`: 2 fail (cross-field, non-object); `config-main`: 3 fail (cross-field T8, broken-file unset, empty value) |
| M2 | no mask for a secret leaf (`config-value.ts`: `JSON.stringify` instead of `***`) | `config-value`: 4 fail (T9 leaf/object/list/subtree); `config-main`: 3 fail (T9 stdin, get/list, MCP args/env) |
| M3 | rewrite with `JSON.stringify(...)` instead of `modify`+`applyEdits` | `config-edit`: 7 fail (all of T10 — comments, round trip, tabs, CRLF, key order) |
| M4 | drop the re-stat before `rename` | `config-run`: 2 fail (both T12 legs) |
| M5 | do not resolve the symlink (`if (false && kind === "symlink")`) | `config-run`: 1 fail (T11's symlink leg: the link is replaced) |
| M6 | skip `remove(temp)` on a failed rename | `config-run`: 1 fail (T11: a temp file is left behind) |
| M7 | `rl._writeToOutput` mute removed (echo the typed secret) | `hidden-input`: 1 fail (the screen holds `sk-live-9f2`) |
| M8 | no appearance check when the file was missing at read (`else if (false)`) | `config-run`: 1 fail (T12's third leg: the other writer's key is lost) |

Restore was verified by `shasum`, not by trust:

```
$ shasum -c .tentacle/tmp/config-set/mut/shas.txt
packages/cli/src/hidden-input.ts: OK              8a27ebfad44f73f657604614418cf0d706829ebe
packages/config/src/config-edit.ts: OK            b26f207732f545733d078206b060bbc71d2d4b7f
packages/config/src/config-value.ts: OK           71b5b6e7e8c49c54ab124d674406ac225283317c
packages/cli/src/config-run.ts: OK                6f094c6886887084d134ee6a582fb0ac9ae86039
```

### The gate

```
$ bun run check                    # tsc --noEmit && tsc -p apps/mobile --noEmit
                                   # → clean
                                   # biome check .
                                   # → Checked 743 files. No fixes applied.
                                   # bun test
                                   # → 5666 pass, 3 skip, 0 fail (386 files, 189.2s)
$ bun test packages                 → 5624 pass, 3 skip, 0 fail (383 files, 165.0s)
$ bun run docs:config               → "README.md's config table is up to date"
$ git status --short README.md      → M README.md   (only the new prose section;
                                        the generated block between the markers is
                                        byte-identical, so docs:config is a no-op)
```

The 3 skips are the documented opt-ins (live k8s, live docker, the real-socket
keepalive) — the same three as on `main`.

### The live command against a scratch config dir

`TENTACLE_CONFIG_DIR` is the right env (`load.ts:452` `resolveConfigDir`: the
override › `TENTACLE_CONFIG_DIR` › `XDG_CONFIG_HOME` › `~/.config/tentacle`).
Nothing here touched `~/.config/tentacle`.

```
$ tentacle config path
/Users/gmeghnag/tentacle/.tentacle/worktrees/config-set/.tentacle/tmp/config-set/cfg/config.jsonc
exit=0

$ tentacle config set subagents.maxParallel 3
set subagents.maxParallel = 3 in `…/cfg/config.jsonc`
applies to sessions started after this — a running `serve` keeps its value until restarted; carried to a pod for a session opened after this (a pod session already open keeps its own)
exit=0

$ tentacle config subagents.maxParallel=abc
[error] subagents.maxParallel: must be an integer
nothing was changed; `tentacle explain subagents.maxParallel` shows its type
exit=1

$ tentacle config modle.model=x
[error] unknown config key "modle.model"
did you mean model.model?
exit=1

$ tentacle config get subagents.maxParallel
3
exit=0

$ tentacle config model.apiKey=sk-test
[error] refusing a secret on the command line: "model.apiKey" would be visible in your shell history and in `ps`
read it from stdin instead:  printf '%s\n' "$KEY" | tentacle config model.apiKey -
or with no value, it is prompted for without echo:  tentacle config model.apiKey
better: store a command that prints it — tentacle config model.apiKeyCommand "pass show tentacle" (see `tentacle explain model.apiKeyCommand`)
exit=1

$ printf 'sk-test\n' | tentacle config model.apiKey -
set model.apiKey in `…/cfg/config.jsonc`
applies to sessions started after this — a running `serve` keeps its value until restarted; not carried to a pod: one there uses its own
stored in plaintext in `…/cfg/config.jsonc`, mode 0644
[warning] `…/cfg/config.jsonc` is readable by other users (mode 0644); it now holds a secret — chmod 600 it
exit=0

$ tentacle config list
model.apiKey = ***
subagents.enabled = true
subagents.maxParallel = 3
exit=0

$ tentacle config unset subagents.maxParallel
unset subagents.maxParallel in `…/cfg/config.jsonc`
applies to sessions started after this — a running `serve` keeps its value until restarted; carried to a pod for a session opened after this (a pod session already open keeps its own)
exit=0
```

The file before (a commented scaffold-shaped file) and after (the `set`, the
stdin `apiKey`, the `unset`), diffed:

```
$ diff before.jsonc cfg/config.jsonc
7a8
>     "apiKey": "sk-test"
```

That one added line is the whole net change: the `set` and the `unset` of
`subagents.maxParallel` cancelled out **byte for byte**, every comment and the
file's key order (including the commented `// "model": "qwen3",` block the new
key landed above) survived, and the `list` above shows the secret as `***` while
the file itself holds it in plaintext (which the command says, with the mode).

### Round 2 (review fixes)

*— claude-sonnet-5-5 (tentacle), 2026-11-09*

Scope: the fresh-context review's `REQUEST-CHANGES` (2 HIGH, 2 MEDIUM, 4 LOW,
2 owner questions). Fix order below is the review's own. Every fix ships a test
shown RED on the pre-fix code first (AGENTS §9), and each surviving mutation is
recorded under *Mutations*.

**HIGH-1 — a secret inside an object/array value on argv.** Root cause: the
argv refusal asked `secretOf(<the key>)` only, so a parent key (`model`,
`mcpServers.fs`, `profiles.p`) passed and its JSON carried the credential.
`config-value.ts` gains `secretPathsIn(value, segments)` — the SAME walk the
masking uses (`isArgvRefusedSecret` on each path, so `apiKeyCommand` keeps its
exemption and no second table exists) — and `config-run.ts` asks it of the
TYPED value at its target path, for `from: "argv"` only. `secretOnArgv(key,
paths)` is the one refusal (it was inline before), naming the secret PATH(S),
never the value, and listing the same three safe forms; a nested case reads
`"model.apiKey" (in the value for "model")`. The stdin `-` form is untouched.

```
$ tentacle config model={"apiKey":"sk-LEAK7"}          → exit 1
[error] refusing a secret on the command line: "model.apiKey" (in the value for "model") would be visible in your shell history and in `ps`
read it from stdin instead:  printf '%s\n' "$KEY" | tentacle config model.apiKey -
or with no value, it is prompted for without echo:  tentacle config model.apiKey
better: store a command that prints it — tentacle config model.apiKeyCommand "pass show tentacle" (see `tentacle explain model.apiKeyCommand`)
$ tentacle config --profile p model={"apiKey":"sk-LEAK11"}   → exit 1 ("model.apiKey" — the path is the target's)
$ tentacle config mcpServers.fs.env={"T":"sk-LEAK9"}         → exit 1 ("mcpServers.fs.env.T")
$ tentacle config profiles.p={"model":{"apiKey":"sk-LEAK12"}} → exit 1 ("profiles.p.model.apiKey")
$ tentacle config mcpServers.fs={"command":"mcp-fs","args":["--token","sk-LEAK13"]} → exit 1 ("mcpServers.fs.args")
$ tentacle config set model {"apiKey":"sk-LEAK14"}           → exit 1 (same)
$ diff before.jsonc cfg/config.jsonc  →  IDENTICAL (no secret substring in any output)
$ printf '{"apiKey":"sk-STDIN9"}\n' | tentacle config model -   → exit 0 (stdin stays allowed)
```
Test: `config-run.test.ts` — every command above, both forms, each `exit 1`,
file bytes equal, `out+err` free of the secret; plus the path-naming test and
the stdin-still-allowed test.

**HIGH-2 — `get <section> --json` printed a stored secret.** Root cause: the
JSON branch emitted `found.value` for anything that was not a leaf mask.
`config-value.ts` gains `maskStored(value, segments): unknown` — the tree with
`"***"` / `["***"]` in place of every secret — and it is now the ONLY source of
a printed stored value: `get` (`bug`: plain) and `get --json` both render it
(`renderStored(maskStored(...))` / the tree itself), and `list --json`
serializes the `value` each `StoredLine` already carries instead of re-deriving
one from text. `flattenStored` and `renderStored` share ONE mask decision
(`maskOf`), so the two can no longer disagree.

```
$ tentacle config get model --json        {"key":"model","value":{"apiKey":"***"}}
$ tentacle config get model               {"apiKey":***}
$ tentacle config get mcpServers --json   {"key":"mcpServers","value":{"fs":{"command":"mcp-fs","env":{"TOKEN":"***"}}}}
$ tentacle config get profiles --json     {"key":"profiles","value":{"work":{"model":{"apiKey":"***"}}}}
$ tentacle config list --json             {"maxIterations": 8,"model.apiKey": "***"}
$ tentacle config list                    maxIterations = 8 / model.apiKey = ***
```
Test: `config-value.test.ts` (`maskStored`, 6 tests) and `config-run.test.ts`
(`get model --json`, `get mcpServers --json`, `get mcpServers.fs --json`,
`get profiles --json`, `list --json`, plain `get`/`list`), asserting the whole
output is free of the secret and that the JSON keeps its shape.

The whole matrix, live, on a file holding five secrets — every form, zero
occurrences of any of them (`grep -c 'sk-'` per line):

```
file: {"model":{"model":"qwen3","apiKey":"sk-…1"},
       "mcpServers":{"fs":{"command":"mcp-fs","args":["--token","sk-…2"],"env":{"TOKEN":"sk-…3"}}},
       "profiles":{"work":{"model":{"apiKey":"sk-…4"}}},
       "model2":{"apiKey":"sk-…5"}}          # an unknown top-level key (Q-B)
$ tentacle config get model --json        {"key":"model","value":{"model":"qwen3","apiKey":"***"}}      0
$ tentacle config get model               {"model":"qwen3","apiKey":***}                               0
$ tentacle config get mcpServers --json   …"args":["***"],"env":{"TOKEN":"***"}…                       0
$ tentacle config get mcpServers.fs --json  same                                                      0
$ tentacle config get profiles --json     {"key":"profiles","value":{"work":{"model":{"apiKey":"***"}}}} 0
$ tentacle config list                    mcpServers.fs.args = [***] / mcpServers.fs.command = "mcp-fs"
                                          / mcpServers.fs.env.TOKEN = *** / model.apiKey = ***
                                          / model.model = "qwen3" / model2 = ***                   0
$ tentacle config list --json             {"mcpServers.fs.args": ["***"],…,"model2": "***",…}          0
```


**MEDIUM-3 — "an error never contains the value" was not pinned.** The review's
two mutations now die (see *Mutations* M3/M4). Tests: `config-run.test.ts`'s
MEDIUM-3 block feeds a secret-looking value to a SECRET leaf that fails typing
(`mcpServers.fs.args` non-array via stdin, `mcpServers.fs.env` non-object via
stdin), to a secret leaf whose value fails the schema (`model.apiKey` via the
prompt), and a non-secret key (`tools.maxParallel`), asserting `out+err` lacks
it. No code change was needed: the assertions hold because the typer and the
typed-error line already withheld the text — which is exactly what the review
said nobody had proven.

**MEDIUM-4 — a schema message echoed a stored value.** Root cause: `issueLines`
forwarded zod's text, which ends `received '<the value>'` for an enum, literal
or union. It is now REBUILT from the issue's `code` + `options`/`expected`
(`tools.execution: Invalid enum value. Expected 'sequential' | 'read-only' |
'parallel'`), with a belt-and-braces strip of any `, received …` tail for codes
that build no expected text. Path and expected set survive.

```
$ tentacle config set autoWake false     # file holds "tools":{"execution":"sk-LEAKECHO"}
[error] the result would not be valid config (2 issues)
  model: Unrecognized key(s) in object: 'foo'
  tools.execution: Invalid enum value. Expected 'sequential' | 'read-only' | 'parallel'
nothing was changed; check the key's schema with: tentacle explain autoWake
$ … 2>&1 | grep -c sk-LEAKECHO   →  0
```

**Q-B (owner default applied, to confirm) — an unknown/misplaced key's value is
masked.** `maskOf` masks any path the schema does not know (`isKnownKey`, from
`resolveKeyPath` — the walker, not a list), so `list`/`get` print
`model.foo = ***` while the PATH is still shown. `config list` is what a user
pastes into a bug report, and a value pasted into the wrong slot is not a
setting. `get model.foo` still refuses it as an unknown key (unchanged).
Test: in both suites (a `model2`/`model.foo` value, plain and `--json`).

**Q-A (owner default applied, to confirm) — a `config`-swallowed sentence keeps
its way back.** `main.ts` prints `promptHint` when the refusal is
`unknown config key` and the first word after `config` has no `.`/`=` and is
not a top-level key (`topLevelKeys()`), i.e. it cannot be a key path. It also
covers the parse-level refusals (`config how are you --json` → `unexpected
argument`), which `explain` already did.

```
$ tentacle config my nginx
[error] unknown config key "my"
did you mean rm?

to send this as a prompt, use: tentacle -- config my nginx
$ tentacle config model.foo=x    → no prompt hint (a near miss, not a sentence)
```

**LOW-5 — unset of the only key of an object with a trailing comma.** Root
cause, reproduced: jsonc-parser's `modify` deletes the member but leaves an
ORPHAN comma (`{"tui":{"theme":"dark",}}` → `{"tui":{,}}`), which does not
parse, so the plan refused with a message that blamed the schema. The plan now
repairs exactly that comma — located by the JSONC parse error's offset, so a
`,}` inside a STRING is untouchable (a blanket regex was tried and rejected for
that reason) — and removes the whole line when the comma stood alone on it, so
no stray indent is left behind. The empty parent still stays (documented debt).
Test: T10's LOW-5 case (trailing comma, no trailing comma, a sibling, and the
two-step unset).

**LOW-6 — a file with no trailing newline gained one.** The newline is now added
only when the original text was empty (a NEW file, where there is no style to
copy). Test: T10's LOW-6 case (`{"maxIterations": 5}` → still no trailing
`\n`; a new file still gets one).

**LOW-7 — Ctrl+C / EOF at the hidden prompt.** `readHiddenLine` now resolves
`undefined` on SIGINT and on EOF (the readline `close` event), `""` only for a
real empty line. `config-run.ts` turns `undefined` into `code 130` with
`cancelled` and writes nothing, for both the hidden prompt and the visible
`ask` prompt. Test: `hidden-input.test.ts` (SIGINT → `undefined`, EOF →
`undefined`, `"\n"` → `""`), and `config-main.test.ts` through `main` (exit
130, `cancelled`, file sha unchanged).

**LOW-8 — a non-ENOENT `lstat` error read as "not a regular file".**
`nodeConfigFs.kind` now rethrows anything but ENOENT, and `readSnapshot` asks it
through `kindOf`, which reports `cannot read <path>: <the error>` — every
`kind()` call is covered, not just the first. Test: `config-run.test.ts` pins
the REAL fs with a `chmod 000` directory (a real EACCES), plus the same failure
through the command, plus the harmless missing file.

**Drift from the review's suggestions (and why).**

- The review suggested "refuse also when the target is a section whose subtree
  contains a secret key". Implemented as the VALUE walk only: the value is what
  goes on argv, and a section whose registry subtree contains a secret key but
  whose given value does not (e.g. `mcpServers.fs` with only `command`/`cwd`)
  carries no secret, so refusing it would forbid a legitimate, safe set.
- `renderStored` was NOT rewritten on top of `maskStored`; both share `maskOf`
  instead. Re-serializing the masked TREE would turn a secret array into
  `["***"]` where the format is `[***]` — the drift the review's own text
  warned about.
- Q-A's hint is printed by `main.ts` (the layer that owns the argv words and the
  prompt hint, exactly as `explain` does), not by `config-run.ts`, which sees
  only the parsed op.
- One pre-existing test had to change its SEED, not its assertion: `an MCP
  server's env/headers/args are masked in list` set the whole server from argv,
  which HIGH-1 now (correctly) refuses — it seeds through `-` instead.
  `hidden-input.test.ts`'s "EOF resolves empty" was the old contract and is now
  "EOF is a CANCEL".
- `config model` (a known section with no value) types `""` as an empty object
  and reports `must be a JSON object, e.g. {"key":"value"}`. That predates this
  round and is not one of the findings; recorded as debt below rather than
  changed under a review-fix task.

**Red/green evidence, round 2** (narrow suites, before/after):

```
$ bun test packages/config/test/config-value.test.ts     # before: SyntaxError, maskStored not exported
$ bun test packages/config/test/config-edit.test.ts      # before: 3 fail (LOW-5 refused, LOW-6 newline, MEDIUM-4 echo)
$ bun test packages/cli/test/config-run.test.ts          # before: 9 fail (HIGH-1 ×5, HIGH-1 names, HIGH-2 ×2, LOW-8)
$ bun test packages/cli/test/hidden-input.test.ts        # before: 2 fail (SIGINT, EOF)
$ bun test packages/cli/test/config-main.test.ts         # before: 3 fail (Q-A ×2, LOW-7)
# after, all of the above: 0 fail
```

**Mutations, round 2** (cp backup → mutate → narrow suite → restore → shasum):

| # | Mutation | Killed by |
|---|---|---|
| M3 | `typeArray` echoes `got ${text}` (the review's own) | MEDIUM-3 `mcpServers.fs.args` (1 fail) — **was SURVIVED before** |
| M4 | the typed error appends `(got ${raw.text})` | MEDIUM-3 ×2 (2 fail) — **was SURVIVED before** |
| M5 | `get` renders `found.value`, not `maskStored(...)` | HIGH-2 "no form of get or list prints a stored secret" |
| M6 | skip the nested-secret argv refusal (`&& false`) | HIGH-1 ×6 |
| M7 | `maskOf` masks only registry secrets (no Q-B rule) | Q-B ×2 + HIGH-2 ×2 (4 fail) |
| M8 | `readHiddenLine` resolves `""` on SIGINT/EOF | LOW-7 ×3 |
| M9 | `issueLines` forwards zod's message | MEDIUM-4 |
| M10 | no orphan-comma repair | LOW-5 |
| M11 | always append the trailing newline | LOW-6 |
| M12 | `kind` maps any error to `"other"` | LOW-8 (after the test was tightened to drive the REAL fs — the first version passed the mutation, which is why it now pins `nodeConfigFs.kind` against a real `chmod 000` EACCES) |

Restore verified by shasum (all four sources):

```
$ cd .tentacle/tmp/config-set/mut2 && shasum -c shas.txt
config-value.ts: OK    config-edit.ts: OK    config-run.ts: OK    hidden-input.ts: OK
```

**The gate, round 2.**

```
$ bunx tsc --noEmit                       → clean
$ bunx biome check .                      → Checked 751 files. No fixes applied.
$ bun test packages                       → 5701 pass, 3 skip, 0 fail (386 files, 166s)
$ bun run docs:config                     → "README.md's config table is up to date"
$ bun run docs:config (again) + git status → README/CHANGELOG untouched, only the
                                            10 code/test files modified
$ git diff --stat schema.ts defaults.ts resolve.ts load.ts  → empty (byte-untouched)
```

The 3 skips are the documented opt-ins (live k8s, live docker, the real-socket
keepalive) — the same three as on `main`.

### Round 3 (layout fix)

*— claude-opus-4-6 (tentacle), 2026-11-08*

Scope: one defect the orchestrator found in a live check. Appending a NEW key
after a sibling written on ONE line reformatted that sibling — eval A3 / owner
Q9 ("comments, layout and key order are preserved") and T10 both say only the
touched node may change. Setting an existing key, or a key inside the inline
object, did not reformat: only an INSERT after a one-line sibling did.

**Probe first** (`.tentacle/tmp/config-set/probe-inline.ts`, 10 lines, the
`modify` call alone with no `config-edit.ts` in the path):

```
$ bun .tentacle/tmp/config-set/probe-inline.ts
EDITS [
  { "offset": 48, "length": 28,
    "content": "  \"tui\": {\n    \"theme\": \"dark\"\n  },\n  \"subagents\": {\n    \"maxParallel\": 3\n  }" }
]
--- input ---
"{\n  // my notes\n  \"maxIterations\": 16, // keep\n\n  \"tui\": { \"theme\": \"dark\" }\n}\n"
--- output json ---
"{\n  // my notes\n  \"maxIterations\": 16, // keep\n\n  \"tui\": {\n    \"theme\": \"dark\"\n  },\n  \"subagents\": {\n    \"maxParallel\": 3\n  }\n}\n"
```

**Root cause, in jsonc-parser itself** — not in our formatting options.
`modify` delegates to `withFormatting` (`lib/esm/impl/edit.js:150-179`), which
for an insert or a remove expands the edit to EVERY WHOLE LINE it touches and
hands that range to `format` with `keepLines: false`:

```js
// edit.js:159-166
if (edit.length === 0 || edit.content.length === 0) { // insert or remove
    while (begin > 0 && !isEOL(newText, begin - 1)) { begin--; }
    while (end < newText.length && !isEOL(newText, end)) { end++; }
}
const edits = format(newText, { offset: begin, length: end - begin }, { ...options.formattingOptions, keepLines: false });
```

The insert's `offset` is the end of the PREVIOUS sibling (`edit.js:78`), so
`begin` walks back to the start of THAT sibling's line — `"tui": { "theme":
"dark" }` — and it is reformatted into four lines. A REPLACE is not affected
(its range is the value itself), which is exactly why setting an existing key was
already byte-exact. That is why the offset in the probe edit is 48, not 66: the
library's own edit already starts at the `"tui"` line.

**As built** (`packages/config/src/config-edit.ts`, one new seam: `editedText`,
which `planConfigEdit` now calls in place of the inline `modify` + `applyEdits`):

- `editedText` asks `modify(…, {})` — NO `formattingOptions` — for the minimal
  splice `(offset, length, content)`. When it is a pure INSERT (`length === 0`),
  `spliceInsert` lays out the new property itself; every other case (a REPLACE, a
  DELETE) keeps `modify` + `formattingOptions`, the pre-round-3 path, which is
  already byte-exact for a value and already the wanted whole-line handling for a
  removed member.
- `afterSibling` re-emits the rest of the previous sibling's line **unchanged**
  and appends `,` + the file's EOL + the new property's line: the separator comma
  goes before a comment, so `"maxIterations": 8 // keep` becomes `… 8, // keep`
  with every byte of the comment kept. A `/* … */` spanning lines is consumed
  whole. A trailing comma the file already had is kept (not doubled).
- `firstMember` handles the one insert `modify` places just INSIDE an opening
  brace (an EMPTY object, `edit.js:80-82`): the property gets a line of its own at
  one indent unit, the closing brace back on the opening one's line, and no
  invented trailing comma.
- `propertyText` applies the file's own style to the NEW text only —
  `format(fragment, undefined, {…, keepLines: false})`, then the file's EOL, then
  `indent` on every following line. Pure text work, no I/O.
- The inline-PARENT shape (`"tools": { "execution": "parallel" }` gaining
  `tools.maxParallel`) deliberately keeps jsonc-parser's formatting
  (`/[}\]]/.test(stripComments(rest))` → `undefined`): that parent is one line
  already, so there is no "surrounding line" of a sibling to preserve, and HEAD's
  output for it is byte-identical. Recorded as a non-change, not a fix.
- `FileStyle` gives `insertSpaces`/`tabSize`/`eol` non-optional types so the
  splice arithmetic typechecks under `noUncheckedIndexedAccess`; `formattingOf`
  still returns the same object and its test is unchanged.

Kept, all pinned by existing tests still green: comments, CRLF, tabs, trailing
commas, the orphan-comma repair (LOW-5), the no-new-trailing-newline rule
(LOW-6), `"tui": {\n  }` after an unset (A3 accepts the empty parent — untouched),
and a new nested section coming out readably indented in the file's style
(`subagents` absent → a two-level block; `profiles.work.model.model` → four).

**Red, then green** (AGENTS §9). The new block in
`packages/config/test/config-edit.test.ts` is `describe("T10 (round 3) …")`, 10
cases (the 5 shapes the defect named — an inline object, an inline array, a
following line comment, the last key before `}` under trailing commas, a CRLF file
with an inline object — plus a tab file, a block comment, a comment holding a
brace, a one-line object and an empty object). Each builds the expected text as
explicit bytes — the input with ONLY the new property's text inserted — and the
inline-object case additionally asserts `onlyInserted` (via `changedRegion`: the
shared prefix+suffix cover every byte of the input), so a re-indented sibling, an
extra byte or a moved line all fail. The line-comment case asserts each line
instead, because it makes TWO insertions (the separator comma, then the property)
and is therefore not a single changed region.

```
$ git show HEAD:packages/config/src/config-edit.ts > packages/config/src/config-edit.ts
$ bun test packages/config/test/config-edit.test.ts
(fail) … after a sibling written on one line (an inline OBJECT)
(fail) … after a sibling written on one line (an inline ARRAY)
(fail) … after a sibling that a line comment follows
(fail) … a CRLF file with an inline object: CRLF throughout, the sibling untouched
(fail) … a tab-indented file: the new node uses tabs, the one-line sibling is kept
(fail) … a block comment after the sibling keeps every byte, even across lines
(fail) … a brace inside a sibling's comment is not the parent's closing brace
 32 pass, 7 fail
$ cp .tentacle/tmp/config-set/final.ts packages/config/src/config-edit.ts   # shasum 40c5fff…
$ bun test packages/config/test/config-edit.test.ts
 39 pass, 0 fail
```

Seven of the ten are RED on `36e7189`; the other three (`after the LAST key …`,
`a one-line object still gains a readable, indented node`, `an empty object gains
its first member`) pass on both — they are coverage of the shapes the splice must
not break, and saying so is better than pretending they were red.

**Mutation** (`cp` backup, narrow test, restore, `shasum`):

```
$ cp packages/config/src/config-edit.ts .tentacle/tmp/config-set/pre-mut2.ts
$ # mutation: spliceInsert(...) → undefined, i.e. re-enable whole-line formatting
$ bun test packages/config/test/config-edit.test.ts
(fail) × the same 7 round-3 tests          → 32 pass, 7 fail   KILLED
$ cp .tentacle/tmp/config-set/pre-mut2.ts packages/config/src/config-edit.ts
$ shasum packages/config/src/config-edit.ts .tentacle/tmp/config-set/final.ts
40c5fff629291ff87245938d8ca5dacc49244eb5  packages/config/src/config-edit.ts
40c5fff629291ff87245938d8ca5dacc49244eb5  .tentacle/tmp/config-set/final.ts
```

**The live repro, before and after** (scratch config dir under
`.tentacle/tmp/config-set/`; `TENTACLE_CONFIG_DIR` always set):

```
$ printf '{\n  // my notes\n  "maxIterations": 16, // keep\n\n  "tui": { "theme": "dark" }\n}\n' > cfg/config.jsonc
$ TENTACLE_CONFIG_DIR=$PWD/cfg bun packages/cli/src/main.ts config subagents.maxParallel=3
```

Before (36e7189) — the inline object rewritten:

```
-  "tui": { "theme": "dark" }
+  "tui": {
+    "theme": "dark"
+  },
+  "subagents": {
+    "maxParallel": 3
+  }
```

After:

```
--- before.jsonc
+++ cfg/config.jsonc
@@ -2,5 +2,8 @@
   // my notes
   "maxIterations": 16, // keep

-  "tui": { "theme": "dark" }
+  "tui": { "theme": "dark" },
+  "subagents": {
+    "maxParallel": 3
+  }
 }
```

Only the new property's text is added; the one-line sibling, its blank line above
it and both comments are byte-identical.

**Gate:** `bunx tsc --noEmit` clean · `bunx biome check .` "Checked 751 files. No
fixes applied." · `bun test packages` all pass except the 3 documented opt-in
skips (live k8s, live docker, the real-socket keepalive — the same three as on
`main`), 0 fail · `bun run docs:config` twice, both "README.md's config table is
up to date", `git status` showing only the three files below.

**Files:** `packages/config/src/config-edit.ts` (the seam, its seven private
helpers and the `FileStyle` type), `packages/config/test/config-edit.test.ts` (the
round-3 block), this doc. `schema.ts`, `defaults.ts`, `resolve.ts`, `load.ts` are
byte-untouched.

### Debt recorded, not fixed

- **`load.ts:85` reports only `issues[0]`** and this task may not edit it, so
  `config-edit.ts` has its own `validateFileConfig` (all issues). When `load.ts`
  can change, one of the two should call the other — the same copy-debt as the
  parse-error message.
- **`run-state.ts:143` `writeAtomic` is still not exported**; `config-run.ts` has
  its own (it needs the mode, the symlink target and the re-stat, which the
  run-state one does not do), so nothing was unified.
- **A map name containing a `.`** (profile `a.b`) cannot be addressed by the
  dotted form; `checkSegments` refuses it, as the eval's A5 told it to. A bracket
  form (`profiles["a.b"].model`) is future work.
- **A lock file** was not added: "documented, not locked (a lock file would be
  new state for a rare case)" — the eval's own decision.
- **A bare known section with no value** (`tentacle config model`) types `""` as
  an object and reports `must be a JSON object, e.g. {"key":"value"}` — a
  confusing answer to "show me the map". It should print the stored value or say
  a value is needed. Found while checking Q-A, not a review finding, so left.
- **Q-A/Q-B are the reviewer's recommendation applied as the default**, pending
  the owner's confirmation (recorded in the task's summary, as asked).
- **An unset leaves an empty object behind** when the removed key was its only
  child (`"subagents": {\n    }`), because `modify` deletes the node, not the
  emptied parent. `jsonc-parser` has no "remove if empty", and pruning in the
  text would touch a second node (against T10's property), so the file keeps a
  `{}` — valid and harmless where the parent's fields are optional. Where one is
  REQUIRED (`mcpServers.*.command`, `schema.ts:66`) the whole-file validate
  refuses the unset instead of writing an invalid entry, which is pinned by a
  test. (Round 2 made the trailing-comma case of this WORK — the orphan comma is
  repaired — but the parent still stays.)

## Review

**Verdict: REQUEST-CHANGES.** The write path is solid (atomic, symlink, mode,
CRLF/tab/comment preservation, validate-before-write all hold), but the secret
rule has two real holes: a secret can still go on argv inside a whole-object
value, and `get <section> --json` prints a stored secret in clear. Both break
eval A4 and need a fix plus a test.

Reviewer: `claude-sonnet-5-5`, a fresh context. The executor was DeepSeek, a
different family. Scratch lives in `./.tentacle/tmp/config-set-review/`; the
real `~/.config/tentacle` was never touched (`TENTACLE_CONFIG_DIR` on every run).

### Findings

**HIGH-1. A secret goes on argv inside an object value** —
`packages/cli/src/config-run.ts:486` (with `config-value.ts:isArgvRefusedSecret`).
The argv refusal only looks at `secretOf(<the key>)`, so the key of a parent
(`model`, `mcpServers.fs`, `mcpServers.fs.env`, `profiles.p`, `profiles.p.model`)
passes, and its JSON carries the credential. Evidence (sandbox dir `sec`):
- `tentacle config model='{"apiKey":"sk-LEAK7"}'` → exit 0, file holds `"apiKey": "sk-LEAK7"`.
- `tentacle config --profile p model='{"apiKey":"sk-LEAK11"}'` → exit 0.
- `tentacle config mcpServers.fs.env='{"T":"sk-LEAK9"}'` → exit 0, `T` stored.
The output masks it (`{"apiKey":***}`), but the value was already in shell
history and `ps`, which is exactly what A4/Q6 forbid. Fix: for an object or
array `set` from argv, parse the typed value and refuse if any path inside it,
under the target's segments, has `secretOf(...) !== undefined` (use the
`flattenStored`/`renderStored` walk, not a new table); refuse also when the
target is a section whose subtree contains a secret key. Apply the
`apiKeyCommand` exemption by path as today. Test: the three commands above, in
both forms, each refused with the file unchanged.

**HIGH-2. `get <section> --json` prints a stored secret in clear** —
`config-run.ts:689-695`. `value = mask === "***" || mask === "[***]" ? mask : found.value`
masks only a leaf; for an object the masked text is `{"apiKey":***}`, so the raw
`found.value` is emitted. Evidence: `tentacle config get model --json` →
`{"key":"model","value":{"apiKey":"sk-LEAK11"}}`; `get mcpServers --json` →
`…"env":{"T":"sk-LEAK9"}…`. The plain `get model` form is masked; only `--json`
leaks. Fix: build the JSON from a masked tree (a `maskStored(value, segments)`
in `config-value.ts` that returns the object with `"***"`/`["***"]` in place of
secrets, and have `renderStored` use it), never from `found.value`. Test:
`get model --json` and `get mcpServers --json` contain no secret substring
(assert on the whole output).

**MEDIUM-3. T9's "an error never contains the value" is not pinned.** I changed
the typed-error path to echo the value, in two places, and the narrow suites
stayed green:
- `config-run.ts:530`: `` `${typed.error} (got ${raw.text})` `` → `config-run` and
  `config-main`: 46 pass, 0 fail.
- `config-value.ts` `typeArray`: `` `must be a JSON array, got ${text}` `` →
  `config-value`, `config-run`, `config-main`: 69 pass, 0 fail.
Fix: add a test that feeds a secret-looking value that fails typing to a secret
leaf (`mcpServers.fs.args` with a non-array via stdin, `mcpServers.fs.env` as a
non-object) and asserts the whole `out + err` lacks it; it must be red on those
two mutations.

**MEDIUM-4. A schema message echoes a stored value, and may echo a secret.**
`config-edit.ts:issueLines` forwards zod text. With a file holding
`"tools":{"execution":"sk-LEAKECHO"}` (a key pasted in the wrong slot),
`config set autoWake false` prints `tools.execution: Invalid enum value.
Expected 'sequential' | 'read-only' | 'parallel', received 'sk-LEAKECHO'`.
Likewise `config list` prints an unknown key's value unmasked
(`model.foo = "sk-LEAKKEYNAME"`). Eval A4 says an error never echoes a value.
Fix: in `issueLines`, drop the `received '…'` tail (strip `, received .*$` from
`invalid_enum_value`/`invalid_literal` messages, or build the line from
`issue.code` and `issue.options`); keep the path and the expected set. The
`list` case is an owner question (Q-B).

**LOW-5. `unset` of the only key of a section with a trailing comma is refused
with a wrong message.** `config-edit.ts` (recheck, last block). File
`{ "tui": { "theme": "dark", }, }`, `config unset tui.theme` →
`[error] the edit would not produce valid JSONC — nothing was changed` and the
hint "check the key's schema". Without the trailing comma the same unset works
(leaves `"tui": {\n  }`). No data loss (fail-closed), but a valid operation on
a file the loader accepts is refused, and the message blames the schema. Fix:
either remove the now-empty parent too, or retry `modify` with
`isArrayInsertion`-free options and the trailing-comma cleanup; at minimum give
a message that names the cause. Add the case to T10.

**LOW-6. A file with no trailing newline gains one** (`config-edit.ts`, the
`edited === "" || /[\r\n]$/` line): `{"maxIterations": 5}` → `…7}\n`. One extra
byte outside the touched node, contra T10's "differs only on the touched node".
Fix: add the newline only when the original text was empty.

**LOW-7. Ctrl+C at the hidden prompt does not abort.** `hidden-input.ts` resolves
`""` on SIGINT/EOF, so the flow continues to the schema, which reports "empty
value … use unset" (a misleading message; nothing is written, so no harm). Fix:
resolve `undefined` on interrupt and exit 130 with "cancelled". Not exercised
on a real TTY here (no TTY available in this session).

**LOW-8. `lstat` errors other than ENOENT read as "not a regular file"**
(`config-run.ts:99`), e.g. EACCES on the directory. Message accuracy only.

### Owner questions

- **Q-A. `tentacle config my nginx` is now a command.** A prompt starting with
  `config` and one or two more words gets `unknown config key "my" / did you
  mean rm?` and no prompt hint (the `explain` hint appears only for
  `unexpected argument`, i.e. 4+ words: `config how do I tune nginx` shows
  `use: tentacle -- config how do I tune nginx`). `tentacle -- config …` still
  reaches the prompt path (`cliMode`: `first === "--"` → prompt). Recommend:
  also print the `promptHint` on `unknown config key` when the first word has no
  `.`/`=` (it cannot be a key path). Consistent with how `explain` was handled.
- **Q-B. Should `config list` mask the value of an unknown/misplaced key?**
  Today it prints it. Recommend masking any value whose key is not in the
  registry unless `--json`-less debugging is wanted: `list` is a place users
  paste into bug reports.
- **Q-C. `mcpServers.*.env.*`/`headers.*` values ARE refused on argv** (confirmed
  for `…env.TOKEN=` and `…headers.Authorization=`); the gap is only the
  object forms (HIGH-1). Eval A4 requires the refusal, so this is not a new
  decision, just completeness.

### Attacks tried (result)

| Attack | Result |
|---|---|
| Tabs, CRLF, comments, trailing commas: `set` | Only the touched node changes; CRLF kept; tab indent kept (`odd`, `crlf`). |
| BOM file | Refused, no write (`InvalidSymbol at offset 0`); the loader rejects it identically (`package list`: `Failed to parse … InvalidSymbol at offset 0`), so no new divergence. |
| Invalid syntax | Refused, file byte-identical. |
| Existing schema-invalid file | Refused, nothing written (`echo1`). |
| A `set` the loader would reject | Not found: validated whole + text re-check. The `mcpServers.fs.env='{"T":…}'` without `command` is refused (`command: Required`). |
| Symlinked config | Written through; link kept (`link` → `real/dot.jsonc`). New dir/file modes 0700/0600 (`stdin`). |
| Not-a-regular-file, rename failure, concurrent change | Read from T11/T12: they use the real fs wrapped with failing/mutating hooks (`tracedFs`), not mocks; non-vacuous for the symlink case (mutation M1). |
| Secret in argv: `model.apiKey=`, `set model.apiKey`, `--profile x`, `profiles.x.model.apiKey=`, `mcpServers.fs.env.T=`, `…headers.Authorization=`, `…args=[…]` | All refused. Object forms are not: HIGH-1. |
| `get`/`list` plain | Masked. `get <section> --json`: HIGH-2. `list --json`: masked. |
| Stdin `-` | One trailing newline trimmed (`"sk-S1\n"` kept from `sk-S1\n\n`). |
| `maxIterations=true`, `model.model=`, `profiles.a.b.c=1`, `--profile x profiles.y…` | Type error / `unset` hint / unknown key / "already names a profile". All fail with nothing written. |
| Dispatch | See Q-A. |

### Mutations (cp backup, narrow test, restore, shasum — all restored, `git status` clean)

| # | Mutation | Test run | Outcome |
|---|---|---|---|
| M1 | symlink: `real = configPath` (no write-through) | `config-run.test.ts` | KILLED (`a symlinked config is written THROUGH the link`) |
| M2 | skip `validateFileConfig` refusal in `planConfigEdit` | `config-edit`, `config-run`, `config-main` | KILLED, 6 tests (T8 ×4, T10 ×1, command surface ×1) |
| M3 | `typeArray` echoes the value | `config-value`, `config-run`, `config-main` | **SURVIVED** (69 pass) → MEDIUM-3 |
| M4 | typed error echoes `raw.text` | `config-run`, `config-main` | **SURVIVED** (46 pass) → MEDIUM-3 |

Hashes after restore equal the pre-mutation ones (`config-run.ts` 6f094c68…,
`config-edit.ts` b26f2077…, `config-value.ts` 71b5b6e7…).

### Premises and gate

- `schema.ts`, `defaults.ts`, `resolve.ts`, `load.ts` byte-untouched vs
  `feat/config-explain`: `git diff feat/config-explain...HEAD -- <the four>` is
  empty. TRUE.
- `bunx tsc --noEmit`: clean. `bunx biome check .`: 743 files, no fixes.
  `bun test packages`: 5624 pass, 3 skip (the opt-in ones), 0 fail, 5627 tests.
- NOT run: `bun run docs:config` (needs approval in this session). The README
  drift test passed inside `bun test`, so the generated block matches.
- AGENTS §7: logic is in `config-edit.ts`, `config-value.ts`, `config-args.ts`;
  `config-run.ts` is I/O behind an injectable `ConfigFs`; the `main.ts` branch is
  thin. No raw terminal write mid-Ink (`config` runs before Ink). No peer or
  broker involvement. Holds.

### What holds

Validate-then-edit-then-recheck design; the injectable fs is real (wraps the
real fs, so T11/T12 prove behaviour); the mutation M1/M2 kills; formatting
preservation (tabs, CRLF, comments); fail-closed on every malformed input I
tried; protected files untouched.

### How the executor behaved

Disciplined on the write path: the plan had the recheck that catches the
`modify` vs zod divergence, and the T11/T12 seams are honest. It stopped short
on secrets: it treated "secret" as a property of the leaf key and never asked
what a container key carries, so both holes are the same blind spot (the output
is masked everywhere it wrote a mask, and nowhere it did not). Its tests assert
the masked outputs but not the absence of the value on error paths, which is how
M3/M4 survive. Shared blind spots with the author's family are possible;
this is the second pass, by a different model.

*— claude-sonnet-5-5, 2026-11-08*

## Review — round 2

**Verdict: PASS.** Every round-1 finding (HIGH-1, HIGH-2, MEDIUM-3, MEDIUM-4,
LOW-5..8) is fixed and pinned; the round-3 layout fix holds on 16 shapes I tried.
0 blocking findings, 0 new defects; 3 non-blocking judgements and 1 owner
question below.

Reviewer: `claude-sonnet-5-5`, a fresh context, and the SAME model as round 1
(not the executors, DeepSeek and claude-opus-4-6). Shared blind spots with my
own round 1 are possible. Scratch: `./.tentacle/tmp/config-set-review2/`
(`a1.sh`…`a5.sh`, `mut*.sh`, `*.out`); `TENTACLE_CONFIG_DIR` on every run, the
real `~/.config/tentacle` never touched. No code changed, nothing committed.

### Owner constraint and gate

- `git diff main --stat -- schema.ts defaults.ts resolve.ts load.ts`: empty. TRUE.
- `bunx tsc --noEmit`: exit 0. `bunx biome check .`: 751 files, no fixes.
  `bun test packages`: **5711 pass, 3 skip (the opt-in ones), 0 fail**, 5714 tests.

### 1. Secret attacks (`a1.sh`, `a2.sh`; grep of all stdout+stderr for each planted value)

Round 1's evidence commands, now: `model={"apiKey":…}`, `--profile p model=…`,
`mcpServers.fs.env={"T":…}` → each exit 1, file not created, the refusal names the
PATH (`model.apiKey`, `mcpServers.fs.env.T`), never the value. New routes:

| Attack | Result |
|---|---|
| `profiles={"p":{"model":{"apiKey":…}}}`, `profiles.p={…}` | refused (`profiles.p.model.apiKey`) |
| `mcpServers={"fs":{"command":"x","headers":{"A":…}}}`, `mcpServers.fs={… "env":{"A":…}}` | refused (`…headers.A`, `…env.A`) |
| `mcpServers.fs.args=["--token",…]`, `mcpServers.fs.args=sk-…`, object holding `args` | refused (`mcpServers.fs.args`) |
| odd case `authorization` (header), `APIKEY`, `apikey`, `api_key` | `authorization` refused; the other three are unknown keys → schema refuses, value not echoed (`Unrecognized key(s)… 'APIKEY'` names the key, not the value) |
| `config <section>=<json>` vs `config set <section> <json>` | same refusal, same text |
| malformed JSON holding a secret (`model={"apiKey":"sk-…"` / unquoted / trailing comma) | `must be a JSON object, e.g. {"key":"value"}`: the parse error does NOT quote the text |
| `model=sk-…`, `model=["sk-…"]` | type error, no value |
| a secret inside a non-secret slot (`subagents={"maxParallel":"sk-…"}`, `tui={"theme":"sk-…"}`) | `Expected number` / `Invalid enum value. Expected 'auto' \| 'dark' \| 'light'`, no `received …` tail |
| the "applies to" line | prints the path and a fixed sentence only |
| stdin `-` for objects | allowed, output masked (`set model = {"apiKey":***,"model":"m"}`) |
| `list` / `list --json` / `get model` / `get model --json` / `get mcpServers --json` / `get profiles --json` / `get …args` / `--profile p get model --json` on a file holding secrets in `model`, `mcpServers.fs.{env,headers,args}`, `profiles.p.model`, and an UNKNOWN `model.foo` | all masked (`***`, `[***]`, `["***"]`); `model.foo` masked (Q-B applied) |
| a file with a secret in a wrong slot, then `config set autoWake false` | refused (3 issues), lines carry path + expected set only |

The only `sk-` strings in any output: `tools.execution = "sk-WRONGSLOT"`
(`list`, `list --json`, `get`) — a KNOWN, non-secret key. Nothing can tell that
value from a legitimate one; masking every known key would make `list` useless.
Not a defect. The key NAME `mcpServers.sk-LEAK40` is echoed, as a path always was.

### 2. Q-A (`a3.sh`; no model session started)

- `tentacle config my nginx` → `unknown config key "my"` + `did you mean rm?` + the line
  `to send this as a prompt, use: tentacle -- config my nginx`. OK.
- `config how do I tune nginx` → `unexpected argument "tune"` + the same hint. OK.
- `cliMode` (`flags.ts:656`): a leading `--` is neither a subcommand nor `-…`
  (`first !== "--"`), so it falls to `"prompt"`; pinned by `config-main.test.ts`
  ("the hint carries the words as typed"). I did not launch `tentacle -- config …`
  (it would start a model session); the reading of the code and that test are the evidence.
- `tentacle config subagents` / `tui` / `model` (a section, no value) →
  `must be a JSON object, e.g. {"key":"value"}` + `an empty value is not a setting —
  to remove the key, use: tentacle config unset subagents`. **Judgement: acceptable,
  not blocking, but the second line steers toward deleting a section the user only
  wanted to look at.** `unset` is a separate explicit command, nothing is written, so
  it is wording, not data risk. Owner question Q-D below.

### 3. The changed seed and hidden-input's contract

- `config-main.test.ts`: the `mcpServers.fs` seed moved from argv to stdin because the
  object form on argv is now refused; the assertions (`args = [***]`, no `tok-123`,
  no `tok-456`) are unchanged and the seed is asserted to succeed (`written === 0`).
  Justified, not weakened. A separate test pins that the argv form is refused.
- `hidden-input`: EOF/Ctrl+C now resolve `undefined` (was `""`). The old EOF test
  was renamed and inverted deliberately (LOW-7), with new tests for Ctrl+C, EOF, an
  empty line still `""`, and a clean screen. The only production caller is
  `main.ts:697`; `config-run.ts:144` types `readSecret` as `string | undefined`
  and exits 130 with `cancelled`, nothing written (pinned). Justified. Nit, not a
  finding: `main.ts:403` still types the io seam `Promise<string>`, which is why the
  test needs `undefined as unknown as string`.

### 4. Mutations (cp backup → narrow tests → restore → `shasum`; `git status` empty after each run)

| # | Mutation | Suites | Outcome |
|---|---|---|---|
| M1 | `secretPathsIn`: stop recursing into children | config-value, config-run, config-main, config-edit | KILLED, 3 tests (nested path, `profiles.p`, path naming) |
| M2 | `maskStored`: a nested map's child returned raw | same | KILLED, 4 tests (incl. "no form of get or list prints a stored secret") |
| M3 | `maskOf`: unknown key not masked (Q-B) | same | KILLED, 4 tests |
| M6 | `typeArray` echoes the text (round 1's M3) | same | KILLED, 1 test (MEDIUM-3 test) |
| M7 | `forwardedMessage` forwards zod's text raw (MEDIUM-4) | config-edit, config-run | KILLED, 1 test |
| M5 | only the `received …` regex fallback at `config-edit.ts:147` removed | same | SURVIVED (137 pass) — it is a belt behind `expectedText`; M7 kills the primary path. Not a finding. |

Hashes after restore: `config-value.ts` `fcc5f8c2…`, `config-edit.ts` `40c5fff6…`,
both equal to before.

### 5. The layout fix (`a5.sh`, 16 cases: `diff` + `cat -et`, then `config list` must load)

Root cause confirmed: `jsonc-parser`'s `withFormatting` widens an insert to the
whole line(s) it touches, and the insert offset is the end of the PREVIOUS
sibling, so that sibling's line is reformatted (the library's own edit in the
executor's probe starts at the `"tui"` line). The fix (`spliceInsert`, own text
layout for the new property only) is the right shape, and a replace was never affected.

Result: the original repro changes ONLY the added lines (`"tui": { "theme": "dark" },`
then `subagents`). Also byte-exact except the added text and the separator comma:
inline array sibling (B); `// trailing` after the sibling (C, comma goes before the
comment); CRLF (D, every new line `^M`); multi-line sibling (I); block comment
spanning lines (H); sibling holding `}, // x` in a string (M); tabs (N); trailing
comma kept, not doubled (O); insert after a middle inline sibling (P) and after
`"a": 1, "b": 2` on one line (L); nested new section 3 levels (K); empty file (J).
Every result loads (`list` exit 0).

- **Inline PARENT (E)** `"subagents": { "enabled": true }` + `subagents.maxParallel`
  → expanded to three lines; and a WHOLE one-line file (F) is expanded to nine.
  Judgement: acceptable, and the executor's non-change is right. There is no
  multi-line layout of that object to preserve; what changed is the touched object's
  own layout, plus (F) its one-line siblings because the touched node IS the root
  line. Eval A3/T10 say comments, other lines and order are preserved: all kept. A
  user who writes JSON on one line gets a readable file after a `set`.
  Fix, if ever wanted: in `spliceInsert`, when the parent is inline, insert
  `, "key": value` before the closing brace (no reformat); red test: E must equal
  `{ "enabled": true, "maxParallel": 3 }`.
- **`unset` of the only key (G)** leaves `"subagents": {\n  }`. Acceptable: valid,
  loads, A3 accepts it, and pruning would edit a second node. Where the parent has a
  required field the whole-file validation refuses. No change requested.

### Findings

None blocking. No new defect from the round-2/3 diff.

### Owner questions

- **Q-D (`config <section>` with no value).** Recommend a one-line follow-up, not a
  blocker: for an object-typed key with no value, say `needs a JSON object value;
  show it with: tentacle config get <key>` (and drop the `unset` hint, kept for a
  leaf given `""`). Red test: `config subagents` stderr must not contain `unset`.
- **Q-A/Q-B** defaults (prompt hint on an unknown first word; unknown keys masked in
  `list`/`get`): confirmed good in practice; recommend keeping them.

### How the executors behaved

DeepSeek (round 2) fixed what the review named, by root cause (one shared
`maskOf` and one `secretPathsIn` instead of tables), and its tests assert the absence
of the value on the output and the error paths, which is what M1–M3, M6, M7 kill.
opus-4-6 (round 3) did the probe first, found the root cause in the library, kept
the change to one seam, listed which of its new tests were NOT red before the fix,
and recorded the inline-parent and empty-parent shapes as decisions instead of
hiding them. Honest reporting throughout; the only gap I found is the wording in Q-D,
which the executor itself had listed as debt.

*— claude-sonnet-5-5, 2026-11-08*
