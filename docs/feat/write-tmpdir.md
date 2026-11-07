# feat/write-tmpdir — `fs_write` may write to the system temp dir

> **Status:** reviewed: REQUEST-CHANGES (one HIGH confinement escape, see Review)
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

### Fix round 1

*— claude-opus-5-5, 2026-11-07*

This round answers Review round 1 (905ce30). The owner chose: F1 refuse every dangling link; F2 fix TOCTOU and hard links in this branch; and fix LOW 3, 4 and 6 too.

**What changed:**

- **F1** `packages/exec/src/host-execution.ts:99` `realTarget`. It now returns `{ok:false, dangling}` as soon as the deepest existing entry passes `lstat` and fails `stat` (a dangling link or a loop). The `readlink` recursion and `MAX_LINK_HOPS` are gone. `confineWrite` (`:420`) throws `refused: dangling symlink <entry> (its target does not exist; create it first): <path>` (`:425`). It returns the checked REAL path, which is what gets opened.
  - A writable dir that is a dangling link at startup is dropped and reported (LOW 5).
  - Behaviour change: a dangling link that points INSIDE a root is refused too (accepted by the owner). The existing test "a symlink inside a writable dir pointing into the project or itself is fine" therefore creates `real.txt` first. That is its only change; its assertions are unchanged.
- **F2** `writeFile` (`:344`), `openConfined` (`:386`), flags at `:119`. The write never goes through `Bun.write(path)` again. It works like this:
  1. `mkdir -p` the parent of the checked real path.
  2. `open(real, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_NONBLOCK, 0o666)`. On `EEXIST`, reopen with `O_WRONLY|O_NOFOLLOW|O_NONBLOCK`. **No `O_TRUNC`**, so nothing is truncated before the checks pass.
  3. On the descriptor: it must be a regular file, and `nlink === 1` (else `refused: hard link …`).
  4. The parent's `realpath` is re-read AFTER the open. It must be inside a root, and the name there must be this very inode (`dev` + `ino` from `lstat` vs `fstat`); else `refused: the path moved during the write …`.
  5. Then `ftruncate(0)` and write through the descriptor.
  - `ELOOP` (or `EMLINK`) gives `refused: a symlink at the final path …`. `ENXIO` (a FIFO with no reader) gives `refused: not a regular file`.
  - Because the checked real path is opened (links present at check time are already followed), a write through an EXISTING in-root symlink keeps working. Opening the model's path with `O_NOFOLLOW` would have refused every symlinked project file.
  - Test seam: `HostExecutionConfig.beforeOpen` (`:58`, documented TEST SEAM ONLY). It runs between the check and the open.
  - **Coverage** (`rg 'env\.writeFile\('`): `fs_write`, `fs_edit`, `fs_multi_edit` (`tools/src/builtins.ts:128, 201, 249`) and the spill fallback (`agent/src/agent.ts:1906`). All go through `HostExecution.writeFile`, the only `ExecutionEnvironment` implementation. So all of it holds in the project and in the writable dirs alike.
- **LOW 3** `packages/tui/src/permission-ui.ts:89`. As a last resort the whole row is cut to `columns - 2`, so it never wraps.
- **LOW 4.** The comments are now true: `packages/agent/src/tool-output.ts:5-9` (the `os.tmpdir()` fallback IS inside the default writable dirs, still behind the ask) and `packages/cli/src/wiring.ts:4`.
- **LOW 6** `packages/config/src/resolve.ts:189` `parseDirList`. It keeps a non-absolute env entry (only blank ones are skipped). `HostExecution` drops it and `buildAgent` sends the same `tools.writableDirs: ignored "<entry>" …` notice.
- **Docs.** CHANGELOG `[Unreleased]`: "Fixed" is rewritten (dangling links, hard links, the `O_NOFOLLOW` race, FIFO; in-root links still work), and "Added" now says ignored entries are logged and that auto-accept skips the ask. The README row is updated to match.

**Red → green.** Every test below was run on the round-0 code first.

- `packages/exec/test/confinement.test.ts`, new `describe("dangling links, hard links and races (fix round 1)")`. Each case runs in a writable dir AND in the project. All 8 were RED on the round-0 code, on the property: the write went through, with `refusal()` → `undefined`, or for the FIFO a non-`WorkspaceWriteError`:
  1. F1, the review's lexical form `d → outside/sub`, `lexbad → d/../created-outside`.
  2. F1, the regression form `outside/sub/up → ../up-out` through `d/up`.
  3. F1, dangling inside a root → `refused: dangling symlink`.
  4. F1/LOW 5, a dangling root is dropped.
  5. F2, a hard link to an outside file → refused; the outside file stays `orig`.
  6. F2, a symlink swapped in at the final path (via `beforeOpen`) → `symlink at the final path`; the outside file stays `orig`.
  7. F2, the parent dir swapped for a link outward (via `beforeOpen`) → `moved during the write`. An existing outside file keeps `orig`; a new one is at most empty.
  8. F2, a FIFO → refused, no hang.
  - A 9th test, "ordinary writes still work", covers create, overwrite (truncated) and through an in-root link. It was green before and is green after, so it shows nothing regressed.
- `packages/tui/test/permission-cwd-line.test.tsx`, added cases. The 45- and 50-column frames were RED (7 rows vs `permissionPromptRows(2)` = 6, the review's number). They need a `<Box width>` because ink-testing-library's stdout is fixed at 100 columns. The pure no-wrap check at 30/40/45/50 was RED at 30/40 and is green after.
  - Not fixed: below about 46 columns the pre-existing key-hint footer (`↑↓ choose · enter confirm · y/a/n · esc deny`) wraps on its own. That is not this task's row, so the frame check stops at 45.
- LOW 6: the `writable-dirs.test.ts` env assertion changed from `["/ok"]` to `["rel","/ok"]` (a behaviour change). `wiring.test.ts` gained an env case asserting both notices. Both were RED before the `parseDirList` change.

**Mutations** (cp backup → Edit → narrow test → cp restore → `shasum -c` OK, every time):

| # | Mutation | Result |
|---|---|---|
| A | no dangling refusal in `realTarget` | killed: F1 lexical form, F1 inside-root message, dangling root dropped. The absolute-target dangling cases still refused, via `O_NOFOLLOW` at the open (defence in depth) |
| B | drop `O_NOFOLLOW` | killed: the final-path race test. Even then the post-open inode check refused (`moved during the write`) and the outside file kept its bytes |
| C | `nlink` check disabled | killed: hard link |
| D | post-open parent/inode re-check disabled | killed: parent swap |
| E | add `O_TRUNC` to the reopen | killed: hard link + parent swap (the outside bytes are lost before the refusal) |
| F | drop `O_NONBLOCK` | the FIFO test HANGS: `open` blocks, the 2 s test timeout cannot interrupt it, and the outer `timeout 60` killed the run. Not a pass |

LOW 3's red was the pre-fix code itself.

**Gate:** `bunx tsc --noEmit` clean. `bunx biome check .` clean (after `biome check --write` reformatted the test's import). `bun test packages`: **5287 pass, 3 skip (opt-in), 0 fail** (5290 total).

**What remains open:**

- **Under an active race, a parent swap can leave empty traces outside.** If a directory on the path is swapped for a link outward between the check and the open:
  - `mkdir -p` may create empty directories outside.
  - `O_CREAT|O_EXCL` may create one EMPTY file outside before the post-open check refuses it. It is not unlinked, because unlinking by name would be racy too.
  - No content is ever written, and no existing file is truncated (mutation E proves the order).
  - The full fix is an `openat`/`O_NOFOLLOW` walk from a root fd, component by component, which Node/Bun does not expose. Left open.
- **After the post-open check, the fd is pinned to a verified inode.** Later renames or new hard links of that inode by an attacker only move OUR bytes; they cannot redirect the write to a victim inode.
- **A hard-linked file inside the project is now unwritable by the tools** (`nlink > 1`), even when every name is inside. That is the price of not being able to see the other names. The error says so. The model can still use `shell`.
- **A dangling link that points inside a root is refused**, by owner choice.
- **The race tests run on one uid with the `beforeOpen` seam**, not a true concurrent cross-user attacker.
- **The `/tmp/wt-repro*.txt` files from round 0 are still there.** Deleting outside the worktree needs an approval this session did not have. All of this round's scratch files in `.tentacle/tmp/write-tmpdir/` were removed. The plan and the reviewer's `review/` folder were kept.
- **LOW 6, first half, not addressed:** the dropped-entry notice still fires once per `buildAgent` (once per session on `serve`).

## Review

*— claude-opus-5-5, 2026-11-07*

**Verdict: REQUEST-CHANGES.** The dangling-symlink fix is incomplete: a link planted in `/tmp` still makes `fs_write` create a file outside every root, and one variant is a regression (`main` refuses it). Everything else in the boundary held.

**Independence.** Fresh context, but the same model as the executor (`claude-opus-5-5`), so shared blind spots are possible. This task is load-bearing: a pass by a different model is worth having after the fix.

### Findings

1. **HIGH: a dangling link's target is resolved lexically, and the kernel resolves it physically** (`packages/exec/src/host-execution.ts:112`, `resolve(dirname(existing), link, ...tail)`). `path.resolve` collapses `..` as text and does not realpath `dirname(existing)`. `Bun.write` then follows the link for real. Two forms, both measured on macOS with real files:
   - **Everything planted in `/tmp` (no write access outside needed):** `/tmp/a/d → <outside>/sub` and `/tmp/a/lexbad → d/../created-outside`. Through the wired agent (`loadConfig` default → `buildAgent` → `fs_write`), the result is `wrote 5 bytes to /tmp/…/lexbad` and `<outside>/created-outside` **exists**. The ask shows only `/tmp/…/lexbad`, so the user approves a path that looks harmless. It creates new files only (a dangling target does not exist yet), but that is enough for e.g. a missing `~/.zshenv`. `/tmp` is world-writable, so another local user could plant this, which is the threat Execution itself names as the reason for the fix (not run across two uids here). On `main` the same link inside the project also escapes, so the bug is old; this branch exposes it in a shared dir.
   - **Regression against `main`:** `<outside>/sub/up → ../up-out`, written through `/tmp/a/d/up`. Branch: `WROTE`, `<outside>/up-out` created. `main`, same layout inside the project: `REFUSED`, because the old walk judged the realpath'd parent.
   - **Fix (recommended, see Owner question 1):** refuse any dangling link (`realTarget` returns `undefined` as soon as `lstat` finds the entry and `stat` does not), and drop the `readlink` recursion. This closes both forms, the loop case and F5. Add both forms above as tests, shown red first.
   - **False claims while this stands:** `CHANGELOG.md:18-19` ("a symlink out of a temp dir is still refused") and the README table row ("a symlink out of one stays refused").
2. **MEDIUM (accepted debt, no worse than `main` in kind, wider exposure): TOCTOU and hard links.** Both escape on `main` (in the project) and on the branch (in `/tmp` and `os.tmpdir()`).
   - Swapping the path for a link between check and write (forced by wrapping `Bun.write`): the file lands outside on both.
   - A hard link to an outside file: its content is overwritten on both, and realpath cannot see it. Execution does not mention this one. Cross-user planting was not tested (one uid here).
   - On `main` an attacker needed write access to the project. `/tmp` is world-writable, so this matters only on a multi-user host; a same-uid attacker gains nothing. See Owner question 2.
3. **LOW: the cwd row wraps below 51 columns.** `packages/tui/src/permission-ui.ts:83-87`. At 50 and 45 columns the frame has 7 rows against `permissionPromptRows(2)` = 6; at 51+ it matches. By arithmetic, the old 20-cell note fitted down to 34 columns. `App` sizes the viewport from that count. The new test pins 60 columns only.
4. **LOW: stale comments saying writes are confined to the workspace.** `packages/agent/src/tool-output.ts:6-7` ("its `fs_write` stays confined to the workspace") is now false: the spill store's fallback is `os.tmpdir()/tentacle-<uid>/tool-output`, which is inside the default writable dirs, so `fs_write` can reach it there (it still asks). Also `packages/cli/src/wiring.ts:4`.
5. **LOW: a listed dir that is a dangling link at startup moves the root to the link's target.** `["/tmp/x/dangling"]` gave `roots=[<outside>/dang1]`. It needs the user to list a path in a shared dir, and an existing symlink behaves the same by design (the alias test). F1's fix drops the dangling case.
6. **LOW: repeated and silent drops.** The dropped-entry notice fires once per `buildAgent`, so once per session on `serve` (by reading, `cli/src/serve.ts:182`). An env entry that is not absolute (`rel`, `./y`) is dropped with no log, while the file form is a load error; this is stated in Execution and only narrows.

### Gate (run once, on the restored tree)

`bunx tsc --noEmit`: clean. `bunx biome check .`: 710 files, no fixes. `bun test packages`: **5272 pass, 3 skip (opt-in), 0 fail, 5275 total.** The gate is green because no test covers F1.

### Mutation

`within`: `target.startsWith(root + sep)` → `target.startsWith(root)`. Killed by `writable dirs > a prefix sibling of a writable dir is refused` (16 pass, 1 fail). Restored with `cp` from the backup; `shasum` before and after: `32da63ced5bfd5d8599bd57c2712015a15e7510e`. `git status` was clean. The executor's nine mutations were not re-run.

### Attacks tried

Run with real files through `HostExecution` with `writableDirs: [os.tmpdir(), "/tmp"]`, in three arenas: inside the project, `/tmp`, `os.tmpdir()`. "Outside" was a dir under `.tentacle/tmp/write-tmpdir/review/`. The result is the same in all three arenas unless noted.

| Attack | Branch | `main` (project arena) |
|---|---|---|
| File symlink → existing outside file | refused, unchanged | refused |
| Dir symlink → outside, write inside it | refused | refused |
| Dangling link → outside | **refused** | **ESCAPE** (the executor's claim: red on `main`, green here) |
| Dangling chain `c1→c2→c3→outside` | **refused** | **ESCAPE** |
| Chain to an existing dir | refused | refused |
| Dangling dir, write beneath it | refused | ENOENT |
| Symlink loop (via the self-pointing `d-sub/../lex1`) | refused | **ESCAPE** (there it is not a loop) |
| Dangling `d/../created-outside` (`/tmp`, via `fs_write`) | **ESCAPE (F1)** | ESCAPE in the project (`d-sub/../lex1`) |
| Dangling `../lex2` through a dir link | **ESCAPE (F1, regression)** | refused |
| Hard link to an outside file | ESCAPE (F2) | ESCAPE |
| TOCTOU swap | ESCAPE (F2) | ESCAPE |
| NUL byte after a dangling link | `ERR_INVALID_ARG_VALUE`, nothing written | same |
| `..` out of the arena; `/tmp/../etc/x` | refused | refused |
| `/tmpfoo/x`, `/private/tmpfoo/x`, `/private/tmpx`, `/varfolders/x`, `/etc/x` | refused | refused |
| `/tmp/…`, `/private/tmp/…`, `/TMP/…`, `/Private/Tmp/…`, `$TMPDIR/…` | written (the same real dir; APFS canonicalises case) | refused (Context repro below) |
| Model path `~/x` | literal `<project>/~/x`, no expansion | not run |

`writableDirs` entries:

| Entry | Result |
|---|---|
| `/`, `//`, `/tmp/..`, `/./`, a symlink to `/` | dropped and reported, outside refused |
| `relative`, `""`, unexpanded `~`, `~/x` | dropped and reported, outside refused |
| `/does/not/exist` | root kept literal, outside refused |
| A missing root later replaced by a link outward | refused (roots are pinned, targets re-checked) |
| `/Users` | accepted, wide open under it: only `/` is dropped, as the owner decided |

Env through the real `loadConfig` (`HOME=/home/u`): `""`, `::`, `" : "` → `[]`. `/a/b::/c` → both dirs. `" /a : rel :~/x:~:~root:./y"` → `["/a","/home/u/x","/home/u"]`. `/` → kept by the loader, then dropped with a notice by the primitive. `TMPDIR=/` or `rel` gives a default that the primitive also drops.

### Other checks

- **Context repro on `main`:** both lines `REFUSED … WorkspaceWriteError`. TRUE.
- **Worker path:** `startWorkerRuntime` structured-clones the whole `config` (`local-runtime.ts:951`), so `writableDirs` reaches the real TUI's agent. The end-to-end trace above used `loadConfig` → `buildAgent` → `fs_write`. The live TUI and a real pod were not run.
- **Explore:** tools are `["fs_read"]` (`agent/src/subagent.ts:65-69`), the filter is untouched (no diff in `packages/agent`), and `parallel-agents.test.ts:597` is green. It still cannot write.
- **Ask:** no diff in `permission-gate.ts`; the ask's title and detail are unchanged; only the row text changed. Auto-accept (`permission-ui.ts:51`) was already by tool, not by path, so under Shift+Tab a `/tmp` write is not asked, as with the project and with `shell`. This is not a regression, but "each write still asks" (README, CHANGELOG) is true only outside auto-accept.
- **Pod:** `writableDirs` appears in none of `packages/protocol`, `client`, `daemon`, `docker`, `k8s`, `transport`; `carried-settings.ts` has no row; and no `TENTACLE_WRITABLE_DIRS` forwarding exists. No RPC makes the laptop write a file, and `engine-runtime` never calls `buildAgent`. So a pod's config widens writes only on the pod. By reading, not by a live pod.
- **Config source:** only the user's `configDir` file is read, no project-level config, so a cloned repo cannot widen the list.

### Premise table

| Premise | Result |
|---|---|
| Write tools call `ctx.env.writeFile` (`builtins.ts:128, 201, 249`) | TRUE |
| Only other caller is the spill fallback (`agent.ts:1906`) | TRUE |
| One production `new HostExecution` (`wiring.ts:360`) | TRUE |
| `buildAgent` serves worker, `serve`, pod (`worker.ts:117`, `serve.ts:182, 426, 491`) | TRUE |
| `explore` read-only by tool set | TRUE |
| Spill store writes outside `env` (`tool-output.ts:5-8`) | TRUE for the write; the "`fs_write` stays confined" half is now FALSE (F4) |
| `realTarget` "catches symlink escapes" (Preconditions) | FALSE on `main` for dangling links (found by the executor); still FALSE on the branch (F1) |
| A missing root stays literal (Design §7) | FALSE on macOS; corrected in Execution |

### What holds

Prefix rule, `..` on the model's path, macOS `/private` aliases, case on APFS (canonical strings, no case-insensitive match added), `/` and relative entries, env parsing, `[]` = project only, replace semantics, not carried, the project-only default of the primitive, non-dangling symlinks.

### How the executor behaved

Good on the whole, and honest. It found a real old hole beyond the plan, showed it red, corrected Design §7 against the code and recorded the drift. It kept TOCTOU visible as debt. The weakness is the fix: it re-implemented link resolution by hand with `path.resolve`, and tested only absolute targets, so it declared the class closed. The fix also moved the check from a realpath'd parent to a lexical one, which created the regression.

### Review method note

`bun <script>` needs an approval this session did not have, so the attack scripts ran as `bun test <file>` from `.tentacle/tmp/write-tmpdir/review/` (`attack.ts`, `e2e.test.ts`, `misc.test.ts`; gitignored). Minimal repro of F1:

```ts
symlinkSync(join(outside, "sub"), join(arena, "d"));          // arena under /tmp
symlinkSync("d/../created-outside", join(arena, "lexbad"));
await new HostExecution({ cwd: project, writableDirs: ["/tmp"] }).writeFile(join(arena, "lexbad"), "x");
existsSync(join(outside, "created-outside")); // true: should have been refused
```

### Owner questions

1. **How should F1 be fixed?** Recommendation: **refuse every dangling symlink**. It is a few lines, fails closed, and removes the hand-written resolver. The only cost is that a write through a dangling link that points inside a root gets refused, which is rare and has a clear error. The alternative is a component-by-component physical walk: it keeps that case working, but it re-implements the kernel's resolution in the one place where a mistake is silent.
2. **TOCTOU and hard links: in this branch or later?** Recommendation: **a separate follow-up task**, listed in `TODO.md`: open with `O_NOFOLLOW` and check `nlink` on the descriptor. It is no worse than `main` in kind, and `shell` is unconfined anyway. If you run `serve` on hosts shared with other users, I would do it before merging.

*— claude-opus-5-5, 2026-11-07*
