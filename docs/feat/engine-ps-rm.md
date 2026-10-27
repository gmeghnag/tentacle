# feat/engine-ps-rm — `tentacle ps`, `tentacle rm <name>`, and `attach <name>` that resolves engine + location by itself (docker-runtime slice E)

> **Status:** execution (owner answered Q1–Q2 on 2026-10-27; plan corrected at Step 0 — see "Step 0 — plan vs code" below; executed by claude-opus-5-5)
> **Branch:** `feat/engine-ps-rm` — lands **on top of** slice C (`feat/docker-engine-cli`: `--engine`, `--keep`, `engine-runtime.ts` renames) and slice D (`feat/docker-workspace-mount`: cwd mount + `create` options). Rebase onto `main` once both merge, before Execution.
> **Type:** feat · **Size:** L · **Blast:** load-bearing · **Suited:** strong model executes; **mandatory fresh-context Review** red-teaming AGENTS §7 "Pod/container lifecycle" (`rm` is the first command that deletes a workload outside `run`'s own exit net; `attach` stays user-owned) and "Compute next to the code, identity with the user; a pod is not trusted" (labels are written by a workload we do not trust the *contents* of).

## Context

*— claude-sonnet-5-5, 2026-10-27*

Slice E of `docs/eval/docker-runtime.md`. After C, `run --keep` leaves a pod/
container behind and prints `tentacle attach --engine <e> [-n ns|--context c] <name>`
(`docker-engine-cli.md:286-301`). Nothing lists those workloads, nothing removes
them except the user's own `docker rm` / `kubectl delete`, and `attach` needs the
user to remember engine, namespace/context and endpoint. The UX is **already
approved by the owner** (`.tentacle/tmp/plans/engine-ps-rm-ux.md`, 2026-10-27) and
is implemented exactly:

```
$ tentacle ps
NAME              ENGINE      WHERE            MOUNT             AGE   STATUS
tentacle-ab12cd   docker      local            ~/code/tentacle   2h    running
…
4 kept · resume: tentacle attach <name> · remove: tentacle rm <name>
```

Fixed by the approved UX: columns; oldest at the bottom; `--engine <e>` filter;
`-q` names only; `-v` detail (incl. masked paths `~/.ssh` + tentacle config);
empty → `No kept containers or pods.`; an unreachable engine → a dim
`podman: not reachable (skipped)` line, never an error; `rm` → `Removed
tentacle-1b2c3d (docker, ~/code/tentacle).`, a running one asks `[y/N]`, `-f`
skips; `attach <name>` needs no `--engine`.

**Repro** (static, 2026-10-27, worktree at `0874c46`; `bun` is not needed):

```
$ rg -n '"ps"|"rm"' packages/cli/src/flags.ts
(no output)          # cliMode (flags.ts:489-512) knows connect|serve|run|attach|hooks|package|update
$ rg -n "listContainers|listPods|labelSelector|filters" packages/docker/src packages/k8s/src
(no output)          # neither client can list
```

`tentacle ps` today is a one-shot prompt (`cliMode` → `"prompt"`), i.e. it
would send the word "ps" to the model. The executor re-runs
`bun packages/cli/src/main.ts ps` first.

## Implementation

*— claude-sonnet-5-5, 2026-10-27*

### Load-bearing assumption

**A workload is "ours" only if the *engine* says it carries tentacle's labels,
and the labels are written by the laptop at `create` time through the one
`EngineHost.create` seam — so `ps` / `rm` / `attach <name>` can be built as a
read-label-then-act layer on top of the existing hosts with no runtime, daemon
or protocol change.**

Proof (main @ `0874c46`, plus the C/D plans):
- The Docker owner marker already exists and is the delete guard:
  `OWNER_LABEL = "tentacle.managed"` (`packages/docker/src/client.ts:51`) is
  added by `createContainer` to *every* create (`:238-241`, body labels are
  merged, the marker wins), and `removeContainer` refuses a container without it
  (`:296-320`, GET `/json` first). So "never remove what we did not create" is
  already enforced for Docker below any new code; `rm` adds a second check above.
- The k8s marker exists on every pod: `app.kubernetes.io/managed-by: tentacle`
  (`packages/k8s/src/pod.ts:73`), and `buildPodManifest` merges extra labels
  (`pod.ts:27`, `:73`). But **`KubeClient.deletePod` has no ownership check**
  (`packages/k8s/src/client.ts:146-156`) and `kubeEngineHost.remove` just calls it
  — so `rm` on k8s MUST `getPod` (`client.ts:133`) and verify labels itself.
- `create` is the only creation call site (`pod-runtime.ts:226-255`; `engine-
  runtime.ts` after C), and slice D turns it into `create(name, image, options?)`
  (`docker-workspace-mount.md` Design §3). Labels ride that `options`.
- Names are `tentacle-<8 hex>` from `crypto.randomUUID()` (`pod-runtime.ts:226`)
  unless a caller supplies one; uniqueness is per engine/namespace, **not
  across engines** → the ambiguity case below is real, if rare.
- No wire change: nothing here crosses the RPC (`ps`/`rm`/resolve are plain CLI
  commands run before any `Connection`, like `package`/`update`); no
  `PROTOCOL_VERSION` bump, no TUI/Ink code (AGENTS §7 "Never write raw to the
  terminal" is moot: no Ink is mounted, `write()` is the contract).

### Preconditions

- **Commands are strict-args routed**: add `ps`, `rm` to `cliMode`
  (`flags.ts:489-512`), `CliMode`, `ARGS`, `USAGE`, `HELP`; unknown flags are
  rejected before anything is dialled (`main.ts:223-236`).
- **The hidden dispatch order is untouched**: `__delete-pod` / `__delete-container`
  (`main.ts:200`, `:206`) come first; `ps`/`rm` go with the other modes after
  config load (they need `config.configDir` for the index and `HOME` for `~`).
- **Docker client has no list** (`client.ts` methods: `ping`, `version`,
  `pullImage`, `createContainer`, `start/stop/inspect/removeContainer`,
  `waitForRunning`). `GET /containers/json?all=1&filters=…` is a new method with
  the same `apiPath` / `call` / `expect` shape as `inspectContainer` (`:280`).
  `ContainerInspect.Config.Labels` (`types.ts:19`) is the existing label type.
- **Endpoint resolution** for the local engines is C's: docker →
  `resolveEngineEndpoint({env,…})` (`engine-endpoint.ts:70`), podman →
  `resolvePodmanEndpoint` (`docker-engine-cli.md` Design §2) which **ignores
  `DOCKER_HOST`**; `buildEngineHost(kind, opts, io)` (Design §3) is the one place
  that turns `kind + context/namespace/endpoint` into an `EngineHost`. ps/rm/
  resolve reuse it — **no second host builder**.
- **`EngineEndpoint.local`** is `true` only for `unix` (`engine-endpoint.ts:23-41`)
  → WHERE = `local`; `ssh` → `ssh://<host>` (user/port stripped for display);
  `tcp` → `tcp://host:port`.
- **K8s label values are restricted** (≤63 chars of `[A-Za-z0-9._-]`, must start/
  end alphanumeric): `context/namespace` and paths are **invalid label values**.
  So on k8s the selector-able marker is a label and every display field is an
  **annotation** (annotations are free text). Docker labels have no such limit.
- **K8s `get` vs `list` RBAC differ** — a user can often `get`/`delete` a named
  pod yet not `list` (failure mode below).
- **`attach` stays user-owned** (AGENTS §7): resolution only *chooses engine/
  location*; it adds no create/delete/start to the `attach` path
  (`main.ts:585-600` flow unchanged after the host is chosen).

### Design

**1. The labels (shared source of truth, both ends).**
`packages/cli/src/kept.ts` (new, **pure**, React/IO-free) exports the key
constants, `keptLabels(input)` (writer) and `parseKept(raw)` (reader), so the
two cannot drift. Written ONLY when `run --keep` (`keepHint` present, C):

| Key | Value | Docker/Podman | K8s | Notes |
|---|---|---|---|---|
| `tentacle.managed` / `app.kubernetes.io/managed-by` | `true` / `tentacle` | label (client adds) | label (exists) | the owner marker; **mandatory** to be listed |
| `tentacle.kept` | `true` | label | **label** | server-side filter; `ps` lists ONLY kept ones |
| `tentacle.engine` | `docker`\|`podman`\|`kubernetes` | label | annotation | needed: docker and podman share the Docker API, so the container cannot tell them apart |
| `tentacle.where` | `local` \| `ssh://host` \| `ctx/ns` | label | annotation | **advisory** (display fallback, `-v`); never used to *choose* where to dial |
| `tentacle.workspace` | laptop dir mounted (D) | label | — | MOUNT column; absent ⇒ `—` |
| `tentacle.created` | RFC 3339 UTC, laptop clock | label | annotation | AGE; engine-native `Created` / `creationTimestamp` is the fallback when absent or unparsable |
| `tentacle.workspace-source`, `tentacle.workspace-masked` | realpath source; `\n`-joined masked paths (D M5b) | label | — | `-v` only |

**Trust rule (pod-is-not-trusted, AGENTS §7):** labels *select and describe*,
they never *authorize a laptop effect or redirect it*. WHERE for dialling comes
from where we asked (the endpoint / index entry we queried), not from
`tentacle.where`. A forged label on a foreign container can at worst add a row
that `rm` then refuses (the engine-side guard needs `tentacle.managed=true`,
which only matters if the *same engine user* forged it — the engine user is
already the trust root, so this is hygiene, not a boundary; documented).

**2. Pure view/logic module — `packages/cli/src/kept.ts` (same file as labels).**
No IO, all unit-tested (AGENTS §7 "Logic lives in pure modules"):
- `parseKept({kind, name, labels, annotations, nativeCreated, state})` →
  `KeptWorkload | null`. `null` unless the managed marker AND `kept=true` AND a
  known engine — a container without them is **never listed, never removed**.
- `sortKept` (newest first ⇒ oldest at the bottom; ties by name),
  `formatAge(now, created)` (`<1m`→`now`, `Nm`, `Nh`, `Nd`; future/NaN → `?`),
  `formatMount(path, home)` (`~/…`, `—`), `formatWhere`,
  `renderTable(rows)` (column widths, `trimEnd`), `renderQuiet`, `renderVerbose`
  (one block per workload: image, labels read, workspace source, masked paths,
  engine endpoint), `summaryLine(n)`, `skipLine(label, reason)` (dim markers are
  applied by the caller: `NO_COLOR`/non-TTY → plain), `emptyLine`.
- `resolveByName(name, workloads)` → `{kind:"one", w} | {kind:"none"} |
  {kind:"ambiguous", candidates}` — the `attach`/`rm` resolver, pure.
- `removeConfirmation(w)` → the `[y/N]` text.

**3. Where do we look? — the laptop-side index (see Q1).**
`packages/cli/src/kept-index.ts` (new): `<configDir>/kept/index.json`,
`{schemaVersion:1, entries:[{engine, endpoint?, context?, namespace?, name}]}`.
Written by `run --keep` after `create` succeeds (locators only — **no
credentials**: a docker `context` name or an `ssh://` URL without secrets; a
kube context + namespace). It is a *hint list*, never authority: every entry is
re-verified against the engine's labels each time; an entry is pruned only on a
definitive "gone" (404 / empty successful list), **never** on unreachable /
403. Unknown `schemaVersion` → refused and left untouched (the on-disk-records
rule, AGENTS §7). Read-modify-write is atomic (temp + rename); a corrupt file is
ignored with a dim line (ps still scans the local engines). Pod daemons never
get it (laptop-only, like the session store).

`ps` scans, **concurrently, each bounded (3 s) and independent**:
(a) local Docker (default endpoint), (b) local Podman (discovered; "no socket
found" ⇒ the dim `podman: not reachable (skipped)` line, not an error),
(c) every index entry not already covered (dedupe by realpath'd socket for
(a)/(b) — podman's docker-compat socket may be the same endpoint — and by
`ctx/ns`/URL for the rest). K8s is dialled **only** for index entries, so a
docker-only user never triggers a kubeconfig exec-credential plugin
(`kube-auth.ts:runExecPlugin` spawns an external command).

- Docker side: `DockerClient.listContainers({all:true, label:[managed, kept]})`
  → `GET /containers/json?all=1&filters={"label":["tentacle.managed=true","tentacle.kept=true"]}`
  (new, `packages/docker`), summary has `Names`, `Labels`, `State`, `Created`.
- K8s side: `KubeClient.listPods(labelSelector)` →
  `GET …/pods?labelSelector=app.kubernetes.io/managed-by=tentacle,tentacle.kept=true`
  (new, `packages/k8s`). On 403 for an indexed namespace: degrade to `getPod`
  per indexed name (needs only `get`); still 403 ⇒ dim line.
- Every row passes through `parseKept` (client-side re-check of the labels the
  server-side filter already applied: defence in depth).

**4. `tentacle ps`** (`packages/cli/src/kept-cmd.ts`, new, thin IO shell over
the pure module; injected `scan`, `write`, `now`, `home`, `isTTY`). Flags:
`--engine <e>` (filter; validated with C's `parseEngine`), `-q`, `-v`. Exit `0`
always (skips are informational); an invalid flag is the usual usage error.

**5. `tentacle rm <name>`** — `-f`. Flow: `scan` → `resolveByName` →
 - `none` → `[error] no kept container or pod named "X" — see \`tentacle ps\``,
   exit 1 (if the index still lists it and the engine confirmed it gone: prune
   the entry, say so);
 - `ambiguous` → error listing `engine · where` per candidate and the exact
   retry (`tentacle rm --engine docker X`; `--engine` narrows by kind, and for
   k8s/ssh duplicates the second line gives `--context …`), exit 1, **nothing
   removed**;
 - `one` → if `running` and not `-f`: prompt `[y/N]` via the existing readline
   helper (`terminal.ts`) — default **No**; **no TTY ⇒ refuse** ("pass -f"),
   never an implicit yes. Then **`parseKept` again on a fresh `inspect`/`getPod`
   immediately before the delete** (the re-verify closes the list→delete race
   and the k8s no-guard gap), then `host.remove(name)` (Docker:
   `removeContainer`, already label-guarded, kill + `force&v`; k8s: `deletePod`),
   drop the index entry, print `Removed <name> (<engine>, <mount|where>).`;
 - a refusal from the engine-side guard (`not created by tentacle`) is printed
   verbatim, exit 1.
 `rm` never starts, creates, stops anything else, and never touches an
 unlabelled or not-kept workload (even a tentacle-managed one: a not-kept
 managed container belongs to a live `run` that deletes itself — refused with
 that explanation; see Q2).

**6. `tentacle attach <name>`** — resolution (`attach` stays user-owned):
 - If the user passed **any** of `--engine`, `-n/--namespace`, `--context`,
   `-c`: **no resolution**, C's path exactly as built (explicit wins; also keeps
   attaching to a user-made pod/container working).
 - Else `scan` → `resolveByName`: `one` ⇒ synthesize the C inputs
   (`engine`, `namespace`/`context`/endpoint from **where we found it**, not from
   its labels) and go on through the *same single* `buildEngineHost` →
   `attachEngineRuntime` call (AGENTS §7 "one session path"; no parallel loop);
   a one-line `[container] resolved tentacle-ab12cd → docker, local` before the
   status line. `none` ⇒ fall through to C's default-engine path (today's
   behaviour, its own "not found" message). `ambiguous` ⇒ usage-style error
   with the candidates, exit 1, nothing dialled further.
 - D's M7 (attach from another cwd → warning) is unchanged and runs after.
 - `attach` for an unreachable engine keeps C's `[container] failed: …` line.

**7. Docs/help.** `HELP` (+ `ps`, `rm`), `USAGE.ps` / `USAGE.rm`, README "Ways to
run" (keep → ps → attach → rm lifecycle), `F4-pod-execution.md` (labels table,
index), AGENTS §7 "Pod/container lifecycle": add "`rm <name>` removes only
workloads carrying tentacle's managed + kept labels, on the user's explicit
command; `attach` resolution only picks engine/location, never creates or
deletes" (wording; rides this branch per AGENTS §10(c)), `TODO.md`.

### Required from slice D (and C) — labels and seams this slice reads

D's plan (`docker-workspace-mount.md` Design §2/§3) writes only
`tentacle.workspace=<target>` and `tentacle.workspace-user`; C's plan writes **no**
labels beyond the client's `tentacle.managed`. Reading them, `ps` needs:

1. **`EngineHost.create(name, image, options?)` carries `labels?: Record<string,string>`
   next to D's `workspace`**; the docker host merges them into `Labels` in
   `containerBody` (the client then adds `tentacle.managed`), and the k8s host
   passes them to `buildPodManifest({labels})` (**labels** for `kept` only,
   **annotations** for the rest — `buildPodManifest` has no annotations option
   today; add it, `pod.ts`). If D lands without this `options` shape, E adds it.
2. **D must write, when a workspace is mounted:** `tentacle.workspace` (target;
   same absolute path as the laptop source on a local engine — D Design §1),
   `tentacle.workspace-source` (realpath), `tentacle.workspace-masked`
   (the M5b mask paths: `~/.ssh` and the real config dir, only those that lie
   inside the source), `tentacle.workspace-user` (exists). Absent mount ⇒ none of
   them (⇒ `—`).
3. **This slice writes** (via `keptLabels`, called by C's `keepHint`/`--keep`
   branch in `engine-runtime.ts`): `tentacle.kept`, `tentacle.engine`,
   `tentacle.where`, `tentacle.created`. `--keep` is the *only* thing that sets
   `kept`; non-kept `run` creates are unchanged (no kept label ⇒ invisible to ps).
4. **`created` may be re-stamped only by us**: engine-native `Created` is the
   fallback; no label is ever read for AGE if it parses to the future.

### Files

Dependency order (paths after C's renames):
1. `packages/docker/src/types.ts`, `client.ts` (`listContainers`), `index.ts`
2. `packages/k8s/src/client.ts` (`listPods`), `pod.ts` (annotations option), `index.ts`
3. `packages/cli/src/kept.ts` (new, pure: labels, parse, sort, format, render, resolve)
4. `packages/cli/src/kept-index.ts` (new: store, atomic write, `schemaVersion`)
5. `packages/cli/src/kept-cmd.ts` (new: scan orchestration, `ps`/`rm`/resolve IO shell)
6. `packages/cli/src/engine-host.ts` (`create` `labels`, if D lacks it), `engine-docker.ts`, `engine-k8s.ts` (pass-through), `engine-runtime.ts` (labels + index write under `keepHint`), `engine-select.ts` (resolution glue), `flags.ts` (`ps`/`rm` modes, `ARGS`, `USAGE`, `HELP`), `main.ts`
7. tests: `packages/cli/test/kept.test.ts`, `kept-index.test.ts`, `kept-cmd.test.ts` (all new), `engine-docker.test.ts`, `engine-k8s.test.ts`, `engine-runtime.test.ts` (labels reach create), `main.test.ts` (`ps`/`rm` routed, not a prompt), `args.test.ts`, `packages/docker/test/client.test.ts`, `packages/k8s/test/*`
8. docs: `README.md`, `docs/architecture/F4-pod-execution.md`, `AGENTS.md` (§7 wording), `TODO.md`, this doc.

Not touched: protocol, daemon, TUI, persistence of sessions, `wiring.ts`.

### Failure modes

| Mode | Where | Converges to |
|---|---|---|
| An engine is unreachable (Docker Desktop stopped, podman machine down, no podman socket, ssh host down, bad kube context) | `scan` per engine, 3 s bound | dim `podman: not reachable (skipped)` (reason after a dash), other engines still listed, **exit 0**; `rm`/`attach` that needed that engine report it by name, exit 1; the index entry is **kept**. |
| Label missing | `parseKept` | `null`: never listed, never removed. A managed-but-not-kept container is invisible to `ps` and refused by `rm` (Q2). |
| Label forged (foreign container carrying the labels; or a garbage `created`/`workspace` value) | `parseKept`, engine guard | Garbage values are rendered inert (`?`, `—`, control chars stripped — a label is untrusted text printed to the terminal: no escape sequences reach the TTY). A fully forged row requires engine access (already the trust root); `rm` still goes through `removeContainer`'s owner check and a fresh re-verify. |
| A container NOT created by tentacle | server filter + `parseKept` + `removeContainer` guard + k8s `getPod` check | never listed; `rm <its name>` ⇒ "no kept … named", nothing sent. Three independent guards, the k8s one added here because `deletePod` has none. |
| Same name on two engines/locations | `resolveByName` | `ambiguous`: both listed with engine·where, exact retry command, nothing dialled/removed; `attach` falls the same way; an explicit `--engine`/`-n`/`--context` bypasses resolution. |
| Docker and Podman share one socket | scan dedupe | one row, engine from `tentacle.engine`. |
| `rm` of a running container with a session attached (other terminal / other machine) | `rm` | `[y/N]` default No; no TTY ⇒ refuse unless `-f`. We cannot detect "a session is attached" (the daemon's exec is opaque), so *every* running one asks. The attached TUI then sees `gone` through its normal reconnect preflight (`dialVerdict`, `engine-docker.ts`, `engine-k8s.ts`) and ends cleanly — no new code, pinned by a test. |
| `rm` races: workload vanished / replaced between list and delete | fresh re-verify | 404 ⇒ idempotent "already gone" (prune index); replaced by an unlabelled one ⇒ refused. |
| K8s RBAC denies `list` pods | `listPods` 403 | fallback to `getPod` per indexed name; still 403/401 ⇒ dim `kubernetes dev/agents: not allowed to list pods (403) — skipped`, exit 0. A 403 on `delete` in `rm` ⇒ the cluster's message verbatim + "ask your cluster admin", exit 1, index entry kept. |
| Kubeconfig lacks the indexed context / exec plugin fails | k8s branch of `scan` | dim skip line, others unaffected; the plugin runs only for indexed k8s entries. |
| Index file missing / corrupt / newer `schemaVersion` | `kept-index` | missing ⇒ empty (local engines still scanned); corrupt ⇒ ignored + dim line; newer ⇒ refused and untouched, dim line "upgrade tentacle". Never half-loaded. |
| Index lists a workload that was removed outside tentacle (`docker rm`) | `scan` | definitive 404 / empty list ⇒ entry pruned silently; unreachable ⇒ kept. |
| Pod/daemon tries to write the index | — | impossible: the index lives only on the laptop; pods never see it (and `ps` never trusts a label to choose a dial target). |
| Empty (nothing kept anywhere) | `ps` | `No kept containers or pods.` exit 0 (`-q`: no output). |
| Name given to `rm` is empty / has several | strict args | usage error, exit 1. |
| `--engine` filter names an unknown engine | `parseEngine` (C) | `[error] unknown engine …` + usage, exit 1 — before any dial. |
| `attach <name>` with no match | resolve `none` | falls through to C's path (default engine) so user-owned workloads still attach; its "not found … see `tentacle ps`" hint stays. |
| Terminal injection via label text | `renderTable` | stripped to printable; tested with an ESC sequence in a label. |
| `v=true` on remove deleting data | `removeContainer` (`client.ts:309`) | only anonymous volumes; D's bind mount is never a volume (D already asks the executor to confirm). |

### Tests

Red first for each slice (paste the red line); mutations restored from a `cp`
backup with matching `shasum` (AGENTS §9).
- `kept.test.ts` (pure): `keptLabels` ↔ `parseKept` round-trip for each engine
  (labels vs annotations); `parseKept` → `null` for: no managed marker, no
  `kept`, unknown engine, label-only-`kept` without the marker, annotations
  carrying `kept` (k8s needs the *label*); `sortKept` order; `formatAge` boundaries
  (59s, 1m, 59m, 1h, 23h, 1d, future, NaN); `formatMount` (`~`, outside home, none);
  `renderTable` exact golden of the approved UX block (4 rows, summary line);
  `-q`; `-v` incl. masked paths; ESC in a label stripped; `resolveByName` one/
  none/ambiguous. Mutations: drop the managed-marker check in `parseKept` → red;
  reverse the sort → red.
- `kept-index.test.ts`: round-trip; atomic write (temp+rename; a crash leaves the
  old file); unknown `schemaVersion` refused and **file byte-identical**;
  corrupt ignored; prune only on definitive gone (unreachable keeps).
- `kept-cmd.test.ts` with fakes (match `FakeCluster` / the docker fake socket, no
  real IO): `ps` with docker+podman+indexed k8s; podman unreachable ⇒ dim line +
  exit 0 + others listed; k8s `list` 403 ⇒ `getPod` fallback, then skip line;
  `--engine` filter; empty; `rm` happy (`Removed … (docker, ~/code/tentacle).`);
  `rm` running ⇒ prompt asked, answer `n`/empty/EOF ⇒ nothing removed; no TTY ⇒
  refused; `-f` ⇒ no prompt; `rm` of an unlabelled container ⇒ **zero DELETE/
  kill requests recorded**; `rm` managed-but-not-kept ⇒ refused; ambiguous ⇒
  nothing removed; k8s `rm` uses `getPod` label check (the fake records a DELETE
  only after it); race (labels stripped between list and delete) ⇒ refused.
  Mutation: skip the fresh re-verify → red; let `rm` remove a not-kept → red.
- `engine-runtime.test.ts` / `engine-docker.test.ts` / `engine-k8s.test.ts`: with
  `keepHint`, the labels reach `create` (docker body `Labels`; k8s manifest labels
  + annotations) and the index is written; without `--keep` none of them is
  written (byte-identical to today). Mutation: write `kept` without `--keep` →
  red.
- `main.test.ts` / `args.test.ts`: `ps`/`rm` route to their handlers and are **not**
  sent as a prompt; unknown flags rejected; `rm` without a name ⇒ usage;
  `attach <name>` with no flags resolves to the indexed engine (end to end with
  the unreachable-endpoint env C's tests use — **env isolation per C's Review
  finding 1: no test may reach a real engine/cluster**); with `--engine` it does
  not scan.
- `client.test.ts` (docker) / k8s client test: `listContainers` builds the exact
  `filters` query and parses `Labels`; `listPods` builds the exact
  `labelSelector`; 403 ⇒ `KubeApiError`.
- Live, opt-in (`TENTACLE_DOCKER_TESTS=1`, pasted in Execution, not gate):
  `run --keep` → `ps` → `attach <name>` (no `--engine`) → `rm` on Docker Desktop
  and a podman machine. Stated unverified otherwise.
- Gate: `bun run check`, baseline = D's final count; lint baseline clean.

### Step 0 — plan vs code (main @ `dda7503`, with C and D merged)

*— claude-opus-5-5, 2026-10-27*

Verified, holds:
- `EngineCreateOptions.labels` already exists (`engine-host.ts:50-55`), is
  threaded by the runtime (`engine-runtime.ts:161`, `:256-259`), merged by the
  docker body under D's workspace labels (`engine-docker.ts:99`) — the client
  adds `tentacle.managed` last (`docker/src/client.ts:257-260`) — and passed to
  `buildPodManifest({labels})` by the k8s host (`engine-k8s.ts:140-148`).
  Nobody sets it yet (`main.ts:729-751`).
- D writes `tentacle.workspace` / `-source` / `-masked` (a **JSON array**, not
  `\n`-joined as the plan says) / `-user` on every container
  (`workspace-mount.ts:430-439`, `:811-821`).
- `removeContainer` guards on `tentacle.managed=true` (`client.ts:319-350`);
  `KubeClient.deletePod` has no guard (`k8s/src/client.ts:146-155`); k8s
  managed marker `app.kubernetes.io/managed-by: tentacle` (`pod.ts:73`);
  `buildPodManifest` has no annotations option.
- `ps`/`rm` route to `prompt` today (`flags.ts:495-518`; repro below).
- `resolveKeep` defaults to **true** (`engine-select.ts:127-139`): every `run`
  without `--keep=false` is kept and goes in the index.

Contradicted → the design is corrected HERE (owner E-Q1: "a laptop-side index …
`ps` reads it and verifies each entry against its engine (marks vanished
ones); `rm` removes the entry"):
1. **The index is the list; the engine only verifies.** `ps` does not scan
   engines by label (no `listContainers` / `listPods`): it reads the index and
   verifies each entry with ONE `inspect`/`getPod` on the location it was
   created on. This drops the k8s `list` RBAC failure mode, the docker/podman
   socket dedupe, and the "kubeconfig plugin runs for a docker-only user" risk
   (k8s is dialled only for a k8s entry). A vanished entry is **marked**
   (`gone`), not pruned silently (owner: "marks vanished ones"); `rm <name>`
   then drops it.
2. **One file per workload** (`<configDir>/kept/<sha256(engine|locator|name)[:16]>.json`)
   instead of one `index.json`: two CLIs writing at once never read-modify-
   write the same file (no lost update, no lock). Each file is written atomically
   (temp + rename). A corrupt / unknown-`schemaVersion` file is reported (dim
   line) and left untouched.
3. **The locator, not the label, says where to dial**: docker/podman → the
   endpoint URL actually used (`unix://…`, `ssh://…`, `tcp://…`) or the
   explicit `--context`, plus `insecureTcp`; k8s → the kube context in use
   (current-context at `run` time) or the `TENTACLE_K8S_SERVER` URL, plus the
   namespace. No credentials. `buildEngineHost` gains `host` / `kubeContext` /
   `server` options (still the ONE host builder).
4. **Display fields come from the index** (laptop-written: NAME, ENGINE, WHERE,
   MOUNT, MODEL, created → AGE); STATUS from the engine. Labels on the workload:
   `tentacle.kept=true` (a label on both engines — the `rm` guard), and
   `tentacle.engine` / `tentacle.model` / `tentacle.created` (docker labels; k8s
   **annotations**, new `buildPodManifest({annotations})`). Written only for a
   kept `run`.
5. **New seam method** `EngineHost.describe(name)` → `{status, labels,
   annotations} | null` (null = 404 gone): the label read `rm` re-verifies on
   right before the delete.

### Owner questions (with recommendation) — execution waits for these

1. **How does `ps` find workloads on remote engines and other k8s contexts?**
   The approved UX shows `ssh://build-box` and `dev/agents` rows, but a remote
   engine/cluster cannot be discovered from the laptop. Options: (a) a
   laptop-side **index** of locators written by `run --keep` (Design §3; no
   credentials, re-verified on every read, self-healing for local engines), or
   (b) scan only the local Docker/Podman + the current kube context, with
   `--context`/`-H` flags to point at others (no new state, but remote kept
   workloads are invisible until the user names them, contradicting the
   approved UX). → **Recommend (a).**
2. **Should `ps`/`rm` also handle tentacle-managed workloads that are *not*
   kept** (a live `run` in another terminal, or one leaked by a crash before
   its exit net ran)? The approved UX says "kept" only. Listing live ones would
   let `rm` kill another terminal's session; leaked ones have no cleanup today
   except `docker rm`/`kubectl delete`. → **Recommend: no** (kept only; `rm`
   refuses a not-kept managed one with an explanation); a separate
   `ps --all`/`prune` slice if leaked workloads become a real complaint.

(Decided without asking, inside the approved UX: `rm` takes one name; no-TTY +
running ⇒ refuse unless `-f`; an explicit `--engine`/`-n`/`--context`/`-c` on
`attach` bypasses name resolution; k8s display fields are annotations because
label values cannot hold `ctx/ns` or paths.)

## Execution

*— claude-opus-5-5, 2026-10-27*

**Repro on main `dda7503`** (`.tentacle/tmp/engine-ps-rm/repro.ts`, `cliMode` from `flags.ts`):

```
ps -> prompt
rm x -> prompt
```

and the red run of the new `main.test.ts` cases showed `tentacle ps` reaching
the (fake) model: `Received: "Done. File written.\n"`.

**As built, in order** (narrow test file per slice):
1. `@tentacle/k8s`: `buildPodManifest({annotations})`; the managed-by marker now
   wins over a caller label (`pod.ts:73-76`; red: `Received: "someone-else"`);
   `currentKubeContext(path?)` (`kube-auth.ts`).
2. `packages/cli/src/kept.ts` (new, pure): label keys, `keptMetadata`,
   `isKeptWorkload`, strict `parseKeptEntry`, `whereOf`, `formatAge`,
   `formatMount`, `sortKept`, `renderTable` (golden of the approved UX incl.
   MODEL), `renderVerbose`, `resolveByName`, `ambiguousMessage`,
   `removeConfirmation`, `removedLine`; every printed value through `untrustedText`.
3. `packages/cli/src/kept-index.ts` (new): one file per workload, atomic write,
   strict read; problems reported, files untouched.
4. Seam: `EngineHost.describe(name)` + `WorkloadFacts`, `EngineCreateOptions.annotations`
   (`engine-host.ts`); docker host (`describe` via `inspectContainer`, annotations
   merged into labels) and k8s host (`describe` via `getPod`, phase → status,
   annotations passed to the manifest). Red: `host.describe is not a function` +
   assertion failures on the create bodies.
5. Runtime (`engine-runtime.ts`): `annotations` + `recordKept(name) → undo`
   called right after a successful create when kept; undone on
   `WorkloadRemovedError`; a failed record is logged with the kept line (never
   swallowed). Red: 3 failing assertions.
6. `engine-select.ts`: `buildEngineHost` options `host` / `kubeContext` /
   `server`, `BuiltEngineHost.kubeContext` / `server`; `endpointUrl`,
   `keptLocation`, `hostOptionsFor` (still the ONE host builder).
7. `packages/cli/src/kept-cmd.ts` (new): `psCommand`, `rmCommand`,
   `resolveKeptAttach`; per-entry 3 s bound.
8. `flags.ts` (`ps`, `rm` modes, `ARGS`, `USAGE`), `main.ts` (dispatch after
   config load, before diagnostics; `run` labels + record when kept; `attach
   <name>` lookup when no `--engine`/`-n`/`--context`/`-c`), `HELP`.
9. Docs: README (keep → ps → attach → rm), F4 §6, AGENTS §7 lifecycle wording,
   TODO.

**Tests added:** `kept.test.ts` (13), `kept-index.test.ts` (5),
`kept-cmd.test.ts` (17), + cases in `engine-docker`, `engine-k8s`,
`engine-runtime`, `engine-select`, `main`, `k8s/pod`, `k8s/kubeconfig`.
The pure modules were written with their tests and proven non-vacuous by
mutation (below), not by a separate red step; the integration behaviours
(routing, runtime record, host `describe`/annotations) were shown red first.

**Mutations** (`.tentacle/tmp/engine-ps-rm/mutate.ts`: `cp` backup → mutate →
narrow tests → restore → `shasum` compared):

```
M1 isKeptWorkload: drop the owner-marker check: RED (3) · restored identical
M2 sortKept reversed (newest at the bottom): RED (1) · restored identical
M3 rm skips the fresh re-verify before the delete: RED (6) · restored identical
M4 run writes the kept label without --keep: RED (1) · restored identical
M5 rm forgets the entry when the engine is unreachable: RED (1) · restored identical
M6 a kept entry re-dials today's DOCKER_HOST instead of its own endpoint: RED (2) · restored identical
```

**Gate:** `bun run check` → typecheck clean, `biome check .` clean (555 files),
`bun test` **3477 pass, 3 skip (the opt-in three), 0 fail** (main `dda7503`
baseline: 3426 / 3 / 0).

**Drift from Implementation** (all recorded in "Step 0" above): index-driven
verify instead of label scans (no `listContainers`/`listPods`, no k8s `list`
RBAC fallback, no socket dedupe); one file per workload instead of one
`index.json`; vanished entries are **marked `gone`** (owner) and dropped by
`rm`, not pruned silently; a name held by a foreign workload shows
`not-tentacle` and `rm` drops the entry without touching it; unreachable rows
stay listed (`unreachable`) under the dim `… not reachable (skipped)` line;
display fields come from the index, not labels; `ps -q` dials nothing.
MODEL column added (owner).

**Red-team (AGENTS §7 "Pod/container lifecycle"):** `rm` deletes only after a
fresh `describe` says managed marker + `tentacle.kept=true` (docker's
`removeContainer` guard stays underneath; k8s relies on ours — test: zero
`remove` calls for unlabelled / managed-only / kept-only); `attach` gained only
a host choice (no create/start/delete path added; `attachEngineRuntime`
untouched); no new child process, so nothing new in argv; no Ink in `ps`/`rm`,
and the runtime's record warning rides the existing kept-line log points
(before mount / after unmount). Index: corrupt / newer file → reported, left
byte-identical; missing → empty; deleted out of band → `gone`; two writers →
separate files (20 concurrent writes, none lost); crash mid-write → old file
intact, no temp left.

**Unverified / debt:**
- Live `run` → `ps` → `attach <name>` → `rm` against Docker Desktop / podman /
  a cluster was NOT run (needs `TENTACLE_DOCKER_TESTS=1` and real engines).
- `ps -v` shows the model the session started with; the owner's "tries the
  live model where the container is running" is NOT built (needs an exec into
  the daemon).
- A docker endpoint reached with TLS from `DOCKER_HOST` + `DOCKER_CERT_PATH`
  (not a named context) is re-dialled without its TLS material → shown
  `unreachable` (loud, never pruned); use `--context` for such engines.
- A kept workload whose index file is lost (or created before this slice) is
  invisible to `ps`/`rm` (no engine scan); `docker rm` / `kubectl delete`
  still work. See owner question below.
- `currentKubeContext` was added without a separate red step (trivial helper,
  covered by its own test).

**Owner question (with recommendation):** should `ps` ALSO scan the local
Docker/Podman for containers labelled `tentacle.kept=true` that have no index
entry (self-heal after a lost index, or ones kept before this slice)? →
**Recommend: yes, in a small follow-up** (local engines only, so no kubeconfig
plugin runs; listed with a `not indexed` note).

## Review

*— claude-opus-5-5, 2026-10-27*

**Verdict: APPROVE-WITH-NITS.** The §7 "Pod/container lifecycle" invariant holds:
`rm` deletes only after a fresh `describe` reports the managed marker AND
`tentacle.kept=true`; `attach <name>` gains only a host choice.

**Gate (re-run):** `bun run check` → typecheck ✓, lint ✓ (555 files, 0
issues), `bun test` **3477 pass · 3 skip (opt-in) · 0 fail**, 3480 tests / 259
files. Identical to the orchestrator's `gate-eps.txt`.

**Mutations (non-vacuity, §9).** Each file was backed up with `cp` and
restored, and `shasum` before and after is identical (`kept.ts 9de02716…`,
`kept-cmd.ts 87da4dbd…`).
1. `isKeptWorkload` → `return owned` (drops the `tentacle.kept` check):
   **3 fail** (`kept-cmd`: "foreign … ZERO removes" with rm exit 0, "not-tentacle"
   row; `kept.test`).
2. `verify` without `bounded(…)` (no 3 s cap): **1 fail**. "a hung engine is
   bounded" times out.

**Findings**
1. *(low–medium, UX; safe)* `kept.ts:325-330` + `kept-cmd.ts:160-167`: the same
   name on the **same engine at two locations** (e.g. two docker endpoints)
   is ambiguous, and `rm` has no location flag. The advice "Narrow it with
   --engine" therefore cannot resolve it, so `rm` is unusable for both entries.
   The plan's failure-mode row (line 283) promised "the exact retry command".
   It fails loud and removes nothing. Fix: a `--context`/`--namespace`
   narrower on `rm` (or match on `engine·where`), and print the advice only
   when `--engine` would actually narrow.
2. *(low, credential scope)* `engine-select.ts` `buildEngineHost` k8s branch:
   a kept entry's `server` wins over today's `TENTACLE_K8S_SERVER`, but the
   token is still today's `TENTACLE_K8S_TOKEN`. If the env now targets
   another cluster, `ps`/`rm` send that token to the old server. The server
   came from this laptop's index (not a pod), so this is not a §7 breach.
   Consider skipping the token when `options.server` ≠ the env server.
3. *(nit)* `kept-cmd.ts:210-215`: the check and the delete are separate
   by-name calls. A same-name re-create in that window (ms) is not excluded.
   k8s `deletePod` could take a `preconditions.uid` from `describe`. Not
   required now.
4. *(debt, already declared)* A TLS `DOCKER_HOST` with no context is
   re-dialled without TLS. It shows `unreachable` (loud, entry kept).

**Attacks tried**
- **Foreign workload at the name.** A container that is unlabelled,
  managed-only or kept-only gets zero `remove` calls (test plus mutation 1).
  A forged managed+kept label from the same engine user is accepted by
  design: whoever holds the engine socket is already root on it.
- **Out-of-band delete, then name reuse.** A 404 gives `gone` and drops the
  entry. A reused name without labels gives `foreign`, nothing is removed and
  the stale entry is dropped.
- **Wrong k8s location.** The context and namespace come from the index
  (laptop-written), never from a label. `deletePod` has no guard, so the
  re-`describe` is the gate (k8s test).
- **Confirmation.**
  - Running + TTY → `[y/N]`; `n` or empty removes nothing.
  - Non-TTY + running → refused unless `-f`.
  - `-f` skips only the question, never the label re-check.
  - Labels stripped between the question and the delete → refused (race test).
- **Index.**
  - A corrupt file or another `schemaVersion` is reported and left untouched.
  - A missing dir is an empty index.
  - One file per workload plus temp+rename: no lost entry with two writers.
  - Only the laptop writes it. Pod data is used only to verify, never as a
    locator.
- **Hung engine.** Each entry is capped at 3 s (mutation 2). `main.ts:1059`
  calls `process.exit`, so a dangling socket cannot keep `ps` alive.
- **Terminal and argv.** No Ink mount in `ps`/`rm`. The runtime's record
  warning rides the existing kept-line log points. No new child process, so
  no new argv.
- **Attach stays user-owned.** The index picks only the engine and location,
  and any explicit flag bypasses the index. An ambiguous name prints an error
  and returns 1, with no guess.

**What holds:** the decisions sit in pure `kept.ts`, and `kept-cmd.ts` is a
thin IO shell. Untrusted text is sanitised on print. The owner decisions
(E-Q1 index, E-Q2 kept-only, keep-default, MODEL column) are implemented.

**Executor behaviour:** honest. Step 0 recorded the plan-vs-code drift, and
the Execution section lists its unverified parts (no live engine run) and its
debt. Its red-team claims matched the code.

**Model note:** reviewed by claude-opus-5-5, the **same model** as the
executor (only a fresh context), so blind spots may be shared. A live
`run → ps → attach → rm` against a real engine is still unverified
(`TENTACLE_DOCKER_TESTS=1`).

**Owner question (from Execution):** should `ps` also scan local engines for
`tentacle.kept` workloads that have no index entry? → **Recommend yes, as a
small follow-up**, local docker/podman only, rows marked `not indexed`.

> **Owner decisions (2026-10-27):** E-Q1 → YES, a laptop-side index written by `run --keep` (name, engine, where, mount, created); `ps` reads it and verifies each entry against its engine (marks vanished ones); `rm` removes the entry.
> E-Q2 → YES: `ps`/`rm` list/remove ONLY kept workloads (`--keep`), not a live non-kept `run`.
> **CHANGED (owner 2026-10-27): `--keep` DEFAULTS TO TRUE** — every `run` keeps its pod/container unless `--keep=false` / `keep: false`; `ps`/`rm` are therefore the primary cleanup path.
> **Owner (2026-10-27):** add a MODEL column (model the session STARTED with, from a label written at `run`; `ps -v` tries the live model where the container is running). Column order: NAME ENGINE WHERE MOUNT MODEL AGE STATUS. No truncation logic needed now (owner: plenty of width).
