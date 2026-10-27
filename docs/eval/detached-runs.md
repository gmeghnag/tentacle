# eval/detached-runs — leave a `run` working with no TUI, re-attach later

> **Status:** eval (Context + Review verdict; no code)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Type:** eval · **Size:** ? (the build, if approved, is 4–5 tasks: see "Suggested split") · **Blast:** ? (two slices are load-bearing) · **Suited:** ? — owner assigns; the load-bearing slices → strong model + mandatory fresh-context Review

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

*(none — eval; filled when promoted)*

## Execution

*(none)*

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
