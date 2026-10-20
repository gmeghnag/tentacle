# feat/pod-attach-resilience — exec-channel keepalive (Layer 1)

> **Status:** DONE — merged to `main` 2026-10-20 (one fresh-context Review, Opus 5.5 sub-agent: APPROVE-WITH-NITS, nits addressed; no second Review by owner choice)
> **Branch:** `feat/pod-attach-resilience`
> **Type:** feat · **Size:** S · **Blast:** contained · **Suited:** any model executes; one fresh-context Review (owner request, Opus 5.5 sub-agent)

---

## Context

*— claude-opus-5-5, 2026-10-20*

**Promoted from a legacy plan** (pre-AGENTS §10, already filed under `feat/`):
this rewrite puts it into the four-section shape. Its history, in short:

- **Original problem (2026-10-17).** A `tentacle attach` session left idle
  (~30 min, laptop probably asleep for part of it) failed on the next prompt
  with `⚠ RpcError: peer is closed`. The exec WebSocket (`v4.channel.k8s.io`)
  had no keepalive and no reconnect: once closed, `execChannel` fired its close
  and `RpcPeer` rejected every request.
- **Layer 2 — reconnect-and-resume — is DONE**, absorbed by
  `docs/feat/client-reattach-frontends.md` (owner decision D9,
  `docs/eval/session-reattach.md:468`). After a drop, `execChannelFactory`
  (`packages/cli/src/pod-runtime.ts:226`) re-execs the daemon, and the session
  is recreated from the laptop's history (test:
  `packages/cli/test/pod-runtime.test.ts:1047`).
- **What is left is Layer 1, this task.** Two gaps remain:
  1. **Avoidable drops.** An idle exec carries no bytes, so every idle reaper on
     the path is free to close it: LB/router TCP idle timeouts, and the kubelet's
     `streamingConnectionIdleTimeout` (default 4 h, often lowered by hardening
     guides). Each such drop costs a reconnect, and a turn in flight is lost.
  2. **Idle half-open goes undetected.** The client's liveness watchdog only
     judges a link while a request is outstanding (`liveness()` returns `idle`
     when `watchedSince === null`, `packages/client/src/link-machine.ts:192`).
     After a laptop sleep or a NAT/LB that silently forgets the flow, the socket
     looks open. The user only finds out when they next type, and then waits up
     to `LIVENESS_MS` (15 s, `link-machine.ts:25`) before the reconnect starts.

**Scope decision (owner, 2026-10-20) — it widens D9's "a WS ping" on evidence.**
A WebSocket ping is answered by the endpoint that terminates the WebSocket, so
the ping alone may never reach the kubelet's stream and can leave that idle
timer running. The owner chose a design with three parts, all inside
`exec-channel.ts` and with no protocol change:

- a WS ping, which keeps laptop↔apiserver busy in both directions;
- a blank stdin line, which keeps every hop up to the container busy, and which
  the daemon discards;
- a pong-gated miss counter, which closes a dead link even while idle, so the
  existing reconnect path starts.

**Repro / evidence** (runs in `.tentacle/tmp/pod-attach-resilience/`; the scripts
are gitignored, so they are pasted here):

1. Bun 1.4.3's client `WebSocket` has `ping()`, and a `pong` listener fires
   (`ping.ts`, a local `Bun.serve` peer):
   ```
   typeof ws.ping: function
   { serverPings: 2, pongs: 2 }
   ```
2. **Live, OpenShift 4.19 / k8s v1.32.13** (throwaway namespace
   `tentacle-ka-13465`, ubi-minimal pod, exec `cat` over `v4.channel.k8s.io`;
   `live.ts`). The exec stream answers client pings, and a blank stdin frame
   (`encodeStdin("")` = `[0x00, 0x0a]`) reaches the container: `cat` echoes it
   back on stdout.
   ```
   0.18s msg ch 1 ""
   0.18s open, protocol = v4.channel.k8s.io
   0.18s ping 1
   0.23s pong 1
   2.18s ping 2
   2.24s pong 2
   4.18s ping 3
   4.24s pong 3
   6.18s sent blank stdin line
   6.23s msg ch 1 "\n"
   8.18s summary pongs = 3 of 3
   8.18s close 1000
   ```
3. Live soak (10 min, one fully idle exec next to one with a 30 s
   ping + blank-stdin heartbeat; `soak.ts`): see Execution.

`live.ts`:
```ts
import { buildExecUrl, execSubprotocols } from "../../../packages/k8s/src/exec-channel.ts";
import { encodeStdin } from "../../../packages/k8s/src/exec-frame.ts";
const server = process.env.SERVER as string, token = process.env.TOKEN as string, ns = process.env.NS as string;
const url = buildExecUrl(server, ns, { pod: "ka", command: ["cat"] });
const t0 = Date.now(); const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
const ws = new WebSocket(url, { protocols: execSubprotocols(token), tls: { rejectUnauthorized: false } } as never);
ws.binaryType = "arraybuffer";
let pongs = 0;
ws.addEventListener("pong" as never, () => { pongs++; console.log(at(), "pong", pongs); });
ws.addEventListener("message", (e) => { const b = new Uint8Array(e.data as ArrayBuffer); console.log(at(), "msg ch", b[0], JSON.stringify(new TextDecoder().decode(b.subarray(1)))); });
ws.addEventListener("close", (e) => console.log(at(), "close", (e as CloseEvent).code));
await new Promise((r) => ws.addEventListener("open", r));
console.log(at(), "open, protocol =", ws.protocol);
for (let i = 0; i < 3; i++) { (ws as unknown as { ping(): void }).ping(); console.log(at(), "ping", i + 1); await Bun.sleep(2000); }
ws.send(encodeStdin("")); console.log(at(), "sent blank stdin line");
await Bun.sleep(2000);
console.log(at(), "summary pongs =", pongs, "of 3");
ws.close(); await Bun.sleep(500);
```

## Implementation

*— claude-opus-5-5, 2026-10-20*

### Load-bearing assumption

**Every pod daemon discards a blank stdin line without answering.** If one did
not, each heartbeat would draw a `ParseError` frame back to the laptop, and an
old daemon might even fail. This holds: `streamChannel` drops empty lines
before they reach `RpcPeer.receive` (`packages/transport/src/stream-channel.ts:50`,
`if (line !== "")`), and `serve --stdio` rides `streamChannel`
(`packages/cli/src/serve.ts:259`). The check has existed since `serve --stdio`
was introduced (`git show 0026eac:packages/transport/src/stream-channel.ts`,
line 50). Every binary an `attach` might reuse, whatever its version, therefore
has it. A test already pins it
(`packages/transport/test/stream-channel.test.ts:45`, "ignores a blank line").

### Preconditions

- **A closed exec channel reconnects.** With a factory, a channel close is the
  drop path: `RemoteClient` wires the channel's `setOnClose`
  (`packages/client/src/remote-client.ts:489`), and the pod runtimes pass
  `channelFactory` (`pod-runtime.ts:345` for `run`, and likewise for `attach`).
  Pinned by `pod-runtime.test.ts:1047`. So the keepalive only has to *close* a
  dead channel; it never reconnects on its own.
- **`openExec` is used only for the long-lived daemon RPC**
  (`packages/k8s/src/client.ts:205`, called at `pod-runtime.ts:226,332,526`).
  The one-shot binary injection uses `exec-run.ts`, which builds its own socket
  and never calls `execChannel`. A blank stdin line therefore cannot corrupt an
  upload stream framed by `head -c N`.
- **The real socket has `ping()` and a `pong` event.** `kube-auth.ts:136` builds
  the exec socket as a Bun `WebSocket` (Evidence 1). A `WebSocketLike` without
  `ping` (a fake, another runtime) must keep working.
- **The apiserver path answers pings, and blank stdin reaches the container**
  (Evidence 2, live).
- **The peer is not serialized** (AGENTS §7): the heartbeat is not an RPC at all
  — it lives below `RpcPeer` — so it cannot block or reorder a request.

### Design

`execChannel` (`packages/k8s/src/exec-channel.ts`) gets one heartbeat timer,
started on `open` and stopped on close.

- **Each tick** (every `intervalMs`, default **15 s**):
  1. **Judge.** If at least one pong has been seen on this socket, and no
     inbound byte (message or pong) arrived since the previous tick, then
     `missed++`; otherwise `missed = 0`. When `missed` reaches `maxMissed`
     (default **2**), the link is dead: `ws.close()` and `fireClose()`, the same
     path a real `close` event takes. The client reconnects from there.
  2. **Probe.** `ws.ping?.()`, then `ws.send(encodeStdin(""))`, both guarded
     with try/catch: a throw means the socket is going away, and its own
     `close`/`error` event follows.
- **Why it is pong-gated.** An idle daemon sends nothing, so without pongs there
  is no proof of life to wait for. A server that ignores pings, or a socket
  without `ping`, therefore never arms the dead-man. It still gets the
  keepalive bytes, and it is never closed by mistake. No false-kill reconnect
  loop is possible.
- **Why it counts ticks, not wall-clock time.** After a laptop sleep the first
  tick judges the pre-sleep ping, which was normally answered before the sleep,
  so a wake is never mistaken for a death. A real death is judged on fresh
  probes: it is declared about 30–45 s after the last inbound byte.
- **Timer handling.** The timer handle is `unref`'d when the runtime supports
  it, so the heartbeat never keeps a process alive on its own. The channel's
  socket owns the lifetime.
- **Seams.** `ExecChannelOptions.keepalive?: { intervalMs?, maxMissed?, timers? }`,
  where `timers` is `{ setInterval, clearInterval }`, for deterministic tests.
  `WebSocketLike` gains an optional `ping?(): void` and a `"pong"` listener
  overload.
- **No caller changes.** `openExec` passes the options through, so `run`,
  `attach` and every redial get the default keepalive.

Not a protocol `ping` RPC: that would bring a new method (an older daemon
answers `MethodNotFound`), handlers on both ends, and blast across modules. The
blank line achieves the same per-hop traffic with zero wire change.

### Files

1. `packages/k8s/src/exec-channel.ts`: `WebSocketLike.ping?` and the `pong`
   overload; the `keepalive` option; heartbeat state and timer inside
   `execChannel`.
2. `packages/k8s/test/exec-channel.test.ts`: `FakeWS.ping()`/`pong()`, a fake
   interval clock, and the tests below.

### Failure modes

- **A server that never pongs** (or a socket without `ping`): the keepalive
  bytes still flow, and the channel is never closed by the heartbeat.
- **Half-open while idle** (sleep, NAT/LB drop): no pong comes back; after
  `maxMissed` ticks the channel closes, and the existing reconnect re-execs and
  recreates the session.
- **One missed tick** (sleep landing between a ping and its pong, a GC pause):
  `missed = 1` is reset by the next inbound byte. Nothing closes.
- **A ping stuck behind outbound bulk** (prior art:
  `docs/eval/remote-execution-model.md:139`, "a keepalive needs a priority lane
  while bulk data flows"). Inbound data already counts as life, and a request
  the client is watching has its own stricter 15 s check. The only gap left: a
  ping and its pong stuck behind more than about `maxMissed × intervalMs`
  (30–45 s) of *laptop→pod* bytes, with no inbound byte at all in that time. A
  false close then costs one reconnect (a turn in flight is reported lost, never
  silently half-applied). This is accepted, not designed out: the laptop rarely
  sends that much to the pod (prompts, tool results, model-stream chunks), and a
  real priority lane is `docs/eval/rpc-flow-control.md`'s question.
- **Busy link** (large stdout, slow pongs): inbound messages count as life, so a
  pong queued behind data is not a miss.
- **Before `open`:** no ticks (nothing is queued into the pre-open buffer). A
  dial that hangs is the client's dial deadline (`remote-client.ts:614`).
- **After close** (local `close()`, remote `close`/`error`, or a heartbeat kill):
  the timer is cleared exactly once and `onClose` fires once (`fireClose` is
  idempotent).
- **`ping`/`send` throws:** swallowed. The socket's own events drive the close.
- **Version skew:** none on the wire; the load-bearing assumption covers old
  daemons.
- **Not covered (by design):** a link the laptop can still reach, but where the
  pod daemon itself is wedged. Pongs come from the apiserver/kubelet stream, not
  from the daemon, so this keepalive does not detect it. The watched-request
  liveness check (`remote-client.ts:560`) covers that while a request is
  outstanding.

### Tests

All tests are in `packages/k8s/test/exec-channel.test.ts`, driven by `FakeWS`
and a manual interval clock:

1. After `open`, each tick sends a ping and exactly one blank stdin frame
   (`[0, 0x0a]`); no tick and no frame before `open`. A socket already OPEN
   when it is wrapped (no `open` event) gets the heartbeat too.
2. **No false kill:** a socket that never pongs is never closed over many ticks.
   The same holds for a socket without `ping` (blank lines only).
3. **Dead-man:** after a pong, `maxMissed` silent ticks → `ws.close()` and
   `onClose` fire exactly once, and later ticks send nothing.
4. **Life resets the count:** one silent tick, then an inbound *message* (not a
   pong) or a pong → no close at the next tick.
5. **Close stops the timer:** after a local `close()` or a remote `close`, the
   interval is cleared, and no tick sends anything.
6. **Half-open:** when `ws.close()` never completes its closing handshake (a
   dead link), `onClose` still fires at once.
7. A `ping`/`send` that throws is swallowed.
8. `openExec` passes `keepalive` through (the client test uses a fake clock).

Red first: everything that asserts a ping, a frame or a close fails on today's
code, which has no ping and no timer. Tests 4 and 7 assert that something does
*not* happen, so they pass vacuously on today's code. Their proof is mutation:
remove the pong gate → test 2 fails; stop counting a message as life → test 4
fails; skip `clearInterval` in `fireClose` → tests 3 and 5 fail; drop the
try/catch → test 7 fails; let the dead-man rely on the socket's close event
instead of calling `fireClose` → test 6 fails.

## Execution

*— claude-opus-5-5, 2026-10-20*

1. Branch `feat/pod-attach-resilience` off `main` (`b4b39f0`). The owner chose
   the design (ping + blank stdin + pong-gated dead-man) over D9's literal
   "ping only", based on the evidence in Context, and authorised the live test
   in a throwaway namespace.
2. Tests written first in `packages/k8s/test/exec-channel.test.ts`.
   **Red:** 6 of the new tests failed on the old code, with no ping and no
   timer. The "reset" and "throw swallowed" tests passed, as expected for
   assertions that something does not happen (see Tests).
3. Implementation in `packages/k8s/src/exec-channel.ts`, as designed. **Drift
   (a bug the plan missed, found while implementing):** a socket that is
   already OPEN when wrapped receives no `open` event, so the heartbeat never
   started. Fixed with `if (opened) startHeartbeat()` after the listeners; that
   test was shown red, then green.
4. **Mutation pass:** M1 (no pong gate), M2 (a message is not life), M3 (no
   `clearInterval`) and M4 (no try/catch) were each caught. **M5** (the
   dead-man skips `fireClose` and relies on `ws.close()` emitting `close`)
   *survived*: `FakeWS.close()` emits synchronously. On a real half-open link
   the closing handshake does not complete, so the direct `fireClose` is
   load-bearing. Added test 6 (a `close()` that never completes); M5 is now
   caught. Every mutation was reverted from a backup copy.
5. **Live check of the real code** (same cluster, `live-channel.ts`):
   `KubeClient.openExec` over a silent `sh -c 'cat >/dev/null'` (no stdout, so
   pongs are the only inbound bytes), `intervalMs: 1000`, `maxMissed: 2`, for
   12 s → `pongs = 11 ; after 12 ticks @1s: still open (no false kill)`. The
   gate armed (pongs were seen), and the pong path alone kept a healthy idle link
   open.
6. Test fixture: `FakeWS.ping` became an optional property, so a test can model
   a socket without `ping` (a `ping: undefined` intersection typed as `never`).
7. **Live soak, 10 min** (`soak.ts`: one exec with no heartbeat at all, next to
   one with a 30 s ping + blank line): `600s after 10 min: idle.readyState = 1
   kept.readyState = 1 pongs = 19`. **Both survived.** This cluster has no idle
   reaper under 10 min, so the "avoidable drops" gap (Context, gap 1) is *not*
   shown live here. That the blank line resets the kubelet's
   `streamingConnectionIdleTimeout` is reasoning, not evidence: verifying it
   needs a node whose timeout is short, or a 4 h soak. The rest *is* evidenced
   live: pongs arrive, and the blank line reaches the container. The dead-man
   was traced end-to-end by the Review (attacks C and F).
8. **Gate:** `bun run check` → typecheck clean; `biome check .`: 307 files, no
   issues; `bun test`: **1202 pass, 2 skip (the two opt-ins), 0 fail**.

## Review

*— claude-opus-5-5 (fresh-context sub-agent), 2026-10-20*

> **Same model as the executor.** This review ran in a fresh context, but on the
> same model (Opus 5.5) that wrote Context, Implementation and Execution. Shared
> blind spots can survive both passes. The task is rated `contained`, so §10 does
> not require a different model; the owner chose this as the only review.

### Verdict: **APPROVE-WITH-NITS**

The code does what the plan says. The load-bearing assumption holds against
the real `serve --stdio` binary path. Every new test is non-vacuous: 13 of my 14
mutations were caught, and the survivor cannot be tested with a fake clock. A
heartbeat kill runs the same close path as a natural close, and it drove a real
`RemoteClient` reconnect end to end. All findings are about the doc or are
low-risk robustness nits. None blocks the merge. Findings 1–3 are worth fixing
in the doc before the merge.

### Findings

1. **(doc) The soak evidence points to a section that does not exist.** Context
   item 3 says "see Execution", but Execution says nothing about the soak. The
   run did happen: `.tentacle/tmp/pod-attach-resilience/soak.out` reads
   `600s after 10 min: idle.readyState = 1 kept.readyState = 1 pongs = 19`.
   That is a **null result**: the *un*-kept idle exec also survived 10 min, so
   this cluster has no idle reaper under 10 min. Gap 1 ("avoidable drops") is
   therefore **not demonstrated live**. The claim that a blank stdin line resets
   the kubelet's `streamingConnectionIdleTimeout`, where a ping alone does not,
   rests on reasoning. It is plausible: on k8s ≥1.30 the apiserver terminates
   the WS and talks SPDY to the kubelet, so only data crosses that hop. Still,
   it is unverified. Record the soak result and this caveat in Execution.
2. **(doc) A prior-art constraint is not discharged.**
   `docs/eval/remote-execution-model.md:139` says: "A keepalive is a control
   message, so it needs 2's priority lane to stay timely while bulk data
   flows". The plan never mentions it. The design does mostly discharge it.
   Inbound bulk counts as life (`exec-channel.ts:192`), so a pong stuck behind
   stdout is not a miss. Outbound bulk is the remaining case: a ping queued
   behind more than ~30 s of buffered laptop→pod data, with nothing coming back.
   For a *watched* request, `RemoteClient`'s 15 s watchdog
   (`remote-client.ts:560`) already cuts that link sooner, so the heartbeat adds
   no new failure class there. Say so in Failure modes and cite the eval.
3. **(doc) The status header is stale.** `> **Status:** implementation` should
   now read review (then merged).
4. **(nit, code) A throwing `ping()` also skips the blank line**
   (`exec-channel.ts:165-170`, one `try` around both calls). Bun's `ping()`
   should not throw on an OPEN socket, so the risk is low. Separate `try` blocks
   would keep the data keepalive working even if `ping` ever broke.
5. **(nit, test) `unref` is not pinned** (`exec-channel.ts:77`). Mutation M14
   (drop the `unref`) survives. This is acceptable: the fake clock cannot
   observe it, and the open socket holds the event loop anyway (see Attack F,
   where the process exits as soon as the channel closes). The comment is the
   only guard.
6. **(observation) Blast rating.** `contained` is defensible by footprint: one
   file, additive optional fields, no protocol change. But the new behaviour
   can *close a live session's channel*. A false kill costs a reconnect and any
   in-flight turn. That is why the false-kill attacks below were run with
   extra care. No change requested.

### Gate (re-run by the reviewer)

`bun run check` → exit 0. `tsc --noEmit` clean; `biome check .`: 307 files,
no fixes; `bun test`: **1202 pass, 2 skip (the two opt-ins), 0 fail**, 4726
`expect()` calls, 1204 tests across 119 files. This matches Execution step 7
exactly. The narrow file `packages/k8s/test/exec-channel.test.ts` has 20 pass.

### Premise table

| # | Premise (cited) | Verdict |
|---|---|---|
| 0 | Context symptom: on `main` the exec channel has no keepalive | TRUE: `git show main:packages/k8s/src/exec-channel.ts \| grep -c "setInterval\|ping"` → `0` |
| 1 | `stream-channel.ts:50` drops blank lines | TRUE (`if (line !== "")`) |
| 2 | `serve --stdio` rides `streamChannel` (`serve.ts:259`) | TRUE (`serve.ts:259-262`, and no other `process.stdin` reader on that path) |
| 3 | The drop has existed since `0026eac` | TRUE: `git log -S'line !== ""'` → only `0026eac`. Every `tentacle`-named binary postdates it (the rename was `2aaf471`, after it), so an on-PATH binary reused by `attach` (`pod-runtime.ts:476-492`) has it too |
| 4 | `stream-channel.test.ts:45` pins "ignores a blank line" | TRUE |
| 5 | `link-machine.ts:192` idle when `watchedSince === null`; `:25` `LIVENESS_MS = 15_000` | TRUE |
| 6 | `pod-runtime.ts:226` `execChannelFactory`; `:345` run `channelFactory`; attach likewise | TRUE (attach `:539`) |
| 7 | `remote-client.ts:489` close wiring | TRUE (factory wrapper forwards `setOnClose` to the raw channel; RpcPeer wires it at `peer.ts:132`) |
| 8 | `remote-client.ts:555` watched liveness; `:610` dial deadline | TRUE, off by a few lines (`call` `:560`, `dialChannel` `:614`) |
| 9 | `pod-runtime.test.ts:1047` attach drop re-execs | TRUE |
| 10 | `openExec` is used only for the daemon RPC (`client.ts:205`; calls `:226,332,526`) | TRUE: `execChannel` is used only at `client.ts:208`; `exec-run.ts` builds its own socket |
| 11 | `kube-auth.ts:136` builds a Bun `WebSocket` | TRUE |
| 12 | D9 at `docs/eval/session-reattach.md:468` | TRUE |
| 13 | Half-open detected "about 30–45 s after the last inbound byte" | TRUE in shape: measured at 2–3 intervals (Attacks C and F) |

### Mutation non-vacuity

I took a backup and applied each mutation by an exact unique-string replace,
ran the narrow test file, then restored. `git diff main | shasum` before and
after was `3f77c8e6…` both times (byte-identical), and `git status` was unchanged.

| Mutation | Caught by |
|---|---|
| M1 drop the pong gate | 3 tests (never-pong, no-`ping`, first tick test) |
| M2 a message is not life | "any inbound byte resets" |
| M3 no `clearInterval` in `fireClose` | 3 tests |
| M4 no try/catch around the probe | "throw is swallowed" |
| M5 dead-man skips `fireClose` | "half-open" |
| M6 no start for an already-OPEN socket | "already OPEN" |
| M7 `inbound` never reset per tick | 2 tests |
| M8 a pong is not inbound | 2 tests |
| M9 heartbeat starts before `open` | "nothing before open" |
| M10 `>` instead of `>=` | 2 tests |
| M11 `openExec` drops `keepalive` | "passes the keepalive options through" |
| M12 no `ping()` | 4 tests |
| M13 no blank line | 3 tests |
| M14 no `unref` | **survives** (Finding 5) |

### Attacks tried

- **A. Load-bearing assumption against the real daemon binary path.** I ran
  `bun packages/cli/src/main.ts serve --stdio --model-proxy` (temp HOME) and
  piped in `\n\n`, an `initialize`, then `\n\n\n`, then `{bad`. Stdout held
  exactly the `initialize` result and one `-32700 parse error` (for `{bad`, the
  control showing that an error *would* be visible). The five blank lines drew
  **no frame**. Holds.
- **B. A long synchronous stall on the laptop event loop** (`stall.ts`: real
  Bun WS to a local `Bun.serve`, interval 200 ms, `maxMissed` 2, armed, then a
  2000 ms busy-wait, i.e. 10 intervals). Bun fired **one** catch-up tick, not
  ten, and the pong for it arrived within the same ms. Result: `still open`,
  11 ticks / 11 pongs. Even a back-to-back double tick (timers before I/O)
  would only reach `missed = 1`. Laptop sleep is the same case (Bun does not
  replay missed intervals). No false kill.
- **C. Half-open dead-man on a real socket** (`halfopen.ts`: a TCP proxy that
  silently black-holes both directions). Frozen at 1.00 s, last pong at
  0.91 s, `onClose` at 1.81 s (3 intervals). Bun's `ws.close()` on the dead
  link emitted its `close` event at once (`readyState` 3). The process then
  **exited on its own**: no lingering CLOSING socket, no leaked interval.
- **D. Frame atomicity, live** (`live-interleave.ts`, OpenShift 4.19,
  `tentacle-ka-13465/ka`, exec `cat`). I sent 3000 ~950-byte JSON frames with a
  **20 ms** heartbeat, so 78 blank lines were interleaved. All 3000 came back
  intact and in order (`bad: 0, extra: 0`), with 76 pongs and no close (no
  false kill under heavy two-way traffic). Each `ws.send` is one whole
  `encodeStdin` message ending in `\n`, so a blank line can only fall between
  frames. The pre-open queue is unreachable: the timer only starts on `open`
  (M9).
- **E. Live idle, the executor's script re-run on the real code**
  (`live-channel.ts`, a silent `cat >/dev/null`, 1 s ticks): `pongs = 11 ;
  still open (no false kill)`. Reproduced.
- **F. A heartbeat kill drives the real reconnect** (`reconnect-e2e.ts`). This
  used the real `RemoteClient` with `channelFactory`, the real `execChannel`,
  and Bun WS. The "pod" side was the real `streamChannel` + `RpcPeer`, behind
  the black-hole proxy for gen 0. I froze the link idle, with nothing
  outstanding, so `RemoteClient`'s own watchdog was `idle` and blind. Result:
  `reconnecting` (attempt 1) 0.6 s after the freeze, then `up`;
  `{ dials: 2, inits: 2, daemonFrames: 2, daemonErrors: 0 }`. The blank lines
  never reached the daemon peer and drew no error. The kill uses the same
  `fireClose` as a natural `close`/`error` event (`exec-channel.ts:162` vs
  `:207-208`), so the `onLinkClosed(gen)` and turn-lost logic cannot tell the
  two apart. A later `close` event from the old socket is a no-op (idempotent,
  and stale by gen).
- **G. Interaction with `RemoteClient` liveness, and double close.** A watchdog
  close goes `peer.close()` → `execChannel.close()` → `fireClose`, which clears
  the timer. A heartbeat close goes `fireClose` → `onClose`. Whichever comes
  first wins, and the second is a no-op. Pongs do not feed `lastInboundAt`, so
  the two watchdogs stay independent. The client's 15 s watchdog is always
  stricter than the heartbeat's 30–45 s. A late dial is closed before `open`,
  so its heartbeat never starts. No conflict found.
- **H. A server that pongs once, then stops answering pings but keeps sending
  data.** Data counts as life, so the channel stays open while data flows. It
  is killed 2 ticks after the data *and* the pongs both stop. That is a
  genuinely silent link, and the cost is one reconnect. Acceptable; no real
  apiserver/kubelet stack is known to behave this way.
- **I. Other paths that could see the blank line.** `run`'s binary injection
  and the `--version` probe use `runExec` (`exec-run.ts`), never `execChannel`,
  so they are unaffected. `connect` uses `ws-channel.ts`, so it is out of scope.
  Found nothing.

### What holds

- The load-bearing assumption, for the real binary and for every historical
  one.
- No false kill from: never-pong servers, sockets without `ping`, event-loop
  stalls, busy links (in either direction for inbound), or a healthy idle link.
- Dead-link detection while idle, and the close path identical to a natural
  drop.
- The timer is cleared exactly once on every close path. No pre-open traffic.
- §7 holds: no peer serialization (below `RpcPeer`), no protocol change, no
  terminal writes.

**Unverified:** the kubelet idle-timeout benefit (Finding 1). It needs a
cluster with a lowered `streamingConnectionIdleTimeout`, or an LB idle timeout
under 10 min, plus an idle-vs-kept soak.

### How the executor behaved

Disciplined and honest. Tests were written first, and the red count was stated
along with *which* tests are vacuous by design. Two of its own gaps were found
and closed: the already-OPEN socket case (drift recorded), and a mutation that
survived (M5) and got a dedicated half-open test. All of this matches what I
re-ran. The gate numbers match exactly. Two lapses: the soak was run but its
null result was left out of Execution (Finding 1), and the prior-art
constraint went unmentioned (Finding 2). Neither overstates the code. They
leave the doc's evidence for gap 1 weaker than its wording suggests.

### Post-review fixes

*— claude-opus-5-5 (executor), 2026-10-20*

Owner rule: one Review only, so these fixes were not re-reviewed.

- Findings 1–3 (doc): the soak result is recorded in Execution step 7, with its
  null result stated plainly. The prior-art constraint is a new Failure-modes
  entry ("A ping stuck behind outbound bulk"). The Status header and the two
  off-by-a-few line cites are fixed.
- Finding 4 (code): `ping()` and the blank-line `send` are now guarded
  separately (`exec-channel.ts`, in `tick`). The "throws" test now asserts that
  the blank line still goes out when `ping()` throws: shown **red** before the
  split, **green** after.
- Finding 5 (`unref` not pinned): accepted as-is, for the Review's reason (a
  fake clock cannot observe it, and the open socket owns the process lifetime).
- Finding 6 (blast rating): kept as `contained`, by footprint. The false-kill
  cost is bounded to one reconnect and is recorded in Failure modes.
