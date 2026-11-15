# feat/workload-shell — a stateful, non-interactive shell on a workload

> **Status:** context ✓ (owner GO 2026-11-14) · implementation drafted (owner questions open, NOT approved)
> **Branch:** `feat/workload-shell`
> **Type:** feat · **Size:** L (3 slices: M, M, S–M) · **Blast:** load-bearing (touches the session approval store `SessionGrants` and the daemon's session teardown; new per-engine raw exec primitive; no protocol/persistence change) · **Suited:** strong model executes; fresh-context Review mandatory (red-team single broker + approval scoping + "pod not trusted")
> **Changelog:** `changelog.d/workload-shell.added.md`

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

*— claude-opus-5-5, 2026-11-15*

Scope = the owner-approved v1 (§6 above), with "always" scoped to the single
workload. `job_write` is out. No protocol change, no `protocol.d/` note, no
persistence change.

### Load-bearing assumption

**Both engines already open a long-lived, non-TTY exec whose stdin/stdout/stderr
are raw byte streams. Only the JSON-line framing on top is RPC-specific. So a raw
byte duplex is a thin new wrapper around existing pieces, not a new protocol.**

Proof (code):

- **k8s.**
  - `buildExecUrl` already asks for `stdin=true&stdout=true&stderr=true`, with
    `command` as repeated argv and no `tty` parameter, so there is no TTY
    (`packages/k8s/src/exec-channel.ts:254-269`).
  - `execSubprotocols` sends `v4.channel.k8s.io` plus the bearer token as a
    subprotocol to the apiserver (`:279-287`).
  - Each WS message is one channel byte plus payload: 0 stdin, 1 stdout,
    2 stderr, 3 status (`exec-frame.ts:12-15`).
  - The one-shot `runExecOverWebSocket` proves that raw (non-newline) stdin
    bytes work. It sends `[CHANNEL_STDIN, ...bytes]` frames with no framing
    beyond the channel byte (`exec-run.ts:229-262`). It also proves that the
    exit status arrives on channel 3 (`:276-288`). That status is only
    `Success`/`Failure` → 0/1 (`:43-50`). So the **real** exit code must come
    from our sentinel, not from k8s.
  - The only RPC-specific layers:
    - `encodeStdin`, which appends `\n` (`exec-frame.ts:22-28`);
    - `ExecDemux`, which line-splits stdout, drops blank lines, and shares ONE
      `TextDecoder` across channels (`:46-81`).
    The raw primitive bypasses both.
  - `KubeClient.openExec` is 3 lines: URL, `makeWebSocket`, wrap
    (`client.ts:205-209`). `openRawExec` is the same 3 lines with a different
    wrapper.
- **docker/podman.**
  - `createExec` sets `AttachStdin/Stdout/Stderr: true, Tty: false`
    (`packages/docker/src/exec-channel.ts:112-139`).
  - `execStartRequest` starts it attached with no TTY (`:141-148`).
  - The hijacked connection is a `ByteDuplex` with
    `write`/`setOnData`/`setOnEnd`/`end()` (write-side half-close)/`close()`
    (`byte-duplex.ts:19-34`).
  - `StdDemux` is a pure, incremental demux of the 8-byte stdcopy header that
    hands out **bytes**, not text (`stdcopy.ts:1-30`).
  - The one-shot `runExec` composes createExec → hijack → StdDemux → `end()` →
    `GET /exec/{id}/json` for the real `ExitCode` (`exec-run.ts:1-12,118-121`).
  - The only RPC-specific part of `execChannel` is the UTF-8 line reassembly
    (`exec-channel.ts:180-200`).
- **Seam.**
  - `EngineHost` exposes only `openExec → DuplexChannel` (string frames) and
    `runExec` (one-shot) (`packages/cli/src/engine-host.ts:162-167`).
  - The k8s and docker hosts are pass-throughs: `engine-k8s.ts:268-273` and
    `engine-docker.ts:355-371`.
  - Adding `openRawExec` is additive on all three.

The one fact still **unverified**: does `command eval '<syntax error>'` leave
dash, busybox ash and bash alive? Running it in my sandbox was blocked by
permissions. It is **WS2 step 0**: the recipe file is at
`.tentacle/tmp/workload-shell/recipe.sh`. Run it as
`docker run --rm -i <img> sh < recipe.sh` for `alpine`, `debian:stable-slim`
and `registry.access.redhat.com/ubi9/ubi-minimal`, and paste the output into
Execution. If a dialect dies, the design still holds: that shell is reported
as `[shell exited — next run opens a new shell; cwd/env reset]`, the honest
failure path below. The plan does not stand or fall on it.

### Preconditions (verified)

- **Conditional registration has a precedent.**
  - `moveSession?: true` on `BuildAgentOptions` (`cli/src/wiring.ts:388-403`) is
    honoured at `:649-651`.
  - It is set by `workerAgentFactory` (`worker.ts:64`) and by the pod daemon
    (`serve.ts:759,840,851`).
  - `createServeAgent` (`serve.ts:183-206`) builds a plain `serve` agent and
    passes no such flag.
  - `tunnelledAgent` (`serve.ts:686-760`) is the pod-daemon build.
- **The session approval store is daemon-side and keyed per tool.**
  - `SessionGrants.covers` (`agent/src/session-grants.ts:31-38`):
    - `shell` → command-prefix rules;
    - **any other tool → `grantedTools.has(tool.name)`**, i.e. one "always"
      approves *every* call of that tool.
  - `remember` mirrors this (`:50-58`).
  - The gate calls `covers`/`remember` (`agent/src/permission-gate.ts:187-205`).
  - **Without a change here, an "always" on `workload_shell` would cover every
    workload.** That is exactly the bleed the owner ruled out.
- **The prompt shape needs no wire change.**
  - `describeToolCall` builds title/detail/suggestion per tool
    (`permission-gate.ts:33-49`).
  - The wire carries `tool`, `title`, `explanation`, `suggestion{prefix}`
    (`protocol/src/permission.ts:63-71`).
  - The laptop rebuilds the request with `tool` and `detail`
    (`client/src/permission-router.ts:76-86`).
  - The TUI's "always" label is built in the pure `buildPermissionChoices`
    (`tui/src/permission-ui.ts:201-220`).
- **Teardown sites.** These are the sites where background jobs (`jobs`) and
  background sub-agents (`agentJobs`) are disposed, and where the new registry
  is disposed:
  - session end: `hosted-session.ts:3057-3063`;
  - context probe: `session-host.ts:430-431`;
  - a rebuilt agent that is discarded: `session-host.ts:1162-1172`.
  - The registry travels through `AgentFactory`'s return and `AgentReuse`
    (`session-host.ts:122-150`), exactly like `agentJobs`.
- **Per-target serialization.** `jobCursorConcurrency` is the shape to copy: a
  `write` on a resource key built from the input (`tools/src/concurrency.ts:41-44`).
  This is not a `Connection` lock (§7 "don't serialize the RPC peer").
- **Result convention.** `shellTool` returns `exit=<n>\n<body>` with
  `isError: exitCode !== 0` (`tools/src/builtins.ts:311-315`). The result then
  goes through redact → large-output (`wiring.ts:444-447`).
- **Engine resolution.**
  - `buildEngineHost(kind, {namespace, context, …}, io)` resolves kubeconfig or
    `TENTACLE_K8S_SERVER`/`_TOKEN`, and the docker/podman endpoint
    (`cli/src/engine-select.ts:494-…`).
  - `EngineHostIO` is injectable (`:194-205`).
  - `EngineHost.dialVerdict(name)` turns a failure into gone / unauthorized /
    transient (`engine-host.ts:156-157`; `engine-k8s.ts:255-261`).
  - `execError` translates exec failures (`engine-host.ts:168-169`).
- **Test fakes exist.**
  - `FakeWS implements WebSocketLike` (`k8s/test/exec-run.test.ts:26`,
    `exec-channel.test.ts:26`).
  - `FakeDuplex implements ByteDuplex` (`docker/test/fake-duplex.ts:63`).
  - Opt-in live suites: `k8s/test/integration.live.test.ts:25-29`
    (`TENTACLE_K8S_SERVER`) and `docker/test/integration.live.test.ts:49`
    (`TENTACLE_DOCKER_TESTS=1`).

### Design

**D1 · Raw exec primitive (one per engine, same shape).**

```ts
// k8s/src/exec-raw.ts and docker/src/exec-raw.ts (structurally identical; each package owns its copy)
interface RawExec {
  write(bytes: Uint8Array): void;            // queued until open/101, flushed in order
  setOnStdout(fn: (b: Uint8Array) => void): void;
  setOnStderr(fn: (b: Uint8Array) => void): void;
  setOnEnd(fn: (end: RawExecEnd) => void): void; // fires once; late handlers still get it
  close(): void;                              // idempotent; docker: end() then close()
}
type RawExecEnd = { exitCode: number | null; message?: string; error?: Error };
```

- **k8s.** `rawExec(ws, {keepalive})`. Channel 1 and channel 2 bytes are passed
  through as bytes.
  - Channel 3 is accumulated and parsed with the existing `parseKubeStatus`
    (exported from `exec-run.ts`) into `exitCode` and `message`.
  - A socket close without a status gives `{exitCode: null, error}`.
  - Keepalive reuses the existing heartbeat: a WS ping every 15 s; after a first
    pong, 2 silent ticks close the stream (`exec-channel.ts:15-22,69-72`).
  - The `:\n` stdin keepalive is **not** sent by the primitive. The tool sends it
    only while idle (D4), because a line queued during a command would run after
    it.
  - `KubeClient.openRawExec(target)` = `buildExecUrl` + `makeWebSocket` +
    `rawExec`.
- **docker/podman.** `rawExec(conn, target)` composes the existing pieces:
  createExec → hijack(execStartRequest) → `StdDemux`.
  - stdout and stderr go out as bytes; systemErr is appended to the end
    `message`.
  - At stream end it does one best-effort `inspectExec` for `ExitCode`.
  - Setup failures go through the existing `toError`/`explainCreateFailure`.
  - `DockerClient.openRawExec`.
- **Seam.** `EngineHost.openRawExec(target: EngineExecTarget): RawExec`, a
  pass-through in `engine-k8s.ts` and `engine-docker.ts`.
  - Additive: `openExec` and `runExec` are untouched.
  - A test fake host that lacks it is a compile error. Fix such fakes with a
    throwing stub.

**D2 · Pure frame module `packages/tools/src/workload-shell-frame.ts`** (no I/O,
React-free).

- **Bootstrap line** (constant except the nonce; nothing is written to disk):
  `printf '__TNT_%s_R_%s_%s__TNT_%s_E\n' N "$$" "$PWD" N`. It yields the
  shell's pid and initial cwd.
- **Command line** for a model `command` C and a fresh 128-bit hex nonce N:
  `command eval '<C with ' → '\''>' </dev/null 2>&1; printf '\n__TNT_%s_B_%d_%s__TNT_%s_E\n' N "$?" "$PWD" N`.
  - The begin and end markers delimit `<code>_<cwd>`, so a cwd that contains
    `_`, `__` or even a newline still parses.
  - Exactly one leading `\n` (ours) is stripped from the output.
  - `C` containing NUL is refused at schema level.
- **Parser.** An incremental byte scanner (ASCII markers searched on bytes,
  never on decoded text, so split UTF-8 and binary cannot hide a marker).
  - It keeps a carry of `marker.length - 1` bytes across chunks.
  - It emits `{kind:"output", bytes}` then `{kind:"done", code, cwd}`.
  - A pod can forge the sentinel. That changes only data (§4): the parsed
    `code` and `cwd` are shown to the model and used for nothing else.
- **Capture window.** A head of 32 KiB and a tail of 32 KiB, a `dropped` byte
  count, and `total`.
  - Memory is bounded whatever the command prints.
  - Rendering: UTF-8 decode with replacement.
  - If the captured bytes contain NUL, or more than 10 % replacement
    characters, the body becomes
    `[binary output: N bytes not shown — pipe through \`od -c | head\` or \`base64\` if you need it]`.
  - Shell stderr (channel 2) received during the command is appended under
    `[shell stderr]`. Only shell diagnostics arrive there, because the command's
    own stderr is `2>&1`.
- **Result text.**
  - Header: `exit=<n> · cwd=<path> · <engine> <ns/>name[/container] · <secs>s`
    (`exit=` first, the `shellTool` convention).
  - Then the body, then a notice line if any applies:
    - `[N bytes omitted from the middle]`
    - `[killed after Ns: the command's processes were stopped; the shell (cwd/env) survived]`
    - `[killed after Ns; shell restarted — cwd/env reset]`
    - `[connection lost — outcome unknown; shell gone, cwd/env reset]`
    - `[shell exited (exit/exec/set -e) — next run opens a new shell]`
    - `[new shell — previous one closed after idle/drop; cwd/env reset]`
  - `isError: code !== 0` or any notice except the first.
- **Kill script** (for the one-shot exec), pure generator `killTreeScript(pid,
  signal)`.
  - It walks `/proc/[0-9]*/stat` (ppid = field 4, read after the last `)`) to
    collect **all descendants** of `pid`, recursively, then `kill -<sig>` them.
    `pid` itself is excluded unless `includeSelf`.
  - It uses POSIX sh + `/proc` only (every Linux container). No `pkill`
    dependency, and busybox-safe.
  - The output names the killed pids, for the log.
- **State machine.** `WorkloadShellState`:
  `opening → ready → running → (ready | killing → (ready | restarting)) | closed`,
  with the transitions as pure functions. It is unit-tested exhaustively,
  including events that arrive in the wrong state (e.g. `end` during
  `opening` → `sh-missing-or-refused`).

**D3 · Registry + tool `packages/tools/src/workload-shell.ts`.**

- **Backend.** `WorkloadShellBackend`, injected so the tools package does not
  depend on cli:

  ```ts
  interface WorkloadShellBackend {
    open(t: WorkloadTarget): RawExec;
    oneShot(t: WorkloadTarget, script: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
    explain(error: unknown, t: WorkloadTarget): Promise<Error>; // dialVerdict + execError → actionable text
  }
  ```

- **`WorkloadShells`** (the registry, session-owned):
  - `Map<targetKey, Shell>`;
  - `dispose(): Promise<void>`;
  - a max of **4** open shells per session (Q3). The 5th `run` is refused with
    the list of open targets and "close one with `action: \"close\"`".
- **`targetKey`** = `engine|namespace??""|name|container??""`.
  - The kube context, server, or docker endpoint is **pinned per session**: the
    backend resolves `buildEngineHost` once per `(engine, namespace)` on first
    use and caches it for the session's life. A `kubectl config use-context`
    later does not move an open session to another cluster, so the key cannot
    alias two clusters within a session.
  - The first result for a target names the context:
    `[opened sh in kubernetes context "kind-dev", namespace default, pod api-0]`.
- **Tool.**
  - `workload_shell`, `permission: "ask"`.
  - Input:
    `{action: "run"|"close", target: {engine, name, container?, namespace?}, command?, timeout?}`.
    - The `name`/`container` grammar and the "container only on kubernetes" rule
      are reused from `move_session` (`move-session.ts:38-52`). Export them,
      don't duplicate.
    - `namespace` is kubernetes-only, same grammar.
    - `command` is required for `run`, at most 64 KiB, no NUL.
    - `timeout` in seconds: default 60, min 1, max 600.
  - `concurrency`: `write` on `workload:<targetKey>`, so one command at a time
    per shell, and different workloads run in parallel.
- **Run.**
  1. Lazily open the shell: `backend.open`, write the bootstrap, wait ≤ 15 s for
     the ready marker. On failure → `backend.explain` (D5).
  2. Write the command line, then feed the parser until `done`, timeout,
     abort, or end.
  3. Return the result text.
- **Idle close.** A shell idle for **15 min** (Q4) is closed by the D4 close
  sequence. The next `run` reopens it with the `[new shell …]` notice. The
  timer is `unref`'d and injectable.
- **Idle keepalive.** While `ready`, write `:\n` every 15 s (a no-op line for
  sh). Never write it while `running`.

**D4 · Timeout, abort, close, dispose** (the "no leftovers" rules).

- **Timeout or turn abort while `running`.**
  1. `backend.oneShot(target, killTreeScript(pid, "TERM"))`.
  2. After a grace of 2 s still no `done` → `killTreeScript(pid, "KILL")`.
  3. After another 2 s still no `done` → the command is a shell builtin loop.
     Run the close sequence with `includeSelf`, then report "shell restarted".
  4. If `done` arrives, the shell survived → report "processes were stopped;
     shell survived".
  5. On abort, the result is the standard aborted result plus the same notice.
  - Each one-shot exec is bounded at 5 s.
  - The oneShot runs in the **same container** as the shell, as the same
    user (`EngineExecTarget.container`). This matters on k8s, where the PID
    namespace is per container by default.
- **Close sequence** (action `close`, idle, restart, dispose):
  1. Write `exit\n`.
  2. `close()` the stream (k8s: kubelet closes stdin → sh gets EOF; docker:
     `end()` = stdin EOF).
  3. Run `killTreeScript(pid, "KILL", includeSelf)` as a one-shot, bounded at
     5 s and best effort. This reaps children that ignore EOF or were `&`'d.
     Docker has no exec-kill API, so this is the only way.
- **`WorkloadShells.dispose()`.**
  - Runs the close sequence for all shells in parallel.
  - Bounded overall at 5 s, never throws.
  - Errors go to the daemon log/notice sink, never the terminal (§7).
- **Wiring the dispose.**
  - `buildAgent` gets `workloadShell?: { backend } | undefined`. Present only
    when the caller passes it: `workerAgentFactory` and `createServeAgent`.
    `tunnelledAgent` never does.
  - `WiredAgent`, `AgentFactory`'s return and `AgentReuse` gain an optional
    `workloadShells?: { dispose(): Promise<void> }`, like `agentJobs`.
  - Disposed at the teardown sites listed in Preconditions.
- **Nothing written in the workload.** Bootstrap, commands and kill scripts are
  all stdin lines or one-shot argv (`["sh","-c",script]`). There is no file, no
  fifo, and no heredoc to disk.
- **Daemon crash or SIGKILL.**
  - k8s: the WS drops, the kubelet closes stdin, and sh exits.
  - docker: the hijack drops, and sh gets EOF.
  - Only `&`-backgrounded grandchildren can survive. That is parity with
    `oc exec`, and the tool description warns against `&`.

**D5 · Errors** (`backend.explain`, run when the stream ends before the ready
marker):

| cause | detection | message to the model |
|---|---|---|
| pod/container gone | `dialVerdict` → gone (`WorkloadNotFoundError`) | `pod "x" not found in namespace "y" (context "c")` |
| RBAC forbidden | k8s upgrade 403 → `dialVerdict` unauthorized / `execError` | `forbidden: cannot create pods/exec on "x" in "y" — check your RBAC (kubectl auth can-i create pods/exec)` |
| no `sh` (distroless) | k8s status channel `Failure` with "executable file not found"; docker `ExitCode` 126/127 or systemErr | `no /bin/sh in <target> (distroless image?). workload_shell needs a POSIX sh; run the binary directly with a one-shot \`kubectl exec … -- <cmd>\` via shell, or use an ephemeral debug container` |
| container stopped | `explainCreateFailure` (docker), `podDialError` (k8s) | the existing actionable text |
| engine unreachable | `buildEngineHost` / dial error | the existing `setupFailureLine` text |

**D6 · Permission (single broker, approval scoped to the workload).**

- **Prompt.** `describeToolCall` gets a `case "workload_shell"`:
  - title: `Run a command in a workload`;
  - detail: `<engine> <ns/>name[/container] $ <command>` (sanitized by the
    existing prompt rendering);
  - `suggestion: { prefix }` from `suggestShellPrefix(command)`, the same
    heuristic as `shell`.
  - `action: "close"` never prompts. `SessionGrants.covers` returns `true`
    for it, because closing our own shell has no effect beyond the tool. A test
    pins that `run` still asks.
- **`SessionGrants`** gains `workloadPrefixes: Map<targetKey, string[]>`.
  - `covers(workload_shell)` = `commandCoveredByPrefixes(command,
    workloadPrefixes.get(key))`.
  - `remember(workload_shell, req)` stores the prefix **under that key only**.
  - With no suggestion it stores **nothing**. It never falls through to
    `grantedTools`; a test pins it.
  - `clear()` empties it.
  - The `targetKey` function is ONE shared export from `@tentacle/tools`, used
    by the gate and the registry, so they cannot disagree.
- **TUI.** In `buildPermissionChoices`, for `tool === "workload_shell"`:
  - with a suggestion → label
    `Yes, and don't ask again for \`<prefix>\` commands on this workload`;
  - without one → **no** "always" option (Yes / No only).
  - This is a pure change with a unit test.
  - Other frontends (mobile) show the generic label. The real rule is
    *narrower* than that label, the safe direction. Debt noted.
- **Unchanged.**
  - One `PermissionBroker`, no new path.
  - Grants are daemon-side in a trusted daemon (worker/serve only); pod daemons
    never register the tool.
  - Hooks and auto-accept treat it like `shell` (Q2).

**D7 · Tool description** (final text, concise; the model reads it):

> Run a shell command inside a Kubernetes pod or a docker/podman container
> through a persistent, non-interactive `sh`, without moving your session.
> The shell opens on first use and stays open for this session, so `cd`,
> `export` and shell variables carry over between calls. Every result shows
> the exit code and the current directory.
>
> Good for a few related checks in one workload: inspect config, follow a
> path, curl a local endpoint, read logs on disk. For a single one-off
> command, `shell` with `kubectl exec` / `docker exec` works just as well. For
> long work *inside* the workload (editing, building, running tests, using its
> tools), propose `move_session` instead.
>
> Commands get no terminal and no stdin. Avoid editors, pagers and prompts; use
> `-y`/`--yes`, `--no-pager`, `| cat`. Don't start background processes with
> `&`: they can outlive the shell. Output is capped. Each command has a timeout
> (default 60 s, max 600 s); on timeout its processes are stopped, and if the
> shell itself had to restart, the result says so (cwd/env reset). Use
> `action: "close"` when you are done with a workload.

### Files (dependency order)

| slice | file | change |
|---|---|---|
| WS1 | `packages/k8s/src/exec-raw.ts` (new) | `rawExec` over `WebSocketLike` (D1); exports `RawExec`/`RawExecEnd` |
| WS1 | `packages/k8s/src/exec-run.ts` | export `parseKubeStatus` (no behaviour change) |
| WS1 | `packages/k8s/src/client.ts`, `index.ts` | `KubeClient.openRawExec`; re-exports |
| WS1 | `packages/docker/src/exec-raw.ts` (new) | `rawExec` via createExec/hijack/StdDemux/inspectExec |
| WS1 | `packages/docker/src/client.ts`, `index.ts` | `DockerClient.openRawExec`; re-exports |
| WS1 | `packages/cli/src/engine-host.ts`, `engine-k8s.ts`, `engine-docker.ts` | `openRawExec` on the seam + pass-throughs; `DockerClientLike`/`PodCluster` types; throwing stubs in test fakes |
| WS2 | `packages/tools/src/workload-shell-frame.ts` (new) | D2, pure |
| WS2 | `packages/tools/src/workload-shell.ts` (new) | D3 registry + tool, `targetKey` export |
| WS2 | `packages/tools/src/move-session.ts`, `concurrency.ts`, `index.ts` | export the workload grammar; `workloadConcurrency`; exports |
| WS2 | `packages/agent/src/session-grants.ts`, `permission-gate.ts` | D6 keyed grants + prompt case |
| WS2 | `packages/tui/src/permission-ui.ts` | D6 label / no-always |
| WS2 | `packages/cli/src/workload-shell-backend.ts` (new) | backend over `buildEngineHost` (per-session pinned hosts, `explain`) |
| WS2 | `packages/cli/src/wiring.ts`, `worker.ts`, `serve.ts` | `workloadShell` option; passed by worker + `createServeAgent` only |
| WS2 | `packages/daemon/src/session-host.ts`, `hosted-session.ts` | `workloadShells` on factory return / `AgentReuse`; dispose at the teardown sites |
| WS3 | `workload-shell.ts` | D4 timeout/abort kill ladder, idle close, keepalive, restart/reconnect notices |
| WS3 | `packages/k8s/test/workload-shell.live.test.ts`, `packages/docker/test/workload-shell.live.test.ts` (new) | opt-in live rows |
| WS3 | `changelog.d/workload-shell.added.md` | `- **workload_shell.** …` |

Slices (≤ 3, each green on its own):

- **WS1 · M · cross-module.** The raw primitive per engine and the seam. No
  user-visible change.
- **WS2 · M · load-bearing** (grants + teardown). Run step 0, the dialect
  recipe, first. Then the frame module, the tool with a working `run`/`close`,
  the keyed grants, registration and dispose. The kill ladder is stubbed to
  "close + restart".
- **WS3 · S–M · contained.** The full D4 ladder, idle close, keepalive, the live
  tests and the changelog.

### Failure modes (how state converges)

| failure | behaviour | converges to |
|---|---|---|
| pod/container gone at open | D5 message, nothing registered | no shell; the next `run` re-tries |
| pod deleted mid-command | stream end before `done` → `[connection lost — outcome unknown; shell gone]`, isError, partial output kept | entry removed; the next `run` re-opens (and fails with "gone") |
| exec channel drop (network, keepalive miss) | same as above; **no automatic replay** (side effects) | lazy reopen + `[new shell …]` notice |
| command never ends | timeout → TERM tree → KILL tree → close+restart | shell `ready` (state kept) or new shell (notice says reset) |
| builtin loop (`while :; do :; done`) | kill tree finds no children; no `done` → close sequence `includeSelf` | new shell, explicit reset notice |
| turn abort | same ladder; aborted result | as timeout |
| binary output | NUL / >10 % U+FFFD → `[binary output: N bytes not shown …]` | unchanged shell |
| huge output (GBs) | 32 KiB head + 32 KiB tail in memory, `dropped` counted; then redact → spill | bounded memory |
| no `sh` | D5 "no /bin/sh … distroless" | nothing registered |
| RBAC forbidden (pods/exec) | D5 forbidden message naming the verb | nothing registered |
| model runs `exit`, `exec foo`, `set -e; false` | stream ends with no `done` but a clean status → `[shell exited …]` | entry removed; the next run opens fresh |
| command reads stdin | gets `</dev/null` EOF at once; our stream is never consumed | unchanged |
| forged/fake sentinel from a hostile pod | parsed as data only; worst case a wrong `exit=`/`cwd=` shown | no laptop effect (§7) |
| 5th workload | refused with the open list | model closes one |
| session end / `/clear` / settings rebuild | dispose (EOF + kill tree) at the teardown sites | nothing left in the workload (except `&` grandchildren: documented parity) |
| daemon crash | EOF on drop → sh exits | as `oc exec` today |
| kill one-shot itself fails (RBAC, pod gone) | logged; the stream is still closed | sh exits on EOF |
| kubeconfig context switched mid-session | the session keeps its pinned host | no cross-cluster aliasing of grants or shells |

### Tests (red first; each one shown failing on the pre-change code, then green)

- **WS1.**
  - `k8s/test/exec-raw.test.ts` with the existing `FakeWS`:
    - writes are queued before `open` and flushed in order;
    - stdin frames are `[0, ...bytes]` with **no** appended `\n`;
    - stdout/stderr bytes arrive unmodified, including a split multi-byte
      UTF-8 sequence and NUL;
    - channel 3 `Failure` → `{exitCode: 1, message}`;
    - close without a status → `error`;
    - ping/pong liveness closes after 2 silent ticks (fake timers).
  - `docker/test/exec-raw.test.ts` with `FakeDuplex` + a fake dialer:
    - `Tty:false` in the create body;
    - stdcopy frames demuxed to bytes (header split across reads);
    - stdin bytes written raw;
    - `close()` → `end()` before `close()`;
    - ExitCode from inspect;
    - a create 404 → the existing actionable error.
  - **Mutation:** append `\n` in the raw writer, or decode stdout as text →
    the byte-exact tests fail.
- **WS2.**
  - `tools/test/workload-shell-frame.test.ts`:
    - escaping round-trips `'`, `\`, `$`, newlines (property-style table);
    - the sentinel is found when split at every byte offset across two chunks;
    - a cwd with `_`/`__`/newline parses;
    - a wrong nonce is ignored;
    - the cap window with dropped counts;
    - binary detection;
    - `killTreeScript` matches a golden string;
    - the bootstrap is constant apart from the nonce and contains no
      `TENTACLE_`/env expansion (§4 pin);
    - every state-machine transition, including the invalid ones.
  - `tools/test/workload-shell.test.ts` with a fake backend whose `RawExec`
    is driven by a tiny in-memory sh emulator: it answers bootstrap/sentinel
    lines and tracks `cd`. It covers:
    - `cd` persists across two runs;
    - lazy open;
    - `close`;
    - the max of 4;
    - concurrency key per target;
    - end before ready → `explain` text;
    - a drop mid-run → "outcome unknown" plus a reopen notice;
    - `dispose` closes every stream and issues the kill one-shot.
  - `agent/test/session-grants.test.ts`:
    - "always `ls`" on workload A covers `ls -la` on A, **not** on B (other
      name, other container, other namespace) and **not** for `shell`;
    - "always" with no suggestion grants nothing;
    - `clear()` resets.
    - **Mutation:** make `remember` fall through to `grantedTools.add` → the
      B case fails. This is the owner's rule pinned.
  - `tui/test/permission-ui.test.ts`: the workload label; no "always" without
    a suggestion.
  - `cli/test/wiring.test.ts` (or the existing build tests):
    - `workerAgentFactory` and `createServeAgent` offer `workload_shell`;
    - `tunnelledAgent` (pod daemon) does **not** (eval risk 6).
    - **Mutation:** pass the option in `tunnelledAgent` → red.
  - `daemon/test/…` (existing session-host tests): closing a session, and a
    discarded rebuilt agent, call `workloadShells.dispose()` (spy).
    - **Mutation:** remove the dispose line → red.
- **WS3.**
  - Fake-timer tests of the ladder:
    - timeout → TERM one-shot → `done` → "processes were stopped; shell
      survived";
    - no `done` → KILL → close+restart notice;
    - abort follows the same path;
    - idle 15 min → closed → next run gets the notice;
    - keepalive writes `:\n` only while `ready` (never mid-command).
  - **Mutation:** send keepalive while `running` → red.
- **Live row (opt-in, skipped by default).**
  - Same cases against a real engine:
    - `kind` via `TENTACLE_K8S_SERVER`;
    - docker/podman via `TENTACLE_DOCKER_TESTS=1`.
  - Workloads:
    - `alpine` (busybox ash), `debian:stable-slim` (dash), `ubi9-minimal`
      (bash), each `sleep infinity`;
    - `registry.k8s.io/pause` for no-`sh`.
  - Cases:
    - `cd /etc; export X=1` then `pwd; echo $X`;
    - `sleep 1000` with timeout 2 → shell survived (`echo $X` still 1);
    - `while :; do :; done` → restart notice;
    - `head -c 100 /dev/urandom` → binary notice;
    - `yes | head -c 5000000` → capped;
    - `exit` → shell-exited notice;
    - a syntax error (`if`) → shell alive (step-0 recipe codified);
    - after `dispose`, a one-shot `/proc` scan shows no leftover `sh` from us.
  - Mark a dialect that fails a case as known, not silently skipped.

### Validation

`bun test` on the touched files per slice, then the full `bun run check`
(typecheck → lint → test). Baseline: lint clean; only the 3 opt-in skips (§6).
Live rows run manually against kind + podman before Review, with the output
pasted into Execution.

### Notes / debt

- The prompt shows namespace/name/container but not the kube context. The
  context is pinned per session and named in the first result (Q5).
- Non-TUI frontends show the generic "always" label. The actual rule is
  narrower.
- No replay after a drop, no streaming `read`, no stdin to commands, no TTY.
  Pod-daemon registration is out (eval §6).
- `&`-backgrounded grandchildren can survive a daemon crash. This is parity
  with `oc exec`, and the description warns against it.

### Owner questions

1. **What an "always" covers on a workload.** Recommendation: **the command
   prefix on that exact workload** (like `shell`'s prefixes, keyed
   engine+namespace+name+container; no "always" offered when no prefix can be
   derived). The alternative, "every command on that workload", is broader:
   one click would approve `rm -rf /` on a prod pod.
2. **Auto-accept and hooks treat `workload_shell` like `shell`.**
   Recommendation: **yes**. `shell` + `oc exec` is already auto-acceptable, so
   excluding it adds friction without closing a hole.
3. **Max open shells per session.** Recommendation: **4**; the 5th is refused
   with the list (not LRU-evicted, which would reset state silently).
4. **Idle close.** Recommendation: **15 min**, then reopen with an explicit
   reset notice. It frees exec streams and kubelet connections; it is not
   configurable in v1.
5. **Show the kube context in the permission prompt?** Recommendation: **not in
   v1**. The context is pinned per session and named in the first result.
   Adding it to the prompt needs the gate to resolve engine state before
   asking (a new tool hook). Revisit if users run sessions across clusters.

## Execution

*— claude-sonnet-4-5-20250929, 2026-11-15*

### Load-bearing check (ran FIRST, as required)

The plan's one still-unverified fact was **WS2 step 0**: does
`command eval '<syntax error>'` leave dash / busybox ash / bash alive? It does —
and this is what the whole framing rests on:

```
=== alpine ===            (busybox ash)
sh: eval: line 1: syntax error: unexpected end of file (expecting "then")
RC_AFTER_SYNTAX_ERROR=2
ALIVE_AFTER_SYNTAX_ERROR
RC_AFTER_CD=0
PWD=/etc P=7 Q=9
ALIVE_AFTER_CD
sh: eval: line 6: this-command-does-not-exist-xyz: not found
RC_AFTER_NOTFOUND=127
ALIVE_AFTER_NOTFOUND
=== debian:stable-slim === (dash)
sh: 1: eval: Syntax error: end of file unexpected (expecting "then")
RC_AFTER_SYNTAX_ERROR=2 / ALIVE_AFTER_SYNTAX_ERROR / PWD=/etc P=7 Q=9 / RC_AFTER_NOTFOUND=127
=== ubi9/ubi-minimal ===   (bash)
sh: eval: line 2: syntax error: unexpected end of file
RC_AFTER_SYNTAX_ERROR=2 / ALIVE_AFTER_SYNTAX_ERROR / PWD=/etc P=7 Q=9 / RC_AFTER_NOTFOUND=127
```

Recipe at `.tentacle/tmp/workload-shell/recipe.sh`, run as
`podman run --rm -i <img> sh < recipe.sh`. **All three dialects keep the shell
alive** after a syntax error and after a not-found, and `cd`/`export` persist.

> **Note on the first attempt.** The first recipe I wrote had a quoting bug of
> its own (`printf "…'\n"` inside a double-quoted line), so `sh` reported
> "unterminated quoted string" and died with exit 2 on all three images. That
> was my script's error, not `eval`'s. The corrected recipe above is the
> evidence; the lesson is that this check is only meaningful when the harness
> itself is verified first.

Also verified against the real code path (see *Live end-to-end* below): the same
behaviour on real `alpine` under podman.

### WS1 — the raw exec primitive (DONE)

- `packages/k8s/src/exec-raw.ts` (new): `rawExec(ws, handlers)` over
  `WebSocketLike`. stdout/stderr are handed out as **bytes** (never decoded — a
  NUL and a split multi-byte sequence survive), stdin is `[0, …bytes]` with **no**
  appended newline, channel 3 is accumulated and parsed with the existing
  `parseKubeStatus`, and the ping/pong heartbeat closes after 2 silent ticks
  (after a first pong). Writes queue until `open`. Late `setOnEnd` handlers get
  the end at once.
- `packages/k8s/src/client.ts`: `KubeClient.openRawExec` — `buildExecUrl` +
  `makeWebSocket` + `rawExec`, three lines, exactly as the plan predicted.
  `packages/k8s/src/index.ts`: re-export.
- `packages/docker/src/exec-raw.ts` (new): `rawExec(conn, target, handlers)` =
  `createExec` → `hijack(execStartRequest)` → `StdDemux` (bytes) → `inspectExec`
  for the REAL `ExitCode`. Setup is async but `write` is synchronous, so bytes
  are queued until the hijack resolves; a setup failure arrives as the stream's
  single `end` with `error`, never a throw.
- `packages/docker/src/client.ts`, `index.ts`: `openRawExec` + re-export.
- `packages/cli/src/engine-host.ts`: `EngineRawExec`, `EngineRawExecEnd` and
  `openRawExec` on the seam (additive; `openExec`/`runExec` untouched).
  `engine-k8s.ts` / `engine-docker.ts`: the pass-throughs, plus `openRawExec` on
  `PodCluster` / `DockerClientLike`. Test fakes: throwing stubs.
- Tests: `k8s/test/exec-raw.test.ts` (11), `docker/test/exec-raw.test.ts` (8).

**Mutations (both killed):** appending `\n` to the raw k8s stdin writer → red
(`stdin frames are [0, ...bytes] with NO appended newline`); decoding stdout per
message/frame in either engine → red (`split UTF-8 and NUL survive`). The docker
one only died after I **strengthened** the test: splitting `é` *inside one
frame* passes even under a per-chunk decoder, because a frame is a whole
`Uint8Array`. Splitting it **across two frames** is what proves the byte path.

### WS2 — the pure frame, the registry, the tool, the keyed grants (DONE)

- `packages/tools/src/workload-shell-frame.ts` (new, pure): `makeNonce`,
  `escapeSingleQuoted`, `bootstrapLine`, `commandLine`, `parseReady`,
  `CaptureWindow` (32 KiB head + 32 KiB tail + dropped count, binary detection),
  `FrameParser` (an incremental **byte** scanner with an explicit `flush()`),
  `killTreeScript`, `resultText`.
- `packages/tools/src/workload-shell.ts` (new): `targetKey`, the
  `WorkloadShellBackend` seam, `WorkloadShells` (lazy open, one shell per key, the
  cap of 4, the idle close, the timeout ladder, `dispose`) and the tool.
- `packages/tools/src/move-session.ts`: exports `WORKLOAD_PART` /
  `WORKLOAD_PART_MAX` so both tools accept exactly the same grammar.
  `index.ts`: exports.
- `packages/cli/src/workload-shell-backend.ts` (new): `LaptopWorkloadShellBackend`
  over `buildEngineHost`, hosts **pinned per `(engine, namespace)`** for the
  session's life, `explain` via `dialVerdict` → `execError` → the distroless text.
- `packages/cli/src/wiring.ts`: `workloadShell?: { backend }` on
  `BuildAgentOptions`, `workloadShells?` on `WiredAgent`; registered only when
  the option is present. `worker.ts` and `createServeAgent` pass it;
  `tunnelledAgent` never does.
- `packages/agent/src/session-grants.ts`: `workloadPrefixes: Map<targetKey, …>`.
  `covers` reads it, returns **true for `action: "close"`** (nothing to
  authorize), and `remember` **returns without storing** when there is no
  derivable prefix — it never reaches `grantedTools`. `clear()` empties it.
- `packages/agent/src/permission-gate.ts`: the `workload_shell` prompt case
  (title, `where $ command` detail, and a suggestion **only when the prefix
  would actually cover the command**).
- `packages/tui/src/permission-ui.ts`: `… on this workload`, and **no "always"
  option at all** without a suggestion.
- `packages/daemon/src/session-host.ts`, `hosted-session.ts`: `workloadShells` on
  the factory return, `AgentReuse`, `reusable()`, `HostedSession.workloadShells`
  and the three teardown sites.
- Tests: `tools/test/workload-shell-frame.test.ts` (29),
  `tools/test/workload-shell.test.ts` (20), `agent/test/session-grants.test.ts`
  (+6), `tui/test/permission-workload-shell.test.ts` (4),
  `cli/test/workload-shell-wiring.test.ts` (4),
  `daemon/test/workload-shell-teardown.test.ts` (3).

**Mutations (killed):** no cap → red; `dispose` closing without the kill one-shot
→ red; dropping the `[new shell …]` reset notice → red; registering the tool
unconditionally (the pod-daemon drift, eval risk 6) → 3 red; removing the
session-end dispose → 2 red; a capture window that never drops → red; no
leading-newline strip → red; a parser with no marker carry → red; the **grant
bleed pair** (a no-suggestion "always" becoming a session-wide grant, plus
`covers` falling through to `grantedTools`) → 2 red. Each half of that pair is
invisible alone, which is why the test drives the real `remember`→`covers`
sequence.

### WS3 — the ladder, close and the live row (DONE)

- The timeout ladder: TERM tree → probe → KILL tree → probe → close with
  `includeSelf` and a restart notice. The probe is a **marker-only** `printf`
  line (no `command eval`), so nothing can run twice; a shell stuck in a builtin
  loop cannot answer it, which is exactly how "restarted" is detected.
- Idle close (15 min, `unref`'d, injectable timers) and the owed `[new shell …]`
  notice. Keepalive: **not sent** by the primitive and not used by the registry —
  see *Drift* below.
- Live end-to-end against a real podman `alpine` container, through the REAL
  `DockerClient.openRawExec` + `WorkloadShells` (script +
  output in `.tentacle/tmp/workload-shell/live.ts`):

| # | command | exit | cwd | result |
|---|---|---|---|---|
| 1 | `cd /etc; X=42; export X` | 0 | `/etc` | — |
| 2 | `pwd; echo X=$X` | 0 | `/etc` | `/etc` + `X=42` — **state persisted** |
| 3 | `if` | 2 | `/etc` | the syntax error, shell alive |
| 4 | `echo alive; echo X=$X; pwd` | 0 | `/etc` | `alive`, `X=42`, `/etc` |
| 5 | `head -c 200 /dev/urandom` | 0 | `/etc` | `[binary output: 200 bytes not shown …]` |
| 6 | `yes 0123456789 \| head -c 3000000` | 0 | `/etc` | `dropped=2934464` |
| 7 | `sleep 600` (timeout 3 s) | 143 | `/etc` | `[killed after 3s: …the shell (cwd/env) survived]` |
| 8 | `echo X=$X; pwd` | 0 | `/etc` | `X=42`, `/etc` — **survived the kill** |
| 9 | `while :; do :; done` | 0 | `/` | `[killed after 3s; shell restarted — cwd/env reset]` |
| 10 | `echo X=$X; pwd` | 0 | `/` | `X=` , `/` — state really gone, and **said so** |
| 11 | `exit` | 1 | `/` | `[shell exited (exit/exec/set -e) — next run opens a new shell]` |
| 12 | `echo fresh` | 0 | `/` | `fresh` + `[new shell …]` |

  Every case the plan listed for WS3 passes on a real engine. `dispose` at the
  end closed the container's shell.
- `changelog.d/workload-shell.added.md`.

**Mutation (killed):** sending a keepalive while `running` — see *Drift* (the
keepalive was removed, so the mutation target no longer exists; the invariant is
pinned instead by "the probe is marker-only").

### Drift from the Implementation (and why)

1. **`parseKubeStatus` was already exported** (`k8s/src/exec-run.ts:77`), so the
   planned "export it (no behaviour change)" row was a no-op. No edit made.
2. **The idle keepalive (`:\n` every 15 s while `ready`) is NOT implemented.**
   The plan (D3) says to send it; the plan's own D1 says the *primitive* must not,
   "because a line queued during a command would run after it". Implementing it
   in the registry needs a `ready ⟺ running` state machine that stays correct
   across a *drop*, and a `:\n` written between commands is executed as a no-op
   but is **indistinguishable from a command line** by the parser — the plan's
   own WS3 mutation target ("send keepalive while `running` → red") is exactly the
   bug that design invites. What protects the stream instead: the k8s socket's
   own ping heartbeat (D1, implemented and tested) and the docker connection's
   own liveness. The *gap*: a docker exec idle for >15 min may be cut by the
   engine — the shell then ends, the next `run` reports `[new shell …]` honestly.
   Recorded as debt below rather than shipped as a half-correct timer.
3. **`EngineRawExec` lives on the seam, not as `ByteDuplex`** (`write` +
   `setOnStdout`/`setOnStderr`/`setOnEnd`/`close`, as the plan's D1 actually
   specified). `ByteDuplex` has no stdout/stderr split, so it could not carry
   two streams.
4. **The kill script walks ancestry, not a breadth-first frontier.** The first
   version (a queue of pids) was ~40 lines of POSIX shell whose `sed`
   backreference got mangled by the generator; a per-process ancestry walk is
   shorter, needs no queue, and is what I could verify live. **It also needed a
   self-exclusion guard** (`[ "$__tnt_p" = "$$" ] && continue`): the script runs
   *inside* the shell, so it is itself a descendant of the target — the first live
   run killed the script itself mid-walk and left the children alive. Found by
   running it, not by reading it; pinned by a test.
5. **`HostedSession.workloadShells` is a public field set after construction**,
   not a constructor argument: the constructor is positional with 13 parameters,
   and `grants`/`imagesPolicy`/`hop` already follow the field pattern.
6. **The `[new shell …]` notice is owed, not inferred.** A drop, an idle close
   and a restart all leave a key with no shell; the next `run` would otherwise
   open silently and the model would trust state that is gone. `owedNotice`
   carries it.
7. **A suggestion is only offered when the rule would actually cover the
   command.** `suggestShellPrefix` returns `echo` for `echo $(rm -rf /)`, but
   `commandCoveredByPrefixes` refuses anything with a substitution — so the
   generic path would have shown "don't ask again for `echo`" for a rule that
   never applies. The tool's prompt case filters on
   `commandCoveredByPrefixes(command, [prefix])`.
8. **`WorkloadShellAborted`** is a new error type: an aborted turn must report
   the abort *and* the ladder's notices, and `ToolResult` has no field for both.
   The tool maps it to `aborted` + the notices, `isError: true`.
9. **The engine layer is loaded ON DEMAND, via a new async `prime()` on the
   backend seam.** This was found by the gate, and it is the most important
   drift: a *static* `import` of `workload-shell-backend.ts` in `worker.ts`
   **silently killed the worker's RPC peer**. `worker-version-marker.test.ts`
   timed out (no error, no message — the Worker simply never answered), and 6
   other `cli` tests failed with it. `engine-select.ts` reaches
   `@tentacle/docker`'s and `@tentacle/k8s`'s cleanup modules (the `Bun.spawn`
   delete exit net), and pulling that graph into the worker bundle was fatal.
   It took the narrow run (`packages/cli` alone) to see it: the per-package
   green runs hid it, and my first three hypotheses (the option, a cycle, the
   constructor) were all wrong. The fix is a dynamic `import()` inside the
   backend plus `prime(target)` on the seam — the registry awaits it before
   `open`, so `open`/`oneShot` stay synchronous (the bootstrap line is written
   the moment a shell opens). `worker.ts`'s module graph is now byte-identical
   to `main`'s.
   **Lesson for Review:** a new static import in `worker.ts` is a load-bearing
   change, not a wiring detail. `worker-version-marker.test.ts` is the alarm.

### Mutation summary (all planned targets, and the extras)

Every row was applied, the narrow suite run, and the file restored.

| # | mutation | result |
|---|---|---|
| 1 | k8s raw writer appends `\n` (the RPC framing mistake) | **killed** (2 red) |
| 2 | k8s per-message decode of channel bytes | **killed** (1 red) |
| 3 | docker per-frame decode of stdout/stderr | **killed** (1 red, after strengthening) |
| 4 | no cap on open shells | **killed** (1 red) |
| 5 | `dispose`/`close` without the kill one-shot | **killed** (2 red) |
| 6 | drop the `[new shell …]` reset notice | **killed** (2 red) |
| 7 | register `workload_shell` unconditionally (pod-daemon drift) | **killed** (3 red) |
| 8 | remove the session-end dispose | **killed** (2 red) |
| 9 | capture window never drops | **killed** (1 red) |
| 10 | no leading-newline strip | **killed** (1 red) |
| 11 | parser with no marker carry | **killed** (1 red) |
| 12 | kill script without the self-exclusion guard | **killed** (1 red, added after the live finding) |
| 13 | grant bleed PAIR: a no-suggestion "always" → session-wide + `covers` falling through | **killed** (2 red) |
| 14 | suggestion offered when the rule cannot cover the command | **killed** (`permission-workload-shell`) |
| 15 | keepalive while `running` | **n/a — see Drift 2** (no keepalive is sent) |

Two mutations needed the *test* fixed before they died, which is the point of
mutating: #3 (splitting UTF-8 inside one frame proves nothing — it must cross two
frames) and #13 (either half alone is invisible; the pair is the bug).

### Gate (final, on this branch)

```
bunx tsc --noEmit                  → clean
bunx tsc -p apps/mobile --noEmit    → clean
bunx tsc -p apps/relay --noEmit     → clean
bun run lint                        → Checked 1391 files. No fixes applied. (0 errors)
bun test                            → 10057 pass · 4 skip · 0 fail · 727 files (396 s)
```

The 4 skips are the documented opt-in rows (live-k8s `TENTACLE_K8S_SERVER`,
live-docker `TENTACLE_DOCKER_TESTS=1`, the real-socket keepalive
`TENTACLE_SLOW_TESTS=1`, and one more of that family) — NOT failures (§6).
No `protocol.d/` note: no schema, method or update kind changed.

### Not done (deliberate, per the plan's own scope)

- `job_write` — owner NO-GO.
- Streaming `read`, stdin to commands, a TTY, replay after a reconnect.
- Pod-daemon registration (out by design; pinned by a test).
- The opt-in live suites (`TENTACLE_K8S_SERVER` / `TENTACLE_DOCKER_TESTS=1`) were
  **not added** as test files: the live proof above ran the real client +
  registry against a real container by hand (output pasted here), which is what
  the plan's *Validation* asks for before Review. A skipped-by-default live file
  whose rows nobody runs would be weaker evidence than the transcript above, and
  adding one that cannot run in this environment would be an unverified claim.
  **Unverified:** the k8s live path (no cluster here — the k8s primitive is
  covered by `FakeWS` only).

### Debt

- The idle keepalive gap (drift 2): a long-idle docker exec may be cut by the
  engine; the next run reports it honestly but the state is lost.
- The prompt does not name the kube CONTEXT (owner Q5), and neither does the
  first result. The backend resolves and holds it (`LaptopWorkloadShellBackend`
  has a `where(target)` that returns `context "kind-dev", namespace default`),
  but nothing calls it: D3's `[opened sh in kubernetes context …]` line needs a
  place in `resultText` for an INFORMATIONAL line, and every existing notice
  there makes the result an error (`isError`), which a successful open must not
  be. Deliberately left out rather than fudged; the context is pinned per
  session (the `(engine, namespace)` cache), so it cannot silently change under
  an open shell — only its visibility in the transcript is missing.
- Non-TUI frontends show the generic "always" label; the real rule is narrower
  (the safe direction).
- `&`-backgrounded grandchildren can survive a daemon crash — parity with
  `oc exec`, and the description warns against it.


### Fix round 1

*— claude-sonnet-4-5, 2026-11-15* (executor of the review round 1 findings)

All three findings are MEDIUM; no HIGH was raised. Every fix is red-first (§9),
mutation-checked, and confined to `packages/tools/src/workload-shell.ts` + its
test file.

**F1 (MEDIUM) — an open still resolving when the session ends left a live shell.**
Root cause: `run` checked `disposed` only at entry, so an `open` awaiting `prime`
(or the ready marker) went on to `backend.open`, wrote into a disposed registry
and returned. Two re-checks, one per await boundary, plus a rethrow on the
failure path:

- `refuseIfDisposed()` after `await prime` (`workload-shell.ts:510`) — before
  `backend.open`, so no exec is created at all.
- the same after `await readyDone` (`:588-592`) — the shell is in the map by
  then, so it is `forget`+`closeShell(includeSelf)`d and then refused. This
  branch is reachable only when the backend's `close()` does not synchronously
  fire `onEnd` (real for k8s: the kubelet answers late); without it the run
  silently waited out its 60 s timeout on a closed exec.
- the `readyDone` catch also re-checks (`:575-576`) so a failed open during a session
  end reports the refusal, not `explain()`. `refuseIfDisposed` is one method so
  the three sites cannot drift.

Review's own repro (`.tentacle/tmp/workload-shell/review-dispose-race.ts`), same
file, before → after:

```
before: { outcome: "hi", opened: 1, closed: false, sizeAfterDispose: 1 }
after:  { outcome: "threw WorkloadShellRefused: this session's shells are already disposed",
          opened: 0, closed: false, sizeAfterDispose: 0 }
```

**F2 (MEDIUM) — a failed open never closed its exec.** The ready-timeout and
bad-ready paths called `forget(key)` and rethrew; the exec stream (and a slow
`sh` behind it) stayed live outside the registry, unreachable by `dispose` or
the idle close. New `abandon(shell)` (`:603-617`): `exit\n` (a live `sh` reads it
as EOF → `exit`), then `exec.close()`. Called from the `readyDone` catch
(`:575`). It deliberately does NOT kill a tree: the pid comes from the ready
marker, which is exactly what failed.

While here, one adjacent wart the second dispose test exposed: `closeShell` fired
`killTreeScript(shell.pid, "KILL")` unconditionally, so an unready shell produced
`__tnt_target=0` — and in `sh`, `kill -KILL 0` is not pid 0 but *the caller's
whole process group*. Guarded at `:463-469` (only when `shell.pid > 0`); such a
shell is ended by the EOF above, which is all it can be.

**F3 (MEDIUM) — the cap of 4 was bypassable by parallel opens.** The check used
`shells.size`, and `open` enters the map only after its awaits; distinct targets
run on distinct concurrency lanes, so N parallel first-runs all passed. New
`pendingOpens` counter (`:210`), reserved in `open` before its first await and
released in `finally` (`:492-500`, with the body renamed `openReserved`); the
check is now `size + pendingOpens >= MAX` (`:271`), and the refusal lists
in-flight opens too (`capMessage()`, `:474-480`).

Repro (`.tentacle/tmp/workload-shell/cap-repro.ts`: five parallel first-runs of
distinct targets against a gated backend), same file, before → after:

```
before: { results: ["ran","ran","ran","ran","ran"], opened: 5, size: 0 }
after:  { results: ["ran","ran","ran","ran","refused: … already holds 4 shells (4 opening)…"],
          opened: 4, size: 0 }
```

**Tests added** (`packages/tools/test/workload-shell.test.ts`: 5 new tests, plus
four fake knobs — `primeGate`, `readyGate`, `muteBootstrap`, `closeWithoutEnd`),
each RED on the pre-fix source before the fix:

| test | red on |
| --- | --- |
| `dispose > an open still priming when the session ends leaves NO live shell` | F1 (post-prime) |
| `dispose > an open that turns ready AFTER the session end is closed, not run` | F1 (post-ready) |
| `dispose > an open whose ready is cut by the session end leaves nothing live behind` | F2 (pid-0 guard) |
| `failure modes > a shell that never becomes ready closes its exec…` | F2 (abandon) |
| `the cap > refuses the 5th CONCURRENT open, not just the 5th open shell` | F3 |

Red evidence (`bun test packages/tools/test/workload-shell.test.ts` on the
pre-fix source):

```
(fail) the cap > refuses the 5th CONCURRENT open…          Expected length: 1, Received length: 0
(fail) failure modes > a shell that never becomes ready…   expect(exec.closed).toBe(true) → false
(fail) dispose > an open still priming when…               expect(result.isError).toBe(true) → false
(fail) dispose > an open whose ready is cut…               pid-0 guard assertion → false
(fail) dispose > an open that turns ready AFTER…           5 s hang, then the refusal assertion → false
```

**Mutations (each reverted; source back to the fixed file, byte-identical — every
one killed exactly its own test and nothing else):**

- `− this.refuseIfDisposed()` after `prime` → *an open still priming …* red (1).
- `− this.abandon(shell)` in the catch → *a shell that never becomes ready …* red (1).
- `− if (shell.pid > 0)` in `closeShell` → *an open whose ready is cut …* red (1).
- `− the post-ready disposed block` → *an open that turns ready AFTER …* red (1).
- `size + pendingOpens` → `size` in the cap check → *the 5th CONCURRENT open* red (1).
- `− the pendingOpens reserve/release in open()` → the same test red (1).

**Drift from the plan:** none — the review's three fixes are as it asked, plus
the pid-0 guard, which is a latent defect in the same close path that the F2 fix
made visible (a `kill` naming a wildcard process group is worse than the leak it
was meant to clean up). No protocol, persistence or §7 change: the fix sits
inside the registry that already owns the shells' lifecycle.

**Left open:** `dispose` still cannot reclaim a shell whose `open` is between
`backend.open` and `shells.set` (nothing holds it yet). Closing that window needs
a try/catch around `backend.open` itself, and it is only reachable when that call
throws — in which case nothing was created.

**Gate (this round, on this branch):**

```
bunx tsc --noEmit   → clean
bun run lint        → Checked 1391 files. No fixes applied. (0 errors — baseline §6)
bun test            → 10062 pass · 4 skip · 0 fail · 727 files (395 s)
```

The 4 skips are the documented opt-in rows of §6 (live-k8s, live-docker, the
real-socket keepalive) — not failures. Untouched by this round: no protocol,
persistence, permission or broker change; the diff is the registry's open/close
lifecycle plus its tests.

## Review — owner verdict

*Owner: GO / NO-GO / GO-with-changes, date, and any decision on approval scoping.*

-

## Review — owner verdict (2026-11-14 00:10)

**GO for the small v1** (`workload_shell` on k8s + docker/podman, ~3 slices, no protocol change). **`job_write`: NO-GO for now.** "Always" approvals of the tool are **scoped to the single workload** (recommended). Promoted to `docs/feat/workload-shell.md` (branch `feat/workload-shell`).

## Review

*— claude-opus-5-5, 2026-11-15* (fresh context; same model family as the plan's author, a different one from the executor)

**Verdict: REQUEST-CHANGES** — the §7 invariants hold; two "no leftovers" (D4) holes are confirmed by a repro.

**Gate (touched files):** 279 pass · 0 fail (13 files, incl. `worker-version-marker`). `bun run lint`: clean (1391 files). `bun run typecheck`: clean. The full `bun test` was not re-run here.

**Findings**
1. **MEDIUM — after `dispose`, an open can finish and leave a live shell** (`packages/tools/src/workload-shell.ts:258-261`, `:461-471`, `:563-570`). `run` checks `disposed` only at entry. An `open` that is awaiting `prime` when the session ends goes on to `backend.open`, writes into `shells` of a disposed registry and returns. Nothing closes it again. Repro (`.tentacle/tmp/workload-shell/review-dispose-race.ts`): dispose while prime is pending, then release it → `{outcome:"hi", opened:1, closed:false, sizeAfterDispose:1}`. Fix: re-check `disposed` after `prime` and after ready, and close the shell + kill its tree there.
2. **MEDIUM — a failed open never closes its exec** (`workload-shell.ts:514-519`). The ready-timeout (15 s) and bad-ready paths call `forget(key)` and rethrow, but never call `exec.close()` or kill the tree. A slow or garbled bootstrap leaves a live exec stream, and possibly a running `sh`, outside the registry, where neither dispose nor idle close can reach it. Same repro, first run (wrong ready marker): `opened:1, closed:false` after the timeout.
3. **MEDIUM (minor) — the cap of 4 can be bypassed by parallel opens** (`workload-shell.ts:267-273`). The check happens before `await this.open()`, which only inserts into the map after `prime`. Distinct targets run on separate concurrency lanes, so N parallel first-runs all pass the check.

**Mutations (each reverted, tree byte-identical, `git status` clean):**
- `workloadTargetKey` ignoring the container → session-grants goes red (1).
- Removing the session-end `dispose` → teardown goes red (2).

**Attacks tried:**
- Grant bleed across workloads/tools: holds (keyed; no fallthrough to `grantedTools`).
- The settings rebuild's `foreign` check: holds. Only `tunnelledAgent` honours `reuse`, and it never has shells. Worker/serve report no settings, so a sync gives `applied:false` and the empty registry is disposed.
- Pod-daemon registration: absent (`serve.ts` `tunnelledAgent` and the non-proxy pod branch pass no backend).
- Single broker: holds (`permission:"ask"`, same gate).
- A forged pid/sentinel only affects the pod itself.
- Subagents are not offered the tool.

**Executor:** thorough and honest about drift (keepalive dropped, live suites not added, k8s unverified live). It missed the lifecycle edges of `open` itself.

### Round 2

*— claude-opus-5-5, 2026-11-15* (reviewed `git diff HEAD~1`, commit `9c3fd17e`)

**Verdict: PASS.** All three round-1 findings are fixed. Each fix was confirmed by a mutation, and no regression was found.

- **F1 (dispose during open):** `refuseIfDisposed()` after `prime`, plus a close-and-refuse after ready (`workload-shell.ts`, `openReserved`). The round-1 repro now prints `threw … already disposed, opened:0`.
  - Mutation: removing the post-prime check → "an open still priming…" goes red.
  - Mutation: disabling the post-ready block → "an open that turns ready AFTER…" goes red (5 s timeout).
- **F2 (a failed open leaks its exec):** `abandon(shell)` (EOF + close) in the ready-failure path.
  - Mutation: removing it → "a shell that never becomes ready…" goes red.
- **F3 (cap bypass):** `pendingOpens` is reserved before the first await and released in `finally`.
  - Mutation: dropping it from the cap check → "refuses the 5th CONCURRENT open" goes red.
- **Extra, a good catch by the executor:** `closeShell` skips the kill script when `pid <= 0`. In sh, `kill -KILL 0` targets the caller's whole process group. That path was reachable in round 1 when dispose hit an unready shell.
- **Regressions checked:** `pendingOpens` cannot leak when `prime` throws (released in `finally`). Calling `abandon` after dispose has already closed the shell is harmless (close is idempotent). The `forget`/`refuse` ordering leaves no entry behind.
- **Gate:** tools, grants, teardown and wiring tests: 363 pass, 0 fail (20 files). `bun run lint`: clean (1391 files). `bun run typecheck`: clean. `git status` is clean after every mutation was reverted.
