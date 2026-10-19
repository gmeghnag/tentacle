# Resilient pod attach: keepalive + reconnect-and-resume

> **Status:** implementation — not started: no keepalive/reconnect in `k8s`/`transport` (verified 2026-10-17) · legacy doc (pre-AGENTS §10), not retrofitted to the four sections

> **Related (2026-10-19):** the protocol-v2 re-attach redesign overlaps this scope — `docs/eval/session-reattach.md`, `docs/eval/client-reattach.md` (reconnect + resume for every transport, incl. `attach`), `docs/eval/session-ttl-limits.md` (server keepalive). Re-evaluate whether this task is absorbed when `client-reattach` is promoted.

## Problem (with evidence)

A `tentacle attach` session left idle (observed: ~30 min, laptop likely asleep
part of it) fails on the next prompt with `⚠ RpcError: peer is closed`.

Cause, traced in the source:

- The attach transport is a `DuplexChannel` over the k8s `exec` WebSocket
  (`v4.channel.k8s.io`). It is built once in `pod-runtime.ts:440`
  (`kube.openExec({ command: [serveBin, "serve", "--stdio", "--model-proxy"] })`)
  and handed to `createLocalRuntime({ channel, store, resume, … })`
  (`pod-runtime.ts:455`).
- `execChannel` (`k8s/src/exec-channel.ts`) has **no keepalive and no
  reconnect**: on the socket's `close`/`error` it calls `fireClose`, which marks
  the channel dead and drops the queue.
- The `RpcPeer` wires `channel.setOnClose(() => this.handleClose())`
  (`transport/src/peer.ts:71`); once closed, every `request()` rejects with
  `new RpcError(InternalError, "peer is closed")` (`peer.ts:81`).

So an idle exec stream is reaped by the apiserver / load-balancer / router (no
bytes flowing → idle timeout), or dropped when the laptop sleeps; the channel
closes, the peer is doomed, and the next `session/prompt` throws. There is no
recovery path today.

## Preconditions (verified invariants this builds on)

- **The session is persisted on the laptop, after every turn.**
  `createLocalRuntime` (`cli/src/local-runtime.ts`) reads the authoritative
  history back from the daemon via `snapshot` and writes it to the
  `JsonSessionStore` (`store.save(...)`), reusing the session uid. (AGENTS §7:
  "Persistence lives on the laptop/main thread.") So the laptop always holds a
  resumable record, independent of the pod.
- **`attach --resume [uid]` already exists** (`cli/src/main.ts:57`, resume load
  at `:265`–`270`: `store.load(uid)` or `store.latest()`), and seeds a fresh
  daemon's session on startup (`createLocalRuntime`'s `resume` seed).
- **A new exec is a new process.** Each `openExec` runs a fresh
  `serve --stdio`; the previous daemon (whose stdin EOF'd when its exec closed)
  is gone. Recovery therefore means *new daemon + resume from the laptop's
  snapshot*, never re-attaching to the old in-pod process.
- **One session path.** Every runtime drives the TUI through the same
  `RemoteClient ↔ Connection` stack (AGENTS §7); a reconnect must rebuild that
  stack over a new channel, not fork a second code path.
- **Protocol changes are additive; version stays 1** (AGENTS §7): a new `ping`
  method an old peer doesn't know returns `MethodNotFound` (clean, catchable).

## Design

Two independent layers; both are needed (keepalive alone cannot survive a laptop
sleep, where no local timer fires).

### Layer 1 — Keepalive (prevent avoidable idle drops)

A lightweight application-level heartbeat over the existing peer keeps bytes
flowing both ways, so idle-timeout reapers (apiserver `streamingConnection`,
LB/router TCP idle) never fire during a quiet session.

- Add a no-op `ping` request to `@tentacle/protocol` (returns `{}`), handled
  daemon-side. App-level, not a WebSocket ping frame: Bun's client `WebSocket`
  (Web-standard) exposes no `ping()`, so a protocol ping is the portable choice.
- `RemoteClient` starts a timer (e.g. every 30 s; configurable, must be well
  under the smallest expected idle timeout) that sends `ping` while connected,
  and stops it on close/dispose. A ping that rejects (peer already closing) is
  swallowed — it is only a liveness probe, and it also doubles as *early*
  detection that then triggers Layer 2.
- Old daemon (version skew on `connect`, not relevant for attach where both ends
  are this build): `MethodNotFound` is caught and the pinger backs off silently.

### Layer 2 — Reconnect-and-resume (survive the drops that still happen)

On channel close, instead of dooming the TUI, transparently rebuild the attach:

1. Detect close centrally (the attach runtime observes the channel/peer close).
2. Enter a `reconnecting` UI state (a single status line, not a raw error): the
   prompt is disabled, a spinner-ish "reconnecting to <pod>…" shows.
3. Re-run the attach bring-up (`pod-runtime` attach path): preflight `--version`
   (skips re-injection — the binary is already there), `openExec` a new
   `serve --stdio`, and `createLocalRuntime` **seeded from the persisted record**
   (`store.load(currentUid)`), so the conversation returns intact.
4. On success: swap the live client/peer, clear the `reconnecting` state, re-emit
   the queued prompt the user just typed (don't lose "hey"). On repeated failure:
   bounded exponential backoff with a cap, then a clear, actionable terminal
   message — "pod connection lost; reattach with `tentacle attach <pod>
   --resume`" — never a raw `RpcError`.

Keep the reconnect logic in one place (the attach runtime wrapper in
`pod-runtime.ts` / a small `ReconnectingRuntime` around `createLocalRuntime`), so
`run` and `connect` can opt in later without duplicating it.

## Files to change (dependency order)

- `packages/protocol`: add the `ping` method schema (request `{}` → result `{}`);
  wire both ends of the union.
- `packages/daemon` (or wherever `Connection` handlers live): handle `ping`.
- `packages/client/src/remote-client.ts`: start/stop the keepalive timer; expose
  a close signal for the reconnect layer.
- `packages/cli/src/pod-runtime.ts`: factor the attach bring-up into a
  re-runnable step; wrap `createLocalRuntime` so a channel close triggers
  reconnect-and-resume with backoff and the `reconnecting` UI state.
- `packages/tui`: a `reconnecting` banner/state (small, additive) — **note the
  in-flight input-editing branch also edits `App.tsx`; land this after it merges,
  or keep the TUI surface to a minimal status prop to avoid a 3-way conflict.**

## Failure modes (and how state converges)

- **Idle (no sleep):** Layer 1 keeps it alive; no drop. If a timeout is shorter
  than the ping interval, Layer 2 reconnects.
- **Laptop sleep:** no timer fires; the socket dies. On wake, the first action
  (ping tick or user prompt) sees the closed peer → Layer 2 reconnects + resumes.
- **Pod restarted / evicted:** `openExec` fails or the binary is gone →
  re-injection runs; if the pod itself is gone, backoff exhausts → actionable
  message. No silent hang.
- **Reconnect mid-turn (model streaming when the drop happened):** the in-pod
  daemon and its turn are lost; the laptop's last *persisted* snapshot is the
  last completed turn (partial assistant output since the last turn is not
  persisted — AGENTS §7 persists `ChatMessage`s per turn). On resume the user re-
  issues the interrupted request. Documented, not silently half-applied.
- **Double close / reconnect race:** a generation token (as in the resize warm,
  `docs/feat/perf-resize-relayout.md`) guarantees only the latest reconnect commits.
- **Keepalive racing a real request:** the peer dispatches requests concurrently
  (AGENTS §7, `transport/peer.ts` — no per-connection mutex), so a `ping` never
  blocks `session/prompt`.
- **Permission broker identity across reconnect:** the single-broker invariant
  (AGENTS §7) must hold on the *new* runtime too — reuse the same
  `PermissionBroker` instance, do not build a second.

## Tests

- Keepalive: a fake peer/clock asserts a `ping` is sent on the interval and
  stops on close; a rejecting `ping` does not surface an error.
- `ping` handler: daemon returns `{}`; an old peer path returns `MethodNotFound`
  and the pinger swallows it.
- Reconnect: with a `FakeCluster`/fake exec channel, closing the channel drives
  the runtime into `reconnecting`, a new `openExec` is issued, the session is
  re-seeded from the store (same uid, same history), and the queued prompt is re-
  sent. Backoff caps and, when `openExec` keeps failing, converges on the
  actionable terminal message. Mutation check: break the re-seed (wrong uid) and
  confirm the history-restored assertion fails.
- Single-broker: a daemon-side broker spy confirms the reconnected runtime shares
  the one broker (regression mirror of the existing `runPodTui` test).

## Validation

`bun run check` green (typecheck + lint + full suite) against the baseline. A
manual soak: attach, idle past the real cluster's timeout, confirm the keepalive
holds; then force a drop (sleep / kill the exec) and confirm transparent
reconnect-and-resume with the typed prompt preserved.

## Notes / debt

- Scope is `transport`/`k8s`/`client`/`cli` plus a minimal TUI status surface —
  **not** the TUI render core, so it does not collide with the perf branch; the
  only TUI touch (a `reconnecting` banner) should be sequenced with the input
  branch.
- Layer 1 (keepalive) is small and self-contained and can land first; Layer 2
  (reconnect+resume) is the larger piece and the one that actually makes attach
  antifragile — keepalive without it only narrows the window.
- Not addressed here: `run` (ephemeral pod) reconnect — its pod is owned and
  deleted on exit, so a drop there usually means intentional teardown; revisit
  only if a use-case appears.
