# eval/packages — declarative bundles of skills, agents, MCP servers and hooks

> **Status:** eval. Owner decision D11 in the umbrella. K1–K3 **decided 2026-10-21**. Implementation drafted below, approved at promotion.
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promote to `feat/packages`.
> **Type:** eval → feat · **Size:** M · **Blast:** cross-module (config loading, skills scan, agent defs, MCP config, a new CLI subcommand; no protocol / persistence-format / agent-loop change) · **Suited:** a weaker model may execute with a standard Review; fresh-context Review if the scope grows to touch trust
> **Umbrella:** [`extensibility.md`](./extensibility.md) (child 5 of 5) · **Needs:** `hooks-core` merged (packages may carry hooks)

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
| User sub-agent types load from `<configDir>/agents/*.md` only | `cli/src/wiring.ts:59-77` (`loadUserAgentTypes`) |
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
  `loadUserAgentTypes(configDir, extraDirs)` (`wiring.ts:59`) reads
  `<configDir>/agents` first, then each extra dir. A type-name clash: the
  first wins, and a diagnostic names both. Today unreadable files are
  skipped silently (`wiring.ts:72-74`); for package dirs, add a diagnostic.

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

*(empty until promoted)*

## Review

*— claude-opus-5-5, 2026-10-21*

Self-review. Mostly plumbing into existing paths, so the blast stays
cross-module. The risks are precedence and name clashes, both designed to be
loud, and the tool-name charset (K2), which a `/` separator would have
broken. The pod exclusion is deliberate (D11).
