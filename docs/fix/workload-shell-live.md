# fix/workload-shell-live — `workload_shell` fails on every multi-container pod, with a reason nobody can act on

> **Status:** implementation (awaiting approval)
> **Branch:** `fix/workload-shell-live`
> **Size:** M · **Blast:** cross-module · **Suited:** executor assigned by the owner; standard Review that also re-runs the session-hop `attach` rows (`engine-runtime.test.ts`, `engine-k8s.test.ts`), because `EngineHost.inspect` is shared with `attach`
> **Changelog:** `changelog.d/workload-shell-live.fixed.md`

## Context

*— claude-opus-5-5, 2026-11-15*

**Owner's live failure (2026-11-15 ~01:55, `tentacle 0.6.0+0d0f0563` = main
`c8b4dc3c`, OpenShift 4.19).** Pod `openshift-etcd/etcd-sharedocp419-qqq5p-master-0`
has 5 containers (`etcdctl etcd etcd-metrics etcd-readyz etcd-rev`). `oc exec`/`oc rsh`
work from the laptop, and a session-hop `attach` to `.../etcdctl` worked the same
day. Every `workload_shell` call failed within 0.3–0.5 s:

```
workload_shell {"action":"run","target":{"engine":"kubernetes","name":"etcd-sharedocp419-qqq5p-master-0","namespace":"openshift-etcd"},"command":"hostname"}
-> workload_shell failed: could not start a shell in kubernetes openshift-etcd/etcd-sharedocp419-qqq5p-master-0: exec channel errored
```

The model said it would retry "specifying the container etcd", but no call ever
carried a `container` field.

**Cause: three defects together, each shown by the repros below.**

1. **No container gets resolved.** When `target.container` is omitted, the
   exec URL carries no `container=` (`packages/k8s/src/exec-channel.ts:256-259`).
   On a pod with more than one container the apiserver refuses the upgrade with
   a 400 Status: `a container name must be specified for pod …, choose one of:
   […]`. kubectl never hits this, because it picks the container on the client
   side (the `kubectl.kubernetes.io/default-container` annotation, else the first
   container, with a "Defaulted container" notice). The tool's path
   (`workload-shell.ts:505-511` → `workload-shell-backend.ts:135-142` →
   `client.ts:241-246`) reads no pod at all. session-hop's `attach` works
   because it reads the pod first (`engine-k8s.ts:173-230`, called by
   `engine-runtime.ts:810-827`). It honours the annotation and refuses with
   the container list otherwise, so it never sends a bare multi-container exec.
   (The owner's attach named `etcdctl`.)
2. **The API's reason is dropped twice.**
   - **(i) Bun drops it.** On a refused upgrade, Bun's WebSocket gives neither
     the HTTP status nor the body. It fires only `error` ("Expected 101 status
     code") and then `close 1002` (repro B).
   - **(ii) `rawExec` drops even that.** It throws away the event and settles
     with a constant `"exec channel errored"` (`exec-raw.ts:276-284`).
   - **(iii) `explain` cannot translate it.** `backend.explain`
     (`workload-shell-backend.ts:171-201`) has two paths, and neither helps:
     - `dialVerdict` (`engine-k8s.ts:258-263` → `podDialError`
       `engine-k8s.ts:101-113`) returns `null` for a Running pod.
     - `execError` (`engine-k8s.ts:76-92`) only matches "closed before the
       command reported a status".

     So the text reaches the model unchanged. Merged plan D5
     (`docs/feat/workload-shell.md:712-713`) claimed that an RBAC 403 is
     caught by `dialVerdict`/`execError`. It is not: `dialVerdict` only does
     a `GET pod`, which `get pods` RBAC allows.
3. **The model is never told about the field.** The `container` field exists
   (`workload-shell.ts:690-691`), but its doc is a JSDoc comment. JSDoc never
   reaches the model-facing JSON Schema (repro A prints
   `{"type":"string","minLength":1,…}`, with no description). The tool
   description (`workload-shell.ts:707-713`) never mentions containers.

**Drift from the merged plan found along the way (fixed here, because it is
the same surface):**
- The "container only on kubernetes" rule is not enforced. Plan D3
  (`docs/feat/workload-shell.md:646-647`) said to reuse `move-session.ts:57-59`,
  but `workloadShellSchema` has no such refine. A docker target with a
  `container` reaches `noSubContainer` (`engine-docker.ts:157-163`), whose text
  talks about the CLI flag `--container`, not `target.container`.
- The first-result line `[opened sh in kubernetes context "…", namespace …, pod …]`
  (plan D2, `docs/feat/workload-shell.md:640-641`) was never built.
  `backend.where()` (`workload-shell-backend.ts:121-123`) has no caller. That
  line is where the container now gets named.

**Repro** (2026-11-15, on main `c8b4dc3c`; scripts in
`.tentacle/tmp/workload-shell-live/`, pasted here because that folder is
gitignored).

*Repro A — the real tool + `LaptopWorkloadShellBackend` + `kubeEngineHost` +
`rawExec`, over a fake `PodCluster`* (`repro.ts`). The fake's 5-container pod
and its WebSocket behave the way repro B shows Bun's does on a refused upgrade:
```ts
const cluster = {
  async getPod(name) { return { metadata: { name, annotations: {} },
    spec: { containers: CONTAINERS.map((n) => ({ name: n, image: "x" })) }, status: { phase: "Running" } }; },
  openRawExec(target) { execTargets.push(target); return rawExec(refusingWs()); }, // error "Expected 101 status code", close 1002
  async runExec(target) { execTargets.push({ oneShot: target }); return { exitCode: 1, stdout: "", stderr: "" }; },
};
const backend = new LaptopWorkloadShellBackend({ io: { env: { TENTACLE_K8S_SERVER: "https://k:6443", TENTACLE_K8S_TOKEN: "t" },
  /* … */ kubeClient: () => cluster } });
const tool = createWorkloadShellTool(new WorkloadShells(backend));
await tool.execute({ action: "run", target: { engine: "kubernetes", name: "etcd-sharedocp419-qqq5p-master-0",
  namespace: "openshift-etcd" }, command: "hostname" }, { signal });
console.log(zodToJsonSchema(workloadShellSchema, { target: "openApi3" }).properties.target.properties.container);
```
```
result: {"content":"workload_shell failed: could not start a shell in kubernetes openshift-etcd/etcd-sharedocp419-qqq5p-master-0: exec channel errored","isError":true}
exec targets: [{"pod":"etcd-sharedocp419-qqq5p-master-0","command":["sh"]}]
target.container in model-facing schema: {"type":"string","minLength":1,"maxLength":253,"pattern":"^[A-Za-z0-9][A-Za-z0-9._-]*$"}
```
The error text matches the owner's byte for byte. The exec target has no
`container`, and the schema gives the model no hint.

*Repro B — what Bun shows of a refused upgrade* (`handshake.ts`). A local
`Bun.serve` answers the upgrade with `400` and a k8s Status body (`a container
name must be specified for pod p, choose one of: [first second]`). `rawExec`
is pointed at it:
```
rawExec end: {"exitCode":null,"error":"exec channel errored"}
ws events: error{message="WebSocket connection to 'ws://127.0.0.1:62029/api/v1/namespaces/d/pods/p/exec?command=sh' failed: Expected 101 status code"} | close{code=1002,reason="Expected 101 status code"}
```
→ the Status message cannot be read from the WebSocket. It has to be asked for
some other way (Design D3).

*Live probe on kind* (`probe.ts`: a 2-container busybox pod, with and without
`container`). **Not run:** `kind-hop-test` refused the connection
(`ECONNREFUSED 127.0.0.1:61409`). It becomes the opt-in live row in Tests, and
that row is also where D3's one unverified apiserver behaviour gets checked.

## Implementation

*— claude-opus-5-5, 2026-11-15*

### Load-bearing assumption

**The tool can pick the container on the laptop, before the exec, with one
`GET pod`, using the same rule kubectl uses.** This holds:

- `prime(target)` is already the async hook the registry awaits before `open`
  (`workload-shell.ts:503-508`, interface `:89-97`).
- The k8s host already reads the pod and applies the annotation rule for
  `attach` (`engine-k8s.ts:200-216`, `podContainerNames` imported at `:20`).
- Once the URL carries `container=<c>`, the apiserver needs nothing else. That
  is the path the owner's working `attach` used (`exec-channel.ts:256-259`).

### Preconditions

- **Single broker (§7) is untouched.** The permission check runs on the
  model's input before `execute` (`permission-gate.ts:70-80`). No prompt is
  added and no grant changes.
- **One `targetKey` for registry and grants** (`workload-shell.ts:69-77`).
  This fix keeps the key on the target **as the model wrote it**. The resolved
  container lives only on the shell (D1), so an "always" can never widen to
  another container.
- **`attach` keeps its behaviour.** The new rule is behind an explicit option
  of `inspect` (D2). Without the option, `inspect` behaves exactly as today
  (`engine-k8s.ts:207-216`). The tests that pin that are
  `engine-runtime.test.ts:919-989` and `engine-k8s.test.ts:234-…`.
- **`KubeClient.doFetch` already carries the cluster TLS and the bearer
  header** (`client.ts:96-115`, `kube-auth.ts:162-173`). A plain-HTTP re-ask
  therefore needs no new auth plumbing.
- **No protocol, persistence or terminal path is touched.** No
  `protocol.d/` note is needed.

### Design

**D1 · Pick the container like kubectl, and say which one (tools + backend).**

- **What `prime` returns.** It now returns what it resolved:
  `prime?(target): Promise<PrimedTarget | void>`, where
  `PrimedTarget = { container?: string; note?: string }`.
- **The registry keeps two targets.** In `openReserved`
  (`workload-shell.ts:501-525`) it builds
  `execTarget = { ...target, ...(primed?.container ? { container } : {}) }`.
  `Shell` gets a new field `execTarget`.
  - `backend.open(execTarget)` and the kill/EOF one-shot
    (`workload-shell.ts:446`, today `shell.target`) both use `execTarget`.
    Without that, the one-shot kill would hit the same 400 on a multi-container
    pod.
  - `key` stays `targetKey(target)`.
- **The result says which container was used.**
  - The header uses `describeTarget(execTarget)`, so every result shows
    `…/pod[etcd]`. This comes in through `RunOutcome.target`, so `execute`
    (`:775-783`) stops formatting the input target.
  - The **run that opened** the shell also gets one info line. This is plan
    D2's missing first-result line, now built:
    `[opened sh in kubernetes context "c", namespace ns, pod p, container etcd — the pod's default-container annotation; others: etcdctl, etcd-metrics, etcd-readyz, etcd-rev; set target.container to choose]`.
    For a first container picked by default, the clause reads
    `— first of 5, no default-container annotation`. A named or only container
    gets no clause.
  - The text comes from `backend.where()` plus `primed.note`.
  - `ResultTextInput` (`workload-shell-frame.ts:441`) gets an `info?: string[]`
    field, printed after the header. It does **not** count toward `isError`
    (`:480`): an informative open line must not turn a successful `hostname`
    into an error.
- **Backend (`workload-shell-backend.ts:75-77`).**
  - For `kubernetes`, `prime` calls
    `host.inspect(name, { container, pick: "kubectl-exec" })`.
  - It caches the resolved container per `targetKey` for `explain`.
  - On `stopped`, it throws a `RefusalError(detail)` (nothing gets opened).
  - Docker/podman `prime` is unchanged.

**D2 · The kubectl-exec rule as an option of the shared k8s `inspect` (cli).**

- `EngineHost.inspect`'s options (`engine-host.ts:176`) gain
  `pick?: "kubectl-exec"`.
- In `kubeEngineHost.inspect` (`engine-k8s.ts:200-224`), the rule moves into
  one pure, exported function next to it:
  `pickExecContainer(names, annotation, requested, mode)`. It returns
  `{ container, how: "named"|"annotation"|"first"|"only" }` or a refusal text.
  - **Default mode** (attach, unchanged): annotation, else refuse with the
    existing `a container name must be specified …` text.
  - **`kubectl-exec` mode**, no container named: annotation (when it names a
    real container), else `names[0]`.
  - **`kubectl-exec` mode**, container named but not in `names`: a
    `RefusalError` worded like the API's own:
    `container "x" is not valid for pod p, choose one of: [a b c] · set target.container`.
    This message used to be lost the same way (repro B).
- `WorkloadState` `ready`/`starting` gain `containers?: readonly string[]` and
  `how?`, for the open line's "others".
- The docker host ignores the option (`inspect` is not called for docker
  anyway).

**D3 · Never a bare "exec channel errored": surface the API's own Status (k8s +
backend).**

- **`rawExec` keeps the reason** (`exec-raw.ts:255-284`).
  - An `error` or `close` that comes **before `open`** settles with a new
    exported `ExecRefusedError`. Its message is
    `the API server refused the exec (<event message, e.g. "Expected 101 status code">)`.
  - An error **after** open keeps today's meaning, but now appends the event's
    message when there is one.
- **The registry passes the cause on.** It wraps the stream's error as
  `new Error(\`could not start a shell in …: ${why}\`, { cause: end.error })`
  (`workload-shell.ts:562-563`), so `explain` can see the original error's
  type.
- **New `KubeClient.execRefusal(target): Promise<string | undefined>`**
  (`client.ts`, next to `openRawExec` `:241`).
  - It issues the **same exec URL** (`buildExecUrl`, ws→http) as a plain `POST`
    through `doFetch`, with no upgrade.
  - The apiserver checks authn/authz (RBAC, SCC admission) and validates the
    container (`ExecLocation`) **before** it requires the upgrade. So a non-2xx
    answer carries the real Status, and it returns `Status.message`.
  - It returns `undefined` for 2xx, for the generic `Upgrade request required`
    (meaning: the URL is acceptable, so the refusal was something else), for a
    body that is not a Status, or on a network error. It never throws.
  - It is wired as an optional `PodCluster.execRefusal?` (`engine-k8s.ts:32-44`),
    so the existing fakes need no change. It is then exposed as an optional
    `EngineHost.execRefusal?(target)`.
- **`backend.explain`** (`workload-shell-backend.ts:171`). When
  `cause instanceof ExecRefusedError`, it asks
  `host.execRefusal({ name, container: <resolved> })` **after** `dialVerdict`
  (a deleted pod still says "gone" first).
  - **Got a message:** `cannot exec into kubernetes ns/pod[c]: <Status message>`.
  - **Got nothing:** `cannot exec into …: the API server refused the WebSocket upgrade and gave no reason over HTTP (the client cannot read the refusal body) — check \`kubectl auth can-i create pods/exec -n ns\` and that the pod is running`.

  Either way, the bare constant is gone.

**D4 · The model is told (tools).**
- `container` and `namespace` get `.describe()` in `workloadShellSchema`
  (`workload-shell.ts:690-693`). This is the pattern the other tools use, e.g.
  `builtins.ts:265-276`.
  - `container`: "Kubernetes only: the container in the pod. Omit it to use the
    pod's `kubectl.kubernetes.io/default-container` annotation, else its first
    container (like kubectl). The first result names the container used and the
    others."
  - `namespace`: "Kubernetes only. Default: `default`."
- One added sentence in `WORKLOAD_SHELL_DESCRIPTION`: "For a multi-container pod,
  set `target.container`. When omitted, the default container is used and named
  in the result."
- The schema gains move-session's refine (`move-session.ts:57-59`):
  `container`/`namespace` only for `kubernetes`. It is reused by export, not
  copied. This replaces `noSubContainer`'s `--container` wording for the tool.
  The refine goes on the object, and the model-facing JSON Schema is unchanged
  by it. **The executor checks** that `zodToJsonSchema` still emits
  `target.properties` with the refine in place, because `registry.ts:64` must
  not end up with an `allOf`/effects wrapper. If it does, the executor puts
  the check in `execute`'s existing post-parse block (`:735-746`) instead, and
  records that drift.

**Docker/podman.** Nothing changes there besides the D4 refusal: a container
*is* the workload, and there is no default to pick. Docker's exec failures come
back over HTTP with their message already readable (`docker/src/exec-raw.ts:150-220`).
That was not re-proved live here. The opt-in docker row in Tests covers it
cheaply.

### Files

In dependency order:

1. `packages/k8s/src/exec-raw.ts`: `ExecRefusedError`; keep the event message
   (`:255-284`).
2. `packages/k8s/src/client.ts`: `execRefusal` (after `:246`).
3. `packages/cli/src/engine-host.ts`: `inspect` option `pick`; `WorkloadState`
   gains `containers`/`how`; optional `execRefusal?`.
4. `packages/cli/src/engine-k8s.ts`: `pickExecContainer` (pure, exported);
   `inspect` uses it (`:200-230`); `PodCluster.execRefusal?`; host
   `execRefusal`.
5. `packages/cli/src/workload-shell-backend.ts`: `prime` resolves and returns
   `PrimedTarget`; a cache for `explain`; the `ExecRefusedError` branch in
   `explain`.
6. `packages/tools/src/workload-shell.ts`: schema `.describe()` + refine,
   description sentence, `PrimedTarget`, `Shell.execTarget`, one-shot on
   `execTarget`, `cause`, `RunOutcome.target`/`info`.
7. `packages/tools/src/workload-shell-frame.ts`: `ResultTextInput.info`
   (excluded from `isError`).
8. `packages/tools/src/move-session.ts`: export the engine-only refine (or its
   predicate).
9. `changelog.d/workload-shell-live.fixed.md`: one bullet.

### Failure modes

| case | behaviour after the fix | converges how |
|---|---|---|
| multi-container pod, no annotation, no `container` | first container, named in the open line with the others | the model reads the line; it can switch with `target.container` (a new key → a new shell; the old one closes on idle or `close`) |
| annotation names a container that does not exist | ignored (kubectl does the same) → first container, `how: "first"` | — |
| `container` named but absent | refused **before** any exec, with the list | nothing opened, nothing registered (`prime` throws before `open`, `:505`) |
| `GET pod` 404 / 403 | the existing `WorkloadNotFoundError` / RBAC text from `inspect` (`engine-k8s.ts:174-188`) | nothing opened |
| pod terminated / not running | `stopped` → `RefusalError(detail)`; `starting` → open anyway (the exec then fails with D3's explained reason) | nothing opened / the next run retries |
| exec 403 (`create pods/exec` denied, `get pods` allowed) or SCC/admission denial | `ExecRefusedError` → `execRefusal` returns the apiserver's own Status message | nothing registered (failed-open path `:568-575`) |
| `execRefusal` itself fails / times out / gets `Upgrade request required` | the honest fallback sentence (D3), never the bare constant | — |
| the pod is replaced between `prime` and `open` (the annotation changed) | the exec uses the container resolved a moment earlier; if that container is gone, D3 explains it | next run: shell `ended` → reopen → `prime` resolves again (`:278-283`) |
| omitted `container` and later the same container named explicitly | two keys → two shells, two approvals (counts toward `MAX_OPEN_SHELLS`) | safe direction (more asks, never fewer); Owner Q2 |
| docker/podman with `container`/`namespace` | refused at parse, as for `move_session` | nothing opened |
| `dispose` during the now-longer `prime` (one more GET) | the existing `refuseIfDisposed` after `prime` (`:508-509`) | unchanged |

### Tests

Red first on main `c8b4dc3c`. Each test below was designed against the repro
outputs above.

1. **`packages/cli/test/workload-shell-backend.test.ts` (new).** This is
   repro A turned into a test. It runs the real `WorkloadShells` +
   `LaptopWorkloadShellBackend` with a fake `io.kubeClient`. The fake
   `PodCluster` keeps the `ExecTarget`s it receives and, like the apiserver,
   refuses any exec that has no `container` on a pod with more than one
   container. That refusal goes through the `refusingWs` behaviour that repro
   B proved.
   - **(a) No annotation.** On a 5-container pod, a run with no container
     reaches `openRawExec` with `container: "etcdctl"` (the first container),
     and the result names it plus the four others. *Red on main:* the exec
     target has no container; the result is "exec channel errored".
   - **(b) Annotation.** With `kubectl.kubernetes.io/default-container: etcd`,
     the exec uses `container: "etcd"`.
   - **(c) Named container absent.** It is refused with the list, and
     `openRawExec` is never called.
   - **(d) Kill one-shot.** A timeout's kill reaches `runExec` with the
     resolved container.
   - **(e) The API's reason.** The fake's handshake refuses and its
     `execRefusal` returns
     `pods "p" is forbidden: User "u" cannot create resource "pods/exec"`. The
     tool's error contains that sentence and does **not** contain
     `exec channel errored`.
   - **(f) `execRefusal` returns `undefined`.** The fallback sentence shows,
     still without the bare constant.
   - **(g) The open line is not an error.** It is printed once, on the opening
     run only, with `isError: false` for `exit=0`.
2. **`packages/k8s/test/exec-raw.test.ts`.**
   - An `error` before `open` settles with `ExecRefusedError`, and its message
     includes the event message.
   - An error after `open` keeps the stream-error path (the existing `FakeWS`).
3. **`packages/k8s/test/client.test.ts`** (or whichever existing file tests
   `KubeClient` with an injected `fetch`): `execRefusal`.
   - It POSTs the exec URL with `container=`, `command=`, the bearer header and
     an `http(s)` scheme.
   - It returns the `message` of a 400 Status.
   - It returns `undefined` for "Upgrade request required", for 2xx, for a
     body that is not JSON, and when the fetch throws.
4. **`packages/cli/test/engine-k8s.test.ts`.** `pickExecContainer` table:
   named, absent, annotation valid/invalid, single, first. Plus `inspect`
   **without** `pick`, which still refuses a multi-container pod with no
   annotation (attach unchanged; the existing rows at `:234-…` and
   `engine-runtime.test.ts:919-989` stay green, unmodified).
5. **`packages/tools/test/workload-shell.test.ts`.**
   - The model-facing JSON Schema (`zodToJsonSchema`, as `registry.ts:64`
     calls it) has a `description` on `target.properties.container` that
     mentions `default-container`.
   - `{engine:"docker", container:"x"}` is refused at parse.
6. **Mutation, then revert. Each must turn a test red:**
   - D1: drop `execTarget` from `open` → 1a red.
   - D1: use `shell.target` in `oneShot` → 1d red.
   - D3: make `explain` skip `execRefusal` → 1e red.
   - D1: let `info` count toward `isError` → 1g red.
   - D2: in `pickExecContainer`, make the default mode fall back to `names[0]`
     → the attach-unchanged row in 4 red.
7. **Opt-in live row** (`TENTACLE_K8S_SERVER`, kind), next to the existing
   live-k8s test. It creates a 2-container busybox pod (`first`, `second`,
   `sleep 3600`) and checks:
   - `run hostname` with no container → `exit=0` and an open line naming
     `first`;
   - `container: "second"` → `exit=0`;
   - `container: "nope"` → refused with `[first second]`;
   - `execRefusal` against the real apiserver, with no container → returns
     the `a container name must be specified …` Status. **This is the one
     apiserver fact D3 relies on that was not run here** (kind was down), so
     it must pass live before Review signs off.

   The docker opt-in row (`TENTACLE_DOCKER_TESTS=1`) checks that an exec into
   a stopped container gives a readable error.

### Owner questions

1. **D3 sends one extra `POST …/exec` (no upgrade) after a refused exec, to
   read the apiserver's reason.** It never runs a process, but on audited
   clusters (OpenShift) it shows up as a second `pods/exec` create attempt.
   *Recommendation: accept.* It runs only after a failure, and it is the only
   way to get the real message out of Bun's WebSocket (repro B). The
   alternative is a generic hint with no API text.
2. **Omitting `container` and later naming the same container explicitly
   gives two shells and two approvals** (the key is the target as written).
   *Recommendation: accept.* It errs toward more asks, never fewer. Keying on
   the resolved container would need a cluster read before the permission
   prompt, i.e. I/O inside the gate.
3. **Should session-hop `attach` also fall back to the first container
   (kubectl's rule) instead of refusing** (`engine-k8s.ts:207-216`)?
   *Recommendation: no, not in this fix.* `attach` installs the daemon in that
   container, so a silent pick there costs more. If wanted, it becomes a
   separate `fix` that only switches `pick` on.

## Execution

*— (pending)*

## Review

*— (pending)*


#### Owner decisions added after the plan (2026-11-15 02:00–02:06) — binding, part of THIS fix

1. **`workload_shell` is DISABLED by default**: not offered to the model unless the config enables it, same shape as `move_session` (`sessionHop.tool: true`, docs/feat/session-hop-ux.md decision 8) — e.g. `workloadShell.tool: true`; documented in the config reference and `tentacle config list`. Tests: default → tool absent from the model's tool list; enabled → present.
2. **Cause confirmed live**: on the 5-container pod every call without `target.container` fails; with `"container":"etcd"` it works (0.1–0.2 s). On a single-container pod it works without one.
3. **New bug (sentinel leak)**: the FIRST command of a fresh shell on `etcd-guard-…` (`hostname`) returned `guard-3a6ec32139722234d98bed4f29e301189cef109a-end` instead of the hostname — the delimiter leaked into the output or the parser cut the real output. Reproduce with the fake exec, fix, and assert a command's output never contains the delimiter.
4. **Restore the working directory on reconnect** (orchestrator, low risk): when a dead shell is reopened, `cd` back to the last known cwd and say so in the result; environment variables are NOT replayed (they may hold secrets).

*— claude-opus-5-5 (orchestrator), 2026-11-15*
