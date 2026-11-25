# feat/run-network — `tentacle run --network <name|none>`

> **Status:** implementation (APPROVED) · **Branch:** `feat/run-network`
> **Type:** feat · **Size:** M · **Blast:** cross-module · **Suited:** DeepSeek executes (config + cli + docker-engine; no §7 invariant changes, but the container-create error path is shared — Review re-reads it); Review in-context by a stronger model (Opus, per `TODO.md`)
> **Changelog:** `changelog.d/run-network.added.md`

## Context

*— claude-sonnet-4-5, 2026-11-25*

`tentacle run --engine docker|podman` creates its container with no
`HostConfig.NetworkMode`, so the engine's default applies — `bridge`, i.e. full
egress. The owner asked (2026-11-25 ~23:59) for a network choice: air-gapped
bench runs (the agent found upstream fixes on GitHub, `EXPERIMENTS` 25/11 23:20)
and sandboxing untrusted work. Kubernetes is out of scope (a pod's network is
the cluster's; a NetworkPolicy is not ours to own).

The capability is absent from every layer (`TODO.md:14` is the owner's item),
and two facts make the change small:

- no `NetworkMode` in the engine source at all — only the two *negative* guards
  that pin "a container gets nothing from the host"
  (`packages/cli/test/engine-docker.test.ts:813`, `:845`);
- the create body is built in ONE pure function,
  `containerBody` (`packages/cli/src/engine-docker.ts:94`), whose `HostConfig`
  is `{ Privileged: false, …Mounts, …SecurityOpt }` (`:102-107`).

**Repro** (2026-11-25, from the repo root; the task's scratch dir is
`.tentacle/tmp/run-network/`):

```console
$ bun run packages/cli/src/main.ts run --engine docker --image busybox --network none "hi"
[error] unknown option --network
usage: tentacle run --image <ref> [--engine kubernetes|docker|podman] [-n|--namespace <ns>] [--context <ctx>] [--insecure-docker-tcp] [--no-mount] [--confirm-mount] [--rm[=true|false]] [--bin-dir <dir>] [--resume [uid]|--continue] [--model <id>] [--profile <name>] [--name <n>] [-d|--detach] [--auto-accept[=true|false]] [--prompt <text|->] ["<prompt>"]
```

Refused by the flag table before any engine or session is touched
(`packages/cli/src/flags.ts:370`), which is the shape the new flag keeps.

## Implementation

*— claude-sonnet-4-5, 2026-11-25 — APPROVED by the owner (decisions delegated; the
recommended option is recorded for each under **Orchestrator decisions**)*

### Load-bearing assumption

**With `HostConfig.NetworkMode: "none"` a run still works end to end — daemon
over `docker exec`, model over RPC to the laptop.** Proven from the source, in
six steps, because everything that matters leaves the laptop side:

1. **The container only has to exist.** `Cmd: ["sleep", "infinity"]`,
   `Privileged: false`, no ports, no host network
   (`packages/cli/src/engine-docker.ts:94-111`). Nothing in the container
   listens or dials.
2. **The daemon is reached over an exec pipe, not over a socket.**
   `run` execs `tentacle serve --bridge --model-proxy`
   (`packages/cli/src/engine-runtime.ts:105`) and the RPC peer rides that
   channel: outbound frames are the exec'd process's **stdin**, inbound frames
   its **stdout**, demuxed by `StdDemux`
   (`packages/docker/src/exec-channel.ts:1-8`). The HTTP request behind the exec
   (`POST /containers/{id}/exec` + hijack) terminates at the *engine* on the
   laptop's socket/ssh/TCP endpoint — never inside the container's network
   namespace.
3. **The model is the laptop's.** The daemon's provider is
   `ProxyModelProvider`, which asks the LAPTOP for every model call over
   `model/stream` / `model/streamChunked` (`packages/daemon/src/proxy-model.ts:1-8`,
   `:194`), declared at `packages/protocol/src/methods.ts:213-214`, served by the
   client (`packages/client/src/remote-client.ts:2662-2678`). No endpoint, no
   key, no egress from the pod.
4. **The binary comes from the laptop, over the same exec.** The offline
   `checkPodBinaries` runs on the laptop before any create
   (`packages/cli/src/engine-runtime.ts:630`), and the upload is an exec
   (`engine-runtime.ts:8-12`).
5. **An image pull is the engine's, on the laptop.** `createContainer`'s 404
   path pulls and retries (`packages/cli/src/engine-docker.ts:209-220`), and
   `pullImage` is an engine API call (`packages/docker/src/client.ts:207-238`),
   so a missing image still resolves under `none`.
6. **The delete net is laptop-side too.** `removeBestEffort` spawns a detached
   child that dials the engine (`packages/docker/src/container-cleanup.ts:1-19`),
   armed right after the create (`packages/cli/src/engine-runtime.ts:717-722`).

What `none` does break, by design, is the agent's own tool calls that need the
internet (git fetch, package managers, an HTTP MCP server) — that is the feature.
The empirical proof the executor must land: one `startEngineRuntime` run with
`network: "none"` against the existing in-memory fake (a real daemon `Connection`
+ `ScriptedProvider`, `packages/cli/test/engine-docker.test.ts:103-110`), which
serves a whole turn over zero sockets. That fake cannot prove the NEGATIVE on
its own (it has no network at all), so the complement is shown by search: no
code path in `run`'s daemon dials the container's own address — the only
listeners are UNIX-socket ones
(`packages/cli/src/control-socket.ts:227`, `packages/cli/src/pod-resident.ts:321`,
both a `server.listen(path)`), and `serve`'s TCP server
(`packages/cli/src/serve.ts:652`) is on the `serve` path, not `run`'s.

### Preconditions

- **The engine's create body is one pure function, one caller.**
  `containerBody` (`packages/cli/src/engine-docker.ts:94`), called only from
  `dockerEngineHost.create` (`:169`, body at `:179-186`); `host.create` has
  exactly ONE caller
  in the tree, `provisionNamed` (`packages/cli/src/engine-runtime.ts:639`).
  Hence one option threads to both `run` paths: `--detach` at
  `packages/cli/src/main.ts:1737` and the TUI run at `:1785-1786`, both spreading
  the same `workloadDeps` (`:1731-1755`).
- **Precedence already exists and is pure.** `chooseEngine` is
  flag > `TENTACLE_ENGINE` > configured > `kubernetes`
  (`packages/cli/src/engine-select.ts:79-93`), wired once at
  `packages/cli/src/main.ts:1300-1313`. The configured value is already the
  profile-over-file merge (`packages/config/src/resolve.ts:885`, profile merge
  `packages/config/src/profile.ts:6-7`, `:53-60`), so "same precedence as
  engine" is `chooseNetwork` next to it — no second table.
- **An engine-specific flag on the wrong engine is refused BEFORE anything
  runs.** `engineFlagProblem` (`engine-select.ts:100-140`) is called inside
  `selectEngine` (`main.ts:1315-1327`), which `run` calls first
  (`main.ts:1553-1557`) — before `openSessions` (`:1607`), before the host is
  built (`:1611`), before any create.
- **`attach` never creates.** "Only a container THIS host created is ever
  started (`attach` never starts one)"
  (`packages/cli/src/engine-docker.ts:148`), and AGENTS §7 makes `attach`
  user-owned. `NetworkMode` is fixed at CREATE, so a kept container keeps its
  network across re-attach with no code and no stored field.
- **`unset` must leave the body byte-identical.** Two tests pin the exact body
  (`packages/cli/test/engine-docker.test.ts:807-818`, `:821-855`), including
  `NetworkMode` in their forbidden-string lists; both stay green only if the key
  is *absent* when unset.
- **A config key must be documented and the README table regenerated.** The key
  registry is the one place a key is described
  (`packages/config/src/key-docs.ts:1013-1026` for `engine`), `config-keys.ts`
  introspects the zod schema rather than a second list
  (`packages/config/src/config-keys.ts:1-10`), and `key-docs.test.ts` T1 fails on
  any hole (`:59-66`), T2 on a wrong default (`:229-278`); the README block is
  generated (`scripts/config-docs.ts:1-14`, `bun run docs:config`) and pinned by
  `packages/config/test/readme-config-table.test.ts:19`.
- **A 404 at create is currently read as "no such image".** `createContainer`
  turns any 404 into `cannot create container <n>: <msg> — pull the image or
  check its name` (`packages/docker/src/client.ts:265-271`), and
  `dockerEngineHost.create` treats *any* plain `Error` with that prefix as a
  missing image, pulls, and retries once (`engine-docker.ts:188-191`, `:209-220`).
  Docker answers an unknown network with a 404 too, so without a fix an unknown
  `--network` would trigger a bogus pull and report the wrong cause.

### Design

`--network <name|none>` on `run` only; `network` as a top-level config/profile
key; `TENTACLE_NETWORK` as the env step; unset = today's body, exactly.

1. **Resolution (pure).** `chooseNetwork({flag, env, configured})` in
   `engine-select.ts`, mirroring `chooseEngine`: flag, else a non-empty env,
   else the configured value, else `undefined`. Unlike an engine name, a
   network name has no closed set — so its SHAPE is checked here
   (`/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/`, which admits `none`, `bridge`,
   `host`, a user network and docker's `container:<id>` form) and a malformed
   value is a usage error before anything is created, while a well-formed but
   unknown name is left to the engine, the only authority on what exists.
   The regex lives ONCE, exported from `@tentacle/config`
   (`schema.ts`: `NETWORK_VALUE` + `networkValueProblem`); `main.ts` — which
   already imports the config package — asks it, so the file loader and the flag
   cannot disagree, and the lazily-loaded `engine-select.ts` graph (its
   `@tentacle/k8s` comment, `:41-46`) gains no `@tentacle/config` import.
2. **One refusal, at the top.** `run` resolves the network right after the
   engine (`main.ts:1553-1557`) and, if the engine is `kubernetes` and a network
   is set from ANY source, prints one error and returns 1 — nothing dialled, no
   run dir, no kept entry. `engineFlagProblem` stays the place for flag-vs-engine
   mistakes; the config/env case needs the resolved value, so the check sits
   next to it (`engine-select.ts` gets a small `networkOnKubernetes(kind,
   network)` predicate, unit-tested). Defence in depth: `kubeEngineHost.create`
   throws on `options.network`, exactly as it already does for a workspace
   (`packages/cli/src/engine-k8s.ts:214-219`).
3. **One option through the seam.** `EngineCreateOptions.network?: string`
   (`packages/cli/src/engine-host.ts:75-82`), passed by `provisionNamed`
   (`engine-runtime.ts:639-643`) from `EngineRuntimeDeps.network`
   (`engine-runtime.ts:244-282`), set from `workloadDeps` (`main.ts:1731-1755`).
   A host that does not implement a network (k8s) refuses it; a caller that does
   not set it changes nothing.
4. **The body.** `ContainerBodyOptions.network?: string` → `HostConfig: {
   Privileged: false, ...(network ? { NetworkMode: network } : {}), … }`
   (`engine-docker.ts:77-111`). `none` is passed through verbatim — no
   tentacle-side special case, so `bridge`, `host` and `container:<id>` cost
   nothing.
5. **The failure the engine reports, cleanly.** New typed error in
   `@tentacle/docker`: `ContainerCreateError extends Error` with
   `reason: "image" | "network"` (`client.ts`, exported from
   `packages/docker/src/index.ts`). `createContainer` classifies:
   a 404/other create failure whose engine message matches
   `/network .* not found|no such network/i` → `reason: "network"`, message
   `cannot create container <n>: <engine message> — check the network name (or
   \`docker network create <name>\`)`; otherwise today's `reason: "image"` text
   unchanged. `dockerEngineHost.create`'s `missingImage` becomes
   `error instanceof ContainerCreateError && error.reason === "image"`, so the
   pull-and-retry happens only for a real missing image, and a
   `reason: "network"` error becomes a `RefusalError`
   (`packages/cli/src/engine-host.ts:99`): one short `[container] …` line,
   no daemon log (nothing ran), exit 1.
6. **The config key.** `network: z.string().regex(NETWORK_VALUE).optional()` in
   `packages/config/src/schema.ts` next to `engine` (`:506-511`);
   `TentacleConfig.network?: string` carried in `resolve.ts` (`:229-233`,
   `:885`), so a profile works with no extra code (`profile.ts:6-7`);
   a `network` entry in `KEY_DOCS` (`key-docs.ts`, after `engine` at `:1026`)
   with `scope: "both"`, `carried: "no"`, `env: "TENTACLE_NETWORK"`,
   `flag: "--network"`, no default (like `engine`, it is NOT resolved into the
   config — the CLI layers it), and the `profiles.*` mirror derives itself
   (`key-docs.ts:1679-1700`). The commented example goes next to `"engine"` in
   `defaults.ts:253-258`.
7. **Docs.** The `run` usage in BOTH tables (`packages/cli/src/flags.ts:922`,
   `packages/cli/src/main.ts:298`), the Engines help block
   (`main.ts:479-512`), and README: the run examples (`README.md:112-116`), the
   Engines paragraph (`:323-337`) and the generated config table
   (`bun run docs:config`, row `engine` at `:417`).

#### Orchestrator decisions

The owner delegated the open questions; each is decided here, with its reason.

- **D1 — Kubernetes + a network is a hard error, whatever its source**
  (flag, `TENTACLE_NETWORK`, `network` in file/profile). *Reason:* silently
  ignoring `network: none` on a pod is a false claim of sandboxing, and a
  warning scrolls away in a transcript while the trust boundary is the whole
  point. The message names the fix, and `--engine docker|podman` is one flag.
  (Rejected: warn-and-ignore for config-sourced values — usable shared config,
  but it lies.)
- **D2 — No `network` field in the kept index and no flag on `attach`.**
  *Reason:* the network is fixed at CREATE; `attach` never creates (AGENTS §7),
  and a recorded value would go stale the moment the user runs
  `docker network connect` on their container.
- **D3 — The value's SHAPE is validated in the CLI, its EXISTENCE is the
  engine's.** *Reason:* the shape is cheap to check and a malformed value should
  never reach a create; whether a network exists is engine state we must not
  cache or guess. `none` is a shape-passing value with no special case.
- **D4 — Unset sends no `NetworkMode` key at all.** *Reason:* additive by
  default — the pinned body tests keep their meaning
  (`engine-docker.test.ts:807-818`, `:821-855`), and the engine's default stays
  the engine's (a future docker default change is not frozen into tentacle).
- **D5 — An unknown network surfaces as a typed create failure +
  `RefusalError`, and suppresses the missing-image pull.** *Reason:* today a 404
  is sniffed by message prefix (`client.ts:265-271` +
  `engine-docker.ts:188-191`), so the same status would trigger a pointless
  image pull over the network and then report "pull the image" for a network
  typo.
- **D6 — `none` gets no separate code path anywhere.** *Reason:* proven by the
  load-bearing section: exec-transport + model tunnel mean there is no
  in-container network dependency to satisfy, so the flag is data, not a mode.
- **D7 — The flag is `run`-only and value-required (`--network <v>`), never
  `--network=true`; on `attach` it is an unknown option.** *Reason:* `attach`
  never creates, so the flags table (`flags.ts:152-171` vs `:175-186`) should
  refuse it rather than accept and ignore it.

### Files

Dependency order; smallest diff each.

1. `packages/docker/src/client.ts` — `ContainerCreateError` (+ the
   network-not-found classification in `createContainer`, `:252-278`);
   `packages/docker/src/index.ts` — export it.
2. `packages/config/src/schema.ts` — `network` key
   (`:506-511` area) + the exported `NETWORK_VALUE` / `networkValueProblem`
   (one shared truth for the loader and the flag).
3. `packages/config/src/resolve.ts` — `TentacleConfig.network` (`:229-233`),
   carry it (`:885`).
4. `packages/config/src/key-docs.ts` — the `network` entry (after `:1026`).
5. `packages/config/src/defaults.ts` — the commented example (`:253-258`).
6. `packages/cli/src/engine-host.ts` — `EngineCreateOptions.network`
   (`:75-82`).
7. `packages/cli/src/engine-docker.ts` — `ContainerBodyOptions.network`
   (`:77-91`), `containerBody`'s `HostConfig` (`:102-107`), `create`'s
   pass-through + `missingImage`/`conflict` (`:169-231`).
8. `packages/cli/src/engine-k8s.ts` — the `network` backstop (`:214-219`).
9. `packages/cli/src/engine-runtime.ts` — `EngineRuntimeDeps.network`
   (`:244-282`), passed at `:639-643`.
10. `packages/cli/src/engine-select.ts` — `chooseNetwork` + the kubernetes
    predicate (`:64-140`).
11. `packages/cli/src/flags.ts` — `network: {}` in `run.values` (`:152-171`),
    usage (`:922`).
12. `packages/cli/src/main.ts` — resolve + validate
    (`networkValueProblem`) + refuse (`:1553-1557`),
    `workloadDeps.network` (`:1731-1755`), usage (`:298`), help (`:479-512`).
13. `README.md` — run examples (`:112-116`), Engines (`:323-337`), and the
    regenerated config table (`bun run docs:config`).
14. `changelog.d/run-network.added.md` — one `added` bullet.

No protocol, no daemon, no persistence, no TUI change.

### Failure modes

| Case | What happens | Where it converges |
| --- | --- | --- |
| `--network` with no value, or `--network=false` | flag table refuses at parse (`flags.ts:370`) | nothing touched; the same refusal shape as the repro |
| malformed value (`a/b`, space, empty, >128) | usage error from `chooseNetwork` before the engine, sessions or a run dir | exit 1, nothing created |
| `network` set + `--engine kubernetes` (flag, env or config) | one error before `openSessions` | exit 1; no pod, no kept entry, no run dir |
| well-formed but unknown network | create fails; `ContainerCreateError("network")` → `RefusalError`; ONE `[container] …` line naming the network; **no image pull** | docker's create is atomic → nothing exists; the exit net was never armed (`engine-runtime.ts:717-722` runs after a successful create), and with `--rm` `removeUnlessKept` still calls `host.remove` only for a workload that exists |
| network exists at create, deleted before start | `startContainer` fails with the engine's message | existing failure path unchanged: `--rm` removes, kept says `failed:` + how to attach/remove |
| engine unreachable / no socket | unchanged — `engineHost` fails first (`main.ts:1611`) | exit 1, before any create |
| `TENTACLE_NETWORK=""` | treated as unset, as `chooseEngine` does with `TENTACLE_ENGINE` (`engine-select.ts:89`) | today's behaviour |
| kept container re-attached later | no flag on `attach`; the container keeps its network (create-time) | nothing to store, nothing to drift |
| `--detach` + `--network` | same `provisionWorkload` create path (`main.ts:1737`) | identical, and the kept entry is unchanged (D2) |
| a user network with no route to the laptop | irrelevant: nothing in the run path dials the laptop over TCP (load-bearing §) | the agent's own tool calls fail with their own errors — the intended sandbox |
| `--network none` + a missing image | the ENGINE pulls on the laptop (`engine-docker.ts:209-220`) | first run works under `none` |

No silent drop: every set value either reaches the create body or produces a
refusal that names it.

### Tests

Red before green (§9). Every test below fails on current `main` — the flag is
an unknown option, the key undocumented, the option absent from every type.

1. `packages/cli/test/engine-select.test.ts` — `chooseNetwork`: flag > env >
   configured > `undefined`; `""` ignored; the kubernetes predicate is true
   only with a network AND kind `kubernetes`. *Property:* the precedence, not a
   weaker correlate (mirror the existing `chooseEngine` cases).
2. `packages/config/test/*` (a small new case next to the schema tests, or
   `packages/cli/test/main.test.ts` for the end of it) — `networkValueProblem`:
   `none`, `bridge`, `my-net`, `container:abc` pass; `""`, `a/b`, `a b`,
   a 129-char value fail. *Property:* the shared shape rule, tested once.
3. `packages/cli/test/engine-docker.test.ts` — `containerBody("img", {network:
   "none"})` has `HostConfig.NetworkMode === "none"` and, unset, **no**
   `NetworkMode` key (the two `toEqual` guards at `:807-818`, `:821-855` stay
   untouched and green). *Property:* the exact wire body.
4. Same file, the create path (`FakeDockerClient`, `:103-175`): a
   `ContainerCreateError("network")` from the fake → `calls` has **no**
   `pull:` and **no** second `create:`; the thrown error is a `RefusalError`
   whose message names the network. A missing-image plain error still pulls and
   retries once (the existing test must stay green — non-vacuity: mutate
   `missingImage` to `true` and watch it fail).
5. Same file (or `engine-runtime.test.ts`), the load-bearing proof:
   `startEngineRuntime(config, { …, network: "none" })` completes a scripted
   turn and the first body carries `NetworkMode: "none"` — the daemon ran with
   zero sockets, exactly as `none` promises.
6. `packages/cli/test/main.test.ts` — the `seenWith` harness
   (`:2536-2590`, extend it to return `seen?.network`, the way `--no-mount`
   does at `:2604-2608`): `run --engine docker --network none` reaches the
   runtime with `network: "none"`; `TENTACLE_NETWORK=none` and a config
   `network: "none"` do too, in that precedence; `run --engine kubernetes
   --network none` is refused with the clear line and `reached: false` (the
   pattern of `:2624-2634`); `attach --engine docker --network none box` is an
   unknown option; a malformed `--network a/b` is refused with the usage error
   (`reached: false`).
7. `packages/docker/test/client.test.ts` — `createContainer`'s classification:
   a 404 with `network foo not found` → `reason: "network"`; a 404 with
   `pull access denied`/`no such image` → `reason: "image"` (the existing
   cases at `:256-270`, `:364` stay green); a 500 with a podman-style
   `network … not found` → `reason: "network"`.
8. `packages/config/test/key-docs.test.ts` T1/T1b/T2 —
   green only with the entry (documented default = unset; env exactly
   `TENTACLE_NETWORK`); `packages/config/test/readme-config-table.test.ts` T4 —
   green after `bun run docs:config`. (These are gates, not behaviour: they are
   red until the registry entry exists.)
9. Optional, opt-in: a live `TENTACLE_DOCKER_TESTS=1` case that creates with
   `NetworkMode: "none"` and runs one exec — the only real-engine check of
   podman's compat API honouring `none`.

Validation: `bun test <file>` per slice, then `bun run check` green
(typecheck will catch any missed `EngineCreateOptions` call site).

## Execution

*— pending (DeepSeek)*

## Review

*— pending (Opus, in-context; re-read the create-error path)*
