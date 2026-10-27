# feat/docker-workspace-mount — `run --engine docker|podman` mounts the laptop cwd as the workspace (docker-runtime slice D)

> **Status:** executed 2026-10-27 (owner answers M1–M7 applied); awaiting the mandatory fresh-context Review.
> **Branch:** `feat/docker-workspace-mount`, off `main` @ `89127d2` (slices B and C merged).
> **Type:** feat · **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes; **mandatory fresh-context Review** red-teaming AGENTS §7 "Compute next to the code, identity with the user; a pod is not trusted" and "Model stays on the laptop" (a bind mount is the first thing the laptop ever *gives* a container — a wrong source path leaks the laptop's identity into an untrusted workload), plus "Pod lifecycle" (`--keep`, `attach` never creates).

## Context

*— claude-opus-5-5, 2026-10-27*

Slice D of `docs/eval/docker-runtime.md`. Owner answer 2 (2026-10-26,
`docker-runtime.md:363-365`): *"bind-mount the cwd read-write at the same
absolute path on a local engine, `--no-mount` to opt out; never on a remote
engine"*. Owner decision C-Q2 (2026-10-27, `docker-engine-cli.md:304`): the cwd
IS mounted, in this own slice, today, right after C.

Why it matters (`docker-runtime.md:239-249`): k8s has no access to laptop files
(workspace = the image / a clone, `docs/architecture/F4-pod-execution.md:196-200`).
A local Docker/Podman engine can give the agent the user's real files with
isolated processes, packages and network — the "sandboxed local TUI". The same
mount is also the first time the laptop hands an untrusted workload (AGENTS §7)
anything of its own: write access to a laptop directory.

**Parity premise corrected.** k8s `run` does **not** copy the workspace into the
pod today: there is no upload/sync code (`rg -n -i "git clone|workingDir|initContainer" packages/k8s/src packages/cli/src`
→ only `packages-cmd.ts:202`, unrelated). The pod daemon's cwd is the image's
`WORKDIR` (the exec sets none). So "fall back to the k8s-style copy" for a
remote engine has nothing to fall back to; a copy/sync would be new work (Q3).

Constraints (binding): one session path — the mount is container-create input
and an exec working dir, nothing in the runtime/protocol; the container stays
untrusted (every laptop effect still gated by the single broker); provider
creds never reach the container; `attach` never creates/deletes/reconfigures.

**Repro** (static, 2026-10-27, `main` @ `6d503be`; `bun` needs approval in this
session — the executor re-runs it on C's tip):

```
$ rg -n "Binds|Mounts|WorkingDir" packages/cli/src/engine-docker.ts
(no output — containerBody has no binds and no working dir)
$ sed -n 55,61p packages/cli/src/engine-docker.ts
export function containerBody(image: string): ContainerCreateBody {
  return {
    Image: image,
    Cmd: ["sleep", "infinity"],
    HostConfig: { Privileged: false },
  };
}
```

Executor's live repro (after C lands): `cd <a repo>; tentacle run --engine
docker --image debian:stable-slim`, then ask the agent `pwd; ls` → expected
today: `/` (image WORKDIR) and the image's rootfs, not the repo.

## Implementation

*— claude-opus-5-5, 2026-10-27*

### Load-bearing assumption

**The daemon's workspace is exactly the exec's working directory: setting the
Docker exec `WorkingDir` to the mount target makes every session confined to
the mounted folder, with no runtime, daemon or protocol change.**

Proof:
- `serve` gives `SessionHost` `defaultCwd: config.cwd` (`packages/cli/src/serve.ts:162`, `:433`);
  `config.cwd` = `defaultCwd` = the launch cwd (`packages/config/src/resolve.ts:283`,
  `load.ts:493`; re-verified 89127d2), i.e. the `serve --stdio` process's cwd = the exec's working dir.
- A client-requested `cwd` is NOT honoured: every session runs against
  `defaultCwd` (`packages/daemon/src/session-host.ts:5-7`, `:754`; re-verified 89127d2). So the
  laptop's `cwd: config.cwd` passed to `createLocalRuntime`
  (`engine-runtime.ts:331`, `:564` — re-verified 89127d2, C renamed `pod-runtime.ts`) is metadata (the laptop's saved record,
  `local-runtime.ts:350`), not confinement — it matches the daemon's only
  because the target path is the same absolute path.
- The Docker exec already supports it: `DockerExecTarget.workingDir` / `user`
  (`packages/docker/src/types.ts:38-45`) → `WorkingDir` / `User` in the exec
  create body (`exec-channel.ts:130-131`). The `EngineHost` exec target has
  neither (`engine-host.ts:19-25`), and `dockerEngineHost.openExec` passes only
  `{container, command}` (`engine-docker.ts:194-200`) (all re-verified 89127d2).

### Preconditions

- **Create body is a passthrough**: `ContainerCreateBody = {Image, [k]: unknown}`
  (`types.ts:31-35`); `createContainer` adds only the owner label
  (`client.ts:232-257`). `HostConfig.Mounts`/`Binds`, `SecurityOpt`,
  `Labels` need no client change.
- **One create call site**: `host.create(name, deps.image)` (`engine-runtime.ts:241`,
  re-verified 89127d2). Both exec targets are built in the
  runtime (`:306-310` run, `:539-543` attach) and go through `host.openExec` /
  `execChannelFactory` — so exec defaults kept **inside the host** reach the
  first dial AND every reconnect.
- **Binary injection is a separate `runExec`** to `/usr/local/bin` (or
  `--bin-dir`) (`engine-runtime.ts:215`, `:445`; re-verified 89127d2), run as the image's user
  (root for typical images). It must stay root → the uid mapping (Q4) applies
  to the **daemon exec only**, never to the container or the injection.
- **Endpoint locality is already typed**: `EngineEndpoint.local` is `true` only
  for `unix` and `false` for `tcp`/`ssh` (`engine-endpoint.ts:24-41`); C's podman
  discovery yields `local:true` (re-verified 89127d2). `buildEngineHost` did not
  return the endpoint (`engine-select.ts:246`) — D adds it to `BuiltEngineHost`.
- **`attach` can read what `run` wrote**: `inspectContainer` returns
  `Config.Labels` (`types.ts:19`); `dockerEngineHost.inspect` already calls it
  (`engine-docker.ts:128-159`; re-verified 89127d2). `createContainer` merges
  caller `Labels` with the owner label (`client.ts:238-241`).
- **The laptop TUI does not read workspace files in `run`** (`rg -l "readdir|readFileSync|Bun.file" packages/tui/src` → none), so a symlink the container plants in the mount is never followed by laptop code in this mode. *Laptop config loader* (verified 89127d2): `load.ts:461` reads `AGENTS.md` from the launch cwd before the container exists, and `engine-runtime.ts`/`main.ts` never send it to the container (`git grep -i agents.md` → only the HELP line). A container CAN rewrite the repo's `AGENTS.md`, which a later local `tentacle` would load — inherent to rw, see the last failure mode.
- **Removal never touches the bind source**: `removeContainer` sends `?force=true&v=true` (`client.ts:321`); `v` removes anonymous volumes only — binds and tmpfs are not volumes.
- **Engine facts not on the client yet**: `DockerClient` has `ping`/`version`
  but no `info()` (`client.ts:177-198`). Rootless / SELinux / Docker Desktop
  detection needs `GET /info` (`SecurityOptions` contains `name=rootless`,
  `name=selinux`; `OperatingSystem` = `Docker Desktop`; podman's compat `/info`
  reports the same `SecurityOptions` — **to verify live** on Docker Desktop and
  podman machine in Execution, pasted).
- **Engine-specific flag validation lives in C's `engineFlagProblem`**
  (`engine-select.ts:65-90`, re-verified 89127d2) — `--no-mount` joins it.
- **`--keep` defaults to TRUE** (C, `engine-select.ts:96-108`): a startup
  failure normally keeps the container (`removeUnlessKept`, `engine-runtime.ts:252-258`)
  — so a failed mask probe must remove it in the host, not via the runtime.

### Design — owner decisions applied (owner 2026-10-27)

These override the sections below where they disagree:
- **M1** mount ONLY `realpath(cwd)` at the logical cwd — never the git root (Q1's
  recommendation dropped).
- **M2** SELinux → `SecurityOpt: ["label=disable"]`, never `:z`.
- **M3** remote engine → no mount + a `[container] warning: …` line before the
  runtime; copy/sync = future work (TODO).
- **M4** daemon exec `User = uid:gid` only on rootful **Docker** on **Linux**
  (not Desktop, not rootless, not podman, not laptop root); no `--userns=keep-id`.
- **M5** dangerous sources are NOT refused: `/`, `$HOME` and its ancestors, the
  tentacle config dir (and inside it), `~/.ssh` (and inside it — added: same
  class as the config dir), exact system dirs → the owner's y/N prompt BEFORE
  Ink (default No); no TTY → the owner's refusal unless `--confirm-mount`.
  A target that contains the injection dir (`/`, `/usr`, `/usr/local[/bin]`,
  `--bin-dir` inside the cwd) is still **refused** — a clash, not taste: the
  binary would be written into the laptop folder (and Docker rejects `/` as a
  mount target anyway).
- **M5b** `~/.ssh` (only when it exists) and the REAL config dir
  (`config.configDir`, `TENTACLE_CONFIG_DIR` included), realpath-resolved,
  strictly inside the source → an empty read-only tmpfs at their container
  path. The post-start probe (§5) also asserts every mask is an empty dir; a
  miss → the host removes the container (even with `--keep`) and throws
  `WorkloadRemovedError`, so the runtime never logs it as kept.
- **M6** no read-only mode. **M7** `attach` from another cwd → the owner's
  warning (`notify` + a piped log line); attach proceeds.
- **Labels for slice E**: every `run` container gets `tentacle.workspace`
  (target), `tentacle.workspace-source` (realpath), `tentacle.workspace-masked`
  (JSON array of container paths), `tentacle.workspace-user` (`uid:gid`) —
  empty strings without a mount; and `EngineHost.create(name, image, { workspace?, labels? })`
  carries a generic `labels` map (docker: merged into `Labels`, ours win;
  k8s: `buildPodManifest({labels})`).
- `attach` honours the workspace labels only on a container with tentacle's
  owner label (`tentacle.managed=true`).

### Design

**1. Pure planner — `packages/cli/src/workspace-mount.ts` (new, React/IO-free).**
`planWorkspace(input) → { kind: "mount", source, target, readOnly, user?, securityOpt? } | { kind: "none", notice? } | { kind: "refuse", message }`
with input `{ engine, endpointLocal, noMount, cwd, realCwd, home, configDir, binDir, engineInfo: { rootless, selinux, desktop }, laptopUid, laptopGid, platform }`.
- `kubernetes` → `none` (never mounts; C rejects `--no-mount` there).
- `noMount` → `none`.
- remote endpoint (`local:false`) → per **Q3** (recommend `none` + a one-line notice).
- **Guards (refuse, actionable, before anything is created)** — per **Q5**:
  - source is `/`, or `$HOME` or an ancestor of it;
  - source contains `configDir` (provider keys / tokens — AGENTS §7 "Model
    stays on the laptop": a mount must never carry creds into the container);
    this one is an invariant, not taste;
  - target equals or is an ancestor of the injection dir (`/usr/local/bin` /
    `--bin-dir`: the binary would be written into the user's folder) or a
    container system path (`/bin /sbin /lib* /usr /etc /proc /sys /dev /run /var /tmp`, exact);
  - path not absolute / contains a NUL (defensive).
- **Source = `realpath(cwd)`, target = `cwd`** (logical, what the user and the
  laptop's session record see — "same absolute path", `docker-runtime.md:243`).
  macOS `/var` → `/private/var` style symlinks resolve on the source only.
- **Symlinks escaping the cwd** need no code: a bind mount exposes the
  directory, and a symlink inside resolves in the *container's* namespace (an
  `../../etc/passwd` link reaches the container's `/etc`, not the laptop's).
  Hard links cannot cross the mount. Pinned by a live check only (Tests).
- **Read-write** (owner answer 2, decided). Read-only variant → **Q6**.
- **uid/gid** → **Q4**. Recommended matrix (`user` = the daemon exec's `User`):
  Docker Desktop (macOS/Win, file-sharing maps ownership) → none (root);
  rootless Docker / rootless Podman / podman machine (container root = the
  user) → none, **no `--userns=keep-id`** (it would make the default user
  non-root and break injection to `/usr/local/bin`); **Linux rootful Docker**
  → `user: "<uid>:<gid>"` so files the agent creates are the user's (root
  would also trip git's "dubious ownership" on the user's repo).
- **SELinux** (`engineInfo.selinux`, Linux only) → **Q2**; recommend
  `securityOpt: ["label=disable"]` for this container (toolbox/distrobox
  precedent) over `:z` (persistently relabels the user's files on the host).

**2. Container body — `engine-docker.ts`.** `containerBody(image, ws?)`:
when `ws.kind === "mount"`, add
`HostConfig.Mounts: [{ Type: "bind", Source, Target, ReadOnly }]` (the
structured API, not the `Binds` string: a path containing `:` or `,` can't be
mis-split) + `SecurityOpt` when set, and label
`tentacle.workspace=<target>` (+ `tentacle.workspace-user=<uid:gid>` when
set). Still no socket mount, not privileged, no other source — tested. The
mount arrives in the JSON body over the engine socket: **never argv, never env**
(the exit-net child gets only the endpoint + name, `container-cleanup.ts`,
unchanged).

**3. Host carries the exec defaults — `engine-host.ts` + `engine-docker.ts`.**
`EngineHost.create(name, image, options?: { workspace?: WorkspacePlan })`
(k8s host: a non-`none` workspace throws — backstop, like `noSubContainer`).
The docker host keeps `execDefaults: Map<name, {workingDir, user?}>`, filled
by `create` (from the plan) and by `inspect` (from the labels — so `attach`
to a `--keep`/`run`-made container lands in its workspace with its user) and
applied in `openExec` / `runExec`-for-daemon. **No change to
`EngineExecTarget`** — the runtime stays engine-neutral; the injection
`runExec` gets no `User`.

**4. Engine facts — `packages/docker/src/client.ts` + `types.ts`.**
`info(): Promise<EngineInfo>` (`GET /info`, the fields above only). Called by
`buildEngineHost` (C) only when a mount is planned; failure → treat as
unknown (rootful, no SELinux) **and** surface the probe error as a status line.

**5. Post-start sanity probe (runtime-neutral, in the docker host's
`waitForReady`).** After start, one `runExec` `test -d <target> && test -w <target>`
plus `test -e <target>/<first laptop entry>` (skipped for an empty dir). A
miss → actionable error *before* the daemon starts (the container is removed
by the existing catch): catches Docker Desktop "not shared" variants that
mount an empty dir, a colima read-only `$HOME`, a podman machine without that
path.

**6. CLI — `flags.ts`, C's `engine-select.ts`, `main.ts`, runtime.**
`--no-mount` on `run` only; `engineFlagProblem`: `--no-mount` with
`kubernetes` → usage error; on `attach` it is not in `ARGS.attach` (strict args
reject it). `main.ts`: `planWorkspace` after `buildEngineHost`, refuse →
`[container] failed: …`, exit 1, nothing created. The runtime passes the plan
to `host.create` and shows it in the create phase line:
`[container] creating X (image …) in … — workspace /Users/me/repo (rw)`.
**`--keep`**: unchanged semantics; the kept container keeps its mount, and the
resume hint names it: `tentacle attach --engine docker X  # workspace /Users/me/repo`.
`attach` from a different laptop cwd than the label → a one-line notice
(not an error, Q7).

**7. Docs.** README "Ways to run" (mount, `--no-mount`, ownership notes),
`F4-pod-execution.md` workspace paragraph (Docker local = mount), HELP text,
`TODO.md`.

### Files

Dependency order (paths after C's renames):
1. `packages/docker/src/types.ts`, `client.ts` (`info()`), `index.ts`
2. `packages/cli/src/workspace-mount.ts` (new, pure)
3. `packages/cli/src/engine-host.ts` (`create` options), `engine-docker.ts` (body, exec defaults, labels, probe, error translation), `engine-k8s.ts` (backstop only)
4. `packages/cli/src/engine-runtime.ts` (pass plan; phase/`--keep` lines), `engine-select.ts` (`--no-mount` rule, `info()` call), `flags.ts`, `main.ts`
5. tests: `packages/docker/test/client.test.ts` (`info`), `packages/cli/test/workspace-mount.test.ts` (new), `engine-docker.test.ts`, `engine-runtime.test.ts` (k8s oracle unchanged + one docker case), `engine-select.test.ts`, `args.test.ts`
6. docs: `README.md`, `docs/architecture/F4-pod-execution.md`, `TODO.md`, this doc.

Not touched: protocol, daemon, persistence, TUI, `wiring.ts`.

### Failure modes

| Mode | Where | Converges to |
|---|---|---|
| cwd is `/`, `$HOME` or its ancestor | planner | refuse: *"refusing to mount /Users/me (your home) into the container — cd into a project, or use --no-mount"*, exit 1, nothing created. |
| cwd contains the tentacle config dir | planner | refuse (invariant: creds never in the container), same shape. |
| cwd = / ancestor of the injection dir or a system path | planner | refuse naming the clash (and `--bin-dir`). |
| Remote endpoint (`tcp://`, `ssh://`) | planner | per Q3 — recommended: no mount + notice *"remote engine: the laptop folder is not mounted; the workspace is the image's"*. Never a silent empty mount. |
| Docker Desktop path not shared (`Mounts denied …`) | `createContainer` 4xx/5xx | translated: *"Docker Desktop does not share /opt/x — add it in Settings → Resources → File sharing, or use --no-mount"*. |
| Mount succeeds but is empty / read-only (colima, podman machine) | probe (§5) | actionable error before the daemon starts; container removed (existing catch). |
| `info()` fails | `buildEngineHost` | treated as rootful/no-SELinux, a status line says so; the probe still catches an unusable mount. |
| SELinux enforcing, no option | probe (`test -w` fails) | per Q2 the option is set up front; else the probe names `label=disable`/`:z`. |
| Linux rootful, root exec | — | designed out (Q4 `User`); git "dubious ownership" otherwise. |
| uid has no passwd entry in the image | daemon exec | `HOME` unset/`/` → tools needing `$HOME` fail; **exec `Env: HOME=<target>`?** — no: writes dotfiles into the repo. Recommend `HOME=/tmp` via exec `Env` (needs `env` on `DockerExecTarget`; noted, small). |
| Path with `:`/`,` | body | `Mounts` (structured) — no split bug; test pins it. |
| `--keep` then `attach` from another cwd | `inspect` labels | attach lands in the labelled workspace; notice names it. |
| `attach` to a user-made container without labels | `inspect` | no exec defaults → image WORKDIR (today's behaviour). |
| `--no-mount` on `kubernetes` / on `attach` | C's `engineFlagProblem` / strict args | usage error, exit 1. |
| Ctrl+C mid-create | existing exit net | container removed; the bind source is never touched by removal (bind mounts are not volumes; `removeContainer` sends no `v=1` for binds — executor confirms `client.ts:300`). |
| Malicious image writes the repo (`.git/hooks`, `.envrc`, `package.json` scripts) | — | inherent to rw (= the local TUI's power, now granted to the image's code too): documented in README; Q6 offers ro. |

### Tests

Red first per slice (paste the red line); mutations restored from a `cp`
backup with matching `shasum`.
- `workspace-mount.test.ts` (pure): every guard (`/`, `$HOME`, ancestor of
  home, contains `configDir`, ancestor of `binDir`, each system path);
  remote → `none`+notice; kubernetes → `none`; source = realpath, target =
  logical cwd; uid matrix (Desktop / rootless / podman / rootful); SELinux →
  `label=disable`. Mutation: drop the `configDir` guard → red.
- `engine-docker.test.ts`: `containerBody` with a plan has exactly one
  `Mounts` entry, `Type:"bind"`, no `Binds`, no socket path, `Privileged:false`,
  the labels; without a plan it is byte-identical to today. `openExec` after
  `create` carries `WorkingDir` (+ `User` on rootful) on the first dial AND a
  redial; the injection `runExec` carries no `User`; `inspect` of a labelled
  container sets the defaults for `attach`. "Mounts denied" translation. Probe
  failure → actionable reject. Mutation: put `User` on the injection → red.
- `engine-runtime.test.ts`: the k8s oracle stays byte-identical; one docker
  case asserts the plan reaches `create` and the phase line shows the workspace.
- `engine-select.test.ts` / `args.test.ts`: `--no-mount` + kubernetes → usage
  error; `attach --no-mount` → unknown flag.
- `client.test.ts`: `info()` parses `SecurityOptions`/`OperatingSystem` (fake socket).
- Live, opt-in (`TENTACLE_DOCKER_TESTS=1`, pasted in Execution): Docker Desktop
  and podman machine — `pwd` = cwd, a file created in the container is owned
  by the laptop user (`ls -l` on the laptop), a `ln -s ../../../etc/passwd x`
  inside reads the container's file. Linux rootful/SELinux: not available on
  this laptop — stated as unverified.
- Gate: `bun run check` against C's final baseline.

### Owner questions (with recommendation) — execution waits for these

1. **Mount the cwd, or the git root?** Mounting only the cwd breaks git when
   the cwd is a subdirectory of a repo, and always for a git **worktree**
   (`.git` is a file pointing to an absolute path outside the cwd — e.g. every
   `.tentacle/worktrees/*`). → **Recommend: mount the git top-level** (and, for
   a worktree, also the common `.git` dir, read-write) with the working dir =
   the cwd; plain cwd when not in a repo. Guards apply to every source.
2. **SELinux hosts:** `label=disable` for the container (no host change, less
   confinement), `:z` (relabels the user's files on the host, persistently;
   slow on big trees), or nothing (mount unusable). → **Recommend
   `label=disable`**, only when the engine reports SELinux.
3. **Remote engine (`tcp://`, `ssh://`):** refuse unless `--no-mount`, or run
   without a mount + a visible notice, or build a copy/sync (none exists for
   k8s either). → **Recommend: no mount + one-line notice** (owner answer 2
   already says "never on a remote engine"; requiring `--no-mount` every time
   is friction); copy/sync = a separate eval.
4. **uid/gid:** the matrix above (daemon exec as the laptop uid:gid only on
   Linux rootful Docker; root elsewhere; never `keep-id`), or always run as
   the laptop uid (then apt/npm-global break in the container). → **Recommend
   the matrix**, with `HOME=/tmp` for the mapped uid.
5. **Guard strictness:** refuse `/`, `$HOME` and its ancestors (+ the
   always-on config-dir and system-path guards), with **no override flag**
   (the user can `cd` into a project or pass `--no-mount`) — or allow an
   escape hatch (`--mount-anyway`). → **Recommend refuse, no override.**
6. **A read-only mode** (`--mount ro`, "review without edits") now? → **Recommend
   not now** (owner chose rw; `--no-mount` covers "don't touch my files"); add
   when asked.
7. **`attach` from a different cwd** than the kept container's workspace:
   notice and continue in the container's workspace, or refuse? →
   **Recommend notice and continue** (the container's mount is fixed; refusing
   would only force a `cd`).

## Execution

*— claude-opus-5-5, 2026-10-27*

**Baseline** (`89127d2`, before any edit): `bun run check` → typecheck clean,
`biome check .` 545 files clean, `bun test` **3270 pass / 3 skip / 0 fail**.

**Repro** (static, `89127d2`): `rg "Mounts|Binds|WorkingDir|workingDir|no-mount" packages/cli/src`
→ no match: no mount, no exec working dir, no flag — the capability is missing.

**Step 0.** Every `file:line` premise re-checked on `89127d2` and fixed in place
("re-verified 89127d2"): C renamed `pod-runtime.ts` → `engine-runtime.ts`
(create `:241`, exec targets `:306`/`:539`, bin path `:215`/`:445`, cwd metadata
`:331`/`:564`); `resolve.ts:283`, `load.ts:493`. New facts that changed the
design: `--keep` defaults to true (a failed probe must be removed by the host),
`buildEngineHost` did not expose the endpoint, `removeContainer` sends `v=true`
(anonymous volumes only — binds safe). Owner decisions folded into the
Implementation ("Design — owner decisions applied").

**As built, in order** (each slice red first):
1. `packages/docker/src/client.ts` — `EngineInfo` + `info()` (`GET /info`).
   Red: `docker.info is not a function` (2 fail; a new method has no assertion-red), green 19/19.
2. `packages/cli/src/workspace-mount.ts` (new, pure): `planWorkspace`,
   `mountGate`/`isYes` (owner's exact wording), `engineFacts`,
   `workspaceEngineOptions`, `workspaceMounts` (structured `Mounts`: bind rw +
   tmpfs ro per mask), `workspaceLabels`/`WORKSPACE_LABELS`,
   `workspaceProbeCommand` (paths as positional args) / `workspaceProbeProblem`,
   `attachCwdWarning`. Red against an export-only stub: **31 fail / 5 pass on
   assertions**; green 40/40 (one test added later: a missing `~/.ssh`).
3. `engine-host.ts` — `EngineCreateOptions {workspace?, labels?}`,
   `WorkloadRemovedError`, `workspace?` on `ready`/`starting`. `engine-k8s.ts` —
   a workspace throws (backstop); `labels` → `buildPodManifest({labels})`.
   `engine-docker.ts` — `containerBody(image, {workspace, user, securityOpt, labels})`;
   `create` calls `info()` only with a workspace (failure → no user, no
   SecurityOpt), translates "Mounts denied"; per-container `execDefaults`
   (from `create`, or from `inspect` labels of a `tentacle.managed` container)
   applied ONLY in `openExec` (every dial/redial) — `runExec` (probe, injection,
   verify) stays root, no working dir; `waitForReady` runs the probe on a
   container this host created and, on a problem, removes it and throws
   `WorkloadRemovedError`. `engine-runtime.ts` — passes `{workspace, labels}`,
   phase line `… — workspace <target> (rw)…`, kept line `…  # workspace <target>`,
   `removeUnlessKept(error)` skips a `WorkloadRemovedError`; `attach` emits the
   M7 warning. Red: **11 fail** in `engine-docker.test.ts`; green 32/32; all
   `engine*` tests 105/105.
4. CLI — `flags.ts` (`--no-mount`, `--confirm-mount` on `run` only; usage),
   `engine-select.ts` (`engineFlagProblem` rejects both on kubernetes;
   `BuiltEngineHost.endpoint`; `laptopWorkspaceInput` = the IO: realpaths,
   `~/.ssh` only if it exists, `readdir`), `main.ts` (plan → refuse /
   remote warning → gate → `askLine` (readline; Ctrl+C/EOF = No) BEFORE the
   runtime and Ink; `CliIO.ask` seam). Red: **9 fail** in `main.test.ts`
   "workspace mount wiring"; green 31/31.
5. Docs: HELP + usage, README "Your folder, in the container", F4 workspace
   paragraph, `TODO.md` (D executed; remote copy/sync follow-up, M3).

**Mutations** (backup by `cp` to `.tentacle/tmp/docker-workspace-mount/`, restored
by `cp`, `shasum` identical after each):
| Mutation | Result |
|---|---|
| config dir dropped from the masks | 6 fail (planner, mounts, probe, `main` mask test) |
| dangerous source never confirmed (`mountGate` always proceeds) | 5 fail (exact prompt/refusal, `main` no-TTY refuse + TTY ask) |
| daemon `User` also on `runExec` (the injection) | 1 fail (rootful run: one-shot execs carry no user) |
| failed probe does not remove the container | 2 fail (visible mask, empty mount) |
| `attach` trusts labels of a non-tentacle container | 1 fail |

**Drift from the Implementation (and why):**
- M5 (owner) replaces the plan's refuse-guards with a y/N gate; the
  injection-dir clash (`/`, `/usr`, `/usr/local[/bin]`, `--bin-dir` inside the
  cwd) stays a refusal — the binary would be written into the laptop folder.
  So `/` is in fact refused (also unmountable as a Docker target), not asked.
- `~/.ssh` (and inside it) added to the dangerous kinds — same class as the
  config dir; and masked only when it exists (a tmpfs on a missing path makes
  the engine create the directory in the laptop folder).
- `info()` failure → no user mapping (not "assume rootful"): mapping a uid on
  an unknown, possibly rootless engine is the worse guess; no status line (the
  host has no log channel) — the probe still catches an unusable mount.
- Labels: written on EVERY docker `run` container (empty strings without a
  mount) per the executor brief, plus `tentacle.workspace-source` per E's doc;
  `masked` is a JSON array (paths may contain `,`).
- The probe lives in the docker host's `waitForReady` (as planned) but removes
  the container itself (`--keep` is now default true).
- Not done: `HOME=/tmp` for the mapped uid (needs `env` on `DockerExecTarget`;
  owner decisions do not mention it) — open item. The "first laptop entry"
  probe skips masked entries.

**Gate (final):** `bun run check` → typecheck clean, `biome check .` 547 files
clean (0 errors/warnings, baseline clean), `bun test` **3332 pass / 3 skip / 0 fail**
(baseline 3270/3/0; +62 new tests; the 3 skips are the opt-in live ones).

**Unverified (no live engine run here):** Docker Desktop / podman machine /
rootful-Linux / SELinux behaviour — that `/info` reports `name=rootless` /
`name=selinux` on podman's compat API, that `ReadOnly: true` is honoured for a
`tmpfs` mount on both engines (the probe checks emptiness, not read-only-ness),
the exact "Mounts denied" wording, `pwd`/ownership in the container. Verify with
`TENTACLE_DOCKER_TESTS=1` + a manual `tentacle run --engine docker --image debian:stable-slim`
from a repo and from `$HOME` (expect the y/N prompt, then `ls -A ~/.ssh` empty in the container).

## Review

*— claude-opus-5-5, 2026-10-27* (fresh context; **same model as the executor** — shared blind spots survive both passes. AGENTS §10 wants a different model for a load-bearing task; owner, consider a second pass.)

**Verdict: APPROVE-WITH-NITS** — mergeable once the owner settles F1 (and, ideally, F2 is fixed: small). No finding breaks a §7 invariant the owner has not explicitly allowed.

**Gate (re-run, uncommitted tree):** `bun run check` → typecheck clean, `biome check .` 547 files clean, `bun test` **3332 pass / 3 skip / 0 fail** (3335 tests, 254 files; the 3 opt-in skips). Matches Execution.

**Findings**
1. **[medium · owner decision] A source that IS (or is inside) the config dir or `~/.ssh` is mounted unmasked after a "y".** `workspace-mount.ts:161-162` masks only paths *strictly* inside the source (`isInside`); `dangerOf` (`:122-127`) turns `cwd ∈ configDir` / `cwd ∈ ~/.ssh` into a y/N, and `--confirm-mount` skips it. A tmpfs cannot mask the mount root, so `cd ~/.config/tentacle && tentacle run --engine docker --confirm-mount …` gives the container `config.json` (a file `apiKey`) — the one thing AGENTS §7 "Model stays on the laptop" forbids. M5 lists the config dir as confirmable, M5b as always masked: they contradict exactly here. **Recommend: refuse** `source ⊆ configDir` (an invariant, like the bin-dir clash) and `source ⊆ ~/.ssh`; keep the y/N for `/`-ancestors, `$HOME`, system dirs.
2. **[low-medium] A probe that *throws* is not "stop and delete".** `engine-docker.ts:238-242`: `client.runExec` rejects on timeout/connection error (`exec-run.ts:81-99`), which escapes `waitForReady` as a plain `Error` → `removeUnlessKept` (`engine-runtime.ts:266`) **keeps** the container under the default `--keep`, with unverified masks. And `removeContainer(...).catch(() => {})` (`:245`) swallows a failed delete while the thrown message says "the container was removed". Masks are engine-enforced from create, so this is a sanity-check gap, not a leak. Fix: wrap the probe in try/catch → remove → `WorkloadRemovedError`; on a failed remove, say so (and print the `rm` command).
3. **[low] Label text reaches the terminal raw.** `engine-runtime.ts:440-445` logs `attachCwdWarning(state.workspace, …)`; `state.workspace` is the `tentacle.workspace` label of any container carrying a (forgeable) `tentacle.managed=true` (`engine-docker.ts:108-117`). Escape sequences in a forged label are written as-is; errors elsewhere go through `untrustedText` (`main.ts:732`). Fix: `untrustedText` the label.
4. **[info] Secrets outside the two masks are visible when cwd ⊇ `$HOME`** (after the y/N): the `apiKeyCommand` key file (the default config's own example is `~/.cache/anthropic-key`, `defaults.ts:102`), `~/.aws`, `~/.kube`, `~/.docker/config.json`. The owner wording "everything in it except ~/.ssh and tentacle's config" can read as "the model key is safe". And a missing `~/.ssh` is not masked, so the agent can create `~/.ssh/authorized_keys` on the laptop (rw home is what the user confirmed). Debt, owner call. Masking the key file itself would mean parsing the `apiKeyCommand`, which is not reliable.
5. **[nit]** The `run` line in HELP (`main.ts:84`) lists `--no-mount` but not `--confirm-mount`. `USAGE.run` lists both.

**Owner decision pending (drift): refuse `/`, `/usr`, `/usr/local[/bin]`.** Recommend **accept** the refusal: it is a clash, not a matter of taste. Docker rejects `/` as a target, a target `/usr` hides the container's userland, and the binary would be written into the laptop folder. `--bin-dir` elsewhere unblocks `/usr` (`workspace-mount.ts:154-159`).

**Premise table**
| Premise | Verdict |
|---|---|
| Symptom: no mount / working dir / flag on `89127d2` | TRUE (Execution's `rg`; the diff adds all three) |
| Every session uses the daemon `defaultCwd` (`session-host.ts:7`, `:754`) | TRUE |
| Exec `User`/`WorkingDir` passthrough (`exec-channel.ts:130-131`) | TRUE |
| `createContainer` owner label wins over caller labels (`client.ts:257-260`) | TRUE |
| Removal `force=true&v=true`, owner-label guarded (`client.ts:333-340`) | TRUE: bind sources are untouched |
| configDir = flag > `TENTACLE_CONFIG_DIR` > `XDG_CONFIG_HOME` > `~/.config/tentacle` (`load.ts:361-371`); main passes `config.configDir` (`main.ts:679`) | TRUE |

**Attacks tried**
- *Case-insensitive macOS + firmlinks* (repro in `.tentacle/tmp/dwm-review/realpath.test.ts`). Bun `realpathSync` maps `/users/gmeghnag`, `/USERS/GMEGHNAG/.ssh` and `/System/Volumes/Data/Users/gmeghnag` to `/Users/gmeghnag…`. With cwd in each spelling: danger = home, both masks present (re-rooted under the logical target), and the non-TTY gate refuses. A lowercase `TENTACLE_CONFIG_DIR` is still masked. **No bypass.**
- *Symlinks in the cwd pointing to `~/.ssh` / the config dir*: they resolve in the container's namespace, where only the target exists, or land on the masked path. A symlinked config dir/`~/.ssh` is masked at its realpath (tested). **Holds.**
- *Mask on a path that does not exist yet*: `~/.ssh` is skipped when absent (by design: see F4). A missing config dir falls back to the raw path, and the engine creates an empty dir under a tmpfs. Harmless.
- *Probe integrity*: the probe runs in the untrusted container, so an image can fake `sh` and print `ok`. It is a UX check, not the boundary (AGENTS §7); the engine-enforced tmpfs is. The positional-arg script has no injection. Probe failure exit 6/7 → removed even with `--keep` (tested). The throw path is F2.
- *Remote engine*: `local` is true only for `unix` (`engine-endpoint.ts`). `ssh://`/`tcp://` → `none` + a `[container] warning:` before the runtime (tested). A unix socket forwarded from a remote host is indistinguishable: then the probe's `probeEntry` check fails unless the remote has the same path with the same first entry. Residual, accept.
- *Confirmation*: asked in `main.ts:686-702` before `startEngineRuntime`, so before Ink. Default No (`isYes`, Ctrl+C/EOF = ""). No TTY → refuse unless `--confirm-mount`. Wording matches M5/M5b verbatim. `--no-mount`/`--confirm-mount` are rejected on kubernetes and unknown on `attach`.
- *uid / SELinux / labels / argv*: `User` only for docker + linux + not rootless + not Desktop + uid≠0, daemon exec only (`openExec`), never `runExec`. `label=disable` only when `/info` says selinux. All four labels are on every docker `run` container. `attach` reads labels only with `tentacle.managed=true`. The mount travels only in the create body; the exit-net child is unchanged.

**Mutations** (backup `cp` → `.tentacle/tmp/dwm-review/`, restored, `shasum` identical: `797d3fd5…` `workspace-mount.ts`, `8b3fc19d…` `engine-docker.ts`). Applied together, each caught by its own tests: drop `sshDir` from the masks → 7 fail (masks, mounts, labels, probe args); a remote endpoint treated as local → 2 fail (planner M3, `main` remote wiring); drop `WorkingDir` from `openExec` → 3 fail (rootful run, redial, attach). 11 fail / 92 pass across the three files. The executor's own 5 mutations are plausible but were not re-run.

**What holds:** the pure-module split (all decisions in `workspace-mount.ts`, IO in `laptopWorkspaceInput`), one session path (no runtime/protocol change), the single broker, `attach` never creates, `WorkloadRemovedError` is never logged as kept, k8s backstop. **Unverified** (as Execution says): live Docker Desktop / podman / rootful-Linux / SELinux, `ReadOnly` honoured on tmpfs.

**Executor behaviour:** disciplined. Premises were re-verified on the real base, the drift was declared rather than hidden (the `/` refusal, the `~/.ssh` addition, `info()` failure → no mapping), the red counts were recorded, and the unverified live behaviour was stated plainly. Missed: the equal-path edge of M5/M5b (F1) and the throwing-probe path (F2).

> **Owner decisions (2026-10-27):**
> - M1: mount ONLY the cwd (realpath), never the git root.
> - M2: SELinux → `label=disable` for the container (never relabel the user files with `:z`).
> - M3: remote engine (`ssh://`, `tcp://`) → NO mount + a clear warning; copy/sync = future work (TODO).
> - M4: run as the laptop uid:gid ONLY on rootful Docker on Linux; Docker Desktop (macOS) and rootless podman need nothing; no `--userns=keep-id`.
> - M5: dangerous mount sources (`/`, `$HOME`, tentacle config dir, system dirs) are NOT refused: interactive y/N confirmation BEFORE Ink mounts (default No), wording: "⚠ You are about to mount <path> (<kind>) into the container. / The agent will be able to read everything in it: SSH keys, tokens, configs. / Continue? [y/N]". Non-interactive (no TTY): refuse unless `--confirm-mount`, message "Refusing to mount <path> (<kind>) without confirmation. / Run from your project directory, or pass --confirm-mount to proceed." (masking of the tentacle config dir / ~/.ssh: owner deciding.)
> - M5b: ALWAYS mask `~/.ssh` and the REAL tentacle config dir (custom path via env/flag included) when they lie inside the mount source: an empty READ-ONLY `tmpfs` mount overlaid at each (realpath-resolved, symlinks cannot bypass); applied only when the path is inside the source. Post-start sanity check also asserts the masked paths are empty inside the container, else stop and delete the container. The confirmation prompt says: "The agent will be able to read everything in it except ~/.ssh and tentacle's config, which stay hidden."
> - M6: no read-only mode now (read-write default); add later if needed.
> - M7: `attach` from a different cwd → WARNING ("This container mounts <orig>; you are in <cwd>."), attach proceeds.
> **All 7 questions answered (2026-10-27); plan approved with these decisions. Executes stacked on slice C.**

> **Owner decision D-1 (2026-10-27):** REFUSE (no confirmation possible) — with a message explaining why — when (a) the source is `/`, `/usr`, `/usr/local[/bin]` (tentacle injects its binary there: it would be written onto the laptop or break the container) and (b) the cwd IS or is INSIDE `~/.ssh` or the tentacle config dir (a mask cannot hide the mount root; the model key must never leave the laptop — AGENTS §7). Everything else, `$HOME` included, keeps the y/N confirmation.
> **Owner decision D-2 (2026-10-27):** the hide list is CONFIGURABLE: `mount.hide` (user config + profiles) REPLACES the default list; `mount.hideExtra` ADDS entries. Default list: `~/.ssh`, `~/.aws`, `~/.kube`, `~/.config/gcloud`, `~/.docker/config.json`, `~/.netrc`. The user MAY remove any default entry (their choice). ALWAYS hidden and NOT configurable: the REAL tentacle config dir and the file used by `apiKeyCommand` when the key lives in a file (AGENTS §7: the model key never leaves the laptop). The confirmation prompt lists what stays hidden. Masks apply only to paths inside the mount source; files (not only dirs) must be maskable.

### Execution — review fixes

*— claude-opus-5-5, 2026-10-27*

All four slices went red first (counts below), then green. Each mutation was
backed up with `cp` to `.tentacle/tmp/docker-workspace-mount/*.r2.bak` and restored
with `cp`; `shasum` matched each time (`workspace-mount.ts` `5e350d78…`,
`engine-docker.ts` `9b916cc9…`, `engine-runtime.ts` `385cbc9e…`).

1. **D-1 refusals** (`workspace-mount.ts` `planWorkspace`). Neither a confirmation
   nor `--confirm-mount` overrides them; the gate is never reached.
   - **Binary dirs.** Source in `BINARY_DIRS` = `/`, `/usr`, `/usr/local`,
     `/usr/local/bin`. The message says the binary would be written onto the laptop.
   - **Secret dirs.** Source at or inside the real config dir ("the model key
     must never leave the laptop"), or at or inside `~/.ssh`. The message says a
     mask cannot hide the mount root.
   - **Other paths.** The `--bin-dir`-inside-target clash stays a refusal. `/`
     is no longer asked about (its `dangerOf` branch is gone).
   - **Still asked (y/N).** `$HOME`, an ancestor of `$HOME`, a system dir, and
     (new) a source inside a hide-list dir.
   - **Tests.**
     - Each source has a test, including a symlinked cwd and `~/.ssh` dropped from the hide list.
     - `workspace-io.test.ts` (real fs) refuses a symlink to the config dir and to `~/.ssh`.
     - The same file has a **macOS case-variant** test, run here (`.CONFIG/TENTACLE`, `.SSH` → realpath → refused).
     - `main.test.ts`: the config dir as cwd is refused with `y` and with `--confirm-mount`, and nothing is asked. The y/N tests moved to `$HOME`.
2. **D-2 configurable hide list.**
   - **Config.**
     - `schema.ts` `mount: {hide?, hideExtra?}` (strict). An entry must start with `~/` or `/`.
     - `profile.ts` merges `mount` per key.
     - `resolve.ts`/`load.ts` expose `config.mount` and `config.apiKeyCommand`. Only the command is exposed, never the key.
     - The template gained a commented example.
     - Tests: `packages/config/test/mount.test.ts`. Red **5/5**.
   - **Pure module (`workspace-mount.ts`).**
     - `DEFAULT_HIDE`, the owner's six entries.
     - `hideList(mount, apiKeyCommand)`: `hide` (or the default) plus `hideExtra`, deduplicated, then "the API key file" always.
     - `apiKeyFileOf`: only `cat [--] <path>`, quoted or not. A pipeline or a password manager gives undefined.
     - `planWorkspace` always adds "tentacle's config" and masks entries strictly inside the source (`WorkspaceMask {path, file, label}`).
     - The prompt lists the labels: "except ~/.ssh, ~/.netrc, the API key file and tentacle's config, which stay hidden".
   - **File masks.** A dir gets an empty read-only `tmpfs`. A FILE gets a read-only bind of `/dev/null` (`{Type:"bind", Source:"/dev/null", ReadOnly:true}`), because a tmpfs cannot sit on a file. Probe args are `d:`/`f:`. A file must be an empty non-dir (`! -d && ! -s`); the script runs for real against a temp dir in a test.
   - **IO (`laptopWorkspaceInput`).** Expands `~/`. A relative path (the key file) resolves against the cwd. A missing entry is skipped. `statSync` decides file vs dir, and every path is realpathed.
   - **Labels.** The `tentacle.workspace-masked` label is still a JSON array of container paths, as E expects.
   - **Red counts.** Pure module: **23 fail** against export stubs. IO: **2 fail**.
3. **F2** (`engine-docker.ts` `waitForReady`).
   - A probe whose `runExec` throws becomes `workspace check failed: <cause>`, and the container is removed even with `--keep`.
   - The message reports the real outcome: `The container was removed.` or `The container could NOT be removed (<cause>) — remove it yourself: \`docker rm -f <name>\``.
   - `WorkloadRemovedError` now means "the host removed it, or tried and said so". The runtime still never logs it as kept.
   - Red: **3 fail** (throwing probe, failed removal, and the existing visible-mask test, which now asserts "The container was removed.").
4. **F3** (`engine-runtime.ts` attach). The `tentacle.workspace` label goes through `untrustedText` before `attachCwdWarning`. Test: a forged label holding `ESC[2J`/OSC/BEL reaches neither the log nor the notice raw. Red: **1 fail**.
5. **Nit F5.** HELP's `run` line lists `--confirm-mount`. README and HELP describe D-1/D-2.

**Mutations** (each red, then restored):

| Mutation | Result |
|---|---|
| D-1 secret refusal off | 6 fail |
| D-1 binary-dir refusal off | 1 fail |
| config dir masked only with a non-empty list | 1 fail |
| file mask as tmpfs | 1 fail |
| throwing probe not caught | 1 fail |
| failed removal reported as done | 1 fail |
| `untrustedText` dropped | 1 fail |

**Not red-first:** the updated `main.test.ts` wiring tests were rewritten after the planner change. Mutation 1 is what proves them.

**Open:**
- The key file is found only for `cat <path>`. A `titleModel`'s own command is not considered.
- Live checks not run here:
  - a `/dev/null` file bind on Docker Desktop and podman machine;
  - `ReadOnly` honoured on a tmpfs;
  - an engine refusing a `/dev/null` bind over a file it cannot see.

**Gate:** `bun run check` → typecheck clean, `biome check .` 549 files clean,
`bun test` **3356 pass / 3 skip / 0 fail** (before these fixes: 3332/3/0; the 3
skips are the opt-in live tests). After a HELP/README text edit made while the
gate ran, lint, typecheck and `main.test.ts`/`args.test.ts` (51/51) were re-run green.

## Addendum — .tentacle/hide (owner 2026-10-27)

*— claude-sonnet-5-5, 2026-10-27*

**Spec (owner-approved, same branch).** `<cwd>/.tentacle/hide` adds hidden paths
per project.
- Syntax: gitignore-style. `#` comments, blank lines, globs including `**`, a
  trailing `/` for directories only, a leading or inner `/` anchoring to the
  folder, `!` negation.
- `!` scope: it un-hides only what that same file hid. It never touches
  `mount.hide`/`hideExtra`, the always-hidden config dir or the `apiKeyCommand`
  key file.
- ADD-only: the file's paths are appended after those entries, and a duplicate
  keeps the configured or always-on entry.
- Resolved to concrete existing paths at container start. **A file created
  later is NOT masked** (documented in README).
- More than 200 resolved paths → refuse before anything is created, with a hint
  to narrow the patterns. Never a partial set.
- Containment: a pattern with `..`, or a symlink whose realpath is outside the
  source (or is the source itself), is ignored with a warning.
- The prompt and the startup status line say
  `Hidden from the container: N paths from .tentacle/hide, M defaults`.

**Execution.**
- **Pure module** (`workspace-mount.ts`):
  - `parseHideFile` → `HideRule`s, with a warning for a `..` pattern.
  - `hidesPath`: the last matching rule wins; a `dir/` rule needs a directory.
  - `resolveHideFile(text, source, fs: HideFs)`. The walk is injectable. A
    matched dir is ONE dir mask and is not descended into; a symlink masks its
    realpath. Over `HIDE_CAP` (200) paths, or over `HIDE_SCAN_CAP` (500k)
    entries scanned, it returns `problem` and no paths.
  - `hiddenSummary(mount)`.
  - `planWorkspace`: entries from the file are flagged `fromFile` and ordered
    after the configured and always-on ones. `input.hideProblem` makes it
    refuse; `input.hideWarnings` become `plan.warnings`.
  - The prompt names the non-file masks one by one and counts the file's.
- **IO** (`engine-select.ts`): `laptopWorkspaceInput` reads
  `<realpath cwd>/.tentacle/hide` ONLY when a mount will happen (local engine,
  not `--no-mount`) and walks the real fs (`readdir withFileTypes`, `realpath`).
- **CLI**:
  - `main.ts` prints the warnings (via `untrustedText`: pattern text is project
    content) before the runtime.
  - `engine-runtime.ts` appends the summary to the create phase line.
- **Tests** (red first: 22 fail on assertions in `workspace-mount.test.ts`, 3 in
  `workspace-io.test.ts`, 1 in `main.test.ts`, 1 phase-line):
  - Parse: comments, escapes, CRLF, `..`.
  - Match: any-depth, anchoring, `dir/`, `**` forms, `!` order.
  - Files vs dirs, `!` scope (never a default/config/key), cap at exactly 200 vs 201.
  - Escape: `../` pattern, symlink out, symlink to the root, and a symlink to a
    dir not matching `dir/`.
  - Real fs: dir/file/link/broken link, over the cap → planner refuses, no
    read for remote or `--no-mount`.
  - Status line and prompt.
- **Mutations** (restored from `cp`, `shasum` identical `495b4889…` /
  `6bed11a9…`):

  | Mutation | Result |
  |---|---|
  | cap disabled | 3 fail |
  | file entries ordered before the defaults | 2 fail |
  | symlink-escape check removed | 3 fail |

- **Limits.**
  - Patterns have no `[abc]` classes (the characters are literal).
  - `.tentacle/hide` is itself writable by the agent. A later run would read a
    weakened file, but it can never weaken the defaults.
  - The walk descends everything not hidden (`node_modules` included), and the
    500k-entry scan cap refuses rather than masking a partial set.
  - Not run live: whether an engine accepts hundreds of file binds.

**Gate:** `bun run check` → typecheck clean, `biome check .` 549 files clean,
`bun test` **3387 pass / 3 skip / 0 fail** (3356/3/0 before this addendum).

## Review — round 2

*— claude-opus-5-5, 2026-10-27* (fresh context. The executor of the fix round
was the **same model**, and the `.tentacle/hide` addendum was claude-sonnet-5-5,
the same family. Shared blind spots can survive. AGENTS §10 asks for a
different model on a load-bearing task.)

**Verdict: REQUEST-CHANGES.** The round-1 fixes and D-1 hold. Two
fail-loud gaps (R2-1, R2-2) silently drop something D-2 or the addendum
promises to hide. Both are small fixes. R2-3 needs a live check before
anyone relies on file masks on macOS.

**Gate (re-run, uncommitted tree):** `bun run check` → typecheck clean,
`biome check .` 549 files clean, `bun test` **3387 pass / 3 skip / 0 fail**
(3390 tests, 256 files; the 3 skips are the opt-in live tests). This matches
the executor.

**Findings**
1. **[medium] The key file is not hidden for `cat "$HOME/…"`, and nothing
   says so.**
   - Where: `workspace-mount.ts:44` (`apiKeyFileOf`).
   - The double-quoted branch `"([^"]+)"` accepts `$`. So
     `cat "$HOME/.anthropic-key"` returns the literal `$HOME/.anthropic-key`.
   - `engine-select.ts` then resolves it against the cwd, `statSync` fails, and
     the entry is skipped.
   - Repro (`.tentacle/tmp/dwm-review2/repro.ts`): with cwd = a home that holds
     `.anthropic-key`, the masks are only `[…/cfg-elsewhere]`, so the key file
     is visible.
   - The unquoted `cat $HOME/k` and `cat ~/k | tr -d '\n'` give `undefined`,
     also silently.
   - D-2 says the key file is ALWAYS hidden, and README/HELP repeat it. In
     practice it is hidden only for the `cat <literal path>` forms.
   - Fix: expand `$HOME`/`${HOME}` (or refuse to match `$` inside quotes). When
     an `apiKeyCommand` is set but no file is recognised, add a line to the
     prompt and status ("the apiKeyCommand key file could not be identified and
     is NOT hidden").
2. **[medium] An unreadable `.tentacle/hide` is a silent drop.**
   - Where: `engine-select.ts:264-268`. `catch {}` treats EACCES, EISDIR, EIO
     and a too-large read the same as "no file".
   - Repro: `chmod 000 .tentacle/hide` (rule `secrets/`) gives `mount`, masks
     `[]`, warnings `undefined`, and no prompt.
   - The brief's rule is "unreadable/malformed → loud". Only ENOENT should be
     silent; any other error should make the planner refuse (`hideProblem`).
   - Related low item: `nodeHideFs.list` (`engine-select.ts:311`) turns an
     unreadable subdir into `[]`, so the files below it are never matched.
     Warn on it.
3. **[high if confirmed · PLAUSIBLE, unverified] Case-variant paths may bypass
   FILE masks on Docker Desktop (macOS).**
   - The macOS share is case-insensitive.
   - A `/dev/null` bind sits on one dentry (`…/.netrc`, the key file,
     `.docker/config.json`).
   - A lookup of `…/.NETRC` through virtiofs can create a different dentry for
     the same file. That dentry is not a mountpoint, so the real content would
     be read.
   - Directory masks may be protected by the kernel's single-alias rule for
     directories. That is not proven either.
   - No engine was runnable in this session (docker needed approval).
   - Verify live before relying on it: `docker run --rm -v "$PWD:/w" --mount type=bind,src=/dev/null,dst=/w/Key,ro alpine cat /w/KEY` with a non-empty `./Key`. If it prints the content, the always-hidden key file is not hidden on macOS. The `.ssh`/config-dir masks need the same test with an uppercase spelling.
4. **[low] `.tentacle/hide` is read without a type or size guard.**
   - Where: `engine-select.ts:265`. `readFileSync` follows a symlink and reads
     a FIFO or a device.
   - The agent can write the folder, so it can plant a FIFO (the next laptop
     run blocks before Ink) or a link to a laptop file.
   - A laptop file's lines that contain `..` come back in a warning. They go
     through `untrustedText`, to the terminal only and never to the container.
   - This is a DoS, not a leak. Fix: `lstat`, require a regular file, and cap
     the size (refuse loudly).
5. **[info] A `dir/` rule silently skips a symlinked dir**
   (`workspace-mount.ts:207`). This is gitignore semantics and it is tested.
   For a list of secrets, a warning would be friendlier.

**Round-1 findings: status**

| R1 | Fix | Verdict |
|---|---|---|
| F1 equal path config/`~/.ssh` | D-1: `isWithin` refusal, before the gate (`workspace-mount.ts:433-443`); `main` refuses with `y` and `--confirm-mount` | **Fixed.** My mutation 1 turned it red. |
| F2 throwing probe / swallowed remove | try/catch → remove → `WorkloadRemovedError` with the real outcome (`engine-docker.ts:239-257`) | **Fixed** (the executor's mutations; code read). |
| F3 raw label | `untrustedText(state.workspace)` (`engine-runtime.ts:447`) | **Fixed.** |
| F4 secrets outside the masks | D-2 default list + configurable | **Fixed**, except for the R2-1 gap. |
| F5 HELP | `--confirm-mount` is in HELP's `run` line | **Fixed.** |

**Premise table**

| Premise | Verdict |
|---|---|
| D-1: `/`, `/usr`, `/usr/local[/bin]` are refused by realpath (`:385`, `:427`) | TRUE. A symlinked cwd is judged by its realpath (tested). |
| D-1: a cwd at or inside the config dir or `~/.ssh` is refused even when `~/.ssh` is dropped from `mount.hide` (`sshDir` comes from `existsSync`, not from the list) | TRUE |
| D-2: the config dir and the key file cannot be removed by `mount.hide: []` or a profile (`hideList:49-61`, `planWorkspace:457`) | TRUE for the config dir. For the key file, TRUE only for the `cat <literal>` forms (R2-1). |
| `.tentacle/hide` `!` never reaches the configured or always-on entries: the file is resolved apart and appended last, and dedup keeps the first (`:458-470`) | TRUE |
| No project-local config can set `mount`/`apiKeyCommand` (`load.ts` reads only `<configDir>/config.json`) | TRUE. The agent cannot weaken the defaults for the next run. |
| The prompt and warnings are written before Ink (`main.ts` plan → gate → `askLine` before `startEngineRuntime`) | TRUE. Warnings go through `untrustedText`. |

**Attacks tried**
- *`.tentacle/hide` written by the agent with `!~/.ssh`, `!/abs`, `!../x`, or a
  link to the config dir:* `!` only edits the file's own set. `..` is dropped
  with a warning. Paths are relative to the cwd and anchored, and a `/abs`
  pattern is cwd-relative. A link outside the folder is ignored, and a link to
  the root is excluded. The always-on entries are separate HidePaths. **No
  weakening of the defaults.** The agent can (a) delete the user's own file
  rules (accepted by the owner), (b) cause a refusal over the cap (loud), and
  (c) DoS with a FIFO (R2-4).
- *Weakening by config:* `mount.hide: []` and profile merges cannot remove the
  config dir or the key file (my mutation 3 pins it). Env has no `mount` form,
  and no project config exists. Trailing slash: `realpathSync` normalises it.
  Case variants: realpath canonicalises them (round 1, re-tested by the
  executor's case-variant IO test).
- *Refused cwds via a symlink or a case variant:* both are judged by realpath
  and refused, before the gate. `--confirm-mount` does not override.
- *Masks colliding with the config-dir tmpfs* (a `.tentacle/hide` entry inside
  or above an in-project config dir): this makes the engine fail to create a
  mountpoint in a read-only tmpfs, so start fails, loudly. It never un-hides.
- *Terminal:* the probe stdout, the hide warnings (file names from the
  agent-writable folder) and the label all go through `untrustedText`. The y/N
  prompt is readline, pre-Ink.

**Mutations** (backup `cp` → `.tentacle/tmp/dwm-review2/wm.bak`; restored;
`shasum` identical `495b4889…`, the same as the executor's):

| Mutation | Result |
|---|---|
| D-1: `isWithin` → `isInside` for the config dir | 5 fail (planner, symlink, real-fs symlink, macOS case variant, `main`) |
| `..` pattern check disabled | 1 fail |
| key file dropped whenever `mount` is configured | 2 fail (`hideList`, real-fs `hide: []`) |

**What holds:** D-1 is complete and runs before the gate. The config dir is
always masked. `!` is scoped. The cap refuses and never masks a partial set.
The pure/IO split is kept (`resolveHideFile` takes the walk injected). The
round-1 fixes are real. There is still no runtime or protocol change, and there
is still one session path.

**Executor behaviour:** disciplined and honest about the limits (`[abc]`, files
created later, live engine untested, the key file only for `cat`). It missed
the `"$HOME"` case inside its own `cat` regex (R2-1), and it treated "can't
read" as "absent" (R2-2), which is the silent-drop pattern the brief forbids.

## Execution — fix round 2

*— claude-opus-5-5, 2026-10-27*

All four round-2 findings are fixed, as the owner decided on 2026-10-27.

**Live evidence for R2-3 (the orchestrator, Docker Desktop on macOS).** With
`--mount type=bind,src=/dev/null,dst=/w/Key`, `cat /w/KEY` printed the real
content. A DIRECTORY tmpfs mask held under every spelling (`/w/SEC/x` and
`/w/sec/x` were not found), because Linux keeps one dentry per directory. So
only FILE masks are unsafe. The finding is CONFIRMED.

**Repro.** `bun <script>` needs approval in this session, so the repro is the
red tests below. `.tentacle/tmp/dwm-fix2/repro.ts` exists but was not run. The
review's repro (`dwm-review2`) already showed R2-1 and R2-2 on this code.

**As built:**

- **R2-1, the key file** (`workspace-mount.ts`):
  - `apiKeyFileOf` now maps a leading `$HOME/` or `${HOME}/` (bare or
    double-quoted) to `~/`. A single-quoted path stays literal.
  - Any other `$`, a backtick, a `\`, a glob (`* ? [`), a bare `{}`, a quoted
    `~` or a `~user` gives `undefined`.
  - The new `apiKeyFileUnknown(cmd)` is true when a command is set but its file
    cannot be named. `main` passes it to the `WorkspaceInput.keyFileUnknown`
    field.
  - `planWorkspace` then adds a fixed warning to `plan.warnings`. `main` prints
    it before Ink, and only when a mount happens.
  - `hideList` marks the key file `always: true`, and `laptopWorkspaceInput`
    carries that onto the `HidePath`.
- **R2-3, case-insensitive file masks:**
  - Pure `caseAliasedFiles(paths, fs: CaseFs)` checks each hidden file. If an
    `lstat` of another spelling gives the same `dev:ino`, the file is aliased.
    - ASCII names: the case is swapped, and one verdict is cached per directory.
      A name with no letters is never probed.
    - Non-ASCII names (APFS is also normalization-insensitive): the
      swapped/upper/lower/NFC/NFD forms are probed. A name none of these
      changes (e.g. CJK) counts as aliased, the conservative choice.
    - A file that cannot be `lstat`ed counts as aliased.
    - A hard link with another spelling counts too. It is just as unmasked.
  - IO: `laptopWorkspaceInput` runs the check only when a mount will happen,
    over the FILE entries inside the source (`nodeCaseFs` uses `lstat` with
    `bigint`). It fills `caseAliased`.
  - `planWorkspace`:
    - It drops any mask that lies inside a hidden DIR. The dir's tmpfs already
      covers it, and the advice "hide the folder" then works.
    - An aliased file marked `always` → `refuse`. `--confirm-mount` cannot
      override it.
    - Other aliased files → `plan.caseExposed`.
  - `mountGate`:
    - `caseExposed` without `--confirm-mount` → `refuse`, TTY or not. A y/N
      answer is not enough. The refusal comes before the danger prompt.
    - With the flag → `proceed` plus a warning that names each file still
      readable. `main` prints it.
  - The messages name each file (through `untrustedText`) and suggest hiding
    the folder or moving the file.
- **R2-2 and R2-4, reading `.tentacle/hide`:** pure
  `loadHideFile(source, fs: HideFileFs)`.
  - Only ENOENT (and ENOTDIR, when `.tentacle` is a file) counts as absent.
  - Any other error → `problem` (`could not be read (<errno>)`). Only the
    errno code is shown, never node's message, which embeds paths.
  - These also give a `problem`:
    - a path whose realpath lies outside the folder (a link, or a linked
      `.tentacle`);
    - a target that is not a regular file;
    - a file over `HIDE_FILE_MAX_BYTES` (64 KiB).
  - A FIFO is never opened. The IO read uses
    `O_RDONLY|O_NONBLOCK|O_NOFOLLOW` and checks `fstat` again on the fd
    (against TOCTOU).
  - Low item: `HideFs.list` returns `undefined` for an unreadable dir, and
    `resolveHideFile` warns, naming the dir.
- **Docs and backlog:** README covers the `$HOME` form, the NOT-hidden warning,
  the case rule and the `.tentacle/hide` refusals. TODO.md has the
  FUSE name-filter line.

**Drift and choices:**
- **Default-list file masks are overridable.** `~/.netrc` and
  `~/.docker/config.json` are on the configurable `mount.hide` list, so I
  treated them as user entries. Only the key file is `always` (the config dir
  is a dir).
- **New: nested masks are dropped.** A mask inside a hidden dir used to make
  the engine fail to create a mountpoint in a read-only tmpfs.
- **Test changes, not behaviour changes.** Some existing tests now meet the
  case check on this macOS disk:
  - the `$HOME` danger tests (`main.test.ts`) run with
    `mount.hide: ["~/.ssh"]`, because the real home's `~/.docker/config.json`
    is aliased;
  - two file-mask wiring tests pass `--confirm-mount`;
  - two `workspace-io` list tests plan with `caseAliased: []`.

**Red first:**
- The pure tests were run against stub exports, so they failed on assertions
  and not on imports: **23 fail** in `workspace-mount.test.ts`.
- The IO and `main` tests were written after the code. They were proven red by
  mutation (below).

**Mutations** (`cp` backups in `.tentacle/tmp/dwm-fix2/`, restored; `shasum`
identical: `workspace-mount.ts` `7c349d4d…`, `main.ts` `c8af40d6…`).
Formatting and the lint fix came afterwards.

| Mutation | Result |
|---|---|
| `loadHideFile` catch → `{}` (R2-2: unreadable = absent) | 2 fail (pure EACCES, real-fs `chmod 000`) |
| key file not `always` (overridable) | 2 fail (pure refusal, `main` key file on a case-insensitive fs) |
| `main`: `keyFileUnknown` dropped and gate warnings not printed | 2 fail (`main` R2-1 warning, `--confirm-mount` warning) |

**Gate:** `bun run check` → typecheck clean, `biome check .` 549 files clean,
`bun test` **3425 pass / 3 skip / 0 fail** (3387/3/0 before; the 3 skips are the
opt-in live tests).

**Open:**
- The two `main` case tests and the real-fs case expectation run only where the
  temp dir is case-insensitive (here, APFS). On Linux CI they are skipped, or
  they assert "no alias".
- Not verified live:
  - the refusal end to end on Docker Desktop;
  - podman machine (virtiofs, the same expectation);
  - a dir mask on an SMB or exFAT share.
- `titleModel` has no own key command, as before.
- `.tentacle/hide` is still writable by the agent (unchanged, owner-accepted).

## Review — round 3

*— claude-opus-5-5, 2026-10-27* (fresh context. This is the **same model** as
the fix-round-2 executor, so shared blind spots can survive. The scope is ONLY
the fix-round-2 diff.)

**Verdict: APPROVE-WITH-NITS.** R2-1, R2-2, R2-3 and R2-4 are fixed. Every
error path I attacked in the new code fails closed. The two nits below are
low and need no new round.

**Gate (re-run, uncommitted tree):** `bun run check` → typecheck clean,
`biome check .` 549 files clean, `bun test` **3425 pass / 3 skip / 0 fail**
(3428 tests, 256 files). This is identical to the orchestrator's
`gate-dwm-fix2.txt`.

**Findings**
1. **[low] The always-on key file is skipped on ANY `stat` error, not only
   ENOENT.**
   - Where: `engine-select.ts:267-271`. The `catch { continue; }` is the
     pre-existing loop, now carrying `always` entries.
   - Effect: an EACCES or ELOOP on the key path silently drops the mask, with
     no warning. This is the same "can't read = absent" pattern as R2-2.
   - In practice the container sees the laptop user's permissions (virtiofs),
     so an entry the user cannot stat is unlikely to be readable. That makes
     it low.
   - Fix (cheap): for `always`, refuse on a non-ENOENT error.
2. **[info] The case probe covers case and Unicode normalization only.**
   - Windows 8.3 short names (`SECRET~1.JSO`) and trailing-dot or trailing-space
     aliases (NTFS/SMB through WSL2/drvfs) are not probed.
   - This is out of the macOS scope the owner decided. Worth a TODO line next
     to the FUSE name-filter item.
3. **[info] Read size limit and the API-key warning.**
   - `nodeHideFileFs.read` (`engine-select.ts:379`) checks the size limit with
     `fstat`, then `readFileSync(fd)` reads to EOF. A file that grows between
     the two calls is read past 64 KiB. Exploiting this needs a live process
     on the laptop folder during startup, so it is negligible.
   - `KEY_FILE_UNKNOWN` (`workspace-mount.ts:684`) is printed even when the cwd
     cannot contain the key file. It is honest but noisy.

**Attacks tried**
- *Case probe says "case-sensitive" on a case-insensitive disk.* No path
  found:
  - **No-letter ASCII name** (`123`): there is no other case spelling on APFS
    or casefold, so it is correctly not aliased (`workspace-mount.ts:124`).
  - **Non-ASCII, NFC vs NFD:** both forms are probed. When no form differs,
    the name counts as aliased (closed). A case-sensitive APFS volume is still
    normalization-insensitive, so an NFD hit there is a TRUE positive.
  - **`Key` and `KEY` both on a case-sensitive disk:** they have different
    `dev:ino`, so the file is not aliased. That is correct, because the
    container also sees two distinct files.
  - **Hard link with another spelling:** aliased, and the directory is then
    cached as insensitive. This over-refuses, which is closed.
  - **A variant that is a symlink:** `lstat` gives the link's own inode. In the
    container the link resolves to the masked dentry, so this is safe.
  - **Per-directory cache:** sensitivity is per volume (APFS) or per directory
    (ext4 `+F`), so the cache key is right. A cached `false` is reused only for
    ASCII names.
- *Errors swallowed as "safe".* An unstat-able hidden file counts as aliased
  (my mutation 1 turns this red). A variant `lstat` error can only come from
  ENOENT or ENAMETOOLONG on the same directory; the container meets the same
  error. Only finding 1 is open.
- *`always` coverage.* D-2 makes only the config dir and the key file
  non-configurable:
  - The config dir is a DIR mask, which the live test shows holds under every
    spelling, so it needs no case check.
  - The key file gets a refusal that `--confirm-mount` cannot override
    (`workspace-mount.ts:650`).
  - `~/.netrc` and `~/.docker/config.json` are the user's own default entries
    (D-2: removable), so treating them as overridable matches the owner's
    decision.
  - A key file inside a hidden dir is dropped as nested and covered by the
    tmpfs.
- *`--confirm-mount` warning.* It is printed at `main.ts:720-724`, after the
  gate and before `startEngineRuntime`, so before Ink. It names each file
  (`caseList`, through `untrustedText`).
  - The case refusal comes BEFORE the danger y/N (`:707`), so a "y" cannot
    bypass it.
  - The `KEY_FILE_UNKNOWN` note is printed pre-Ink, at `:702`.
- *FIFO or oversized `.tentacle/hide`:*
  - `lstat` reports `other`, and the file is refused before any open.
  - A FIFO swapped in after the `lstat` is opened `O_NONBLOCK|O_NOFOLLOW`; the
    `fstat` then sees a non-file, throws, and the run refuses.
  - Size over 64 KiB → refuse.
  - A `.tentacle` linked out of the folder, or a `hide` linked out of it,
    fails `isInside(realpath)` → refuse.
  - `chmod 000 .tentacle` → EACCES → refuse.
  - ENOTDIR (`.tentacle` is a file) counts as absent, which is reasonable.
- *`apiKeyFileOf`.* Each of these gives `undefined` plus the warning:
  `cat $HOME` (no `/`), `cat "$HOME"/k`, `cat "~/k"`, `cat ~`, `cat ~user/k`,
  `cat a b`, `cat <k`, `cat k\nrm x`, `cat ~/a$b`. Each of these maps to
  `~/k`: `cat ${HOME}/k`, `cat "$HOME/k"`, `cat $HOME/k`.
- *README.* It matches the code: the `$HOME` form, the NOT-hidden warning, the
  case refusal (never overridable for the key file), and the `.tentacle/hide`
  refusals (unreadable, FIFO, link out, 64 KiB).

**Mutations** (`cp` backup → `.tentacle/tmp/dwm-review3/wm.bak`; restored;
`shasum` identical `2a35d389…` before and after):

| Mutation | Result |
|---|---|
| `caseAliasedFiles`: unstat-able file → not aliased (fail open) | 1 fail (`a file that cannot be stat'ed … → aliased`) |
| `loadHideFile`: non-regular file accepted (`kind !== "file"` → `stat === undefined`) | 3 fail (FIFO, symlink to FIFO, …) |

**Not verified:** a scratch `bun` script needs approval in this session, so I
did not run the end-to-end repro (`.tentacle/tmp/dwm-review3/r.ts`, written).
Two things rest on the tests instead:
- that `realpathSync` gives the on-disk case on APFS (the round-1 macOS
  case-variant test);
- the live Docker Desktop refusal, which was not run.

**Executor behaviour:** thorough and fail-closed by default. The only drift
(defaults overridable) is stated and matches D-2. It added the nested-mask
drop unasked, but justified it, and the change only removes a start failure.
It missed extending the R2-2 lesson to the old `statSync` loop (finding 1).

## Execution — fix round 3

*— claude-sonnet-5-5, 2026-10-27*

Finding 1 fixed at `engine-select.ts:267-278`: a `statSync` error other than ENOENT/ENOTDIR (e.g. EACCES) now sets `statProblem`, merged into `hideProblem` (the existing refusal path in `planWorkspace`). It names the label, the path and the error, for every entry (always or not).
Test in `workspace-io.test.ts` (chmod 000 dir; always and non-always; ENOENT still skipped). Red: with the catch reverted to `if (code) continue`, it failed (`hideProblem` undefined); backup `cp` + identical `shasum` after restore (`fa75386f…`).
