# feat/docker-engine-seam — one `EngineHost` seam for `run`/`attach` (k8s moved behind it, Docker/Podman as the second impl)

> **Status:** executed (B.1 + B.2), awaiting fresh-context Review — gate needs `bun install` first (see Execution §0)
> **Branch:** `feat/docker-engine-seam`
> **Type:** feat · **Size:** L · **Blast:** load-bearing · **Suited:** strong model (Opus-class) executes; **mandatory fresh-context Review** red-teaming AGENTS §7 "TUI always over RPC — one session path", "Pod lifecycle" (never delete on `attach`, exit net), "Compute next to the code… a pod is not trusted" and "Single-broker invariant".

## Context

*— claude-opus-5-5, 2026-10-26*

TODO Roadmap item 4, **slice B** of `docs/eval/docker-runtime.md` (decided). The
owner wants `run`/`attach` to target Kubernetes **or** a Docker/Podman engine
through ONE path. Slice A (`packages/docker`, the engine client) is merged;
slice A2 (`ssh://` dialer) is in flight on `feat/docker-ssh-dialer` and is
**not** a dependency of B beyond the `Dialer` type A froze
(`packages/docker/src/byte-duplex.ts:36`). Slice C is the CLI
(`--engine kubernetes|docker|podman`, config `engine:`, podman socket
discovery, `--context`, bind-mount, `--insecure-docker-tcp`).

What B delivers:
1. a backend-neutral seam (`EngineHost`, name to confirm — Owner Q1) that the
   whole `run`/`attach` runtime and the binary injector are written against;
2. the k8s implementation moved behind it with **zero behaviour change**
   (proved by the existing `pod-runtime.test.ts` passing **unmodified**);
3. the Docker/Podman implementation of the seam over `DockerClient`, plus its
   exit net, exercised by fakes. No user-visible flag: nothing selects Docker
   until C, so B changes no behaviour a user can reach (except the hidden
   `__delete-container` child entry).

Constraints (AGENTS §7, binding): one session path — a new target adds only a
transport + lifecycle (`AGENTS.md:142`); `run` creates+deletes with an exit net
that survives `process.exit`, `attach` never creates/deletes, secrets via env
never argv (`AGENTS.md:257`); the container is not trusted and the model stays
on the laptop (`AGENTS.md:190`, `:194`); never write raw while Ink owns the
terminal (`AGENTS.md:251`); single broker (`AGENTS.md:161`).

**Repro** (2026-10-26, `main` `efd8fa6`) — the capability is missing: the CLI
has no caller of the engine client, and the runtime's only host type is the
k8s-shaped `PodCluster`.

```
$ rg -c "@tentacle/docker" packages/cli packages/k8s
(no output — zero references)
$ rg -n "export interface PodCluster" packages/cli/src/pod-runtime.ts
137:export interface PodCluster {
```

## Implementation

*— claude-opus-5-5, 2026-10-26*

### Load-bearing assumption

**The `run`/`attach` runtime and the injector touch the cluster ONLY through
the `PodCluster` interface, so wrapping a `PodCluster` in an adapter that
implements a neutral seam changes nothing observable for k8s.**

Proof:
- `PodCluster` is the injectable subset of `KubeClient`
  (`packages/cli/src/pod-runtime.ts:136-148`): `createPod/getPod/waitForReady/deletePod/deletePodBestEffort/openExec/runExec`.
- `startPodRuntime` reaches the cluster only via `deps.kube`
  (`pod-runtime.ts:337`, `:351`, `:355-358`, `:379-380`, `:392`, `:412`) plus
  three pure k8s imports: `buildPodManifest` (`:338`), `AGENT_CONTAINER`
  (`:359`, `:375`), `KubeApiError` in translators (`:168-183`, `:220-233`).
- `startAttachRuntime` likewise: `deps.kube.getPod` (`:465`), `TERMINAL_PHASES`
  / `podIsReady` (`:480-490`), `runExec` (`:514`, `:563`), `openExec` (`:620`),
  `KubeApiError` (`:471`).
- The injector takes `Pick<PodCluster, "runExec">` only
  (`packages/cli/src/pod-binary.ts:135`, `:155`); its targets are built at
  `:140-142`, `:279-287`, `:314-315`.
- `main.ts` builds `new KubeClient(auth.options)` and passes it as `kube`
  (`packages/cli/src/main.ts:552-559`, `:599-606`) — the only construction site.
- The existing suite already drives the runtime through a `FakeCluster
  implements PodCluster` (`packages/cli/test/pod-runtime.test.ts:79-135`, 74
  references in that file). If `startPodRuntime`/`startAttachRuntime` keep
  their signatures and internally wrap `deps.kube` in the k8s adapter, those
  tests are the zero-behaviour-change oracle **without being edited**.

### Preconditions

- **Transport is already neutral.** The RPC layer needs only a `DuplexChannel`;
  both clients return one: k8s `openExec` (`packages/k8s/src/client.ts:205-209`),
  Docker `openExec` (`packages/docker/src/client.ts:378-380`).
- **One-shot exec results are structurally identical**: k8s `RunExecResult
  {exitCode: number|null, stdout, stderr, status?}` (`packages/k8s/src/exec-run.ts:42-56`)
  = Docker's (`packages/docker/src/types.ts:52-61`); options `{timeoutMs?, signal?,
  onProgress?}` identical (`k8s exec-run.ts:59-70`, `docker types.ts:63-70`).
  `ExecChannelOptions.onStderr` exists on both (`k8s exec-channel.ts:49-51`,
  `docker types.ts:72-74`).
- **Exec targets differ only in naming**: k8s `{pod, container?, command}`
  (`k8s exec-channel.ts:244-251`) vs Docker `{container, command, user?, workingDir?}`
  (`docker types.ts:42-50`). The seam's target is `{name, container?, command}`.
- **Exit-code consumers only test `!== 0`**: `containerDecision`
  (`packages/cli/src/container-version.ts:77-80`), the injector
  (`pod-binary.ts` install check after `:299`, verify after `:314`). So Docker's
  real codes (127 etc.) and k8s's 0/1 are interchangeable.
- **stdin EOF**: k8s v4 cannot half-close, hence `head -c N` in the install
  command (`pod-binary.ts:279-287`, `AGENTS.md:262`). Docker's `runExec`
  half-closes after the input (`packages/docker/src/exec-run.ts:74`, eval P3 "Half-close
  works"); `head -c N` still terminates on it, so **the install command stays
  verbatim** — one injection path for both engines.
- **Docker verbs exist** (A): `pullImage` (`docker/client.ts:199`),
  `createContainer` adds `OWNER_LABEL` (`:232-258`, label const `:51`),
  `startContainer` (`:261`), `inspectContainer` (`:280`), `removeContainer`
  refuses a container without `OWNER_LABEL` and is bounded, kill-first,
  404-idempotent (`:300-335`), `waitForRunning` (`:337-375`), errors are
  `DockerApiError(status, engineMessage, body)` (`docker/src/http-conn.ts:17-33`).
  **Not** in A: best-effort delete / exit net (`docs/feat/docker-engine-client.md:302`).
- **k8s exit net** (to mirror, not change): detached+`unref`'d child, env-only
  secrets, compiled → `[execPath, "__delete-pod"]`, source → `bun -e <script>`
  (`packages/k8s/src/pod-cleanup.ts:143-196`); dispatched at `main.ts:199-202`;
  registered right after create (`pod-runtime.ts:291-295`, `:347`).
- **A2's dialer interface** (from its doc, `docker-engine-client.md:305-325`):
  `sshDialer(ep: SshEndpoint, options?) : Dialer`. B relies on nothing else.
- **Pod daemon command carries no secret** (`pod-runtime.ts:56-74`); the
  model is reverse-tunnelled (`laptopModels`, `:84-98`). Unchanged for Docker:
  no secret enters the container.

### Design

**1. The seam — `packages/cli/src/engine-host.ts` (new, types only).**

```ts
type EngineKind = "kubernetes" | "docker" | "podman";
interface EngineExecTarget { readonly name: string; readonly container?: string; readonly command: readonly string[] }
type WorkloadState =
  | { kind: "ready" }
  | { kind: "starting"; detail: string }      // pulling / restarting — bounded wait
  | { kind: "stopped"; detail: string };      // terminal / not runnable — refuse
interface EngineHost {
  readonly kind: EngineKind;
  readonly noun: "pod" | "container";        // log/UI vocabulary ("[pod] …")
  readonly where: string;                     // `namespace dev` | `context "desktop-linux"`
  readonly defaultContainer?: string;         // k8s: AGENT_CONTAINER on `run`; docker: none
  create(name: string, image: string): Promise<void>;           // translated errors
  waitForReady(name: string, opts?: { timeoutMs?: number }): Promise<void>; // docker: start + waitForRunning
  inspect(name: string): Promise<WorkloadState>;                // attach preflight; translated not-found
  dialVerdict(name: string): Promise<ChannelError | null>;      // reconnect preflight
  remove(name: string): Promise<void>;
  removeBestEffort(name: string): void;                         // exit net; never throws, never blocks
  openExec(t: EngineExecTarget, o?: { onStderr?(s: string): void }): DuplexChannel;
  runExec(t: EngineExecTarget, input?: Uint8Array, o?: RunExecOptions): Promise<RunExecResult>;
  execError(error: unknown, t: { name: string; container?: string }): Error; // wrong-container etc.
}
```
Shared result/option types are declared here (structural copies of the two
identical package shapes), so the CLI imports neither package's version.

**2. The runtime — `pod-runtime.ts`, generalised in place** (keeps blame and
every test import). New `startEngineRuntime(config, deps & {host})` and
`attachEngineRuntime(config, deps & {host})` are the current bodies with every
`deps.kube.*` / k8s helper replaced by the `host` call; log lines are built
from `host.noun` / `host.where` so the k8s strings stay **byte-identical**
(e.g. `[pod] creating X (image I) in namespace N…`, `:335`). `startPodRuntime`
and `startAttachRuntime` keep their exact signatures and become 3-line
wrappers: `startEngineRuntime(config, {...deps, host: kubeEngineHost(deps.kube, deps.namespace)})`.
`execChannelFactory` takes the host (`dialVerdict` then `openExec`); the exit
net becomes `process.once("exit", () => host.removeBestEffort(name))`.
**Still ONE path**: Docker gets no runtime of its own — `createLocalRuntime(…,
daemonKind: "container")` is called from the same two places.

**3. k8s impl — `packages/cli/src/engine-k8s.ts` (new).**
`kubeEngineHost(kube: PodCluster, namespace)`: `PodCluster` moves here
(re-exported from `pod-runtime.ts` so tests don't change). Moved verbatim:
`podCreateError` (`pod-runtime.ts:160-183`), `containerExecError` (`:191-207`),
`podDialError` (`:216-243`, still exported), the attach 404 message (`:468-476`),
the terminal-phase refusal (`:480-485`). `create` = `createPod(buildPodManifest(...))`;
`waitForReady` = `kube.waitForReady`; `inspect` maps `podIsReady`/`TERMINAL_PHASES`;
target `name` → `pod`.

**4. Docker/Podman impl — `packages/cli/src/engine-docker.ts` (new).**
`dockerEngineHost({ client: DockerClientLike, endpoint: EngineEndpoint, kind:
"docker"|"podman", spawn? })` — `DockerClientLike` = the `DockerClient` subset
(injectable, like `PodCluster`).
- `create`: `createContainer(name, containerBody(image))`; on 404 (no such
  image) → `pullImage` → create again (parity with k8s pulling
  `IfNotPresent`); 409 → *"a container named X already exists on <where> —
  pick another name or `docker rm X`"*. `containerBody` (pure, exported for
  tests): `{Image, Cmd:["sleep","infinity"], Labels:{"tentacle.managed-by":"tentacle"},
  HostConfig:{Privileged:false}}` — **no** binds (C), no socket mount, no host
  network/pid, no `AutoRemove` (it races our `DELETE` with a 409 "removal in
  progress"), no TTL (k8s `run` sets none either, `pod-runtime.ts:338`).
- `waitForReady`: `startContainer` then `waitForRunning` (a start failure is
  inside the runtime's try → removed, like a never-ready pod).
- `inspect`: `Running` → ready; `restarting` → starting; `created` / `exited`
  / `dead` / `paused` → stopped with an actionable detail (`docker start` /
  `docker unpause`; **attach never starts a user container**); 404 →
  *"container X not found on <where> — `docker ps`; use `run` to create one"*.
- `dialVerdict`: 404 or exited/dead → `gone`; anything else (dial error,
  5xx, paused) → `unreachable` (`dialError` returns a plain `Error`,
  `byte-duplex.ts:55-100`, so no auth class is distinguishable — noted debt).
- `remove`: `client.removeContainer(name)` (owner-label guard = defence in
  depth for "never delete on attach").
- `removeBestEffort`: `spawnContainerDelete(endpoint, name)` (below).
- `openExec`/`runExec`: target `name` → `container`; a non-empty
  `t.container` is rejected (Docker has no sub-containers; C rejects `-c` at
  parse, this is the backstop).
- `execError`: a 409 "is not running"/"is paused" → actionable; else as is.

**5. Docker exit net — `packages/docker/src/container-cleanup.ts` (new)** +
**`packages/docker/src/engine-dialer.ts` (new).**
- `dialerFor(ep)`: unix|tcp → `socketDialer(ep)`; ssh → `sshDialer(ep)` if A2
  has merged when B executes, else an actionable "ssh engines need the ssh
  dialer" error (one-line follow-up). Shared by C's wiring and the child.
- `spawnContainerDelete(ep, id, spawn = Bun.spawn)`: never throws; detached,
  `stdio: ignore`, `unref()`; env = parent env + `TENTACLE_CONTAINER_DELETE_ID`
  + `TENTACLE_DOCKER_ENDPOINT` (JSON of the endpoint **incl. TLS PEM contents**
  — secrets in env, never argv). Command: compiled → `[execPath,
  "__delete-container"]`; source → `["bun", "-e", "import {deleteContainerFromEnv} from <abs path of container-cleanup.ts>; await deleteContainerFromEnv()"]`
  (a path is not a secret; unlike the k8s static script this reuses the real
  client, so unix/TCP/TLS/ssh are one code path and the owner-label guard holds).
- `deleteContainerFromEnv(env, makeClient?)`: parse env → `new DockerClient({dial:
  dialerFor(ep)})` → `removeContainer(id, {timeoutMs: 15_000})`, all errors
  swallowed, exits.
- `main.ts`: hidden `__delete-container` next to `__delete-pod` (`main.ts:199-202`).
  `__delete-pod` and the k8s `bun -e` script are **untouched** (zero k8s change).

**6. Injector — `pod-binary.ts`**: `Pick<EngineHost, "runExec">`, target field
`pod` → `name`, `podName` → `name`, optional `noun` (default `"pod"`, so k8s
messages are unchanged) for the `[pod X]` prefixes (`:206-217`, `:306`, `:328`).

**Slice C becomes thin**: parse `--engine`/`engine:` → build either `new
KubeClient` → `kubeEngineHost`, or `resolveEngineEndpoint` (+ podman discovery)
→ `new DockerClient({dial: dialerFor(ep)})` → `dockerEngineHost` → call the
same `startEngineRuntime`/`attachEngineRuntime`. No runtime edit.

**Execution order (two checkpoints on the branch):** B.1 = §1-3 + §6
(pure refactor; gate green with `pod-runtime.test.ts` byte-unchanged — `git
diff main -- packages/cli/test/pod-runtime.test.ts` empty); B.2 = §4-5 + tests.

### Files

Dependency order (≈14 files, 2 packages + cli):
1. `packages/docker/src/engine-dialer.ts` (new) · 2. `packages/docker/src/container-cleanup.ts` (new) · 3. `packages/docker/src/index.ts` (2 exports; trivial rebase vs A2)
4. `packages/cli/package.json` (+ `@tentacle/docker`), `bun.lock`
5. `packages/cli/src/engine-host.ts` (new) · 6. `packages/cli/src/engine-k8s.ts` (new) · 7. `packages/cli/src/engine-docker.ts` (new)
8. `packages/cli/src/pod-runtime.ts` (generalise in place, wrappers kept) · 9. `packages/cli/src/pod-binary.ts` (target rename + `noun`)
10. `packages/cli/src/main.ts` (only `__delete-container`)
11. tests: `packages/docker/test/container-cleanup.test.ts`, `packages/docker/test/engine-dialer.test.ts`, `packages/cli/test/engine-docker.test.ts` (new); `packages/cli/test/pod-binary.test.ts` (FakeKube field rename only).
Not touched: `packages/k8s/**`, `packages/cli/test/pod-runtime.test.ts`, the A2 worktree, AGENTS/F4 wording (C).

### Failure modes

| Mode | Where | Converges to |
|---|---|---|
| Engine unreachable (socket missing / refused / EACCES / TLS) before create | `create` → `dialError` message (`byte-duplex.ts:55-100`) | `[container] failed: <actionable>`, nothing created, no exit net registered (net is registered only after create resolves, as k8s). |
| Image missing | `create` 404 → pull → retry; pull error line → reject (`docker/client.ts:199-229`) | actionable error, nothing created. |
| Name conflict | `create` 409 | actionable error; **never** removes the existing container (it is not ours; `removeContainer` would also refuse it). |
| Created, start fails / exits before running | `waitForReady` throws (`waitForRunning` :356-361) | runtime catch → `host.remove` (+ exit net already armed). |
| Injection fails (no `sh`, musl, arch) | unchanged injector messages (`pod-binary.ts:204-217`) | `run`: removed; `attach`: never removed. |
| Daemon exec create/start fails (409 not running, hijack error) | `openExec` channel closes with error → `createLocalRuntime` handshake fails | runtime catch: stderr flushed (pre-mount, safe), `run` removes. |
| Exec drops mid-session (engine restart, TCP reset) | `dialVerdict` → `gone` stops reconnect; `unreachable` retries | turn reported lost, never re-run (existing client-reattach behaviour). |
| Ctrl+C / `process.exit` mid-session | `process.once("exit")` → `removeBestEffort` → detached child | container killed+deleted; child bounded 15 s; spawn failure swallowed. |
| Ctrl+C **during** `create` | net not yet armed (same as k8s today, `pod-runtime.ts:347`) | possible orphan carrying `tentacle.managed` label — **debt** (k8s parity), cleanable by label in a later task. |
| Exit-net child secrets | env `TENTACLE_DOCKER_ENDPOINT` (TLS key) | never argv; test asserts argv has no PEM/id-bearing secret. |
| ssh endpoint before A2 merges | `dialerFor` | actionable error, no silent fallback. |
| `attach` on a stopped/created/paused container | `inspect` → stopped | refuse with the right `docker start`/`unpause` hint; never started, never removed. |
| `attach -c` on Docker | host rejects `container` | actionable error (C also blocks at parse). |
| Real exit codes (127, 126) vs k8s 0/1 | consumers test `!== 0` only | same decisions; messages show the real code. |
| stdin EOF | Docker half-closes; `head -c N` still exact | install identical on both engines. |
| Version skew pod/laptop | unchanged (`containerDecision`, `initialize` `VersionMismatch`) | — |
| `attach` dispose | runtime closes the exec only; no `remove`, no net | a test spies that `remove`/`removeBestEffort` are never called on attach (both engines). |

### Tests

- **Zero k8s change (B.1)**: `packages/cli/test/pod-runtime.test.ts` passes
  with an **empty diff**; `pod-binary.test.ts` changes only the fake's field
  name. Non-vacuity: mutate the k8s adapter (e.g. drop `removeBestEffort`
  wiring or swap `where`) → the existing "registers a process-exit cleanup"
  (`:483`) / message tests go red; revert.
- **`engine-docker.test.ts`** (new; `FakeDockerClient` recording calls, its
  `openExec` bound to a real daemon `Connection` exactly like `FakeCluster`,
  `pod-runtime.test.ts:109-121`): `run` = create → net armed → start → running
  → inject (`head -c` command verbatim) → exec `serve --stdio --model-proxy` →
  a real turn → dispose removes; 404 image → pull → create; 409 name; start
  fails → removed; injection fails → removed; `attach` running → reuse/inject,
  **never** `remove`/`removeBestEffort` even on failure; `attach` on
  exited/created/paused → refuse, no start; 404 → actionable; `-c` rejected;
  reconnect: exited → `gone` (no exec storm), dial error → `unreachable`;
  **single broker**: an `ask` tool's permission lands on the shared broker
  (copy `:333`); `containerBody` has no binds/Privileged/socket mount.
- **`container-cleanup.test.ts`** (injected spawner, like `PodDeleteSpawner`,
  `pod-cleanup.ts:61-65`): detached+ignore+unref; secrets only in env, never
  argv; compiled vs source command; spawn throw swallowed;
  `deleteContainerFromEnv` against A's `scriptedDialer`/`FakeDuplex`
  (`packages/docker/test/fake-duplex.ts`) issues inspect → kill → delete and
  swallows errors; a container without the owner label is NOT deleted.
- **`engine-dialer.test.ts`**: unix/tcp → socket dialer; ssh → A2 dialer or the
  actionable error.
- Gate: `bun run check` (lint baseline 0/0, AGENTS §6). The live Docker test
  (`TENTACLE_DOCKER_TESTS=1`) is optional for B; the end-to-end live run is C.

### Owner questions

1. **Seam name** — `EngineHost` vs `SandboxHost`. → **Recommend `EngineHost`**:
   it matches `--engine`/`engine:` (owner decision), and "sandbox" over-promises
   isolation that `attach` does not give (the same reason `--sandbox` was
   rejected).
2. **Rename `pod-runtime.ts` / `startPodRuntime` now?** The plan keeps the file
   and wrappers so the k8s oracle tests stay byte-unchanged. → **Recommend:
   keep in B, rename in C** (or a follow-up) once both engines are wired.

## Execution

*— claude-opus-5-5, 2026-10-26*

### 0. Baseline and environment (read first)

- **Gate baseline** (`bun run check`, branch at `6bb7d4a`, before any edit):
  typecheck ✓, lint ✓ (527 files, 0/0), test **3132 pass / 2 skip / 2 fail / 2
  errors** (3136 tests, 243 files). It is red for an **environmental** reason
  only: `packages/docker/test/ssh-dialer.test.ts` → `Cannot find module
  '@tentacle/core' from packages/docker/src/ssh-dialer.ts`, and
  `integration.live.test.ts` errors in the same load. `packages/docker/node_modules`
  does not exist: nobody ran `bun install` after A2 added the docker package's
  first runtime workspace import. `bun.lock` already lists those deps.
- `bun install --frozen-lockfile` (with and without `--filter '!@tentacle/mobile'`)
  **requires approval** in this session and was not run (two attempts, then
  stopped, AGENTS §0). I did not work around it (no hand-made symlinks).
- Consequence: anything that loads `@tentacle/docker` at runtime cannot resolve
  here: the new `cli → @tentacle/docker` dependency (also needs
  `packages/cli/node_modules/@tentacle/docker`) and `docker/src/ssh-dialer.ts`.
  The empirical stand-in is `bun test --tsconfig-override ./tsconfig.json`: it
  makes Bun resolve `@tentacle/*` through the root `paths` (the same map `tsc`
  uses). It was proven on the baseline failure (`ssh-dialer.test.ts`: 24 pass
  with the override, error without). Every narrow run of a docker-touching
  test below used it.
- **Owner action needed before Review/merge:** `bun install` (CI form:
  `bun install --frozen-lockfile --filter '!@tentacle/mobile'`). Then `bun run
  check` should be green with no override (§5).

### 1. Repro (capability missing, on the branch before any edit)

```
$ rg -c "@tentacle/docker" packages/cli packages/k8s
(no output)
$ rg -n "export interface PodCluster" packages/cli/src/pod-runtime.ts
140:export interface PodCluster {
$ rg -n "EngineHost" packages
(no output)
```

### 2. B.1: pure refactor (§1-3 + §6)

As built, in order:
1. `packages/cli/src/engine-host.ts` (new, types only): `EngineKind`,
   `EngineExecTarget {name, container?, command}`, `WorkloadState`,
   `EngineHost` exactly as Design §1, plus the shared shapes.
2. `packages/cli/src/engine-k8s.ts` (new): `PodCluster` (moved verbatim),
   `podCreateError`, `containerExecError`, `podDialError` (moved verbatim,
   still exported), and `kubeEngineHost(kube, namespace)`. `create` =
   `createPod(buildPodManifest)` with the translation. `inspect` maps
   `getPod` → ready / starting / stopped; the 404 message and the
   terminal-phase refusal are moved verbatim. `dialVerdict` = the old
   `execChannelFactory` try/catch. The target maps `name → pod` and passes
   `container` through, so the `container` key is still present-but-undefined
   as before.
3. `packages/cli/src/pod-runtime.ts`: generalised in place.
   - `startEngineRuntime(config, EngineRuntimeDeps)` and
     `attachEngineRuntime(config, EngineAttachRuntimeDeps)` hold the former
     bodies. Every `deps.kube.*` became a `host.*` call. Log and stderr prefixes
     are built from `host.noun` / `host.where`, and `run`'s container is
     `host.defaultContainer`.
   - `startPodRuntime` / `startAttachRuntime` keep their exact signatures and
     are now wrappers over `kubeEngineHost(kube, namespace)`.
   - `execChannelFactory(host, target, options)` now calls `dialVerdict`, then
     `openExec`. It is exported but has no external caller.
   - The exit net is `registerExitCleanup(host, name)` →
     `process.once("exit", () => host.removeBestEffort(name))`, registered at
     the same point (right after `create` resolves).
   - `PodCluster` and `podDialError` are re-exported, so the test imports are
     unchanged.
4. `packages/cli/src/pod-binary.ts`: `Pick<EngineHost,"runExec">`. Deps are
   `host`, `name` and an optional `noun` (default `"pod"`); the target field is
   `name`. The error prefixes are `[${noun} ${name}]`, so the k8s messages are
   unchanged. The install command is untouched.
5. `packages/cli/test/pod-binary.test.ts`: only the fake's target type
   (`EngineExecTarget` from `engine-host.ts`) and `kube,`/`podName:` →
   `host: kube,`/`name:` (9 diff lines).

**Zero-k8s-change proof:**
- `git diff --stat main -- packages/cli/test/pod-runtime.test.ts packages/k8s
  packages/docker/src/client.ts` → **empty**.
- `bun test packages/cli/test/pod-runtime.test.ts packages/cli/test/pod-binary.test.ts`
  → **88 pass / 0 fail** (same files and counts as on `main`).
- typecheck ✓ and lint ✓ after two hand fixes (import order, one template
  literal). `biome check --write` needs approval here.

**Oracle gap found, and closed with a new test (not by editing the oracle).**
`pod-runtime.test.ts` does not pin the phase log lines (`[pod] creating X
(image I) in namespace N…`, `[pod] attaching to X in namespace N…`, `[pod]
waiting for X…`). A mutation of `where` (M2 below) left it **green**, so the
plan's claim that "message tests go red" was false. I added
`packages/cli/test/engine-k8s.test.ts`, which pins them byte for byte through
`startPodRuntime` / `startAttachRuntime`, plus the `kubeEngineHost` mapping
(vocabulary, inspect, dialVerdict, target and option pass-through, execError).

**Characterization proof that the pins hold on `main`** (not just on the new
code): I materialised main's runtime with `git show
main:packages/cli/src/pod-runtime.ts > packages/cli/src/zz-pod-runtime-main.ts`
and ran the same three log-line assertions against it. Repro
`.tentacle/tmp/docker-engine-seam/main-pins.test.ts`:

```
$ bun test ./.tentacle/tmp/docker-engine-seam/main-pins.test.ts
 3 pass  0 fail  9 expect() calls
$ rm packages/cli/src/zz-pod-runtime-main.ts
```

The repro asserts, on main: `logs == ["[pod] creating p1 (image img:1) in
namespace dev…\n"]` and `calls == ["create:p1:dev"]` for a 404-namespace
create; `["[pod] attaching to p in namespace dev…\n"]` / `["get:p"]` for a
Failed pod; and the attaching + `[pod] waiting for p to become ready…` lines
with `["get:p","ready:p:60000"]` for a Pending pod. These are the same
strings `engine-k8s.test.ts` pins.

**B.1 mutations.** Each file was backed up with `cp` to
`.tentacle/tmp/docker-engine-seam/bak/`, mutated, tested, then restored with
`cp`. Pre and post `shasum` match (`engine-k8s.ts 13400de4…`,
`pod-runtime.ts 7de10075…`).

| # | Mutation | Result |
|---|---|---|
| M1 | `kubeEngineHost.removeBestEffort` → no-op | RED: oracle `registers a process-exit cleanup…` (`:536`, no `besteffort:`) + engine-k8s mapping test |
| M2 | `where` → `` `ns ${namespace}` `` | RED: 4 tests in `engine-k8s.test.ts`; **oracle stayed green** (the gap above) |
| M3 | `attachEngineRuntime` catch also calls `host.remove(name)` | RED: 4 oracle tests (`:801`, `:876`, `:1205`, `:1281`, "never deletes") |

### 3. B.2: Docker/Podman (§4-5)

1. `packages/docker/src/engine-dialer.ts` (new): `dialerFor(ep)` maps ssh →
   `sshDialer` and unix/tcp → `socketDialer`. A2 is merged, so there is no
   "ssh needs A2" fallback (drift D3).
2. `packages/docker/src/container-cleanup.ts` (new):
   - `spawnContainerDelete(ep, id, spawn?, execPath?)` never throws. The child
     is detached with stdio `ignore` and `unref()`'d. Its env is the parent
     env + `TENTACLE_CONTAINER_DELETE_ID` + `TENTACLE_DOCKER_ENDPOINT` (the
     endpoint JSON, TLS PEM included).
   - `containerDeleteCommand(execPath, modulePath = import.meta.path)`:
     compiled → `[execPath, "__delete-container"]`; source → `bun -e` doing
     `await import(<abs path>)` + `deleteContainerFromEnv()` + `process.exit(0)`.
   - `deleteContainerFromEnv(env?, makeClient?)` validates the endpoint `kind`,
     then calls the real `DockerClient` over `dialerFor(ep)` and
     `removeContainer(id, {timeoutMs: 15_000})`. All errors are swallowed.
3. `packages/docker/src/index.ts`: 2 exports.
4. `packages/cli/package.json` + `bun.lock`: `@tentacle/docker: workspace:*`.
   **`bun.lock` was hand-edited** (one line, alphabetical, matching the other
   workspace deps) because `bun install` was not allowed. `bun install
   --frozen-lockfile` will confirm or reject it.
5. `packages/cli/src/engine-docker.ts` (new):
   - `dockerEngineHost({client, endpoint, kind, spawnDelete?})`,
     `DockerClientLike` (a `Pick` of `DockerClient`), and `containerBody(image)`
     = `{Image, Cmd:["sleep","infinity"], HostConfig:{Privileged:false}}`.
   - `where` = `` `${endpointLabel(ep)} (${ep.source})` ``, e.g.
     `unix:///var/run/docker.sock (context "default")`.
   - `create` → on the client's 404 branch: pull, then create once more. 409 →
     the actionable "already exists … `docker rm X`" error, and nothing is
     removed.
   - `waitForReady` starts **only a container this host created** (drift D1).
   - `inspect`: paused → stopped (unpause hint); running → ready; restarting →
     starting; everything else → stopped (`docker start` hint, "attach never
     starts a container"); 404 → actionable.
   - `dialVerdict`: exited/dead/404 → `gone`; running and not paused → `null`;
     everything else → `unreachable`.
   - `remove` = `removeContainer` (owner-label guard). `removeBestEffort`
     swallows spawner errors.
   - `openExec` / `runExec` reject a non-empty `container`.
   - `execError` = pass-through (drift D2).
6. `packages/cli/src/main.ts`: hidden `__delete-container` next to
   `__delete-pod` (static import of `deleteContainerFromEnv`). `__delete-pod`
   and the k8s script are untouched.
7. Tests (new): `packages/docker/test/container-cleanup.test.ts` (8),
   `packages/docker/test/engine-dialer.test.ts` (2) and
   `packages/cli/test/engine-docker.test.ts` (20). The last uses a
   `FakeDockerClient` whose `openExec` is bound to a real daemon `Connection`,
   like `FakeCluster`, and runs a real turn plus the single-broker `SpyBroker`
   check.

**Red → green.** I wrote the B.2 sources before their tests, so red was shown
**by mutation** on the asserted property. Each was backed up with `cp`,
restored with `cp`, and the post-restore `shasum` matches
(`engine-docker.ts 7498bb45…`, `container-cleanup.ts ae50afe2…`):

| # | Mutation | Result |
|---|---|---|
| D1 | `waitForReady` always `startContainer` | RED: "a restarting container … never started by us" (`start:users-box` appeared) |
| D2 | `removeBestEffort` → no spawn | RED: run happy path, `net == []` after firing the exit listener |
| D3 | `inspect` checks `Running` before `paused` | RED: "a paused container is refused…" (attach proceeded) |
| D4 | the endpoint JSON appended to the child's argv | RED: "…never argv" (`SECRETKEYMATERIAL` in argv) |

Narrow runs (with `--tsconfig-override ./tsconfig.json`): engine-docker 20/20,
container-cleanup + engine-dialer 10/10, engine-k8s 8/8. I tightened the ssh
dialer test after a first version could pass vacuously; it now asserts the
exact `ssh not found on PATH … ssh://h` rejection.

**Real-child repro: NOT verified.** `.tentacle/tmp/docker-engine-seam/child-repro.ts`
spawns the real source-mode command against a missing unix socket and expects
exit 0, fast, no output. In this checkout it fails before reaching any new
code: `Cannot find module '@tentacle/core' from packages/docker/src/ssh-dialer.ts`
(the §0 cause; `bun -e` gets no tsconfig override). To verify, run `bun install`,
then `bun run .tentacle/tmp/docker-engine-seam/child-repro.ts`. The script is:

```ts
import { CONTAINER_DELETE_ID_ENV, DOCKER_ENDPOINT_ENV, containerDeleteCommand }
  from "../../../packages/docker/src/container-cleanup.ts";
const cmd = containerDeleteCommand("bun");
const env = { ...process.env, [CONTAINER_DELETE_ID_ENV]: "tentacle-repro",
  [DOCKER_ENDPOINT_ENV]: JSON.stringify({ kind: "unix", path: "/nonexistent/docker.sock", local: true, source: "repro" }) };
const started = Date.now();
const proc = Bun.spawnSync(cmd, { env, stdout: "pipe", stderr: "pipe" });
console.log("argv has id:", cmd.join(" ").includes("tentacle-repro"));
console.log("exit:", proc.exitCode, "ms:", Date.now() - started);
console.log("stderr:", JSON.stringify(proc.stderr.toString().slice(0, 300)));
```

### 4. Drift from Implementation (and why)

- **D1: `waitForReady` starts only containers this host created.** The plan
  said `startContainer` then `waitForRunning`. But `attach` calls
  `waitForReady` for a `starting` (restarting) container, so that would start
  a user's container, against "attach never starts". A per-host `created` set
  fixes it; mutation D1 pins it.
- **D2: Docker `execError` is a pass-through.** Slice A's `createExec`
  (`explainCreateFailure`, `docker/src/exec-channel.ts:74-110`) already turns a
  refused exec into "not found" / "not running (state: …) — start it or use
  `run`", working from the container's state rather than the 409 text. A
  second translation would only re-word it.
- **D3: no "ssh needs A2" branch in `dialerFor`.** A2 is merged.
- **D4: no extra `tentacle.managed-by` label in `containerBody`.**
  `createContainer` always adds `OWNER_LABEL=tentacle.managed=true`
  (`docker/src/client.ts:238-241`), and that is the label `removeContainer`
  checks. A second label adds nothing.
- **D5: the missing-image detection matches the client's message prefix.**
  `createContainer` turns a 404 into a plain `Error("cannot create container
  <name>: … — pull the image…")` (`client.ts:250-255`), not a
  `DockerApiError`. The host therefore treats "a plain Error with that prefix"
  as no-such-image. It is coupled to A's wording; the test pins it. Cleaner
  follow-up: have A throw a typed error.
- **D6: shared types are named `EngineRunExecResult` / `EngineRunExecOptions` /
  `EngineExecChannelOptions`**, so they don't collide with the packages'
  `RunExecResult`.
- **D7: the source-mode child uses `await import(<path>)`** instead of a static
  `import … from` in the `-e` string. Same effect, and it sits naturally next
  to the `await`.
- **D8: new test file `engine-k8s.test.ts`** (not in the plan's file list). It
  closes the oracle gap found by M2.
- **D9: `bun.lock` edited by hand** (§0).

Unchanged on purpose: `PROTOCOL_VERSION`, `DAEMON_RECORD_VERSION` (still 7; no
persisted shape touched), `packages/k8s/**`, `docker/src/client.ts`, and the
`pod-runtime.ts` / `startPodRuntime` names (the rename is slice C, per the
owner's decision).

### 5. Final gate

- `bun run check` (no override): **typecheck ✓**, **lint ✓** (536 files,
  0/0), test **3097 pass / 2 skip / 14 fail / 10 errors** (3113 tests, 247
  files). Every fail and error is `Cannot find module '@tentacle/docker'`
  (from `cli/src/main.ts`, which every `main`-importing or `bun src/main.ts`
  test now loads) or `'@tentacle/core'` (from `ssh-dialer.ts`), or Bun.build's
  `Could not resolve "@tentacle/docker". Maybe you need to "bun install"?`.
  That is the §0 cause, now hit by more tests. **Not green.**
- Stand-in, `bun test --tsconfig-override ./tsconfig.json`: **3190 pass / 3
  skip / 4 fail** (3197 tests). The 3 skips are the opt-in ones. The 4 fails
  run a child process that does not inherit the override:
  - `update.test.ts` ×2 and `version-marker.test.ts` ×1 spawn
    `bun src/main.ts` → `Cannot find module '@tentacle/docker'`;
  - `pod-binary-build.test.ts` ×1 runs `Bun.build` → `Could not resolve
    "@tentacle/docker"`.
- **Unverified (one line):** a green `bun run check`. Verify with `bun
  install`, then `bun run check`: expect ≈3197 tests, 3 opt-in skips, 0 fail.

## Review

*— claude-opus-5-5, 2026-10-27* (fresh context, but the **same model** as the
executor: shared blind spots can survive both passes. For a load-bearing task,
AGENTS §10 would prefer a different model.)

### Verdict: **APPROVE-WITH-NITS** (MERGE). None of the findings blocks the merge.

### Gate (re-run, after the orchestrator's `bun install`)

`bun run check`, no override: typecheck ✓, lint ✓ (536 files, 0/0), test
**3194 pass / 3 skip / 0 fail** (3197 tests, 247 files). The 3 skips are the
opt-in ones (live-k8s, live-docker, slow keepalive). This matches Execution §5's
expected result. The env failure from §0 is gone.

`bun.lock`: `git diff main -- bun.lock` is still the single hand-added line
after `bun install` ran, and every `@tentacle/docker` import resolves in the
gate. So it is what bun produces.

### Findings

1. **Low (test gap): the `__delete-container` dispatch at `packages/cli/src/main.ts:206`
   is untested.** Mutation R4 renamed the matched string in `main.ts` and
   `bun test packages/cli` stayed **870/0 green**. A compiled binary's exit
   net (`[execPath, "__delete-container"]`, `container-cleanup.ts`) would then
   silently stop deleting: the child would run `main` with an unknown
   subcommand. Its output is ignored, so the container would be orphaned. The
   two ends are two hand-matched string literals in two packages. The gap is
   **pre-existing** for `__delete-pod` too: only `podDeleteCommand` is pinned
   (`k8s/test/pod-cleanup.test.ts:137`), never the dispatch. Fix (follow-up or
   slice C): export the subcommand name as one constant and use it on both
   ends, or add a `main(["__delete-container"])` test with an empty env
   (returns 0, no client).
2. **Nit: `packages/cli/src/engine-docker.ts` `missingImage` matches A's message
   prefix** (drift D5). This is debt the executor already declared. Under C's
   live test, a rewording in `docker/client.ts` would turn "pull the missing
   image" into a plain create error. The failure would be loud, not silent.
   Follow-up: a typed error in A.
3. **Nit: `EngineAttachRuntimeDeps` still carries `podName`.** It comes from
   `Omit<PodAttachRuntimeDeps, "kube"|"namespace">` (`pod-runtime.ts`). Slice C
   will pass a container name through a field called `podName`. Rename it
   together with the C rename (Owner Q2).
4. **Nit (declared debt): Docker `dialVerdict` cannot tell an auth failure apart**,
   so a TLS client-cert rejection becomes `unreachable`, and reconnect keeps
   retrying instead of stopping with `unauthorized`. The reconnect is bounded
   by the existing client-reattach policy, so this is not an infinite storm.
   C is the right place to fix it, once `dialError` is typed.

### Premise table (Implementation's load-bearing cites)

| Premise | Verdict |
|---|---|
| Context symptom: no `@tentacle/docker` in cli on `main`; `PodCluster` is the only host type | TRUE (`git show main:packages/cli/src/pod-runtime.ts`: `PodCluster` at :137-148, no docker import) |
| Runtime + injector touch the cluster only via `PodCluster` (+ `buildPodManifest`, `AGENT_CONTAINER`, `KubeApiError`, `TERMINAL_PHASES`, `podIsReady`) | TRUE: after the move, `pod-runtime.ts` has no `@tentacle/k8s` import |
| One-shot exec result/options structurally identical (k8s ↔ docker) | TRUE (the engine types typecheck against both clients) |
| Exit-code consumers only test `!== 0` | TRUE (`container-version.ts`, `pod-binary.ts` install/verify) |
| `removeContainer` is owner-label-guarded, kill-first, bounded, 404-idempotent | TRUE (`docker/src/client.ts:300-335`), and confirmed empirically (exit-net repro below) |
| `pod-runtime.test.ts`, `packages/k8s`, `docker/src/client.ts` unchanged vs main | TRUE (`git diff --stat main --` shows only `bun.lock`) |

### B.1: byte-identical k8s (attacks)

- **Diff read line by line against `main`** (`git show main:…pod-runtime.ts`).
  Status/log lines are `[${noun}] … in ${where}…` with `noun="pod"` and
  `where="namespace N"`, so the bytes are the same. The stderr prefix is
  `[pod X]`. The attach final line is `…the ${noun} stays up`, which gives
  "pod". The error texts (namespace 404, the attach 404, the terminal phase,
  `containerExecError`, `podDialError`) moved verbatim.
  `status?.finish()` comes before every throw, as before. Cleanup order in
  `run`: create → net armed → ready → inject → exec. On a catch: finish →
  flush → `remove`. On dispose: flush → `remove`. Same as before.
  `attach`: no `remove`, no net, as before.
- The only literal difference: `kube.waitForReady(name)` became
  `kube.waitForReady(name, undefined)` on `run`. Passing `undefined` to an
  optional or defaulted parameter changes nothing. **No observable change
  found.**
- The injector `prefix` defaults to `"pod"`, and `run`/`attach` pass
  `host.noun`, so the `[pod X] …` messages are unchanged. The install command
  (`head -c N`) is untouched.
- Mutation R3: `kubeEngineHost.inspect` always returns ready. **RED** in 3
  tests, including the unmodified oracle `pod-runtime.test.ts` "waits for a
  not-yet-ready pod (bounded)". Reverted.

### §7 red-team

- **Pod lifecycle / exit net: verified empirically** (the executor could not).
  The repro is in `.tentacle/tmp/docker-engine-seam-review/`.
  `fake-engine.ts` is a `Bun.serve({unix})` fake engine that logs every
  request, with `ours` labelled `tentacle.managed=true` and `users`
  unlabelled. `parent.ts` builds the real `dockerEngineHost` and arms
  `process.once("exit", () => host.removeBestEffort(id))`, the same shape as
  `registerExitCleanup`. It then calls `process.exit(130)`, the Ctrl+C path.
  Engine log:
  ```
  1793057891739 parent exits (process.exit 130)
  1793057891771 GET /_ping
  1793057891772 GET /v1.43/containers/ours/json
  1793057891772 POST /v1.43/containers/ours/kill?signal=KILL
  1793057891772 DELETE /v1.43/containers/ours?force=true&v=true
  1793057892319 GET /_ping                       (parent for "users")
  1793057892319 GET /v1.43/containers/users/json (refused: no kill, no delete)
  ```
  The detached child outlives the parent (about 32 ms later) and removes the
  container. The ownership guard holds even in the net. The executor's
  `child-repro.ts` (missing socket) now gives `exit 0, 36 ms, stderr ""`, and
  the argv does not contain the id. Only the source-mode (`bun -e`) child was
  run. The compiled-mode child was not exercised (see finding 1).
- **`attach` never creates, deletes or starts.** `attachEngineRuntime` has no
  `remove`, no net and no `create`. Docker `waitForReady` starts a container
  only if it is in this host's `created` set (drift D1). This is correct: it
  is the only way `attach` (restarting → `starting` → `waitForReady`) cannot
  start a user's container. It is pinned by mutation D1 and by the test "a
  restarting container … never started by us".
- **Secrets via env, never argv.** The endpoint JSON (TLS PEM) and the id
  travel in env. The `bun -e` argv contains only the module path. This is
  tested, and the repro confirms the id is not in argv. The container itself
  gets no secret. `containerBody` is `{Image, Cmd, HostConfig:{Privileged:false}}`:
  no binds, no socket, no host ns (tested).
- **One session path.** Docker has no runtime of its own. The same
  `startEngineRuntime`/`attachEngineRuntime` call `createLocalRuntime`, and
  `engine-docker.test.ts` runs a real turn over a real daemon `Connection`.
  The single broker holds: the `SpyBroker` test is present.
- **Model on the laptop.** `laptopModels(config)` is unchanged and shared, and
  `podDaemonCommand` is unchanged (`--model-proxy`, no creds).
- **Raw terminal writes.** No new `process.stdout.write`. Daemon stderr is
  still buffered through `createStderrSink`. The exit-net child has stdio
  `ignore`.
- **Docker `--container`.** It is rejected in `openExec`/`runExec`
  (mutation R2 → **RED**).

### Mutations (backup with `cp` → mutate → test → `cp` restore; post-restore `shasum` identical: `engine-docker.ts 7498bb45…`, `engine-k8s.ts 13400de4…`, `main.ts ca7db81f…`, `container-cleanup.ts ae50afe2…`)

| # | Mutation | Result |
|---|---|---|
| R1 | Docker `dialVerdict`: exited → `unreachable` | RED (dialVerdict test) |
| R2 | `noSubContainer` → no-op | RED ("--container is rejected") |
| R3 | k8s `inspect` → always ready | RED (3, incl. unmodified oracle) |
| R4 | `main.ts` `__delete-container` dispatch renamed | **GREEN, a gap** (finding 1) |

Properties left untested besides R4: the docker pull-then-second-create
failure path is not tested on its own (it shares the `conflict` translation
with the first create). The docker `waitForReady` timeout pass-through is
indirectly covered by the restarting test.

### Slice C readiness

The seam is thin to wire. C has to:

1. parse `--engine` / the `engine:` default;
2. build the host: `kubeEngineHost(new KubeClient…, ns)`, or
   `dockerEngineHost({client: new DockerClient({dial: dialerFor(ep)}), endpoint, kind})`.
   `kind: "podman"` already drives the `podman rm/start/ps` hints;
3. call the same two runtime entry points.

Podman socket discovery belongs to `resolveEngineEndpoint` (A), not the seam.
Renames left for C: `pod-runtime.ts`, `startPodRuntime`, and the `podName`
field (finding 3).

### How the executor behaved

The executor behaved well:
- It stopped at the `bun install` approval boundary instead of hand-symlinking
  (AGENTS §0).
- It reported the unverified child repro honestly, instead of claiming it.
- It found the plan's false claim "message tests go red" (M2). It closed that
  gap with a new characterization test that was proven against `main`, and
  left the oracle untouched.
- It logged every drift with its reason. D1 (no start on attach) is a genuine
  safety catch the plan missed.

One miss: the `__delete-container` dispatch has no test (finding 1). The k8s
side has the same gap, so this is inherited parity, not a new regression.

> **Owner decisions (2026-10-26 21:05):** plan APPROVED. Seam name `EngineHost`. Renaming `pod-runtime.ts` / `startPodRuntime` deferred to slice C.
