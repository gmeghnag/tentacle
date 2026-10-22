# feat/hook-env-dirs — `TENTACLE_PROJECT_DIR` / `TENTACLE_PACKAGE_DIR` for hooks and package MCP servers

> **Status:** execution
> **Branch:** `feat/hook-env-dirs`
> **Type:** feat · **Size:** S · **Blast:** contained · **Suited:** any model + standard Review

## Context

*— claude-opus-5-5, 2026-10-22*

Hooks run in the session's cwd. Today the only directory variable is
`TENTACLE_PROJECT_DIR`, and it equals that cwd (`agent/src/hooks.ts:758`).
Two cases break:
- A project hook `./.agents/scripts/guard.sh` stops working when tentacle is
  launched from a subfolder of the repo.
- A package hook (`docs/feat/packages.md`) cannot find its own `bin/check.sh`.
  `docs/extensions.md` works around it with
  `${TENTACLE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/tentacle}/packages/<name>/…`.

Package MCP servers have the same gap.

**Repro (2026-10-22, branch base):** `.tentacle/tmp/hook-env-dirs/repro.ts`. It
builds a repo with `.git` and `.agents/hooks.json`, launches from `repo/sub`,
and installs a package `pk` with a hook and an MCP server:
```
package hook env: {"TENTACLE_HOOK_EVENT":"turn_end","TENTACLE_PROJECT_DIR":"…/hed-erYHfU/repo/sub"}
project root: (none) | launched from: /repo/sub
pkg MCP env: undefined
```
`PROJECT_DIR` is the subfolder, not the repo. There is no `TENTACLE_PACKAGE_DIR`,
and the MCP server gets no package dir.

## Implementation

> **Superseded in part by review:** `ProjectHooks.root` below was replaced by `TentacleConfig.projectDir` (computed in `loadConfig`, independent of whether project hooks exist: `.git` holder → nearest hooks-file folder → cwd, all realpath). See Execution → Post-review fixes.

*— claude-opus-5-5, 2026-10-22*

### Load-bearing assumption

Each kind of process has exactly one place where its environment is built. All
hooks (user, project, package, sub-agent) go through `HookRunner.run`
(`agent/src/hooks.ts:744-765`); `forAgent` copies `opts` (`:506`). A package MCP
server's config is produced only in `mergePackageContributions`
(`config/src/packages.ts`), and its `env` is merged over the scrubbed process
env at spawn (`mcp/src/transport.ts:31-34`). Inject at those two places.

### Preconditions

- The project-hooks trust hash covers only `{file, hooks}` entries
  (`config/src/hooks-scan.ts` `projectHooksHash`). The `hooks/trust` wire request
  is built field by field (`folder`, `hash`, `files`; `cli/src/wiring.ts`), so a
  new `ProjectHooks.root` field never reaches the protocol. **Trust is
  unchanged:** only env changes, and the definitions that are hashed and
  prompted are identical.
- Pods: the pod daemon loads its own config and scans its own filesystem
  (`docs/eval/extensibility.md` §Trust model), so both values are pod paths.
  Laptop packages are not loaded in a pod (D11).

### Design

- **`TENTACLE_PROJECT_DIR`**, for every hook. When project hooks were found, it
  is the project root `ProjectHooks.root`: the repo root (the `.git` holder,
  the same folder as the trust key) if there is one, else the folder holding
  the nearest valid `.agents/hooks.json`. Otherwise it is the session cwd, as
  before. `HookRunnerOptions.projectDir?` is set by `buildAgent`.
- **`TENTACLE_PACKAGE_DIR`**, only for package contributions.
  - Package hooks: `loadPackage` tags each hook with `packageDir`, a new
    optional field on core `HookSpec` (like `source`; the strict config schema
    keeps it out of user config). `run` adds the var when the field is set.
  - Package MCP servers: `mergePackageContributions` adds it to a stdio
    server's `env`. It overrides a same-named key in `mcp.json`. An http
    server has no process, so nothing is added.
- MCP `command` is spawned without a shell, so `$VAR` does not expand there.
  The docs show `sh -c 'exec "$TENTACLE_PACKAGE_DIR/bin/srv"'`.

### Files

`core/src/hooks.ts` (`packageDir?`) · `agent/src/hooks.ts` (`projectDir`, env) ·
`config/src/hooks-scan.ts` (`root`) · `config/src/packages.ts` (tag, MCP env) ·
`cli/src/wiring.ts` (pass `projectDir`) · `docs/extensions.md`, `README.md`.

### Failure modes

| Case | Result |
|---|---|
| No project hooks file | `PROJECT_DIR` = cwd (unchanged behaviour) |
| Hooks file in a parent folder, no `.git` | `PROJECT_DIR` = the folder holding that `.agents/` |
| User-config hook | `PROJECT_DIR` set, `PACKAGE_DIR` absent |
| `mcp.json` sets its own `TENTACLE_PACKAGE_DIR` | overridden with the real dir |
| Pod session | pod paths (the pod's own config); laptop packages absent |

### Tests

- `agent/test/hooks.test.ts`: `projectDir` reaches the env; `packageDir` adds `PACKAGE_DIR`; a plain hook gets none.
- `config/test/hooks-scan.test.ts`: root from a subfolder = the repo root; with no `.git`, the hooks file's folder.
- `config/test/packages.test.ts`: hook tagged with `packageDir`; stdio MCP env gets the var (and overrides); http untouched.
- `cli/test/wiring.test.ts`: a launch from a subfolder → a hook sees the repo root; no project → cwd.

## Execution

*— claude-opus-5-5, 2026-10-22*

Built as designed, in the planned order:
- `core/src/hooks.ts`: `HookSpec.packageDir?`.
- `agent/src/hooks.ts`: `HookRunnerOptions.projectDir?`. `run` sets
  `TENTACLE_PROJECT_DIR = projectDir ?? cwd`, plus `TENTACLE_PACKAGE_DIR` when
  `spec.packageDir` is set.
- `config/src/hooks-scan.ts`: `ProjectHooks.root?`.
- `config/src/packages.ts`: `loadPackage` tags hooks with `packageDir`;
  `mergePackageContributions` adds `env.TENTACLE_PACKAGE_DIR` to stdio servers.
- `cli/src/wiring.ts`: passes `projectDir: project.root`.
- Docs: `docs/extensions.md` gains an env table in 3.3. The project-hook
  example, the troubleshooting row and the package examples use the new vars
  instead of `git rev-parse` / the config-dir path. The Known limitations item
  is removed. README gets the one-liner.

**Drift:**
- `ProjectHooks.root` is optional, so hand-built fixtures (protocol/trust tests)
  stay unchanged. `discoverProjectHooks` always sets it.
- In the no-`.git` case, root is the folder holding the *nearest* valid hooks
  file. The trust key `folder` stays the launch folder, as before.

**Trust:** unchanged. The hash covers `{file, hooks}` from the files
(`projectHooksHash`). `root` and `packageDir` are added outside it, and the
`hooks/trust` wire request is built field by field, so the protocol is
unchanged too.

**Tests:** 5 new tests plus 3 updated expectations. Every new test was red on
its assertion first (repro output in Context), then green. Mutants, each
killing ≥1 test:
- `projectDir` ignored;
- `PACKAGE_DIR` never set;
- root = folder without `.git`;
- `mcp.json` env overriding ours;
- wiring dropping `root`.

After the change, the repro shows `TENTACLE_PACKAGE_DIR` on the package hook,
`root` = the repo for a launch from `repo/sub`, and the MCP env carrying the
dir. The repro's runner is built by hand, so its `PROJECT_DIR` reflects only
what wiring passes (covered by `cli/test/wiring.test.ts`).

**Post-review fixes (2026-10-22, REQUEST-CHANGES).** Each new test was red on
its assertion first, then green. Mutants killed: no per-child scrub, no root
without hooks, no realpath, wiring passing `cwd`.
1. `TENTACLE_PROJECT_DIR` no longer depends on project hooks existing.
   `discoverProjectHooks` returns a top-level `root`:
   - the realpath of the `.git` holder whenever one is found, hooks or not;
   - else the realpath of the nearest valid hooks file's folder;
   - else absent.
   `TentacleConfig.projectDir = root ?? cwd`, and `buildAgent` always passes it.
   `ProjectHooks.root` is removed, so there is one source. New tests: in
   hooks-scan and in wiring end to end through `loadConfig` (git repo, no hooks,
   launched from `src/api` → repo root). The docs table and the README line are
   updated.
2. `docs/extensions.md` 6.x now says the script is addressed through
   `$TENTACLE_PACKAGE_DIR`.
3. The no-`.git` root also goes through `realpath`. Test: launched through a
   symlinked path.
4. `scrubSensitiveEnv` (`core/src/env.ts`) also drops `TENTACLE_PACKAGE_DIR`.
   It is the one base env for both hook exec (`exec/src/host-execution.ts:206`)
   and MCP stdio (`mcp/src/transport.ts:31`). A package's value comes back only
   through its explicit `env`. Test in `core/test/env.test.ts`.

## Review

*— claude-opus-5-5, 2026-10-22. Fresh-context adversarial review. The executor is the **same model** in another context, so blind spots they share survive both passes.*

**Verdict: REQUEST-CHANGES** (one small must-fix). Mechanism, trust and tests hold.
The fallback rule leaves `TENTACLE_PROJECT_DIR` meaning two different things in the same repo.

### Findings

**Must-fix**

1. **`PROJECT_DIR` depends on whether project hooks exist, not on where the project is**
   (`cli/src/wiring.ts:207`, `config/src/hooks-scan.ts:167-168`). E2E: in a git repo with
   no `.agents/hooks.json`, launched from `repo/src/api`, a **user** hook and a **package**
   hook both get `PROJECT_DIR=…/repo/src/api`. Add an empty-hooks `.agents/hooks.json` to
   that repo, and the same hooks get `…/repo`. So a user or package hook written as
   `"$TENTACLE_PROJECT_DIR/Makefile"` works in some repos and silently breaks in others.
   Fixing it later would change what an existing hook sees.
   **Ruling:** `TENTACLE_PROJECT_DIR` = the real path of the `.git` holder whenever the walk
   finds one, whether or not project hooks exist. Without `.git`, keep the folder of the
   nearest hooks file, else `cwd`.
   **Change:** have `discoverProjectHooks` (or a sibling helper reusing `projectHooksFiles`)
   return `projectRoot` even when `files`/`entries` is empty. Carry it on `TentacleConfig`
   (e.g. `projectDir`), have `buildAgent` pass it unconditionally, and update the
   `extensions.md:246` and `README.md:166` wording. Add a wiring test: a git repo, no hooks,
   launched from a subfolder → the repo root. Red first.

**Nits**

2. `docs/extensions.md:1097` still says "The script is addressed through the config dir".
   The example below it now uses `$TENTACLE_PACKAGE_DIR`. Reword it.
3. The no-`.git` `root` (`hooks-scan.ts:168`, `dirname(dirname(nearest))`) is not
   `realpath`'d, but the `.git` branch is. Use one form for both.
4. A non-package hook or user MCP server inherits any `TENTACLE_PACKAGE_DIR` exported in
   the launching shell (only *set*, never *cleared*). Harmless, but the env table says
   "package hooks only". Unset it for non-package hooks, or document it.

### Gate

`bun run check`: typecheck clean · lint clean (373 files) · **1828 pass, 2 skip (opt-in), 0 fail**.

### Premise table

| Premise | Result |
|---|---|
| Context symptom: from `repo/sub`, the hook gets the subfolder and there is no `PACKAGE_DIR` | TRUE on base. Fixed when project hooks exist; still TRUE without them (finding 1) |
| All hooks go through `HookRunner.run`; `forAgent` copies `opts` (`agent/src/hooks.ts`) | TRUE |
| stdio MCP `env` merged over the scrubbed env (`mcp/src/transport.ts:31-34`) | TRUE |
| Trust hash covers `{file, hooks}` only; `hooks/trust` is built field by field (`wiring.ts:213-219`) | TRUE: `root` never reaches the hash or the wire |
| `HookSpecSchema` is `.strict()` (`config/src/schema.ts:113`), so config cannot supply `packageDir` | TRUE |

### Mutations (each restored; tree verified identical with `shasum -c`)

- No-`.git` root uses `realFolder`: hooks-scan 1 fail ✓
- `mcp.json` env wins over ours: packages 1 fail ✓
- `PACKAGE_DIR` key renamed in `run`: hooks 1 fail ✓
- Wiring drops `projectDir`: wiring 1 fail ✓
- `packageDir` tagged with a wrong value: packages 2 fail ✓

### End-to-end trace (real `loadConfig` → `buildAgent` → `HookRunner.turnStart`/`toolCall`)

Scripts: `.tentacle/tmp/hook-env-dirs/e2e.ts`, `demo.ts`. tentacle cwd = `repo/src/api`.

- Git repo with project hook `sh "$TENTACLE_PROJECT_DIR/.agents/scripts/x.sh"`: the script
  runs from the subfolder with `PROJECT_DIR=…/repo` and `TENTACLE_PACKAGE_DIR` unset. The
  package hook `"$TENTACLE_PACKAGE_DIR/bin/h.sh"` gets `PACKAGE_DIR=<cfg>/packages/pk`. The
  `mcp.json` `env.TENTACLE_PACKAGE_DIR: "/evil"` is overridden with the real dir.
- No `.git`, hooks in `repo/.agents`: `PROJECT_DIR=…/repo` ✓.
- Git repo with **no** project hooks (user hook): `PROJECT_DIR=…/repo/src/api` ✗ (finding 1).

### Attacks tried

1. **Override from config:** a package's `mcp.json` cannot override the var: ours is merged
   last, and E2E confirms it. A project or package `hooks.json` cannot set `packageDir`
   (strict schema), and `loadPackage` overwrites the tag anyway. Holds.
2. **Pod spoofing:** the pod daemon computes both values from its own filesystem and config,
   and runs its hooks in the pod. No laptop-side hook ever runs with pod-supplied env, and
   `root` is not on the wire. Holds.
3. **Trust drift:** a project can move `root` (in the no-`.git` case) by where it places
   `.agents/hooks.json`. That changes only an env path, not the hashed definitions, and the
   user approved the definitions. Holds.
4. **Docs run as written:** I built the 6.7 minimal package verbatim from
   `docs/extensions.md`, with `guard-rm.sh` from 6.1, and installed it with the real CLI.
   Through the wiring, `rm -rf /etc` → `deny … (hook demo:guard-rm)` and `rm -rf build` →
   allowed. The project-hook example from §4 ran in the trace above. Both hold. Stale prose:
   finding 2.

### How the executor behaved

The executor was precise and honest: it flagged that its repro bypassed the wiring. The
miss was that it tested only the case *with* project hooks. It wrote down the no-hooks
fallback as "unchanged behaviour" and did not ask whether that fits the variable's name.

### Re-review

*— claude-opus-5-5, 2026-10-22. Same model as the executor, in a fresh context.*

**Verdict: APPROVE-WITH-NITS.** Findings 1–4 are fixed.

**Gate:** `bun run check` is clean on typecheck and lint (373 files), with **1832 pass, 2 skip (opt-in), 0 fail**.

**E2E** (real `loadConfig` → `buildAgent` → `turnStart`, cwd `repo/src/api`):

| Repo | Hooks file | `PROJECT_DIR` |
|---|---|---|
| git | yes (project hook) | `…/repo` |
| git | none (user + package hooks) | `…/repo`, the same value |
| no `.git` | hooks in `repo/.agents` | `…/repo` |
| no `.git` | none | `…/repo/src/api` (cwd, as documented) |

With `TENTACLE_PACKAGE_DIR=/stale` in the launching shell, a project hook sees it unset. A package hook still gets its own dir.

**Mutations** (each restored; tree verified with `shasum -c`):

- `discoverProjectHooks` returns no root without hooks: 2 fail ✓
- `projectDir: cwd`: 1 fail ✓
- wiring drops `projectDir`: 2 fail ✓
- `TENTACLE_PACKAGE_DIR` not scrubbed: 1 fail ✓

**Blast radius of the scrub:** `scrubSensitiveEnv` has two callers. `exec/src/host-execution.ts:206` builds the env for the shell tool and for hook processes, with `options.env` overlaid after. `mcp/src/transport.ts:31` does the same for stdio MCP, with `spec.env` overlaid after. So package hooks and package MCP servers still get the var: it is re-added per child. Every other child stops inheriting a stale value, which is the intent. No other behaviour changes.

**`projectDir` source:**
- It is computed in `loadConfig` (`load.ts:366`). It is not in `schema.ts` or the protocol, so neither a config file nor a project can set it. A project can only move it in the no-`.git` case, by where it places `.agents/hooks.json`. That changes an env path only, not the trust hash.
- In a pod, the pod daemon computes it from the pod's own filesystem, and no laptop hook sees it.

**Nit (open):** the Implementation and Execution sections still describe `ProjectHooks.root` (`hook-env-dirs.md:51,61,107,117`). Update them to `TentacleConfig.projectDir` / `discoverProjectHooks().root`, so the doc stays the source of truth.
