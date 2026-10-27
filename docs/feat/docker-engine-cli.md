# feat/docker-engine-cli — `run`/`attach --engine kubernetes|docker|podman`, config `engine:`, podman socket discovery (docker-runtime slice C)

> **Status:** execution (plan approved 2026-10-27 with C-Q1, C-Q2, `--keep`)
> **Branch:** `feat/docker-engine-cli` (fast-forwarded to `main` `206adbf`: slice B and task 4 merged)
> **Type:** feat · **Size:** L · **Blast:** load-bearing · **Suited:** strong model executes; **mandatory fresh-context Review** red-teaming AGENTS §7 "Pod lifecycle" (the exit-net dispatch is renamed and pinned here; `attach` never creates/deletes), "TUI always over RPC — one session path" (one call site per mode for all three engines) and "Single-broker invariant".

## Context

*— claude-opus-5-5, 2026-10-27*

Slice C of `docs/eval/docker-runtime.md` (decided). Slice A (`packages/docker`)
and A2 (`ssh://` dialer) are merged; slice B (`docs/feat/docker-engine-seam.md`,
the `EngineHost` seam + `dockerEngineHost`) is reviewed MERGE. After B, nothing
a user can type selects Docker: `main.ts` still builds only a `KubeClient`
(`packages/cli/src/main.ts:559`, `:606`). C is the user-facing wiring.

Owner decisions this task implements (fixed, `docs/eval/docker-runtime.md:383`
and the orchestrator brief, 2026-10-27):
- ONE flag `--engine kubernetes|docker|podman` on `run` and `attach` (no `--docker`);
- the default engine is configurable with config key `engine:` ("project/user
  config"); the flag overrides it; with nothing configured it stays `kubernetes`;
- `podman` = the Docker-API path, with automatic podman socket discovery
  (rootless Linux, podman machine on macOS), so no `DOCKER_HOST` is needed;
- seam name `EngineHost` (done in B).

Also decided earlier and in C's scope per the eval table (`docker-runtime.md:324`)
and B's Context (`docker-engine-seam.md:17-18`): `--context <ctx>` (owner answer 1)
and `--insecure-docker-tcp` (answer 6). The bind-mount of the cwd (answer 2) is
in that list too; see **Q2**.

Slice-B carry-overs owned here: rename `pod-runtime.ts` / `startPodRuntime` /
`startAttachRuntime` and the attach deps' `podName` to engine-neutral names
(B Owner Q2, B Review finding 3); pin the hidden `__delete-container` and
`__delete-pod` dispatch so a rename cannot silently drop exit cleanup (B Review
finding 1, mutation R4 stayed green).

**Repro** (2026-10-27, branch at `fa1ce47`): the capability is missing. `bun`
needs approval in this session, so the repro is static:

```
$ rg -c engine packages/cli/src/flags.ts packages/config/src/schema.ts
(no output — no --engine flag in ARGS.run/ARGS.attach, no engine: key in the schema)
$ rg -c "CONTAINER_HOST|XDG_RUNTIME_DIR|podman-machine" packages
(no output — no podman socket discovery)
$ rg -n "values:" -A0 packages/cli/src/flags.ts   (excerpt)
83:    values: { namespace: { short: "n" }, image: {}, "bin-dir": {} },
90:    values: { namespace: { short: "n" }, container: { short: "c" }, "bin-dir": {} },
```

Since `ARGS` is closed (`flags.ts:23-26`, docs/fix/cli-strict-args.md),
`tentacle run --engine docker …` is rejected today as an unknown flag. The
executor re-runs `bun packages/cli/src/main.ts run --engine docker --image x`
first (expected: `[error] unknown flag --engine`).

## Implementation

*— claude-opus-5-5, 2026-10-27*

### Load-bearing assumption

**After B, choosing the engine is ONLY choosing which `EngineHost` to build:
the runtime entry points take any host, so `run`/`attach` on Docker/Podman
need no runtime edit, and the k8s path stays byte-identical when the host is
`kubeEngineHost(new KubeClient(auth), ns)`.**

Proof:
- `startEngineRuntime(config, EngineRuntimeDeps)` (`packages/cli/src/pod-runtime.ts:221`)
  and `attachEngineRuntime(config, EngineAttachRuntimeDeps)` (`:394`) take a
  `host`; `startPodRuntime` (`:206`) and `startAttachRuntime` (`:376`) are thin
  wrappers that build `kubeEngineHost(deps.kube, deps.namespace)`.
- `dockerEngineHost({client, endpoint, kind, spawnDelete?})`
  (`packages/cli/src/engine-docker.ts:40-46`, `:69`) already takes
  `kind: "docker" | "podman"` (drives the `docker …`/`podman …` hints) and any
  `EngineEndpoint`.
- The client: `new DockerClient({ dial: dialerFor(ep) })` (B Review "Slice C
  readiness", `docker-engine-seam.md:719-723`; `dialerFor` in
  `packages/docker/src/engine-dialer.ts`).
- The B oracle `packages/cli/test/pod-runtime.test.ts` drives the runtime only
  through `startPodRuntime`/`startAttachRuntime` with a `FakeCluster` (68
  references to those names + `podName`); it stays the zero-k8s-change oracle
  if those names survive as a **test-local** helper over the engine entry points.

### Preconditions

- **Strict args**: `ARGS.run` / `ARGS.attach` are the one list of accepted
  flags (`flags.ts:82-95`), and `USAGE.run`/`USAGE.attach` the usage lines
  (`flags.ts:520-522`). An unknown flag fails before config/cluster
  (`main.ts:223-236`).
- **Config is loaded before `run`/`attach`** (`main.ts:309-317`), so a
  `config.engine` default is available where the host is built. A bad config
  value is a `[config error]` (zod), before any engine work.
- **Settings shape is shared by the file and profiles** (`schema.ts:271-288`:
  `ProfileSchema` and `FileConfigSchema` both spread `settingsShape`), so an
  `engine` key in `settingsShape` is valid in `config.jsonc` AND in a profile
  (`--profile`). Env > profile > file > default is the repo pattern
  (`resolve.ts:351`, `autoWake`).
- **There is NO project-level config layer.** `rg -i "project ?config|\.tentacle/config|projectConfig" packages/config/src`
  → nothing; the only per-repo inputs are skills, `AGENTS.md` and project hooks
  (the last behind a trust store, `load.ts:478-484`, `hooks-trust.ts`). → **Q1**.
- **Docker endpoint resolution** honours `--context` > `DOCKER_HOST` >
  `DOCKER_CONTEXT` > `currentContext` > default socket
  (`packages/docker/src/engine-endpoint.ts:70-96`), and refuses plaintext/
  unverified `tcp://` unless `allowInsecureTcp` (`:249-257`; the message already
  names `--insecure-docker-tcp`). `context` and `allowInsecureTcp` are inputs
  reserved for C (`:46-49`).
- **Unreachable-engine messages exist** (`packages/docker/src/byte-duplex.ts:55-100`):
  missing socket → "is Docker Desktop running / `podman machine start`?"
  (`:64`); refused → "+ podman hint when the path contains `podman`" (`:68`).
  A podman socket path contains `podman`, so discovered sockets get the hint.
- **Podman socket locations** (to discover): macOS podman 5 machine API socket
  `$TMPDIR/podman/podman-machine-default-api.sock` (observed on this laptop:
  `docker-runtime.md:67`); podman 4 `~/.local/share/containers/podman/machine/podman.sock`
  (+ `qemu/podman.sock`); Linux rootless `$XDG_RUNTIME_DIR/podman/podman.sock`
  (else `/run/user/<uid>/podman/podman.sock`); rootful `/run/podman/podman.sock`.
  Podman's own override is `CONTAINER_HOST` (not `DOCKER_HOST`).
- **Exit-net dispatch** is two hand-matched literals per engine:
  `main.ts:200` ↔ `packages/k8s/src/pod-cleanup.ts:146` (`__delete-pod`), and
  `main.ts:206` ↔ `packages/docker/src/container-cleanup.ts:69`
  (`__delete-container`). Neither dispatch is tested (B mutation R4).
- **Failure lines are hard-coded `[pod]`** in `main.ts:546` (`--image`
  required), `:578` and `:625` (`[pod] failed:`), and `loadPodAuth(…, "pod")`
  (`:452-472`) — they must follow the host's noun.

### Design

**1. Config: `engine` key** (`packages/config`).
`settingsShape.engine: z.enum(["kubernetes","docker","podman"]).optional()`
(`schema.ts`, next to `autoWake` `:231`), so `config.jsonc` and profiles accept
it. `TentacleConfig.engine?: EngineKind` (`resolve.ts` + `load.ts` pass-through;
optional — absent = not configured). Scaffold comment in `defaults.ts`
(`// "engine": "kubernetes",`). Env `TENTACLE_ENGINE` only if Q1 says so.
Project-level source: per **Q1**.

**2. Podman discovery — `packages/docker/src/podman-endpoint.ts` (new, pure).**
`resolvePodmanEndpoint(input)` with injected `env`, `platform`, `uid`,
`tmpdir`, `home`, `exists(path)`, `listDir(dir)`, `readFile` (as A's
resolver). Precedence: explicit `--context` (a docker context; delegated to
`resolveEngineEndpoint({context})`) > `CONTAINER_HOST` > platform candidates
(macOS: `$TMPDIR/podman/podman-machine-default-api.sock`, then any
`$TMPDIR/podman/*-api.sock`, then the two podman-4 paths; Linux:
`$XDG_RUNTIME_DIR/podman/podman.sock`, `/run/user/<uid>/podman/podman.sock`,
`/run/podman/podman.sock`). First existing path wins → `{kind:"unix", path,
local:true, source:"podman (auto-discovered)"}`. **`DOCKER_HOST` /
`DOCKER_CONTEXT` are ignored for `--engine podman`**: they name Docker's engine,
and honouring them would silently run "podman" on Docker. `CONTAINER_HOST`
`unix://`/`tcp://` reuse A's parsing through a new exported thin wrapper
`resolveHostEndpoint(host, source, {allowInsecureTcp})` in `engine-endpoint.ts`
(over the private `hostEndpoint`, `:204-230`); `ssh://` → actionable error
(podman URLs carry a socket path, which A2's `docker system dial-stdio` cannot
use — debt). None found → *"no Podman socket found (looked in: …) — start it
with `podman machine start` (macOS) or `systemctl --user enable --now
podman.socket` (Linux), or set CONTAINER_HOST"*. A found-but-stale socket is
left to the dial (A's "nothing is listening … `podman machine start`").

**3. Engine selection — `packages/cli/src/engine-select.ts` (new, pure + one builder).**
- `parseEngine(value)` → `EngineKind` | error *"unknown engine "x" (--engine):
  use kubernetes, docker or podman"*.
- `chooseEngine(flag, configured)` → `{kind, source: "--engine" | "config" |
  "default"}`: flag > config > `kubernetes`. Pure; the conflict case (flag ≠
  config) is simply "flag wins" (owner decision), no warning.
- `engineFlagProblem(kind, {namespace?, container?, context?, insecure?})` →
  usage error or `null`: `-n/--namespace`, `-c/--container` only with
  `kubernetes`; `--context`, `--insecure-docker-tcp` only with docker/podman.
  (`TENTACLE_POD_NAMESPACE` env is ambient: ignored for docker/podman, not an
  error.) Checked before sessions/auth, like other usage errors.
- `buildEngineHost(kind, opts, io)` → `EngineHost` (throws an actionable
  `Error`): kubernetes → the existing `loadPodAuth` logic moved here verbatim
  (`main.ts:452-472`) + `kubeEngineHost(new KubeClient(auth), ns)`; docker →
  `resolveEngineEndpoint({env, context, allowInsecureTcp, readFile})`; podman →
  `resolvePodmanEndpoint(…)`; both → `dockerEngineHost({client: new
  DockerClient({dial: dialerFor(ep)}), endpoint: ep, kind})`. `io` injects
  `env`, `readFile`, `exists`, `listDir`, platform/uid/tmpdir, and the two
  client constructors (tests).

**4. Renames (B carry-over), mechanical, no behaviour change.**
`git mv packages/cli/src/pod-runtime.ts packages/cli/src/engine-runtime.ts`;
delete the k8s wrappers `startPodRuntime`/`startAttachRuntime` and fold
`PodRuntimeDeps`/`PodAttachRuntimeDeps` into `EngineRuntimeDeps`/
`EngineAttachRuntimeDeps` (no `kube`/`namespace`); `podName` → `name`.
`git mv packages/cli/test/pod-runtime.test.ts packages/cli/test/engine-runtime.test.ts`
with a **test-local** `startPodRuntime`/`startAttachRuntime` helper (3 lines
each, `{...deps, host: kubeEngineHost(kube, namespace)}`) so the 68 call sites
and every assertion stay byte-identical; `podName:` → `name:` at its call
sites. Imports updated in `main.ts`, `engine-docker.ts`, `engine-host.ts`
(comment), `engine-k8s.test.ts`, `engine-docker.test.ts`, `status-line.test.ts`.
Helper names (`podDaemonCommand`, `createStderrSink`, `PodStderrSink`) stay —
not in the carry-over; noted debt.

**5. Exit-net dispatch pinned.** Export `DELETE_POD_SUBCOMMAND = "__delete-pod"`
(`k8s/src/pod-cleanup.ts`) and `DELETE_CONTAINER_SUBCOMMAND =
"__delete-container"` (`docker/src/container-cleanup.ts`); use them in the
command builders (`:146`, `:69`) AND in `main.ts:200/206`, so the two ends
cannot diverge. Plus a `main.test.ts` test per constant: `main(["bun","cli",
CONST])` with the delete env unset → returns `0` with **no output** (an
unknown word would go to prompt mode and print). Mutation: drop a dispatch
branch → red.

**6. `main.ts` wiring.** `run`/`attach`: read `--engine`, `--context`,
`--insecure-docker-tcp`; `chooseEngine` → `engineFlagProblem` (usage error +
`USAGE`, exit 1) → sessions → `buildEngineHost` (error → `[<noun>] failed:
…`, exit 1) → **the same single call** to `startEngineRuntime` /
`attachEngineRuntime` with `host` → `runPodTui` (renamed `runEngineTui`). The
prefix/noun of every `[pod]` line in these two blocks comes from the kind
(`pod` for kubernetes, `container` otherwise), so k8s output is unchanged.
`daemonInPod: true` stays (a container is also "not the laptop").

**7. Flags/help/docs.** `ARGS.run`/`ARGS.attach` + `engine`, `context` values,
`insecure-docker-tcp` bool; `USAGE` + `HELP` (`main.ts:76-85`, `:150-174`):
an "Engines" paragraph (`--engine`, `engine:` default, `--context`,
`--insecure-docker-tcp`, podman discovery + `CONTAINER_HOST`). README "Ways to
run" (`README.md:53-73`): `--engine docker|podman` examples, config key in
"Configuration". `docs/architecture/F4-pod-execution.md`: a short "Engines"
section. AGENTS §7 "Pod lifecycle": "pod" → "pod/container" (wording only,
rides this branch per §10(c) review). `TODO.md` index line.

### Files

Dependency order:
1. `packages/config/src/schema.ts`, `resolve.ts`, `load.ts`, `defaults.ts` (+ `packages/config/test/*` for the key)
2. `packages/docker/src/engine-endpoint.ts` (+ `resolveHostEndpoint`), `podman-endpoint.ts` (new), `container-cleanup.ts` (constant), `index.ts`
3. `packages/k8s/src/pod-cleanup.ts` (constant only), `packages/k8s/src/index.ts` if needed
4. `packages/cli/src/engine-runtime.ts` (git mv of `pod-runtime.ts`), `engine-select.ts` (new), `flags.ts`, `main.ts`, `engine-docker.ts`/`engine-host.ts` (imports/comments)
5. tests: `packages/docker/test/podman-endpoint.test.ts` (new), `packages/cli/test/engine-select.test.ts` (new), `engine-runtime.test.ts` (git mv, helper + `podName`), `engine-k8s.test.ts`/`engine-docker.test.ts`/`status-line.test.ts` (imports), `main.test.ts` (dispatch pins + one wiring test), `args.test.ts` (new flags)
6. docs: `README.md`, `docs/architecture/F4-pod-execution.md`, `AGENTS.md` (§7 wording), `TODO.md`, this doc.
Not touched: `packages/cli/src/wiring.ts` (overlap with `permission-call-attribution`), the protocol, persistence.

### Failure modes

| Mode | Where | Converges to |
|---|---|---|
| Unknown engine value on the flag (`--engine dokcer`) | `parseEngine`, before config | `[error] unknown engine "dokcer" (--engine): use kubernetes, docker or podman` + usage, exit 1; nothing dialled. |
| Unknown engine value in config (`"engine": "lxc"`) | zod enum at `loadConfig` | `[config error] … engine: Invalid enum value …`, exit 1 (every command; same as any bad key). |
| Flag vs config disagree | `chooseEngine` | flag wins (owner); the `where` in the first status line (`unix:///… (context "default")` vs `namespace dev`) shows which engine ran. |
| Engine-specific flag on the wrong engine (`-n` with docker, `--context` with kubernetes, `-c` with docker) | `engineFlagProblem` | usage error, exit 1 — never silently ignored (strict-args rule). |
| Docker engine unreachable (no socket / refused / EACCES / TLS) | A's `dialError` at the first call (`create`/`inspect`) | `[container] failed: Docker engine socket not found at … — is Docker Desktop running / \`podman machine start\`?`, exit 1; nothing created, no exit net armed (B). |
| Docker endpoint config invalid (missing context, plaintext tcp) | `resolveEngineEndpoint` throws | `[container] failed: refusing plaintext tcp://… — or force it with --insecure-docker-tcp`, exit 1. |
| Podman socket not found | `resolvePodmanEndpoint` | actionable "no Podman socket found (looked in …) — `podman machine start` / `systemctl --user enable --now podman.socket` / CONTAINER_HOST", exit 1. |
| Podman socket stale (machine stopped) | dial | A's "nothing is listening … (start it with `podman machine start`)". |
| `CONTAINER_HOST=ssh://…` | `resolvePodmanEndpoint` | actionable "not supported yet" error naming the workaround; no silent fallback to a local socket. |
| User has `DOCKER_HOST` set and runs `--engine podman` | discovery ignores it | podman's socket is used, never Docker's (test pins it). |
| `attach --engine docker` to a missing container | B `inspect` 404 | `[container] failed: container X not found on … — \`docker ps\`; use \`run\` to create one`, exit 1; nothing created/started/removed. |
| `run` without `--image` on docker | `main.ts` | `[container] --image <ref> is required …`, exit 1. |
| Renamed exit-net subcommand (future refactor) | shared constants + dispatch tests | cannot diverge; dropping a dispatch branch is red. |
| Nothing configured, no flag | `chooseEngine` → kubernetes | today's path, byte-identical (oracle green, renamed only). |
| Help/README drift | `HELP`, `USAGE`, README | `args.test.ts`/`main.test.ts` assert `--engine` appears in `USAGE.run`/`attach` and `HELP`. |

### Tests

Red first for each slice (paste the red line); mutations restored only from a
`cp` backup with matching `shasum`.
- `podman-endpoint.test.ts`: macOS podman-5 path; podman-4 fallback; Linux
  XDG / `/run/user/<uid>` / rootful order; `CONTAINER_HOST` wins over
  discovery; `DOCKER_HOST` set → **ignored**; `--context` wins; none found →
  the exact message listing the paths; `ssh://` → error. Mutation: honour
  `DOCKER_HOST` → red.
- `engine-select.test.ts`: flag > config > default; unknown value; each
  wrong-engine flag; `buildEngineHost` with injected constructors → kubernetes
  gets the moved auth (`TENTACLE_K8S_SERVER` path), docker gets
  `resolveEngineEndpoint` with `context`/`allowInsecureTcp` passed through,
  podman gets `kind:"podman"`. Mutation: config beats flag → red.
- config tests: `engine` accepted in file and profile; invalid value rejected.
- `engine-runtime.test.ts` (renamed oracle): green with only the import lines,
  the local helper and `podName`→`name` changed (`git diff -M` shows that).
- `main.test.ts`: dispatch pins (§5, mutation: drop a branch → red); wiring:
  `run --engine docker --image x` with `DOCKER_HOST=unix:///nonexistent/d.sock`
  → exit 1 and `[container] failed: Docker engine socket not found …`
  (proves the flag reaches the docker host end to end, no engine needed);
  `run --engine docker -n x` → usage error.
- Optional live (not gate): `TENTACLE_DOCKER_TESTS=1` manual `run --engine
  docker --image debian:stable-slim` on Docker Desktop, pasted in Execution.
- Gate: `bun run check`, baseline 3194 pass / 3 skip / 0 fail.

### Owner decisions folded in (owner 2026-10-27)

- **C-Q1 → engine default (owner 2026-10-27).** `engine:` in the USER
  `config.jsonc` and in profiles (`settingsShape`, so profile > file comes for
  free from the profile merge), plus env `TENTACLE_ENGINE`. Precedence: flag >
  env > profile > user config > `kubernetes`. The env is read in the CLI's
  `chooseEngine` (not in `resolve.ts`), so an invalid `TENTACLE_ENGINE` is a
  loud error through the same `parseEngine` as the flag, never the repo's
  "unrecognised env falls through" (`resolve.ts:179-185`): silently falling
  back to kubernetes would run on the wrong engine. Per-repo config: not here
  (separate eval).
- **C-Q2 → no workspace mount in C (owner 2026-10-27).** It is
  `feat/docker-workspace-mount`, right after C. `containerBody` is untouched.
- **NEW: `run --keep` (owner 2026-10-27), all engines.** `EngineRuntimeDeps`
  gains `keepHint?: (name) => string` (present = keep), built in `engine-select.ts` as
  `attachCommand(kind, name, {namespace?, context?})` →
  `tentacle attach --engine <e> [-n <ns>|--context <c>] <name>`. With it,
  `startEngineRuntime`: (a) does NOT arm `registerExitCleanup` (Ctrl+C /
  `process.exit` keep the workload); (b) `disposeTransport` closes the exec but
  does not `remove`; (c) the startup-failure catch does not `remove` either
  (`--keep` = tentacle never deletes this workload; a broken one is left to
  inspect); (d) prints `[<noun>] kept <name> — resume with: <attach cmd>` as a
  durable log line once the workload exists (pre-mount, so it survives the
  alt-screen and covers Ctrl+C) and again after dispose / after a startup
  failure. Without `--keep` the path is byte-identical. `--keep` is a `run`
  bool only (`attach` already never deletes). Tests: keep → no `besteffort:`
  after firing the exit listener, no `delete:` on dispose and on an injection
  failure, the hint line exact, on k8s (renamed oracle rig) and docker
  (`engine-docker.test.ts` rig); mutation: arm the net anyway → red.
- **Carry-over from task 4 (owner 2026-10-27).** The renamed
  `engine-runtime.test.ts` rig must send `toolCallId`/`origin` on its
  permission requests like the other rigs (task 4's gap).

### Owner questions (answered 2026-10-27, see the decisions at the end)

1. **`engine:` "project/user config": there is no project config layer.**
   tentacle reads only `~/.config/tentacle/config.jsonc` (+ profiles, env); the
   only per-repo inputs are skills, `AGENTS.md` and trust-gated project hooks.
   Options: (a) `engine:` in the user config + profiles (a per-project choice
   is `--profile <p>` / `TENTACLE_PROFILE`), plus env `TENTACLE_ENGINE`
   (repo pattern: env > profile > file); (b) also build a per-repo config file
   (e.g. `.agents/tentacle.jsonc`) now. A repo-supplied file is pod-style
   "untrusted input": it would need the project-hooks trust treatment, and it
   is a general mechanism, not an engine feature. → **Recommend (a)** now,
   and a separate `eval/project-config` if a per-repo default is still wanted.
2. **Bind-mount of the cwd (owner answer 2) — in C or its own slice?** It
   changes `containerBody` (B pinned "no binds"), needs the daemon's working
   dir set to the mounted path, and is the one security-relevant default
   (rw host folder inside the container; remote engine excluded; Docker
   Desktop/podman machine share only some host paths). → **Recommend a
   separate `feat/docker-workspace-mount` (S–M) right after C**, so C stays
   wiring + renames and its Review stays focused. C ships `--context` and
   `--insecure-docker-tcp` (pass-through to A's resolver).

## Execution

*— claude-opus-5-5, 2026-10-27*

### 0. Baseline

Branch at `206adbf` (main: slice B and task 4 merged), before any code edit:
`bun run check` → typecheck ✓, lint ✓ (535 files, 0/0), test **3211 pass / 3
skip / 0 fail** (3214 tests, 247 files). That matches the brief.

### 1. As built, in plan order

1. **Config** (`packages/config`): `settingsShape.engine` is a
   `z.enum(["kubernetes","docker","podman"])` (`schema.ts`), so it is valid in
   the file and in a profile. It is passed through `ResolvedConfig` and
   `TentacleConfig` (`resolve.ts`, `load.ts`) only when set. The template has
   a commented `"engine": "kubernetes"` (`defaults.ts`). Tests:
   `packages/config/test/engine.test.ts` (5).
2. **Podman discovery** (`packages/docker/src/podman-endpoint.ts`, new; pure):
   - `podmanSocketCandidates` lists the places to look. macOS: the default
     machine socket in `$TMPDIR/podman`, other `*-api.sock` there, then the
     two podman-4 paths. Linux: `XDG_RUNTIME_DIR`, `/run/user/<uid>`, then
     rootful.
   - `resolvePodmanEndpoint` picks one: `--context` > `CONTAINER_HOST` > the
     first candidate that exists. `DOCKER_HOST`/`DOCKER_CONTEXT` are ignored.
     `CONTAINER_HOST=ssh://` is an actionable error. If no socket is found,
     the error lists every path it looked in.
   - `engine-endpoint.ts` gains `resolveHostEndpoint`, a thin export over the
     private `hostEndpoint`.
   - Tests: `packages/docker/test/podman-endpoint.test.ts` (10).
3. **Exit-net pin**: `DELETE_POD_SUBCOMMAND` (`k8s/src/pod-cleanup.ts`) and
   `DELETE_CONTAINER_SUBCOMMAND` (`docker/src/container-cleanup.ts`) are used
   by the command builders AND by `main.ts`'s dispatch. In `main.test.ts`, one
   test per constant checks exit 0, no output and no config scaffolded.
4. **Engine selection** (`packages/cli/src/engine-select.ts`, new):
   - `chooseEngine`: flag > `TENTACLE_ENGINE` > configured > kubernetes. An
     unknown flag or env value is an error that names its source.
   - `engineFlagProblem`, `engineNoun`, `attachCommand` and
     `setupFailureLine`.
   - `buildEngineHost` with an injectable `EngineHostIO`. The kubernetes auth
     moved here verbatim from `main.ts`'s `loadPodAuth`.
   - Tests: `packages/cli/test/engine-select.test.ts` (9).
5. **Renames + `--keep`**:
   - `pod-runtime.ts` → `engine-runtime.ts`. The k8s wrappers
     `startPodRuntime`/`startAttachRuntime` and the
     `PodRuntimeDeps`/`PodAttachRuntimeDeps` types are gone.
     `EngineRuntimeDeps`/`EngineAttachRuntimeDeps` carry `host`, and attach
     takes `name` (was `podName`).
   - `keepHint?: (name) => string` on `run`. With it, no exit net is armed,
     the workload is not removed on dispose or on a startup failure, and
     `[<noun>] kept <name> — resume with: <cmd>` is logged pre-mount and again
     on dispose or failure.
   - `pod-runtime.test.ts` → `engine-runtime.test.ts`. Test-local
     `startPodRuntime`/`startAttachRuntime` helpers over the engine entry
     points leave every call site and assertion unchanged.
   - The task-4 rig gap is fixed: `SpyFakeCluster` forwards
     `(req, options)` to a recording daemon broker. The single-broker test now
     also asserts `{toolCallId:"tc1", origin:"call"}`.
   - The same gap is closed in `engine-docker.test.ts`'s rig.
   - Two `--keep` tests on the k8s rig and one on the Docker rig.
6. **Wiring** (`flags.ts`, `main.ts`):
   - New flags: `--engine` and `--context` on `run`/`attach`,
     `--insecure-docker-tcp` on both, and `--keep` on `run` only.
   - `selectEngine` turns an unknown value or a flag given for the wrong
     engine into a usage error, before sessions or any engine is touched.
     Next `engineHost` builds the host (a failure prints `setupFailureLine`).
     Then ONE call to `startEngineRuntime` or `attachEngineRuntime`, and
     `runEngineTui` (renamed from `runPodTui`).
   - The `[pod]`/`[container]` prefixes follow the engine.
   - `HELP` gains an "Engines" section; `USAGE` is updated.
   - Six `main.test.ts` tests drive `--engine` end to end, with both engines
     pointed at unreachable endpoints.
7. **Docs**:
   - README "Ways to run" covers engines and `--keep`, and the config table
     has an `engine` row.
   - `docs/architecture/F4-pod-execution.md` has an Engines note.
   - AGENTS §7: "Pod lifecycle" → "Pod/container lifecycle", which adds the
     `--keep` exception and the shared-constant pin.
   - `TODO.md` index line updated.

### 2. Red → green

| Slice | Red (on the assertion, before the code) | Green |
|---|---|---|
| config | `engine.test.ts`: **1 pass 4 fail** — `Unrecognized key(s) in object: 'engine'`; template lacks `// "engine": "kubernetes",` | 5/5 |
| podman | a stub module (to get past the import), **0 pass 10 fail**, e.g. `Expected: […podman-machine-default-api.sock, …] Received: []` | 10/10 (+16 endpoint) |
| `--engine` wiring | `main.test.ts` **8 pass 6 fail**, e.g. `Expected to contain: "[container] failed: Docker engine socket not found at /nonexistent/tentacle-test.sock" Received: "[error] unknown option --engine …"` | 14/14 |

The exit-net dispatch tests pass on the old literal dispatch as well,
because those strings did match. `engine-select.test.ts`, the `--keep` tests
and the rig attribution assertion were written after their code. Their red
is shown **by mutation** (§3). That is drift D5.

### 3. Mutations

Each file was copied to `.tentacle/tmp/docker-engine-cli/bak/`, mutated with
`sed`, tested narrowly, then restored with `cp`. The post-restore `shasum` is
identical for all five files: `engine-runtime.ts c0abd43c…`, `main.ts
a0eb0dfa…`, `podman-endpoint.ts 20526f9f…`, `engine-select.ts fd23ac0a…`,
`engine-runtime.test.ts 527c3034…`.

| # | Mutation | Result |
|---|---|---|
| M1 | arm the exit net even with `--keep` | RED: both `--keep` tests (k8s + docker): `exitListeners` = `[Function]` |
| M1b | remove the workload even when kept | RED: 3 tests (`delete:keeper` ×2, the failure-path delete, `remove:kept1`) |
| M2 | rig drops `options` (task 4's gap) | RED: `daemonAsks[0]` undefined (`received value must be a non-null object`) |
| M3 | `main.ts` container dispatch renamed | RED: the dispatch test (output = a whole prompt turn) |
| M3b | `main.ts` pod dispatch renamed | RED: the dispatch test |
| M4 | podman honours `DOCKER_HOST` | RED: "DOCKER_HOST / DOCKER_CONTEXT are IGNORED" (`/var/run/docker.sock`) |
| M5 | the configured engine beats the flag | RED: 2 `chooseEngine` tests |

### 4. Drift from Implementation (and why)

- **D1: `git mv` needed approval in this session**, so the renames are plain
  `mv`. `git status` shows `D pod-runtime.ts` + `?? engine-runtime.ts` (same
  for the test). `git add -A` then `git diff -M --cached` shows them as
  renames.
- **D2: the k8s host is now built inside the auth `try`**
  (`buildEngineHost`). Before, `new KubeClient` ran outside it. A
  `KubeClient` constructor throw would now print as `[pod] cluster auth
  failed: …` instead of crashing. The kubernetes output is otherwise
  byte-identical (`setupFailureLine`).
- **D3: `USAGE.attach` says `<name>`, not `<pod>`.** The existing
  `main.test.ts` assertion changed accordingly. That is one line.
- **D4: when the kept line is printed.** It goes out after startup succeeds
  (pre-mount; it stays on the main screen after the alt-screen exits, so it
  also covers a Ctrl+C during the session), and again after dispose or a
  startup failure. Ctrl+C *during* startup keeps the workload but prints no
  line. Printing next to the spinner would corrupt the single status line.
- **D5: red was shown by mutation** for the code written before its tests.
  That covers `engine-select`, `--keep` and the rig assertion; see §2/§3.
- **D6: the Docker test rig** (`engine-docker.test.ts`) had the same task-4
  gap and now forwards `options` too. That file has no attribution assertion.
- **D7: incident (no damage).** The first red run of the
  `TENTACLE_ENGINE` main test ran before the test env was isolated. The env
  var was then ignored, so it took the kubernetes path, read the developer's
  real kubeconfig, and sent one pod create to the current context
  (`namespace openshift-dns`). The cluster refused it with **401
  Unauthorized**, so nothing was created. Every `--engine` main test now sets
  `TENTACLE_K8S_SERVER=http://127.0.0.1:9` along with the unreachable
  `DOCKER_HOST`.
- **D8: mutation artifact (removed).** Under M3 the undispatched word ran as
  a one-shot prompt against the test's fake model. It wrote `out.txt`
  (`hello from agent`) into the worktree root. I removed it. The dispatch
  test now `chdir`s into its temp dir, and M3b confirmed the file lands
  there.
- **D9: no live engine run.** `run --engine docker|podman` against a real
  Docker Desktop or Podman engine was not run (optional per the plan).

### 5. Gate

`bun run check` (after the code): typecheck ✓, lint ✓ (540 files, 0
errors/0 warnings), test **3246 pass / 3 skip / 0 fail** (3249 tests, 250
files). Against the baseline: +35 tests and +3 files (`engine.test.ts`,
`podman-endpoint.test.ts`, `engine-select.test.ts`; the rename is
count-neutral). There are 3 skips, the same count as the baseline. Lint
needed `biome check --write` on 9 changed files; the fixes were formatting
and import order only.

**Unverified (one line each):**
- A live `tentacle run --engine docker --image debian:stable-slim` (and
  `--engine podman` after `podman machine start`), plus `--keep` → `tentacle
  attach --engine docker <name>`. Verify on Docker Desktop and Podman, then
  remove the kept container.
- The compiled-binary `__delete-*` path. Verify with a `bun build --compile`
  binary and a `run` + Ctrl+C.

## Review

*— claude-opus-5-5, 2026-10-27* (fresh context, but the **same model** as the
executor: blind spots we share survive both passes. For a load-bearing task,
AGENTS §10 says a different model should review.)

### Verdict: **REQUEST-CHANGES**

The design is correct and the k8s path behaves as before. Two things block
the merge. First, the real-cluster incident (D7) was fixed only locally, in
one `describe`; no structural guard exists. Second, `--keep` is not pinned at
the CLI boundary.

### Findings

1. **HIGH: no structural guard against real endpoints in tests.**
   `packages/cli/test/main.test.ts:163` and `:191` call
   `main(["bun","cli","run"])` and rely on "no `--image`" to fail. Those tests
   do not blank `TENTACLE_POD_IMAGE`, `TENTACLE_ENGINE`,
   `TENTACLE_K8S_SERVER` or `KUBECONFIG`. Their `beforeAll` (`:59-72`) only
   isolates the config dir and the model. If a developer's shell has
   `TENTACLE_POD_IMAGE` set (a documented user variable), the chain is:
   - the image check passes;
   - `checkPodBinaries` is a no-op from source (`pod-binary-build.ts:229`,
     `appVersion === "dev"`);
   - `buildEngineHost("kubernetes")` reads `$KUBECONFIG` / `~/.kube/config`
     (`engine-select.ts:191`, `kube-auth.ts:77-82`);
   - a **real `POST …/pods`** reaches the current context. That is the D7
     path again.

   With `TENTACLE_ENGINE=docker` and an image set, the same tests dial the
   real `/var/run/docker.sock` or `DOCKER_HOST`. No `bunfig.toml` exists and
   there is no `[test] preload`. The `unreachable` env at
   `main.test.ts:262-267` covers only the `--engine` describe. I proved this
   statically. The empirical check (a fake kubeconfig pointing at a local
   listener, with an env-prefixed `bun test`) needed approval, so I did not
   run it.

   **Fix (structural):** add a root `bunfig.toml` with
   `[test] preload = ["./test-env-guard.ts"]`. The preload should:
   - delete `TENTACLE_ENGINE`, `TENTACLE_POD_*`, `TENTACLE_K8S_*`,
     `TENTACLE_PROFILE`, `DOCKER_CONTEXT` and `DOCKER_TLS_VERIFY`;
   - set `KUBECONFIG`, `DOCKER_HOST` and `CONTAINER_HOST` to non-existent
     paths (`unix:///nonexistent/…`);
   - set `DOCKER_CONFIG` to a temp dir, so `currentContext` is never read;
   - make an exception only when an opt-in live flag is set
     (`TENTACLE_K8S_SERVER` for live-k8s, `TENTACLE_DOCKER_TESTS=1`);
   - include a guard test that asserts these variables are blanked.

   Tests that need an endpoint already set their own (`args.test.ts:253`).
2. **MEDIUM: `run --keep` → `keepHint` wiring is unpinned.**
   `packages/cli/src/main.ts:619`. Mutation R1 (`...(false &&
   runBools.has("keep")`) leaves `packages/cli/test` at **573 pass / 0 fail**.
   If the flag were dropped, `--keep` would be parsed and accepted, and the
   pod/container would then be **deleted**. That is the opposite of what the
   owner decided, and nothing would fail. The runtime tests (k8s + docker)
   pin only the runtime. Wanted: a `main` test where `run --keep` reaches the
   runtime with a hint. One way is the `args.test.ts` mock k8s server: assert
   that no `DELETE` is sent after a failed startup, plus the `kept … resume
   with: tentacle attach --engine kubernetes -n dev <name>` line.
3. **LOW: the resume hint can be wrong.** `attachCommand`
   (`engine-select.ts:97-110`) carries only `-n` or `--context`. After
   `run --keep --insecure-docker-tcp` on a plaintext `tcp://`, the printed
   `tentacle attach --engine docker <name>` fails with "refusing plaintext".
   An endpoint that came from `DOCKER_HOST`, `DOCKER_CONTEXT` or
   `CONTAINER_HOST` is also not named. That one works only if the env is
   unchanged. Add `--insecure-docker-tcp` when it was given, and consider
   naming the endpoint's `source`.
4. **LOW: stale references to the old names.** `AGENTS.md:164` still says
   "the invariant comment on `runPodTui`" (now `runEngineTui`): this is a §7
   invariant pointer. `TODO.md:70` (an open item) points at
   `cli/test/pod-runtime.test.ts` (now `engine-runtime.test.ts`). `README.md`,
   `F4-pod-execution.md` and the code are clean (`rg`). Older eval docs keep
   the old `file:line`s as history, which is acceptable.
5. **NOTE: git history (D1).** The plain `mv` shows up as `D` + `??`. The
   rename is kept only if the commit stages both sides
   (`git add -A packages/cli/{src,test}`, then check that `git diff --cached
   -M --stat` shows `pod-runtime.ts => engine-runtime.ts`). Otherwise
   `git log --follow` loses F4's history. Check this at commit time.

### Gate (re-run by me)

`bun run check`: typecheck ✓, lint ✓ (540 files, no fixes), test **3246 pass
/ 3 skip / 0 fail** (3249 tests, 250 files, 122.5 s). This matches Execution.
The 3 skips are the opt-in ones.

### Mutations (backed up with `cp`; after restoring, `shasum` is identical: `main.ts a0eb0dfa…`, `engine-select.ts fd23ac0a…`, `podman-endpoint.ts 20526f9f…`)

| # | Mutation | Result |
|---|---|---|
| R1 | `main.ts:619` drops the `--keep` → `keepHint` wiring | **GREEN, a gap** (finding 2) |
| R2 | `chooseEngine` ignores `TENTACLE_ENGINE` | RED: 2 `chooseEngine` tests |
| R3 | podman reads `DOCKER_HOST` in place of `CONTAINER_HOST` | RED: 5 tests (the ignored-`DOCKER_HOST` test, `CONTAINER_HOST` precedence, tcp refusal, ssh error, `buildEngineHost` podman) |

The executor's M1–M5 cover the runtime `--keep`, the dispatch pins and the
rig attribution. I did not re-run them. R2 and R3 agree with their M4/M5.

### Premise table

| Premise | Verdict |
|---|---|
| Symptom: `--engine` is unknown on `main` (strict `ARGS`) | TRUE (the executor's red at §2: `unknown option --engine`; `flags.ts:85-96` now lists it) |
| Choosing the engine = choosing the host; ONE call per mode | TRUE (`main.ts` diff: a single `startEngineRuntime` / `attachEngineRuntime`, `runEngineTui`) |
| `loadPodAuth` moved verbatim | TRUE (`engine-select.ts:184-200` vs the removed `main.ts` block; only D2, now inside the `try`) |
| Exit-net dispatch was hand-matched literals | TRUE (diff: `"__delete-pod"`/`"__delete-container"` → shared constants) |
| No project config layer | TRUE (`engine:` lives in `settingsShape`, file + profile) |
| `DOCKER_HOST` names Docker, ignored for podman | TRUE (`podman-endpoint.ts:82-100`; R3) |

### Attacks tried

- **Precedence** flag > env > profile > file > kubernetes
  (`engine-select.ts:43-55`). Empty env counts as unset. An unknown value from
  the flag or env is an error that names its source and never falls back. A
  bad `engine:` in the config is a zod `[config error]`. **Holds.**
- **Engine flag on the wrong engine** (`-n`/`-c` with docker/podman,
  `--context`/`--insecure-docker-tcp` with kubernetes): a usage error before
  sessions or auth (`main.ts selectEngine`). `TENTACLE_POD_NAMESPACE` is
  ignored off kubernetes. `--keep` exists on `run` only (`flags.ts:87` vs
  `:94`). **Holds.**
- **Podman discovery:**
  - macOS: `$TMPDIR/podman/podman-machine-default-api.sock`, then other
    `*-api.sock`, then the podman-4 paths.
  - Linux: XDG, then `/run/user/<uid>`, then rootful.
  - `--context` > `CONTAINER_HOST` > discovery. `ssh://` is a loud error.
    When nothing is found, the error lists the paths and gives the commands
    to start Podman. `DOCKER_HOST`/`DOCKER_CONTEXT` are ignored.

  **Holds.** Unreachable engine: A's `dialError` gives the
  `[container] failed: Docker engine socket not found …` line, pinned end to
  end in `main.test.ts:269-293`.
- **`--keep` lifecycle** (`engine-runtime.ts:247-266, 301-305, 327, 347`):
  - no exit net is armed (`exitListeners` = `[]`);
  - no remove on dispose or on a startup failure;
  - the kept line is logged after `status.finish()` and before the TUI
    mounts, so it survives the alt-screen and a Ctrl+C;
  - it is logged again from `dispose`, which runs after unmount.

  It is never written raw while Ink owns the terminal (§7). Without
  `--keep`, `registerExitCleanup` + remove behave as before (the existing
  delete/besteffort tests are green). D4 (no hint on a Ctrl+C *during*
  startup) is honest and acceptable. **Holds at the runtime; unpinned at the
  CLI (finding 2).**
- **`attach` never creates or deletes:** `attachEngineRuntime` has no
  `registerExitCleanup` or remove, and `attach --engine docker` is pinned to
  fail at inspect (`main.test.ts:286-293`). **Holds.**
- **Exit-net pins (B finding 1):** constants are shared by the builders and
  `main.ts:222/229`, plus a dispatch test per constant (M3/M3b red). **Holds.**
- **Task-4 rig gap:** `SpyFakeCluster` forwards `(req, options)`, and the
  single-broker test asserts `{toolCallId:"tc1", origin:"call"}`
  (`engine-runtime.test.ts:405`). **Closed.**
- **Secrets / model on the laptop:** no new argv secret. Docker and podman
  reuse B's `dockerEngineHost` (endpoint via env to the exit child). The model
  provider path is unchanged (`daemonInPod: true`, proxy). **Holds.**
- **Real cluster / socket isolation:** I grepped for `KUBECONFIG`, `.kube`,
  `DOCKER_HOST`, `CONTAINER_HOST` and `TENTACLE_ENGINE` in the tests and found
  no preload. `buildEngineHost` takes an `io`, but the kube branch still
  calls the real `loadKubeClientOptions` (`engine-select.ts:191`; it is not
  injected through `io`). **Fails: finding 1.**

### How the executor behaved

- Disciplined and honest. It disclosed the real-cluster incident (D7) and the
  stray `out.txt` (D8) instead of hiding them. It showed red by mutation
  where the test was written after the code (D5) and said so.
- Its fix for D7 was local (one `describe`), when the class of bug needed a
  harness guard. That is the one judgement gap: the incident deserved the
  structural fix.
- It did not claim a live run (D9).

> **Owner decision (2026-10-27): `--keep` on `run`** (all engines: kubernetes, docker, podman). With `--keep`, `run` does NOT delete the pod/container on exit — normal exit AND Ctrl+C (the delete-on-exit net is not armed) — and prints how to resume, e.g. `tentacle attach --engine docker <name>`. Without `--keep`, behaviour unchanged (create + delete). `attach` is unchanged (never creates/deletes).
> **Owner decision C-Q1 (2026-10-27):** default engine from `engine:` in the USER config file and in profiles, plus env `TENTACLE_ENGINE`; precedence flag > env > profile > user config > `kubernetes`. Per-repo config = a separate eval (needs project-hook-like trust).
> **Owner decision C-Q2 (2026-10-27):** the cwd IS mounted into the container, but in its own slice `feat/docker-workspace-mount`, done TODAY right after C. Not in this task.
> **Plan APPROVED (2026-10-27)** with C-Q1, C-Q2 and `--keep`.

> **CHANGED (owner 2026-10-27, supersedes "DEFAULT false"):** `--keep` / `keep:` DEFAULT is **TRUE** — `run` keeps the pod/container unless `--keep=false` or `keep: false` (user config/profile). Precedence unchanged: flag > profile > user config > true. Without keep (`--keep=false`) the old create+delete behaviour, delete-on-exit net armed.

### Execution — review fixes

1. **HIGH, test env guard.** `bunfig.toml` `[test] preload` → `scripts/test-preload.ts` → `applyTestEnvGuard` (`scripts/test-env-guard.ts`): deletes `TENTACLE_*`, points `KUBECONFIG`/`DOCKER_HOST`/`CONTAINER_HOST` at nonexistent paths and `HOME`/`XDG_*` at a temp dir. Opt-ins stay when set explicitly: `TENTACLE_K8S_SERVER` (+TOKEN/NAMESPACE), `TENTACLE_DOCKER_TESTS=1` (+`TENTACLE_DOCKER_*`, docker client env, HOME), `TENTACLE_SLOW_TESTS=1`. Proof: fake listener + kubeconfig + `TENTACLE_POD_IMAGE` in the env; guard neutralised → 2× `POST /api/v1/namespaces/dev/pods` reached it (RED); guard on → none. One-line note in AGENTS §6. (Removing `bunfig.toml` itself was denied by the sandbox, so the mutation neutralised the preload call instead; restored by `cp`, shasum identical.)
2. **MEDIUM, `--keep` wiring.** Test seam `CliIO.startEngineRuntime`; 7 `main` tests. Mutations: `kept.keep`→`false` → 6 fail; `insecureTcp: false` → 1 fail; restored from `cp` (shasum identical).
3. **Owner decision.** `--keep` is an optional-value flag (`ARGS.run.optional`, never swallows the next word): `--keep`, `=true`, `=false`; `keep:` in user config and profiles; default TRUE; flag > profile > user config > true; other value → error. Help/README/AGENTS lifecycle/defaults updated.
4. **LOW.** The hint carries `--insecure-docker-tcp` (`attachCommand` + main wiring, tested).
5. **LOW.** `AGENTS.md` `runPodTui` → `runEngineTui`; `TODO.md` test name. `git status` shows the rename pairs (`pod-runtime*` deleted, `engine-runtime*` new).

Gate: `bun run check` green, 3268 pass / 3 skip / 0 fail; lint clean.

*— claude-sonnet-5-5, 2026-10-27*

### Review — fix round

*— claude-opus-5-5, 2026-10-27* (fresh context. The executor of this round was
claude-sonnet-5-5, a different model, so the review is cross-model.)

#### Verdict: **REQUEST-CHANGES** (one MEDIUM hole in the guard, so a small fix)

Findings 2–5 of the first round are closed. Finding 1 is closed for the
documented way to run tests (`bun test` from the repo root, with or without a
file). It is **not** closed when `bun test` runs from inside a package dir: I
proved that hole empirically.

#### Findings

1. **MEDIUM: the guard does not apply when `bun test` runs from a package
   dir.** `bunfig.toml` is read from the cwd only. Running
   `bun test test/main.test.ts` with cwd `packages/cli` and a hostile env sent
   **2× `POST /api/v1/namespaces/dev/pods`** to the listener (the D7 path). With
   cwd `packages/cli` and `TENTACLE_ENGINE=docker`, `bun test test` sent
   **2× `GET /_ping`** to the fake `DOCKER_HOST`, and 2 tests failed. No package
   has a `test` script, so this is not the documented path. But IDE runners and
   a habitual `cd packages/x` take it. AGENTS §6 claims "no test reaches real
   infra", and that claim is unconditional.

   **Fix:** a `bunfig.toml` in each package and in `apps/mobile`, with
   `preload = ["../../scripts/test-preload.ts"]`, plus a guard test run from
   that cwd. Alternatively, fail closed: the root preload sets a marker, and a
   tiny import in every test entry asserts the marker. If the owner prefers not
   to fix it, AGENTS §6 must at least say "run from the root only".
2. **LOW: the resume hint omits `--bin-dir`.** See `main.ts:636-641` and
   `engine-select.ts:111-128`. After `run --bin-dir /tmp` (a read-only rootfs,
   the case the help text recommends), `attach` without `--bin-dir` behaves
   like this:
   - its probe runs the on-PATH `tentacle` (`engine-runtime.ts:445-450`);
   - `/tmp` is not on PATH, so it re-injects into `/usr/local/bin`;
   - on a read-only rootfs, that fails.

   This is from static reading; I did not execute it. It does not apply when
   the install dir came from `TENTACLE_POD_BIN_DIR`, because the env is
   inherited. Fix: repeat `--bin-dir <dir>` when it was given.
3. **NIT: stale `runPodTui` comments.** They are at `packages/tui/src/run.tsx:34`,
   `packages/tui/src/App.tsx:276`, `packages/tui/test/app.test.tsx:1791` and
   `packages/cli/test/connect.test.ts:647`. The function is now `runEngineTui`.
   The test-local `startPodRuntime` shim (`engine-runtime.test.ts:52-56`) is
   deliberate and documented, so it is fine. Mentions in done `TODO.md` items
   and in F4 are history.
4. **NOTE: the opt-ins apply to the whole process.** With `TENTACLE_K8S_SERVER`
   (or `TENTACLE_DOCKER_TESTS=1`) set on a root `bun test`, every test that
   reaches `buildEngineHost` gets the live endpoint. The live files document
   running them alone, so this is acceptable. Ideally §6 says so in one line.
5. **NOTE (carried over): the rename.** `git status` shows `D pod-runtime*` +
   `?? engine-runtime*`. Rename detection happens only at commit time: stage
   both sides, then check `git diff --cached -M --stat`.

#### Guard proof (repro in `.tentacle/tmp/review-fix-guard/`, not committed)

The rig works like this:
- `listener.ts` starts an in-process `Bun.serve`: tcp `127.0.0.1:18443` (a fake
  k8s API) and unix sockets `docker.sock` / `podman.sock`. It logs every
  request to `hits.log` and writes a fake `kubeconfig` (server = that
  listener, namespace `dev`).
- `run-core.ts` spawns `bun test <args>` with a **hostile env**:
  `KUBECONFIG=<fake>`, `TENTACLE_POD_IMAGE=evil:1`, `TENTACLE_ENGINE=<e>`,
  `TENTACLE_POD_NAMESPACE=dev`, `DOCKER_HOST` and `CONTAINER_HOST` pointing at
  the fake sockets.
- The sanity check (a direct fetch) logged `k8s GET /sanity` and
  `docker GET /sanity`.

| Run (cwd = root unless stated) | Tests | Hits |
|---|---|---|
| `packages/cli`, engine kubernetes | 911 pass / 0 fail | **0** |
| `packages/cli`, engine docker | 911 / 0 | **0** |
| `packages/cli`, engine podman | 911 / 0 | **0** |
| `packages/cli/test/main.test.ts` (single file) | 21 / 0 | **0** |
| **Control:** the preload call neutralised (`cp` backup) | k8s 1 fail, docker 2, podman 2 | **2× POST pods; 2× docker `/_ping`; 2× podman `/_ping`** (RED, so the rig detects a hit) |
| Opt-in `TENTACLE_DOCKER_TESTS=1` on the docker live file | it reached the fake socket (`GET /_ping`; it fails on my 500) | 1, as intended |
| Opt-in `TENTACLE_K8S_SERVER=<listener>` on the k8s live file | `POST …/default/pods` reached it | 1, as intended |
| Opt-in `TENTACLE_SLOW_TESTS=1` on `ws-server.test.ts` | 12 pass (the keepalive ran) | 0 |
| **cwd `packages/cli`**, `test/main.test.ts` | 21 pass | **2× POST pods**: finding 1 |
| **cwd `packages/cli`**, `test`, engine docker | 589 pass / 2 fail | **2× `/_ping`**: finding 1 |

The preload is applied for the root `bun test` across every package (one
process, one preload) and for `bun test <single file>`, but only from the
root.

#### Mutations (each backed up with `cp` and restored; `shasum` is identical before and after: `test-preload.ts 7b193224…`, `main.ts 825523ff…`, `engine-runtime.ts c0abd43c…`, `engine-select.ts cb7c18a5…`)

| # | Mutation | Result |
|---|---|---|
| G | `test-preload.ts` no longer calls `applyTestEnvGuard` | RED: real requests reach the listener (the table above) |
| K1 | `main.ts:634` `kept.keep` → `false` (the flag/config → `keepHint` wiring is cut) | RED: 6 of the 7 `--keep wiring` main tests |
| K2 | `engine-runtime.ts:264` `!keptLine` → `false` (no exit net without keep) | RED: 2 tests (`registers a process-exit cleanup…` k8s, `create → net armed…` docker) |

#### First-round findings vs the fix

| # | Status |
|---|---|
| 1 guard | **Partly closed.** Holds from the root (proven); the package-cwd hole is new finding 1 |
| 2 `--keep` wiring | **Closed.** The `CliIO.startEngineRuntime` seam; K1 red |
| 3 `--keep[=bool]`, default TRUE | **Closed.** See the details below |
| 4 resume hint | **Mostly closed.** `--insecure-docker-tcp` is carried (tested); `--bin-dir` is missing (finding 2) |
| 5 stale names / rename | **Closed in `AGENTS.md` and `TODO.md`.** Comments remain in tui/test (finding 3); the rename shows as D + `??` (finding 5) |

Details for row 3:
- `resolveKeep` (`engine-select.ts:96-108`): the value beats the bare flag,
  which beats the configured value, which falls back to `true`. An invalid
  value is a loud error.
- `keep:` comes from the file or a profile (`resolve.ts` diff).
- Precedence flag > profile > user config > true is pinned
  (`main.test.ts:399-411`).
- `--keep=false` sends no hint (`main.test.ts:389-391`). At runtime, no hint
  means the exit net is armed and the workload is removed (K2 red).
- `--keep` never swallows the name (`main.test.ts:394`).

#### Gate (re-run by me)

`bun run check`: typecheck ✓, lint ✓ (545 files, no fixes), test **3268 pass
/ 3 skip / 0 fail** (3271 tests, 253 files, 135.8 s). This matches Execution;
the 3 skips are the opt-in ones.

#### Attacks tried

- **A hostile shell env against the full cli suite, for each of the 3
  engines:** 0 hits. **Holds.**
- **A single file from the root:** 0 hits. **Holds.**
- **Running from a package cwd:** hits. **Fails** (finding 1).
- **The opt-ins still reach their endpoint** (docker, k8s and slow): **holds.**
- **Podman discovery via `$TMPDIR`** (a real podman machine socket is not
  hidden by the guard): with `CONTAINER_HOST` set, it wins over discovery, and
  no test unsets `DOCKER_HOST`, `CONTAINER_HOST`, `KUBECONFIG` or `HOME` (`rg`).
  **Holds**, though only by precedence.
- **`--keep` swallowing the next word, an invalid value, a profile vs the user
  config:** all are pinned. **Holds.**
- **Does the hint carry every reconnect flag?** `--bin-dir` is missing
  (finding 2). Quoting of `-n` / `--context` with shell metacharacters is not
  handled, which is cosmetic because these values are user-supplied.

#### How the executor behaved

- Honest and thorough. The guard is well built (opt-ins, the guard test, the
  §6 note), and its own empirical proof with the control RED matches mine.
- It disclosed that the sandbox stopped it removing `bunfig.toml`, and how it
  worked around that.
- It never tested a non-root cwd, so the claim "structural" is larger than
  what it proved. That is the same judgement gap as round 1, smaller this
  time: it proved the property for the path it ran, not for every path to the
  same state (AGENTS §2).

### Execution — fix round 2

1. **Guard from a package cwd (MEDIUM).** The orchestrator added `packages/*/bunfig.toml`
   (`[test] preload = ["../../scripts/test-preload.ts"]`); I did not touch them. The guard
   self-test is the existing `packages/cli/test/test-env-guard.test.ts` ("the preload is
   active in this process": `KUBECONFIG` starts with `NONEXISTENT`, `HOME` is the temp
   scratch). It runs from the root and from `packages/cli`. From `packages/cli`:
   `bun test test/test-env-guard.test.ts` → 5 pass (GREEN). With the preload absent
   (`bun test --config=<empty toml> test/test-env-guard.test.ts` from `packages/cli`) →
   4 pass / **1 fail** (`KUBECONFIG` received `undefined`) (RED).
   Drift: the sandbox forbids touching `bunfig.toml` (even `cp`), so instead of moving
   the file aside + `shasum`, I proved RED with `--config` pointing at an empty file.
   The bunfig is untouched by construction. `apps/mobile`: its only bun test,
   `test/rn-websocket.test.ts`, imports only `webSocketChannelFactory` from `@tentacle/client`
   (no engine/cluster path), so it needs no bunfig.
2. **Resume hint (LOW).** `attachCommand` takes `binDir` and emits `--bin-dir <dir>` after
   the scope (`engine-select.ts`); `main.ts` passes `binDir`. Tests: `engine-keep.test.ts`
   (docker, k8s) and `main.test.ts` (`--bin-dir /tmp` → hint). RED by mutation (both
   source lines removed): 2 fail; restored → 29 pass.
3. **NIT.** `runPodTui` → `runEngineTui` in `tui/src/run.tsx`, `tui/src/App.tsx`,
   `tui/test/app.test.tsx`, `cli/test/connect.test.ts`; no `runPodTui` is left in `packages`.

*— claude-sonnet-5-5, 2026-10-27*

> **Owner (2026-10-27):** merge approved.
