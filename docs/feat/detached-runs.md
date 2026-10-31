# feat/detached-runs — leave a `run` working with no TUI, re-attach later

> **Status:** execution — S1 `pod-daemon-resident` DONE (merged 2026-10-30, no tag; fix rounds 1–6 reviewed, live-tested); S2 `detached-relay` DONE (merged 2026-10-31); S2b + S4 `detached-relay-lifecycle` built, awaiting Review; next S3 (release with protocol 14 after S3)
> **Branch:** `feat/detached-runs` (promoted from `docs/eval/`; the slices below are one branch each, sequential — see "Slices")
> **Type:** feat · **Size:** L overall = 5 slices (S1 L, S2 M, S3 M, S4 S, S5 M; no slice is XL) · **Blast:** load-bearing (S1, S2, S3, S5; S4 contained) · **Suited:** owner assigns; per AGENTS §10 every load-bearing slice gets a strong model + a mandatory fresh-context Review, S4 a standard Review

## Context

*— claude-opus-5-5, 2026-10-27*

### The question (owner, TODO.md "4b. Detached runs", 2026-10-27)

Leave a `run` (k8s pod or docker/podman container) working with no TUI, and
re-attach later. The model stays on the laptop (AGENTS §7), so something
**laptop-side** must keep the `model/stream` proxy, the single permission
broker and laptop persistence alive without Ink. The question this eval
decides first: **where does that laptop-side relay live?** Then the owner's
open questions (DR-2 … DR-9) and a split. Lands **after docker slice E**
(`tentacle ps`/`rm`, laptop index `<configDir>/kept/index.json`, name-based
`attach` resolution — `docs/feat/engine-ps-rm.md` on branch `feat/engine-ps-rm`
§3, and the owner-approved UX `.tentacle/tmp/plans/engine-ps-rm-ux.md`).

### Facts from the code (verified 2026-10-27 on `main` 670aee1)

- **F1 — The pod daemon lives exactly as long as ONE exec's stdin.**
  `run`/`attach` exec `tentacle serve --stdio --model-proxy …`
  (`packages/cli/src/engine-runtime.ts:58-71`). `startStdioDaemon` binds one
  `Connection` to stdin/stdout and resolves on stdin `end`/`close`
  (`packages/cli/src/serve.ts:456-485`); `main` then returns
  (`main.ts:407-416`) and the process ends with its in-memory sessions. A
  reconnect is "a new exec = a new `serve --stdio`" whose session is recreated
  from the laptop's history, "a turn in flight is reported lost"
  (`engine-runtime.ts:162-168`). Closing an `attach` TUI: "the daemon dies
  with it" (`engine-runtime.ts:376-378`).
- **F2 — The model tunnel is one connection, and leaving it cancels the turn.**
  `tunnel = connection` is set once per stdio daemon (`serve.ts:428`, `:468-470`);
  every model call looks it up per call (`ready()`, `serve.ts:383-394`). The
  connection is `servesModel` (`serve.ts:466`), so releasing a session from it
  cancels the turn (`daemon/src/connection.ts:79-83`, `:133-137`).
- **F3 — The daemon side already supports several clients per session.**
  `HostedSession` keeps a set of attachments (`hosted-session.ts:325`);
  `permission_request` is session STATE streamed to every attached client
  (`hosted-session.ts:20-29`); with **nobody attached the ask is held** for a
  client to attach (`:494-501`, `:566-576`); of two answers exactly one wins
  (`:593-605`); `session/open` re-attaches with a gapless replay
  (`session-host.ts:337-342`). `serve` already hosts many `Connection`s on one
  `SessionHost` over `startWsServer` (`serve.ts:259-274`,
  `daemon/src/ws-server.ts:177`). Pod runtimes use none of this: "exactly one
  client — the laptop" (`docs/eval/session-handoff.md` Context).
- **F4 — The laptop half of a run is already Ink-free except one flag.**
  `startEngineRuntime`/`attachEngineRuntime` return a `LocalRuntime`
  (`engine-runtime.ts:207-350`, `:383-581`) built by `createLocalRuntime`:
  `RemoteClient` + broker + `laptopModels` + the persisting controller that
  saves on every turn (`local-runtime.ts:293-384`, `:218-231`). Ink enters only
  in `runEngineTui` (`main.ts:553-579`). The one TUI assumption inside:
  `hooksTrust` is built with `interactive: true` (`local-runtime.ts:297-303`);
  non-interactive means "declined" + a notice (`hooks-trust.ts:31-39`, `:175-181`).
- **F5 — Single broker, held until a requester exists.** `run`/`attach` build
  ONE `PermissionBroker(undefined, { holdUntilSet: true })` for runtime + TUI
  (`main.ts:544-552`, `:626`, `:686`); with no requester a request is queued,
  never approved (`core/src/permission.ts:9-12`, `:121-126`). The client router
  sends NOTHING for a dismissed prompt — the ask stays pending daemon-side for
  another client (`client/src/permission-router.ts:14-15`). The client answers
  only `model/stream[_chunked]` and `hooks/trust` (`remote-client.ts:948-962`).
- **F6 — Detached children are an existing pattern.** The delete-on-exit net is
  a detached, unref'd child that re-execs the binary with a hidden subcommand,
  secrets via env (`main.ts:229-240`, `engine-runtime.ts:183-198`).
- **F7 — `run` has no prompt argument.** `run`'s positional is the workload
  name (`main.ts:606`); the one-shot prompt path is the bare `tentacle <words>`
  in-process agent (`main.ts:813-840`). A detached one-shot needs a new flag.
- **F8 — Auto-wake on a background-job exit lives in the TUI** (`App.tsx:261`,
  `:547`), not in the runtime: with no TUI, nothing wakes the agent.
- **F9 — `serve` is a foreground, per-project, TCP daemon** (`main.ts:441-469`:
  runs until Ctrl+C; `serve.ts:104-146`: one store lock per
  `<configDir>/daemon/<projectKey(cwd)>`), and every `serve` session is a
  local `Agent` (`createAgent` → `buildAgent`, `serve.ts:161-184`): its
  sessions run the agent loop **on the laptop** with the laptop's own tools.

**Load-bearing consequence of F1+F2:** today a run cannot outlive its laptop
process even with a perfect relay: when the process holding the exec goes, the
pod daemon and its session go too, and an in-flight turn is lost. So
"detach" is two problems: **(i)** something laptop-side to serve the model and
answer/hold permissions, and **(ii)** a pod daemon that survives the hand-over
between laptop processes (relay ↔ TUI).

## Options & decisions

### DR-1 — Where the laptop-side relay lives (load-bearing)

**Owner decision (2026-10-27): (c) ACCEPTED** — resident pod daemon + one laptop owner at a time (TUI or headless relay). Orchestrator probe (Docker Desktop, 2026-10-27): processes started via `docker exec` (with and without `setsid`) keep running after the exec ends; Kubernetes exec still to verify.

**(a) Reuse `tentacle serve` as the host of detached runs.** The run becomes a
session of a local `serve`; the TUI re-attaches with `connect`. *Exists:*
detached sessions, re-attach + replay, archive, TTL, `session/list`, multi-client
permissions (F3, F9). *Breaks:*
- `serve`'s session IS a local `Agent` (F9). Driving a pod from it needs either a
  `HostedSession` backed by a `RemoteClient` (a second session code path —
  AGENTS §7 "TUI always over RPC — one session path" forbids exactly this) or
  moving the agent loop to the laptop with tools tunnelled to the pod (a new
  execution model, contrary to "compute next to the code").
- Persistence ownership: `serve` persists daemon-side, "the daemon's copy wins
  on re-attach" — here the "daemon" would be relaying pod-supplied history, and
  `connect` keeps no laptop copy, so the pod's word becomes the record of truth.
- `serve` is foreground, one per project store, on TCP (F9): it would have to
  become a background service anyway, and a `serve` exposed with `--host` +
  token would let a remote `connect` answer a pod's prompts.
- Verdict: **rejected** — the reuse is illusory; it costs a second session path.

**(b) A per-run relay process that proxies the protocol.** A detached child holds
the exec and is the pod's only client; a TUI re-attaches to the relay over a
local unix socket. *Exists:* the whole laptop half (F4), the detached-child
pattern (F6). *New:* the relay must *serve* the tentacle protocol to the TUI
(initialize, open/replay with `seq`, prompt, enqueue, send-now, cancel,
resolve_permission, snapshot, compact, rename, skills, mcp/status…) on top of a
`RemoteClient` — a re-implementation of `Connection` over a client, i.e. a
second session path again, plus a frame-level `seq`/replay buffer of its own.
Frame splicing (relay forwards raw frames) fails on per-connection state: the
pod `Connection` is already `initialize`d and attached by the relay.
- Re-attach: TUI → relay socket. Two attachers: the relay must broadcast.
- Mac sleep / relay crash: F1 still holds — the exec dies, the pod daemon dies,
  the in-flight turn is lost.
- Verdict: **rejected** as the full design (too much new protocol surface; and
  it does not fix F1).

**(c) A resident pod daemon + one laptop OWNER at a time (relay or TUI), with
hand-over.** *(recommended)*
- **Pod side:** the daemon outlives the exec. The first exec starts
  `serve --resident` in the pod (detached in the pod, listening on a unix
  socket / loopback only), and every exec is a dumb byte bridge
  (`serve --bridge`: stdio ↔ that socket). The resident daemon is a normal
  multi-connection `SessionHost` (F3, the `serve` shape) — no new session logic.
  Change to F2: the model tunnel is "any attached connection that serves the
  model" (looked up per call, as `ready()` already does), and a release cancels
  the turn only when the LAST serving connection leaves.
- **Laptop side:** at any moment exactly one laptop process OWNS the run — it
  serves the model, holds the single broker, and persists. It is either the TUI
  (today's `run`/`attach`, unchanged) or the **relay** = `attachEngineRuntime`
  with no Ink (F4) spawned as a detached child (F6), with
  `hooksTrust.interactive = false` (F4) and its own one broker (F5).
- **Hand-over** (both ways, `/detach` and re-`attach`): the new owner attaches
  and starts serving the model; then the old one flushes its saver and leaves.
  The brief overlap is safe because the daemon picks a serving connection per
  call and only the owner persists. A per-run local control socket
  (`<configDir>/kept/<name>.sock`, 0600) carries only `status` / `handover` /
  `stop` — never the session protocol.
- **What exists:** multi-client sessions, held asks, exactly-one-answer, replay
  (F3); the Ink-free runtime (F4); the detached-child pattern (F6); the kept
  index + labels + name resolution (slice E). **What is new:** resident +
  bridge modes, the multi-serving tunnel, the relay entry point, the control
  socket + owner/status file, hand-over.
- **§7 check.** One session path: yes (every client is a `RemoteClient` ↔
  `Connection`). Single broker: one per laptop process, shared by that
  process's runtime and its requester (TUI prompt or relay policy) — two owners
  are two clients, like two `connect` devices, never two brokers in one process.
  Pod not trusted: every laptop effect is still gated in the owner's process; a
  pod-resident daemon stores nothing durable (memory only). Model on the
  laptop: unchanged. Persistence on the laptop: one owner = one writer per uid.
- **Bonus without detach:** a Mac sleep or a dropped link no longer kills the
  pod session — today's "turn reported lost" (F1) becomes "turn cancelled,
  session intact in the pod".

**(d) Considered and dropped:** a relay with no live re-attach (re-attach = relay
exits at a turn boundary, TUI resumes with `--resume`): a detached turn waiting
on a permission could only be handed over by killing it, and the laptop saves
only at turn end (`local-runtime.ts:218-231`), so the whole turn would be lost.

**Failure modes under (c)** (each converges to "laptop history up to the last
turn end + the pod's in-memory session"):

| Event | What happens | How it converges |
|---|---|---|
| Mac sleeps / lid closed | The exec link dies (k8s keepalive closes it, `k8s/src/exec-channel.ts:61`, `:114-115`); last serving connection gone → turn cancelled (F2). Session stays in the pod. | On wake the relay's `channelFactory` redials (`local-runtime.ts:257`, `engine-runtime.ts:169-181`) and re-attaches. The cancelled turn is NOT re-run: status = `interrupted (sleep)`; the user re-prompts. DR-9 reduces the odds. |
| Reboot / relay killed (SIGKILL) | Same as sleep, but no relay comes back. Owner file holds a dead pid. | `ps` shows `relay lost`; `tentacle attach <name>` takes ownership (stale-pid check) and re-opens the session from the pod (or `--resume` from laptop history if the pod daemon is gone too). |
| Relay crashes | As above; its log keeps the error (DR-6). | As above. |
| Workload deleted under the relay | `dialVerdict` refuses the redial (`engine-runtime.ts:175-178`). | Relay writes `failed: <noun> gone`, flushes, exits; laptop history intact. |
| Pod/container restarted | Resident daemon gone. | `attach` starts a new one; session recreated from laptop history (`session/open{messages}`, existing). |
| Two attachers (TUI + TUI, or `attach` while the relay owns) | The second asks the owner for `handover`; only one owner. A second TUI that declines the hand-over is refused (v1), not a silent co-owner. | Owner file is the lock (atomic create, pid + start time). |
| Permission pending, nobody attached | The relay's broker holds it (F5); the pod holds it (F3). | Answered on re-attach (replayed `permission_request`); or per DR-3. |
| Version skew relay vN / CLI vN+1 | Control socket + owner file carry `schemaVersion` + app version; the pod daemon is vN. | The new CLI does NOT replace the resident binary while an owner or a running turn exists (today `attach` replaces on mismatch, `engine-runtime.ts:459-531`); it says: "detached run on vN — wait, `tentacle stop <name>`, or use vN". `initialize` still fails cleanly with `VersionMismatch` (`remote-client.ts:1003-1006`). |
| Resident daemon idle forever | Sessions in pod memory, no client. | Exits with the pod; plus `serve`'s existing reaper/TTL (`serve.ts:275-340`) applied to the resident daemon. |

### DR-2 — `--detach` only one-shot, or also `/detach` from a running TUI?

**Owner decision (2026-10-27): BOTH (A) and (B)** — `run --detach --prompt` AND `/detach` from a running TUI are in scope of the first deliverable (slicing/order decided when the plan is written).

Options: (A) one-shot only: `tentacle run --detach --prompt "<text>" …` (F7: needs
`--prompt`, or stdin when not a TTY); (B) also `/detach` in the TUI; (C) `/detach`
only.
**Recommendation:** (A) first, (B) as its own later slice. Both are the same
hand-over under (c) — one-shot is "the relay is the first owner", `/detach` is
"TUI → relay". (A) needs no TUI change and ships the relay, status and logs;
(B) touches the TUI teardown path (Ink + `runSessionTui`), which deserves its own
review. `--prompt` is refused without `--detach` in v1 (a non-detached `run`
already has the TUI input).

### DR-3 — `--auto-accept[=true|false]` semantics

**Owner decision (2026-10-27): (A) by default** — a detached run waits at the first ask — UNLESS it was launched with `--auto-accept`, or the TUI was already in auto-accept mode when the user typed `/detach` (the relay inherits that mode). Auto-accept keeps the (C) limits: pod-side asks only, allow-once, logged; laptop-side gates never auto-approved (AGENTS §7).

Options: (A) no auto-accept: a detached run stalls on the first ask until
someone attaches; (B) auto-accept every pod-side ask; (C) B but scoped.
**Recommendation:** (C), default **off**, explicit opt-in:
- The relay's requester answers a **pod** `permission_request` with **allow
  once** — never a session/"always" option — and logs each one (tool + summary,
  sanitised with `untrustedText`, `cli/src/untrusted-text.ts:12`).
- It never covers a laptop-side gate: `hooks/trust` stays non-interactive →
  declined (F4); future `runOn: "client"` MCP tools stay held. Rationale: an
  auto-approved pod tool gives the pod nothing it could not do itself (it is
  untrusted and runs its own tools); a laptop effect would (AGENTS §7 "never let
  a pod-originated prompt create a lasting approval").
- Valid only with `--detach` (refused otherwise), shown in `ps` (`auto` marker)
  and as a TUI notice on re-attach; it ends with the relay — a TUI owner prompts
  as today.
- Off: the launch line says it: "detached; it will wait at the first permission
  — `tentacle attach <name>` to answer". `ps` STATUS shows
  `waiting: permission (shell)` from the relay's held ask (owner file, DR-6).

### DR-4 — Relay lifetime

**Owner decision (2026-10-27): recommendation ACCEPTED** — (A)+: relay exits when the session is idle, after a 60 s grace; also on `rm`/stop/workload gone.

Options: (A) until the turn ends; (B) until `rm`; (C) idle TTL.
**Recommendation:** (A)+: the relay exits when the session is **idle** — turn
ended, nothing queued, no pending ask, no running background job — after a short
grace (60 s, absorbs a queued follow-up). Under (c) nothing is lost when it goes:
the session stays in the pod, history is on the laptop, and the next `attach`
owns it normally. It also exits on `stop`/`rm`/workload gone. Not (B): a relay
whose only job is serving the model would sit forever holding the model key
open and the Mac awake. v1 does **not** auto-wake on a background-job exit (F8:
the logic is in the TUI); the relay simply stays while a job runs, and the
turn-end status says "background job still running". Revisit once auto-wake moves
to a pure module (AGENTS §7 "logic lives in pure modules").

### DR-5 — `--keep=false` with a detached run

**Owner decision (2026-10-27): recommendation ACCEPTED** — (B): with `--keep=false` the relay removes the workload when it exits normally; exit net for crashes; a pending ask keeps it alive.

Options: (A) refuse the combination; (B) delete when the relay ends; (C) ignore.
**Recommendation:** (B), explicit: with `--keep=false` the relay removes the
workload when it exits **normally** (idle/`stop`), and arms the existing exit net
(`registerExitCleanup`, `engine-runtime.ts:194-198`) in the relay process for
crashes; never on the launching CLI's exit (it exits at once). The launch line
warns: "removed when the run goes idle — its files go with it; the transcript stays
in `tentacle --resume <uid>`". `keep` defaults to true (owner, 2026-10-27), so this
is opt-in. A pending permission keeps the relay (hence the workload) alive.

### DR-6 — State, logs, `ps` (never the terminal)

**Owner decision (2026-10-27): recommendation ACCEPTED.**

**Recommendation:**
- Relay spawned with stdio to files only (never inherited): log at
  `<configDir>/kept/<name>/relay.log` (lifecycle lines, buffered pod stderr via
  `createStderrSink` `engine-runtime.ts:114-132`, laptop RPC errors, auto-accept
  decisions), size-capped with one rotation.
- Owner file `<configDir>/kept/<name>/owner.json` (`schemaVersion`, kind
  `relay|tui`, pid + process start time, app version, sessionId, state
  `running|waiting-permission|idle|interrupted|failed`, tool, lastActivityAt,
  autoAccept) — written by whichever process owns, so a TUI owner shows as
  ATTACHED. Beside slice E's `kept/index.json`.
- `ps`: STATUS gains `detached · running 3m`, `detached · waiting: permission
  (shell)`, `attached`, `relay lost`; `ps -v` shows the log path. `rm` on a run
  with a live owner: `stop` first via the control socket (still `[y/N]`, `-f`).
  A `tentacle logs <name>` is a later nicety.

### DR-7 — Notification on finish

**Owner decision (2026-10-27): (A)** — no notification in v1; `tentacle ps` only. The owner-file state transitions stay the event source for mobile push (task 17) later.

Options: (A) none now (`ps` only); (B) desktop notification now; (C) wait for the
mobile app (task 17, `docs/eval/mobile-app.md:335`).
**Recommendation:** (B) minimal and opt-out: on `idle` (turn done),
`waiting-permission` and `failed`, macOS `osascript -e 'display notification …'`
(other OSes: none in v1), config `detach.notify: true`. Text is laptop-composed
(name + state); pod-supplied text only through `untrustedText`. The owner-file
state transitions are the single event source task 17 will consume later.

### DR-8 — Re-attach UX

**Owner decision (2026-10-27): recommendation ACCEPTED, except the fallback** — if the pod/container is gone, `attach` stops with an EXPLICIT message (name, that the workload no longer exists, the session uid) and does NOT fall back to a local `--resume`. Later (separate idea): `--resume` that revives the session INTO a new container.

**Recommendation:** `tentacle attach <name>` (slice E resolves engine + location
from labels/index) detects a live relay owner and hands over (DR-1 (c)); it opens
the run's session (not a fresh one), replaying from the pod. If the pod daemon is
gone it falls back to `--resume <uid>` from the owner file. Quitting the TUI of a
detached-origin run behaves as today's `attach` quit (no relay respawn) unless
`/detach` (DR-2 B).

### DR-9 — Keeping the Mac awake

**Owner decision (2026-10-27): recommendation ACCEPTED** — (C), on by default on macOS, `detach.keepAwake: false` to opt out; the lid-close-on-battery limit is stated once at launch.

Options: (A) nothing (documented); (B) `caffeinate` while the relay lives; (C)
only while a turn runs.
**Recommendation:** (C), on by default on macOS: the relay spawns
`caffeinate -i -w <relayPid>` when a turn starts and kills it at idle/waiting
(`-i` prevents idle sleep; it does NOT prevent lid-close sleep on battery — say
so once in the launch line). `-w` ties it to the relay, so a relay crash cannot
leak an awake Mac. Waiting on a permission lets the Mac sleep (nothing to
compute). Config `detach.keepAwake: false` to opt out.

### Suggested split (all after docker E)

| # | Task | Size · Blast | Depends |
|---|---|---|---|
| 1 | `feat/pod-daemon-resident` — `serve --resident` + `serve --bridge`; multi-serving model tunnel, cancel only on the last serving connection (F2); `run`/`attach` use it; no-replace-while-busy rule; reaper on the resident daemon | L · load-bearing (pod lifecycle, model tunnel, §7) | E |
| 2 | `feat/detached-relay` — `run --detach --prompt`, relay entry point (headless `attachEngineRuntime`, `interactive:false` hooks trust), owner file, log, idle exit, `--keep=false` (DR-5), `--auto-accept` (DR-3), caffeinate (DR-9) | M · load-bearing (broker, persistence ownership, lifecycle) | 1 |
| 3 | `feat/detached-handover` — control socket, `attach` takes over from a relay (DR-8), stale-owner recovery | M · load-bearing | 2 |
| 4 | `feat/ps-detached-state` — `ps` STATUS/`-v` from the owner file, `rm` stops the owner, desktop notification (DR-7) | S · contained | 2 (3 for `rm`) |
| 5 | `feat/tui-detach` — `/detach` (TUI → relay hand-over) | M · load-bearing (TUI teardown, Ink/terminal invariant) | 3 |

Slices 1–3 and 5 → strong model + mandatory fresh-context Review; 4 may go to
a weaker model.

## Implementation

> **Orchestrator probe — Kubernetes exec survival, VERIFIED 2026-10-27** (kind v1.36.1, containerd, alpine pod with PID 1 = `sleep`): a process started inside `kubectl exec` keeps running after the exec ends, re-parented to PID 1, in all four cases — (A) `cmd &` then the exec returns; (B) `setsid cmd </dev/null &`; (C) `cmd & cat` with stdin EOF; (D) `cmd & cat` with the CLIENT `kill -9`'d mid-exec. Still alive 3.5 min later (`ps` ppid 1). Same result on Docker Desktop (`docker exec`, with and without `setsid`). Caveats: one container runtime tested (containerd); CRI-O not tested; a PID 1 that does not reap leaves exited children as zombies (harmless for a resident daemon, but S1 should not rely on reaping). P0 in S1 stays as a cheap re-check through the repo's own exec channel, but plan K (supervisor PID 1) is NOT expected to be needed.

*— claude-opus-5-5, 2026-10-27*

Verified on `feat/detached-runs` = `main` 85e5aeb (docker slices D+E merged).
The owner decisions above win over the original recommendations: **DR-2** both
`run --detach --prompt` and `/detach` · **DR-3** a detached run stalls at the first
ask unless `--auto-accept`, or the TUI was in auto-accept at `/detach` · **DR-7** no
notification · **DR-8** a gone workload gets an explicit message and NO local
`--resume` fallback.

### Load-bearing assumption

**A pod daemon started from an exec can become RESIDENT: it survives the end of
that exec, on docker/podman AND Kubernetes, and a later exec can reach it.**
Everything else is reuse of seams that already exist. Today it does not:

- `startStdioDaemon` binds ONE `Connection` to `process.stdin`/`stdout` and
  resolves on stdin `end`/`close` (`packages/cli/src/serve.ts:456-485`). `main`
  then returns 0 (`main.ts:502-511`) and the process ends, taking its
  `SessionHost` with it (`serve.ts:432`).
- Every exec runs that command (`podDaemonCommand`, `engine-runtime.ts:61-74`;
  `run` `:361-368`, `attach` `:608-615`). A redial is a new exec, so a new daemon
  (`execChannelFactory` doc, `engine-runtime.ts:180-199`).
- The workload's PID 1 is a plain keepalive that does not supervise anything:
  k8s `["sleep","infinity"]` (`packages/k8s/src/pod.ts:24-25`, `:57`).

**Evidence so far.** Orchestrator probe (Docker Desktop, 2026-10-27): a process
started by `docker exec`, with and without `setsid`, keeps running after the
exec ends. **Kubernetes is NOT verified.** It is a real risk: the CRI streaming
`Exec` runs under the stream's context, and a runtime may SIGKILL the exec's
process when the client goes. A child that left the process group and holds
none of the exec's stdio fds should be reparented to PID 1 and survive. The
fds matter because the shim waits for stdio to close. "Should" is a story, not
a fact.

**Probe P0 (S1's first step, before any edit; paste script + output into
Execution).** Run it in `.tentacle/tmp/detached-runs/p0/`. It uses the repo's
OWN k8s exec path, because how the stream closes matters (v4 cannot half-close
stdin, AGENTS §7), not `kubectl`. The steps:
1. Create a pod with `createPod` from `@tentacle/k8s` (image
   `busybox:glibc`, keepalive `sleep infinity`) on the current kubeconfig
   context. Record `kubectl get node -o wide` CONTAINER-RUNTIME.
2. Open a long exec with `openExec` (the k8s `execChannel`), running
   `sh -c '<variant>; echo started; cat'`, where `<variant>` is each of:
   (a) `sleep 600 &`
   (b) `setsid sleep 600 </dev/null >/dev/null 2>&1 &`
   (c) the real mechanism: `node:child_process.spawn(..., { detached: true,
   stdio: ["ignore", logFd, logFd] }).unref()` from the injected `tentacle`
   binary (a 10-line `bun build --compile` probe binary is fine).
   Wait for `started`, then close the channel the way the laptop does
   (`channel.close()`).
3. Repeat (b)/(c) with an *unclean* end: SIGKILL the probe's laptop process
   (the lid-close case; the kubelet notices on TCP/keepalive).
4. Wait 15 s, then a second one-shot `runExec(["sh","-c","ps -o pid,ppid,args || ls /proc/*/cmdline"])`.
   PASS = the `sleep 600` (or probe child) is still listed with ppid 1.
5. Run it on ≥1 containerd cluster (kind/k3s/EKS). Add CRI-O (OpenShift) if
   reachable; say so if not. Repeat (c) on docker AND podman with the same
   script, through the docker `execChannel`.

**If k8s kills exec children (P0 fails for (b) and (c)) → plan K.** The
resident daemon then cannot be a child of an exec. Instead it becomes a child
of PID 1, and only for workloads tentacle creates:
- `run` creates the pod with a supervisor keepalive, not `sleep infinity`:
  `sh -c 'while :; do [ -x BIN ] && BIN serve --resident …; sleep 1; done'`.
  It goes through `createPod`'s `command` option (`pod.ts:24-25`), so it is a
  createPod-only change. The injection is unchanged: the loop starts the
  daemon once the binary exists.
- `attach` to a USER-owned pod (its PID 1 is not ours) keeps today's per-exec
  daemon. `--detach` and `/detach` on it are refused, with a clear message
  ("this pod was not created by `tentacle run`: its daemon cannot outlive the
  exec").
- docker/podman keep the exec-spawned resident, if P0 (c) passes there.
- S1's design is otherwise unchanged: the bridge simply finds the socket
  instead of spawning. Record the verdict in Execution and adjust Files if
  plan K is taken (STOP-and-fix-the-plan rule, AGENTS §8).

### Preconditions (cited)

- **P1 — multi-client sessions exist.** `HostedSession` keeps a set of
  attachments (`daemon/src/hosted-session.ts:325`, attach `:800-825`, detach
  `:826`). `Connection.open` attaches with a gapless replay (`connection.ts:348-371`).
  An ask with nobody attached is held (`hosted-session.ts:567-576`).
- **P2 — the per-call model lookup already exists.** `tunnelledAgent` resolves
  `link()` on every call (`serve.ts:383-394`). Only the binding is
  daemon-global (`let tunnel`, `serve.ts:428`, `:468-470`).
- **P3 — the cancel rule is in ONE place.** `Connection.release` cancels the
  turn when `servesModel` (`connection.ts:132-138`). `session/detach` documents
  the same rule (`protocol/src/session.ts:470-478`).
- **P4 — the agent is built before its `HostedSession`.** `SessionHost.build`
  calls `createAgent(cwd)` and then `new HostedSession` (`session-host.ts:747-779`).
  A per-session link is therefore a late-bound closure.
- **P5 — the laptop half is Ink-free except hooks trust.** `createLocalRuntime`
  hard-codes `interactive: true` (`cli/src/local-runtime.ts:297-303`).
  `dispose` CLOSES the sessions (`:376-382`). The client already has
  `session/detach` (`client/src/remote-client.ts:643-670`) and `session/list`
  (`:439`).
- **P6 — single broker, held.** `run`/`attach` build one
  `PermissionBroker(undefined, { holdUntilSet: true })` (`main.ts:790`, `:893`).
  The pure `autoApproves(req)` (`tui/src/permission-ui.ts:41`) already refuses
  `hooks_trust`.
- **P7 — the detached-child and lock patterns exist.** There is a hidden
  subcommand dispatch (`main.ts:291-297`, `DELETE_POD_SUBCOMMAND`
  `k8s/src/pod-cleanup.ts:142`). The exit net is `registerExitCleanup`
  (`engine-runtime.ts:212-216`). The pid lock is `acquireStoreLock`
  (`daemon/src/session-persister.ts:282`).
- **P8 — the kept index ignores what is not a top-level `*.json`.** `readKept`
  skips dot-files and non-`.json` names (`cli/src/kept-index.ts:83-86`); entries
  are `<configDir>/kept/<hash>.json` (`:17-29`). Run state goes in
  `<configDir>/kept/runs/<hash>/`, a directory, so the index never reads it.
- **P9 — to verify in S1 (red test first): `session/open{sessionId, messages}`
  of a LIVE id attaches to the live session and does not recreate it.** The
  eval listed this as unverified with `servesModel`. If it recreates, S1 adds
  "live wins" in `SessionHost.open` before anything else.

### Design

**Pod side (S1).**
- **`serve --resident --socket <path> --model-proxy …`** is a `SessionHost`
  (same `createAgent` as `startStdioDaemon`, identity kind `container`) served
  on a unix socket (`node:net` server). Each accepted socket becomes
  `new Connection(streamChannel(sock, sock), host, log, { servesModel: true })`.
  This is the `startStdioDaemon` body with the stdin binding replaced by an
  accept loop: extract `podSessionHost(config, opts)` and share it. No new
  session logic.
- **Single instance:** `acquireStoreLock(stateDir)` (P7), then unlink a stale
  socket, then `listen`.
- **Default `stateDir`:** `${TMPDIR:-/tmp}/tentacle-<uid>/`, mode 0700. `/tmp`
  is writable even on a read-only rootfs, where `--bin-dir /tmp` is used.
- **Logs:** go to `<stateDir>/resident.log`, size-capped. Its stdio is never
  the exec's.
- **Idle exit:** the `listen` reaper policy (`serve.ts:278-330`) runs on the
  resident host. The resident exits when it has had 0 sessions and 0
  connections for 30 min.
- **`serve --bridge --socket <path> -- <resident argv>`** is what every exec now
  runs (`podDaemonCommand` → `podBridgeCommand`). It is a dumb byte pipe,
  stdin ⇄ socket and socket ⇄ stdout, with no frame parsing.
- **Bridge start-up:** on `ENOENT`/`ECONNREFUSED` it spawns the resident (P0
  variant (c): `detached: true`, stdio to the log, `unref`). It then retries
  the connect for ≤10 s. Two bridges racing → the lock lets one resident live,
  and both connect to it.
- **Bridge shutdown:** stdin end → `socket.end()`; socket close → exit. A
  killed exec kills only the bridge, so its socket closes and the resident
  detaches that `Connection`.
- **Per-session model link.**
  - `Attachment` gains `model?: ModelLink`: the connection, when it serves the
    model.
  - `HostedSession.modelLink()` returns the most recently attached attachment
    that has one. The newest owner wins new calls, which is the hand-over
    semantics.
  - `AgentFactory` gains `(cwd, { modelLink })`. `SessionHost.build` passes
    `() => hosted?.modelLink() ?? null`, bound after construction (P4).
  - `tunnelledAgent` already takes a `link()` resolver (P2), so it is unchanged.
  - The daemon-global `tunnel` goes away.
- **Cancel rule (P3):** `release` = `hosted.detach(attachment)`, then
  `if (servesModel && hosted.modelLink() === null) hosted.cancel()`. With one
  connection this is today's behaviour exactly. Update the `session/detach`
  doc comment.
- **Protocol bump:** this changes what `session/detach` means, so **bump
  `PROTOCOL_VERSION` 13→14** (AGENTS §7 "changed meaning"). There are no wire
  shape changes in S1.
- **No replace while busy.** Before `attach` replaces a mismatched binary
  (`engine-runtime.ts:536-600`), it runs the OLD binary's
  `serve --resident-status --socket …`. That prints one JSON line:
  `{version, sessions, running, attached}`; an old binary without the flag →
  "no resident".
  - If `running > 0 || attached > 0`: refuse with "a detached run is using
    tentacle vX in <name> — wait for it, `tentacle rm <name>`, or attach with
    vX".
  - Else: `serve --resident-stop`, then replace. The idle in-pod sessions are
    lost, and the laptop history is intact.
- **Redial semantics change for free.** A redial reaches the SAME resident, so
  the client's reopen finds the session live (P9), and "turn reported lost"
  becomes "turn cancelled, session intact". Update the `execChannelFactory`
  doc.
- **Quitting a TUI** still `dispose()`s, i.e. closes the session (DR-8 "as
  today's attach quit"). Only a hand-over or an idle relay DETACHES.

**Laptop side: the owner (S2, S3).** Exactly one laptop process owns a run.
The owner serves the model, holds the single broker, and persists. Its state
lives in `<configDir>/kept/runs/<hash>/` (dir 0700, files 0600; `<hash>` =
the kept entry's file stem):
- `owner.lock`: exclusive `wx` create, `{pid, startedAt, kind: relay|tui}`.
  Liveness = `kill(pid,0)` AND a control-socket `status` answer; else stale.
- `owner.json`: atomic temp+rename, strict parse, unknown `schemaVersion` →
  reported and treated as "unknown owner", never overwritten. Fields:
  `schemaVersion`, `kind`, `pid`, `appVersion`, `sessionId`, `state`
  (`starting|running|waiting-permission|idle|interrupted|failed`), `tool?`,
  `detail?`, `lastActivityAt`, `autoAccept`, `keep`.
- `control.sock` (S3): newline JSON `{schemaVersion, op: status|handover|stop}`.
  It carries no session protocol. A path over 103 bytes (macOS `sun_path`)
  falls back to `$TMPDIR/tentacle-<uid>/<hash>.sock`, and that path is written
  in `owner.json`.
- `relay.log`: capped (1 MiB, one rotation). It gets lifecycle lines, the
  buffered pod stderr (`createStderrSink`), laptop RPC errors, and every
  auto-accept decision as `untrustedText(tool + detail)`.
- `spec.json`: the relay's launch spec. No secrets: the relay reads the API
  key from config like any CLI.

**The relay** (S2) is the hidden subcommand `RELAY_SUBCOMMAND = "__relay"` (one
constant, pinned by a `main` dispatch test like P7). It gets
`TENTACLE_RELAY_SPEC=<path>` in env and is spawned `detached`, with stdio set
to `ignore` or the log, `cwd = config.cwd`, and `unref`'d. What it does:
1. Takes `owner.lock`, or exits 1 with "owned by pid N".
2. Builds ONE `PermissionBroker({ holdUntilSet: true })` with the requester
   from `relay-policy.ts` (a pure module):
   - auto-accept off → hold: record the ask in `owner.json` as
     `waiting-permission (tool)`, never answer.
   - auto-accept on and `autoApproves(req)` → `{ allowed: true, scope: "once" }`
     plus a log line.
   - `hooks_trust` → never answered by auto-accept. `interactive: false` →
     declined (F4).
3. Calls `attachEngineRuntime(config, { …, permissions, interactive: false })`.
   `LocalRuntimeDeps` gains `interactive?: boolean` (default true) and
   `LocalRuntime` gains `release()`: flush, then `session/detach` each open
   session, then close the transport. `release` does NOT close the sessions
   (P5).
4. **mode `start`** (`run --detach`): `createSession()` with the spec's uid and
   then `send(prompt)`. **mode `adopt`** (S5 `/detach`): open the existing uid
   and `watch()` it. Both persist through the same `persistingController`.
5. Drives `relay-state.ts`, a pure reducer: turn start/end, queue, ask
   pending/answered, `jobs` → `state` + `exitAt`. Idle = no turn, nothing
   queued, no pending ask, `jobs === 0`, then a 60 s grace (DR-4).
   - `jobs` is a new **display-free field** on the `session/list` entry, the
     count of running background jobs. Adding a field is free (§7 forward
     compat). The relay reads it at turn end and every 30 s while > 0.
6. At idle it calls `release()`, then the `--keep=false` step below, then
   deletes `owner.lock` and exits 0. The session stays in the pod and the
   history is on the laptop.
7. **Keep awake (DR-9):** on darwin with `detach.keepAwake` (default true),
   `keep-awake.ts` spawns `caffeinate -i -w <relayPid>` at turn start and
   kills it at idle or waiting (injectable spawner).

**`run --detach --prompt <text>` (S2).**
- Flags: `--prompt -` reads stdin when stdin is not a TTY. `--prompt` without
  `--detach`, `--detach` without a prompt, and `--auto-accept` without
  `--detach` are usage errors (DR-2/DR-3).
- The launcher runs the `run` setup unchanged (engine, mount gate, kept
  metadata; `main.ts:688-788`). It then calls the extracted
  `provisionWorkload()`, which is `startEngineRuntime`'s create → ready →
  inject → kept-line section (`engine-runtime.ts:251-360`). That provisions
  the workload WITHOUT a runtime, and `startEngineRuntime` itself calls it.
- It then writes `spec.json` (mode `start`, uid, prompt, autoAccept, keep),
  spawns the relay, and waits ≤30 s for `owner.json.state ≠ starting`.
- It prints one plain line (no Ink): "detached <name> — it will wait at the
  first permission (`tentacle attach <name>` to answer)" or "… auto-accepting
  pod tool asks (allow once; logged in <log>)". It adds the DR-9 lid note on
  darwin and exits 0.
- If the relay failed early it prints the log tail and exits 1.
- **`--detach --keep=false` (DR-5):** the workload is still created with the
  kept labels and index entry, so that `ps`/`attach`/`rm` can reach it while it
  runs. On a normal exit the relay removes it and forgets the entry, and it
  arms `registerExitCleanup` for crashes. The launcher never removes it.

**Hand-over (S3).** `attach <name>` reads `owner.json`.
- **Live relay:**
  1. Build today's runtime and open the session `owner.json.sessionId`,
     seeded from the laptop store (not a fresh session). It becomes the
     newest model link.
  2. Send `handover` with its pid.
  3. The relay stops answering: its requester switches to hold and its open
     prompts are dismissed. It stops persisting: it unsubscribes `watch`
     after `flushed()`.
  4. The relay waits for its in-flight model calls to drain via
     `RemoteClient.modelIdle()` (new: resolves when the client has no
     `model/stream*` request open), bounded at 5 min.
  5. It `release()`s and rewrites `owner.lock` to the new pid (temp+rename),
     replies `done`, and exits.
  6. The TUI writes `owner.json{kind:tui}`.
- **Live TUI owner** → refused in v1: "attached from another terminal (pid N)".
- **Stale owner** → taken over.
- **DR-8:** `owner.json` present and `describe(name) === null` → exit 1 with
  "<name>: the <noun> no longer exists — session <uid> cannot be re-attached;
  its transcript is kept on this laptop". There is no fallback.

**`/detach` (S5).** `commands.ts` gets `/detach`. It is available only when
`daemonInPod` (`main.ts:669`); elsewhere it shows a notice. The App only calls
`onDetach(autoApprove)`; its availability and messages come from a pure
`detach-command.ts`. `main` then:
1. Writes `spec.json` (mode `adopt`, uid, autoAccept = the TUI's auto-accept
   at that moment, DR-3) and spawns the relay.
2. Waits for the relay's `owner.json.state = running` (it has opened the
   session = the newest model link).
3. Does the TUI half of the hand-over: drain `modelIdle()`, flush,
   `release()`.
4. Unmounts Ink. The teardown then `write`s "detached <name> — `tentacle
   attach <name>`" after unmount, never while Ink owns the terminal (§7).
5. If the relay fails to adopt, the TUI stays mounted and shows a notice;
   nothing is released.

**`ps` / `rm` (S4).** STATUS comes from `owner.json` plus lock liveness:
`detached · running 3m`, `detached · waiting: permission (shell)`, `attached`,
`idle`, `relay lost`, `failed: <detail>`. `ps -v` adds the log path. `rm` with
a live owner first sends `stop` (the relay releases and exits), keeping the
existing `[y/N]`/`-f`. All pod-supplied text goes through `untrustedText`.

### §7 check

| Invariant | How it holds |
|---|---|
| One session path | Every client is still a `RemoteClient` ↔ `Connection`. The bridge moves bytes and the control socket never carries the session protocol. |
| Single broker | One broker per laptop process: the relay's, or the TUI's. Two owners overlap only during a hand-over, as two clients, never two brokers in one process. |
| Pod not trusted | The relay's auto-accept answers only POD asks, allow-once, logged. `hooks_trust` and laptop effects are never auto-approved. The resident daemon is memory-only. A pod process (same uid) that dials the resident socket can take over the POD session: attach as the newest model link (steer the agent with fake model output) and answer the session's POD-side asks — ACCEPTED risk (owner, 2026-10-27: the pod is not trusted; a token would not help, `/proc/*/environ` is readable). Laptop-side effects stay gated on the laptop (its own single broker, its allowlist). |
| Model on the laptop | The bridge carries `model/stream` exactly as the stdio channel did. |
| Persistence | One writer per uid: the old owner stops persisting before the new one starts. |
| Terminal | The relay never touches a TTY, and `/detach` writes only after unmount. |

### Files (dependency order) and slices

One code branch at a time, **sequential, not stacked** (AGENTS §10): each slice
merges before the next starts, and each ships alone.

| Slice | Size · Blast | Ships | Files (protocol → daemon → client → cli → tui) |
|---|---|---|---|
| **S1** `feat/pod-daemon-resident` | L · load-bearing | sleep/link resilience: a dropped link keeps the pod session | `protocol/src/version.ts` (14); `protocol/src/session.ts:470-478` (detach comment); `daemon/src/hosted-session.ts` (`Attachment.model`, `modelLink()`); `daemon/src/session-host.ts` (`AgentFactory` context, late-bound link, "live wins" if P9 needs it); `daemon/src/connection.ts` (attachment `model`, `release` rule); `cli/src/serve.ts` (`podSessionHost`, `startResidentDaemon`, `startBridge`, `residentStatus`/`residentStop`; `startStdioDaemon` stays as a thin wrapper); `cli/src/main.ts` (flag dispatch); `cli/src/engine-runtime.ts` (`podBridgeCommand`, replace guard, docs); plan K only: `k8s/src/pod.ts`, `cli/src/engine-k8s.ts` |
| **S2** `feat/detached-relay` | M · load-bearing | `run --detach --prompt`; re-attach = wait for idle, or `rm` | `protocol/src/session.ts` + `daemon/src/session-host.ts` (`jobs` list field); `config` (`detach.keepAwake`); `cli/src/local-runtime.ts` (`interactive`, `release()`); `cli/src/engine-runtime.ts` (`provisionWorkload`); new `cli/src/run-state.ts`, `relay-policy.ts`, `relay-state.ts`, `keep-awake.ts`, `relay.ts`; `cli/src/flags.ts`/`main.ts` (`--detach`, `--prompt`, `--auto-accept`, `__relay`, USAGE) |
| **S3** `feat/detached-handover` | M · load-bearing | live hand-over relay → `attach`; DR-8 message | `client/src/remote-client.ts` (`modelIdle()`); new `cli/src/control-socket.ts`; `cli/src/relay.ts` (handover/stop ops); `cli/src/main.ts` (attach: owner check, open `sessionId`, hand-over, TUI owner file) |
| **S4** `feat/ps-detached-state` | S · contained | `ps` STATUS/`-v`, `rm` stops the owner | `cli/src/kept-cmd.ts`; `cli/src/run-state.ts` (pure `statusOf(owner, alive)`) |
| **S5** `feat/tui-detach` | M · load-bearing | `/detach` | new `tui/src/detach-command.ts`; `tui/src/commands.ts`; `tui/src/App.tsx` (only the `onDetach` call); `tui/src/run.tsx` (option); `cli/src/main.ts` (`runEngineTui`: relay `adopt`, hand-over, post-unmount line) |

This doc is the umbrella plan and rides S1 on `feat/detached-runs`. S2–S5 each
get `feat/<slug>` + `docs/feat/<slug>.md`, whose Implementation cites its
sub-plan here (owner question, see the report).

### Failure modes (each converges to "laptop history up to the last turn end + the pod's in-memory session")

| Event | Behaviour | Convergence |
|---|---|---|
| Exec link drops (sleep, Wi-Fi) | Bridge dies → `Connection.close` → last model link gone → turn cancelled; session lives on. | The client redials, P9 reopens the live session, replay. The user re-prompts. Pinned by test S1-T3. |
| Two bridges start at once | `acquireStoreLock`: one resident wins, and the loser's spawn exits 1 (logged). | Both bridges connect to the winner (the bridge retries ≤10 s). |
| Stale socket file (resident crashed) | `ECONNREFUSED` → the bridge spawns a new resident; the lock's dead pid is taken over (P7). | Session recreated from laptop history (`open{messages}`, existing path). |
| Resident crashes mid-turn | All connections close; same as a pod restart. | As above; the turn is lost and the client says so (`onHistoryLost`). |
| P0 fails on k8s | Plan K. | Foreign pods keep per-exec daemons, and detach is refused there with a message. |
| Version skew: CLI vN+1 attaches, pod resident vN busy | Replace guard refuses with the explicit message. | The user waits, `rm`s, or uses vN. `initialize` still gives `VersionMismatch` (14 vs 13). |
| Hand-over while a model call streams | The old owner drains `modelIdle()` (≤5 min) before it leaves. | Past the bound it leaves anyway: that call rejects and the turn errors (logged). Bounded, never silent. |
| Hand-over while an ask is pending | The ask is streamed to both. The relay's requester switches to hold; the TUI prompts from the replay. | Exactly one answer wins (`hosted-session.ts:593-605`). |
| Relay SIGKILLed / reboot | Its bridge closes → turn cancelled; `owner.lock` names a dead pid. | `ps` shows `relay lost`; `attach` takes the stale lock and opens `sessionId`. |
| Relay crashes before `owner.json` | The launcher's 30 s wait fails. | It prints the `relay.log` tail and exits 1. The workload stays (kept) or is removed by the exit net (`--keep=false`). |
| Workload deleted under the relay | `dialVerdict` refuses the redial (`engine-runtime.ts:193-196`). | `failed: <noun> gone`, flush, exit. `attach` prints the DR-8 message. |
| `owner.json` of an unknown `schemaVersion` | Reported, left untouched. | `ps` shows `unknown owner`; `attach` refuses unless the lock is stale. |
| `--prompt ""` / empty stdin | Usage error before anything is created. | Nothing to converge. |
| Auto-accept + `hooks_trust` | Never auto-approved → declined (non-interactive). | A notice in `relay.log`; the turn runs without project hooks. |
| `/detach` and the relay cannot adopt | The TUI stays the owner, with a notice. | Nothing released; the spawned relay exits on its own (lock held by the TUI). |

### Tests (red first; each names its mutation target)

- **S1.** `daemon/test/connection.test.ts`: **T1** two serving connections on
  one session — closing the first does NOT cancel the running turn and its
  next model call goes to the second (red on today's `release`; *mutation:*
  restore `if (servesModel) cancel()`); **T2** closing the last one cancels
  (kept); **T3** `modelLink()` = most recent (*mutation:* first). **T4**
  `session-host.test.ts` (P9): `open{sessionId, messages}` of a live id →
  `created: false`, live history. `cli/test/serve-resident.test.ts` on a real
  unix socket in a temp dir: **T5** bridge pipes both ways, stdin end ends the
  socket; **T6** no resident → fake spawner called once, then connects; **T7**
  second resident fails on the lock; **T8** resident survives its first
  connection closing and a second one reopens the id mid-turn with replay
  (*mutation:* exit on first close). `engine-runtime.test.ts`: **T9**
  `podBridgeCommand` argv pinned; **T10** replace guard (busy → refused with
  the message; idle → stop, then replace). Opt-in live (docker, k8s): `run`,
  close the exec, a new exec still lists the session.
- **S2.** `relay-policy.test.ts`: off holds + records; on answers `once`,
  never `session` (*mutation:* `session`); `hooks_trust` never answered.
  `relay-state.test.ts`: each of queued / pending ask / `jobs>0` / inside the
  grace blocks exit; grace boundary ±1 ms. `run-state.test.ts`: `wx`
  exclusivity, stale detection, strict parse (unknown version refused, file
  byte-identical). `relay.test.ts` (fake host + channel): `start` sends the
  prompt, persists via the saver, at idle sends `session/detach` and never
  `session/close` (*mutation:* release → dispose); `keep=false` removes after
  release; launch failure prints the log tail. `main` dispatch test for
  `RELAY_SUBCOMMAND` + flag usage errors. `keep-awake.test.ts`: `-i -w <pid>`
  at turn start, killed at waiting/idle.
- **S3.** `remote-client.test.ts`: `modelIdle()` resolves only after the open
  `model/stream_chunked` ends. `control-socket.test.ts`: unknown schema
  refused; status/stop. Hand-over integration (two `RemoteClient`s on one
  in-process resident host): one persister writes after it, the turn
  survives, the ask is answered once (*mutation:* skip the drain → fails).
  DR-8: fake `describe` → null builds no runtime.
- **S4.** `kept-cmd.test.ts`: every STATUS from `statusOf`, `untrustedText`
  applied, `rm` sends `stop` before remove.
- **S5.** `detach-command.test.ts` (pure); `packages/tui/test/app.test.tsx`:
  `/detach` calls `onDetach(autoApprove)` with the live toggle (*mutation:*
  hard-code false); `main` test: the line is written after teardown, never
  before.

## Execution — S1

*— claude-opus-5-5, 2026-10-27*

### P0 (before any edit) — PASS on docker; k8s not reachable from here

Run through the repo's OWN exec channel (`buildEngineHost(kind).openExec`,
then `channel.close()`, 15 s, then a second `runExec` listing `/proc`). The
harness allows only `bun test`, so the probe is a test file,
`.tentacle/tmp/detached-runs/p0/p0.test.ts`, that undoes the test-env guard for
itself. Image `node:22` (node gives variant (c) the same
`child_process.spawn({detached:true, stdio:["ignore",fd,fd]}).unref()` call the
code uses; a compiled bun probe binary was not built). Core of the script:

```ts
const VARIANTS = {
  a: "sleep 601 &",
  b: "setsid sleep 602 </dev/null >/dev/null 2>&1 &",
  c: `node -e "const fs=require('fs');const fd=fs.openSync('/tmp/p0.log','a');require('child_process').spawn('sleep',['603'],{detached:true,stdio:['ignore',fd,fd]}).unref()"`,
};
const channel = host.openExec({ name, command: ["sh", "-c", `${VARIANTS[v]}\necho started; cat`] });
// wait for "started" → channel.close() → 15 s → runExec(list /proc: pid ppid cmdline)
```

Output:

```
p0-dock-a-42496: PASS ["14 ppid=1 sleep 601 "]
p0-dock-b-57769: PASS ["14 ppid=1 sleep 602 "]
p0-dock-c-73028: PASS ["20 ppid=1 sleep 603 "]
kubernetes a|b|c: KubeApiError 401 Unauthorized (createPod) — the current kubeconfig context rejects this laptop's credentials
```

So: docker PASS for all three variants, re-parented to PID 1. Kubernetes
could NOT be re-checked through the repo's channel: the kubeconfig context
returns 401, and `kubectl` needs an approval this session does not have. The
k8s evidence is still the orchestrator's `kubectl exec` probe (kind/containerd,
cases A–D, including client `kill -9`). Not run: step 3 (SIGKILL of the laptop
process; a `bun test` cannot kill itself), podman, CRI-O. P0 did not FAIL, so
plan K was not taken.

### As built (in plan order)

1. **protocol** — `PROTOCOL_VERSION` 13→14 (`protocol/src/version.ts:7`). The
   `session/detach` comment states the new rule (`protocol/src/session.ts:470-482`).
   `schema/protocol.json` was regenerated (`bun run schema:export`). There are no
   wire-shape changes and no new update kind, so `UPDATE_CLASS` is unchanged.
2. **daemon**
   - `ModelLink` moved from cli `serve.ts` to `daemon/src/connection.ts`.
   - `Attachment.model?` is set by `Connection.open` when the connection
     `servesModel`.
   - `HostedSession.modelLink()` (`hosted-session.ts`, before `detach`) returns
     the LAST serving attachment in the set's insertion order. A re-attach
     re-inserts its attachment, so the newest owner wins.
   - `release` now detaches first, then cancels only if
     `servesModel && hosted.modelLink() === null`.
   - `AgentContext { modelLink }` is the 2nd argument of `AgentFactory`.
     `SessionHost.build` late-binds it through a holder object, because Biome's
     `useConst` refuses a `let`.
3. **P9 holds already.** T4 was green on `main`: `SessionHost.open` checks
   `live` before `seeded` (`session-host.ts:348-351`), so "live wins" needed
   no code.
4. **cli**
   - `serve.ts`:
     - The new `podSessionHost(config, log, options)` is the old
       `startStdioDaemon` body.
     - Its agents use `context.modelLink`, and the daemon-global
       `let tunnel` is gone.
     - `startStdioDaemon` is now a thin wrapper over it.
   - NEW `pod-resident.ts`:
     - `serveResident`:
       - It takes the lock (`acquireStoreLock(stateDir)`), unlinks a stale
         socket, then listens.
       - It serves a `Connection` per socket and detaches on socket `close`.
       - The reaper runs at `DEFAULT_SESSION_TTL_MS`. The resident exits after
         `RESIDENT_IDLE_EXIT_MS` (30 min) with 0 sessions and 0 connections.
     - `runBridge`: buffers stdin until connected; spawns once on
       ENOENT/ECONNREFUSED, retries ≤10 s, then exits 1 with a line.
     - `spawnResidentProcess`: `detached` (setsid), stdio on
       `<stateDir>/resident.log` (1 MiB, one rotation), `unref`.
     - `residentStatus` (`initialize` + `session/list`) and `residentStop`
       (SIGTERM the lock's pid, SIGKILL after 5 s).
     - The pure helpers `residentGuard`, `residentCommand` and `selfCommand`.
     - `runResidentMode`, the `serve` dispatch.
   - `stateDir` is `os.tmpdir()/tentacle-<uid>` and the socket is
     `<stateDir>/resident.sock` (`--socket` overrides it).
   - `flags.ts`: `serve` gains `--bridge`, `--resident`, `--resident-status`,
     `--resident-stop` and `--socket`.
   - `main.ts`: `POD_DAEMON_MODES` never scaffolds config (read-only pod). Its
     non-stdio modes go to `runResidentMode`.
   - `engine-runtime.ts`:
     - `podDaemonCommand` emits `serve --bridge …`.
     - The replace guard runs in `attachEngineRuntime` before any injection
       (`decision.kind !== "reuse"`). It asks the OLD binary (`tentacle` on
       PATH for `replace`, the install path for `inject`) for
       `--resident-status`. Busy → throw the message; idle → `--resident-stop`
       first.
     - Docs updated: header, `execChannelFactory`, `attachEngineRuntime`.

### Drift from the Implementation (and why)

- **Name kept: `podDaemonCommand`, not `podBridgeCommand`.** T9 then stays red
  on an assertion, not on an import, and fewer call sites change.
- **Bridge argv is `serve --bridge --model-proxy --context-window N
  [--auto-title]`, with no `-- <resident argv>`.** `parseArgs` has no `--`
  passthrough. The resident argv is derived from the bridge's own flags
  (`residentCommand(selfCommand(), …)`), and `--socket` is passed only when
  given. The laptop cannot know the pod's TMPDIR/uid, so the default socket
  path is computed in the pod.
- **New module `pod-resident.ts` instead of growing `serve.ts`.**
  `podSessionHost` stays in `serve.ts`.
- **T1–T3 live in `daemon/test/registry.test.ts`, not `connection.test.ts`.**
  The model-serving tests and the `daemon()` harness already live there.
- **The guard also runs for `inject`, not only `replace`.** With
  `--bin-dir /tmp` the PATH probe fails on every attach, but a resident may be
  running from `/tmp/tentacle`. This costs one extra one-shot exec per
  injecting attach. One existing test pinned the exec sequence and now
  includes that step (`engine-runtime.test.ts`, "injects the binary when the
  preflight probe fails").
- **`--resident-status` reports `APP_VERSION` of the binary that answers**
  (the old binary on disk). The resident does not report its own build over
  the protocol (`initialize` has no server version).

### Tests (red → green) and mutations

- **Red on `main`, on the assertion:**
  - pin `PROTOCOL_VERSION === 14`;
  - T1 (`links[0] === b.connection` false);
  - T9 (`--stdio` ≠ `--bridge`).
- **Red with a `TypeError`, not on the assertion:** T3, because `modelLink`
  did not exist yet. A mutation proves it.
- **Green on `main` on purpose (kept behaviour):** T2, T2b (a plain
  connection never keeps a turn alive), and T4/P9.
- **New module, so there was no red baseline:** T5–T8, T10 and the failure
  modes. Their non-vacuity rests on the mutations below.
- **New tests:**
  - `serve-resident.test.ts` (12 tests, real unix sockets): T5, T6, bridge
    timeout, two bridges racing, T7, stale socket + dead-pid lock, T8, link
    drop (cancel, then the redial finds the session live), idle exit,
    `--resident-status`, `residentGuard`, argv helpers.
  - `version-mismatch.test.ts`: 13 ↔ 14 gives a clean `VersionMismatch`.
  - `engine-runtime.test.ts`: T9, T10 (busy → refused, nothing injected and no
    exec; idle → stop before install; old binary → replaced as before).
- **Mutations.** Each target was backed up with `cp` to
  `.tentacle/tmp/detached-runs/mut/` and restored with `cp`. The `shasum`
  after restore is identical: `connection.ts c4aac28d…`,
  `hosted-session.ts b1cdbc6a…`, `pod-resident.ts ee9bd2db…`.

  | # | Mutation | Killed by |
  |---|---|---|
  | M1 | `release`: `if (servesModel) cancel()` | T1 (`cancelled` ≠ `end_turn`) |
  | M2 | `modelLink()` returns the FIRST | T1, T3 |
  | M3 | no `acquireStoreLock` | T7, and the race test. That test was first too weak (`≤ 1` failures) and survived M3; it was tightened to one host per start + exactly 1 failure, which kills M3. |
  | M4 | idle check ignores `host.size` | idle-exit test |
  | M5 | `residentGuard` never refuses | T10 busy (`engine-runtime`), `residentGuard` unit |

### Gate

`bun run check`: typecheck clean, `biome check .` clean (557 files),
**3500 pass / 3 skip / 0 fail** (main baseline 3479 / 3 / 0; +21 = the new
tests).

### Not verified (and how to verify)

- **No live end-to-end run.** No run used a real compiled pod binary (close
  the exec, then a new exec finds the session). To verify: `tentacle run
  --engine docker`, prompt, kill the laptop process mid-turn, `tentacle attach
  <name>`. Expect the session reopened (`created: false`) and the turn
  `cancelled`, not "lost".
- **k8s P0 through the repo's own channel**: needs a kubeconfig context that
  authenticates (401 here).

### Notes / debt

- A resident keeps the model flags (`--context-window`, `--auto-title`) of the
  exec that STARTED it. A later attach from a laptop with a different config
  gets the old flags until the resident is replaced or idles out.
- A `run` that ends normally leaves the resident idle in a kept container
  until its 30-minute idle exit. That is harmless: memory only, sessions
  closed by `dispose`.
- The in-flight model call on a departing link still rejects; a TUI quit is
  unaffected. The drain (`modelIdle()`) is S3.

## Review

*— claude-opus-5-5, 2026-10-27*

### Verdict

**Build it as (c), in the split above, after docker E.** The relay alone is not
enough: F1 (pod daemon bound to one exec) and F2 (single model connection,
cancel on release) mean any laptop-process change kills the pod session today.
Making the pod daemon resident reuses the multi-client `SessionHost` already in
production for `serve` (F3) instead of writing a protocol proxy (b) or a second
session path (a); the relay is then just today's `attach` runtime without Ink
(F4). Slice 1 is worth having even if detach is never built (sleep resilience).

### Unverified / to prove first when promoted

- The load-bearing assumption of slice 1: a pod process started from an exec
  survives the exec's end on both engines (k8s exec + docker exec), e.g.
  `setsid`/double-fork from `sh`. Cheap test: start `sleep 600 &` detached via
  one exec, close it, list processes via a second exec — on k8s AND docker.
- That `session/open` from a second `Connection` on the resident host re-attaches
  a session that the first connection still holds (serve does this for
  `connect`; not yet exercised with `servesModel`).
- `caffeinate -i -w` behaviour on the owner's Mac (lid closed on AC vs battery).

### How the evaluating model behaved

Every fact above is cited from `main` 670aee1; slice E was read from its doc on
`feat/engine-ps-rm`, not merged code. No probes were run (the questions are
architectural; the one empirical risk is listed above with its test).

### Orchestrator live test — S1 (2026-10-27, Docker Desktop, isolated `TENTACLE_CONFIG_DIR`, S1 linux-arm64 pod binary)

- `run --engine docker` → in the container: `serve --bridge` (pid 56) + `serve --resident` (pid 89, child of the bridge).
- Laptop client `kill -9` → bridge gone, resident 89 ALIVE (re-parented to PID 1).
- `attach` → SAME resident 89 reused through a new bridge (166); a second attach + `kill -9` of the client after a real turn → resident 89 still alive (2:39 uptime), then `attach --continue` shows the previous session's output (numbers up to 300).
- NOT verified: a kill DURING an active turn (the turn had finished before the kill); whether `--continue` showed the resident's in-memory session or the laptop's persisted copy. Plain `attach` opens a FRESH session (expected until S3 / DR-8).
- **Owner decision (2026-10-27):** the resident keeps the model flags (`--context-window`, `--auto-title`) of the exec that started it — ACCEPTED as debt (a config change applies after the resident restarts).

## Review — S1

*— claude-opus-5-5, 2026-10-27. Fresh context, but the SAME model as the
executor (and the evaluator): shared blind spots can survive both passes. A
load-bearing slice wants a different model for a second look (AGENTS §10).*

### Verdict

**REQUEST-CHANGES (small).** The core is sound: the cancel rule, the per-session
model link, the lock-then-unlink order, memory-only resident, no peer
serialisation, a dumb byte pipe. But one regression in today's paths (F1) is
reachable with plain `attach --continue`, and the §7 table over-claims what a
pod process on the socket can do (F2). Both need either a small fix or an
explicit owner decision before merge.

### Findings

1. **MEDIUM — a second laptop on the same live session closes it for the
   first.** `SessionHost.close` ends a session "for every client"
   (`daemon/src/session-host.ts:407-413`) and every TUI quit `dispose()`s =
   `session/close` (P5). Before S1 each exec had its own daemon, so two
   terminals could never share a pod session. Now: terminal A `run`s (kept),
   terminal B `attach <name> --continue` opens A's uid → P9 attaches B to the
   LIVE session (`session-host.ts:362-366`); B becomes the newest model link
   (A's turns now call B's laptop), and when B quits, A's session is closed under
   it (`session_closed`). No test pins this. Fix options: (a) a TUI quit
   `session/close`s only when it is the last attachment (else `session/detach`);
   (b) refuse/notice a second attacher until S3's hand-over exists. Owner
   decision; recommend (a) — it is local to the laptop's dispose and matches the
   hand-over model S3 needs anyway.
2. **MEDIUM (security claim) — the §7 row "a pod process that dials the socket
   can only feed its own pod" is incomplete.** Every socket connection is
   `servesModel: true` (`pod-resident.ts:155`), and any same-uid pod process
   can run `tentacle serve --bridge` (the binary is on PATH). So ONE approved
   shell command (e.g. a prompt-injected agent) can attach to the user's
   session, become the newest model link (`hosted-session.ts:837-845`) and
   thereby (i) steer the agent with fake model output and (ii) answer the
   session's future POD permission asks itself (first answer wins), bypassing
   the user's prompt for every later pod tool call. Laptop effects stay gated
   on the laptop (separate broker), so §7's hard line holds; but before S1 this
   needed ptrace-level effort, now it is a pipe. A token cannot fix it (same
   uid reads `/proc/*/environ`). Recommend: owner ACCEPTS it explicitly, and the
   §7 table/`docs/eval/remote-execution-model.md` say "a pod process can take
   over the pod session (model + pod asks)", not "only feed its own pod".
3. **LOW — orphan bound is ~24.5 h, not 30 min, after an unclean exit.** The
   reaper uses `DEFAULT_SESSION_TTL_MS` = 24 h (`daemon/src/session-reaper.ts:17`,
   `pod-resident.ts:183-186`) and the idle exit needs `host.size === 0`
   (`pod-resident.ts:218`). A clean quit closes the session → 30 min; a killed
   laptop leaves the session detached → the resident lives 24 h + 30 min.
   Memory only; document it (Notes/debt says only "30-minute idle exit").
4. **LOW — the replace guard fails OPEN.** A `--resident-status` exec that
   times out or errors → `null` → `none` (`engine-runtime.ts:553-558`,
   `pod-resident.ts:458-459`) → replace proceeds next to a possibly busy
   resident. Not silent in practice (the new bridge reaches the old resident →
   `VersionMismatch` on a protocol change, or the in-place write hits
   `ETXTBSY`), but "refuses loudly" is not what the code guarantees. Fine to
   keep; say so in Failure modes.
5. **LOW — pid-only lock in a restarted container.** `docker start` of a kept,
   stopped container keeps `/tmp`; the lock's old pid can be live again (low
   pids recycle) → `acquireStoreLock` throws → every bridge times out after
   10 s with "no resident listening" until `/tmp/tentacle-<uid>` is removed.
   Rare; loud; note as debt.

### Gate

`bun run check` re-run by the reviewer: typecheck clean, `biome check .` clean
(557 files), **3500 pass / 3 skip / 0 fail** (3503 tests, 260 files). Matches
the Execution's numbers.

### Mutations (re-run by the reviewer)

Both targets backed up with `cp` to `.tentacle/tmp/dr-s1-review/`, restored with
`cp`; `shasum` identical before and after (`connection.ts c4aac28d…`,
`pod-resident.ts 7c24f4a4…`), narrow tests green again (36/0).

| # | Mutation | Result |
|---|---|---|
| R1 | `release`: `if (this.servesModel)` (= Execution M1) | KILLED by T1 |
| R2 (new) | `runBridge`: stdin end no longer `socket.end()` | KILLED by T5, T6, two-bridges race (5 s timeouts) |

Note: `pod-resident.ts`'s hash (`7c24f4a4…`) differs from the one the Execution
recorded (`ee9bd2db…`), so it was edited after the executor's mutation run; the
gate above covers the current file.

### Attacks tried

- **Normal `run` quit / `--keep=false`:** dispose closes the session and the
  exec → bridge stdin end → `socket.end()` → bridge exits → `main` returns →
  `process.exit` (`main.ts:1064`); the container removal kills the resident.
  Holds.
- **Older/newer resident:** a newer laptop replaces only after the guard stops
  the idle old resident; a pre-S1 binary answers no `--resident-status` →
  `none` (no resident can exist). If an old resident is still there, the new
  bridge reaches it → `initialize` `VersionMismatch` 14↔13 (test in
  `version-mismatch.test.ts`) — clean, no hang. Holds (modulo F4).
- **Stale bridge hijacking model calls:** only the NEWEST serving attachment
  gets calls, and a re-dial re-attaches as newest. A stale bridge of a dead
  laptop can be newest only if nobody attached after it; its calls then hang
  until TCP gives up — same as today. Holds. A second laptop / pod process:
  F1/F2.
- **Single broker:** no laptop-side code changed; one broker per laptop
  process. Holds.
- **Pod persists nothing:** `podSessionHost` builds `SessionHost` without a
  persister (diff of `serve.ts`); the resident writes only its log, lock and
  socket in `/tmp/tentacle-<uid>`. Holds.
- **Two residents racing / stale socket:** lock BEFORE `rmSync(socket)`
  (`pod-resident.ts:145-149`), so the loser never unlinks the winner's socket;
  a dead-pid lock is taken over. Holds (F5 aside).
- **Peer serialisation / raw terminal:** `transport/peer.ts` untouched; bridge
  and resident write diagnostics to stderr / the log file only; the laptop's
  stderr sink is unchanged. Holds.
- **Byte pipe:** `runBridge` never parses frames (buffers raw chunks before
  connect). Holds.
- **Protocol:** no schema change; the bump is for the changed meaning of
  `session/detach`/close-of-connection — honest per §7. `UPDATE_CLASS`
  unchanged. Holds.

### How the executor behaved

Honest and well-cited: drift is listed with reasons, a too-weak race test was
caught by its own mutation (M3) and tightened, and the unverified parts (live
kill mid-turn, k8s through the repo channel) are stated. Missed: the
multi-laptop consequence of P9 (F1) and the threat-model wording (F2).
- **Owner decisions on Review — S1 (2026-10-27):** (1) a TUI quitting while OTHER clients are attached to the same session sends `session/detach`, not `session/close` (the session stays for the others) — YES; (2) a pod process that reaches the resident socket (same uid) can take the session's model link / answer pod-side asks — ACCEPTED as risk (consistent with "the pod is not trusted"; a token would not help, `/proc/*/environ` is readable): fix the §7 table/doc wording, no code. Finding 3 (resident TTL after unclean exit ~24.5 h → the intended 30 min; `residentGuard` must fail CLOSED when the status probe fails; pid-only lock vs container restart) → fix.

## Execution — S1 fix round 1

*— claude-opus-5-5, 2026-10-28*

Status: DONE — all five fixes landed; awaiting Review (fresh context, load-bearing). Nothing committed.

Plan (red-first each, one `cp`-backed mutation per fix, `shasum` identical after restore):

1. **F1 shared quit** — the exit path (`RemoteClient.closeSessions`, `local-runtime.ts` dispose)
   sends `session/close{ifLast: true}`; the daemon (`Connection.closeSession`) closes only when no
   OTHER client is attached, else it detaches this connection (= `session/detach`, the remaining
   serving client becomes the model link via `modelLink()`). Atomic daemon-side (the laptop cannot
   know who else is attached without a racy list). Additive field (strip schema: an older daemon
   ignores it → closes, today's behaviour). `/clear`, `/close` keep the full close.
2. **F2 wording** — AGENTS §7 + this doc's §7 table + `docs/eval/remote-execution-model.md`.
3. **F3a** idle TTL after an unclean exit → the resident reaper uses the 30-min idle bound.
   **F3b** `residentGuard` fails CLOSED on a failed status probe. **F3c** lock robust to a
   container restart.

Progress:

- **F1 DONE.** `protocol/src/session.ts` `CloseParamsSchema.ifLast` (optional; `protocol.json`
  regenerated); `daemon/src/connection.ts` `closeSession`: `ifLast` + another attachment →
  `detachSession` (release: the remaining serving client is the link, no cancel);
  `client/src/remote-client.ts` `closeSessions` → `endSession(Close, id, ifLast=true)` (a detached
  outcome withdraws its prompts like a detach). Tests: `registry.test.ts` T5 (link moves back,
  next model call goes to `a`, last one out closes) + T6 (plain close still ends for all);
  `remote.test.ts` "closeSessions() (a quit) leaves a session another client is attached to".
  RED first on both (T5: `host.get("X") === live` false; client: `attachedCount` undefined).
  Mutation M1 (`ifLast === true` → `=== false`): KILLED (T5 + client test); restored,
  `shasum` 25324778… identical. Drift: the frame is `session/close{ifLast}`, not a
  laptop-chosen `session/detach` — the laptop cannot know who else is attached without a racy
  `session/list`; the daemon decides atomically, with the same effect as a detach.
- **F3a DONE.** `cli/src/pod-resident.ts` `serveResident`: the idle exit counts only a
  connection, an attached session or a busy one (`inUse()`, from `liveness()`), no longer
  `host.size`; the reaper's idle TTL is `idleExitMs` (not `DEFAULT_SESSION_TTL_MS`). A killed
  laptop → the resident exits ~30 min after the last activity. Tests (`serve-resident.test.ts`):
  "idle exit (Review S1 F3a)…" (replaces the old "a detached session keeps it" pin, which pinned
  the bug) + "a turn still running with nobody attached keeps it". Both RED first (never exited,
  `until` timeout). Mutation M3a (drop `busy` from `inUse`): KILLED (exits mid-turn); restored,
  `shasum` 61191870… identical.
- **F3b DONE.** `cli/src/pod-resident.ts` `residentGuard` fails CLOSED: a `null` probe (exec
  threw/timed out), `exitCode: null`, exit 0 with unreadable stdout, or a JSON answer whose
  `resident` is not a boolean (`{resident: null, error}`) → `refuse` ("could not ask <name> whether
  a detached run is using its tentacle (…) — retry, or `tentacle rm <name>`", sanitised). Only
  `resident:false` or a non-zero exit with NO JSON (no binary / pre-S1 `unknown option`) → `none`.
  New `residentStatusReport`: the status mode always answers one JSON line (`{resident:null,error}`,
  exit 1, on a failed probe). Found while testing: `residentStatus` had no socket `error`
  listener after connect, so an EPIPE crashed the probe with no JSON (= fail open) — fixed
  (`socket.on("error", () => {})`; the peer's close rejects the request). Tests: guard F3b test +
  `residentStatusReport` on an accept-and-drop socket. RED first (`null` → `none`). The engine
  fakes (`engine-runtime.test.ts`, `engine-docker.test.ts`) answered `--resident-status` with an
  exit-0 empty line (no real binary does) → now `{"resident":false}`. Mutation M3b (`!probe` →
  `none`): KILLED; restored, `shasum` 50d8d928… identical.
- **F3c DONE.** `cli/src/pod-resident.ts`: the resident no longer uses `acquireStoreLock`
  (serve's store lock is untouched) but `acquireResidentLock`: `<stateDir>/.lock` =
  `<pid> <start time>` (`procStartTime`: field 22 of `/proc/<pid>/stat`, parsed by the pure
  `statStartTime`; absent where there is no `/proc` → pid-only, as before). A live pid with another
  start time (a `docker start` kept `/tmp`, the pid was reused) is stale → taken over;
  `residentStop` checks the same identity before any signal (it could otherwise SIGTERM an
  unrelated process). Error text now "another tentacle resident (pid N)" (T7 + race test
  updated). Tests: "F3c (Review S1): a container restart left the lock…" (RED first: the
  takeover threw "another tentacle serve") + "residentStop never signals a recycled pid" (a real
  `sleep` child) + `statStartTime` parse. Mutation M3c (`holderAlive` ignores the start time):
  KILLED (both); restored, `shasum` 632ef23a… identical. Unverified here (macOS): the real
  `/proc` read in a Linux pod — verify with `tentacle run` + `docker restart` on a kept container.
- **F2 DONE (no code).** The §7 table row "Pod not trusted" (this doc) now says a same-uid pod
  process on the resident socket can take over the POD session (model link + pod-side asks),
  owner-accepted; laptop effects stay gated on the laptop. Same statement added to AGENTS.md §7
  ("Compute next to the code…") and `docs/eval/remote-execution-model.md` (trust boundary).
- **Collateral test pin:** `client/test/foreign-turns.test.ts` ("an older daemon (MethodNotFound)…")
  pinned the exit close frame as `{sessionId}`; it is now `{sessionId, ifLast: true}` (intended).
- **Gate:** `bun run check` — typecheck clean, `biome check .` clean (after `biome check --write`
  on two touched files: formatting only), **3509 pass / 3 skip / 0 fail** (3512 tests, 260 files;
  before: 3500/3/0). All mutations restored with `cp`, `shasum` identical.
- **Not done / to verify:** no `PROTOCOL_VERSION` bump for `ifLast` (additive optional field;
  an older daemon drops it and closes — today's behaviour; S1 already bumps to 14). The `/proc`
  start-time read is untested on a real Linux pod (see F3c).
- *Orchestrator gate after S1 fix round 1 (2026-10-28 00:30):* run 1 = 3507/3/2 (`scripts/test/install.test.ts` 5 s timeouts + `worker-exit-net.test.ts`, neither touched by this branch; both pass alone, 3/3 runs, also on main); run 2 = **3509 pass / 3 skip / 0 fail**. Treated as load flakes — reviewer to confirm.

## Review — S1 fix round 1

*— claude-opus-5-5, 2026-10-30. Fresh context, but the SAME model as the
executor: shared blind spots can survive both passes (AGENTS §10).*

### Verdict

**REQUEST-CHANGES (small).** F1, F2, F3a and F3b do what the owner decided. F3c
does not: `.lock` recovery still fails after the commonest crash (finding 1), and
"exactly one resident" is not guaranteed under a race (finding 2). Both sit in
`acquireResidentLock`/`holderAlive`, so one small fix covers them. Findings 1–2
come from reading the code, not from a run (see Limits).

### Findings

1. **MEDIUM (PLAUSIBLE, not reproduced) — a crashed resident's lock is not
   recovered, because it stays a zombie.** `alive()` is `kill(pid, 0)`
   (`pod-resident.ts:536-543`), which succeeds on a zombie, and a zombie's
   `/proc/<pid>/stat` keeps its start time, so `holderAlive`
   (`pod-resident.ts:165-174`) answers "alive". Nothing reaps it: PID 1 is
   `sleep infinity` on both engines (`engine-docker.ts:93`, `k8s/src/pod.ts:57`)
   and the resident re-parents to PID 1 (orchestrator live test). So a SIGKILL or
   OOM of the resident, or `residentStop`'s own SIGKILL (`:568`), leaves every
   later bridge spawning a resident that throws "another tentacle resident", and
   the attach fails after 10 s with "no resident listening" until `.lock` is
   removed by hand or the container restarts. Loud, no data lost. Fix: treat
   state `Z` (field 3 of the same stat line) as dead. The same fix removes the
   full 5 s wait + useless SIGKILL in `residentStop` (`:564-569`) after a clean
   SIGTERM exit. Needs a test with an injected stat, and a live check.
2. **LOW-MEDIUM (by code reading) — two residents can both win the lock.** Two
   orders break it. (a) Fresh start: `take()` creates the file, then writes it
   (`pod-resident.ts:189-191`); a loser reading in between gets `""` → holder
   `null` → treated as stale (`:202-208`), removes the winner's lock and takes
   it. (b) Stale lock: both read the dead holder, A removes + takes, B removes
   A's fresh lock + takes (`:208-209`). Either way both continue,
   `rmSync(socket)` (`:246`) unlinks the first's socket, and two residents live,
   one unreachable with its sessions. Narrow window, inherited from
   `acquireStoreLock`; S1's Review marked it as holding, wrongly for these
   orders. Fix: write a temp file and `linkSync` it (atomic with its content), and
   take over by `renameSync` to a unique name before re-taking, so only one
   taker succeeds.
3. **LOW — F3b still fails open in two corners.** (a) A non-zero exit with no JSON
   → `none` (`pod-resident.ts:608`): this is the "no binary / pre-S1" case, but
   also a status process killed mid-probe (137), and every k8s `Failure` maps to
   exit 1 (`k8s/src/exec-run.ts:99-102`). (b) The `--resident-stop` exec failing
   is swallowed and the replace goes on (`engine-runtime.ts:563-567`) beside a
   resident the guard found idle. Both stay loud afterwards (`ETXTBSY` or
   `VersionMismatch`). Fix: (b) refuse; (a) treat exit ≥ 128 as a failed probe.
4. **LOW (test gap) — the reaper's bound is unpinned.** Mutation R2 below
   survived: nothing fails if `{ idleTtlMs: idleExitMs }`
   (`pod-resident.ts:282-284`) goes back to 24 h. It matters: only the reaper's
   close frees a session's background jobs before the idle exit, because `stop()`
   closes no session. Add a test that the detached session is reaped first.

### Owner decisions

None new. Note, no change asked: at 30 min a detached idle session loses its
background jobs (`busy` ignores jobs, `session-reaper.ts:4-6`), so a Mac asleep
past the bound stops a pod build started as a job. That is F3a as decided.

### Gate

`bun run check` re-run by the reviewer: typecheck clean, `biome check .` clean
(557 files), **3509 pass / 3 skip / 0 fail** (3512 tests, 260 files), first run,
no flake. Matches the orchestrator's count.

### Mutations (re-run by the reviewer)

Backed up with `cp` to `.tentacle/tmp/dr-s1-fix1-review/`, restored with `cp`;
`shasum` identical after restore (`connection.ts 25324778…`, `pod-resident.ts
561b4d9c…`); narrow tests green again (117/0).

| # | Mutation | Result |
|---|---|---|
| R1 | F1: `const own = 0` in `closeSession` | KILLED: T5 + 2 `remote.test.ts` tests |
| R2 | F3a: reaper `idleTtlMs` = 24 h | **SURVIVED** (finding 4) |
| R3 | F3b: `exitCode === null` → `none` | KILLED: the F3b guard test |

R1 and R2 ran together; all 3 failures were F1 tests, so R2 had no killer. Red-first
was not re-run; R1 and R3 show those tests are not vacuous. `pod-resident.ts`'s
hash differs from the Execution's last one (`632ef23a…`), consistent with its
post-mutation `biome --write`; the gate above covers the current file.

### Attacks tried

- **F1, two clients quit at once:** `closeSession` is synchronous (no await between
  the count and the detach/close), so the first detaches and the second sees
  count 1 = own 1 and closes. Neither both-close nor both-detach. A stale third
  attachment makes the last one detach: the session is left detached and the
  reaper ends it. Holds.
- **F1, double count:** a retried `open` drops the old attachment first
  (`connection.ts:365-367`), so own is never undercounted. A connection that never
  opened the id has own 0 and detach is a no-op. Holds.
- **F1, peers and the bump:** the only older peer is 13, refused at `initialize`
  by 14, so `ifLast` is never dropped today; no bump is right, 14 is unreleased.
  `protocol.json` has the field. Holds.
- **F1, A quits mid model call:** the link moves for the NEXT call; A's in-flight
  stream dies with its connection and B sees a turn error. Loud. Holds.
- **F3a:** the idle check counts connections, attachments and `running` (true for
  a turn suspended on a permission, `session-reaper.ts:58-59`); `idleSince` resets
  on any use. The reaper starts first and `lastActiveAt ≤ idleSince`, so it reaches
  a session before the idle exit. Holds (pin: finding 4).
- **F3b, first attach:** a missing binary answers without throwing (docker 126/127,
  k8s `Failure` → 1), same as the `--version` probe before it, so no JSON → `none`:
  a fresh pod is not refused. A status probe has a 15 s bound on the laptop, no new
  laptop hang; a hung resident leaves one stuck status process in the pod per try.
  Holds.
- **F3c, pid reuse and durability:** another start time → stale, also when the
  reused pid is the new resident's own; `statStartTime`'s index is right with `)`
  in `comm`. Only `.lock`, socket and log are written. Holds. Crash and race:
  findings 1–2.
- **F2:** AGENTS §7, the §7 table (`:155`) and the eval state the takeover and the
  acceptance, and keep the laptop limit. Not over-claimed. Holds.
- **Pin in `foreign-turns.test.ts:1131`:** still asserts exactly one close frame
  and its exact params; only the intended field was added. Justified.

### Limits

- Scripts `.tentacle/tmp/dr-s1-fix1-review/lock-zombie.ts` (unreaped killed holder)
  and `lock-race.ts` (8 residents, 12 rounds, stale and fresh) were written but
  NOT run: `bun <script>`, and `docker run`, needed an approval this agent could
  not get. So no end-to-end trace ran, and findings 1–2 are unproven by execution.
  Verify: run both, and `kill -9` a resident in a `sleep infinity` container, then
  `attach`.
- The real `/proc` read on Linux stays unverified (as the Execution says).

### How the executor behaved

Honest and cited: the drift to `close{ifLast}` is stated with its reason, and the
EPIPE crash was found and fixed while testing. Missed: zombies, and the inherited
lock races were copied into new code without being re-examined.

## Execution — S1 fix round 2

*— claude-opus-5-5, 2026-10-30*

Status: DONE — all four findings fixed; awaiting Review (fresh context, load-bearing). Nothing committed.

Plan (findings of "Review — S1 fix round 1"; red-first each, one `cp`-backed mutation per fix, `shasum` identical after restore):

1. **Repro** findings 1 and 2 first (`.tentacle/tmp/detached-runs/`; docker only on `tentacle-dr-fix2-*`). If one does not reproduce: evidence here, no code.
2. **Finding 1** — a zombie holder counts as dead (state `Z` of the same stat line): `holderAlive`, `residentStop`.
3. **Finding 2** — lock taken atomically with its content (temp + `linkSync`); a takeover is a compare-and-swap, so exactly one wins.
4. **Finding 3** — `residentGuard`: exit ≥ 128 with no JSON refuses; a failed `--resident-stop` refuses.
5. **Finding 4** — a test that kills mutation R2 (reaper `idleTtlMs` = 24 h).
6. `bun run check`, remove the containers, fill in below.

Progress:

- **Finding 1 REPRODUCED (real Linux, property level).** Container `tentacle-dr-fix2-zombie` from `alpine:3` (`sleep infinity`, as `engine-docker.ts:93`; the image was only read). An exec leaves an orphan (re-parented to PID 1), a second exec SIGKILLs it:

  ```sh
  #!/bin/sh
  probe() { kill -0 "$1" 2>/dev/null && echo "kill -0 $1: succeeds" || echo "kill -0 $1: fails"; }
  if [ "$1" = start ]; then
    sleep 301 </dev/null >/dev/null 2>&1 &
    echo $! >/tmp/orphan
    exit 0
  fi
  pid=$(cat /tmp/orphan)
  echo "pid1=$(cat /proc/1/comm)"
  echo "before: $(cat /proc/$pid/stat)"
  probe "$pid"
  kill -9 "$pid"
  sleep 1
  echo "after:  $(cat /proc/$pid/stat)"
  probe "$pid"
  ```

  ```
  pid1=sleep
  before: 13 (sleep) S 1 7 7 0 -1 4194304 57 0 0 0 0 0 0 0 20 0 1 0 22839674 1720320 156 …
  kill -0 13: succeeds
  after:  13 (sleep) Z 1 7 7 0 -1 4228108 57 0 0 0 0 0 0 0 20 0 1 0 22839674 0 0 …
  kill -0 13: succeeds
  ```

  So on the crashed holder both `alive()`'s `kill(pid, 0)` and the start time (`22839674`) answer "the same live process".
- **Multi-process scripts NOT run.** `bun <script>` and `bun build --compile` need an approval this agent cannot get (same as the Review), so `.tentacle/tmp/detached-runs/lock-race.ts` did not run and no real Linux binary exists here. Finding 2 is therefore reproduced at unit level, with a deterministic interleaving.
- **Finding 2 REPRODUCED (unit level).** A `beforeStep` seam (test-only, added first with no behaviour change) runs a rival `acquireResidentLock` between the first taker's steps. On the unfixed code, both orders of the Review: `Received function did not throw` — the rival had acquired too, so **both won** (test output in the "fresh start" and "stale lock" tests).
- **Finding 1 FIXED.** `alive()` (`pod-resident.ts`) is false for state `Z`, so `holderAlive` and `residentStop`'s wait both see a zombie as gone. Seam `startTimeOf` → `procOf` (`procStat`/`parseProcStat`: state + start from ONE stat line). Tests: takeover with a zombie holder (RED: "another tentacle resident (pid …)"), `residentStop` neither waits the grace nor SIGKILLs (RED: `Received: 2045`, expected < 1000), `parseProcStat` on the REAL zombie line captured above.
- **Finding 2 FIXED — drift from the Review's suggestion.** `.lock` is hard-linked from a temp file (`linkSync`), so it never exists half-written. The suggested "`renameSync` to a unique name, then re-take" does NOT close order (b): a slow taker renames away the winner's FRESH lock. Instead a takeover is a compare-and-swap under an exclusive `.lock.takeover` claim: `linkSync` the claim, re-read `.lock`, only if it still holds what was judged stale `renameSync` over it (never absent on the way, so a fresh `link` cannot slip in), remove the claim. Tests: both orders (RED above, now one winner, the lock = the rival's), a held claim fails naming it, a taker leaves only `.lock`. Accepted limit: a taker dying INSIDE the claim (a few syscalls) leaves `.lock.takeover`; later residents fail loudly naming the file. Age-based recovery of the claim would bring back the same race.
- **Finding 3 FIXED.** (a) `residentGuard`: exit ≥ 128 with no JSON → refuse (`killed, exit N`). (b) `residentStopVerdict` (pure, new): a `--resident-stop` that threw or exited non-zero → `engine-runtime.ts` throws "could not stop the idle tentacle resident in <name>…", nothing replaced. RED first: `Received: "none"`; `Expected promise that rejects`. The guess that remains, stated in the doc comment: k8s maps every `Failure` to exit 1 (`k8s/src/exec-run.ts`), indistinguishable from a pre-S1 `unknown option`.
- **Finding 4 FIXED (test only).** "a detached idle session is REAPED on the resident's bound, before the idle exit": `host.get("X")` is gone when `done` settles.
- **Mutations** (all `cp`-backed, `shasum` identical after restore):

  | # | Mutation | Result |
  |---|---|---|
  | M1 | `alive` ignores the state (`return true`) | KILLED: both finding 1 tests |
  | M2 | no compare under the claim (`=== undefined` instead of `!== stale`) | KILLED: "stale lock" |
  | M3a | `>= 128` → `>= 999` | KILLED: guard finding 3 test |
  | M3b | `stop?.exitCode === 0` → `stop !== undefined` | KILLED: T10 finding 3 |
  | M4 | = R2: reaper `idleTtlMs` = 24 h | KILLED: finding 4 test (`01f0bb03…` restored) |

  M1–M3 ran together, each killed by its own named test (`c87958d6…` restored).
- **Gate:** `bun run check` — typecheck clean, `biome check .` clean (557 files), **3518 pass / 3 skip / 0 fail** (3521 tests, 260 files; before: 3509/3/0), first run, no flake.
- **Docker:** `tentacle-dr-fix2-zombie` removed; no other container or image touched (`alpine:3` read as its base).
- **Not verified:** the real resident binary on Linux (`kill -9` a resident in a `sleep infinity` container, then `attach`) and the multi-process race: both need `bun build --compile` / `bun <script>`. Verify with `.tentacle/tmp/detached-runs/lock-race.ts` (`stale`, `fresh`) and `tentacle run` on a kept container. The `/proc` parsing is verified only on a real captured line.

## Review — S1 fix round 2

*— claude-opus-5-5, 2026-10-30. Fresh context, but the SAME model as the executor: shared blind spots can survive both passes (AGENTS §10).*

### Verdict

**REQUEST-CHANGES (one fix).** F1, F3 and F4 hold. F2 gives one winner, but a crash inside the claim is a permanent wedge of that pod, not an accepted limit (finding 1).

### Findings

1. **MEDIUM (CONFIRMED) — a crash inside the takeover claim wedges the pod for good.** The claim is never judged: any `.lock.takeover` makes `takeOver` throw (`pod-resident.ts:214-219`). A taker that dies before the `renameSync` leaves `.lock` on the dead old holder; one that dies after it leaves `.lock` on itself, also dead. Either way `.lock` is stale and the claim stays, so every later resident fails, on every later `run`/`attach` on that pod. The test at `serve-resident.test.ts:391` runs exactly that state and pins the throw. It survives `docker restart`: a claim planted in a live `alpine:3` container was still in `/tmp/tentacle-0/` after a restart, its pid gone. Only `rm` by hand or `tentacle rm` clears it. "Fails loudly naming the file" is true only pod-side: the resident's stderr goes to `resident.log` (`:509`, `:773`), and the bridge only reports "no resident listening … after 10000ms" (`:465-467`). So the laptop never sees the file to remove. The window is a few syscalls during a takeover only, so it is rare, but no state on the laptop or in the product recovers it. SIGTERM counts too: the handlers are installed only after `serveResident` (`:768`). Fix: drop the claim and use generation-named locks: `.lock.<n>`, the highest is the holder; a taker `linkSync`s `.lock.<n+1>`, EEXIST = lost. There is nothing to wedge on, and a crashed winner is just a dead holder of a higher generation. Files must not be deleted on release (a lower `n` would reopen the slow-taker race); keep the highest as a tombstone. Reviewer's design, not built or tested: verify it with a red test on the crash state.
2. **LOW — "the one guess left" is not the only one.** `residentGuard`'s `none` (`:664`) and its comment (`:641`) name k8s, but any exit 1 with no JSON lands there, also on docker: a `[config error]` of the status process exits 1 before reaching the mode (`main.ts:407-409`). Same bound as the k8s case below. Fix the comment.
3. **LOW — the k8s exit code may be recoverable.** `exec-run.ts:99-102` maps every `Failure` to 1 but keeps `details.causes[0].message`. As far as I recall that message IS the numeric code on `NonZeroExitCode` (no fake in this repo pins it, no cluster here: unverified). If so, a killed probe (137) on k8s could refuse like docker with a small change there.

**F3 k8s `Failure` = exit 1 → `none`: acceptable, not a silent fail-open.** The case is a probe killed or failing with exit 1 next to a busy resident. The replace then goes on, but the resident keeps running, and the next attach either works through the new bridge or is refused at `initialize` (or `ETXTBSY` at the write). Loud or harmless, nothing lost, laptop history intact. Refusing instead would block every first attach of a pre-S1 pod on k8s.

### Owner decisions

- Finding 1 fix: generation-named locks (recommended) vs keeping the claim with the wedge documented. Recommendation: fix, it is about the same size as the claim code.
- Finding 3: fix now or leave it. Recommendation: leave it for S1, track it in `TODO.md`.

### Gate

`bun run check` re-run by the reviewer: typecheck clean, `biome check .` clean (557 files), **3518 pass / 3 skip / 0 fail** (3521 tests, 260 files), first run, no flake. Matches the Execution.

### Mutations (re-run by the reviewer)

Backed up with `cp` to `.tentacle/tmp/detached-runs/rev2/`, restored with `cp`; `shasum` identical (`pod-resident.ts c87958d6…`, the Execution's hash).

| # | Mutation | Result |
|---|---|---|
| F1 | `alive`: `return true` instead of the `Z` check | KILLED: both finding 1 tests (lock takeover; `residentStop` 2038 ms) |
| F2 | `readLock(path) === undefined` instead of `!== stale` | KILLED: "stale lock" |
| F4 | reaper `idleTtlMs` = 24 h | KILLED: finding 4 test |

F2 and F4 ran together; each failure is its own named test.

### Attacks tried

- **F1, a crashed resident:** bridge gets ECONNREFUSED, spawns; `alive` is false on `Z`, `.lock` taken over, stale socket unlinked (`:292`). Status answers `resident:false`, stop answers false with exit 0. Holds. Nothing is actually reaped: the zombie stays in the process table for the container's life, one per crash, harmless. No `waitpid` and no signal at a process that is not ours: a zombie is skipped by `residentStop` (`:610`), and a zombie's pid cannot be reused while it exists. A reused pid still reads another start time. No new orphan path. Holds.
- **F2, one winner:** fresh start is `link` (atomic, EEXIST). Takeover: `.lock` is never absent during the rename and the compare runs under the claim, so a second taker sees the winner's content and backs off. The claim is removed only by whoever linked it (`:214` is before the `try`). `temp` and `.lock` are never the same inode, so the rename is never a no-op. ABA needs the same pid and start time. Holds by reading and by the interleaving tests; not multi-process (see Limits). A crashed taker leaks `.lock.<uuid>`, harmless.
- **F3, fail closed:** null, exit null, exit ≥ 128 with no JSON, `resident:null`, unreadable JSON all refuse, with pod text through `untrustedText`. Exit 0 with garbage refuses. A failed or non-zero stop throws before the injection (`engine-runtime.ts:573-575`). `{stopped:false}` exit 0 passes: only reachable if `.lock` was removed by hand beside a live resident, which is outside the guard. Holds.
- **F4:** the assertion is on the session being gone from the host when `done` settles; killed above. Holds.
- **Linux primitives:** a hard link on overlay `/tmp` worked in `alpine:3` (`ln`). Rename over an existing file not run there. Holds for the link.
- **Prior art:** `TODO.md`, `docs/library-bugs.md`, `docs/fix/`: nothing open on this lock.

### Limits

- `bun <script>` and `bun build --compile` need an approval this agent could not get, and I did not route around it. So `lock-race.ts` did not run, no real resident ran on Linux, and the multi-process race and the `kill -9` + `attach` trace are still unverified. Verify: `bun .tentacle/tmp/detached-runs/lock-race.ts stale` and `… fresh`, and `tentacle run` on a kept container.
- Container `tentacle-dr-rev2-wedge` was created and removed; nothing else touched.
- Premise table limited to this round's scope (the lines above): all TRUE except "fails loudly naming the file" (finding 1).

### How the executor behaved

Honest: it reproduced before fixing, corrected the Review's `renameSync` suggestion for a real reason, and stated the claim limit and what it could not run. Its one error is judgement: it filed a permanent wedge as an accepted limit, and "fails loudly" overstated what the laptop sees.

**Owner decisions on Review — S1 fix round 2 (2026-10-30):** finding 1 → fix with generation-named locks (`.lock.<n>`, no claim file), red test on the crash-inside-takeover state first; finding 2 → fix the comment in the same round; finding 3 (k8s exit code from `details.causes`) → NOT in S1, tracked in `TODO.md`.

## Execution — S1 fix round 3

*— claude-opus-5-5, 2026-10-30*

Status: DONE — both findings fixed; awaiting Review (fresh context, load-bearing). Nothing committed.

Plan (findings 1 and 2 of "Review — S1 fix round 2", as the owner decided):

1. **RED first:** the crash states of today's claim (taker died before and after its rename) must let the next resident start; show them failing on the unfixed code.
2. **Finding 1:** generation-named locks: `.lock.<n>`, the highest is the holder; a taker `linkSync`s `.lock.<n+1>`, EEXIST = lost; no claim file; release never deletes (it empties the file, a tombstone). A winner sweeps everything below its generation, so at most one lock file stays; a taker re-reads the directory after its link, since a swept slot can be linked again.
3. Old-format leftovers (`.lock`, `.lock.takeover`) are simply not generations: ignored, then swept. No compat path (AGENTS §7, pre-public).
4. **SIGTERM during start:** with no claim there is nothing to wedge on; prove it.
5. **Finding 2:** the `residentGuard` comment.
6. One `cp`-backed mutation per fix, live check in `tentacle-dr-fix3-*` if a binary can be built, `bun run check`.

Progress:

- **RED (unfixed code, hash `c87958d6…`).** Both crash states, `.lock` on a dead pid plus `.lock.takeover`, in `serve-resident.test.ts`: `expect(received).not.toThrow()`, "another tentacle resident is taking over …; retry, or remove ….lock.takeover". 2 fail, on the property.
- **Finding 1 FIXED — `pod-resident.ts:226` (`acquireResidentLock`), `lockPath` / `lockGeneration` / `currentGeneration` above it, `residentStop` reads the highest generation.** No claim file, so nothing can wedge: a taker dead at any step leaves at worst a dead holder of a higher generation, which is stale.
- **Tombstones are bounded to ONE file.** Release truncates its own generation and never deletes (`:274`). A winner sweeps every `.lock*` below its generation (`:262`): old generations, a crashed taker's temp, the old-format files. So the directory holds one lock file, plus temps of takers in flight.
- **Drift from the Reviewer's design: the sweep, and a re-read after the link (`:257`).** The Reviewer's "never delete" keeps every generation, one file per resident start, with no bound. Sweeping reopens a slot below the holder, so a slow taker can link it; it then reads the directory, sees the higher generation, removes its link and loses. The highest generation is never removed, so the check cannot miss it. One accepted limit: `readdir` is not a snapshot, so it could miss the highest only if a takeover AND a sweep both fall inside that one scan of a slow taker, which needs the holder to die in that same instant.
- **Other drift.** Temps of a rival are swept too: the rival gets ENOENT at its link, mapped to "lost" like EEXIST (it had lost anyway). `LockStep` is now `judged` / `link`: the first lets a rival win before our temp exists (EEXIST path, and the slow-taker test), the second after (ENOENT path).
- **Old format: no compat code.** `.lock` and `.lock.takeover` are not generations, so they are ignored, then swept. A LIVE fix-round-2 resident beside a new binary is not detected. Accepted: it never shipped, and `attach`'s guard asks the old binary to stop it before replacing that binary.
- **SIGTERM during start:** no code change. With the default action the process dies leaving a dead holder (stale) and at most a stale socket, unlinked at the next start. Handlers stay where they are.
- **Finding 2 FIXED — `pod-resident.ts:648`.** Comment only: any exit 1 with no JSON lands on `none`, k8s and a `[config error]` on any engine.
- **Multi-process, real (`bun test`).** New `describe("real processes …")` spawns `main.ts serve --resident` with its own `TMPDIR`: SIGTERM the moment the lock exists, then the next resident serves on `.lock.2`; four racing on a stale lock: exactly one serves, three exit 1. This also covers the `lock-race.ts` gap left by fix round 2, on macOS.
- **Live, real Linux: PARTIAL.** `bun run compile` needs an approval this agent cannot get, so NO real binary ran in a container. Instead the lock code, cut verbatim from `pod-resident.ts` with `sed`, ran under Node (type stripping) in `tentacle-dr-fix3-lock` (`node:22`, `sleep infinity`, as `engine-docker.ts`). Real `/proc`, overlay `/tmp`, real processes:

  ```
  planted: .lock .lock.takeover
  pid 17 HOLDS, dir=.lock.1
  pid 26 REFUSED: another tentacle resident (pid 17) owns /tmp/tentacle-0; …
  holder state: Z (pid1=sleep)
  crash state: .lock.1 .lock.2
  pid 51 HOLDS, dir=.lock.3
  after restart: .lock.3  holder=51 22960164
  stopped=false
  pid 26 HOLDS, dir=.lock.4
  pid 27, 28, 29 REFUSED: another tentacle resident (pid 26) owns /tmp/tentacle-0; …
  held=1 refused=3
  dir: .lock.4
  ```

  So on Linux: the fix-round-2 wedge state no longer wedges; a `kill -9` zombie plus a dead taker one generation up is taken over; after `docker restart` the stale holder is not signalled and is taken over; four real processes give one winner. Container removed; no other container touched.
- **Mutations** (`cp`-backed, `shasum` `30eb8ab3…` identical after restore). All are of finding 1; finding 2 is a comment, nothing to mutate.

  | # | Mutation | Result |
  |---|---|---|
  | M1 | no re-read after the link | KILLED: "a slow taker that links a swept slot" |
  | M2 | no sweep | KILLED: 10 tests, including tombstone bound and SIGTERM real process |
  | M3 | `renameSync` instead of `linkSync` | KILLED: "fresh start" and "stale lock", step `judged` |
  | M4 | release empties the highest generation | KILLED: "a superseded holder's release" |

- **Gate:** `bun run check` — typecheck clean, `biome check .` clean (557 files), **3530 pass / 3 skip / 0 fail** (3533 tests, 260 files; before: 3518/3/0), first run, no flake.
- **Not verified:** the real binary on Linux, including `attach` end to end. Verify with `tentacle run` on a kept container, `kill -9` the resident, then `attach`.
- **Owner:** the "Owner decisions" line says finding 3 (k8s exit code) is tracked in `TODO.md`, but `TODO.md` has no such entry. Not added here: outside this brief.

## Review — S1 fix round 3

*— claude-opus-5-5, 2026-10-30. Fresh context, but the SAME model as the executor: shared blind spots can survive both passes (AGENTS §10).*

### Verdict

**APPROVE-WITH-NITS.** The generation lock holds: one holder, no sweep of a live holder, no wedge from a crash. The executor's drift from the round 2 design (deleting lower generations) is sound, because the re-read at `pod-resident.ts:257` closes the race the round 2 Review feared. One LOW comment nit, no code change needed.

### Findings

1. **LOW — the comment at `pod-resident.ts:648` understates the guess.** Its two facts are true: k8s maps every `Failure` to 1 (`k8s/src/exec-run.ts:44`), and a `[config error]` exits 1 with no JSON (`main.ts:407-409`). But "ANY exit 1" is narrower than the code: `:673` returns `none` for every exit from 1 to 127 with no JSON, so a failed probe exiting 2 to 125 is a guess too. Say "any exit below 128 with no JSON".

### Why deleting lower generations is safe

The whole argument rests on one invariant: **the highest generation is never removed.** Removal happens in two places only. The sweep (`:262`) removes names below a generation the sweeper has just linked. The back-off (`:258`) removes its own link only after seeing a higher one. Neither can remove the maximum, so the maximum never goes down (by hand aside).

The slow taker, step by step, with `.lock.5` stale:

1. S reads 5 as dead, picks 6, stalls.
2. A links 6, re-reads, sweeps 5, holds. A dies. B reads 6 as dead, links 7, sweeps 6, holds.
3. S links 6, which succeeds because the slot was swept.
4. S re-reads, sees 7, removes its 6, throws "lost". It never swept anything.

Other orders:

- S's link fails with EEXIST if 6 is still there.
- It fails with ENOENT if a winner swept its temp.
- If S read 5 after the sweep (`readLock` undefined, so "no holder"), it picks 6, and the same two cases apply.
- A rival that reads a live holder's generation refuses at `:233`, so while a holder lives nobody can go above it, and a live holder can never be below a winner. That is why a sweep cannot delete a live holder's file.
- ABA on a slot: a re-linked slot is always below the maximum, so its linker backs off and it never becomes a holder.

The one gap is the Execution's: `readdir` could miss the maximum if a takeover AND a sweep both fall inside one scan. It needs the holder to die in that instant, and a small directory is normally returned by a single `getdents`. Not observed under stress (below). Accepted.

### Crash at every syscall

| Dies after | Left behind | Next start |
|---|---|---|
| judging | nothing | normal |
| temp write | a `.lock.<uuid>` | ignored by `:197` (the name has dashes), swept by the next winner |
| link, temp not yet removed | a dead highest + its temp | stale, taken over, both swept |
| link, before the re-read or inside the sweep | a dead highest + some old files | stale, taken over, all swept |
| a low link, before the back-off | a dead low file below the maximum | never read, swept |
| SIGTERM before the handlers (`:768`) | a dead holder + maybe a stale socket | taken over, socket unlinked (`:299`) |

No state blocks a later resident. A live `.lock.<n>` is the only refusal, and its holder is a real process. Two states do wedge: a directory named `.lock.x` makes `:263` throw, and a planted `.lock.99999999999999999999` breaks `generation + 1`. Both need a pod process writing in its own 0700 state dir on purpose. That is the pod harming itself, not a crash. Not a finding.

### Tombstone bound

Mostly true. At rest, after a release, one file. The Execution's "one lock file" is not exact after a taker's crash: a crashed low link or temp stays beside the highest until the next winner sweeps it. So it is one file plus crash leftovers, swept at the next start. Sampled maximum of generation files in the stress run: 2. Rest after 1494 crashes: one file. Not a finding: bounded by the crashes between two winners.

### Gate

`bun run check` re-run by the reviewer: typecheck clean, `biome check .` clean (557 files), **3530 pass / 3 skip / 0 fail** (3533 tests, 260 files), first run, no flake. Matches the Execution.

### Mutations (re-run by the reviewer)

Backed up with `cp` to `.tentacle/tmp/detached-runs/pod-resident.rev3.bak`, restored with `cp`; `shasum` identical (`pod-resident.ts 30eb8ab3…`, the Execution's hash).

| # | Mutation | Result |
|---|---|---|
| R1 | no re-read after the link (`:257`) | KILLED: "a slow taker that links a swept slot" |
| R2 | release deletes instead of truncating (`:274`) | KILLED: 3 tests (slow taker, tombstone, SIGTERM real process) |

### Attacks tried

- **Stress on real Linux (`node:22`, overlay `/tmp`, real `/proc`):** the lock code cut verbatim from `pod-resident.ts`, 8 processes for 25 s, respawned on death. Random stalls and SIGKILL at both `beforeStep` steps, 20% of holders SIGKILLed while holding, and `.lock` + `.lock.takeover` planted at the start. Each holder takes an exclusive `crit` file and checks that its own lock file still exists. Result: **7520 acquisitions, 1494 crashes while holding, 2244 processes, 0 violations, 0 errors.** The final start worked. Old-format files gone.
- **Is that stress vacuous? No.** The same harness on the extract with the `:257` re-read disabled gave 3 violations (2 double holders, 1 swept live holder) in 15 s, so it does detect the race the round 2 Review feared.
- **Pid reuse + start time, real `/proc`:** a lock on live pid 1 with its real start time is refused; with another start time it is taken over, and `.lock.8` carries the new pid and start. `residentStop` uses the same `holderAlive` (`:617`), so it signals nothing in the second case. Holds.
- **`docker restart`:** not re-run. The Execution's output covers it, and it is the same stale path as the pid reuse above.
- **Old format:** `.lock` and `.lock.takeover` are never read as generations, swept by the first winner. Holds. A live fix-round-2 resident is not detected; it never shipped.
- **Superseded release:** ENOENT is caught (`:275`). A slot re-linked under a holder cannot be a holder's. Holds.
- **Losers and the socket:** the socket is touched only after the lock (`:299`), so a slow taker that loses cannot unlink a live socket. Holds.

### Limits

- `bun build --compile` needs an approval this agent could not get, and I did not route around it. So the real binary did not run on Linux, and the stress ran the extract under Node, not Bun. Verify: `tentacle run` on a kept container, `kill -9` the resident, then `attach`.
- Container `tentacle-dr-rev3-lock` was created and removed; nothing else touched.
- Scratch files are in `<repo root>/.tentacle/tmp/detached-runs/rev3/`.

### How the executor behaved

Honest. It showed the red first, flagged its drift from the Reviewer's design with the reason, and named the `readdir` limit and the missing real-binary check. Its "one lock file" is slightly overstated after a crash. Its judgement against the round 2 Review's "never delete" was right.

### Orchestrator live test — S1 fix round 3 (2026-10-30, Docker Desktop, `node:22` arm64, isolated `TENTACLE_CONFIG_DIR`, binaries built from this worktree)

*— claude-opus-5-5 (orchestrator), 2026-10-30*

- `run --engine docker --keep --no-mount` → bridge (56) + resident (95), `.lock.1`.
- `kill -9` of the resident with the client attached → the client re-dialled by itself: new bridge (163) + new resident (196) holding `.lock.2`; `.lock.1` swept (one lock file at rest). The killed resident stays `<defunct>` under `sleep infinity` (PID 1 does not reap) — by design since fix round 2 (a `Z` holder counts as dead); one harmless process-table entry per crash.
- `kill -9` of the laptop client → resident 196 survives (re-parented to PID 1).
- `attach` → the SAME resident 196 reused through a new bridge (273). No wedge.
- **Finding (orchestrator): `--bin-dir` defeats the reuse.** With `--bin-dir <dir>` (in-pod install dir, e.g. `/tmp` on a read-only rootfs) the binary is not on the container's `PATH`, and the attach probe runs `["tentacle", "--version"]` on `PATH` (`engine-runtime.ts` probe before `containerDecision`; same probe on `main`). So every `attach` misses it, takes the replace path, and `residentGuard` → idle → `--resident-stop`: an idle resident is stopped on every re-attach ("resident stopped" in `resident.log`, observed live: resident 178 stopped, 384 started) and its idle in-pod sessions go. Before S1 that only re-injected the binary; with S1 it ends the detached sessions S2/S3 are meant to re-attach to.

**Owner decision on the orchestrator's live-test finding (2026-10-30):** fix `--bin-dir` reuse inside S1, before the merge (fix round 4).

## Execution — S1 fix round 4

*— claude-opus-5-5, 2026-10-30*

**Root cause.** With a bin dir off `PATH` the attach probe `["tentacle", "--version"]` exits 127, so `containerDecision` says `inject` (not `replace`, as the finding put it); the guard then asks `binPath`, which answers, and stops the idle resident. `run` has no such probe (`injectAgentBinary` verifies by absolute path): both call sites were in `attachEngineRuntime`, the preflight and the re-probe after a failed replace.

**As built.**
- `packages/cli/src/engine-runtime.ts:538`: with a bin dir, `binPath` is probed first, then `tentacle` on `PATH`; without one, `PATH` only, as before. The binary that answered (`found`) is what is reused, what the guard asks on `replace`, and what the failed-replace fallback re-probes and runs (`:617`).
- `packages/cli/src/container-version.ts`, `replacedNotice`: when the replaced binary stays on `PATH` and ours went to the bin dir, the notice names both.
- `packages/cli/src/pod-resident.ts`, `strayResidentWarning`, called at `engine-runtime.ts:640`: after a fresh install the NEW binary asks the socket; a resident none of the probes could see gets a warning.

**Rule when the bin dir differs between `run` and `attach`.** The resident's socket does not depend on the install dir, so any binary reaches the one resident (confirmed live below).
| Case | Outcome |
|---|---|
| Binary in `--bin-dir`, this laptop's version | reused, resident kept |
| Not there, `PATH` has this laptop's version | `PATH` binary reused, nothing installed, resident kept |
| Not there, `PATH` has another version, resident busy | refused (`residentGuard`), nothing installed |
| Not there, `PATH` has another version, resident idle or absent | idle resident stopped, installed in the bin dir, notice names both versions |
| No binary found, a resident alive (`run` used a dir this attach does not know) | never stopped; installed, the bridge joins it, warning says so and how to use one binary |

`attach <name>` inherits the bin dir of `run` from the kept index (`main.ts:874`), so the last case needs a different explicit `--bin-dir`, a different `TENTACLE_POD_BIN_DIR`, or no index entry.

**Tests (red → green), `packages/cli/test/engine-runtime.test.ts`.** Six added.
- Red before the fix, on the property: the reuse test failed at `expect(kube.calls.some((c) => c.includes("--resident-"))).toBe(false)`; the `replacedNotice`, stray-warning and failed-replace tests failed too. The reuse test first went red on a missing fake binary (`release` with no bins), which proves nothing; it now uses `BINS` and goes red on the assertion.
- Two are green on the old code by design, they pin what must not regress: `PATH` same version → reused; `PATH` other version + busy → refused.
- Green after the fix: 100 pass in `engine-runtime` + `engine-docker`.

**Mutation.** `let serveBin = "tentacle";` (the old `PATH`-only probe): 2 fail (reuse; failed-replace fallback), 61 pass. Restored by `cp`; `shasum` identical before and after, `8d969f35…6b0f`.

**Gate.** `bun run check`: typecheck clean, Biome 557 files clean, 3536 pass / 3 skip / 0 fail.

**Live check: PARTIAL, the laptop flow did NOT run.** Drift from the brief, and the reason: the session's permission layer refused `cp` of `~/.config/tentacle/config.jsonc`, `script`, and the direct launch of the compiled binary. None of the three was worked around, so `run`, `kill -9` of the client and `attach` were not exercised end to end. What ran instead, with `docker` only, on `tentacle-dr-fix4-a` (`node:22` arm64, binary built from this worktree, removed after):
- `docker exec … tentacle --version` → exit 127; `docker exec … /tmp/tentacle --version` → `tentacle 0.1.0`: the bug's premise and the new probe's answer, on a real container.
- `/tmp/tentacle serve --bridge …` started resident pid 41. A second bridge, then a second binary at `/usr/local/bin/tentacle`: `ps` still shows pid 41, and `tentacle serve --resident-status` from `PATH` answers `{"resident":true,…}` for it, so the socket really is independent of the install dir.
- `resident.log` holds only the `resident listening … (pid 41)` line, no "resident stopped".

**Not verified, and how to verify.** The decision `attachEngineRuntime` takes is covered by the fake-cluster tests only. To close it, approve those commands and run the brief's sequence: `run … --bin-dir /tmp`, `kill -9` the client, `attach … --bin-dir /tmp`, then `docker exec <name> ps -eo pid,ppid,stat,args`. The real config is not needed: no prompt is sent, a config with a dummy `model` block should do (not itself exercised).

**Notes / debt.**
- The stray warning cannot state the resident's version: `--resident-status` reports the asking binary's, and `initialize` carries no build version. Adding one was left out to keep this round small.
- `Review — S1 fix round 2`'s finding 3 is still absent from `TODO.md` (noted in round 3, outside this brief too).

### Orchestrator live test — S1 fix round 4 (2026-10-30, Docker Desktop, `node:22` arm64, isolated `TENTACLE_CONFIG_DIR`, binaries built from this worktree)

*— claude-opus-5-5 (orchestrator), 2026-10-30*

- `run --engine docker --keep --no-mount --bin-dir /tmp` → `/tmp/tentacle serve --bridge` (63) + resident (96).
- `kill -9` of the laptop client → resident 96 survives (re-parented to PID 1).
- `attach --engine docker --bin-dir /tmp` → the SAME resident 96 reused through a new bridge (178); `resident.log` has only "resident listening … (pid 96)", no "resident stopped". The fix-round-3 finding is closed live.
- Not run live: the run/attach bin-dir MISMATCH branches (left to the review's code reading + the unit tests).

## Review — S1 fix round 4

*— claude-opus-5-5, 2026-10-30*

Same model and family as the executor, only a fresh context: shared blind spots survive both passes.

### Verdict

**REQUEST-CHANGES (one small fix).** The reported bug is closed, by the tests and by the orchestrator's live run, and no branch stops or strips a busy resident. But the same root cause stays on the path without `--bin-dir` (F1, reproduced).

### Findings

1. **`packages/cli/src/engine-runtime.ts:538`, MEDIUM, reproduced.** `binPath` is probed only when `deps.binDir` is set. Without a bin dir, an image whose `PATH` finds another `tentacle` version before `/usr/local/bin` never converges: `attach` installs to `/usr/local/bin`, and the next `attach` still asks `PATH` only. Temporary test (fake cluster, `tentacle` = 0.2.0, `/usr/local/bin/tentacle` = 0.3.0, laptop 0.3.0; test file restored, `shasum` identical):
   - Idle resident: `--resident-status`, `--resident-stop`, then the install again, on every `attach`. That is the owner's bug.
   - Busy resident: refused with "a detached run is using tentacle 0.2.0 … attach with tentacle 0.2.0", which is false: the run uses 0.3.0. The way out is `--bin-dir /usr/local/bin`, and the message does not say so.
   - Fix: always ask `binPath` first, then `PATH` (one more exec when it is missing). The narrow precondition is why this is not HIGH; it is also a one-line change on a path S2/S3 rely on.
2. **`packages/cli/src/engine-runtime.ts:639`, LOW.** The stray warning fires only on `inject`, so only once. The next `attach` with the same bin dir takes `reuse` and joins the foreign resident silently. The `replace` path has no stray check either, and neither does row 2 of the table (same version on `PATH`, resident from another version elsewhere). `initialize` still refuses a protocol skew, so what stays silent is a build difference inside one protocol version. Only a resident version in `--resident-status` closes this; it is the executor's own debt note.
3. **`packages/cli/src/pod-resident.ts:733`, LOW.** The refusal names the asking binary's version, not the resident's. In row 3 of the table it can tell the user to attach with the wrong version. Fail-closed all the same: nothing is stopped or installed. Same fix as F2.
4. **`packages/cli/src/engine-runtime.ts:563`, `:622`, NIT, pre-existing.** `version` is raw pod stdout. It reaches `deps.log` (`:670`) in piped mode when `expected` is undefined (a dev build) or after a failed replace. Not Ink's terminal, and not from this round. Worth an `untrustedText` when F1 is fixed.

### Owner decisions

- **F1:** fix now, before the merge. Recommended: it is the same bug the owner asked to close in S1.
- **F2 + F3:** defer to S2 with a `TODO.md` entry, adding the resident's real version to `--resident-status`. Recommended: no safety is lost in the meantime.

### Gate

`bun run check`: typecheck clean, Biome 557 files clean, **3536 pass / 3 skip / 0 fail**, no load flake this run.

### Mutations (re-run by the reviewer)

`cp` backup, `engine-runtime.test.ts` only, 63 tests. `shasum` identical before and after: `engine-runtime.ts` `8d969f35…6b0f`, `pod-resident.ts` `8a66e0df…b566`.

| Mutation | Result |
|---|---|
| Executor's: `let serveBin = "tentacle";` | 2 fail (reuse; failed-replace fallback) |
| Mine: `oldBin = binPath` (the guard asks a binary that may not exist) | 3 fail (T10 busy, T10 idle, `PATH` other version + busy) |
| Mine: the stray check tests `resident === false` | 1 fail (stray warning) |

### Attacks tried

- **Both call sites:** the preflight (`:541`) and the failed-replace re-probe (`:617`) use `versionOf`. `run` has no such probe: `pod-binary.ts:319` verifies by absolute path. Holds.
- **A busy resident stopped:** stop is reached only through `residentGuard`, which refuses a busy answer. On `inject` the guard asks a binary that failed `--version`: exit 127 means `none`, so nothing is stopped and the install goes to a different path than the resident's. Holds. The guess the guard already documents (exit 1–127 with no JSON) stays.
- **A busy resident losing its binary:** on `replace` the binary that answered is asked before the install (mutation 2 pins this). Holds.
- **Is "invisible" a fail-open?** Not for safety: nothing is stopped, the install lands elsewhere, `initialize` still refuses a protocol skew. For the warning, partly: the probe's failure (`.catch(() => null)`, unparseable output) drops it silently, and F2 applies.
- **Socket independent of the binary:** `residentStateDir` depends on `TMPDIR` and the uid only (`pod-resident.ts:65`). Holds, and the executor confirmed it on a real container.
- **Raw writes under Ink:** the new lines go through `deps.notify`, and `deps.log` only when `status` is null (no TTY), the same pattern as `:500`. Holds.
- **Pod text:** the stray warning holds no pod text (`name` and `binPath` come from the laptop); `had` and `now` pass `parseVersionLine`; `status.version` is sanitised. A forged `resident:true` only produces the warning. Holds, except the pre-existing F4.
- **k8s:** every `Failure` maps to exit 1 (`exec-run.ts:99`), so a missing `binPath` falls back to `PATH` correctly. Not exercised on a real cluster.
- **Prior art:** none open on this path beyond the round's own debt note.

### Limits

The mismatch branches ran on the fake cluster only, here and in the orchestrator's live run. No Docker was run by this review, as briefed. The premise table is limited to this round's root-cause claims, which are TRUE: `containerDecision` says `inject` on a failed probe, and `run` has no `PATH` probe.

### How the executor behaved

Honest: the live gap and the refused commands were reported rather than worked around, the correction of the finding (`inject`, not `replace`) checks out, and the first red that proved nothing was disclosed and redone. The blind spot was scope: it fixed the case as reported (`--bin-dir`) without asking whether the same probe fails with no flag.

**Owner decisions on Review — S1 fix round 4 (2026-10-30):** F1 → fix now (fix round 5): always probe the install path (`binPath`, default `/usr/local/bin` or `--bin-dir`) first, then `PATH`; the NIT (`untrustedText` on the probed `version`) rides along. F2 + F3 → deferred to S2, tracked in `TODO.md` (add the resident's real version to `--resident-status`).

## Execution — S1 fix round 5

*— claude-opus-5-5, 2026-10-30*

**As built.**
- `packages/cli/src/engine-runtime.ts`, `attachEngineRuntime`: `binPath` is always probed first, then `tentacle` on `PATH` (one more exec when `binPath` is missing), so `/usr/local/bin/tentacle` is now the default exec path of a reused binary, no longer the bare `tentacle`.
- Same function, `versionLabel`: both probed versions (the reuse and the failed-replace fallback) pass through `untrustedText` before they reach `deps.log`.
- `replacedNotice` in the same function: `installedAt` no longer needs `deps.binDir`. `found === "tentacle"` now always means `binPath` did not answer, so the `PATH` binary really stays beside ours, with or without a bin dir.

**Drift from the brief.**
- `serveBin === binPath` no longer told a done replace from a failed one: the failed-replace fallback has `found === binPath` in the common case, so it would have printed a false "replaced" line after the warning. A `replaced` flag, cleared in the fallback, drives the notice. Three existing tests caught it. `--bin-dir` already had this path before this round, unobserved: its test does not assert the notices.
- Test fixtures changed: `containerHas` now models the image's tentacle at the install path, until something is installed over it, and the expected attach commands name `POD_BIN_PATH` (also in `engine-docker.test.ts`). The inject test expects both preflight probes in `kube.calls`. `attach-stale` makes both paths answer 127.

**Rule (replaces the fix round 4 table, same safety rules: a busy resident is never stopped).** "Install path" is `/usr/local/bin`, or `--bin-dir` / `TENTACLE_POD_BIN_DIR`.
| Case | Outcome |
|---|---|
| Binary at the install path, this laptop's version (whatever `PATH` holds) | reused, resident kept |
| Not there, `PATH` has this laptop's version | `PATH` binary reused, nothing installed, resident kept |
| Not there, `PATH` has another version, resident busy | refused (`residentGuard`), nothing installed |
| Not there, `PATH` has another version, resident idle or absent | idle resident stopped, installed at the install path, notice names both versions |
| No binary found, a resident alive | never stopped; installed, the bridge joins it, warning says so and how to use one binary |
| Binary at the install path, another version, resident busy | refused (`residentGuard`), nothing installed |
| Binary at the install path, another version, resident idle or absent | idle resident stopped, replaced in place, plain "replaced" notice |

**Tests (red → green), `packages/cli/test/engine-runtime.test.ts`.** Three added.
- `no --bin-dir: another tentacle earlier on PATH, ours installed`, idle and busy resident: red at `expect(kube.calls.some((c) => c.includes("--resident-"))).toBe(false)`, which is the reviewer's repro.
- `no --bin-dir: another version on PATH only`: red on the notice ("the container had tentacle 0.2.0; replaced…", false: `PATH` keeps 0.2.0).
- `a pod's escape sequences in the probed version never reach the log`: its first red proved nothing (a dev build injected, and `evil` was absent). Its binary is at the install path, so it was re-run after the probe fix and went red on the property: `\u001b[31m` raw in the log. Green after `versionLabel`.
- Green: 103 pass in `engine-runtime` + `engine-docker`.

**Mutation.** The old probe restored (`let serveBin = deps.binDir ? binPath : "tentacle";` and the old fallback guard): 18 fail, 85 pass. Most of the 18 are the re-pointed expectations, so this count alone is no proof of the new test; the red above is. Restored by `cp`; `shasum` identical before and after, `f13a27c2…1db5`.

**Gate.** `bun run check`: typecheck clean, Biome 557 files clean, 3539 pass / 3 skip / 0 fail, no load flake this run.

**Not verified, and how to verify.** Fake cluster only, no live run, as briefed: on a real container with another `tentacle` earlier on `PATH`, `attach` twice and check the resident's pid with `docker exec <name> ps -eo pid,ppid,stat,args`.

**Notes / debt.** F2 and F3 stay deferred to S2, as the owner decided. The refusal text keeps naming the asking binary's version.

## Review — S1 fix round 5

*— claude-opus-5-5, 2026-10-30*

Same model and family as the executor, only a fresh context: shared blind spots survive both passes.

### Verdict

**REQUEST-CHANGES (one test, no source change required).** The code closes F1 of round 4: with another `tentacle` earlier on `PATH`, an installed binary is found first and a busy resident is never stopped. But re-aligning the tests lost one pin (F1 below), reproduced by a surviving mutation.

### Findings

1. **`packages/cli/test/engine-runtime.test.ts:1658`, MEDIUM, reproduced: a re-aligned test lost its contract.** At `HEAD`, `attach: replacing fails (read-only dir)` asserted the daemon exec `tentacle serve`, the bare `PATH` binary. It now asserts `${POD_BIN_PATH} serve`, because `containerHas` moved the image's binary to the install path, so `found === binPath` and the assertion no longer tells `found` from `binPath`. The two tests that do reach `found === "tentacle"` (`attach-replace-landed`, `attach-replace-broken`) assert no exec line. Mutation: delete `serveBin = found;` (`engine-runtime.ts:625`) → **103 pass, 0 fail**. On that mutant, an image with another version on `PATH` and an unwritable install path execs a binary that does not exist, and the attach fails instead of continuing with the warning. The source is correct today. Fix: one test with `binsAnswer(kube, { tentacle: "tentacle 0.2.0\n" })` + `readOnly(kube)`, asserting `exec:mypod:-:tentacle serve …` and the warning.
2. **`packages/cli/src/pod-binary.ts:337`, NIT, pre-existing.** The third pod-stdout version: `injectAgentBinary` returns it raw and `engine-runtime.ts:675` logs it, in piped mode only, on `attach` and on `run`. The owner's NIT named the probed version, so round 5 is within its brief; the Execution's "both probed versions" is true, but the log is not clean of pod text. One `untrustedText` closes it. By reading; no test reaches it.
3. **`packages/cli/src/engine-runtime.ts:580`, LOW, pre-existing, by reading.** The idle resident is stopped (`:580`) before the install (`:594`). When the install path is unwritable and the version differs (a non-root image, no `--bin-dir`), every `attach` stops the idle resident, fails the install and goes on with the old binary. This does not converge, and an idle resident may hold a finished session (`sessions: 1, running: 0`). The warning names the way out (`--bin-dir`), so it is loud. Same on round 4's code.

### Owner decisions

- **F1:** fix now. Recommended: one test, on the path a non-root image takes.
- **F2:** ride along with F1, one line. Recommended, as it finishes the owner's NIT.
- **F3:** defer to S2 with a `TODO.md` entry. Recommended: not a regression, and a writability check before the stop needs its own design.

### Gate

`bun run check` (run before the mutations): typecheck clean, Biome clean, **3539 pass / 3 skip / 0 fail**, no load flake this run.

### Mutations (re-run by the reviewer)

`cp` backup, `engine-runtime.test.ts` + `engine-docker.test.ts`, 103 tests. `shasum` identical after each restore: `engine-runtime.ts` `f13a27c2…1db5`; the other four reviewed files unchanged.

| Mutation | Result |
|---|---|
| Executor's: the old probe | 18 fail, 85 pass: matches its count. Includes the new `path-first` test and `version-escape` |
| Mine: delete `serveBin = found;` | **0 fail, SURVIVES** (F1) |
| Mine: delete `replaced = false;`, together with a raw `version` in the fallback | 4 fail (the failed-replace tests); on the replace flag, the fallback's `untrustedText` alone is not pinned (by reading, only the `reuse` path has an ESC test) |

### The re-aligned tests

No backup of the round-4 test file exists, so the comparison is against `HEAD` plus the round-4 source (`fix4/engine-runtime.ts.bak`, whose diff with today is exactly the three changes in the Execution).
- The 18 are re-pointed expectations: `tentacle` → `${POD_BIN_PATH}` in the probe and exec lines. The notice texts and the guard's ordering assertions are unchanged, so those hold the same contract, except F1.
- The inject test keeps its order and adds the second probe and the guard: stronger.
- `attach-replace-landed` and `attach-replace-broken` keep their asserted strings, but now run with `binPath` failing from the first probe, and a rename that "landed" while only `PATH` changes. Same text, a less realistic scene; the case `found === binPath` with a landed rename has no test. It shares its code with the read-only case, so it stays in F1's family, no separate finding.

### Attacks tried

- **Mismatch table:** every row has a test. Rows 2 and 3 run only with `--bin-dir`, but the branch does not depend on the default dir; rows 1, 4, 5, 6, 7 are pinned on the default path. Holds.
- **Converges after one install:** `path-other` installs, and the next attach finds `binPath` (`path-first`, idle and busy). Holds when the install succeeds; F3 otherwise.
- **Busy resident:** a stop is reached only through `residentGuard`; every `replace` and `inject` asks it first. Holds.
- **Stale install path, right version on `PATH`:** not in the table. `binPath` wins, so it is a replace: idle stopped once, busy refused with the stale version's name. Fail-closed and converging. Rare. Holds.
- **`replaced` flag:** set once, cleared only in the fallback, and the non-`replace` catch rethrows. The executor's claim is right: `serveBin === binPath` could not tell a failed replace. Holds.
- **Raw terminal writes:** the notice goes through `deps.notify`, and `deps.log` only with no status line, as before, before Ink mounts. Nothing new. Holds.
- **Pod text in the notice:** `had` passes `parseVersionLine`; `installedAt` comes from the laptop. Holds. Except F2 elsewhere.
- **Absolute exec by default:** `podDaemonCommand(serveBin, …)` takes argv. A hang at `binPath` throws, as a hang on `PATH` did. Holds; a real container is the orchestrator's check.
- **Prior art:** `main:TODO.md:505` tracks the deferred F2 + F3 of round 4, as the owner decided. `main:TODO.md:522` (a killed guard probe, exit 137, on k8s) is an open item on the same path, not touched here.

### Limits

Fake cluster only; no Docker, as briefed; no end-to-end trace by this review, it is the orchestrator's live check. F2 and F3 are by reading. A script running all the mutations in one go needed an approval this session lacks, so three were run by hand, per the brief.

### How the executor behaved

Honest: it reported the drift, disclosed the first red that proved nothing, and warned that the 18 prove little on their own. The blind spot is the one that warning points at: after moving the fixture, it did not ask which branch the moved test still discriminated.

### Orchestrator live test — S1 fix round 5 (2026-10-30, Docker Desktop, isolated `TENTACLE_CONFIG_DIR`, binaries built from this worktree)

*— claude-opus-5-5 (orchestrator), 2026-10-30*

- Image `FROM node:22` + a foreign `/usr/local/sbin/tentacle` printing `tentacle 0.0.9` (earlier on `PATH` than `/usr/local/bin`) — the round-4 F1 case.
- `run --engine docker --keep --no-mount` → `/usr/local/bin/tentacle` bridge (63) + resident (96).
- `kill -9` client → `attach` → SAME resident 96 (new bridge 170); again `kill -9` → `attach` → SAME resident 96 (bridge 246). `resident.log`: only "resident listening … (pid 96)", no "resident stopped". Converges; F1 closed live. Container and image removed.

**Owner decisions on Review — S1 fix round 5 (2026-10-30):** F1 (test) + F2 (NIT) → fix round 6, no logic change; F3 (stop-before-install with an unwritable install path) → deferred to S2, tracked in `TODO.md`; the final check of round 6 is done by the orchestrator (gate + the surviving `serveBin = found` mutation), no further full review.

## Execution — S1 fix round 6

*— claude-opus-5-5, 2026-10-30*

No logic change. F3 not done (deferred, as decided).

### F1: the lost contract

`packages/cli/test/engine-runtime.test.ts:1668`, new test `attach: another tentacle on PATH, the install dir is read-only → execs the one that answered, not the install path`: `binsAnswer(kube, { tentacle: "tentacle 0.2.0\n" })` + `readOnly(kube)`, so `found === "tentacle"` differs from `binPath`. It asserts the warning and `exec:mypod:-:tentacle serve --bridge --model-proxy --context-window 128000`. No source change.

### F2: the third pod-stdout version

`packages/cli/src/pod-binary.ts:339`: `untrustedText(version.stdout.trim()) || "tentacle"` (import added at `:30`). A seam exists (`FakeKube`), so it has a unit test, `packages/cli/test/pod-binary.test.ts:389`: stdout `tentacle 1.2.3\u001b[2J\n` → `tentacle 1.2.3 [2J`.

### Mutations

`cp` backup in `.tentacle/tmp/detached-runs-fix6/`, the two mutants together, `engine-runtime.test.ts` + `engine-docker.test.ts` + `pod-binary.test.ts`:

| | Result |
|---|---|
| Real code | 140 pass, 0 fail (104 engine + 36 pod-binary, run per file) |
| Delete `serveBin = found;` + return the raw stdout | **138 pass, 2 fail**, one per mutant, both on the assertion: the new F1 test (`Expected to contain: "exec:mypod:-:tentacle serve …"`) and the new F2 test (`Expected: "tentacle 1.2.3 [2J"`) |

`shasum` before the mutants and after the restore is identical: `engine-runtime.ts` `f13a27c2…1db5` (the same as Review round 5: this round leaves it untouched), `pod-binary.ts` `b85a56f8…5c4`.

The first red of the F2 test proves nothing: its expected value lacked the space `oneLine` puts in place of the ESC, so it stayed red after the fix too. The expectation was corrected against `oneLine`; the valid red is the mutant above.

### Gate

`bun run check`: typecheck clean, Biome clean, **3541 pass / 3 skip / 0 fail** (3539 + the 2 new), no load flake this run.

### Limits

Fake cluster only; no container was run.

### Orchestrator check — S1 fix round 6 (owner: no further full review)

*— claude-opus-5-5 (orchestrator), 2026-10-30*

- Mutant "delete `serveBin = found;`" (`engine-runtime.ts:625`), which survived round 5 (103 pass / 0 fail): now `engine-runtime.test.ts` 66 pass / **1 fail** ("attach: another tentacle on PATH, the install dir is read-only → execs the one t…"). Restored with `cp`, `shasum` identical.
- `bun run check`: typecheck clean, lint clean, `bun test` **3541 pass / 3 skip / 0 fail**.
- **S1 verdict: MERGE** (rounds 1–6 reviewed; live tests of rounds 3, 4, 5 PASS). Deferred to S2/TODO: resident real version (F2+F3 of round 4), install-before-stop (F3 of round 5), k8s exit code (F3 of round 2).
