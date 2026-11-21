# eval/container-sessions-mobile — drive a session whose workspace is a container, from the phone

> **Status:** context · review (verdict below) — Implementation/Execution empty until promoted
> **Branch:** none (an `eval` is committed directly to `main`, AGENTS §10)
> **Size:** — (if built: L, split into S0 spike + 5 slices, see §5) · **Blast:** load-bearing if built · **Suited:** Opus plans + executes the load-bearing slices; fresh-context Review mandatory
> **Changelog:** none (no code)

## Sintesi per il proprietario (italiano semplice)

**Verdetto: raccomandato, con condizioni — ma nella forma "A2", non in quella che il TODO dava per scontata.**

- **Cosa si vuole.** Dal telefono apri una sessione `serve` "nel container": il codice, la shell, le build girano in podman/docker (poi k8s); chiavi del modello, permessi e storico restano sul Mac.
- **Due modi di farlo.**
  - **A1 — il cervello nel container.** Un daemon tentacle gira nel container, come fa `run` oggi. `serve` sul Mac gli fa da "laptop": modello tramite il tunnel inverso, permessi, salvataggio. Il telefono parla con `serve`, che inoltra.
  - **A2 — il cervello sul Mac, le mani nel container.** La sessione è una normalissima sessione `serve`. Cambia solo *dove* i tool eseguono: `fs_read`/`fs_write`/`shell`/`search`/job usano un `ExecutionEnvironment` che esegue nel container. Questa interfaccia esiste già, ed è nata proprio per questo (ADR-005).
- **Consiglio: A2.** Tutto il percorso di sessione del telefono funziona così com'è: lista, push, Live Activity, permessi, persistenza, più client insieme. Il container non ha **nessuna voce** nel protocollo: restituisce solo output dei tool, come già fa ogni comando shell. Non serve il tunnel del modello (il modello lo chiama direttamente il Mac). Non serve iniettare il binario tentacle nel container: basta `/bin/sh`.
- **A1 costa molto di più ed è più rischioso.** `serve` dovrebbe ospitare sessioni "altrui": un secondo percorso di sessione, vietato da §7. Dovrebbe anche salvare storico scritto dal pod (da validare) e mandare push con testo deciso dal pod. È di fatto XL.
- **Il prezzo di A2.** Ogni chiamata ai file costa un `exec` nel container (decine di ms in locale, ~50–150 ms su k8s). I job in background e la loro chiusura nel container vanno verificati con uno spike prima di scrivere codice.
- **Cosa c'è già oggi (A0).** Una sessione `serve` aperta dal telefono può già usare `workload_shell` su un container esistente. Però i tool sui file e la ricerca agiscono sul Mac.
- **B e C.** A2 assorbe B ("Sposta nel container" dal telefono): diventa un cambio d'ambiente nella stessa sessione. Non assorbe C (run staccati visibili dal telefono): resta un lavoro separato, da fare solo se serve davvero.
- **Da decidere (tu): 8 domande** in fondo, ognuna con la mia raccomandazione. La più importante è la Q1: accetti A2 invece del "daemon nel pod + tunnel"?

---

## Context

*— claude-opus-5-5, 2026-11-21*

### Origin and the exact question

Owner, 2026-11-18, confirmed 2026-11-21: *"mi piacerebbe poter da mobile
controllare una sessione eseguita in un container"*. `TODO.md:83` lists three
options. The owner asked to evaluate **option A** in depth:

> The `serve` daemon stays on the Mac (trusted: model keys, permission broker,
> persistence, relay link to the phone). A chosen session's WORKSPACE (code,
> shell, builds, MCP servers that act on the workspace) runs in a container/pod
> through the existing `EngineHost`. The phone sees and drives it like any other
> `serve` session.

The decision this eval serves: **build A or not, in which shape, in which
slices, and does it make B/C unnecessary?**

**Repro (capability missing), 2026-11-21, static.** `serve` has no
workspace/image option: `OpenParams` carries `cwd`, `settings`, `messages`, …
and nothing that names an engine or an image (`packages/protocol/src/session.ts:1163-1203`).
`SessionListEntrySchema` has no place field (`session.ts:1638-1660`). Every
`serve` session's agent is built on `HostExecution` rooted at the daemon's cwd
(`packages/cli/src/serve.ts:745-746` → `createServeAgent` `serve.ts:204-247` →
`buildAgent` `packages/cli/src/wiring.ts:483-490`). The container paths
(`run --image`, `attach`, `/move`) are all TUI-side (`hop-runtime.ts:1-12`,
`engine-runtime.ts:825`, `:985`). No runtime repro is needed: the absence is
structural.

### What exists today (verified against the source)

**How `serve` hosts sessions.**
- One `SessionHost` per `serve` process, one process per project
  (`sameProject` = `projectKey(cwd) === key`, `serve.ts:585`). It is built in
  `reloadedHost` (`serve.ts:702-800`). The `createAgent` factory is
  `createServeAgent` with the daemon's config (`serve.ts:745-746`). The factory
  contract is `AgentFactory(cwd, AgentContext)` (`packages/daemon/src/session-host.ts:181-215`).
  It can also be handed `AgentReuse` (broker, jobs, grants, workload shells) on
  a settings rebuild (`session-host.ts:162-175`).
- Every agent's side effects go through `ExecutionEnvironment`
  (`packages/core/src/execution.ts:76-109`: `exec`, `readFile`, `writeFile`,
  optional `readBytes`, `readConfinedBytes`, `spawnBackground`). ADR-005 says it
  is "host now, container later, one interface … without touching callers"
  (`ARCHITECTURE.md:119-122`). Verified: `packages/tools/src/*.ts` holds **no**
  `node:fs`/`Bun.file`/`Bun.spawn` (grep, 0 hits). The fs tools, shell and search
  all call `ctx.env.*` (`builtins.ts:125,151,256,260,332,337,376,392,457`;
  `search-tool.ts:75,235,312`; `present.ts:100-104`). Background jobs are
  `new BackgroundJobs(env)` (`wiring.ts:508`). The search tool already probes
  the image for `rg` and falls back to POSIX grep (`search-tool.ts:75`,
  `search.ts:302`), because the pod daemon runs it inside arbitrary images.
- `serve` already reaches workloads from the Mac: `workload_shell` gets
  `LaptopWorkloadShellBackend` in every `serve` session (`serve.ts:232-235`,
  `workload-shell-backend.ts:68`). It rides `EngineHost.openRawExec`
  (`engine-host.ts:213`, the raw-exec primitive declared at `:64-71`).
- Persistence: `serve` is the only daemon with a `SessionPersister`
  (`serve.ts:548,588,766`). It writes its OWN entries (a log + a
  `<uid>.state.json` sidecar). On start it reloads every live record and indexes
  archived ones (`serve.ts:860-905`). The sidecar is versioned on its own. A new
  optional payload that an older build would silently drop gets a NEW version,
  written only when present (precedents: v2 image refs, v3 schedules,
  `packages/daemon/src/daemon-state-file.ts:46-75`).
- Lifecycle hooks: `onSessionDeleted` exists (`session-host.ts:367-371`, wired
  `serve.ts:744`). There is no close/archive hook ("never on close/archive",
  `session-host.ts:367`).
- `serve` answers auto-accepted asks itself and shares auto-accept across
  devices (`serve.ts:770-776`). The MCP set is daemon-wide on the Mac
  (`createMcpHub`, `serve.ts:554`; `mcpStatus`, `:750`).

**How a workspace gets into a pod today (`run` / `attach` / `/move`).**
- The pod runs `tentacle serve --bridge --model-proxy` (`engine-runtime.ts:104-105`).
  Its agent is `tunnelledAgent` (`serve.ts:1192`) and its host is
  `podSessionHost` (`serve.ts:1292`). The pod host has no persister, no
  `answersAutoAccept`, no schedules and no `workload_shell` (`serve.ts:233-238,
  764, 774-776`).
- The model is reached through the laptop: `ProxyModelProvider` sends
  `model/stream` / `model/streamChunked` to the connected client
  (`packages/daemon/src/proxy-model.ts:1-20`). The client is the session's
  `modelLink`, i.e. the most recently attached model-serving connection
  (`hosted-session.ts:251-255, 2143`; `connection.ts:291`).
- The laptop side is `createLocalRuntime` → `RemoteClient` over a `DuplexChannel`
  with THE broker (`local-runtime.ts:1181-1200`). A pod never gets the
  hooks-trust store, so a pod prompt never creates a lasting approval
  (`local-runtime.ts:1182-1190`). The laptop persists from `session/log` reads
  and writes only validated entries (`local-runtime.ts:12, 510`). Pod artifacts
  are never written on the laptop (`local-runtime.ts:934, 1379`).
- Lifecycle: `provisionWorkload` creates, waits and injects the binary
  (`engine-runtime.ts:574-599`). A kept workload is labelled and recorded
  (`recordKept`, `kept-index.ts:50`). `removeVerifiedKept` re-reads labels and
  `created` before any delete (`kept-cmd.ts:279-290`). docker/podman can mount
  the laptop folder; k8s refuses a mount (`engine-k8s.ts:216`). The engine seam
  is `EngineHost` (`engine-host.ts:173-214`: `create`, `waitForReady`,
  `remove`, `openExec`, `openRawExec`, `runExec`).
- A detached run keeps a laptop relay process: headless `attachEngineRuntime`
  that holds the model link, the broker and the save (`relay.ts:1-21`).
- `/move` builds a second runtime on the SAME broker and saver, seeded from the
  laptop record (`session-hop.ts:1-16`, `hop-runtime.ts:1-12`;
  `docs/feat/session-hop.md:86-110`). It moves the **agent loop** between
  daemons, and it lives in the TUI process.

**The phone path.**
- `apps/relay` is an untrusted splice: `/v1/daemon` is the daemon's control
  socket, `/d/<id>/e2e` the phone's leg (`apps/relay/src/server.ts:8-16`). The
  daemon dials out (`packages/daemon/src/relay-link.ts:1-20`). A phone stream
  lands in `acceptDevice`, i.e. the same Noise handshake, device registry,
  `Connection` and single broker as the direct route (`relay-link.ts:8-11, 37`).
  Pairing and the device registry: `docs/feat/device-pairing.md`.
- What the phone can do today: list sessions per computer and per project, and
  create a fresh session with a phone-minted id. Its failure text comes from a
  typed reason, never from daemon text (`apps/mobile/src/drawer-new-session.ts:1-13`).
  It can also open/attach, prompt, queue, answer permission sheets, view
  artifacts, and get push and Live Activities (feature docs under
  `docs/feat/mobile-*`). It talks **only** to `serve` daemons. It sees no
  `run`/`attach` session and has no notion of place.
- **A0, available today:** a phone-driven `serve` session can already ask the
  agent to run commands in an *existing* container through `workload_shell`.
  Its limit is the point of this eval: `fs_*`, `search`, `shell` and background
  jobs still act on the Mac.

### The two shapes of "A"

The TODO wording ("model through the existing reverse model tunnel") assumes
**A1**. The source offers a second shape, **A2**, which this eval recommends.

| | **A1 — loop in a pod daemon** | **A2 — loop in `serve`, workspace via `ExecutionEnvironment`** |
|---|---|---|
| Agent loop | pod (`serve --bridge --model-proxy`) | Mac (`serve`'s own `HostedSession`, unchanged) |
| Tool calls | executed in the pod by the pod's `HostExecution` | executed in the container by a new `WorkloadExecution` (exec over `EngineHost.runExec`/`openRawExec`) |
| Model | `ProxyModelProvider` → `serve` serves `model/stream` | `serve` calls its provider directly; no tunnel |
| What carries what | phone ⇄ `serve` (Noise) ⇄ pod daemon (`DuplexChannel` exec) — full session RPC crosses the pod boundary | phone ⇄ `serve` as today; `serve` ⇄ container only exec bytes (stdin / stdout / stderr / exit) |
| Pod's voice | a full JSON-RPC peer: updates, asks, log entries, titles, artifacts | none: tool output bytes only |
| Session in `SessionHost` | a **foreign** session `serve` must list, persist, push for and forward | a normal session with a workspace binding |
| Binary in image | injected tentacle binary (musl/glibc, version skew) | `/bin/sh` (+ optional `rg`) |

**A1's cost, in the source.** `Connection` serves sessions only through
`SessionHost`/`HostedSession` (`session-host.ts:898, 979-1061`), and
`HostedSession` is 4,198 lines of surface (prompt, enqueue, resolve, log,
settings, artifacts, attachments, schedules, push observer, …). A1 must either
(i) re-implement that surface as a forwarding session, which is a second session
path (§7 "one session path" forbids it), or (ii) splice phone RPC through to the
pod. Under (ii), `serve` still has to intercept `model/*`, read `session/log` and
persist **pod-supplied** entries with the laptop's validation, merge pod
sessions into `session/list` with pod-chosen titles, and derive push and Live
Activity text from pod-supplied updates (an APNs body written by the pod). That
is several load-bearing seams at once. It is XL and must be split, and every
piece widens what the pod can say to the trusted host. A1 does reuse the most
battle-tested pod path (`run`/`attach`/detach). That is its only real advantage.

**A2 needs, in the source:** one new `ExecutionEnvironment` implementation, a
per-session binding that the factory reads, provisioning without binary
injection, and a few additive protocol fields. The session, its persistence,
its list entry, push, the broker and multi-client attach are all **unchanged
code**.

### 1. Shape of A (A2)

- **Where the loop runs:** in `serve` on the Mac, inside the session's normal
  `HostedSession`.
- **Which channel carries tool calls:** none at the RPC level. A tool calls
  `ctx.env.exec/readFile/…`, and for a bound session `env` is a
  `WorkloadExecution`:
  - `exec(cmd, {cwd, env, stdin, timeoutMs, signal})` → `EngineHost.runExec`
    with `["sh","-c", cmd]`, `cwd` and env passed in the script, stdin as bytes
    (`engine-host.ts:214`).
  - `readFile`/`readBytes` → `cat -- <path>` (size check first: `stat`).
  - `writeFile` → `cat > <tmp> && mv` with stdin.
  - `readConfinedBytes` → `realpath` checked in the container against the
    workspace root, plus the secret-path rule, then read.
  - `spawnBackground` → one `openRawExec` per job, `setsid sh -c`, pgid
    captured; `kill` is a `runExec("kill -TERM -- -<pgid>")`.
  - A later optimisation may multiplex these over one long-lived raw exec, using
    `workload_shell`'s framing (`workload-shell-frame.ts`). v1 does not need it.
- **Changes in `SessionHost`:** the binding is a session fact the factory reads:
  `AgentContext.workspace` → `createServeAgent` builds `WorkloadExecution`
  instead of `HostExecution`. The factory contract stays one function. The
  binding is persisted in the sidecar under a **new sidecar version** (4), written
  only for bound sessions (same pattern as v2/v3,
  `daemon-state-file.ts:46-75`). An older `serve` then refuses that one session
  and leaves its files untouched, instead of reloading it as a Mac session.
  **That silent fallback is the most dangerous failure in this whole design:**
  the agent would edit Mac files while believing it is in the container.
- **Session list / protocol (additive only; no `protocol.d/` note needed):**
  - a method or `initialize` capability that publishes the Mac's workspace
    **presets** (names + display facts, never an image string the phone
    invents);
  - `OpenParams.workspace: { preset }`;
  - `SessionListEntry.workspace` (display: preset, engine, state);
  - a **display**-class `session/update` `workspace_status` (provisioning
    phase, ready, gone).

  All of these are free under v10 forward-compat (strip schemas; a new display
  kind shows `unsupported` once on an old client, AGENTS §7). The one
  silent-drop risk on the wire: an **old `serve`** strips
  `OpenParams.workspace` and creates a Mac session. This is designed out
  because the phone offers presets only from a daemon that published them (an
  old daemon answers `MethodNotFound` / no capability, so no option is shown),
  and the open result echoes the binding, which the phone checks. A mismatch
  makes the phone refuse to open the session.
- **How a phone session is created "in a container":** the drawer's New
  session gets a second line, "New session on ▸ `<preset>`", listing the presets
  that this computer published. Presets live in the Mac's config, e.g.
  `workspaces.<name> = { engine, image, mount: true }`. The engine is resolved by
  the existing `engine-select.ts`. With a mount, the cwd is the project folder at
  the same path (`planWorkspace` mounts at the same path; session-hop doc P7).
  Open returns at once. Provisioning runs as session state with
  `workspace_status` phases, and a prompt sent meanwhile is queued by the
  existing daemon queue. List and header show a small place badge. Nothing
  else changes on the phone.

### 2. §7 invariants it touches (A2)

| invariant | how A2 keeps it |
|---|---|
| **One session path** | No new session path. The session is `serve`'s own. A new *execution environment* is the seam ADR-005 reserved (`ARCHITECTURE.md:119-122`). It adds no transport to the session stack. |
| **Single broker** | Unchanged: the session's broker is the one `serve` already shares with every attached device. `WorkloadExecution` never asks anything; asks stay in the gate before the tool runs. |
| **Persistence on the trusted host** | Unchanged: `serve` writes its own log + sidecar. Nothing is pod-supplied except tool output text inside `ChatMessage`s, exactly as today for any shell output. The binding goes in the sidecar under a new version (above). |
| **Pod not trusted, laptop effects gated on the laptop** | Strictly stronger than `run`. The container has no RPC voice: it cannot raise asks, write log entries, name a title, push to the phone or request a model call. A hostile container can only return hostile **tool output**, which is prompt-injection input like any command output. Laptop-side tools (Mac MCP, `workload_shell`) stay behind the broker as today. Auto-accept: `serve`'s daemon-side auto-answer (`serve.ts:770-776`) now approves commands that run **in the container**, a narrower blast than on the Mac. |
| **Model stays on the laptop** | Trivially: the model is called by `serve` on the Mac, and the container never sees an endpoint or key. Env/argv to `exec` must carry no secrets (§7 lifecycle rule). `WorkloadExecution` passes only the session's own command env. |
| **Pod lifecycle / kept / `--rm`** | The workload is created **by the session**, labelled managed + `tentacle.kept`, with an extra `tentacle.session=<uid>` label. It is recorded in the kept index with an owner marker (`serve:<projectKey>/<uid>`), so `tentacle ps`/`rm` see it and `rm` stays user-explicit (`removeVerifiedKept`, `kept-cmd.ts:279`). `session/delete` removes it through `onSessionDeleted` (`session-host.ts:367-371`) → `removeVerifiedKept`. Archive behaviour is owner Q4. Nothing deletes a workload this session did not create; attaching an *existing* workload as a preset is out of v1. |
| **Don't serialize the peer** | Exec calls run inside tool execution, async. No per-host or per-session mutex in `WorkloadExecution` or its engine client (a test runs two sessions' long `exec` concurrently and a third session's `session/enqueue` stays fast). Parallel tool calls on one container are allowed. |
| **Never write raw to the terminal** | `serve` has no Ink. Provisioning and engine stderr go to the daemon log, not the console. |

(A1 would have to re-prove every row above against a pod that speaks RPC to
`serve`; rows 1, 3 and 4 do not hold without new validation code.)

### 3. Failure modes (A2)

| case | convergence |
|---|---|
| **Container dies mid-turn** | The in-flight `exec` ends with an engine error → the tool result is an error the model sees; the turn continues or ends on the Mac. **The session is never lost** (in A1 the loop dies with the pod and must be re-seeded from the Mac copy). The next tool call re-checks `describe`/`dialVerdict` (`engine-host.ts`) → `workspace_status: gone` and a refusal on every workspace tool (**never a fallback to the Mac**). The user can recreate (same preset, empty container, with the mount the files are still there) or delete. |
| **Engine unavailable** (podman machine down, no socket) | Provisioning fails → `workspace_status: failed(<typed reason>)`. The session exists, its tools refuse, and the phone shows a typed text. Option: "Retry". No container was created, so there is nothing to clean. |
| **Image pull slow / fails** | Phases stream as `workspace_status`, bounded by `waitForReady`'s timeout (`engine-host.ts:184`). Prompts queue. A failure → as above, and the kept entry exists only if `create` happened → `removeVerifiedKept`. |
| **Mac sleeps** | The loop pauses with the Mac (the model needs it anyway, remote-execution-model "laptop is a hard dependency"). The container keeps running. Exec streams may drop. A foreground tool in flight returns an error. **Background jobs:** what happens to an exec'd process when its stream drops is engine-specific and unverified here (docker/podman are expected to keep it running, k8s is unknown). This is the S0 spike, and until it is answered a job whose stream dropped is reported `lost` (honest), never `exited 0`. |
| **Mac reboots / `serve` restarts** | Reload reads the sidecar (v4) → the binding is restored. The container is re-dialled lazily on the first tool call. A turn cut short is closed honestly (existing reload rules, `serve.ts:860-905`). A turn suspended on a permission is re-asked. If the container is gone → `gone`, as above. Jobs from before the restart are `lost` (the `BackgroundJobs` table is in memory, as on the Mac today). |
| **Relay drop** | Only the phone leg drops. The session runs on, and the phone reconnects via the existing relay-link policy. No difference from any `serve` session. |
| **Two clients (TUI `connect` + phone)** | Unchanged: shared attachments, one broker, `askedOn`, shared auto-accept (`serve.ts:770-772`). The place badge is a list/update fact, so both see it. |
| **Container cleanup on archive / delete** | Delete → `onSessionDeleted` → verified delete. If the engine is unreachable at that moment, the kept entry is left with `delete pending` and `serve` retries at start and on `ps`. It is never silent. Archive → owner Q4. A `serve` that is never restarted keeps its entries visible in `tentacle ps` with the session title. |
| **Old `serve` + new phone / new sidecar + old `serve`** | Wire: the preset is offered only by a publishing daemon, and the open echo is checked. Disk: an old build refuses sidecar v4 and leaves the files untouched. |
| **Mount gate** | docker/podman mount = the container edits the Mac folder directly (isolation of *execution*, not of *files*). The existing `mountGate` (session-hop doc P7) asks on the Mac's terms when creating the preset session, through the broker, once per session. |
| **Mount write-back into what `serve` trusts** | With the mount, any process in the container (one approved command is enough) can rewrite files the **Mac** `serve` later reads as its own inputs. (a) Project hooks: the hooks-trust answer is keyed on the content hash (`hooks-trust.ts:28-40`; `serve` uses its own precheck, `serve.ts:955-959`), so a changed hooks file is re-asked through the broker, never run on an old approval. (b) `AGENTS.md`, skills and agent defs that `serve` reads from `config.cwd` into the prompt: this is prompt-injection input, the same class as tool output, and it gains no laptop effect without the broker. (c) `.git/hooks` and similar files that the *user's own* Mac tools run later: this risk already exists for `/move` and `run` with a mount. A2 does not widen it, but the preset doc must say so plainly (Q8). The rule for S2: `serve` must never treat a file under the mounted folder as a lasting approval. |

Under **A1** the same cases are worse in three places. If the pod dies, the loop dies with it, and the session must be re-seeded from the Mac copy (the `/move` / re-attach path). On a `serve` restart, `serve` must re-dial a pod daemon and reconcile two copies of the log (the pod's and its own), where A2 has only one. And with two clients, the pod's `modelLink` is whichever connection attached last (`hosted-session.ts:251-255`). That connection is now `serve` itself, so the pod daemon has exactly one peer, and every phone/TUI fan-out is new forwarding code in `serve`.

### 4. B and C, briefly

- **B — "Move to container" from the phone (session-hop from the phone).** Today
  hop moves the **loop** and lives in the TUI process (`hop-runtime.ts:1-12`).
  A `serve` session's loop is in `serve`, so moving it into a pod means `serve`
  hosting a foreign session: A1's whole cost, plus hop orchestration in `serve`.
  **On top of A2, B is cheap (S–M):** switch the session's binding and rebuild
  the agent through the existing settings-apply path with `AgentReuse`
  (`session-host.ts:162-175`). The guard rules come straight from hop's
  (refuse with running jobs or sub-agents, wait for idle). **A2 subsumes B.**
- **C — detached runs listed/attachable from the phone.** They reuse the
  detached relay (`relay.ts`, laptop-side, the pod holds the loop) and the
  laptop store, not `serve`'s. The phone talks only to `serve`, so C needs
  `serve` to discover relays and splice phone ↔ relay ↔ pod. That is the A1
  problem again (foreign sessions, pod-supplied list and push text), but scoped
  to runs started from a terminal. Cost L, load-bearing. **A2 does not subsume
  C.** It removes most of the *reason* for C ("I want a container session I can
  drive from the phone"), leaving only "I started a `run` at my desk and want to
  watch it from the phone". Recommend deferring C until that case is concrete.
- A1 would partly subsume C (same forwarding machinery), but it costs more than
  A2 + B together.

### 5. Size, blast, slices, owner questions

**Building A2 overall: Size L · Blast load-bearing** (agent factory of `serve`,
sidecar format, a new execution environment under every tool). Split:

| slice | what | size · blast |
|---|---|---|
| **S0** (spike, no merged code; results into the promoted feat doc) | `.tentacle/tmp/container-sessions-mobile/`: prototype `WorkloadExecution` over podman and k8s. Measure a realistic tool mix (20 `fs_read` + 5 `search` + 5 `shell`) vs host. Check what happens to a `setsid` job when its exec stream closes, on docker/podman and on k8s. Check that `kill -- -pgid` reaches grandchildren. | S · contained |
| **S1** | `WorkloadExecution implements ExecutionEnvironment` (new module, with fake `EngineHost` tests: exit codes, stdin, binary-safe read/write, confined read, timeout/abort, error mapping). No consumer yet. | M · contained |
| **S2** | `serve`: config presets, a per-session binding (`AgentContext.workspace` → `createServeAgent`), provisioning (create + `waitForReady`, no injection, labels + kept entry with owner), sidecar v4, lazy re-dial on reload, `gone`/`failed` states with **no Mac fallback**, delete cleanup through `onSessionDeleted`. A `connect` TUI can open a preset (test surface before the phone). | M–L · load-bearing |
| **S3** | protocol (additive): preset publication, `OpenParams.workspace` + echo, `SessionListEntry.workspace`, display update `workspace_status`; `client/mapping.ts` reverse mapping. | S–M · cross-module |
| **S4** | phone: "New session on ▸ preset", badge in list/header, provisioning row, typed failure texts, echo check. | M · contained (mobile) |
| **S5** | background jobs in the container (per S0's answer), then optionally B ("Move to container / back") through the settings-apply rebuild. | M · load-bearing |

Order: S0 → S1 → S2 → S3 → S4 → S5. Each is one branch at a time (§10). S2
and S5 need fresh-context Review that red-teams "no Mac fallback", single
broker, and the kept/delete rules.

**Owner questions (each with a recommendation):**

1. **Shape: A2 (loop on the Mac, workspace via `ExecutionEnvironment`) instead
   of A1 (pod daemon + reverse model tunnel)?** *Recommend A2.* It reuses the
   whole `serve`/phone path unchanged, the pod gets no RPC voice, and there is
   no binary injection. A1 is XL and widens the pod's reach into the trusted
   host.
2. **Who chooses the image?** *Recommend: presets in the Mac's config only.* The
   phone picks a preset name and never sends an image string. This keeps the
   phone UX one tap, and a stolen paired phone cannot pull an arbitrary image.
3. **Engines in v1?** *Recommend docker/podman with the same-path mount first.*
   k8s second: it has no mount (`engine-k8s.ts:216`), so the code must already
   be in the image or cloned. That is a separate design question (and Q8).
4. **Container fate when the session is archived (`session/close`, idle TTL,
   detached cap)?** *Recommend: keep it (stopped if the engine supports
   stop/start, else running), and delete only on `session/delete` or an explicit
   `tentacle rm`.* This matches "`run` keeps by default" and "an archive purges
   nothing". A per-preset `rm: onArchive` is an opt-in.
5. **Hooks in a container session?** *Recommend: they run on the Mac, as today.*
   With the same-path mount they see the same files. For a no-mount (k8s)
   preset they are disabled with a notice.
6. **MCP servers?** *Recommend: the daemon-wide Mac MCP set stays available
   (identity-side tools: GitHub, Jira …, behind the broker as today).
   Container-side MCP servers (stdio over a raw exec) come in a later slice.*
7. **Background jobs in v1?** *Recommend yes, if S0 shows a reliable kill and an
   honest "lost" on stream drop. Otherwise v1 refuses `background: true` in
   container sessions with a clear message.*
8. **Isolation intent: with the mount the container edits the Mac's folder
   directly.** Is that what you want (isolated *execution*: deps, toolchains,
   builds), or do you want isolated *files* (a copy/clone in the container)?
   *Recommend the mount for v1.* It is the existing `/move` default and keeps
   the Mac copy as the truth. A copy mode can be added as a preset option later.

## Implementation

*(empty until promoted — AGENTS §10)*

## Execution

*(empty until promoted — AGENTS §10)*

## Review

*— claude-opus-5-5, 2026-11-21*

**Verdict: recommend with conditions — build A as A2, not A1.**

What holds (checked against the source above):
- The seam A2 needs already exists and is honoured. Every built-in tool
  reaches the OS only through `ExecutionEnvironment` (0 direct fs/spawn imports
  in `packages/tools/src`). ADR-005 reserved a container implementation behind
  it. `serve` already dials workloads from the Mac (`workload_shell`).
- A2 changes no session path, no broker wiring and no persistence writer. The
  pod gets less voice than in `run` today. Every §7 row in §2 holds by
  construction, except two that need explicit design: the sidecar version bump
  (no silent Mac fallback) and the kept/delete ownership. Both have precedents
  in the code.
- A2 subsumes B cheaply. C stays separate and should be deferred.

What does not hold, or is unverified:
- **The TODO's framing ("model through the existing reverse model tunnel") does
  not fit A2.** In A2 no tunnel is used. This is a deliberate deviation and
  needs the owner's OK (Q1).
- **Exec latency per file op** (each `fs_read` is a container exec) is unmeasured
  for docker/podman. The only figure in the repo is the k8s reverse-RPC p50
  47 ms / p95 ~110 ms (`docs/eval/remote-execution-model.md:48-60`), a floor
  for k8s exec. If S0 shows a typical turn more than ~2× slower than host on
  podman, S1 must use the multiplexed long-lived shell instead of
  exec-per-call.
- **Background-job semantics in a container across stream drops** (k8s
  especially) are unverified. They are S0's second question and gate Q7.
- Hooks and agent-defs/skills are read from the Mac `config.cwd`. They line up
  with the container only under the same-path mount (Q3/Q5).

Conditions to promote to `feat/container-sessions-mobile`:
1. The owner answers Q1 (A2) and Q2–Q8, or accepts the recommendations.
2. S0's two measurements are pasted into the feat doc before S1 starts.
3. S2's Review (fresh context) demonstrates, with a mutation test, that a bound
   session whose binding is lost or refused **never** runs a tool on the Mac.

How I behaved on this task: static evaluation only, no repro run (the absence is
structural). Line citations come from `grep`/`sed` on `main` at `c8554a4a`. They
were re-checked on `63dceb54`: since then only `packages/tui` changed, and the
cited lines in `serve.ts`, `session-host.ts`, `execution.ts`,
`daemon-state-file.ts`, `engine-runtime.ts`, `engine-k8s.ts`, `kept-cmd.ts` and
`apps/relay/src/server.ts` still say what this doc claims. The second pass added
the mount write-back row and the A1 contrast to §3. The A1 cost estimate is a
judgement from the surface it would have to forward (`HostedSession`, 4,198
lines), not a prototype.
