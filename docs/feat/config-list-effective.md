# feat/config-list-effective — `config list` shows every known key with its effective value and origin; `config get` answers for an unset key

> **Status:** execution done — Review pending (fresh context)
> **Branch:** `feat/config-list-effective`
> **Type:** feat · Size: S–M · Blast: contained · Suited: DeepSeek (standard, in-context Review)
> **Changelog:** `changelog.d/config-list-effective.changed.md`

## Context

*— deepseek-v4.1-flash (tentacle), 2026-11-13*

`tentacle config list` prints only what the file happens to hold, so the answer
to "what is `model.images` right now?" is invisible: the key is unset (its
value is the provider's default), so it is neither in `list` nor answered by
`get`. The owner decided (2026-11-13, binding):

1. `config list` shows **every known key** — the key registry, `KEY_DOCS` —
   with its **effective value** and its **origin** as a trailing comment
   (`default`, user config file, profile, env var), naming *which* default when
   it depends on something (`model.images = false   # default (openai-compatible)`).
   Secrets stay masked (`[***]`/`***`, unchanged).
2. `config list --set` = today's behaviour exactly (only keys set in the file,
   output unchanged) — the old output stays reachable.
3. `config get <key>` on an unset key prints the effective value **with its
   origin** and exits 0; an unknown key still errors (exit 1).

**Repro** (`.tentacle/tmp/config-list-effective/repro.sh`, run 2026-11-13 on
this branch, config file = `{"model":{"model":"qwen3"},"maxIterations":8}`):

```
$ tentacle config list
maxIterations = 8
model.model = "qwen3"
[exit 0]

$ tentacle config list | grep image   (nothing)
  <no output>

$ tentacle config get model.images
[error] model.images is not set in `…/cfg/config.jsonc`
[exit 1]

$ tentacle config get model.maxImageBytes
[error] model.maxImageBytes is not set in `…/cfg/config.jsonc`
[exit 1]
```

So: the capability is missing, and the two keys the owner named are the
sharpest case (their default is the *provider's*, i.e. it depends on another
key). Note there is no project config file in this build — `scope` is
`user | profile` (`packages/config/src/key-docs.ts:47-52`), and the project
file is still an open eval (`docs/eval/project-config.md`), so the origin set
is `default · file · profile · env` plus the two CLI-side defaults.

## Implementation

*— deepseek-v4.1-flash (tentacle), 2026-11-13*

### Load-bearing assumption

**`resolveConfig` is pure and total for a file + env, so the effective view can
be built with no I/O, and the registry already carries every fact needed to
label a value's origin.** Cited:

- `resolveConfig(ctx: ResolveContext)` takes `{fileConfig, env, defaultCwd}` and
  does no I/O — `packages/config/src/resolve.ts:381`; its module comment says so
  ("This module performs NO I/O", `resolve.ts:1-9`).
- It returns `sources` per setting, `Source = "env" | "file" | "default" |
  "carried"` (`resolve.ts:50`, `resolve.ts:170-202`), and each key's registry
  entry names the `sources` field it lands in (`sourceKey`, `key-docs.ts:107`;
  pinned in both directions by `config/test/key-docs.test.ts:309-318`).
- The registry's `default()` thunk is pinned to a real resolution
  (`config/test/key-docs.test.ts:229-250`), and `renderDefault`
  (`key-docs.ts:1237`) is the "default as text" for the ones that are runtime
  state or provider-dependent (`model.baseURL` `key-docs.ts:177-186`,
  `model.maxTokens` `:273-275`).

Cheap test that decides it: build the view from an empty file + empty env and
compare each entry's rendered value with `doc.default()` / `renderDefault`.
If that does not hold for the whole registry, the design is wrong.

### Preconditions

- `KEY_DOCS` is the total list of keys (`key-docs.ts:1147`), with the
  `profiles.*.` mirror derived (`:1155-1170`), so "every known key" has one
  source of truth; `leafPaths()` (`:1179`) and `renderDefault()` (`:1237`)
  already exist. Sections (`kind: "section"`, `:1174-1194`, 20 of them) are
  containers: they are NOT settings, and `list` prints leaves.
- `docForKey` maps a concrete key to its registry entry through the map `*`
  segment (`config-value.ts:128-131`, via `resolveKeyPath`,
  `config-keys.ts:19-27`), so `mcpServers.fs.command` → `mcpServers.*.command`.
  Masking is registry-driven and unchanged (`maskStored`/`renderStored`,
  `config-value.ts:184-233`).
- The profile fold erases its own provenance (`profile.ts:52-140`), exactly as
  `docs/eval/config-cli.md:338-343` states — so the origin must come from a
  *second* resolution without the profile (base) compared to one with it; no
  change to `applyProfile` is needed for what the owner asked (see Design).
- `readFileConfig` is async I/O + schema validation (`load.ts:59-74`); the
  `config` command is deliberately BEFORE `loadConfig` and must work on a
  broken file (`main.ts:672-678`), so the view is built from the *already
  parsed + validated* file the `config` path has, not from `loadConfig`.
- The provider defaults that `model.images` / `model.maxImageBytes` fall back to
  are `imageLimits()` (`packages/providers/src/images.ts:141-153`) with
  `ANTHROPIC_MAX_IMAGE_BYTES = 3_932_160` (`images.ts:38`) and
  `OPENAI_MAX_IMAGE_BYTES = 5 MiB` (`images.ts:45`). `@tentacle/config` cannot
  import them: `providers` depends on `core`/`protocol` only
  (`packages/providers/package.json`) and `config` has no dependency on
  `providers` (`packages/config/package.json`) — adding one would invert the
  graph. So these two defaults are TEXT in the registry (`defaultText`), which
  is the same device `model.baseURL`/`model.maxTokens` already use.

### Design

Three additions, all pure except the existing file read:

1. **`packages/cli/src/config-effective.ts` (new, pure, unit-tested).**
   *(As built: in `cli`, not `config` — see Execution drift 1: the provider's own
   `imageLimits()` is the default for the two image keys, and
   `@tentacle/config` must not depend on `@tentacle/providers`. The two
   provider-dependent notes are computed there, not added to `KeyDoc`.)*
   ```ts
   export interface EffectiveEntry {
     readonly path: string;              // canonical registry path (model.images)
     readonly value: string;             // rendered, already masked where secret
     readonly origin: Origin;            // see below
   }
   export type Origin =
     | { readonly kind: "file" }
     | { readonly kind: "profile"; readonly name: string }
     | { readonly kind: "env"; readonly name: string }
     | { readonly kind: "default"; readonly note?: string }   // note = "openai-compatible"
     | { readonly kind: "unset" };                            // no default, not set
   export function effectiveEntries(input: {
     readonly fileConfig: FileConfig;     // parsed + validated, profile NOT folded
     readonly profile?: string;           // --profile / TENTACLE_PROFILE
     readonly env: Env;                   // process env (TENTACLE_*)
   }): readonly EffectiveEntry[];
   export function originText(origin: Origin): string;  // "# file", "# profile work", …
   ```
   How a value + origin is decided, per registry leaf, with no second table:
   - **Fold** the profile first (`applyProfile(fileConfig, profile)` — pure,
     `profile.ts:52`), giving `merged`. Resolve BOTH `merged` and the base
     (`applyProfile(fileConfig, undefined)`) with `resolveConfig` under the same
     env, so `sources` of each come from the loader's own `pick()`
     (`resolve.ts:246-257`).
   - **env**: `doc.env !== undefined && env[doc.env] !== undefined` → origin
     `env(doc.env)`. This is *the same predicate* `resolveConfig` uses for every
     `pick`, but read from the registry so it also covers keys with no
     `sourceKey` (`model.images`, `rm`, …). For `envInverts` keys
     (`loadAgentsMd`, `loadSkills`, `:46-48` of the doc type) the value comes
     from `resolved()`/the resolved config, never from the raw env.
   - **profile**: not env, the merged resolution differs from the base one
     (`merged` value !== base value) → origin `profile(name)`.
   - **file**: not env/profile, and the base resolution differs from the
     default-only resolution (empty file + the same env *minus* the doc's own
     env var) → origin `file`.
   - **default**: otherwise → the value from `doc.resolved?.(resolved)` when the
     entry has one (the loader's own accessor, `key-docs.ts:104-107`), else
     `doc.defaultText` (text defaults), else `doc.default()`.
     Sections are skipped; a leaf with neither `default` nor `defaultText` and
     not set is `unset` and printed as `(unset)` with `# no default` — e.g.
     `model.titleModel`.
   - **Which default (owner's example)**: `model.images`/`model.maxImageBytes`
     get a *provider-dependent* note by rendering their value through the
     resolved provider: `false` + `# default (openai-compatible)` /
     `true` + `# default (anthropic)`. To keep one source of truth the note
     comes from the registry entry (`defaultText` carries the two provider
     cases; a small `defaultNote?: (c: ResolvedConfig) => string | undefined` on
     `KeyDoc` is added for exactly this — a function of the *resolved* config,
     so it can never disagree with the value beside it).
   - **Value rendering** reuses `renderStored`/`maskStored` (`config-value.ts`),
     so secrets are masked exactly as today (`***`, `[***]`) and the owner's
     rule "secrets stay masked as today" is satisfied by *reuse*, not by a new
     mask table.
   - **Map/array keys** (owner asked explicitly):
     - a map's entries present in the file (`mcpServers.fs.*`, `models.fast.*`,
       `packages.<name>`, `subagents.types.<t>.*`) are listed per concrete entry,
       exactly as `--set` lists them today, with the origin of the *entry*;
     - a map with no entries in the file is NOT expanded (there is no name to
       print) and its per-field registry leaves (`mcpServers.*.command`) are
       listed once, as the schema default/`unset` — one line each, no invented
       names;
     - `models.<name>` entries are resolved over the main model
       (`resolveModelEntry`, `models.ts:66`), so an unset field shows the
       inherited value with origin `# default (from model)`.
       Arrays are leaves (`flattenStored`, `config-value.ts:278`), unchanged.

2. **`packages/cli/src/config-run.ts`.** `list` gains `--set` (today's path,
   byte-identical output); the default path calls `effectiveEntries` and prints
   `path = value` padded, then `  # origin`. `get` on a not-found key prints the
   effective line (value + origin) with exit 0 instead of the "not set" error;
   a key the registry does not know still goes through `resolveTarget` →
   `unknownKey` (exit 1, unchanged). `--json` gains `{path, value, origin}` per
   entry (the value masked) — the machine form must stay honest about origin.

3. **`packages/cli/src/config-args.ts` + `flags.ts`.** `list --set` →
   `{kind: "list", setOnly: true}`; `--set` on anything else is refused with the
   usage line; `USAGE.config` mentions it.

### Files

1. `packages/cli/src/config-effective.ts` — NEW pure module (the whole
   computation above). *(As built: `packages/cli/`, not `packages/config/`.)*
2. `packages/cli/src/config-args.ts` — `setOnly` on the list op, `--set`
   handling, usage.
3. `packages/cli/src/flags.ts` — `set` as a bool of `config`, USAGE text.
4. `packages/cli/src/config-run.ts` — `list`/`get` print the effective view.
5. Tests: `packages/cli/test/config-effective.test.ts` (new),
   `packages/cli/test/config-args.test.ts`,
   `packages/cli/test/config-main.test.ts` (+ `config-run.test.ts` where the
   existing get/list assertions meet the new default).
6. `changelog.d/config-list-effective.changed.md`.

*(As built, `key-docs.ts` and `packages/config/src/index.ts` are NOT touched:
no registry field was added, because the provider-dependent notes belong where
`@tentacle/providers` is already a dependency.)*

### Failure modes

| Case | Behaviour |
| --- | --- |
| Unknown key (`get model2`) | unchanged: `unknown config key`, exit 1 — the effective view never invents a value for a path the registry does not know. |
| File does not parse | `list`/`get` refuse as today (`planRefusal`, config-run's existing path); no effective view is printed on top of a file we cannot read. |
| File parses, schema fails | as today: `get`/`list` still answer from the parsed text (they are how a user finds the offending key, `config-main.test.ts:340-352`) — the effective view is built from the *parse-able* subset; a leaf the schema would reject is still printed with origin `file` (its value, in clear — that is the diagnostic value). |
| Secret leaf, set or default | masked by the same `renderStored`/`maskStored` path: `model.apiKey = ***  # file`. A `--json` value is the masked tree. Never a prefix, never a length (eval A4). |
| Default depends on another key | the value AND the note come from the same resolved config (`defaultNote(resolved)`), so `model.images = false # default (openai-compatible)` — they cannot disagree. When the provider is set by env, the value follows it and the note says so. |
| Key with no default (`model.titleModel`, `sessions.keepSuperseded`, …) | printed `(unset)` with `# no default` — the honest answer; `get` exits 0 with the same line and origin `unset`. |
| `--profile` names no such profile | unchanged: exit 1, `no profile "x"`. |
| Env var set to an invalid value | `resolveConfig`'s `pick` ignores an unparseable env value and falls through (`resolve.ts:258-300`), so the origin must NOT claim `env` when the value did not move. Predicate: env is the origin only when the entry's `resolved()` value actually equals a resolution under that env — i.e. compare the resolution with and without it, exactly as the file/profile test does. A `TENTACLE_PROVIDER=nonsense` therefore reports `default`, which is what the loader does. |
| `--set` with `--json` | `--json` still applies (machine form of the file's own entries). |
| A huge file / many map entries | output is one line per leaf; no new work beyond what `--set` does today (same walk) plus one `resolveConfig` per layer (cheap, pure). |
| A pod/`serve` etc. | not touched: this is `config`, laptop-side only. No protocol change, no persisted format change. |

### Tests

Red before green for every new behaviour (§9), plus a non-vacuity mutation.

`packages/config/test/config-effective.test.ts` (the pure module):
- T-E1 *every registry leaf appears exactly once, in path order* — pins
  "EVERY known key": `effectiveEntries({fileConfig:{}, env:{}})` paths ===
  `leafPaths()` minus the `profiles.*.` mirror (and the mirror is absent without
  `--profile`).
- T-E2 *an empty file yields the registry defaults*: for each entry with a
  `resolved`, the printed value equals `renderDefault(doc)`/`doc.resolved` —
  the "default is the loader's own" pin.
- T-E3 *`model.images` with an empty file says `false` + `default
  (openai-compatible)`; with `TENTACLE_PROVIDER=anthropic` says `true` +
  `default (anthropic)`; with `model.images: true` in the file says
  `true  # file`* — the owner's example, end to end.
- T-E4 *origins*: one leaf per origin (file, profile, env, default, unset) in a
  single fixture; a profile value reports `profile(name)`, and the same key
  unset in the profile reports the base's origin (not `profile`).
- T-E5 *a bogus env value never claims `env`* (`TENTACLE_PROVIDER=nonsense`,
  `TENTACLE_MAX_ITERATIONS=abc`) → `default`.
- T-E6 *secrets are masked*: `model.apiKey` (file) + a default-valued secret
  prints `***`; no raw value anywhere in the joined output.
- T-E7 *maps/arrays*: `mcpServers.fs.command` (file) appears as itself;
  `mcpServers.*.command` appears when no server is defined; `models.fast.model`
  inherits `model`'s id with `default (from model)`; an array leaf
  (`tools.writableDirs`) prints as JSON.

`packages/cli/test/config-args.test.ts`:
- T-A1 `list --set` → `{kind:"list", setOnly:true}`; `list` → not `setOnly`;
- T-A2 `--set` with `get`/`set`/`unset`/`path` is refused, naming `list`.

`packages/cli/test/config-main.test.ts`:
- T-C1 `config list` on a file holding `model.model` + `maxIterations` prints
  `model.images = false   # default (openai-compatible)` and still prints the
  file's own keys with `# file` — the owner's grep now finds it.
- T-C2 `config list | grep image` finds two lines (model.images,
  model.maxImageBytes) — the repro turned green.
- T-C3 `config list --set` output is **byte-identical** to today's (assert on
  the exact string).
- T-C4 `config get model.images` exits 0, prints value + origin; `config get
  model.model` (set) is unchanged (`"qwen3"`); `config get model2` still exits 1
  with `unknown config key`.
- T-C5 `config get model.apiKey` (set) stays `***`; `config get
  model.maxImageBytes` exits 0 with the provider limit + origin.
- T-C6 `--json` carries `{path, value, origin}` and no secret.

Mutation checks (paste in Execution): (M1) drop `defaultNote` rendering →
T-E3/T-C1 fail; (M2) make `list` ignore `--set` → T-C3 fails.

## Execution

*— deepseek-v4.1-flash (tentacle), 2026-11-13*

Gate: `bun run typecheck` (root + `apps/mobile`) OK · `bun run lint`
(`biome check .`, 964 files) clean · `bun test` **7637 pass, 3 skip (the three
opt-in skips: live-k8s, live-docker, real-socket keepalive), 0 fail**.

**Where the computation lives.** `packages/cli/src/config-effective.ts` (new,
pure, 479 lines, no I/O): `effectiveEntries` / `effectiveEntry` / `effectiveLine`
/ `originText`. It reads the file the `config` path already parsed, folds the
profile (`applyProfile`), resolves BOTH views (`resolveConfig`) and takes the
origin from the loader's own `sources` — the layering is never re-derived by
hand. The provider-dependent defaults the registry cannot state
(`model.images`, `model.maxImageBytes`, `model.maxTokens`, a `models` entry's
inherited fields) are computed there from `imageLimits()`, so the value and its
`# default (anthropic)` note come from one call.

**Drift from Implementation (all deliberate, each recorded here):**
1. *The module is in `packages/cli`, not `packages/config`.* `model.images`'s real
   default is `imageLimits()` in `@tentacle/providers`, and `@tentacle/config`
   must not depend on it (that would invert the graph:
   `providers` → `core`/`protocol` only). In `cli` both packages are already
   dependencies, so the default is the providers' own function rather than a
   copied constant. The registry stays docs-only: no `defaultNote` field was
   added, and `key-docs.ts` is untouched.
2. *No project origin.* There is no project config file in this build
   (`scope` is `user | profile`; the project file is still `docs/eval/project-config.md`),
   so the origin set is `file · profile · env · default · unset`, as the plan's
   Context already said.
3. *`--json` for the new `list` is an ARRAY of `{path, value, origin}`*, not an
   object keyed by path: an object cannot carry two fields per key without
   nesting, and the origin is the point. `list --set --json` keeps the old object
   shape byte-for-byte (it is the same code path).
4. *`defaultText` is a fallback, not the answer, where the loader has a value*:
   `sessions.keepSuperseded` → `false`, `mount.hide` → `DEFAULT_HIDE` (imported
   from `workspace-mount.ts`, the module that owns it), `mount.hideExtra` → `[]`.
   Without that, 4 keys printed `(unset)` while the daemon really does use `false`.
5. *Unknown keys in the file are still listed* (origin `file`, in clear), reusing
   `flattenStored`, to keep `docs/fix/config-unknown-plain.md`'s diagnosis path.
   A KNOWN-but-container node (`model`, an empty `mcpServers.fs`) is excluded by
   `docForKey`/`kind`, so no section is ever listed as a setting.

**Two bugs found by probing shapes, both fixed and pinned:**
- `applyProfile` can THROW on a shape it cannot fold (`{"profiles":{"work":{"tools":5}}}`,
  `{"subagents":{"types":"x"}}`, …), and `config` runs before the loader — so
  `list`/`get` would have died with a `TypeError`. `safeProfile` refuses instead
  (defaults are then listed, which is exactly what the loader would use).
- a file whose top level is not an object (`"x"`) made `flattenStored` emit
  `0 = "x"  # file`. Now refused in words:
  `[error] …: a config file is a JSON object`.

**Tests (all red before green, §9).**
- `packages/cli/test/config-effective.test.ts` (new, 16 tests): T-E1 every known
  leaf once (and no section) · T-E2 the loader's own defaults · T-E3 the owner's
  example (`model.images` openai → `false # default (openai-compatible)`,
  `TENTACLE_PROVIDER=anthropic` → `true # default (anthropic)`, file → `# file`)
  and `model.maxTokens` · T-E4 origins (file/env/default/profile, an unparseable
  env value never claims `env`, an inverted env var shows the boolean) · T-E5
  secrets masked on the line and in the value, never in the joined JSON · T-E6
  maps/arrays (real names replace the pattern, `models.fast.model` inherits
  `# default (from model)`) · T-E7 the printed form + an unknown profile lists
  nothing.
- `packages/cli/test/config-args.test.ts` +2 assertions/tests: `list --set` parses
  to `setOnly: true`; `--set` on `get`/`path`/`unset`/`set` is refused.
- `packages/cli/test/config-main.test.ts`: `list` prints every known key with
  origin (the repro's `grep image` now finds two lines) · `list --set` output
  **byte-identical** (`maxIterations = 8\nmodel.model = "qwen3"\n`) and different
  from the default form · `list --json` carries `{path,value,origin}` and masks a
  secret · `get model.images` / `model.maxImageBytes` exit 0 with the line (and
  follow `TENTACLE_PROVIDER`) · `get model.titleModel` (no value at all) and
  `get model2` (unknown) still exit 1 · a wrong SHAPE never crashes the view, and
  a non-object file is refused.
- `config-run.test.ts`: the three file-only-view assertions now say
  `{kind:"list", setOnly:true}` (they pin the OLD output, which is `--set`).

**Red-before-green evidence** (old code = `git show HEAD:…` restored into place,
everything else untouched — no checkout/restore/stash; the copies live in
`.tentacle/tmp/config-list-effective/redcheck/`):
```
=== OLD CODE (pre-feature) + NEW tests:
(fail) get on an unset key prints the effective value and its origin, exit 0
(fail) --json is machine-readable for get and list
(fail) --profile targets profiles.<name> in the same file
(fail) list: every known key with its effective value and origin (owner 2026-11-13)
(fail) list --set prints exactly what it used to: only the file's own keys
(fail) list --json carries path, value and origin
 6 fail    (config-main)   |  2 fail (config-args: --set parsing + refusal)
```
With the implementation back: `111 pass / 0 fail` across the four config test files.

**Mutation checks (2, each red then reverted to green):**
```
M1  drop the provider note for the two image keys (defaultNote):
(fail) get on an unset key prints the effective value and its origin, exit 0
(fail) --json is machine-readable for get and list
(fail) list: every known key with its effective value and origin (owner 2026-11-13)
(fail) list --json carries path, value and origin
(fail) T-E3 … model.images follows the provider, and says which one
 5 fail → reverted: 58 pass / 0 fail

M2  make `list` ignore --set (always the file-only view):
(fail) --json is machine-readable for get and list
(fail) --profile targets profiles.<name> in the same file
(fail) list: every known key with its effective value and origin (owner 2026-11-13)
(fail) list --set prints exactly what it used to: only the file's own keys
(fail) list --json carries path, value and origin
 5 fail → reverted: 237 expect() / 0 fail
```

**Repro, after** (`.tentacle/tmp/config-list-effective/repro-after.out`):
```
$ tentacle config list | grep image
model.images = false  # default (openai-compatible)
models.*.images = (unset)  # no default

$ tentacle config get model.images
model.images = false  # default (openai-compatible)
[exit 0]

$ tentacle config list --set
maxIterations = 8
model.model = "qwen3"          ← byte-identical to the old `list`

$ tentacle config get model.imagez
[error] unknown config key "model.imagez"
did you mean model.images, models.*, model?      [exit 1]
```

Also: `README.md` (the CLI example and a paragraph on the origin column) and
`changelog.d/config-list-effective.changed.md` (one `changed` bullet;
`CHANGELOG.md` untouched). Files changed: `packages/cli/src/config-effective.ts`
(new), `config-run.ts`, `config-args.ts`, `flags.ts`, three cli test files (+ one
new), `README.md`, the changelog fragment, this doc.

## Review

*— <model-id>, <YYYY-MM-DD>*

(pending)
