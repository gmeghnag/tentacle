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

> **Superseded by Fix round 2:** this round's "What remains open" claims are false under a two-flip race (review R2-1): "No content is ever written" and "the fd is pinned to a verified inode". The `nlink` refusal and the post-open name check described above are removed in round 2.

### Fix round 2

*— claude-opus-5-5, 2026-11-07*

This round answers Review round 2 (18129c0). The owner answered **A: close it all in this branch.**

**What changed** (`packages/exec/src/host-execution.ts`):

- **Atomic replace** (`writeFile`, `:382`). No write ever goes through an existing inode. In order:
  1. The checked real path comes from `confineWrite`, as in round 1.
  2. The directory rule runs (below).
  3. The `beforeOpen` seam runs, then the rule is re-checked.
  4. The final name is judged (`finalNameMode`, `:433`):
     - absent: a new file, mode `0666` minus the umask;
     - a symlink: refused as `a symlink at the final path`, never replaced;
     - not a regular file (FIFO, dir): refused;
     - else its `mode & 0o777` is kept (setuid/setgid/sticky dropped).
  5. A temp file `.<name>.<16 hex>.tentacle-tmp` is created in the verified parent with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` (`:145`).
  6. The rule is re-checked, `fchmod` restores the kept mode, the content is written, `fsync`ed and the file closed.
  7. The `beforeRename` seam runs (`:70`), then the rule and the final name are re-checked.
  8. `rename(temp, target)`.
  - A `finally` unlinks the temp on every failure. The `nlink` refusal, `O_NONBLOCK` and the reopen path are gone (a FIFO is refused by `lstat` before any open).
- **The final-name semantics are round 1's.** A link that existed at check time was followed by `confineWrite`, so the real path, not the link, is replaced, and in-root links keep working. A link at the real path now means one appeared after the check: refused, not replaced.
- **The directory rule** (`dirChain`, `:460`; `rootOf`, `:512`, picks the most specific root that holds the target). Every directory strictly below that root, down to the parent, must be:
  - a real directory (`lstat`: not a symlink);
  - owned by `process.getuid()` (test seam `currentUid`, `:75`; skipped where the platform has no uid);
  - `mode & 0o022 === 0` (not writable by group or others).
  - The root itself is exempt (`/tmp`: sticky, `1777`).
  - Missing directories are created with `mkdirSync(dir, 0o755)` (`NEW_DIR_MODE`, `:150`). That respects the umask, which can only remove bits, so they are never group/other-writable even under `umask 000` (tested). They are then judged the same way.
  - A configured writable dir that does not exist yet is created (`mkdir -p`, `0755`), as `Bun.write` used to do.
  - In the recheck phase, every failure is `refused: the path moved during the write (…)`, and `realpath(parent)` must still equal the checked parent.
- **R2-2** (`realTarget` `:132`, `confineWrite` `:536`). A link whose `stat` fails with `ELOOP` gives `refused: symlink loop at <entry>` (no "create it first").
- **Docs.**
  - CHANGELOG "Fixed" is rewritten to the actual guarantees: atomic replace, the directory rule, `0755` minus umask, and that a same-uid process and `shell` are not covered.
  - The README row is updated. No TODO follow-up is needed (R2-1 is closed here).

**Red → green** (`packages/exec/test/confinement.test.ts`, new `describe("atomic replace and the directory rule (fix round 2)")`; each case runs in a writable dir AND in the project). Ten were RED on the round-1 code:

| # | Test | Why it was red on round 1 |
|---|---|---|
| 1 | R2-1 FLIP: the reviewer's form, by wrapping `FileHandle.prototype.stat` | outside overwritten |
| 2 | R2-1 TWO-STEP: `beforeOpen` swaps `q` outward; the `stat` wrapper swaps it back holding a hard link | outside overwritten |
| 3 | R2-3: a parent swapped outward leaves NOTHING outside | an empty file was left |
| 4 | group- (`775`) and other-writable (`757`) intermediate dirs are refused; a `1777` root is accepted | written |
| 5 | another uid's dir is refused (`currentUid` seam) | written |
| 6 | created dirs are never `g/o+w` under `umask 0` | created `777` |
| 7 | R2-4: a hard-linked file inside the root is writable and its link is broken | refused |
| 8 | no temp left on failure (`beforeRename` throws; a dir at the path) | the seam was ignored |
| 9 | R2-2: the loop message | it said "create it first" |
| 10 | the round-1 test "a hard link to a file outside every root never changes the outside file" | refused |

- Test 10 was **changed by owner decision**: it asserted `refused: hard link` and now asserts the write succeeds, the outside file keeps `orig` and the in-root name has the new bytes.
- "An existing file's mode bits are kept" was green before (an in-place write keeps the mode). It is a guard for the rename, and mutation 5 shows it is not vacuous.
- The round-1 tests (final-path link race, parent swap, FIFO, ordinary writes) pass unchanged.
- Real files in this repo: `stubs/react-devtools-core/index.js` has `nlink 2` (`package.json` has 1 here, after a reinstall). `find` shows no group/other-writable directory in the worktree outside `node_modules`/`.git`.

**Mutations** (cp backup → Edit → `confinement.test.ts` → cp restore → `shasum -c` OK, every time):

| # | Mutation | Killed by |
|---|---|---|
| 1 | drop the ownership check | another-uid dir |
| 2 | `rename` replaced by an in-place `Bun.write(target)` | outside hard link, FLIP, in-root hard link |
| 3 | drop the `0o022` check | group/other-writable dir |
| 4 | the rechecks become no-ops | parent swap (round 1), TWO-STEP, R2-3 |
| 5 | drop the `fchmod` | mode bits kept |
| 6 | the temp is not unlinked on failure | no temp left |

After the mutations, Biome's `noVoidTypeReturn` made me turn `dirChain`'s `return moved(…)` into `throw moved(…)` (same branches, same messages), and the narrow test file was re-run green.

**Gate:** `bunx tsc --noEmit` clean. `bunx biome check .` clean (710 files). `bun test packages`: **5297 pass, 3 skip (opt-in), 0 fail** (5300 total).

**What remains open, honestly:**

- **A process running as the same uid is not stopped.** It can rename the user's own directories, chmod them, or write anywhere the user can. The rule only stops OTHER users. That is not this boundary's job.
- **`shell` is unconfined.**
- **A world-writable root WITHOUT the sticky bit** (e.g. a `TMPDIR` set to a `777` dir) is exempt as the owner specified. There, another user could rename our temp or our subdirectory entries in the root itself. A sticky requirement would be one cheap check; not done, owner decision.
- **Behaviour changes to weigh:**
  - **(a) A user with `umask 002` (user-private groups, common on Ubuntu)** has group-writable project directories (`775`). Every write BELOW the project root is then refused with `writable by group or others`. This follows the rule as specified; it may need an exception (e.g. accept `g+w` when the dir's group is the user's private group). **Owner question.**
  - **(b)** A project directory owned by another uid (e.g. created with `sudo`) is now refused.
  - **(c)** A hard-linked file loses its link when written, like an editor's atomic save. A file owned by another user in one of our directories is replaced by one we own.
  - **(d)** Directories the tools create are `0755` minus the umask, not `0777` minus the umask.
- **Same-uid race tests.** The race tests run on one uid through seams (`beforeOpen`, `beforeRename`, a wrapped `FileHandle.prototype.stat`). The cross-uid guarantee rests on POSIX semantics, by reasoning, not measured with two users: a non-owner cannot rename entries in a directory it cannot write, and in a sticky root it cannot remove our entries.
- **TOCTOU on the rule itself.** Between the last recheck and `rename` there is a window of a few syscalls. Only a principal that can write those directories could use it, and by the rule that is the user or root.
- **The dropped-entry notice is still per `buildAgent`** (LOW 6, first half).
- **Scratch:** this round's backups were removed from `.tentacle/tmp/write-tmpdir/`; the plan and the reviewer's `review/` folder remain.

> **Superseded by Fix round 3:** the directory owner/mode rule above, its `currentUid` seam, `NEW_DIR_MODE` and the claim "another user cannot swap a directory under the write" are removed.

### Fix round 3

*— claude-opus-5-5, 2026-11-07*

**Owner decision:** REMOVE the directory owner/mode rule entirely. It is too rigid: `umask 002` and pods with `fsGroup` would block project writes, and `/tmp` must always be writable. Everything else from round 2 is kept.

**What changed** (`packages/exec/src/host-execution.ts`):

- **`dirChain`** (`:449`): the `uid` and `mode & 0o022` checks are deleted, so is the `currentUid` seam with its field. What stays does not depend on ownership:
  - every directory below the root is a real directory, not a symlink (`lstat`);
  - in the recheck phases, every one must still exist and `realpath(parent)` must still equal the checked parent.
- **`mkdir -p` is back to the default mode** (`mkdirSync(dir)` at `:467`, and `mkdirSync(root, { recursive: true })` at `:380`): `0777` minus the umask. `NEW_DIR_MODE` is deleted.
- **Kept, unchanged:**
  - the `O_CREAT|O_EXCL|O_NOFOLLOW` temp + `fsync` + `rename` (`writeFile`, `:369`);
  - the mode bits kept;
  - no `nlink` refusal;
  - the dangling and loop refusal and the loop message;
  - a symlink at the final real path refused (round-1 semantics);
  - the post-create and pre-rename parent `realpath` re-checks;
  - the temp unlinked on failure.
- The comments are updated. The header no longer claims the rule. `writeFile`'s doc names the residual and points here.

**Tests** (`packages/exec/test/confinement.test.ts`):

- **Removed:** exactly the three tests that pinned the rule: "a group- or other-writable directory below the root is refused", "a directory below the root owned by another uid is refused (injected uid)", "directories created for a write are never group/other-writable, even under umask 000".
- **Added** (`:452`): "fix round 3: a group-writable (0775) subdirectory is writable, in the project and in a temp root" (both arenas; plus a `1777` sticky root).
- **RED on the round-2 code:** I put e3444b0's `host-execution.ts` in place temporarily (backup + `shasum -c` OK after the restore). Result: 1 fail, `refused: … is writable by group or others`. GREEN on this round's code.
- Every other test is untouched and green (80 in `packages/exec`). That includes the round-2 FLIP/TWO-STEP/R2-3 tests, which hold through the remaining `realpath`/symlink re-checks (seam-driven).

**The residual, measured with a real concurrent attacker.** The repro (`.tentacle/tmp/write-tmpdir/r3/`, deleted after the run) worked like this:

- A separate `bun` process flips `<arena>/a-real` as fast as it can: rename the dir aside, put a symlink to `<victim>` in its place, remove it, rename the dir back. `<arena>` stands for `/tmp`, `<victim>` for e.g. `~/.ssh`, which holds an existing `authorized_keys` = `orig`.
- The writer loops `HostExecution{writableDirs:[arena]}.writeFile(<arena>/a-real/authorized_keys, "PWNED-<i>")`.
- Same uid. Only directory renames and symlinks are used, which a different user owning `a-real` in `/tmp` could equally do.

Result over 20 s (86,488 flips, 135,530 writes):

| Outcome | Count |
|---|---|
| Written | 1,041 |
| `moved during the write` | 52,280 |
| Outside the workspace | 34,591 |
| Not a directory | 23,752 |
| `ENOENT` | 18,506 |
| Dangling symlink | 3,622 |
| `EINVAL` | 1,738 |
| **Existing `<victim>/authorized_keys`** | **still `orig`: never written in place, never replaced** |
| **New files in `<victim>`** | **1,443 `.authorized_keys.<hex>.tentacle-tmp`, 380 holding our content** |

A 6 s run gave the same picture: 354 stray temps, 111 with content, the victim file untouched.

**So the exact residual is:**

- **What happens.** Another local user who can write a directory on the path can race directory↔symlink swaps. A directory they can write is one they created in a shared root such as `/tmp`, or a group/other-writable directory in a project. Winning the race makes our write create NEW hidden files named `.<basename>.<random>.tentacle-tmp` in ANY directory the tentacle user can write. Some of them hold the model's content, and they are left behind (the cleanup `unlink` resolves the path again and misses them).
- **What did not happen.** An existing outside file was never written in place: no write goes through an existing inode.
- **Not excluded.** It is not excluded by reasoning that our temp gets `rename`d over an existing outside file with the same basename. That needs three aligned flips: link at the temp create, real dir at both re-checks, link again at the `rename`. Not observed in 135,530 writes, so it is stated, not claimed impossible.
- **Who is affected.** This matters only on hosts shared with other users (and in a project only if another user can write one of its directories). A same-uid process can do anything anyway, and `shell` is unconfined.
- **Where it is written down.** CHANGELOG "Fixed" ("Known limit…") and the README `tools.writableDirs` row state this. The CHANGELOG no longer claims "another user cannot swap a directory".

**Gate:** `bunx tsc --noEmit` clean. `bunx biome check .` clean (710 files). `bun test packages`: **5295 pass, 3 skip (opt-in), 0 fail** (5298 total; round 2 had 5297, minus 3 removed, plus 1 added).

**Still open:**
- the residual above;
- `shell` is unconfined;
- same-uid processes are out of scope;
- the dropped-entry notice is still per `buildAgent` (LOW 6, first half).

### Fix round 4

*— claude-opus-5-5, 2026-11-07*

This round answers Review round 3 (bea50f8): F1–F5, all fixed in this branch.

**What changed** (`packages/exec/src/host-execution.ts`):

- **F1, temp mode.** The temp is created with mode `0600` (`:408`). The final bits are set by `fchmod` only after the content is written and `fsync`ed (`:416`): the target's `mode & 0o777`, or `0666 & ~umask` for a new file. That matches what `open(…, 0o666)` gave before, so a new file's mode is unchanged.
- **F2, permission parity with `main`.**
  - `finalNameMode` (`:467`) now calls `accessSync(target, W_OK)` (`:486`). It runs before the temp is created and again before the `rename`.
  - A read-only file, or another user's file we may not write, is refused: `refused: read-only file (EACCES: permission denied; it is read-only or another user's)`. The error carries `code: "EACCES"`, like the errno an in-place write threw: `WorkspaceWriteError` gained an optional `code` (`:80`).
  - The directory owner/mode rule is NOT back; only the target file's own write permission is checked.
  - `dirError` (`:448`) maps `EACCES`/`EPERM` on the temp create or the `rename` to a `WorkspaceWriteError` that names the directory, not the hidden temp. Example: a `0666` file in a `0555` dir, or a sticky dir where the target is another user's.
  - **Choice made:** such a file is **refused clearly, with no in-place fallback**. A fallback would bring back writes through an existing inode, which is what round 2 removed. This differs from `main`, which wrote it. **Open for the owner**, and documented in the CHANGELOG and the README.
- **F3, temp name.** The name is now `.tt-<16 hex>.tentacle-tmp` (`:403`), 33 bytes, never derived from the basename. It keeps the `tentacle-tmp` suffix, so the existing `leftovers()` helper and the documented residual name stay meaningful.
- **F4, temp cleanup.**
  - The cleanup is now a `catch` that unlinks the temp on ANY failure, including a failed `rename`.
  - If the unlink itself fails (e.g. the parent became read-only), the thrown error says `(temp file left at <path>: <errno>)` and keeps its type and `code`.
  - The `beforeRename` seam moved to just before the `rename`, after the last re-checks, so a test can make the `rename` itself fail.
- **F5 + nit, docs.**
  - CHANGELOG "Fixed": the `0600` temp; that the replace breaks hard links and does not keep owner, group, ACLs, xattrs, or setuid/setgid/sticky ("like an editor's atomic save"); the `EACCES` parity; the non-writable-dir refusal; "permission bits"; the residual temp name updated to `.tt-<random>.tentacle-tmp`.
  - The README row says the same.
  - `writeFile`'s doc comment is rewritten to match.

**Tests** (`packages/exec/test/confinement.test.ts:525`, new `describe("permission parity and temp hygiene (fix round 4)")`; each case runs in the writable dir AND in the project; the permission tests are skipped when running as root, where permission bits do not apply):

| Test | Round 3 code |
|---|---|
| F1: the temp's mode while the content is written (seen via a wrapped `FileHandle.prototype.writeFile` → `fstat`) is `[0600]` for `0600` and `0644` targets; at `beforeRename` and at the end it is the target's | **red** (`644`) |
| F1: a new file gets `0666 & ~umask` under umask `022` and `002` | green: guard, the behaviour is unchanged |
| F2: `0444` refused with `EACCES` (message and `code`), content `orig`, no temp left; once made `0644` it is replaced | **red** (replaced) |
| F2: a real root-owned file (`/etc/hosts` with `writableDirs: ["/etc"]`) is refused with `EACCES`, unchanged | **red** (raw rename error) |
| F2: a `0666` file in a `0555` dir is refused, naming the dir and not the temp; content unchanged | **red** (raw `EACCES` on the temp) |
| F3: a 250-byte name is written, no temp left | **red** (`ENAMETOOLONG`) |
| F4: `rename` fails (a non-empty dir appears at the target via the moved seam) → temp unlinked | green before only because the old seam ran before the final-name re-check. Pinned by mutation 3 below |
| F4: the parent made `0555` before the `rename` → the error names the `.tt-…` temp left behind | **red** |

**Mutations** (backup → Edit → narrow test → restore → `shasum -c` OK):

| # | Mutation | Result |
|---|---|---|
| 1 (F1) | temp opened with `0o666` | killed: the F1 temp-mode test |
| 2 (F2) | `access(W_OK)` → `F_OK` | killed: the `0444` test. The root-owned `/etc/hosts` case still refused, because the `rename` into the root-owned `/private/etc` fails and is mapped, so that test pins the outcome, not this guard alone |
| 3 | the temp never unlinked on failure | killed: the round-2 "no temp left", F4 rename-fails, F4 temp-left message |
| 4 | `EACCES`/`EPERM` not mapped | killed: the non-writable dir, F4 temp-left message |

**Gate:** `bunx tsc --noEmit` clean. `bunx biome check .` clean (710 files). `bun test packages`: **5303 pass, 3 skip (opt-in), 0 fail** (5306 total; +8 tests).

**Open:**

- A writable file in a non-writable directory is refused, while `main` wrote it. This is the owner question from Review round 3 F2.
- The foreign-owner case is covered by `access(W_OK)` and by one real root-owned file. A second uid owning a file in a directory WE own was not available here; by POSIX, `access` refuses it the same way.
- On a filesystem whose permission model `access` does not reflect (e.g. some network mounts), the result follows `access`.
- Unchanged from round 3: the shared-root race residual, `shell` unconfined, same-uid processes out of scope, and the per-`buildAgent` dropped-entry notice.
- Scratch: this round's backups were removed; `.tentacle/tmp/write-tmpdir/` holds only the plan and the reviewer's `review/`.

### Fix round 5

*— claude-opus-5-5, 2026-11-07*

**Owner decision on round 4's open point: A, fall back to an in-place write.** It applies when the target file is writable but its directory is not, i.e. the temp `open` fails with `EACCES`, `EPERM` or `EROFS`. This matches `main`.

**What changed** (`packages/exec/src/host-execution.ts`):

- `finalNameMode` (`:589`) now returns what it checked: `CheckedTarget { mode, dev, ino }` (`:158`). Before, it returned only the mode.
- In `writeFile` (`:429`), when the temp `open` fails with a code in `IN_PLACE_FALLBACK` (`:155`) **and the target existed at the check**, it calls `writeInPlace` (`:479`). It never falls back for a new file or for any other error: those still go through `dirError`, the clear refusal naming the directory.
- **`writeInPlace`:**
  1. The test seam `beforeInPlaceOpen` (`:75`) runs.
  2. `open(target, O_WRONLY|O_NOFOLLOW|O_NONBLOCK)` (`:153`): no `O_CREAT`, no `O_TRUNC`. `ELOOP`/`EMLINK` → `a symlink at the final path`. `ENXIO` → not a regular file. `ENOENT` → moved.
  3. Then `fstat` on the descriptor: it must be a regular file, with `nlink === 1` (`:514`, else `refused: hard link …`), and the same `dev`+`ino` as checked (`:519`, else `moved`).
  4. Then a `dirChain` recheck, plus `lstat(target)` must still be that inode.
  5. Only then `ftruncate(0)`, write, `fsync`, close.
  - The mode and owner are untouched (it is the same inode).
- `dirError`'s message no longer claims "a file there is never rewritten in place".
- The `writeFile` doc comment, the CHANGELOG ("in a directory you cannot create files in, an **existing** writable file is still written, in place, as before … a **new** file there is refused") and the README row describe the fallback.

**Tests** (`packages/exec/test/confinement.test.ts`; both arenas; skipped as root; every read-only dir is restored to `0755` in a `finally`):

- **Flipped by owner decision:** the round-4 test at `:625`, "a writable file in a directory we cannot write is refused clearly", became "… is written in place, as on main". It checks the content `"new"` replacing a longer original (so the truncation is correct), the mode `666` kept and no temp left. It was **red** on round 4 (refused).
- **New `describe` at `:695`:**

| Test | Round 4 code |
|---|---|
| A hard-linked target in a read-only dir is refused with `hard link`; both names keep `orig` | **red**: refused, but by the directory error, not the hard-link guard |
| A symlink swapped in at the final path before the in-place open (seam) is refused with `symlink at the final path`; the outside victim keeps `orig` | **red**: no seam, the dir error |
| A different file swapped in before the in-place open is refused (`moved`); both files keep their bytes | **red** |
| A NEW file in a read-only dir is still refused with the clear error naming the dir; nothing is created | green: a guard for the "never for a new file" rule |

**Mutations** (backup → Edit → narrow test → restore → `shasum -c` OK):

| # | Mutation | Result |
|---|---|---|
| 1 | the fallback's `nlink` check dropped (as asked) | killed: the hard-linked-target test |
| 2 | `O_NOFOLLOW` dropped from the in-place open | killed, on the message. The same-inode check still refused it (`moved`), and the victim was untouched: defence in depth |
| 3 | the checked-inode comparison dropped | killed: the different-file swap test |

**Gate:** `bunx tsc --noEmit` clean. `bunx biome check .` clean (710 files). `bun test packages`: **5307 pass, 3 skip (opt-in), 0 fail** (5310 total; +4).

**Open:**

- **The fallback writes through an existing inode in a non-writable directory.** In that one case, the pre-round-2 race class comes back in a reduced form: a symlink at the final name is refused by `O_NOFOLLOW`, and a hard link by `nlink`. A two-flip race on the name (the R2-1 FLIP) needs whoever controls the directory to change names in it. In a directory that WE cannot write, that is another user who CAN write it. This is the owner's accepted trade-off for parity with `main`.
- Unchanged: the shared-root race residual, `shell` unconfined, same-uid processes out of scope, the per-`buildAgent` dropped-entry notice.
- Scratch: this round's backups were removed.

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

### Review round 2

*— claude-opus-5-5, 2026-11-07*

**Verdict: REQUEST-CHANGES (0 HIGH, 1 MEDIUM, 3 LOW).**
- F1 is closed: every escape form is refused, in every arena.
- The hard-link refusal, `O_NOFOLLOW` and the post-open check close the *single-step* forms of F2.
- A *two-step* race still overwrites an existing outside file with content. The Execution and the CHANGELOG say this cannot happen. The minimum change is to make those claims true and record the residual. Whether to close it is Owner question 1.

**Independence.** Fresh context, same model as the executor and as round 1 (`claude-opus-5-5`). This task is load-bearing, so a pass by a different model is still worth having.

#### Findings

Numbered R2-1 to R2-4, so they don't clash with round 1's F1 to F6.

1. **R2-1 MEDIUM: a two-flip race defeats the post-open checks, and a victim's existing file gets the model's content.** The checks on the descriptor are a sequence, not one atomic step:
   - the `fstat` at `packages/exec/src/host-execution.ts:350`;
   - the `nlink` check at `:354`;
   - the name check at `:362-372`;
   - the truncate and write at `:378`.

   An attacker who changes names between them passes every check, and `:378` then writes the victim's inode. Measured with real files, in the project, in `/tmp` and in `os.tmpdir()`. The attacker's steps are injected by wrapping `FileHandle.prototype.stat`, which is deterministic and on one uid. Both forms:
   - **FLIP** (no directory needed). The attacker plants `<arena>/flip` as a hard link to `outside/victim3`. The attacker removes that name just before the `fstat` (so `nlink` is 1) and puts it back just after (so the name check matches dev and ino). Result: `WROTE`, and `outside/victim3` = `PWNED` in all 3 arenas.
   - **TWO-STEP.** The attacker swaps `<arena>/q` for a link to `outside/sub` before the open. After the `fstat`, the attacker swaps a real `q` back, holding a hard link to the opened inode. Result: `WROTE`, `outside/sub/victim2` = `PWNED` in all 3 arenas.

   Cross-uid precondition: macOS lets a user hard-link a file it does not own. `ln /private/etc/hosts <scratch>/hosts-link` succeeded: `nlink 2`, owner `root`, link removed afterwards. So on a shared macOS host another user can plant the FLIP link in `/tmp`, pointing at the victim's own file. Linux with `fs.protected_hardlinks=1` (the common distro default) forbids that hard link; that is from knowledge, not measured.

   Practical bar: a different local user, a write the user approves to a name the attacker predicted, and a window of a few syscalls won twice. It is rare, but it is a content overwrite outside, not an empty trace.

   - **False claims while this stands:**
     - Execution "What remains open": "No content is ever written".
     - Execution: "After the post-open check, the fd is pinned to a verified inode" (the verification is by name, so it is racy).
     - `CHANGELOG.md:32-34`: "a symlink or a swapped directory slipped in between the check and the write is refused".
     - README row: "a hard-linked file … is refused everywhere" (true only without a race).
   - **Re-ordering the checks does not fix it.** Moving the `nlink` check after the name check only adds a third flip. This is reasoning, not run. Name-based checks cannot pin an inode.
   - **Required (minimum):**
     - Reword those claims: single-step swaps are refused; a racing local attacker can still win.
     - Add the residual to `TODO.md` as a follow-up.
   - **A real fix** is Owner question 1.
2. **R2-2 LOW: a symlink loop is reported as a missing target.** `:425` prints `refused: dangling symlink <A>/l1 (its target does not exist; create it first)` for `l1 ↔ l2` and for `self → self`. Following "create it first" is impossible for a loop. Something like "dangling or looping symlink" would fix it. Fails closed, so the cost is cosmetic.
3. **R2-3 LOW: an empty file (and empty dirs) can be left outside after a single parent swap.** This is as the executor disclosed, and verified: a swapped parent plus a new name leaves `outside/sub/g` with 0 bytes. An existing outside file keeps `ORIG` (no truncation). Empty files created outside under directories named by `mkdir -p` (`:346`) follow from the code; that part was read, not run.
   - Acceptable on its own: no content, no truncation, and only with an active attacker.
   - One caveat: an empty file can matter by existing (e.g. `~/.hushlogin`).
4. **R2-4 LOW (behaviour change, for the owner, not to fix here): hard-linked project files are now unwritable by the tools.** Measured on this machine:
   - **This repo:** 2 of the tracked files have `nlink > 1`: `stubs/react-devtools-core/index.js` and `package.json`. `bun install` hard-links the `file:` dependency into `node_modules/.bun/…`. So `fs_write`/`fs_edit` on those two source files now fails with `refused: hard link (2 names …)`. It is a real hit in this repo.
   - **Git worktrees:** this worktree has no other tracked file with `nlink > 1`. Git checks out new inodes; a local `git clone` hard-links only `.git/objects`.
   - **Registry packages on macOS:** 0 of the 4179 files in `node_modules` that came from the registry have `nlink > 1`. Bun clones them (`clonefile`), and a clone is a new inode.
   - **Linux:** `node_modules` from pnpm, or from bun's default `hardlink` backend, has `nlink > 1` on essentially every file. That is from knowledge, not measured. Writing there is rare.
   - The error says why, and the model can fall back to `shell` (unconfined).

#### Attacks tried

Real files under `.tentacle/tmp/write-tmpdir/review2/`, `writableDirs: [os.tmpdir(), "/tmp"]`. There are three arenas: in the project, `/tmp/wt-r2-*` and `$TMPDIR/wt-r2-*`, each with its own `outside` dir. The results are the same in all three arenas.

| Attack | Result |
|---|---|
| R1 lexical `d → outside/sub`, `lexbad → d/../created-outside` | refused: dangling symlink, nothing outside |
| R1 regression `outside/sub/up → ../up-out` via `d/up` | refused: dangling symlink |
| Dangling link at the final path | refused |
| Dangling link as an intermediate dir (`ddir/deep/x`) | refused (names `ddir`) |
| Dangling chain `c1 → c2 → c3 → outside` | refused |
| Chain to an EXISTING outside file | refused: outside the workspace |
| Loop `l1 ↔ l2`, at the final path and as `l1/x`; self-loop | refused (message: R2-2) |
| Hard link to an outside file: `fs_write`, `fs_edit`, `fs_multi_edit` (real tools) | refused, outside `ORIG hello` unchanged |
| New file; new file under new subdirs; overwrite longer → shorter; `fs_edit`; `fs_multi_edit` | written; truncation correct; `nlink` 1 |
| Final path swapped for a link to an existing outside file (`beforeOpen`) | refused by `O_NOFOLLOW`, outside unchanged |
| A new final path swapped for a dangling link outward | refused (`EEXIST` → `ELOOP`), nothing created |
| Parent swapped, the target exists outside | refused ("moved during the write"), outside `ORIG`: not truncated |
| Parent swapped, new target | refused, a 0-byte file left outside (R2-3) |
| **TWO-STEP**: parent swap + swap back with a hard link after `fstat` | **WROTE, outside overwritten (R2-1)** |
| **FLIP**: hard link unlinked around `fstat` | **WROTE, outside overwritten (R2-1)** |

**Coverage.** `rg 'Bun\.write|writeFile\(|writeFileSync'` over `exec/src`, `tools/src` and `agent/src`:
- `fs_write`, `fs_edit` and `fs_multi_edit` (`tools/src/builtins.ts:128, 201, 249`) and the spill fallback (`agent/src/agent.ts:1906`) all call `env.writeFile`. `HostExecution` (`:166`) is its only implementation, and it writes only through the descriptor (`:379`).
- The other hits are not model-steered: `tool-output.ts:81` is the spill store's own `0600` create, and `session-store.ts:144` is the session store.
- `Bun.write` no longer appears in the tool paths.

#### LOW 3, 4, 6 from round 1

- **LOW 3: fixed.** `permission-ui.ts:86-89` cuts the whole row to `columns - 2`. The pure check at 30/40/45/50 columns and the `<Box width>` frame at 45/50 pass. Below about 46 columns the pre-existing key-hint footer wraps, as the executor disclosed; that is not this row.
- **LOW 4: fixed.** `tool-output.ts:5-9` and `wiring.ts:4` now match the behaviour.
- **LOW 6: fixed for the env.** `parseDirList` keeps `rel/dir` and `./y`. The `wiring.test.ts:1040-1045` notice is asserted, and 54/54 pass across the three files. The first half, a notice once per `buildAgent`, is still open, as disclosed.

#### Mutations

`cp` backup, edit, narrow test (`confinement.test.ts`), `cp` restore. `shasum` before and after: `738485b1ef1a235a326ce1a0fa8194ba11e07954`. `git status` was clean.

| Mutation | Result |
|---|---|
| M1: drop `O_NOFOLLOW` from `OPEN_EXISTING` | killed (25 pass, 1 fail), on the MESSAGE only: the post-open inode check still refused and the outside file was untouched. The test pins the defence in depth, not `O_NOFOLLOW` alone |
| M2: `st.nlink > 1` → `> 2` | killed (25 pass, 1 fail): `a hard link to a file outside every root is refused` |

#### Gate

Run once, on the restored tree:
- `bunx tsc --noEmit`: clean.
- `bunx biome check .`: 710 files, no fixes.
- `bun test packages`: **5287 pass, 3 skip (opt-in), 0 fail; 5290 total.** It matches the executor's count.

#### What holds

- F1 entirely: refusing every dangling link removed the hand-written resolver, and with it both round 1 forms and the loop case.
- The open order: `O_EXCL`, then a reopen without `O_TRUNC`, then the checks, then `ftruncate`. No refused write truncated anything, in any test.
- In-root links still work.
- FIFOs are refused (by the executor's test, not re-run).
- All write tools are covered, and `Bun.write` is gone from the tool paths.
- LOW 3, 4 and 6.

#### How the executor behaved

Good and honest:
- It did what the owner chose, showed every new test red, and ran six mutations.
- It disclosed the empty-trace residual and LOW 6's open half.
- Its blind spot is the same in kind as round 1: it treated a check that reads names as pinning an inode, and it tested only one swap per race. So "no content is ever written" went into the doc and the CHANGELOG without a test that a second flip could break.

#### Scratch

The round 2 scripts (`review2/attack2.test.ts`, `leftover.test.ts`, the `.bak`) were deleted after this review. A check from inside Bun found no `wt-r*` entries left in `/tmp` or `os.tmpdir()`; round 0's `/tmp/wt-repro*.txt` are also gone. The core of the FLIP race:

```ts
linkSync(join(outside, "victim3"), name);           // planted hard link in the arena
proto.stat = async function (...a) {                 // FileHandle.prototype.stat
  rmSync(name); const st = await realStat.apply(this, a); linkSync(join(outside, "victim3"), name); return st;
};
await env.writeFile(name, "PWNED");                  // WROTE; outside/victim3 === "PWNED"
```

#### Owner questions

1. **Close the two-flip race in this branch, or record it as a follow-up?** **Recommendation: follow-up**, with this branch's claims reworded now (R2-1, required). A real fix needs a different write strategy, not more checks:
   - **Hard links:** write a new file with `O_EXCL` in the verified parent, then `rename` it over the target. This never writes through an existing inode, so a hard link only loses its in-root name and the victim stays intact. It also removes the `nlink` refusal (R2-4): `stubs/…` becomes writable again, at the cost of breaking the link, as an editor's atomic save does.
   - **Directory swaps:** additionally require every directory below the writable root to be owned by the user and not writable by group or others. Then another user cannot rename them.

   The bar is high: a different local uid, a shared macOS host, and two won windows. `shell` is unconfined anyway. If you run `serve` on hosts shared with other users, do it before merging.
2. **The hard-link refusal hits this repo's own `stubs/` (R2-4).** Recommendation: accept it for now. If question 1 goes the `rename` way, it goes away. Otherwise, document it in the README row ("a hard-linked file, e.g. a `file:` dependency after `bun install`").

*— claude-opus-5-5, 2026-11-07*

### Review round 3

*— claude-opus-5-5, 2026-11-07*

**Scope:** `git diff 18129c0..8d25f56` (fix rounds 2 and 3). **Independence:** fresh context, but the same model as the executor, so shared blind spots are possible. A pass by a different model is still worth having on this load-bearing path. Following the owner's decisions, the shared-root directory-swap residual is accepted, and no ownership rule is asked for.

**Verdict: REQUEST-CHANGES.** 0 HIGH, 2 MEDIUM, 3 LOW. The atomic write is correct for ordinary use, cleans up after itself, and is mutation-pinned. But it drops three properties that the in-place write on `main` had, and the docs mention none of them:
- the confidentiality of a restrictive file during the write;
- the refusal to write a read-only or foreign file;
- writes into a directory we can't create files in, and long names.

#### Findings

1. **MEDIUM: a `0600` target's new content passes through a `0644` temp file.**
   - **Where.** `packages/exec/src/host-execution.ts:393` creates the temp with `open(temp, OPEN_TEMP, 0o666)`, so its mode is `0666 & ~umask` = `0644`. The kept mode is applied only afterwards by `fd.chmod(mode)` at `:396`.
   - **Measured.** A real `secret.env` at `0600` in the project. A wrapper on `FileHandle.prototype.chmod` saw the temp at mode `644`. A descriptor opened in that window read `"TOP-SECRET"` after the write finished, while the final file is `600`.
   - **Who can exploit it.** Any user who can traverse the directory and is polling it can open the temp in that window. The descriptor survives the `fchmod` and the rename.
   - **Regression.** `main` writes in place into the existing `0600` inode and has no such window.
   - **Fix (cheap).** Create the temp with `0o600`. Then `fchmod` to the kept mode, or for a new file to `0o666 & ~umask`. Add a test that the temp is never more permissive than the target.
   - **Scope.** This is a confidentiality leak, not the documented "content lands outside" residual.
2. **MEDIUM: a read-only (`0444`) or foreign-owned target is now silently replaced. A writable file in a non-writable directory now fails with a raw error.**
   - **Read-only target.** `rename` needs write permission only on the directory (`:405`).
     - Measured, branch: a `0444` `ro.txt` is replaced with the new content and keeps mode `444`.
     - Measured, `main`: `EACCES`, file untouched.
   - **Foreign-owned target.** By the same POSIX rule, a file owned by another user (e.g. root) in a directory we own is replaced by one we own. Not measured: that needs a second uid. In a sticky root such as `/tmp`, the `rename` fails with a raw `EPERM` instead.
   - **Writable file in a `0555` directory.** The reverse case fails.
     - Measured, branch: a `0666` file in a `0555` dir gives `Error: EACCES: permission denied, open '…/rodir/.f.txt.<hex>.tentacle-tmp'`. That is a raw Node error naming a hidden file the user never asked for.
     - Measured, `main`: written.
   - **Docs.** Fix round 2's "(c)" mentions only the foreign-owner case, and only in the Execution section. The CHANGELOG and the README say none of this.
   - **Fix.** Refuse a target we could not write in place: `access(target, W_OK)`, or mode/owner bits, refused as `refused: read-only file`. Map `EACCES`/`EPERM` on the temp create or on the `rename` to a `WorkspaceWriteError` that names the directory and the reason.
   - **Owner question.** Should a writable file in a non-writable directory fall back to an in-place write, or be refused clearly? Either way, document it.
3. **LOW: a basename longer than 224 bytes can no longer be written.**
   - The temp name adds 31 bytes: `.` + `.<16 hex>` + `.tentacle-tmp` (`:388`).
   - Measured: a 254-byte name (250 `L` + `.txt`, under `NAME_MAX` 255) gives a raw `ENAMETOOLONG` naming the temp file. `main` writes it.
   - Fix: truncate the basename part of the temp name, e.g. to 64 bytes. The name only has to be unique, and the random suffix makes it so.
4. **LOW: a `rename` that fails because the parent became non-writable leaves the temp.**
   - Measured: `beforeRename` runs `chmod 0555` on the parent. The result is `EACCES` on the `rename`, and `.x.txt.<hex>.tentacle-tmp` stays behind, because the `unlink` at `:410` fails for the same reason.
   - This can't be fixed: the temp can't be removed without write permission on the directory. Since the error is swallowed, at least say so in the error.
   - It is contrived and listed for completeness.
5. **LOW: the replace doesn't keep metadata.** This is an expected property of temp + rename, but undocumented:
   - setuid/setgid/sticky are dropped (`:438`; measured `4755` → `755`; `main` also loses setuid on write, so this is not a regression);
   - ACLs and xattrs are lost (macOS Finder tags, quarantine, Linux ACLs);
   - the owner and group become ours.

   A clause in the CHANGELOG bullet ("like an editor's atomic save: ownership, ACLs and xattrs are not kept") is enough.

#### Attacks tried

The script ran on the branch and on `main`'s `host-execution.ts`, with real files in `.tentacle/tmp/write-tmpdir/r3review/`. That folder is deleted.

| Attack | Branch | `main` |
|---|---|---|
| `0755` script rewritten | OK, mode `755` | same |
| 100 KB file rewritten to `"short"` | content exactly `"short"` | same |
| empty content | OK, size 0 | same |
| new file in `a/b/c/` | OK, dirs `755` (umask 022) | same |
| hard link `h1`/`h2` in the project, write `h1` | `h1=new`, `h2=old` | `h2=new` (by design now) |
| in-root symlink `link.txt → real.txt` | `real.txt` replaced, the link still a link | same |
| `0444` target | **replaced** (F2) | `EACCES` |
| `0666` file in a `0555` dir | **raw `EACCES` on the temp** (F2) | written |
| 254-byte basename | **`ENAMETOOLONG`** (F3) | written |
| file `644` in a `0775` dir | OK, `644` kept | same |
| setuid `4755` file | `755` | `755` |
| simulated `ENOSPC` (`FileHandle.prototype.writeFile` throws) | error, target `old`, no temp left | — |
| `beforeRename` throws | error, no target, no temp left | — |
| a non-empty dir appears at the target before `rename` | `refused: not a regular file`, no temp left | — |
| parent `chmod 0555` before `rename` | raw `EACCES`, **temp left** (F4) | — |
| 20 MB content | OK, no temp left | — |
| 50 concurrent writes to one file, 200 KB each | 0 rejected, the final file is exactly one whole payload, no temp left | — |
| `0600` target: temp mode before `fchmod` | **`644`; an early fd reads the new content** (F1) | n/a (in place) |

**Write paths (item 1).**
- `rg` for `Bun.write|writeFile|open(` in `packages/{tools,exec,agent,daemon}/src`: `fs_write`, `fs_edit` and `fs_multi_edit` (`packages/tools/src/builtins.ts:128,201,249`) and the tool-output fallback (`packages/agent/src/agent.ts:1906`) all go through `ExecutionEnvironment.writeFile`. The only implementation is `HostExecution.writeFile`.
- The other writes on that list are laptop-side stores, outside this task: `tool-output.ts`, `session-store.ts`, `session-tombstones.ts`.

#### Mutations

Each mutation: backup, then Edit, then `bun test packages/exec/test/confinement.test.ts`, then restore. `git status --porcelain` was empty after each.

| # | Mutation | Result |
|---|---|---|
| 1 | the `finally` never unlinks the temp | **killed**: "a failing write leaves no temp file behind" (`confinement.test.ts:497`) |
| 2 | `rename` replaced by an in-place `Bun.write(target)` | **killed**: 3 fail, incl. the R2-4 in-root hard link (`:473`) |

No test pins F1, F2 or F3. They are the gaps: the suite tests the boundary, not file-permission semantics.

#### Docs vs code (item 5)

- **What matches the code:**
  - CHANGELOG "Fixed": atomic replace, mode kept, the hard link loses only this name, a symlink/FIFO at the path refused, "detected in most cases";
  - the "Known limit" paragraph (content in a new hidden `.tentacle-tmp` file, an existing file never written in place, a same-uid process and `shell` not covered);
  - the README `tools.writableDirs` row;
  - the `writeFile` doc comment (`:351-367`), which names the residual;
  - fix round 3's citations (`:369`, `:380`, `:449`, `:467`, test `:452`), all verified.
- **What is missing:** F1, F2 and F5.
- **Nit:** "its mode bits are kept" should say "permission bits" (setuid/setgid/sticky are dropped, `:438`).
- **Stale but superseded:** fix round 2's line numbers.

#### Gate (on the restored tree)

- `bunx tsc --noEmit`: clean.
- `bunx biome check .`: 710 files, no fixes.
- `bun test packages`: **5295 pass, 3 skip (opt-in), 0 fail** (5298 tests, 363 files). This matches fix round 3's count.

#### What holds

- No confined write goes through an existing inode.
- Temps are cleaned on every failure except F4.
- No leftovers in normal or concurrent use. Last write wins, with no torn content.
- In-root symlinks and hard links behave as documented.
- Ordinary project edits match `main`: big files, `0775` dirs, git-tracked modes.
- The round-2 race tests still pass without the ownership rule.

#### How the executor behaved

- Fix round 3 did exactly what the owner asked: three tests removed, one red→green test added. It measured the residual with a real concurrent attacker and reported it honestly, including the "not excluded" three-flip case, instead of claiming it closed.
- The blind spot: it attacked the new write only as a *confinement* boundary. It never checked which ordinary file-permission semantics the in-place write had and the rename drops: the temp's open mode, read-only targets, directory write permission, name length.
