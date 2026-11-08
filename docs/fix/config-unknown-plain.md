# fix/config-unknown-plain — an unknown config key's value is shown in clear

> **Status:** execution (Review pending — a fresh-context pass)
> **Branch:** `fix/config-unknown-plain`
> **Size:** S · **Blast:** contained · **Suited:** any model; standard in-context Review

## Context

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

`docs/feat/config-set.md` shipped owner question **Q-B** as a *default*: "an
unknown/misplaced key's value is masked" — `maskOf` returns `***` for any path
`resolveKeyPath` does not know, so `tentacle config list` prints `model.foo = ***`
and `list --json` prints `"model.foo": "***"`.

**The owner rejected that default (2026-11-08).** A key the registry does not know
(a typo, or a key in the wrong place, e.g. `"model": { "foo": "x" }`) must show its
value **in clear** in `config list` and `get`, plain and `--json`. Only keys marked
secret in the registry are masked (`***`, `[***]`, every value under
`mcpServers.*.env` / `headers`, `args`), exactly as today. Everything else about
masking stays: the registry is the only source of a mask, and an unknown key *under
a secret map* (`mcpServers.fs.env.ANYTHING`, `mcpServers.fs.headers.Y`) is still a
secret and stays masked — the registry's `mcpServers.*.env.*` / `headers.*` entries
match it by `*`, not by name (`packages/config/src/key-docs.ts:674,726`).

The reason Q-B was recommended ("`list` is what a user pastes into a bug report")
lost to the simpler rule: masking a value the user typed makes a typo impossible to
diagnose, and the registry's secret set is already the authority for what must not
be printed.

**Repro** (2026-11-08, this worktree, `TENTACLE_CONFIG_DIR` under
`.tentacle/tmp/config-unknown-plain/cfg`, file holding `model.foo`,
`bogus`, a real `model.apiKey`, and `mcpServers.fs.env.ANYTHING` /
`headers.Y`):

```
$ tentacle config list
bogus = ***
mcpServers.fs.command = "mcp-fs"
mcpServers.fs.env.ANYTHING = ***
mcpServers.fs.headers.Y = ***
model.apiKey = ***
model.foo = ***
model.model = "qwen3"
$ tentacle config list --json
{"bogus": "***",…,"model.foo": "***",…}
$ tentacle config get model
{"model":"qwen3","apiKey":***,"foo":***}
$ tentacle config get model --json
{"key":"model","value":{"model":"qwen3","apiKey":"***","foo":"***"}}
```

`bogus`, `model.foo` must print their values; `model.apiKey`,
`mcpServers.fs.env.ANYTHING`, `mcpServers.fs.headers.Y` must stay `***`.

## Implementation

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

### Load-bearing assumption

Every mask has exactly two sources, and only one of them is "unknown": the registry
secrets (which must survive) and the Q-B unknown-key branch (which must go). Both
live in ONE function, `maskOf` (`packages/config/src/config-value.ts:169-182`), and
every printed form is built from it — `renderStored` (`:189`), `maskStored`
(`:222`), `printedValue` (`:283`) and `flattenInOrder` (`:319`). So removing the
branch's last line is the whole fix, and the secret branches above it (`secret ===
"values"` → `[***]`, `secret === true` → `***`) are untouched.

### Preconditions

- `secretOf` resolves through `docForKey` → `resolveKeyPath`, and the registry has
  `mcpServers.*.env.*` / `mcpServers.*.headers.*` with `secret: true`
  (`key-docs.ts:674-681`, `:726-732`): an unknown NAME under a secret map still hits
  a `secret: true` entry. Verified by the existing `A4` test
  (`packages/config/test/config-value.test.ts:118-121`).
- `isKnownKey` (`config-value.ts:134`) has no other caller in the tree (only the
  `maskOf` line itself), so removing the branch makes it dead code: delete it.
- `get` refuses a key the schema does not know *before* rendering
  (`packages/cli/src/config-run.ts:585`, `:604`, `unknownKey`), so `get model.foo`
  still errors as today; `get model` (a KNOWN section) is where the unknown child's
  value now appears in clear.
- Nothing else masks on "unknown": `secretPathsIn`/`isArgvRefusedSecret` are
  registry-only already (`config-value.ts:148`, `:250`).

### Design

Remove `return isKnownKey(key) ? undefined : MASK;` from `maskOf`, leaving it a pure
registry lookup (`undefined` when the registry has no secret for the path). Delete
the now-unused `isKnownKey`. Update the two comments that state Q-B as behaviour
(`maskOf`'s doc comment, `flattenInOrder`'s) to say the mask is the registry's
secret set only. No other source change: `renderStored`, `maskStored`,
`printedValue`, `flattenStored` and `config-run.ts` all keep working through the same
`maskOf`.

Consequence, intended: an unknown key is now flattened like any other plain setting,
so `"model": {"foo": {"a": 1}}` lists `model.foo.a = 1` (before: one masked
`model.foo` line). Its value is in clear, which is the point.

### Files

1. `packages/config/src/config-value.ts` — drop the unknown-key branch and
   `isKnownKey`; fix the two comments (`:160-168`, `:317-319`).
2. `packages/config/test/config-value.test.ts` — replace the `Q-B` test
   (`:262-273`) with its inverse (unknown key in clear, secret map under an unknown
   name still masked); add a `flattenStored` case.
3. `packages/cli/test/config-run.test.ts` — replace the `Q-B` test (`:509-520`):
   `list`, `list --json`, `get model`, `get model --json` show `model2`/`model.foo`
   in clear; secrets stay masked in the same run.
4. `README.md` — the secret paragraph (`:415-418`) if it claims unknown keys are
   masked (it does not: it names `env`, `headers`, `args` only — verify, edit only
   if wrong).
5. `docs/feat/config-set.md` — one line where Q-B is stated as applied.

### Failure modes

- **Unmasking a secret under a secret map.** The real risk of deleting the branch.
  Pinned by tests on `mcpServers.fs.env.ANYTHING` and `mcpServers.fs.headers.Y`
  (names the registry does not list) in both trees and both suites.
- **A secret leaf at an unknown-but-past-a-known-secret path.** Covered by the same
  two cases (`env`/`headers` are `secret: true` per child, resolved by the `*` doc).
- **`get <unknown key>` starts printing a value.** It does not: `get` refuses an
  unknown key before rendering (`config-run.ts:585,604`), and a test pins the
  refusal (kept from the old Q-B test).
- **`get <known section>` still masks its secret children.** Existing HIGH-2 tests
  are unchanged and still assert `apiKey: "***"`.
- **A masked parent stops the walk** (`flattenInOrder`): still true for secrets, so
  `mcpServers.fs.env` still lists one masked line per variable, never a leaking
  parent/child mix. No change in behaviour there.

### Tests

Red first (`AGENTS.md` §9), on the current code:

- `config-value.test.ts` — `maskStored({model:{foo:"hello"}}, [])` equals
  `{model:{foo:"hello"}}`; `flattenStored` lists `model.foo = "hello"`; and the
  secret cases (`env`/`headers` under an unknown name) still `***` (those assertions
  are green before and after — they guard the change, they are not the red).
- `config-run.test.ts` — `list` contains `model2 = {…}` in clear, `list --json`
  has `model2` not `"***"`, `get model` / `get model --json` show `foo` in clear;
  in the SAME run the four registry secrets (`model.apiKey`,
  `mcpServers.fs.env.TOKEN`, `mcpServers.fs.headers.Authorization`, `args`) are
  still masked and still absent from `out+err`.

Non-vacuity: one mutation (re-add the unknown-key branch → the new tests fail),
`cp` backup + `shasum` restore.

## Execution

*— deepseek-v4.1-flash (tentacle), 2026-11-08*

`bun install` first (the worktree had no `node_modules`, so every CLI run failed
with `Cannot find module '@tentacle/docker'`), then the Repro above, which
reproduced Q-B exactly as described.

In order:

1. **Red** (`AGENTS.md` §9), tests edited first, on unmodified code:
   - `packages/config/test/config-value.test.ts` — the `Q-B` test inverted
     ("an unknown key's value is IN CLEAR"), the `bogus = ***` assertion in
     "renderStored of the masked tree…" changed to `bogus = "typo-value"`, and a
     new `flattenStored` case (unknown nested object flattens, key by key).
     Also added "an unknown NAME under a secret map is STILL a secret".
     → `bun test packages/config/test/config-value.test.ts`: **3 fail**
     (`model.foo` → `"***"`, `bogus = ***`), on the assertion, not on a compile error.
   - `packages/cli/test/config-run.test.ts` — the `Q-B` test replaced by
     "an unknown/misplaced key's value is IN CLEAR" over a new `seededUnknown()`
     file: `list`, `list --json`, `get model`, `get model --json`, plus the
     secrets of the same file still `***` and absent, plus `get model2` still
     refused without echoing its value.
     → `bun test packages/cli/test/config-run.test.ts`: **1 fail** (`model.foo = ***`).
2. **Green**: the change in `packages/config/src/config-value.ts` — `maskOf`'s
   last line (`return isKnownKey(key) ? undefined : MASK;`) replaced by
   `return secret === true ? MASK : undefined;`; `isKnownKey` deleted (no other
   caller, verified by `rg`); the four comments that stated Q-B fixed. Both
   suites: `102 pass, 0 fail` (with `config-main.test.ts`).
3. **Mutation** (`cp` backup → `shasum` → re-add the unknown-key branch on
   `resolveKeyPath` → narrow tests → restore → `shasum -c`): **KILLED, 4 tests**
   (`T9`'s flatten case, the two `config-value.test.ts` Q-B cases, the CLI Q-B
   case), `61 pass / 4 fail`. Restored: `0510822e…` before = after, `shasum -c` OK.
4. Docs: `docs/feat/config-set.md` — the one required line in Q-B's paragraph;
   also repaired a missing space (`…`isKnownKey`, from`resolveKeyPath``) that my
   first edit exposed, a formatting fix only. `README.md` — the secret paragraph
   now states the rule the owner chose (the registry is the only thing masked; a
   key it does not know prints in clear). `--help`/`USAGE.config`
   (`packages/cli/src/main.ts:214-224`) never claimed unknown keys are masked — no
   change.

**Drift from Implementation.** One, in the test scope, and it is the owner's
rule, not a weakening: the HIGH-2 seed in `config-run.test.ts` held
`"model2": { "apiKey": "${SECRET}" }`, and "no form of get or list prints a
stored secret" asserted the *string* `sk-STORE9` was absent from every form. With
Q-B gone, `model2.apiKey` is a path the registry does not know (`model2.*` is not
`model.apiKey`), so it is in clear and that test failed with exactly
`model2.apiKey = "sk-STORE9"`. I removed that one entry from the HIGH-2 seed (its
assertions otherwise unchanged) rather than mask by name, and pinned the boundary
as a decision in `config-value.test.ts` (`maskStored({model2:{apiKey:"sk-x"}})` is
in clear — masking by name would need a second table of secrets, which A4
forbids). The Q-B test asserts the in-clear sibling explicitly. This is the one
place where the owner's rule and "no output contains a secret value" meet, and
the owner's rule wins: a credential-shaped value at a path the registry does not
know is reported as a misplaced key, not silently masked.

**Gate** (2026-11-08, this worktree):

```
$ bunx tsc --noEmit                       → 0 errors
$ bunx tsc -p apps/mobile --noEmit        → 0 errors
$ bunx biome check .                      → Checked 751 files. No fixes applied. 0 errors/warnings
$ bun test packages                       → 5715 pass, 3 skip, 0 fail (386 files, 163s)
$ bun run docs:config                     → README.md's config table is up to date; tree clean
```

The 3 skips are the opt-in ones (live-k8s, live-docker, real-socket keepalive).

**Live `config list` on a scratch file** (`.tentacle/tmp/config-unknown-plain/`,
`TENTACLE_CONFIG_DIR` under it; one unknown child under a known section, one
unknown top-level key, and a secret in every secret slot — values replaced with
`<SECRET>` for this paste):

```
file: {"model":{"model":"qwen3","apiKey":"<SECRET>","foo":"hello-typo"},
       "mcpServers":{"fs":{"command":"mcp-fs","env":{"ANYTHING":"<SECRET>"},
                           "headers":{"Y":"Bearer <SECRET>"},"args":["--token","<SECRET>"]}},
       "bogus":"visible-wrong-place"}
$ tentacle config list
bogus = "visible-wrong-place"
mcpServers.fs.args = [***]
mcpServers.fs.command = "mcp-fs"
mcpServers.fs.env.ANYTHING = ***
mcpServers.fs.headers.Y = ***
model.apiKey = ***
model.foo = "hello-typo"
model.model = "qwen3"

$ tentacle config list --json
{"bogus": "visible-wrong-place","mcpServers.fs.args": ["***"],"mcpServers.fs.command": "mcp-fs","mcpServers.fs.env.ANYTHING": "***","mcpServers.fs.headers.Y": "***","model.apiKey": "***","model.foo": "hello-typo","model.model": "qwen3"}

$ tentacle config get model
{"model":"qwen3","apiKey":***,"foo":"hello-typo"}

$ tentacle config get model --json
{"key":"model","value":{"model":"qwen3","apiKey":"***","foo":"hello-typo"}}

$ tentacle config get mcpServers --json
{"key":"mcpServers","value":{"fs":{"command":"mcp-fs","env":{"ANYTHING":"***"},"headers":{"Y":"***"},"args":["***"]}}}

$ tentacle config get bogus
[error] unknown config key "bogus"
run `tentacle explain` to see the top-level keys
```

Unknown keys in clear (`bogus`, `model.foo`), every registry secret still `***`
/ `[***]` — including the names the registry does not list under `env`/`headers`
— and `get <unknown key>` still refuses without printing it.
