# feat/client-reattach-frontends — connect / attach / run use the reconnecting client

> **Status:** DONE — merged to `main` 2026-10-20 (one fresh-context Review on Fable: APPROVE-WITH-NITS, both nits addressed; real-cluster check A–D on OpenShift; no second Review by owner choice)
> **Branch:** `feat/client-reattach-frontends`
> **Type:** feat · **Size:** M · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (one-session-path, single-broker and pod-trust invariants, AGENTS §7)

---

## Context

*— claude-opus-5-5, 2026-10-19*

Parent: `docs/eval/session-reattach.md` (child 8b). `client-reattach` (8a)
makes `RemoteClient` reconnect and resume, but stays inert until a frontend
passes it a channel factory. This task wires every runtime (`connect`,
`attach`, `run`, in-process worker) through it — keeping AGENTS §7's one
session path — and shows connection state in the Ink `StatusBar` (not
`StatusLine`). It absorbs Layer 2 (reconnect-and-resume) of
`docs/feat/pod-attach-resilience.md` (decision D9).

### Scope handed over by 8a

*— claude-opus-5-5, 2026-10-20*

From `docs/feat/client-reattach.md` (every **[8b]** item, the Revision's D7/D8
and owner answers R-Q1/R-Q2, Execution drift 1):

1. **Channel factories** per runtime: `connect` (WebSocket), `run` / `attach`
   (k8s exec). The worker passes none (Design §7).
2. **Q8** — a rejected WebSocket upgrade is classified (401 → terminal
   `unauthorized`, anything else transient) via one `fetch` probe.
3. **R-Q2** — liveness: a half-open link (laptop slept) must not hang forever.
4. **Q7** — link state in the Ink `StatusBar`, never a raw write.
5. **Persistence on resync / `onCommitted`** (D1) — decided here (Design §6).
6. **Drift 1** — `connect` must pass a client-generated session id, or a drop
   during the first `open` is an error instead of a recovery.
7. **Q12 / D9** — pod-attach Layer 2: a new exec is a new `serve --stdio`, the
   session is recreated from the laptop's history, the turn in flight is
   reported lost (never re-run).

### Repro (`main` @ `a3ce281`, 2026-10-20, bun 1.4.3)

`.tentacle/tmp/client-reattach-frontends/repro.ts` — `connect.ts`'s exact
client construction over a **real** WebSocket to `startWsServer` + a
`SessionHost`; the server goes away mid-turn and comes back on the same port.

```ts
// Repro for feat/client-reattach-frontends on main: `connect`'s client over a
// REAL WebSocket to a `serve`-style daemon (startWsServer + SessionHost).
import { Agent } from "@tentacle/agent";
import { RemoteClient, connectWebSocket } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import { SessionHost, startWsServer } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { GatedModel, t, done } from "../../../packages/client/test/support/fakes.ts";

const model = new GatedModel([[t("a"), { kind: "gate" }, t("b"), done]]);
const host = new SessionHost({
  defaultCwd: "/tmp",
  createAgent: () => {
    const permissions = new PermissionBroker();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: { id: "e", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }), readFile: async () => "", writeFile: async () => {} }, requestPermission: (r, o) => permissions.request(r, o) });
    return { agent, permissions };
  },
});
let server = startWsServer({ host: "127.0.0.1", port: 0, sessionHost: host, token: "good" });
const port = server.port;

// 1. a dropped link mid-turn (exactly connect.ts's construction)
const channel = await connectWebSocket(server.url, { token: "good" });
const client = new RemoteClient(channel, new PermissionBroker(undefined, { holdUntilSet: true }), undefined, {});
client.onLinkStatus((s) => console.log("link:", JSON.stringify(s)));
await client.initialize();
const session = client.newSession();
const events: string[] = [];
const turn = (async () => { for await (const e of session.send("hi")) events.push(e.type); })();
while (!model.waiting) await new Promise((r) => setTimeout(r, 5));
server.stop(); // the network drops mid-turn
server = startWsServer({ host: "127.0.0.1", port, sessionHost: host, token: "good" }); // ...and comes back
model.open();
try { await turn; console.log("turn completed:", events.join(",")); } catch (e) { console.log("turn failed:", (e as Error).message, "| events:", events.join(",")); }
await new Promise((r) => setTimeout(r, 1500));
console.log("sessions still live daemon-side:", host.list?.().length ?? "(n/a)");

// 2. a wrong token: what does the user learn?
try { await connectWebSocket(server.url, { token: "bad" }); } catch (e) { console.log("bad token:", (e as Error).message); }
// 3. nothing listening
try { await connectWebSocket("ws://127.0.0.1:1", {}); } catch (e) { console.log("unreachable:", (e as Error).message); }
server.stop();
process.exit(0);
```

```
link: {"state":"stopped","reason":"disconnected"}
turn failed: connection closed | events: text
sessions still live daemon-side: (n/a)
bad token: failed to connect to ws://127.0.0.1:56849
unreachable: failed to connect to ws://127.0.0.1:1
```

The daemon is back and still holds the session, yet the turn fails and the
link is `stopped`: no runtime passes a factory. A wrong token and a dead host
read the same. (`pod` `run`/`attach`: same code path — `createLocalRuntime`
builds `RemoteClient` without options other than `onError`,
`local-runtime.ts:130-133`.)

**Experiment Q8 (`closecodes.ts`, same date):** what Bun's client sees.

```
401      : error close(1002,"Expected 101 status code")
502      : error close(1002,"Expected 101 status code")
down     : error close(1006,"Failed to connect")
ok+drop  : open close(1001,"going away")
GET probe token=bad: 401
GET probe token=good: 426
```

401 and any other non-101 are indistinguishable on the socket (1002); a plain
GET to the same URL tells them apart (the daemon answers 401 vs 426,
`daemon/src/ws-server.ts:207-214`). Q8's design holds on Bun 1.4.3.

## Implementation

*— claude-opus-5-5, 2026-10-20*

**Owner answers (2026-10-20):** liveness = inbound-silence watchdog (§4) ·
post-turn save detached + serialized (§6, not the "accept busy" option) ·
worker gets no factory (§7) · plan approved for Execution · the single
fresh-context Review runs as a subagent on **Fable**.

### Load-bearing assumption

**A fresh channel from a factory reaches a daemon in one of exactly two states
for each session this client holds — it still has the session (re-attach with
`since` / resync), or it provably does not (`open` without `messages` throws
`UnknownSession` → recreate) — and both are already handled by 8a's client.**

- `serve` (WebSocket): sessions outlive connections; `open{sessionId, since}`
  attaches (`daemon/src/session-host.ts:97-101`). Restart → persistence reload
  (8a test E4).
- Pod exec: each `openExec` runs a new `serve --stdio` process
  (`cli/src/pod-runtime.ts:259-266`, `:445-452`) with its own `SessionHost`;
  the old one ends on stdin EOF (`cli/src/serve.ts:215`, "Resolves when
  stdin closes"). The recovery `open{sessionId, since}` carries no `messages`
  and no `create` (`client/src/remote-client.ts:632-642`), so the new host
  throws `UnknownSession` (`session-host.ts:103-105`) → `recreate` seeds the
  laptop's newest history and reports the turn lost (`remote-client.ts:697-715`).
- Proved end to end on 8a's in-memory transports (`reattach.test.ts` "recreate
  → `turn_lost`", E4). **Not yet proved on a real WebSocket nor through
  `createLocalRuntime` + pod runtime** — first tests of this task (T1, T6).

### Preconditions

- **P1 — the factory seam exists and is inert by default.**
  `RemoteClientOptions.channelFactory` (`remote-client.ts:118-123`); no factory
  → a drop stops (`:495-500`). `ChannelError{kind}` with only `unauthorized`
  terminal (`link-machine.ts:18-31`, `terminalReason` `:72-82`).
- **P2 — one broker, never rebuilt.** The broker is a constructor argument
  (`remote-client.ts:206-213`); `dial` builds only a peer (`:543-582`). Every
  runtime constructs ONE `RemoteClient` per process (`local-runtime.ts:130`,
  `connect.ts:51`). This task must keep that: the factory is the only new
  input, the client is never re-constructed.
- **P3 — model proxy rides each generation.** `makePeer` installs the
  `model/stream*` handlers on every new peer (`remote-client.ts:429-450`), with
  the same laptop `ModelProvider`. The pod never gets the key.
- **P4 — status is observable.** `onLinkStatus` (`remote-client.ts:239-242`),
  `LinkStatus = up | reconnecting{attempt, nextAtMs} | stopped{reason}`
  (`link-machine.ts:34-37`). No status before the first drop (initial state is
  `up`, no emission).
- **P5 — Q8 observable** (Experiment above): close 1002 for any rejected
  upgrade, 1006 for unreachable; GET → 401 / 426.
- **P6 — exec channel**: `openExec` is synchronous and returns a channel that
  queues frames until the socket opens (`k8s/src/exec-channel.ts:10-13,
  :62-75`); a failed upgrade surfaces only as a close. So an exec failure shows
  up as a failed `initialize` → `dialFailed` → transient
  (`remote-client.ts:562-568`).
- **P7 — a pod's identity check needs no exec**: `PodCluster.getPod`
  (`pod-runtime.ts:90`) is already in the injectable interface; `run` pods are
  `restartPolicy: Never` (`k8s/src/pod.ts:61`), so a dead container is a
  terminal pod phase (`TERMINAL_PHASES`, used at `pod-runtime.ts:374`).
- **P8 — the TUI does not depend on `@tentacle/client`** (8a D11): link status
  reaches it as a structural type, like `NoticeFeed` (`tui/src/App.tsx:63-65`).
- **P9 — `prompt`, `enqueue`, `resolve_permission`, `initialize`, `open`,
  `snapshot`, `close` answer promptly** (`daemon/src/connection.ts:155-208`;
  `prompt` acks at once, `hosted-session.ts:600-604`; `enqueue` waits one store
  write, `connection.ts:187-192`). `compact` does not (a model call,
  `:196-199`).

### Design

**§1 WebSocket factory (Q8)** — `client/src/ws-channel.ts`:
`webSocketChannelFactory(url, {token?}, deps?) → () => Promise<WebSocketChannel>`.
One dial = one `new WebSocket` (same URL/headers construction as
`connectWebSocket`, factored into one helper so they cannot drift). Resolves on
`open`. On a `close` before `open`: pure `classifyUpgradeFailure(code,
probeStatus)` → `ChannelError`: 1002 → one `fetch` of the http(s) twin of the
URL (same `?token=` and `Authorization`) — 401 → `unauthorized`, any other
status or a fetch failure → `rejected`; 1006 / anything else → `unreachable`.
`deps = {WebSocket?, fetch?}` injectable. `connectWebSocket` stays (exported
API) and keeps its behaviour.

**§2 Exec factory (pod-attach Layer 2)** — `cli/src/pod-runtime.ts`:
`execChannelFactory(kube, podName, target, options)` → `async () => {
preflight; return kube.openExec(target, options) }`. Preflight = `getPod(name)`,
classified by a pure `podDialError(errorOrPod)`: `KubeApiError` 404 or a
terminal phase → `ChannelError("gone")`; 401/403 → `ChannelError("unauthorized")`;
anything else (network, 5xx) → `ChannelError("unreachable")`; a running pod →
no error. Same `target` (same `serveBin`/`binPath`, container, `--model-proxy`)
and the same buffered `stderr.onStderr` sink as the first exec. Used by both
`startPodRuntime` and `startAttachRuntime`; the first channel stays the direct
`openExec` (the pod was just checked).

**§3 Terminal kinds** — `link-machine.ts`: `ChannelErrorKind` gains `"gone"`
(the target no longer exists: a deleted / terminated pod), terminal like
`unauthorized`. `LinkStatus.reconnecting` gains `error?: string` — why the last
dial failed (e.g. "rejected: HTTP 502", an exec error), so the user is not
staring at a bare counter. `linkDropped` sets none ("connection lost" is the
frontend's default wording).

**§4 Liveness (R-Q2), refined.** 8a's draft: a 15 s ack deadline per command.
Refinement: **a request outstanding and no inbound frame for 15 s → the link is
dead.** Any frame (a replay burst, a model chunk request, an update) proves
liveness, so a slow-but-alive replay during `open` is never mistaken for a dead
link (a per-command deadline would be: the `open` response follows its whole
replay, `hosted-session.ts:474-495`), and the check covers `initialize`, `open`,
`snapshot` pages and keyed commands with one rule. Pure:
`liveness({now, lastInboundAt, watched}) → {dead} | {checkInMs} | idle` in
`link-machine.ts` (`LIVENESS_MS = 15_000`). Shell (`remote-client.ts`, factory
only): the generation's channel is tapped for `lastInboundAt`; requests issued
through `sessionCall`, `handshake`, `openOn`/`recreate` and `readSnapshot` are
"watched" (counted in/out); `compact` is not (P9). Dead → `peer.close()` on that
generation → the existing `onLinkClosed` path (reconnect, keyed re-send). A dial
whose factory never settles is bounded by the same deadline (a late channel is
closed on arrival). **Not covered** (stated): a half-open link while nothing is
outstanding — e.g. mid-turn, the client is passive — is detected only when the
user next acts, or by transport keepalive (`pod-attach-resilience` Layer 1 for
exec; server pings only close the server side). Nor a `compact` alone on a half-open
link (unwatched, P9): it waits until the next watched command trips the
watchdog, then rejects as `once` (Review nit 2).

**§5 Runtimes.**
- `LocalRuntimeDeps.channelFactory?` → `RemoteClient` option.
  `LocalRuntime.link: LinkFeed` (`{onLinkStatus(listener) → unsubscribe}`,
  delegates to `client.onLinkStatus`).
- `connect.ts`: `ConnectDeps.connect` is replaced by
  `dialer(url, {token}) → () => Promise<DuplexChannel>` (production:
  `webSocketChannelFactory`). The first channel comes from the SAME factory
  (so a bad token at startup now says "the daemon rejected the credentials"),
  the factory is passed to `RemoteClient`, `newSession(undefined,
  crypto.randomUUID())` (drift 1), `link` to `startTui`.
- `run` / `attach`: pass `execChannelFactory(...)` (§2).
- worker: no factory (§7).
- `main.ts`: `startTui(..., link: runtime.link)` for worker, `run`, `attach`.

**§6 Persistence — `onCommitted` dropped; the post-turn save detached
(owner decision 2026-10-20).** `onCommitted` has no consumer:
`persistingController` already saves the daemon's `snapshot` after every
`send`/`compact` (`local-runtime.ts:73-104`), and with a factory
`RemoteClient.snapshot` waits out a drop and reads after recovery
(`remote-client.ts:345-362`). Resync mid-turn → the save reads the post-resync
history; pod recreate → the save after `turn_lost` reads the recreated session
(= the last saved history: disk keeps the pre-turn state, consistent with the
daemon); idle drop → nothing to save. `connect` persists nothing (unchanged).

But today `send`'s `finally { await flush() }` holds the turn open until the
save's `snapshot` answers, so a drop between `turn_end` and that `snapshot`
would leave the TUI "busy" for the whole outage. **Owner chose: detach it.**
- The controller schedules the flush and returns (`send` ends at `turn_end`,
  `compact` resolves with its result).
- Flushes are **serialized** per controller (a promise chain) and **coalesced**
  (at most one waiting: it reads the history when it runs, so a newer one
  supersedes it). The store already serializes saves of one uid in call order
  (`agent/src/session-store.ts:271-277`), so serialized snapshot reads ⇒ disk
  order = history order.
- A failed flush (snapshot rejected: stopped link, closed session) is
  **reported, never thrown**: `SessionSaver.failed(id, error)` feeds the same
  `nextSaveState` machinery as a failed write — one in-TUI notice, and `drain`
  lists it at exit ("not saved: … — any file on disk is from an earlier save").
- `dispose` first awaits the pending flushes, bounded
  (`FLUSH_ON_EXIT_TIMEOUT_MS`, 3 s), THEN closes the sessions: a quit right
  after a turn must not close the session under its own save (it would fail
  with `UnknownSession`). Quitting while the link is down: the bounded wait
  expires, the flush fails on `close()`, and the exit report says the last
  turn is not on disk — true.

**§7 Worker: no factory (decision).** A worker "link drop" is the worker dying;
reconnecting means a new worker + recreate — a different feature
(`docs/eval/worker-crash-hang.md`). It still gets `link` (a crash now shows
"disconnected" in the StatusBar instead of nothing).

**§8 TUI (Q7).** Pure `tui/src/link-status.ts`: structural `LinkStatusView`
(mirror of `LinkStatus`) and `LinkFeed`; `linkIndicator(status, nowMs) →
{text, tone: "warn" | "error"} | null` — `up`/none → null; `reconnecting` →
`reconnecting… (attempt n, retry in Xs)` (`X = ceil((nextAtMs-now)/1000)`,
`≤ 0` → `retrying now`; `: <error>` appended when present); `stopped` →
`disconnected: <reason>`, except `reason === "closed"` (our own exit) → null;
`nextTickMs(status, now)` → ms until the countdown text changes, or null.
`App` gets `link?: LinkFeed`; one small hook (`useLinkIndicator`) holds the
status and a timer re-armed from `nextTickMs` (no polling when up). `StatusBar`
gets `link?: {text, tone}` and renders it FIRST, as a **sibling** box capped at
70 % of the width (nested inside the truncated `<Text>` it kept the first
render's width — Execution drift 4), yellow / red. `TuiOptions.link`
passes it through (`run.tsx`).

### Files

Dependency order (no protocol / daemon / transport change; `PROTOCOL_VERSION`
stays):

1. `packages/client/src/link-machine.ts` — `"gone"`, `reconnecting.error`,
   `liveness`, `LIVENESS_MS`.
2. `packages/client/src/ws-channel.ts` — `webSocketChannelFactory`,
   `classifyUpgradeFailure`, shared socket construction.
3. `packages/client/src/remote-client.ts` — liveness watchdog (factory only),
   dial deadline, `error` on the reconnecting status.
4. `packages/client/src/index.ts` — exports.
5. `packages/cli/src/session-saver.ts` — `failed(id, error)`.
   `packages/cli/src/local-runtime.ts` — `channelFactory`, `link`, detached
   serialized flush, bounded flush wait in `dispose`.
6. `packages/cli/src/pod-runtime.ts` — `execChannelFactory`, `podDialError`,
   wired in `run` + `attach`.
7. `packages/cli/src/connect.ts` — dialer, session id, `link`.
8. `packages/cli/src/main.ts` — `link` to `startTui` (worker, `run`, `attach`).
9. `packages/tui/src/link-status.ts` (new), `components/StatusBar.tsx`,
   `App.tsx` (prop + hook), `run.tsx`, `index.ts`.
10. Tests (below). Docs: `TODO.md`, `docs/feat/pod-attach-resilience.md`
    (Layer 2 done here).

### Failure modes

| Case | How state converges |
|---|---|
| `serve` restarts / network blips (WS) | 1006/1001 → transient → backoff → re-attach (`since`) or E4 path; StatusBar shows reconnecting, then clears. |
| Token revoked / wrong (WS) | 1002 + probe 401 → `unauthorized` → stopped; sessions fail with "the daemon rejected the credentials"; StatusBar red. At startup: the same message, before Ink mounts (plain error, as today). |
| Proxy 502 / daemon not yet listening behind an LB | 1002 + probe ≠ 401 → `rejected` → transient, `error` shown. |
| Probe itself fails (TLS, network) | `rejected` (transient) — never terminal on a guess. |
| Origin-rejected (also 401, `ws-server.ts:194`) | Terminal "unauthorized" — correct: a native client sends no Origin; a browser client with a bad Origin will never succeed. |
| Pod exec drops, pod alive | new exec → new daemon → `UnknownSession` → recreate from the laptop history → `turn_lost` for a turn in flight (never re-run, tools may have run); pending dialog withdrawn (`retainOnly` on the reset); the next prompt works. |
| Pod deleted / Failed / Succeeded | preflight 404 / terminal phase → `gone` → stopped; `run`'s exit net still deletes (idempotent). |
| Cluster credentials expired | preflight 401/403 → `unauthorized` → stopped. |
| apiserver unreachable | preflight network error → `unreachable` → backoff. |
| Injected binary gone (user pod restarted its container, `attach`) | exec fails each time → handshake fails → transient forever, with the exec error in the StatusBar; the user quits. Re-injection on reconnect: out of scope (Notes). |
| Half-open socket, a command outstanding | §4 watchdog: 15 s of inbound silence → close → reconnect → keyed re-send. |
| Half-open, nothing outstanding | undetected until the next command (stated limit, §4). |
| Factory never settles (SYN black hole) | dial deadline → transient; a late channel is closed on arrival (no orphan generation). |
| Drop during the first `open` (`connect`) | client-generated id → recovered with `create: true` (8a). |
| Drop between `turn_end` and the post-turn save | the turn ends at once; the save waits for recovery in the background (§6); stop → "not saved" notice + exit report. |
| Two turns end while one save waits | coalesced: one save reads the newest history after recovery. |
| Quit right after a turn | `dispose` awaits the flush (≤ 3 s) before `session/close`. |
| Quit while reconnecting | `dispose` → `closeSessions` resolves at once while down (`remote-client.ts:308-311`) → `close()` clears the timer (`:416-425`); `run` still deletes the pod; a `serve` daemon reaps the detached session by TTL. |
| Pod forges a replay / snapshot after reconnect | Unchanged trust: prompts still go through the laptop's single broker and router; the history it supplies is what `persistingController` already reads from it after every turn. No new laptop-side effect is gated by the pod. |

### Tests

Red-before-green: each new test is shown failing on the pre-change code (or
with the feature's line mutated out) before it passes.

- **T1 — real WebSocket re-attach** (`client/test/ws-factory.test.ts`): the
  Repro as a test — `startWsServer` + `SessionHost`, a client with
  `webSocketChannelFactory`; stop + restart the server mid-turn → the turn
  completes, statuses `reconnecting → up`. Red on `main` (no factory: "connection closed").
- **T2 — Q8 classification**: real `Bun.serve` on loopback: bad token →
  `ChannelError("unauthorized")`, 502 → `rejected`, closed port →
  `unreachable`; good token → channel. Plus `classifyUpgradeFailure` table.
- **T3 — link machine**: `"gone"` terminal; `error` carried on reconnecting;
  `liveness` table (idle, watched + fresh, watched + stale = dead, boundary).
- **T4 — watchdog in the shell** (`reattach.test.ts`, injected clock, a
  channel that swallows outbound frames = half-open): a `prompt` outstanding,
  clock +15 s → a new generation is dialled and the prompt is re-sent with the
  same `turnId`, completes once; no watch without a factory (inert); a slow
  replay that keeps sending frames is NOT declared dead; `compact` not watched.
- **T5 — dial deadline**: a factory that never settles → after 15 s a second
  dial; the late channel is closed.
- **T6 — pod runtime** (`cli/test/pod-runtime.test.ts`, `FakeCluster` — each
  `openExec` is a new daemon): drop the exec mid-turn → `turn_lost`, the next
  prompt runs on the new exec (2 `exec:` calls with the same command); pod
  404 / `Failed` on reconnect → stopped, no further exec; 401 → stopped; a
  pending approval across the drop is withdrawn and the **same `SpyBroker`**
  receives the next session's prompt (single broker, mutation: build a second
  client/broker in the factory path → red).
- **T7 — `attach`**: same as T6 for `startAttachRuntime` with `serveBin`
  unchanged across execs; never `deletePod` on a stop.
- **T10 — detached save** (`cli/test/local-runtime.test.ts`): (a) `send`
  ends while the post-turn `snapshot` is held (red on `main`: the generator
  waits); (b) two flushes while one is held → reads serialized, one coalesced,
  the saved record is the newest; (c) a snapshot that rejects → `saver.failed`
  → one notice, no throw, no unhandled rejection; (d) `dispose` right after a
  turn saves before `session/close` (frame order); (e) `SessionSaver.failed`
  joins `drain`'s report.
- **T8 — connect** (`cli/test/connect.test.ts`): the session id passed to
  `open` is a UUID; the factory is used for the first channel; `link` reaches
  `startTui`; a startup `unauthorized` surfaces its message.
- **T9 — TUI**: `link-status.test.ts` table (labels, countdown, `closed` →
  null, `nextTickMs`); `app.test.tsx` frame test: feed `reconnecting` → the
  StatusBar line starts with "reconnecting…", feed `up` → gone.
- **Mutations** (each alone, must turn a test red): no factory passed in
  `connect` (T1/T8); `"gone"` transient (T3/T6); watchdog never fires (T4);
  watchdog ignores inbound frames (T4 slow replay); probe skipped
  (T2 bad token → `rejected`); `closed` shown in the bar (T9).

### Notes / debt

- Re-injecting the binary on reconnect (`attach` to a pod whose container
  restarted) — out of scope; the failure is visible and bounded by the user.
- Idle half-open detection on WS — needs a client-side ping; follow-up with
  `pod-attach-resilience` Layer 1 (exec ping).
- Worker crash recovery — `docs/eval/worker-crash-hang.md`.

## Execution

*— claude-opus-5-5, 2026-10-20*

Branch `feat/client-reattach-frontends` off `main` @ `a3ce281`. Baseline gate
before any edit: `bun run check` green — **1157 pass, 2 skip (opt-in), 0 fail**.
Built in the Files order; each slice red → green on its own test file.

### As built

1. `client/src/link-machine.ts`: `"gone"` (terminal), `reconnecting.error`
   (the dial failure's message), `LIVENESS_MS`, pure `liveness`.
2. `client/src/ws-channel.ts`: `webSocketChannelFactory` (+ injectable
   `WebSocket`/`fetch`), pure `classifyUpgradeFailure`; socket construction
   shared with `connectWebSocket` (unchanged behaviour).
3. `client/src/remote-client.ts`: every request goes through `call` — watched
   (factory only, not `compact`) by one liveness timer; inbound frames tapped
   per generation; `dialChannel` bounds a factory call; `onHistoryLost`
   (drift 2); `sessionCall` checks a recreate only for a command already
   written (drift 1). `remote-session.ts`: `sent` per turn.
4. `cli/src/session-saver.ts` `failed()`; `cli/src/local-runtime.ts`:
   `channelFactory`, `link`, `notify`, detached serialized coalesced flush
   (`PersistingController.flushed`), `close` after the pending save, `dispose`
   waits (≤ 3 s) before closing sessions.
5. `cli/src/pod-runtime.ts`: `podDialError`, `execChannelFactory`, wired in
   `run` and `attach` (same target + stderr sink), `notify`.
6. `cli/src/connect.ts`: `ConnectDeps.dial` (a factory) opens the first channel
   and every redial; client-generated session id; `link` to the TUI.
   `cli/src/main.ts`: `link` (worker, `run`, `attach`) and `notify` (pods).
7. TUI: `link-status.ts` (pure), `useLinkIndicator` (`hooks.ts`), `StatusBar`,
   `App`, `run.tsx`, `index.ts`.

### Drift from the Implementation (and why)

1. **8a defect fixed — a prompt typed while the link is down was reported
   lost on a recreate.** Found by the `attach` test: `sessionCall` captured
   `recreates` at CALL time, so a prompt that waited out the drop unsent
   rejected with `SessionLostError`, and `RemoteSession` failed the turn on
   `turn_lost`. No daemon ever had it. Now the recreate check counts from the
   first WRITE (`sentIn`), and `turn_lost` spares an unsent turn
   (`turn.sent`, set by `prompt`'s `onSent`). Unreachable on `main` (no
   factory). A prompt written to a channel that was already dying is still
   reported lost (conservative: the frame may have reached the old daemon).
2. **New failure mode found — a drop right after a turn ends lost that turn
   silently.** Found by the idle pod test: a recreate seeds `entry.history`,
   which only a snapshot read refreshes; a drop between `turn_end` and the
   post-turn read recreates the session WITHOUT the finished turn (daemon,
   model context, and the next save). The stream does not carry committed
   messages (`history_commit` is daemon-internal, `daemon/src/mapping.ts:149`),
   so restoring it would need a full client-side fold of the stream (L).
   Done instead (AGENTS: surface a silent drop): the client counts applied
   `turn_end`s vs those covered by the last history read; a recreate seeded
   from a lagging history emits `onHistoryLost{turns}`, shown as an in-TUI
   notice (pod runtimes get `notify`). Window: one round trip after each turn
   end — or up to the 15 s liveness window on a half-open link.
3. **Save on exit made explicit**: `dispose` waits for pending flushes BEFORE
   `session/close`. Needed only because the flush is now detached; a paged
   snapshot (> 200 messages) would otherwise lose its second page to the close
   (test "paged", red without the wait). A second wait after `close()` was
   tried and removed: the failure path is microtask-only, no test could tell.
4. **StatusBar**: nested inside the truncated `<Text>` the indicator kept the
   first render's width (frame captured: `disconnected: the daemon rejected
   the credent…` with the line half empty) — the Ink nested-Text mis-measure
   already in `docs/library-bugs.md`; rendered as a sibling box. Hiding the
   "auto-accept off" hint was tried first, did not fix it (wrong cause),
   and was reverted.
5. `connect`'s `ConnectDeps.connect` became `dial` (a factory): the first
   channel and the redials share one classifier, so a bad token at startup
   reads "the daemon answered 401 to the token".

### Tests

`link-machine.test.ts` (+3), `ws-factory.test.ts` (new: classification table,
real-socket 401/502/closed-port, real-WebSocket re-attach mid-turn),
`reattach.test.ts` (+5: half-open + keyed re-send, slow-but-alive, inert
without a factory, `compact` unwatched, dial deadline + late channel closed),
`session-saver.test.ts` (+1), `local-runtime.test.ts` (+6: detached, serialized
+ coalesced, failure reported, `/clear` after the save, failure → saver,
paged save before close), `pod-runtime.test.ts` (+7: `podDialError` table,
idle drop → seeded history, lost-turn notice, mid-turn → lost / pod kept,
pod gone → stopped / one exec, typed-while-down runs, `attach` re-exec / never
delete, single broker across a reconnect), `connect.test.ts` (+2),
`link-status.test.ts` (new), `app.test.tsx` (+1 frame test).

### Mutations (each alone, file restored byte-identical — `.tentacle/tmp/client-reattach-frontends/mutate.py`)

| # | Mutation | Result |
|---|---|---|
| W1 | watchdog never closes the peer | RED (half-open, slow-alive) |
| W2 | inbound frames not tapped | RED (slow-alive) |
| W3 | `compact` watched | RED |
| W4 | no dial deadline | RED |
| W5 | watched without a factory | RED (inert) |
| W6 | late channel not closed | RED |
| Q8 | probe skipped | RED (bad token → rejected) |
| G1 | `gone` transient | RED |
| T1 | no factory in the WS re-attach test | RED |
| P1 | save awaited by the turn (main's behaviour) | RED (4 tests) |
| P2 | flushes not serialized | RED |
| P3 | `close` not after the save | RED |
| P4 | `dispose` closes before the save | RED (paged) — green before that test existed |
| P5 | flush error not sent to the saver | RED |
| S1 | `SessionSaver.failed` no-op | RED |
| C1 / C2 / C3 | `connect`: no factory / no session id / no `link` | RED / RED / RED |
| K1 | `run`: no factory | RED |
| K2 | 404 transient | RED |
| K3 | no pod preflight | RED |
| H1 | history loss not reported | RED |
| H2 | recreate check from call time (8a behaviour) | RED |
| H3 | unsent turn failed on `turn_lost` | RED |
| H4 | history reads not counted | RED (idle drop raises a false notice) |
| U1 | App does not pass the link to the bar | RED |

### Gate

`bun run check`: tsc clean · Biome clean · **1190 pass, 2 skip (opt-in
live-k8s, slow keepalive), 0 fail** (1192 tests, 119 files).

### After (`.tentacle/tmp/client-reattach-frontends/after.ts` — the Repro with `webSocketChannelFactory`)

```
link: {"state":"reconnecting","attempt":1,"nextAtMs":1792510116432}
link: {"state":"up"}
turn completed: text,text,turn_end
bad token: the daemon answered 401 to the token
unreachable: cannot reach the daemon (close 1006)
```

### Real cluster (2026-10-20, OpenShift, `kube:admin`, pod `test00/ubi9-sleep`, ubi9, `restartPolicy: Always`, `--bin-dir /tmp`)

`.tentacle/tmp/client-reattach-frontends/cluster/run.ts`: the REAL
`startAttachRuntime` + `KubeClient` (binary built for `bun-linux-x64` and
injected, 89.1 MB); the model is a fake OpenAI server on the laptop, reached by
the pod THROUGH the laptop (`--model-proxy`). "Drop" A/B = kill the pod's
`serve --stdio` (found via `/proc`, the image has no `ps`); C = close the
exec WebSocket from the laptop side (a network cut seen from here).

```
[14.9s] turn 1: ok "reply-1"
[16.5s] link: {"state":"reconnecting","attempt":1,...}      ← A: daemon killed while idle
[16.8s] openExec: /tmp/tentacle serve --stdio --model-proxy
[17.2s] link: {"state":"up"}
[17.6s] model call #2: 4 messages, last user = "mid-turn prompt"   ← history kept across the recreate
[18.3s] model is mid-reply; killed serve pid(s): 116           ← B: daemon killed mid-turn
[19.8s] link: {"state":"up"}
[19.9s] mid-turn result: FAILED: the daemon lost the session; the turn in flight was not re-run (text so far "reply-2")
[20.1s] next turn after mid-turn drop: ok "reply-3"          ← 3 model calls total: never re-run
[21.0s] serve pids before: 137                                 ← C: laptop closes the exec socket
[23.1s] link: {"state":"up"}
[26.8s] serve pids 3s after (old one must be gone, one new): 158
[26.9s] turn after C: ok "reply-4"
[30.7s] serve pids 3s after dispose (must be none): (none)
[30.7s] execs: 4 [ "/tmp/tentacle serve --stdio --model-proxy" ]
[30.7s] notices: []   drain report: []
[30.7s] saved record: [system, user:hello, assistant:reply-1, user:after the drop, assistant:reply-3, user:after C, assistant:reply-4]
```

Verified on a real apiserver: re-exec of the same command; recreate seeded
with the laptop history; mid-turn loss reported, not re-run; the old
`serve --stdio` exits when the stream drops (premise of the LBA); no orphan
daemon after `dispose`; no false history-lost notice; the saved record matches.

**D — the pod deleted mid-session** (owner OK; `oc delete pod --wait=false`):

```
[14.7s] turn 1: ok "reply-1"
[15.0s] oc delete: pod "ubi9-sleep" deleted
[45.0s] link: {"state":"reconnecting","attempt":1,...}              ← the 30 s grace: the exec lived until the kill
[45.2s] openExec: /tmp/tentacle serve --stdio --model-proxy          ← preflight still saw Running (terminating)
[45.5s] link: {"state":"reconnecting","attempt":2,...,"error":"connection closed"}
[45.6s] link: {"state":"stopped","reason":"the connection target is gone: pod \"ubi9-sleep\" is Failed"}
[45.7s] turn after delete: FAILED: the connection target is gone: pod "ubi9-sleep" is Failed
[45.7s] notices: [ "⚠ Session d23f535c not saved — could not read the history back: …" ]   ← false alarm, fixed below
```

Converges in < 1 s after the kill, one extra exec (a terminating pod still
reports `Running`; its exec fails, the next preflight sees `Failed`).
**Found and fixed:** the turn that failed at once still scheduled the
post-turn save, whose read failed → a "not saved" notice and exit report for a
file that was complete (`hello`/`reply-1` on disk). `persistingController` now
saves only after a turn that produced an event or ended normally
(`local-runtime.ts` `send`); test "a turn that failed before producing
anything saves nothing" — RED before (one read, one error), GREEN after. Gate:
**1192 pass, 2 skip (opt-in), 0 fail** (1194 tests). Not re-reviewed (owner:
one Review). Known limit: an Esc before the turn's first event skips that
save; the next turn's save covers it.

**Still unverified:** the history-lost notice on a real link (its window is one round trip),
and the interactive TUI over `tentacle serve` + `connect` with a real network
cut.

### Fixes after the Review

*— claude-opus-5-5, 2026-10-20*

| Nit | Fix | Test |
|---|---|---|
| 1 `dialChannel`'s deadline survives `close()` | `remote-client.ts`: the deadline is `dialDeadline`, cleared by `close()` and when the dial settles | `reattach.test.ts` "close() during a dial that hangs leaves no timer armed" — RED before (1 timer pending), GREEN after |
| 2 `compact` on a half-open link waits for the next watched command | Doc only: §4 "Not covered" | — |

Gate after the fixes: `bun run check` green — tsc clean · Biome clean · **1191 pass, 2 skip (opt-in), 0 fail** (1193 tests, 119 files). No second Review (owner: one Review only).

## Review

*— claude-fable-5-1, 2026-10-20 (fresh context)*

**Verdict: APPROVE-WITH-NITS.** The feature does what the Implementation claims:
every runtime now drives the reconnecting client through the one session path
(§7), the single broker is preserved across recreates, the model stays on the
laptop per generation, and the drift-1 defect fix is real and well-tested. Two
low-severity nits (below), neither blocking.

I am a **different model** from the executor (claude-opus-5-5 wrote the code;
claude-fable-5-1 reviewed) — the AGENTS §10 routing for a load-bearing task is
satisfied.

### Gate (re-run myself)

`bun run check`: tsc clean · Biome clean (307 files) · **1190 pass, 2 skip
(opt-in), 0 fail** (1192 tests, 119 files, 37.2 s). Matches Execution's claim
exactly; baseline on `main` was 1157 pass.

### Premise table (every cited `file:line` opened)

| Premise | Cite | Verdict |
|---|---|---|
| `open{sessionId}` attaches a live session; unknown + no `create`/`messages` → `UnknownSession` | `session-host.ts:97-105` | TRUE |
| `serve --stdio` resolves when stdin closes (old exec ends) | `serve.ts:215` | TRUE |
| `history_commit` not carried in the stream mapping | `mapping.ts:149` | TRUE |
| `run` pods are `restartPolicy: Never` (crash → terminal phase) | `pod.ts:61` | TRUE |
| exec channel buffers outbound until `open`; a failed upgrade shows only as close | `exec-channel.ts:10-13,62-75` | TRUE (P6) |
| factory seam inert by default; only `unauthorized`/`gone` terminal | `link-machine.ts:32,80-92`, `remote-client.ts:556` | TRUE |
| one broker is a ctor arg, never rebuilt on redial | `remote-client.ts:235,476-538` | TRUE (P2) |
| model handlers reinstalled per generation, same provider | `remote-client.ts:497-509` | TRUE (P3) |
| Context symptom (Repro on `main`): no factory → turn fails "connection closed", daemon still holds session | `.tentacle/tmp/client-reattach-frontends/repro.ts` | TRUE — reproduced via the T1 mutation (no factory) going RED |

No false premises.

### Mutation non-vacuity (my own, each reverted; tree re-verified byte-identical)

I targeted the three properties I judged weakest/most load-bearing:

| # | Mutation | Test | Result |
|---|---|---|---|
| RM1 | drop the `turn.sent` guard in `turn_lost` (undo drift-1 fix) | pod "typed while the link is down" | RED ✓ |
| RM2 | neuter the watchdog's `peer.close()` on a dead verdict | reattach "half-open… 15 s" | RED ✓ |
| RM3 | make `"gone"` non-terminal in `terminalReason` | pod "pod is gone on reconnect" | RED ✓ |

All three turned RED, then GREEN on revert. After restoring, `git diff main |
shasum` = `05b2d8…` — **identical to the pre-review baseline**. The executor's
own 25-row mutation table is consistent with what I observed.

### Attacks tried (incl. those that found nothing)

1. **Can a prompt run TWICE across a recreate / can a turn hang forever?**
   Traced `sessionCall`'s `sentIn` + `RemoteSession.turn.sent`: a prompt
   *written* to a dying daemon has `sentIn === recreates-before`, so after the
   recreate `sentIn !== entry.recreates` → `SessionLostError`, never re-sent,
   and `turn_lost` (sent=true) fails it → reported lost, never double-run. A
   prompt *typed while down* has `sentIn === null`, so it binds to the new
   session and runs once. **No double-run.** Confirmed end-to-end: my
   `.tentacle/tmp/client-reattach-frontends-review/e2e.ts` over a REAL WebSocket
   drops mid-turn and completes with `model.calls === 1`. Found nothing wrong.
2. **History-lost false positive on an idle drop / compaction.** `turnEndsApplied`
   vs `turnEndsInHistory` (refreshed by every `historyRead`): after a completed
   post-turn save they are equal → an idle-drop recreate reports 0 lost (pod
   "idle" test: `notices === []`), and the H4 mutation proves the counter is
   load-bearing. A drop *before* the save's snapshot answers reports exactly 1
   ("window" test). Found nothing wrong.
3. **Detached save: lost save / ordering / `/clear`.** `flush()` coalesces (≤1
   queued, newest history wins), serializes via one `running` chain, and
   `flushed()` returns that chain so `dispose`'s bounded wait covers the queued
   one; `/clear` closes only after `flushed()`. A failed read → `saver.failed` →
   one notice + `drain`, never thrown. The paged (302-message) test proves
   `session/close` never lands between two snapshot pages. Found nothing wrong.
4. **§7 "don't serialize the RPC peer."** The watchdog/`call` wrapper adds only a
   `watched` map + a single timer around `peer.request`; no await/lock was added
   to `transport/peer.ts` or the `Connection` handlers. Dispatch stays
   concurrent. Found nothing wrong.
5. **Q8 probe hanging forever / TLS / Origin.** A hung probe is bounded: the
   whole factory promise is raced by `dialChannel`'s `LIVENESS_MS` timer
   (`unreachable`, transient), and the late factory rejection is consumed (no
   unhandled rejection). A probe that *fails* → `rejected` (transient, never
   terminal on a guess). Origin-rejection (also 401) → terminal, which is
   correct for a native `connect` (no Origin sent). Found nothing wrong.
6. **Pod preflight: Pending / 403 / apiserver down.** `podDialError` maps
   Pending → `unreachable` (transient retry), 401/403 → `unauthorized` (stop),
   404/terminal phase → `gone` (stop), 5xx/network → `unreachable`. Table test
   covers all. Found nothing wrong.
7. **StatusBar indicator (drift 4).** The frame test asserts the real rendered
   bottom line (`reconnecting… (attempt 3, retry in [45]s)` and the full
   `disconnected: …` line), exercising the sibling-`<Box>` workaround for the
   Ink nested-Text mis-measure now logged in `docs/library-bugs.md`. My e2e fed
   the emitted `LinkStatus` through `linkIndicator` and saw
   `warn:reconnecting…` → `(none)`. Found nothing wrong.

### Findings

1. **`remote-client.ts:608-631` (NIT, low).** `dialChannel`'s `LIVENESS_MS`
   timer is created with `this.clock.setTimeout` but `close()` only clears
   `dialTimer` and `livenessTimer`, not a dial that is in-flight at exit. If the
   process quits *while actively dialing a black-holed host*, that 15 s timer
   stays armed (the late rejection is still handled, so no unhandled rejection —
   only a possibly-delayed natural exit). Narrow path; most exits go through
   `process.exit`. Not blocking.
2. **`remote-client.ts:556` + §4/P9 (NIT, low / documentation).** `compact` is
   deliberately unwatched, so a `compact` outstanding on a *half-open* link does
   not self-heal via the watchdog — it stays pending until the next watched
   command (a prompt) triggers the drop, at which point the `once` policy
   rejects it cleanly. Intended per P9, pinned by the "compact is not watched"
   test, but the hang-until-next-action consequence is only implicit in the
   doc. Worth a one-line note; not a code change.

### What holds

- One session path, single broker, model-on-laptop, no RPC-peer serialization
  — all preserved (attacks 1, 4; premises P2/P3).
- The drift-1 defect fix (`sentIn`/`turn.sent`) is correct and conservative: a
  frame that may have reached the old daemon is reported lost, never re-run
  (attack 1, RM1).
- History-loss detection is non-vacuous and free of the obvious false
  positives (attack 2, RM3-adjacent H4).
- Detached/serialized/coalesced save converges on every path incl. `/clear`,
  paged snapshot, and read-failure reporting (attack 3).
- Docs/registries updated honestly (`pod-attach-resilience` Layer 2, TODO 8b,
  `library-bugs` second hit). `PROTOCOL_VERSION` correctly unchanged (additive).

### How the executor (claude-opus-5-5) behaved

Disciplined and honest. The Execution's drift log is accurate: both drifts (the
8a `sentIn`/`turn.sent` defect and the post-turn history-loss window) are real
bugs *found by the new tests*, surfaced loudly rather than papered over, each
with a red-before-green test and a mutation entry. The claimed gate counts match
my re-run to the test. The 25-row mutation table is consistent with my
independent RM1-RM3. The one item I would have pushed on — the detached-save
exit ordering — was already caught and fixed (the paged test). No overclaiming,
no vacuous tests found. Mandatory fresh-context Review satisfied by a different
model.
