# feat/write-tmpdir — `fs_write` may write to the system temp dir

> **Status:** executed, awaiting fresh-context Review
> **Branch:** `feat/write-tmpdir` (off `main` 70ec587 = v0.3.0)
> **Type:** feat · **Size:** M · **Blast:** load-bearing (widens a write boundary; the confinement check is the one thing `fs_write`/`fs_edit`/`fs_multi_edit` rely on) · **Suited:** a strong model executes; Review is mandatory and in a fresh context, red-teaming confinement escapes (symlinks, `..`, case, prefix collisions). The code is small (S-sized diff), but a hole here is silent file corruption outside the project.

## Context

*— claude-sonnet-5-5, 2026-11-06*

**Problem.** `fs_write` (and `fs_edit`, `fs_multi_edit`) go through `ExecutionEnvironment.writeFile` (`tools/src/builtins.ts:128`, `:201`, `:249`) → `HostExecution.confineWrite` (`exec/src/host-execution.ts:239-248`), which refuses any path whose realpath is outside the project root (`WorkspaceWriteError: refusing to write outside the workspace`, `:243`). A model that wants a scratch file in `/tmp` (e.g. `/tmp/forge-context-token-body.json`) wastes turns, and falls back to `shell`, which can already write anywhere (`host-execution.ts:166`; the shell is not confined, `:11-13`). So the refusal protects nothing for temp dirs and costs turns.

**Decision (owner, 2026-11-06, A).** Make the system temp dir writable by default: `os.tmpdir()` and `/tmp`, both matched by realpath. Add `tools.writableDirs` (list). `[]` = project only. The normal `fs_write` permission ask is unchanged.

**Repro (feat: the capability is missing).** Not run in this planning session (`bun <script>` needs an approval this session did not have). The expected output comes from reading `host-execution.ts:239-248`. The executor runs this on current `main` before any edit:

```ts
// bun .tentacle/tmp/write-tmpdir/repro.ts   (from the repo root)
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostExecution } from "../../../packages/exec/src/index.ts";
const env = new HostExecution({ cwd: process.cwd() });
for (const p of [join(tmpdir(), "wt-repro.txt"), "/tmp/wt-repro.txt"]) {
  try { await env.writeFile(p, "x"); console.log("OK     ", p); }
  catch (e) { console.log("REFUSED", p, (e as Error).name); }
}
// expected today: REFUSED … WorkspaceWriteError (both lines)
```

## Implementation

*— claude-sonnet-5-5, 2026-11-06*

### Load-bearing assumption

**`HostExecution.confineWrite` is the ONLY place a model-driven file write is confined, and it runs on the host where the daemon runs.** Evidence:

- Every write tool calls `ctx.env.writeFile` (`builtins.ts:128, 201, 249`); the only other `env.writeFile` caller is the spill fallback (`agent/src/agent.ts:1906`, a path inside the project's `.tentacle/tool-output`, only when no `sink`).
- The only production `new HostExecution` is `cli/src/wiring.ts:360` (`buildAgent`). `buildAgent` is used by the local worker, `serve` (`cli/src/serve.ts:182`) and the pod daemon (`serve.ts:426, :491`) alike, so the pod's agent confines inside the pod. Docker/k8s add transports, not another env (AGENTS §7 "one session path").
- Sub-agents get the same `env` (`wiring.ts:474`); the `explore` type is read-only by TOOL SET, not by `confineWrite` (`agent/src/subagent.ts:315-329`, `readOnlyType` uses `isReadClass(classOf(tool))`). A temp-dir allowance leaves `explore` read-only, since it has no `fs_write`.

If a second write path existed (another `ExecutionEnvironment`, a tool writing with `node:fs` directly), the widening would be inconsistent. A grep for `.writeFile(` outside tests found none (`session-store.ts:144` is the session store, not a tool).

### Preconditions

- **Which host a write lands on.** Writes happen in the daemon's process, on the daemon's filesystem. In-process worker and `serve` (user's own host): the user's machine. In `run`/`attach`: the POD's filesystem (`/tmp` is the container's). A pod's config can therefore only widen writes ON THE POD, which the pod already fully controls. It cannot touch the laptop: no RPC makes the laptop write a file (AGENTS §7 "compute next to the code… a pod is not trusted"; the laptop-side effects are gated by the broker, and this change adds none). So there is no laptop-side check to build.
- **Carry (answer in Design §5).** `CARRIED` is keyed by the wire's `SessionSettings` keys and must classify every one (`cli/src/carried-settings.ts:42`, compile-enforced). A key that is NOT added to the wire (like `autoWake`, `:39-41`) needs no row.
- **`realTarget`** already resolves symlinks on the deepest existing ancestor and re-appends the missing tail (`host-execution.ts:65-78`); `resolve` has removed `..` before it (`:240`). So a link inside a temp dir that points outside resolves outside and stays refused, exactly as for the project (existing test `confinement.test.ts` "rejects a write through a symlink").
- **The existing confinement tests build their workspace and "outside" dir under `os.tmpdir()`** (`confinement.test.ts:13-18`). If temp dirs were writable in `HostExecution` by default, "rejects an absolute path outside the workspace" would turn red. So the primitive defaults to project-only; the temp dirs come from config (Design §1).
- Spill output is not affected: `agent/src/tool-output.ts:5-8` writes through the daemon's own cache store, deliberately outside the confined `env`, and the model reads it back with `fs_read` (unconfined).
- Permission ask: `fs_write` is `permission: "ask"` (`builtins.ts:118`). The ask's `detail` is the path. Nothing in the permission engine reads confinement. The ask is unchanged (owner).

### Design

1. **`HostExecution` (exec).** New optional `HostExecutionConfig.writableDirs?: readonly string[]` (absolute paths). In the constructor: `this.writableRoots = writableDirs.map((d) => safeRealpath(resolve(d)))`, de-duplicated, dropping a root that realpaths to the filesystem root (`/`), since it would make "confined" meaningless AND `root + sep` is `"//"` there. `confineWrite` accepts a target that is inside `[this.root, ...writableRoots]`, via one small `within(root, target)` (`target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)`). The `+ sep` keeps `/tmpfoo` out of `/tmp`. **The default of the primitive stays project-only** (`writableDirs` absent). The error message names the project root and, when extra roots exist, lists them.
2. **Config (config package).**
   - `schema.ts` `tools.writableDirs: z.array(WritableDirSchema).optional()`. `WritableDirSchema` = the `HidePathSchema` shape (`schema.ts:~168-173`): `~/…`, `~` or `/…`; a relative entry has no anchor and is a load error. The `tools` object is `.strict()`, so the key must be added there (`schema.ts:334-369`).
   - `defaults.ts`: `defaultWritableDirs()` returns the unique `[os.tmpdir(), "/tmp"]` (computed at resolve time, because `TMPDIR` is runtime state). Add it to the commented defaults template (`defaults.ts:~211-217`).
   - `resolve.ts` (next to `maxParallel`, `:456`): `writableDirs = pick(parseDirList(env.TENTACLE_WRITABLE_DIRS), fileConfig.tools?.writableDirs, defaultWritableDirs())`, with a `sources.writableDirs` entry. Env value: entries separated by `path.delimiter`; an EMPTY string is `[]`.
   - **Semantics: the list is the complete set of non-project writable dirs and REPLACES the default** (`[]` = project only; `["~/scratch"]` = project + `~/scratch`, temp dirs NOT writable unless listed). This is what the TODO's "`[]` = project only, i.e. temp dirs NOT writable" implies, and mirrors `mount.hide` replacing its default list (`workspace-mount.ts:19`).
   - Profile merge: `tools` is merged per key (`docs/feat/config-profiles.md:111`), so a profile's `writableDirs` replaces the base list (arrays are not concatenated).
   - `load.ts`: expand `~` with the existing `expandTilde(p, home)` (`load.ts:223`, `home = env.HOME ?? homedir()`), as for `cwd` (`:635`), and expose `TentacleConfig.writableDirs: readonly string[]` (type at `load.ts:~154`, mapped at `:~670`).
3. **Wiring (cli).** `wiring.ts:360`: pass `writableDirs: config.writableDirs` to `new HostExecution`. Nothing else in `buildAgent` changes: sub-agents, hooks and background jobs share `env`.
4. **TUI ask text.** The dialog row says `· writes confined here` (`PermissionPrompt.tsx:72`, gated by `permissionShowsCwd`, `permission-ui.ts:71`). With this change it can be false. The TUI does not know the daemon's effective list (it is daemon config, and we do not add a wire field for a label). Smallest honest fix: a constant in the pure module `permission-ui.ts` (`WRITES_NOTE = "writes limited to here + allowed dirs"`) that the component renders. The `detail` row already shows the concrete path, so the user sees a `/tmp/…` target. The existing test (`auto-approve.test.tsx:141-142`) only checks the row's absence for `hooks_trust`; update its text expectation and add one positive assertion.
5. **Carry to pods: NOT carried (recommendation).** Reasons: (a) the value is laptop paths (`~/scratch`, `/Users/me/x`), meaningless or wrong in a container; (b) the pod's `/tmp` is the right default there and the pod's own env/file may set it; (c) a carried value adds a wire key (`SessionSettings`, `protocol/src/session.ts:~468`), a `CARRIED` row (P or W), notices that print path lists (the notice machinery hides any text: `shown()`, `carried-settings.ts:309-318`), and report filtering, all for a list that can only widen writes on the pod, which gains nothing in security. Consequence to state in the docs: `tools.writableDirs: []` on the laptop confines the laptop's own sessions, NOT a pod's; a pod follows its own config (normally none → `/tmp`). A pod-supplied value can never affect the laptop (see Preconditions). Carrying only a boolean "temp dirs off" would be the fallback if the owner wants `[]` to hold in pods (Owner question 2).
6. **Relative paths, `..`, `~`.** A model path is resolved against `defaultCwd` (`host-execution.ts:240`) and normalised before `realTarget`, so `../../tmp/x` from the project resolves to `/tmp/x` and is judged on its real location: allowed iff under a writable root. A relative config entry is rejected by the schema; `~` is expanded at load (not in the primitive, which only gets absolute dirs).
7. **Temp dir that does not exist.** `safeRealpath` returns the entry unchanged (`host-execution.ts:52-58`), so the root is the literal path. A write there creates it (Bun.write creates parents); if the literal is later a symlink outward, `realTarget` resolves outside and the write is refused (fails closed). Acceptable.
8. **Case-insensitive APFS (macOS).** A model may write `/TMP/x` or `/Private/Tmp/x`. Whether `realpathSync` canonicalises case on macOS under Bun is **unverified** (not run here). Behaviour either way is safe: if it canonicalises, the write is allowed; if not, `/TMP/x` fails to match `/private/tmp` and is refused (fails closed; the model retries with the shown real path). The match is never made case-insensitively by us (that would be a new escape surface). The executor verifies with one `bun -e` on macOS and records the answer; no code change unless it shows a way to ESCAPE (a case variant of a non-temp path matching a writable root: impossible, since the comparison is on canonical strings).
9. **Linux pods/containers.** `os.tmpdir()` honours `TMPDIR` (else `/tmp`); both are added. `/tmp` may be a tmpfs or `emptyDir`. Nothing special.

### Files

In dependency order (no protocol/daemon/client change):

1. `packages/exec/src/host-execution.ts` — `writableDirs` config, `within`, `confineWrite`, error text; update header comment (`:9-13`).
2. `packages/config/src/schema.ts`, `defaults.ts`, `resolve.ts`, `load.ts` — key, default, env, `~` expansion, `TentacleConfig.writableDirs`; plus the config JSON-schema artifact if one is generated (check `packages/config` for a generated schema and its test, like `protocol/schema/protocol.json`).
3. `packages/cli/src/wiring.ts:360` — pass the list.
4. `packages/tui/src/permission-ui.ts` + `components/PermissionPrompt.tsx:72` — the note constant.
5. Docs: `README.md` config table (`tools.writableDirs`), `ARCHITECTURE.md` if it describes confinement, `TODO.md` entry; and the one-line note in `docs/feat/config-carry.md`'s "not carried" list (`:178`-style) that `tools.writableDirs` is not carried. No change to AGENTS.md (no rule changes).

Not changed: `carried-settings.ts`, protocol, `PROTOCOL_VERSION`, daemon, client, `tool-output.ts`, `subagent.ts`.

### Failure modes

| Case | Outcome |
|---|---|
| Symlink inside a temp dir → outside | `realTarget` resolves outside every root → `WorkspaceWriteError` (same as the project). |
| Symlink in the project → a temp dir | Resolves into the temp root → allowed. Intended: the temp dir is writable, and the link is the user's/model's own. (A link → `$HOME` stays refused.) |
| `..` from the project into `/tmp` | Normalised by `resolve` first; allowed iff the real target is under a root. |
| Prefix collision `/tmpfoo`, `/private/tmpx` | Refused by the `root + sep` rule; mutation-tested. |
| `writableDirs: ["/"]` | Entry dropped (it would defeat the confinement and break the prefix rule); a one-line daemon log (`buildAgent`'s `notice`, never the terminal, AGENTS §7). Recommendation; owner may prefer to honour it as an explicit opt-out. |
| `writableDirs: []` | Project only: today's behaviour. |
| Relative / empty entry in the file | Config load error with the key path (strict schema). |
| Env `TENTACLE_WRITABLE_DIRS=""` | `[]`. Unset → default. |
| Temp dir missing, or `/tmp` absent (some containers) | Root stays literal; writes create it or fail with the OS error. No crash at construction. |
| macOS `/var/folders/…/T` vs `/private/var/…` | Roots are realpaths; targets are realpaths → the same string. |
| TOCTOU: link swapped after the check | Pre-existing race for the project too (`confineWrite` checks then `Bun.write`); not widened in kind. Noted as debt, not fixed here. |
| Pod config sets a wide list | Affects only the pod's own filesystem (Preconditions). No laptop effect. |
| `shell` | Unchanged and still unconfined; this change only removes the `fs_*` asymmetry. |
| Concurrency | `lockPath` keys by the path string (`builtins.ts:121`); unchanged. |

### Tests

Red first (each shown failing on `main`, then green), one mutation each. Use real temp dirs under `.tentacle/tmp` is NOT needed: reuse the existing `mkdtemp(join(tmpdir(), …))` style of `exec/test/confinement.test.ts` (the test env guard already points `HOME` at a temp dir; no fakes needed for a filesystem primitive).

1. **exec** `packages/exec/test/confinement.test.ts` (new `describe("writable dirs")`):
   - `HostExecution({cwd: root, writableDirs: [extra]})` writes into `extra` and a subfolder (red: refused today). *Mutation: ignore `writableRoots` → fails.*
   - Prefix sibling `extra + "-evil"` is refused. *Mutation: `startsWith(root)` without `sep` → fails.*
   - A symlink inside `extra` pointing to a dir outside every root is refused. *Mutation: use `abs` instead of `realTarget(abs)` → fails.*
   - A symlink to a writable root's alias resolves: `extra` given as a symlink path still matches (root realpath'd). *Mutation: skip `safeRealpath` on roots → fails (the macOS `/var` vs `/private/var` case, reproduced with a symlinked temp dir on any OS).*
   - `..` from the project into `extra` allowed; `..` to a sibling refused.
   - `writableDirs: ["/"]` dropped: writing outside is still refused.
   - Default (no `writableDirs`) stays project-only: the existing tests stay green unchanged.
2. **config** (`packages/config/test`, next to the `tui-theme`/tools tests): default is `[tmpdir(), "/tmp"]` (with `TMPDIR` set via the injected `env`); `[]` honoured; list replaces; profile replaces; `~/x` expanded with the injected `HOME`; relative entry rejected; `TENTACLE_WRITABLE_DIRS` (`a:b`, empty). *Mutation: make the default also apply when the list is `[]` → the `[]` test fails.*
3. **cli wiring** (`packages/cli/test/wiring.test.ts`, near the unconfined-reads test at `:262`): `buildAgent(config)` with the default config can write to the temp dir through its `env` and still refuses `$HOME`-side outside paths; with `writableDirs: []` the temp write is refused. *Mutation: drop the `writableDirs` argument at `wiring.ts:360` → the first assertion fails.* This pins that the config is actually wired, the failure the single-broker test also guards against.
4. **tui** `permission-ui` test: the row text is the constant and is absent for `hooks_trust`; update `auto-approve.test.tsx:141-142` accordingly.
5. **carry** `packages/cli/test/carried-settings.test.ts`: `ALL_KEYS` is unchanged (it asserts the key list at `:259`), which pins "not carried".
6. Gate before done: `bun test`, `bun run typecheck`, `bun run lint` against the clean baseline (AGENTS §4, §6).

Unverified items the executor must check and record: (a) the macOS case-variant behaviour of `realpathSync` (Design §8); (b) whether a generated config JSON-schema artifact exists; (c) the live macOS repro (`/var/folders` write) after the change.

### Validation

Repro above flips from `REFUSED` to `OK` on both lines; `/etc/x`, `$HOME/x`, `/tmpfoo/x` stay refused; the live TUI shows the ask for a `/tmp/…` write with the detail path and the new note.

### Notes / debt

- TOCTOU between check and write exists today and is not widened in kind; not fixed here.
- `shell` remains the unconfined route; confining it is a separate (sandbox) task.
- No wire/persistence change, no `PROTOCOL_VERSION` bump.

### Owner questions

1. **Does the list replace the default or add to it?** Recommendation: **replace** (`[]` = project only, as the TODO says; `["~/scratch"]` = project + `~/scratch` without temp). The cost is that a user adding one dir must also list temp dirs if they want them. Alternative: `writableDirs` extra + a separate `tools.tempWritable: bool`; more keys for little gain.
2. **Carry to pods?** Recommendation: **no** (laptop paths are meaningless in a container; only the pod itself is exposed; no wire/`CARRIED` change). Consequence: `[]` on the laptop does not turn off `/tmp` writes in a pod. If you want it to hold there, the fallback is carrying just a boolean.
3. **TUI ask row text** (`writes confined here` is no longer always true). Recommendation: the static `writes limited to here + allowed dirs`. Alternative: hide the row when the detail path is outside the project (no extra info needed). Say if you prefer another wording.
4. **`writableDirs: ["/"]`**: drop with a daemon log (recommended) or honour as an explicit opt-out?
5. **Env override `TENTACLE_WRITABLE_DIRS`** (every other `tools.*` key has one): include it (recommended, `:`-separated, empty = `[]`), or file-only?

*— claude-sonnet-5-5, 2026-11-06*

### Owner answers (2026-11-06)

All five recommendations ACCEPTED: (1) `tools.writableDirs` REPLACES the default temp dirs (`[]` = project only); (2) NOT carried to pods/containers; (3) ask row text `writes limited to here + allowed dirs`; (4) `["/"]` is dropped with a daemon log; (5) env `TENTACLE_WRITABLE_DIRS` (`:`-separated, empty = `[]`).

## Execution

*— claude-opus-5-5, 2026-11-06*

**Repro on 70ec587, before any edit.** `bun <script>` needed an approval this session lacked, so the Context's repro ran as a `bun test` file in `.tentacle/tmp/write-tmpdir/repro.test.ts` (same body):

```
REFUSED /var/folders/gf/…/T/wt-repro.txt WorkspaceWriteError
REFUSED /tmp/wt-repro.txt WorkspaceWriteError
REFUSED /TMP/wt-repro2.txt WorkspaceWriteError
REFUSED /etc/wt-x WorkspaceWriteError
REFUSED /tmpfoo/x WorkspaceWriteError
realpath /TMP -> /private/tmp   realpath /Private/Tmp -> /private/tmp
```

After the change, with `writableDirs: [tmpdir(), "/tmp"]`: `/var/folders/…/T/…`, `/tmp/…` and `/TMP/…` are `OK`; `/etc/wt-x` and `/tmpfoo/x` stay `REFUSED`. (`$HOME/wt-x` was OK only because the test env guard puts `HOME` inside the temp dir.)

**As built, in plan order:**

1. **exec** `packages/exec/src/host-execution.ts`. `HostExecutionConfig.writableDirs` (`:45-52`), and `writableRootsOf` (`:132-155`), which drops a non-absolute entry (so a `~` that was not expanded is dropped too), a `/` entry and a symlink loop. It reports them in `droppedWritableDirs` (`:164`). It also adds `within` (`:123-125`, `root + sep`) and `confineWrite` against `[root, ...writableRoots]`; the error lists the writable dirs (`:323-337`). `realTarget` (`:79-109`) gains the dangling-link walk. The primitive's default stays project-only.
2. **config.** `schema.ts`: `WritableDirSchema` (`~`, `~/…`, `/…`) and `tools.writableDirs`. `defaults.ts`: `defaultWritableDirs(env)` plus a template paragraph. `resolve.ts`: `parseDirList` and `pick(env, file, default)`, with `sources.writableDirs`. `load.ts`: `TentacleConfig.writableDirs`, `~` expanded with `expandTilde`.
3. **cli** `wiring.ts:360-371`: passes `writableDirs` to `new HostExecution`. Each dropped entry goes to `notice ?? log` (daemon-side).
4. **tui.** `permission-ui.ts`: `WRITES_NOTE` and `permissionCwdLine(cwd, columns)`. `PermissionPrompt.tsx:71` renders it.
5. **Docs.** README (feature bullet + config table row), `docs/feat/config-carry.md` ("not carried" item 4), CHANGELOG `[Unreleased]` (Added + Fixed), TODO link. ARCHITECTURE.md does not describe write confinement: no change.

**Protocol:** not touched. No `PROTOCOL_VERSION` bump, no `CARRIED` row, `carried-settings.test.ts` unchanged (and green).

**Drift from Implementation (and why):**

- **Dangling-symlink escape: found and fixed (beyond the plan).** `realTarget` walked up with `existsSync`, which FOLLOWS links. So a dangling link `<dir>/x → /outside/f` looked absent, its parent was judged (inside), and `Bun.write` then followed the link and created `/outside/f`. This was already true for the project. In a world-writable `/tmp`, another local user could plant such a link, so making `/tmp` writable without this fix would open a real hole. The fix: walk with `lstat` (`entryExists`), follow a dangling link by hand (`readlink`), and refuse after 40 hops. The test was shown RED on 70ec587 (`rejects a write through a DANGLING symlink`).
- **Roots are canonicalised with `realTarget`, not `safeRealpath`.** Design §7 assumed a missing root stays literal. That broke macOS: a missing `/var/folders/…/x` stayed `/var/…` while targets became `/private/var/…` (caught by the "does not exist yet" test). Now the existing ancestors are realpath'd and the tail is re-appended, the same rule as for targets.
- **`within` keeps the strict `root + sep`** instead of the plan's `root.endsWith(sep) ? root : root + sep`. A writable `/` is dropped anyway. Keeping the old rule means a project at `/` stays exactly as confined as before (only `/` itself); with the plan's rule it would silently become "everything".
- **The default is computed purely from the injected env** (`TMPDIR | TMP | TEMP | /tmp`, trailing `/` trimmed: `os.tmpdir()`'s POSIX rule), not by calling `os.tmpdir()`. This keeps `resolve.ts` I/O-free and testable.
- **Env entries that are not `~`, `~/…` or absolute are dropped**, not an error (the env parsers here fall through on bad values; dropping only narrows).
- **TUI.** The note is longer (37 vs 20 cells), so the cwd row's width math moved into the pure `permissionCwdLine`, which reserves the note's length. Otherwise the row would wrap at narrow widths and break `permissionPromptRows`. New test file `packages/tui/test/permission-cwd-line.test.tsx`. In `auto-approve.test.tsx` the existing assertion was extended, not replaced.
- `TentacleConfig.writableDirs` is required. `buildAgent` passes `config.writableDirs ?? []`, so a test that casts a partial config gets project-only, which fails closed.

**Tests (red first, then green).** These were shown red on the property, not on imports. For the TUI the pure function first carried the OLD text and width, and the assertions failed.

- `packages/exec/test/confinement.test.ts`: +1 test in "write confinement" (dangling link) and a new `describe("writable dirs")` with 11 tests. They cover: subfolders, the prefix sibling, a link out and a dangling link out, a symlink loop, links into the project or the dir itself, the root given as a symlinked alias, `..` in and out, `/` + relative + `~` dropped, a missing dir, the case variant (asserted per filesystem: on APFS it IS the dir; on a case-sensitive FS it is refused), and the error text.
- `packages/config/test/writable-dirs.test.ts` (new): default with `TMPDIR`, `[]`, list replaces, env (`a:b`, empty, relative dropped), schema, profile replaces, `loadConfig` `~` expansion with the injected `HOME`, template.
- `packages/cli/test/wiring.test.ts`: new `describe("tools.writableDirs wiring")`. It checks: the default contains `/tmp`; the configured dir reaches the agent's `fs_write`; outside and `[]` are refused, with nothing written; a dropped `/` produces a notice and no widening.
- `packages/tui/test/permission-cwd-line.test.tsx` (new) and `auto-approve.test.tsx` (extended).

**Mutations** (cp backup → Edit → narrow test → cp restore → `shasum -c` OK, every time):

| # | Mutation | Killed by |
|---|---|---|
| 1 | `confineWrite` checks `[this.root]` only | 7 writable-dir tests |
| 2 | `within` without `+ sep` | prefix sibling |
| 3 | last path component's link not followed (`resolve(realpath(dirname), basename)`) | symlink out (project + writable dir), alias, case |
| 4 | roots not canonicalised (`resolve(dir)`) | 8 tests (alias, missing dir, …) |
| 5 | walk with `existsSync` again (the pre-fix code) | dangling (project + writable), loop |
| 6 | `/` not dropped | dropped-entries test |
| 7 | config: `[]` falls back to the default | `[] in the file = project only` |
| 8 | wiring: `writableDirs` not passed to `HostExecution` | both wiring tests |
| 9 | tui: old width reserve (24) with the new note | `a long cwd is cut so the row fits` |

Mutation 3 replaced the plan's "`abs` instead of `realTarget(abs)`". On macOS that one is killed by `/var` ≠ `/private/var`, not by the symlink property, so it proved nothing about symlinks.

**Plan's unverified items:**
- (a) On APFS, `realpathSync` canonicalises case (`/TMP`, `/Private/Tmp` → `/private/tmp`), so case variants of a temp dir are allowed. It cannot escape, because the comparison is on canonical strings.
- (b) No generated config JSON-schema artifact exists (`packages/config` has only `package.json`/`tsconfig.json`).
- (c) The macOS `/var/folders` write was verified after the change (above).

**Gate** (once, at the end): `bunx tsc --noEmit` clean. `bunx biome check .` clean (after `biome check --write` reformatted two of my files). `bun test packages`: 5272 pass, 3 skip (the opt-in live-k8s/docker/slow tests), 0 fail.

**Unverified / debt:**
- The live TUI and a real pod run were not exercised here (owner checklist below).
- TOCTOU between the check and `Bun.write` remains (a link swapped in between). It is pre-existing and not widened in kind, but `/tmp` is shared, so it matters more there; an `O_NOFOLLOW`/`openat` write would close it. Separate task.
- The repro left `/tmp/wt-repro.txt`, `/tmp/wt-repro2.txt` and `$TMPDIR/wt-repro.txt` (deleting outside the worktree needed an approval).

**Owner live checklist:**
1. In a local TUI session, have the model `fs_write` `/tmp/x.json`. Expected: the ask shows `/tmp/x.json` and `… · writes limited to here + allowed dirs`; after approval the file exists.
2. `ln -s ~/victim.txt /tmp/evil` (the target missing, then existing). Have the model `fs_write` `/tmp/evil`. Expected: `refusing to write outside the workspace`, and `~/victim.txt` is not created or changed.
3. Set `"tools": { "writableDirs": [] }` in `config.jsonc`, then repeat 1. Expected: refused.
4. Run `tentacle run --engine docker …` with that same laptop config and have the model write `/tmp/y.txt`. Expected: it asks and writes inside the container (not carried; the container's own default applies).

## Review

*— (empty; mandatory fresh-context review for a load-bearing change)*
