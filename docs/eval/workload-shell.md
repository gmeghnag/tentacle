# eval/workload-shell — a stateful, non-interactive shell on a workload (+ stdin for background jobs)

> **Status:** context · review (owner verdict pending)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size (if promoted):** M (v1 below), L with reconnect + `job_write` · **Blast:** cross-module (new tool + per-engine raw exec primitive; no protocol, persistence or §7 seam change in v1) · **Suited:** strong model executes (new remote-exec primitive + cleanup semantics); fresh-context Review recommended even though not strictly `load-bearing`
> **Changelog:** (if promoted) `changelog.d/workload-shell.added.md`

## Sintesi per il proprietario (italiano semplice)

**Verdetto proposto: GO, ma solo per un v1 piccolo** (`workload_shell` su k8s + docker/podman, sessioni locali e `serve`). **`job_write` (stdin ai job in background): NO-GO per ora.**

- **Il problema è reale ma piccolo.** Oggi l'agente fa `oc exec … -- cmd` dallo `shell` normale: funziona, è sicuro e limitato. Si perde solo lo stato tra una chiamata e l'altra (`cd`, `export`) e si paga un handshake per ogni comando.
- **`/move` non è l'alternativa giusta per un controllo di 5 secondi.** Azzera server MCP, job in background e approvazioni (`docs/feat/session-hop.md:333-342,397-398`). È pensato per il lavoro lungo *dentro* il container.
- **Cosa sarebbe `workload_shell`.** UN tool, non un secondo percorso di sessione. Apre una shell `sh` per workload, senza TTY, sul canale exec che il codice usa già (k8s `v4.channel.k8s.io`, docker exec hijack). Ogni comando torna con output limitato, exit code e `cwd`, delimitato da un marcatore casuale. `cd` ed `export` restano tra una chiamata e l'altra.
- **Sicurezza.** Ogni comando passa dal broker unico del laptop (`ask`, come `shell`). Le credenziali k8s/docker restano sul laptop. Quello che torna dal pod è solo dato, mai un permesso.
- **Pulizia.** Alla fine della sessione la shell viene chiusa e i suoi figli uccisi. Sul pod non si scrive nessun file. Il rischio vero è un processo figlio che ignora il segnale di chiusura: lo copre un `kill` one-shot di riserva.
- **Costo.** Circa 3 slice (primitiva exec "raw" per engine, tool + parser, cleanup/timeout + test). Nessun cambio di protocollo.
- **`job_write` costa più di quanto vale ora.** Va cambiata l'interfaccia `BackgroundHandle` (oggi lo stdin è chiuso per scelta) e serve un nuovo tipo di permesso. Senza un caso d'uso concreto, rimandare.
- **Da decidere (tu):** GO/NO-GO sul v1; se le approvazioni "always" del tool vanno legate al workload (consigliato) o vietate del tutto.

---

## Context

*— claude-opus-5-5, 2026-11-14*

### Origin

Owner, 2026-11-14. A tentacle session was asked why it ran `oc rsh`/`oc exec`
one-shots instead of "entering" the container. Its answer, condensed:

1. A one-shot gives bounded output, an exit code, and a replayable call.
2. An interactive shell (TTY, prompts, pagers, `vi`) does not fit a turn-based agent.
3. `move_session` resets MCP servers, background jobs and approvals, which is too
   expensive for a 5-second check.
4. (its point 5) It proposed **"a non-interactive but STATEFUL exec tool on a
   workload: a persistent session with `run(cmd)`/`read()`, cwd and env surviving
   between calls, without moving the whole session (and without losing MCP); plus
   stdin injectable into a background job."**

### The exact question

> Should tentacle add **(a)** a `workload_shell` tool, i.e. one long-lived
> non-interactive shell per workload, driven by tool calls, with cwd/env persistence,
> and/or **(b)** a `job_write` tool that writes to a background job's stdin? If yes,
> what is the minimal v1 that respects AGENTS §7?

### What exists today (verified against the source)

**Foreground `shell`** (`packages/tools/src/builtins.ts:259-318`)
- Runs `/bin/sh -c` once per call (`:265`). Default timeout is 120 s (`:260`), and a
  kill reports exit `124` (`:262`, `host-execution.ts:262`). Permission is `"ask"`
  (`:286`).
- Output is stdout and stderr joined (`:306-309`), not interleaved in arrival order.
- No state survives between calls, except an explicit `cwd` argument (`:266`).
- The model reaches a workload today through this same tool: `oc exec <pod> -- …`
  using the laptop's own kubeconfig.

**Background jobs** (`packages/exec/src/background.ts`)
- `BackgroundJobs.start` (`:162-191`) gives each job one interleaved buffer, capped at
  512 KiB from the head (`:36`, `:53-61`).
- `read` is incremental (`:193-199`). `dispose` kills every job (`:233-241`).
- The model-facing tools are `shell_output` and `shell_kill`
  (`packages/tools/src/background.ts:23-72`).
- **Stdin is closed by design.** `spawnBackground` forces `stdin: undefined`
  (`host-execution.ts:285-286`), so the child gets `"ignore"` (`:311`).
  `ExecOptions.stdin` is documented as "write then close; `spawnBackground` ignores
  it" (`core/src/execution.ts:20-21`).
- `BackgroundHandle` has no write side (`core/src/execution.ts:29-40`).
- When the session ends, `jobs.dispose()` runs (`daemon/src/hosted-session.ts:3057`;
  `session-host.ts:430,1168`). That is the "no leftovers" pattern to copy.

**k8s exec** (`packages/k8s`)
- A one-shot `runExecOverWebSocket` over `v4.channel.k8s.io` (`exec-run.ts:2-14,126`)
  supports a timeout (`:134,310`) and an abort (`:299-306`).
- v4 cannot half-close stdin, so EOF is a known byte count plus `head -c N`
  (`exec-run.ts:8-14`; AGENTS §7 "Bun TLS + k8s").
- `execChannel` is a *line-framed JSON* `DuplexChannel` built for the daemon RPC
  (`exec-channel.ts:2-21,102`). It sends a keepalive every 15 s and closes after 2
  missed ticks (`:71-72`).
- The URL builder already opens `stdin=true` (`exec-channel.ts:254-262`). Bearer auth
  travels as a WS subprotocol to the **apiserver** (`:279-287`), never to the pod.

**docker/podman exec** (`packages/docker`)
- `createExec` attaches stdin+stdout+stderr with `Tty: false`
  (`exec-channel.ts:112-128`).
- The channel is again line-framed JSON (`:4`). Docker *can* half-close: `end()` is
  stdin EOF (`exec-channel.ts:15-16,186`; `exec-run.ts:7-9,160`).

**Engine seam** (`packages/cli/src/engine-host.ts:162-168`)
- `EngineHost.openExec` returns a `DuplexChannel`, the JSON-line RPC shape.
  `runExec` is a one-shot with input bytes.
- **Neither is a raw, long-lived byte stream.** This is the one missing primitive.

**Where tools are wired**
- `buildAgent` (`cli/src/wiring.ts:416`) registers `builtinTools` and creates
  `BackgroundJobs` (`:435-439`).
- It is called by the worker (`worker.ts:50`), by `main` (`main.ts:2049,2220`), and by
  `serve`, *including the pod daemons* (`serve.ts:189,743,827`; the pod/stdio daemon
  is distinguished at `serve.ts:377,676,777`).
- So a new tool must be **registered conditionally**: laptop/user-host daemons only.

**Session-hop** (`docs/feat/session-hop.md`)
- `/move` moves the live conversation local ⇄ container (`:8-27`).
- A hop resets auto-accept and announces "background jobs, MCP tools and approvals
  were reset" (`:333-342`). MCP servers are per target, and session approvals do not
  survive (`:397-398`).
- `move_session` itself has no effect; it only raises a laptop prompt
  (`packages/tools/src/move-session.ts:1-16`).

### Constraints (AGENTS §7)

- One session path: a new capability is a tool or a transport, never a second agent loop.
- Logic goes in pure modules.
- Single broker.
- A pod is not trusted.
- The model and the identity stay on the laptop.
- Secrets go through env, never argv.
- Never write raw to the terminal while Ink owns it.

---

## Evaluation

*— claude-opus-5-5, 2026-11-14*

### 1 · Design of `workload_shell`

**Where it runs.** It is a daemon-side tool, registered **only where the daemon runs on
the user's own host**: the in-process worker and `tentacle serve` (not `--stdio`, not
`--resident`).

There it can read the user's kubeconfig and docker/podman endpoint exactly as
`engine-select.ts` does today. Inside a pod daemon (`run`/`attach`) it is **not
registered**, for two reasons:
- that daemon's plain `shell` already *is* in the workload;
- reaching *other* workloads from a pod would need cluster credentials inside the pod,
  which §7 forbids.

Under `connect`, the identity is the `serve` host's. Document this; nothing changes.

**Tool surface (v1).** One tool with an `action` field keeps the tool list short,
following the `agent_control` precedent (`tools/src/background.ts:74-82`):

| action | input | result |
|---|---|---|
| `run` | `target` (`engine`, `name`, optional `container`; same grammar as `move_session`, `move-session.ts:31-40`), `command`, optional `timeout` (default 60 s, max 600 s) | `exit=<n> · cwd=<path>` + output (capped) |
| `close` | `target` | closes that shell |

The shell opens lazily on the first `run` for a target. There is no separate
`open`/`read`. The proposed `read()` exists only for streaming output, and a command
that must stream belongs in a background job: see the scope in §3. `run` blocks until
the sentinel arrives or the timeout fires, as `shell` does.

**Raw exec primitive (the one new seam).** Add
`EngineHost.openRawExec(target, argv) → ByteDuplex { write(bytes), stdout, stderr, closed, close() }`.
- **k8s:** reuse `exec-frame.ts` (channel 0 out; channels 1/2/3 in), the URL builder
  and the subprotocol auth. Port the keepalive *idea* (`exec-channel.ts:71-72`), but
  send it as an inert shell line (`:\n`) rather than a JSON blank.
- **docker:** reuse `createExec` with `Tty: false`, the `hijack` and the stdcopy
  demux (`stdcopy.ts`).
- Both engines already hold every building block; only the framing layer is new
  (≈100 lines each).

**Bootstrap.**
- The tool runs `argv = ["sh"]`. With no TTY, sh reads commands from stdin. There is
  no prompt and no echo.
- Images without `sh` (distroless) fail with an actionable error, as `oc rsh` would.
- First line: `printf '__TNT_READY_%s_%s__\n' "$$" "$PWD"`. It records the shell's
  PID, needed for timeout and cleanup.

**Command framing.** All logic sits in a pure, unit-tested `workload-shell-frame.ts`.
For each call, the laptop draws a fresh 128-bit nonce `N` and writes:

```sh
command eval '<command with ' escaped as '\''>' </dev/null 2>&1; printf '\n__TNT_%s_%d_%s__\n' N "$?" "$PWD"
```

- `</dev/null` matters. Without it, a command that reads stdin (`cat`, `ssh`, a
  confirmation prompt) would swallow the *following* commands from our stream.
  Interactivity is explicitly out of scope: §2 explains why.
- `command eval` keeps a syntax error in the model's command from killing a
  non-interactive POSIX shell, because special-builtin errors are fatal unless the
  builtin is prefixed by `command`. Single-quote escaping is purely lexical, so no
  `base64` is needed in the image.
- **Unverified (cheap test before Implementation):** do dash, busybox ash and bash
  keep the shell alive after `command eval 'if'`? Recipe: run
  `printf "command eval 'if'\necho alive\n" | <shell>` in `alpine`, `debian:slim`
  and `ubi9` images.
- `2>&1` gives one interleaved stream in arrival order, as owner decision A gave for
  background jobs (`background.ts:11-19`). The shell's own stderr (channel 2) carries
  only diagnostics and is shown on error.
- The parser scans for `\n__TNT_<N>_<code>_<cwd>__\n`.
  - The nonce is never echoed (no TTY), so normal output cannot collide with it by
    accident.
  - A *hostile* pod can forge anything, the sentinel included. That is acceptable:
    whatever comes back is data (§4).

**Persistence.** The command runs in the shell itself, not in a subshell, so `cd`,
`export`, `set` and aliases persist between calls. That is the feature. One shell per
`(session, engine, name, container)`.

**Output cap.**
- An in-memory head+tail window, e.g. 64 KiB head plus 64 KiB tail, with the count of
  dropped bytes. Memory stays bounded however chatty the command is.
- The result then goes through the existing redact → large-output layer, like any
  other tool result (`wiring.ts:444-447`).

**Timeout and abort.** There is no TTY, so there is no Ctrl-C to send. On timeout or
turn abort:
1. A **one-shot** `runExec` runs `pkill -TERM -P <shellpid>`, then `-KILL` after
   grace. This kills the shell's children; the shell itself survives, so the state
   survives. If `pkill` is missing, the one-shot falls back to `kill` over
   `/proc/*/stat` (ppid scan).
2. If the sentinel still has not arrived after grace, a builtin is looping
   (`while :; do :; done`). The tool closes the stream, kills `<shellpid>`, and
   reports `[killed after Ns; shell restarted — cwd/env reset]`. It never pretends the
   state survived.

**Reconnect.**
- A dropped stream (keepalive miss, network) loses the shell process. With k8s, the
  kubelet closes stdin and sh exits on EOF.
- So reconnect = reopen lazily on the next `run` plus a one-line notice
  `[shell reconnected — cwd/env reset]`.
- v1 does **not** try to replay `cd`/`export`. Replaying model commands silently
  would re-run side effects.

**Cleanup ("no leftovers").** The same lifecycle as `BackgroundJobs`. A
`WorkloadShells` registry owned by the session is disposed next to `jobs.dispose()`
(`hosted-session.ts:3057`, `session-host.ts:430,1168`). Dispose does three things:
1. Best effort: write `exit\n`, close the stream, which gives sh EOF.
2. A one-shot `pkill -KILL -P <pid>; kill -KILL <pid>`, bounded at 5 s, against
   children that ignore EOF. Docker has no exec-kill API, and a no-TTY exec child
   that has `nohup`'d itself survives a closed stream.
3. **Nothing is written to the workload's filesystem**: no script, no fifo. This is
   why the bootstrap is a single stdin line.

Residual leftover: a daemon crash or SIGKILL skips dispose.
- **k8s:** the WS drop gives sh EOF, and sh exits. Children the model itself
  backgrounded inside the shell (`cmd &`) can survive. This is the same as with
  `oc exec` today, so it is no regression.
- **docker:** the same once the hijacked connection drops.
- State it in the tool description: "don't `&` inside `workload_shell`; for anything
  long-lived, use `/move` or a background `shell` job".

**Process boundaries.** Is a stateful shell more than `shell` + `oc exec`?
- Only moderately: it saves state and the handshake.
- Two thirds of the stated value (bounded output, exit code, replayable) is *already*
  what `oc exec` gives. Persistence is the real addition.
- Be honest about the cost: replayability gets **weaker**. A call's meaning now
  depends on earlier calls (`cd`). The `cwd=` line in every result partly compensates,
  because the transcript shows the context of each command.

### 2 · `job_write` (stdin for background jobs)

- **What it needs.**
  - `BackgroundHandle` would gain `write`/`end` (`core/src/execution.ts:29-40`).
  - `spawnBackground` would pass `stdin: "pipe"` instead of `"ignore"`
    (`host-execution.ts:286,311`).
  - The interface would change for every `ExecutionEnvironment` implementer.
  - A new tool, `job_write{job_id, text, eof?}`.
- **Permission.** Writing to a running process's stdin is arbitrary input to whatever
  that process is, so it would have to be `ask`. A REPL, `kubectl apply -f -` or a
  `psql` session executes it as code. The prompt would have to show the job's
  command plus the text, and auto-accept should not cover it.
- **Hazard.** Today a background job **cannot block on stdin**, because stdin is EOF
  immediately. That is a deliberate property: a forgotten prompt does not hang a job
  forever. A pipe-by-default reverses it, so it would have to be opt-in per job
  (`shell{run_in_background, stdin: "pipe"}`).
- **Value.** The cases are an interactive REPL, or answering a prompt (`y/N`). Both are
  the interactivity the origin session itself called hostile (point 2). The useful
  subset, "feed a known payload", is already `shell{command: "… <<'EOF' …"}`.
- **Verdict: NO-GO for now.** Revisit only with a concrete use case the heredoc form
  cannot cover. If it ever lands, it is independent of `workload_shell`, and the opt-in
  pipe makes it a contained, S-size change.

### 3 · Relation to session-hop, `shell` and background jobs

| need | tool |
|---|---|
| a 5-second check in a pod/container, no state | `shell` + `oc exec`/`docker exec` (today; keep) |
| a few related checks needing `cd`/`export` | **`workload_shell`** (new) |
| long work *inside* the workload (edit, build, test there; its MCP servers) | `/move` / `move_session` (session-hop) |
| a long-running process on the host | `shell{run_in_background}` + `shell_output`/`shell_kill` |
| a long-running process in a workload | v1: `/move`, then a background job; or a host background `oc exec … -- cmd` |

- `workload_shell` does **not** replace session-hop. It covers exactly the case the
  origin session named: too small to pay for a hop's reset of MCP servers, jobs and
  approvals (`session-hop.md:333-342,397-398`).
- The tool description must say so, so the model does not try to do long work through
  it.

### 4 · AGENTS §7 fit

- **One session path: holds.** `workload_shell` is a tool inside the existing agent
  loop. It neither creates a session, runtime or `DuplexChannel` transport, nor
  touches `RemoteClient`/`Connection`. The raw exec stream is a tool-private resource,
  like a background job's pipes. It is *not* a session transport, and it must never be
  promoted into one: if long work is wanted, that is `/move`.
- **Logic in pure modules: holds by design.** Framing, sentinel parsing, the cap window
  and the timeout state machine go in `workload-shell-frame.ts`, React-free and
  unit-tested. The tool only wires I/O.
- **Single broker: holds.**
  - Permission is `"ask"`, through the session's existing gate, so it reaches the one
    laptop `PermissionBroker`. No new broker and no laptop-side special path.
  - The prompt shows `target` and `command`.
  - **Approval scoping (owner decision):** an "always" approval for `workload_shell`
    must be keyed on `(engine, name, container, command)`, never on the command
    alone. An "always allow `rm -rf build`" in a dev container must not carry over to
    a prod pod. Where `shell`'s "always" rules are keyed was not located in this pass
    (`core/src/permission.ts:183` is the broker; the session rule store is elsewhere).
    Implementation must cite it, or v1 offers no "always" for this tool at all
    (simplest, recommended).
- **A pod is not trusted: holds.**
  - Everything the pod sends back (output, exit code, cwd, a forged sentinel) is
    **data in a tool result**. Nothing the pod sends is interpreted as a laptop action,
    permission or approval.
  - The parsed `cwd` is shown to the model, never used as a laptop path.
  - Control and bidi characters in the output go through the same sanitization tool
    output already gets.
  - Prompt injection via output exists exactly as it does with `oc exec` today:
    unchanged risk.
- **Identity stays with the user: holds.**
  - Cluster/engine credentials authenticate the laptop daemon to the apiserver/engine
    (`exec-channel.ts:279-287`). They never enter the workload.
  - Unlike host `exec`, the remote shell does **not** inherit the daemon's environment
    (`childEnv` is host-only), so no laptop env var, model key included, reaches the pod.
  - A `TENTACLE_*`/provider variable must never be put in the bootstrap. A test pins
    that the bootstrap line is constant apart from the nonce.
- **Secrets via env, never argv.** Not applicable to the bootstrap (argv is just
  `["sh"]`). A secret the *model* `export`s lives in the pod's shell memory, which is
  the same exposure as typing it into `oc exec`. The redact layer still scrubs results.
- **Never write raw to the terminal while Ink owns it: holds.** All output goes into
  tool results; dispose/cleanup diagnostics use the daemon log/notice path.
- **Don't serialize the RPC peer: holds.** The tool awaits its own stream. Two `run`
  calls on the *same* target are serialized per shell (one shell runs one command at
  a time) by the tool's `concurrency` declaration (`tools/src/concurrency.ts`, as
  `jobCursorConcurrency` does), not by any lock on `Connection`.
- **Protocol / persistence: untouched.** No new update kinds, no wire change, no
  `protocol.d/` note. Shells are not persisted. A resumed session starts with no
  shells, which is honest: the remote state is gone.

### 5 · Cost, slices, risks

**Slices** (if GO; v1 = WS1–WS3, M size in total):

| slice | content | size · blast |
|---|---|---|
| WS1 | `openRawExec` on k8s + docker (frame/stdcopy reuse, keepalive), tested with `FakeWS` and a fake hijack | M · cross-module |
| WS2 | pure `workload-shell-frame.ts` (escape, sentinel parse, cap window, timeout state machine) + the `WorkloadShells` registry + the tool, registered only in worker/`serve` builds; dispose wired next to `jobs.dispose()` | M · cross-module |
| WS3 | timeout/abort kill via one-shot `runExec`, restart notice, reconnect, the live k8s/docker tests under the existing opt-ins (`TENTACLE_K8S_SERVER`, `TENTACLE_DOCKER_TESTS=1`), changelog fragment | S–M · contained |
| (later) | `job_write`, only on a concrete need | S · contained |

**Risks** (ranked):

1. **Shell dialect variance.** `command eval`, `pkill` availability, busybox quirks.
   Mitigation: the empirical recipe in §1 before Implementation, plus a ppid-scan
   fallback.
2. **Leftover child processes** when a command backgrounds work, or on a daemon crash.
   Mitigation: dispose kill, the tool description, and parity with `oc exec`.
   Residual, documented.
3. **Model misuse as a "lightweight /move"**, running long work through repeated
   `run`s. Mitigation: a 600 s max timeout, the description, and no streaming `read`.
4. **Approval bleed across targets** if "always" is keyed on the command only.
   Mitigation: §4 (key on target, or no "always").
5. **Weaker replayability** (state-dependent calls). Mitigation: `cwd=` in every
   result; the reset notices are explicit.
6. **Conditional registration drift.** If a future `buildAgent` caller forgets the
   gate, a pod daemon would offer the tool. Without credentials it would only fail,
   but this needs a test that pins "pod daemon → tool absent".

### 6 · Recommendation

**GO for a minimal v1 of `workload_shell`; NO-GO for `job_write` now.**

Minimal v1:
- **Scope.** Local worker + `serve` only. k8s (kubeconfig context/namespace as
  `engine-select.ts` resolves it) and docker/podman.
- **Interface.** `workload_shell{action: run|close, target, command, timeout?}`, lazy
  open, one non-TTY `sh` per target, `command eval … </dev/null 2>&1` + nonce sentinel,
  result `exit · cwd · capped output`.
- **Permission.** `ask` per command, no "always" in v1.
- **Failure handling.** Timeout kills the children, then restarts the shell with an
  explicit notice. A drop means a lazy reopen with an explicit notice.
- **Cleanup.** Disposed with the session (EOF + one-shot kill). Nothing written to the
  workload.
- **Out of v1.** Streaming `read`, stdin to commands, a TTY, replay after reconnect,
  pod-daemon registration, `job_write`.

Gate before promoting to `feat/`:
- run the §1 dialect recipe;
- cite the session-approval keying, or confirm "no always".

---

## Implementation

*(empty — filled only if the eval is promoted to `docs/feat/workload-shell.md`)*

## Execution

*(empty)*

## Review — owner verdict

*Owner: GO / NO-GO / GO-with-changes, date, and any decision on approval scoping.*

-

## Review — owner verdict (2026-11-14 00:10)

**GO for the small v1** (`workload_shell` on k8s + docker/podman, ~3 slices, no protocol change). **`job_write`: NO-GO for now.** "Always" approvals of the tool are **scoped to the single workload** (recommended). Promoted to `docs/feat/workload-shell.md` (branch `feat/workload-shell`).
