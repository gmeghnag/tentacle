# feat/client-reattach — `RemoteClient` reconnects and resumes transparently

> **Status:** DONE — merged to `main` 2026-10-20 (one fresh-context Review: REQUEST-CHANGES, findings 1–8 addressed with red→green tests; no second Review by owner choice)
> **Branch:** `feat/client-reattach`
> **Type:** feat · **Size:** L (re-estimated in the Revision; was "M") · **Blast:** load-bearing · **Suited:** strong model executes; mandatory fresh-context Review (TUI-over-RPC one-session-path + single-broker invariants, AGENTS §7)

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** the client half of re-attach — reconnect, `open`
with the last cut, apply replay or resync — living in `RemoteClient` so every
frontend (TUI over `connect`/`attach`, the future mobile app) gets it without
code of its own.

Evidence: today a dropped socket rejects the in-flight `prompt` with
`connection closed` and nothing reconnects (parent Repro).
`client/src/ws-channel.ts:69-77` builds the token URL with `URL.searchParams`
and passes headers as the 2nd `WebSocket` argument — fine on Bun, likely not on
React Native (unverified; a mobile client brings its own `DuplexChannel`
adapter, the "a new target adds only a transport" shape of AGENTS §7).

Related: `docs/feat/pod-attach-resilience.md` (keepalive + reconnect for pod
`attach`, not started) — likely absorbed by this child; decide when promoting.

### Repro (`main` @ `0bfe86c`, 2026-10-20, bun 1.4.3)

*— claude-opus-5-5, 2026-10-20*

`.tentacle/tmp/client-reattach/repro.ts` — a real `SessionHost` + `Connection`
over `createChannelPair`, a scripted model (text, then a `shell` call that
needs approval), and a broker that holds the prompt until it is aborted. The
link drops while the approval is pending.

```ts
// Repro for feat/client-reattach on main: a dropped link mid-approval.
import { Agent } from "@tentacle/agent";
import { type ChatRequest, type ModelProvider, PermissionBroker, type StreamEvent } from "@tentacle/core";
import { RemoteClient } from "@tentacle/client";
import { Connection, SessionHost } from "@tentacle/daemon";
import { Method, Notification, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";

const script: StreamEvent[][] = [
  [{ type: "text", delta: "let me look" }, { type: "tool_call", toolCall: { id: "c1", name: "shell", arguments: '{"command":"ls"}' } }, { type: "done" }],
  [{ type: "text", delta: "done" }, { type: "done" }],
];
let turn = 0;
const model: ModelProvider = { id: "s", async *stream(_r: ChatRequest) { for (const e of script[turn++] ?? []) yield e; } };
let runs = 0;
const host = new SessionHost({
  defaultCwd: "/tmp/x",
  createAgent: () => {
    const permissions = new PermissionBroker();
    const agent = new Agent({
      model, tools: new ToolRegistry().register(shellTool),
      env: { id: "e", exec: async () => { runs++; return { stdout: "ok", stderr: "", exitCode: 0 }; }, readFile: async () => "", writeFile: async () => {} },
      requestPermission: (req, o) => permissions.request(req, o),
    });
    return { agent, permissions };
  },
});
const tick = () => new Promise((r) => setTimeout(r, 20));

// 1. client A starts a turn; the tool asks for approval; the link drops.
const [d1, c1] = createChannelPair();
new Connection(d1, host);
const prompts: string[] = [];
const broker = new PermissionBroker(async (req, o) => {
  prompts.push(req.title);
  return await new Promise((res) => o?.signal?.addEventListener("abort", () => res({ allowed: false, dismissed: true })));
});
const seen: number[] = [];
const a = new RemoteClient(c1, broker, undefined, { onError: (e) => console.log("onError:", e.message) });
await a.initialize();
const session = a.newSession(undefined, "S");
const events: string[] = [];
const sent = (async () => { for await (const e of session.send("list files")) events.push(e.type); })().then(
  () => "completed", (e: Error) => `rejected: ${e.message}`);
await tick();
console.log("prompts before drop:", prompts.length, "| daemon running:", host.get("S")?.running);
c1.close();
console.log("send ->", await sent, "| events:", events.join(","));
await tick();
console.log("after drop: session live daemon-side:", host.get("S") !== undefined, "| running:", host.get("S")?.running, "| tool runs:", runs);
console.log("RemoteClient has a reattach API:", ["reattach", "reconnect", "attach"].some((k) => k in a));

// 2. the same RemoteClient cannot be reused: its peer is dead.
const again = await a.snapshot("S").then(() => "ok", (e: Error) => `rejected: ${e.message}`);
console.log("same client, snapshot after drop ->", again);

// 3. a raw re-open with `since` at/after the request does NOT re-offer it.
const [d2, c2] = createChannelPair();
new Connection(d2, host);
const updates: string[] = [];
const raw = new RpcPeer(c2, { onNotification: (m, p) => { if (m === Notification.SessionUpdate) { const u = p as { seq: number; update: { type: string } }; seen.push(u.seq); updates.push(`${u.seq}:${u.update.type}`); } } });
await raw.request(Method.Initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } });
const full = (await raw.request(Method.Open, { sessionId: "S" })) as { epoch: string; resync: boolean };
await tick();
console.log("open without since -> resync:", full.resync, "| replay:", updates.join(" "));
const reqSeq = Number(updates.find((u) => u.endsWith("permission_request"))?.split(":")[0]);
updates.length = 0;
const pinned = (await raw.request(Method.Open, { sessionId: "S", since: { epoch: full.epoch, seq: reqSeq } })) as { resync: boolean };
await tick();
console.log(`open with since=${reqSeq} (the request's seq) -> resync:`, pinned.resync, "| replay:", updates.join(" ") || "(nothing)");
raw.close();
```

```
prompts before drop: 1 | daemon running: true
send -> rejected: connection closed | events: text,tool_start
after drop: session live daemon-side: true | running: true | tool runs: 0
RemoteClient has a reattach API: false
same client, snapshot after drop -> rejected: peer is closed
open without since -> resync: true | replay: 3:tool_call 4:permission_request
open with since=4 (the request's seq) -> resync: false | replay: (nothing)
```

Reading: (1) the session and its suspended turn survive daemon-side, but the
client's turn dies with `connection closed` and its dialog is withdrawn
(`PermissionRouter.connectionClosed`); (2) `RemoteClient` is single-use — its
peer is dead and nothing reconnects; (3) the two hazards 8a must handle: a
re-attach with `since` at the request's seq does **not** re-offer the pending
request (the `permission-events` obligation), and a resync replays
`3:tool_call` for a call the snapshot already lists (the cut sits at the
`history_commit` after the assistant message, seq 2: tool calls must be
upserted by id).

## Implementation

### Revision for 8a, verified on `main` @ `0bfe86c` — wins over the draft below

*— claude-opus-5-5, 2026-10-20*

The draft (2026-10-19, `main` @ `4914e9b`) predates 3a–7b. Every cited fact was
re-checked on `0bfe86c` (premise table below). Where this Revision and the draft
(including its "Re-baselined" note) disagree, **this Revision wins**; the draft
is kept below as dated evidence.

#### State check

- **Dependencies DONE on `main`:** 3c, 4, 7a — and 5, 5b, 6, 7b (`TODO.md`
  block "Sessions die with their connection", items 3a–7b all "DONE 2026-10-20").
- **No other code branch open:** `git branch --no-merged main` is empty; the
  two local branches (`feat/permission-events`, `feat/suspended-turn-resume`)
  are merged.
- **Parent decisions that bind 8a** (`docs/eval/session-reattach.md`
  §"Owner decisions…"): A (replay as notifications inside `open`), B
  (`turn_start{prompt}`), C (projected-transcript property), E (class + `seq`
  + catch-all), connection state in Ink `StatusBar` not `StatusLine` (→ 8b), D1
  (`since = {epoch, seq}`), D9 (pod-attach Layer 2 → 8b), split 8a / 8b.
- **8b boundary** (`docs/eval/client-reattach-frontends.md`): channel factories
  per runtime (`connect` / `attach` / `run`), `StatusBar`, persistence on
  resync, recreate from the store on a fresh process, pod-attach Layer 2. 8a
  stays **inert** for every shipped runtime: no caller passes a factory.

#### Obligations handed to 8a by merged tasks

| From | Obligation | How 8a meets it |
|---|---|---|
| `permission-events` Review finding 2 (`permission-events.md:1150-1164`; `hosted-session.ts:20-27`) | A re-attach with `since` at or past a pending request's seq does not replay it (Repro step 3), and `PermissionRouter.connectionClosed()` drops what the client holds (`permission-router.ts:135-143`, called at `remote-client.ts:186`). Never both. | With a factory, a drop does **not** call `connectionClosed`: router entries (and the on-screen dialog) survive the drop. On a **resync** the router keeps only the ids still pending in the replay (new pure `PermissionRouter.retainOnly(sessionId, ids)`), aborts the rest; a replayed known id is already deduped (`permission-router.ts:71-79`). Without a factory: today's `connectionClosed` (terminal drop). Test E2/E3. |
| `suspended-turn-resume` P4 (`suspended-turn-resume.md:105-112`; `hosted-session.ts:223-233`) | A turn resumed after a `serve` restart emits **no** `turn_start`; the snapshot's `turn` names it; the re-ask has a fresh `requestId` (P5, `hosted-session.ts:294`). | Turn state on resync comes from `snapshot.turn`, never from a `turn_start`. The client's own turn keeps waiting; its re-sent `prompt{turnId}` acks `{turnId}` (the key is restored, `hosted-session.ts:212-214,251-261`). The old request id is not in the replay → `retainOnly` withdraws its dialog; the re-ask prompts once. Test E4 (restored session via `SessionHost` persistence). |
| `suspended-turn-resume` scope (`suspended-turn-resume.md:386-391`) | No shipped client can answer a resumed request until 8a re-attaches by id. | 8a re-attaches by id; reaching it from `connect` is 8b. |
| `session-history-cut` (`session-history-cut.md:355-362`; `protocol/src/session.ts:165-168`) | A replayed `tool_call` may name a call the snapshot already lists: upsert by `toolCallId`. Repro step 3 shows it (`3:tool_call` after a cut at seq 2). | The turn adapter drops a `tool_start` for an id the last reset already showed (and the TUI marks that call running); the test projection upserts. |
| `session-registry` finding 4 (`session-registry.md:1045-1056`) | An oversize attach burst can close a healthy client on every reconnect (backpressure close). | Bounded by backoff + the flap guard (attempt counter resets only after 10 s up). Documented, not fixed (daemon side). |
| `session-registry` hole 3 (`session-registry.md:135-145`) | A client offline at close time recreates the session from its own history. | Accepted there; 8a recreates from the newest history it has read (see design R3). |
| `DaemonRestarted` (`protocol/src/jsonrpc.ts:42-43`, `persisted-session.ts:233`) | A turn a restart interrupted is cached as ended with `DaemonRestarted`. | The re-sent `prompt{turnId}` returns `ended` → the turn fails with that code (already handled by `remote-session.ts:131-144`). |

#### Q1–Q12

| Q | Status | Where |
|---|---|---|
| Q1 unknown types dropped | **Resolved** (3a) | `protocol/src/updates.ts:189-218` (catch-all, required `seq`, `mandatory?: true`); `client/src/mapping.ts:35-51` (`classifyUpdate`). Experiment 6 is obsolete. |
| Q2 prompt not in the stream | **Resolved** (3b) | `updates.ts:99-103`; emitted `hosted-session.ts:621`. Cut does not move at turn start (`:671-677` moves it only at `history_commit`/`finishTurn`), so a resync before the first commit replays `turn_start` — confirmed by the Repro (cut = seq 2, after `turn_start` 1 + text 2 committed). |
| Q3 turn status at the cut | **Resolved**: (a) `snapshot.turn` (`session.ts:195-206`, `hosted-session.ts:541`); `state: "suspended"` **decided not added** (`permission-events.md:96-100`: derivable from the replayed request). (b) `PromptResult.ended` (`session.ts:120-126`, `hosted-session.ts:606-611`). | |
| Q4 `open` in resync mode | **Resolved** (registry, decision A): Option A as built — replay as notifications before the response; resync replays from the cut | `session.ts:213-233`; `hosted-session.ts:474-495`; `connection.ts:249-264` (a retried open on one connection drops the old attachment first). |
| Q5 withdraw a broker prompt | **Resolved** (7a) | `core/src/permission.ts:52-60` (`signal`); router `abort` action, `remote-client.ts:479-502`. |
| Q6 `since` comparable | **Resolved** (3c, D1) | `session.ts:170-182`. Also verified: `seq` is per **incarnation**, +1 across compaction epochs (the barrier's own seq opens the epoch, `hosted-session.ts:817-820`), and restarts at 0 with a new epoch per incarnation (`:228-233`). |
| Q7 status via `StatusLine` | **Decided** (owner, list item after G): `StatusBar` | → 8b. 8a only exposes `onLinkStatus`. |
| Q8 401 not observable | **Decided** (probe) | → **8b** per `client-reattach-frontends.md:23-26` — contradicts the draft's Files item 4; see R-Q1. |
| Q9 `compact` has no key | **Decided** (draft): never auto-re-sent | `session.ts:139-143` (no id). A drop mid-compact rejects the caller with a "link lost" error; the barrier, if it happened, arrives on recovery. |
| Q10 predecessors port the client | **Resolved** | `remote-client.ts:217-230` (open), `:310-314` (prompt ack), `:133-142` (permission events). |
| Q11 split | **Decided** (owner): 8a + 8b | Size re-estimated below (R-Q4). |
| Q12 pod-attach verdict | **Decided** (D9) | `docs/feat/pod-attach-resilience.md:7`. |

#### Premise table (the draft's citations)

| Draft cites | Status | On `0bfe86c` |
|---|---|---|
| `ws-channel.ts:69-77` token URL + headers | DRIFTED | `:66-77`, same code. |
| `peer.ts:360-363` + `updates.ts:85-94` closed union drops unknown types | FALSE | catch-all since 3a (`updates.ts:204-218`). |
| `agent/src/session.ts:66-68` prompt pushed synchronously | TRUE | `:65-67`. |
| `daemon/src/mapping.ts` has no user-message case | FALSE | `turn_start{prompt}` (`hosted-session.ts:621`). |
| `core/src/permission.ts:44,68-70` no cancel | FALSE | `signal` (`:52-60`). |
| `status-line.ts:1-16,49-71` raw writes | TRUE | |
| `ws-server.ts:166-173` 401 vs 426 | DRIFTED | `:206-213`. |
| `remote-client.ts:145,160-162,105-106` (`session/new`, long-lived prompt, `request_permission`) | FALSE | ported (Q10). |
| `pod-runtime.ts:445` `openExec` | TRUE | also `:259`. |
| `serve.ts:105-120` stdio ends on stdin EOF | DRIFTED | `:209-215`. |
| `peer.ts:321-325` response after the awaited handler | DRIFTED | `handleRequest` `:320-371`; LBA half 1 holds. |
| `remote-client.ts:101` routes only to a registered handler | DRIFTED | `:153`; still drops an update with no handler. |
| `hosted-session.ts:83` `seq: ++this.seq` | DRIFTED | `:587`; single emit path (`:587-591`), ring push `:588`, replay `:490-492` sends the same frames. LBA half 2 holds. |
| `channel.ts:36-45` FIFO | TRUE | |
| `local-runtime.ts:117-121,210-221`; `connect.ts:17-29` | DRIFTED | `local-runtime.ts:130-142,231`; `connect.ts:46-61`. |
| `remote-client.ts:64-87` one `peer` per client | DRIFTED | `:84-113`; `peer` is `readonly` — the generation rebuild is new code. |
| `channel.ts:16-17`, `peer.ts:119,234-250` close path | DRIFTED | `peer.ts:131-132,246-264`; holds. |
| `peer.ts:260` / `ws-channel.ts:20-23` late frames | DRIFTED | `peer.ts:280` (no `closed` check); `ws-channel.ts:20-23` holds. |
| `remote.test.ts:22-31,80-105`; `pod-runtime.test.ts:162` | TRUE / DRIFTED | `:22-32,80-106`; `SpyBroker` at `:164`. |
| `state.ts:183`, `App.tsx:350-352`, `resume.ts:9` | DRIFTED | `state.ts:188`, `App.tsx:379-380`, `resume.ts:9`. |
| `permission-ui.ts` broker-driven | TRUE | |
| `methods.ts:51`, `remote-client.ts:176-178` cancel is a notification | DRIFTED, still TRUE | `methods.ts:54`; `CancelParams{sessionId}` only (`session.ts:130-135`). |
| Precondition "cancel becomes `cancel{sessionId, turnId}`" | FALSE | still a notification without `turnId` (`connection.ts:290-299`). |
| `errors.ts:13` `UnknownSession` | DRIFTED | `protocol/src/jsonrpc.ts:32`. |
| `App.tsx:45-51,963`, `state.ts:143` | DRIFTED | `App.tsx:47-55,1018`, `state.ts:148`. |
| `mapping.ts:78` `updateToEvent` | DRIFTED | `:116`. |
| `local-runtime.ts:65-94` `persistingController` | DRIFTED | `:73-104`. |
| `remote-session.ts:42-47` enqueue reconcile | DRIFTED | `:85-98`. |
| Precondition "assumed 4" (open / UnknownSession / close / detach / model-proxy) | TRUE | `session-host.ts:97-113`, `connection.ts:101-110`. |
| Precondition "assumed 7" permission events | TRUE, plus a **new fact**: the client half is `PermissionRouter` (`permission-router.ts`), not reducer state | design difference D2 below. |

#### Differences from the draft

| # | Draft | Revision | Why |
|---|---|---|---|
| D1 | Reducer keeps `committed`, `tail`, emits a `committed` persist effect | Reducer is a **stream-ordering machine only** (phase, epoch, applied, buffer, turn, pending ids, reopen guard). The newest history the client read is cached per session in the shell (seed, resync snapshots, `snapshot()` results) for recreate. `onCommitted` → 8b. | The TUI keeps its own transcript; persistence stays `persistingController` until 8b. Fewer states to test; no second copy of history. |
| D2 | Reducer owns `pending` and calls the broker once per `requestId` | `PermissionRouter` (7a) stays the one owner of prompts. Reducer reports the ids pending after a resync; the router gains `retainOnly`. With a factory, a drop no longer calls `connectionClosed`. | The router is built, tested and pod-trust-reviewed; a second owner would be a place for them to disagree. Meets the permission-events obligation. |
| D3 | Reset output folds the buffered `turn_start`'s prompt into `reset.messages` | The adapter emits `user_message{text}` for a `turn_start` applied **after** a reset in the same turn generator. | Exact order: an idle `background_exit` can sit between the cut and the `turn_start`. |
| D4 | Turn ended while away → detect via `snapshot.turn ≠ mine` | After **every** recovery, if the client's own turn has not ended in its view, re-send `prompt{turnId}` (same key). Running → no-op ack; ended → `ended` ends it; never received → starts it. Not on a recreated session (→ `turn_lost`). | One rule covers lost-before-send, ambiguous ack and ended-while-away (`hosted-session.ts:606-611` checks the key first). |
| D5 | `cancel{turnId}` command assumed | `cancel` stays a notification. An Esc while the link is down marks the turn; on recovery, if that turn still runs, `session/cancel` is sent. | No wire change (no `PROTOCOL_VERSION` bump). |
| D6 | Unknown mandatory → `fatal`, stop reconnecting the session | Same as today: fail the turn loudly + cancel it (`remote-session.ts:165-170`); the seq still counts as applied. `fatal` only from the reopen guard. | Keeps the 3a-reviewed behaviour; a "too old client" error still surfaces. |
| D7 | `webSocketChannelFactory` + 401 probe in 8a (Files 4) | **→ 8b** (R-Q1). 8a defines `ChannelError{kind}` so a factory can say "unauthorized" (terminal). | The 8b doc already claims Q8; the factory is per-transport wiring and inert in 8a. |
| D8 | Ack deadline (15 s) closes a half-open link | **→ 8b** (R-Q2). | Without a factory it would turn today's hang into a new terminal error — a behaviour change for every shipped runtime, against "8a is inert". |
| D9 | JSON test vectors + generator + drift test | **Deferred to the mobile-app eval** (R-Q3). Reducer table tests stay (TS). | No non-TS client exists; the vectors would be speculative and add a generator + drift gate to an already-L task. |
| D10 | Session ids client-generated | Same; `RemoteSession` mints one when the frontend gives none. | Confirmed needed: buffering starts before `open` is sent. |
| D11 | TUI: `history_reset` only | `history_reset` (items rebuilt by `messagesToItems`, unresolved calls of a running turn shown running) + `user_message`; types defined structurally in `tui/src/state.ts` (the TUI does not depend on `@tentacle/client`). | `messagesToItems` marks every call `ok` (`resume.ts:30`); after a mid-turn reset a call awaiting approval would show as done. |
| D12 | Existing fake-daemon tests unaffected | Fakes that send non-contiguous `seq` (`remote.test.ts:887,936,950,1000`) are adjusted to contiguous seqs. | With contiguity, `seq: 999` as a first update is a gap → resync; those tests pin classification, not seq. |
| D13 | Size M | **L** (R-Q4). | ~1.5–2 k lines incl. tests; a new seam (generations) + the property harness. |

#### Revised design

**R1 — `client/src/session-reducer.ts` (pure).** One state per opened session:
`phase: "opening" | "resyncing" | "live" | "down" | "failed"`, `epoch`,
`applied`, `buffer` (sorted, unique by seq), `turn` (`turnId | null`),
`pending` (permission request ids), `reopens` (timestamps). Inputs:
`open_sent`, `update{params}`, `open_result{created, resync, epoch}`,
`snapshot{since, turn}`, `link_down`, `recreated{epoch}`. Outputs:
`reset{turn, keepRequests}`, `update{seq, update}`, `error{error}` (malformed
known / unknown mandatory — today's behaviour), `turn_lost`, `failed{reason}`.
Effects: `fetch_snapshot`, `reopen` (open without `since`). Rules as the draft
§Design 1, minus `committed`/`tail`, plus: replay mode with `result.epoch ≠
state.epoch` → treated as resync (defensive); `since()` = `{epoch, applied}`
only in `live`/`down` with a known epoch, else none.

**R2 — `client/src/link-machine.ts` (pure).** Backoff `min(30 s, 0.5 s ·
2^attempt) · random()`, attempt reset only after ≥ 10 s up, terminal on
`ChannelError{kind: "unauthorized"}`, `VersionMismatch` at `initialize`, and
`dispose`; `LinkStatus` for listeners. Plus the recovery rules as a pure
function `onRecovery(command, {recreated, turnRunning, …}) → "send" | "reject" |
"drop"` (the draft's outbox table, with D4/D5/Q9).

**R3 — the shell, `RemoteClient`.** New options `channelFactory`, `clock`,
`random`. The constructor channel is generation 0; without a factory a drop
stays terminal exactly as today (the inert default, pinned by a test). Per
generation: new `RpcPeer` with the same handlers (model-stream handlers use the
peer that received the request), `initialize`, then per open session
`open{sessionId, since?}` with the reducer in `opening` **before** the frame is
sent; resync → paged `snapshot` (the existing `readSnapshotPages` guards) →
reducer. `UnknownSession` → `open{sessionId, messages: newest history read}`
(or `create: true` if none) → `recreated`. Session commands wait until their
session is `live` on the current generation: `prompt`/`enqueue` are re-sent
with their keys after a drop (not after a recreate), `resolve_permission`
answers given while down are held and sent after recovery
(`PermissionNotPending` stays silent), `compact` rejects on a drop,
`snapshot()` retries (read-only), `close` while down resolves at once (the
daemon reaps it). Late frames of an old generation are ignored. One broker,
never rebuilt.

**R4 — `RemoteSession` (adapter).** `send` yields `SessionEvent = AgentEvent |
{type: "history_reset", messages} | {type: "user_message", text}`. It survives a
drop when a factory is set, ends on its own `turn_end` / an `ended` ack, fails on
`turn_lost` ("the daemon lost the session; the turn in flight was not re-run")
or `failed`.

**R5 — TUI (minimal).** `SessionController.send` yields `SessionEvent`;
`state.ts` gains pure `applySessionEvent` (delegates to `applyEvent`;
`history_reset` → `messagesToItems` + running calls; `user_message` → user
item); `App.tsx:379-380` calls it. Known limit (cosmetic): a reset shows
loop notes (`context_note`: nudge, background note) as user bubbles, because
`messagesToItems` cannot tell them from user messages; live they are hidden.

#### Files (dependency order)

1. `packages/client/src/session-reducer.ts` (new) · 2. `link-machine.ts` (new) ·
3. `permission-router.ts` (`retainOnly`) · 4. `remote-client.ts` (generations,
factory, recovery) · 5. `remote-session.ts` (adapter, client id) ·
6. `mapping.ts` (`SessionEvent` types) · 7. `index.ts` · 8. tests:
`session-reducer.test.ts`, `link-machine.test.ts`, `permission-router.test.ts`
(+cases), `reattach.e2e.test.ts`, `support/{link-cutter,transcript}.ts`,
`remote.test.ts` (shell cases + D12 adjustments) · 9. `packages/tui/src/state.ts`,
`App.tsx`, `test/state.test.ts`, `test/app.test.tsx` (one frame test).
No protocol / daemon / transport / cli change; `PROTOCOL_VERSION` stays 6.

#### Tests (replaces the draft's §Tests where they differ)

- **A (property, parent C):** real `SessionHost` + `Connection` per generation,
  `LinkCutter` (one counter, both directions), scripts S1 (text, gated pause
  mid-round, `shell` call needing approval, more text) and S2 (turn, `compact`,
  turn). For every `k ∈ 1..N` × path {(a) same client re-attaches with its
  `since`, (b) fresh `RemoteClient` + new broker opens the id, (c) same client,
  `since` stripped by a test decorator → resync}: at each quiescent point
  (model gate held / approval pending) and at the end, `transcript(client) ==
  transcript(reference at the daemon's last seq)`; applied seqs contiguous after
  the last reset; model calls and tool runs equal the uninterrupted run (tool
  runs = 1). A bridge test pins `transcript(messages) == transcript(stream)`.
- **E (obligations):** E1 broker prompted once across a drop (same client);
  E2 drop with `since` past the pending request → dialog kept, Approve after
  recovery runs the tool once (red on `main`'s `connectionClosed`); E3 answered
  on another client while away → dialog withdrawn, held answer not effective;
  E4 restored `serve` session (persistence fake): no `turn_start`, own turn
  keeps waiting, old dialog withdrawn, re-ask prompted once, Approve runs once.
- **B/C/D/TUI** as the draft (reducer table, link machine with injected
  clock/random, shell: generation guard, single broker, inert default), minus
  the WS-factory and vector cases (R-Q1, R-Q3).
- Mutations (each must turn a test red, then revert): the draft's list, plus
  "call `connectionClosed` on a drop with a factory" (E2), "require
  `turn_start` to mark a turn running" (E4), "no `retainOnly` on resync" (E4/E3).

#### Owner answers (2026-10-20) — all four recommendations accepted

R-Q1 → 8b · R-Q2 → 8b · R-Q3 → deferred to the mobile-app eval · R-Q4 → one L task, no split.

The questions as asked:

- **R-Q1 — WebSocket factory + 401 probe (Q8) in 8b, not 8a?** *Recommend
  8b* (D7): the 8b doc claims it; in 8a it would be unused code.
- **R-Q2 — Ack-deadline liveness in 8b?** *Recommend 8b* (D8): it only makes
  sense with a factory, and alone it changes today's behaviour.
- **R-Q3 — JSON test vectors deferred to the mobile-app eval?** *Recommend
  defer* (D9): TS table tests now; vectors when a Swift/Kotlin client exists.
- **R-Q4 — Accept 8a as L (no further split)?** *Recommend yes*: splitting
  the pure modules from the shell would land code whose only real proof (the
  property harness) arrives in the second half. L × load-bearing is already
  routed to a strong model + fresh-context Review.

---

*The 2026-10-19 draft follows (dated evidence; superseded where the Revision above disagrees).*

> **Owner decisions (2026-10-19):** the open questions below are resolved in
> the parent, `docs/eval/session-reattach.md` §"Owner decisions after the
> children's Implementation drafts" (A–G, D1–D10). Where a question or
> design point here disagrees, the parent decision wins.

> **Re-baselined on 3a/3b/3c (2026-10-20, claude-opus-5-5).** `session-event-stream`
> is fully built (`docs/feat/session-wire-classes.md`,
> `docs/feat/session-turn-events.md`, `docs/feat/session-history-cut.md`).
> The text below is aligned to the as-built shapes; this note wins over any
> older wording (incl. the 2026-10-19 Review and the Experiments, which are
> dated evidence against `main` @ `4914e9b` and are not re-run):
> - **Envelope (Q1, 3a):** `{sessionId, seq, mandatory?: true, update}` — the
>   class is `mandatory: true` (absent = display), not `class: …`; `update` is
>   `anyOf[SessionUpdate, UnknownSessionUpdate]`; `seq` required.
>   `classifyUpdate` (`client/src/mapping.ts`) already implements the rule.
> - **Turn bracket (Q2/Q3b, 3b):** `turn_start{turnId, prompt: string}` (`""`
>   for a continuation turn), `turn_end{turnId, stopReason, error?}`;
>   `prompt{turnId}` acks at once; a re-sent `prompt` for an ended turn returns
>   `{turnId, ended: {stopReason, error?}}` (the field is `ended`, not
>   `outcome`); `enqueue{id, turnId}` is bound to its turn.
> - **Cut (Q6, 3c):** `since` is a `HistoryCut = {epoch: string, seq: int}`
>   (owner D1). Meaning: every update with `seq ≤ since.seq` is reflected in
>   `messages`; replay `seq > since.seq` of the **same epoch** carries the rest.
>   `seq` is compared only within one epoch; `epoch` only for equality. The
>   epoch changes per session incarnation and per compaction.
> - **Snapshot (Q3a, 3c):** `snapshot{cursor?, limit?}` → `{messages, since?,
>   turn?: {turnId}, cursor?}`; `since`/`turn` on the first page only; `turn` =
>   the turn running **at the cut**. There is no `state` yet: `suspended` is
>   `permission-events`' to add (it owns suspension). A cursor of an older epoch
>   → `StaleCursor` (-32011). `RemoteClient.snapshot` already pages (200 per
>   page), restarts on `StaleCursor` (≤ 3) and fails loudly on a cursor that
>   makes no progress or past 10 000 pages — reuse it in `fetch_snapshot`.
> - **History ↔ stream (3c):** every message the agent loop pushes has an
>   update — prompt → `turn_start`, steer → `steer`, assistant text/tools →
>   chunks / `tool_call` / `tool_call_update`, nudge and background note →
>   `context_note{text, reason}` (display). Two rules the reducer must keep:
>   **tool calls are upserted by `toolCallId`** (an assistant message in the
>   snapshot lists its calls before their `tool_call` updates, so a replay can
>   re-announce one), and whitespace-only assistant text of an empty round is
>   live-only (the agent drops that round from history).
> - **Barrier (3c):** `history_replaced{reason: "compact"}`, mandatory.
> - **`session-registry`** (re-baselined the same day): `open{sessionId,
>   since?: HistoryCut, create?, messages?}` → `{sessionId, epoch, created,
>   resync}`; no separate `incarnation` (the epoch is it).
> - `PROTOCOL_VERSION` is 4 after 3c (registry → 5, this child bumps again only
>   if it changes the wire).

*— claude-opus-5-5, 2026-10-19 (draft, awaiting owner approval)*

Verified against `main` @ `4914e9b` (v1 code; children 3, 4, 7 not implemented).
Experiments live in `.tentacle/tmp/client-reattach-impl/` (gitignored) and are
pasted in full under **Experiments** below. Line numbers are `main` today; the
v2 children will move some of them — the executor re-checks each cited fact
on the post-children tree before editing (§0: a contradiction stops the work).

### Open questions / contradictions (owner decision needed before Execution)

Each item names the sibling that should own it and my recommendation. Q1–Q5
are **interface requirements on the unimplemented children**; if a child
lands without them, this plan cannot meet the parent property.

- **Q1 — Unknown event types are dropped by the peer today, seq included
  (Experiment 6).** `RpcPeer` validates every inbound notification
  (`transport/src/peer.ts:360-363`) against `SessionUpdateSchema`, a closed
  `discriminatedUnion` (`protocol/src/updates.ts:85-94`); an unknown `type`
  is reported to `onError` and never delivered, so its `seq` vanishes. A
  client with contiguity checks then sees a gap on *every* future display
  event → a forced-resync loop; a client without them silently tolerates
  real gaps. The parent's "ignore unknown display, fail loudly on unknown
  mandatory" (point 14) is **not implementable** unless the envelope carries
  the class and survives validation. **Recommendation (owner:
  `session-event-stream`):** `session/update` params become
  `{sessionId, seq, class: "display"|"mandatory", update}` where the `update`
  schema has a catch-all member (`{type: string}` passthrough) after the known
  ones; `seq` becomes required. The client applies `class` only for unknown
  types. **→ Built in 3a** as `mandatory?: true` (see the re-baseline note).
- **Q2 — The in-flight turn's user prompt is not in the stream.**
  `Session.send` pushes the user message synchronously
  (`agent/src/session.ts:66-68`) and no update carries it
  (`daemon/src/mapping.ts` has no user-message case). If the cut sits before
  that push (first round of a turn not committed yet), a resync rebuilds
  `messages` *without* the prompt and the replay has no event for it → the
  recovered transcript lacks the user bubble — the parent property fails for
  every drop in a turn's first round. **Recommendation (owner:
  `session-event-stream`):** `turn_start{turnId, prompt?: ContentBlock[]}`
  (absent for a continuation turn). It is also what a second device needs to
  render a turn it did not start. **→ Built in 3b** as `prompt: string` (`""`
  for a continuation turn).
- **Q3 — Turn status at the cut.** On resync, a `turn_end` with `seq ≤ since`
  is not replayed; the client cannot tell whether a turn is still running, or
  how *its own* turn ended. **Recommendation:** (a) the first `snapshot` page
  carries `turn?: {turnId, state: "running"|"suspended"}` as of its `since`
  (owner: `session-event-stream`); (b) the lifetime idempotency map (parent
  point 4, F8) stores `turnId → {ack, outcome?}`, and a re-sent
  `prompt{turnId}` for an ended turn returns `{turnId, outcome:{stopReason,
  error?}}` — so the client learns its own turn's end after any resync without
  a new method (owner: `session-event-stream`). **→ Built:** (b) in 3b as
  `PromptResult.ended`; (a) in 3c as `turn?: {turnId}` (running at the cut) —
  `state: "suspended"` is deferred to `permission-events`.
- **Q4 — What `open` does in resync mode.** `session-registry` says
  "live → attach + `{replay}` or `{resync: true}`" but not whether the sink is
  attached and what is replayed on resync. This plan assumes **Option A**:
  `open{sessionId, since?}` always attaches the sink in the same tick as it
  computes the replay (registry's own second assumption); in `replay` mode it
  sends `seq > since`, in `resync` mode it sends `seq > committedSeq` (the
  round in flight) — both as ordinary `session/update` notifications, **not**
  inline in the result. The client then pages `snapshot` and applies buffered
  events with `seq > snapshot.since`. A fresh client (no `since`) is the same
  path. Fallback if the registry picks otherwise: snapshot first, then
  `open{since: S}` (two round trips, one extra resync on a race). Owner:
  `session-registry`. Notifications-not-inline matters because live events can
  overtake the `open` response anyway (Experiment 1), so inline replay buys
  nothing and needs a second ordering rule.
- **Q5 — Withdrawing a pending broker prompt.** When `permission_resolved`
  (another device answered), `turn_end` or a resync removes a request, the
  TUI dialog must close. `PermissionRequester` has no cancel
  (`core/src/permission.ts:44`; `PermissionBroker.request`, `:68-70`).
  **Recommendation (owner: `permission-events`, which must already close the
  dialog on `permission_resolved`):** additive `PermissionRequest.signal?:
  AbortSignal`; `permission-ui.ts` closes the dialog on abort and the client
  never sends an answer for an aborted request. This plan assumes it; if
  `permission-events` lands without it, this child adds it (core + tui, ~20
  lines) and the Files list grows by two.
- **Q6 — `since` is "opaque" but the client must compare it.** Dedupe
  (`seq ≤ since`) and contiguity are numeric comparisons. Recommendation: the
  spec says `since` is a **seq number with one meaning** — "every event with
  `seq ≤ since` is reflected in `messages`" — clients may compare it with
  event seqs and must derive nothing else (granularity stays the daemon's).
  Owner: `session-event-stream` (wording only). **→ Built in 3c** with the
  epoch (D1): `since = {epoch, seq}`, `seq` comparable within one epoch.
- **Q7 — "reconnecting…" cannot go through `StatusLine` (contradicts this
  doc's Review).** `StatusLine` writes raw `\r`/ANSI to the terminal
  (`cli/src/status-line.ts:1-16,49-71`) and AGENTS §7 requires it to be
  `finish()`ed *before* Ink mounts; mid-session it would corrupt Ink's frame —
  the exact bug the Review wanted to avoid. **Resolution in this plan:** the
  link status is Ink-rendered state: the runtime exposes `link` (a
  subscribable `LinkStatus`), the TUI renders it in `StatusBar`
  (`tui/src/components/StatusBar.tsx`, mounted at `App.tsx:963`). The Review's
  intent (no raw writes) holds; its mechanism was wrong.
- **Q8 — "stop retrying on 401" is not directly observable on Bun.** A
  rejected upgrade surfaces as `error` + `close(1002, "Expected 101 status
  code")`, for 401 *and* any other non-101 (403, a proxy's 502), vs
  `close(1006)` for unreachable (Experiment 5). The daemon answers a plain GET
  with 401 for a bad token and 426 for a good one
  (`daemon/src/ws-server.ts:166-173`). **Resolution:** on a 1002 the WebSocket
  channel factory makes one `fetch` probe (same URL as http(s), same
  `Authorization`): 401 → terminal `unauthorized`; anything else → transient.
  No daemon change.
- **Q9 — `compact` has no idempotency key in the parent design.** An
  ambiguous ack cannot be retried safely (a second compaction costs a model
  call and summarises a summary). Plan: never auto-re-send `compact`; if the
  recovered stream shows `history_replaced` it resolves, else it rejects with
  `LinkLost` and the user retries. Cheap alternative if the owner prefers:
  `compact{id}` in `session-event-stream`.
- **Q10 — Predecessors must port the client minimally.** Children 3/4/7
  remove `session/new`, the long-lived `prompt` result and
  `session/request_permission` — all consumed by the client today
  (`remote-client.ts:145,160-162,105-106`). Each must keep `bun run check`
  green, so each necessarily ports `RemoteClient`/`RemoteSession` to the new
  wire *without* reconnect. This plan builds on that port; it does not redo
  it. Confirm the predecessors' Implementations say so.
- **Q11 — Size: as scoped by the Review this is L** (client pure modules +
  shell + vectors + property test, cli wiring for three transports, TUI). Not
  XL, but two independent risk surfaces. **Proposed split** (recommended):
  **8a `client-reattach`** (this doc): the client package + the minimal TUI
  type/reducer change that the new output forces; reconnect is inert until a
  frontend passes a channel factory. **M · load-bearing.**
  **8b `client-reattach-frontends`** (new eval, to be created by the owner —
  I may edit only this doc): channel factories for `connect` / `attach` /
  `run`, persistence on resync, `--resume`-style recreate from the store,
  `LinkStatus` in `StatusBar`, absorbs `pod-attach-resilience` Layer 2.
  **M · load-bearing.** The sections below mark 8b items with **[8b]**; if
  the owner rejects the split, everything ships here as L.
- **Q12 — `pod-attach-resilience` verdict.** Layer 2 (reconnect-and-resume)
  is **absorbed** by 8b: the attach channel factory re-runs `openExec`
  (`cli/src/pod-runtime.ts:445`); the new `serve --stdio` is a new process
  (the old one ends on stdin EOF, `cli/src/serve.ts:105-120`), so `open`
  returns `UnknownSession` and the client recreates from its committed
  messages — exactly that doc's "new daemon + resume from the laptop's
  snapshot", now through the one session path. Layer 1 (keepalive) is **not**
  absorbed and that doc's premise is wrong: Bun 1.4.3's client `WebSocket`
  *does* have `ping()` and the server receives it (Experiment 4), so the exec
  keepalive is a WS ping in `k8s/src/exec-channel.ts` — no protocol `ping`
  method. It matters more after `background-process-groups`: an idle drop
  ends the stdio daemon and its exit net kills the user's background jobs.
  Recommend: shrink `pod-attach-resilience` to Layer 1 (S, contained); whether
  the apiserver/LB idle timers count WS pings is unverified (verify on a real
  cluster in that task).

### Load-bearing assumption

**Seq alone — never arrival order, never which frame carried an event — is
sufficient to merge replayed, live and post-snapshot events into one correct
sequence; and arrival order really cannot be trusted.** The whole reducer
design (buffer per session from *before* `open` is sent, apply strictly by
seq, dedupe `seq ≤ applied`, treat a gap as a forced resync) stands on it.

Proof, both halves:

1. *Arrival order cannot be trusted:* `RpcPeer.handleRequest` `await`s the
   handler before sending the response (`transport/src/peer.ts:321-325`), so
   even a fully synchronous attach yields at least one microtask before the
   response frame; a live update emitted in that window goes out first.
   Experiment 1 shows it: the notification `seq=11` arrives **before** the
   response of the request that attached the sink. So a client that waits for
   the `open` result before routing updates (today: `RemoteClient` routes only
   to a registered handler, `client/src/remote-client.ts:101`, and drops
   anything else) would lose them.
2. *Seq is sufficient:* `HostedSession.emit` stamps `seq: ++this.seq`
   per session for every emitted update (`daemon/src/hosted-session.ts:83`) —
   monotonic, +1, one counter per session — and one connection delivers frames
   in order (`transport/src/channel.ts:36-45`: FIFO microtasks; WebSocket is
   ordered). `session-event-stream` keeps this counter per session for its
   lifetime (its Review: "`seq` per-session monotonic") and Q1 makes every seq
   reach the client. Under those two facts a client that has applied
   `1..n` needs exactly `n+1` next; anything else is a duplicate (drop) or a
   gap (resync).

If Q1 is rejected (unknown types still dropped by validation), half 2 fails and
the plan must change (contiguity could no longer be checked) — STOP and report.

### Preconditions

Verified on `main` unless marked *(assumed: child N)*.

- **One session path.** `createLocalRuntime` builds one `RemoteClient` over a
  `DuplexChannel` (`cli/src/local-runtime.ts:117-121`) for worker
  (`:210-221`), pod `run` (`pod-runtime.ts:259,276`) and `attach`
  (`:445,462`). `connect` builds `RemoteClient` directly
  (`cli/src/connect.ts:17-29`) — same class, no persistence. Reconnect lives
  in `RemoteClient`, so all four get it from one place.
- **The `RemoteClient` object can outlive its channel.** It holds the broker,
  the model provider and the handler maps (`remote-client.ts:64-86`); only
  `peer` is per-channel (`:87`). Rebuilding the peer per channel "generation"
  keeps the **single `PermissionBroker`** (AGENTS §7): reconnect never
  constructs a broker.
- **The drop is observable before callers see the rejection.** A channel has
  one close handler, owned by the peer (`transport/src/channel.ts:16-17`,
  `peer.ts:119`); on close the peer rejects every pending request with
  `connection closed` (`peer.ts:234-243`) and aborts inbound handlers
  (`:247-250`, which stops a laptop-served model stream). A client-side
  channel decorator that wraps `setOnClose` sees the drop first, without a
  transport change (Experiment 3: `onDrop` runs, then the rejection observes
  `dropped=true`).
- **Late frames on a dead generation are possible.** `RpcPeer.receive` does
  not check `closed` (`peer.ts:260`) and `WebSocketChannel` forwards messages
  regardless of its `closed` flag (`client/src/ws-channel.ts:20-23`). So the
  client needs its own generation guard (ignore callbacks whose generation is
  not current).
- **The ambiguous-ack case is real and reproducible in memory.** Experiment
  2b, `k=5`: the `session/prompt` frame reached the daemon (model called once)
  and the link died before the response; the client got `connection closed`.
  Without a key the re-send runs the turn twice; without a re-send in the
  `k<5` case the prompt is lost.
- **Drop at every frame is implementable with existing seams.**
  `createChannelPair` (`transport/src/channel.ts:31-66`) + a send-wrapping
  decorator with one global counter cuts the link after exactly frame *k* in
  either direction, deterministically (Experiments 2, 2b, 11 consecutive k).
  Real daemon objects run in memory (`Connection`, `SessionHost`,
  `ScriptedProvider`, `RecordingGatedProvider` patterns in
  `client/test/remote.test.ts:22-31,80-105`; `SpyBroker` in
  `cli/test/pod-runtime.test.ts:162`). `@tentacle/daemon` is already a client
  devDependency (`packages/client/package.json`).
- **The TUI folds events through a pure reducer** (`tui/src/state.ts:183`,
  `applyEvent`) inside one `for await` over `session.send`
  (`tui/src/App.tsx:350-352`), and can already build items from messages
  (`tui/src/resume.ts:9`, `messagesToItems`). A resync therefore maps to "replace
  items from messages, then keep folding" — a small pure addition.
- **The TUI's permission dialog is broker-driven, not turn-driven**
  (`tui/src/permission-ui.ts` installs the requester). So a replayed
  `permission_request` for a turn the TUI did not start still shows the
  Approve/Deny dialog — the acceptance scenario needs no new TUI surface.
- *(built: 3 `session-event-stream`, see the re-baseline note)*
  `turn_start{turnId, prompt: string}`, `turn_end{turnId, stopReason, error?}`,
  `history_replaced{reason}`, `context_note{text, reason}`, `prompt{turnId}`
  acks at once (`ended` on a retry of a finished turn), `enqueue{id, turnId}`
  dedupes (key checked before `running`), paged `snapshot{cursor?, limit?} →
  {messages, since?: HistoryCut, turn?: {turnId}, cursor?}`, `mandatory?: true`
  on the envelope, required `seq` (Q1–Q3, Q6).
- *(assumed: 4 `session-registry`)* `session/open{sessionId, since?:
  HistoryCut, create?, messages?} → {sessionId, epoch, created, resync}` —
  the reducer's `mode` is derived: `created` → `"created"`, else `resync` →
  `"resync"`, else `"replay"` — with Option A semantics
  (Q4); `UnknownSession` (-32003, `transport/src/errors.ts:13`) when not live
  and no `messages`; `session/close` idempotent; detach on socket close;
  model-proxy turns cancelled on detach (session survives).
- *(assumed: 7 `permission-events`)* `permission_request{requestId, …}`
  (mandatory), `permission_resolved{requestId, outcome}`,
  `session/resolve_permission{sessionId, requestId, outcome}` →
  `PermissionNotPending` when late; no timeout; `PermissionRequest.signal`
  (Q5); the client's basic event→broker→resolve path (Q10).
- *(assumed: `cancel`)* the parent lists `cancel` among ack-at-once commands;
  today it is a notification (`protocol/src/methods.ts:51`,
  `remote-client.ts:176-178`). The plan treats it as an idempotent command
  `cancel{sessionId, turnId}`; if it stays a notification the outbox rule is
  identical (re-send while the turn is still running after recovery).

### Design

Three pure modules (AGENTS §7) and one imperative shell. Nothing in the pure
modules knows about sockets, timers or React.

**1. `session-reducer.ts` (pure) — the per-session view.**

```ts
type Phase = "opening" | "live" | "resyncing" | "down" | "fatal";
interface SessionView {
  readonly phase: Phase;
  readonly committed: readonly ChatMessage[]; // seed, or the last snapshot
  readonly cut: HistoryCut | null;            // snapshot.since (or {open.epoch, 0} when created); committed ⊇ all seq ≤ cut.seq
  readonly applied: number;                   // last applied seq of cut.epoch (contiguity)
  readonly tail: readonly SeqUpdate[];        // applied updates with seq > cut, in seq order
  readonly buffer: readonly SeqUpdate[];      // received, not yet applicable (opening/resyncing)
  readonly turn: { turnId: string; state: "running" | "suspended" } | null;
  readonly pending: ReadonlyMap<string, PermissionRequestUpdate>;
  readonly fatal?: string;
}
type Input =
  | { kind: "open_sent"; since: HistoryCut | null }
  | { kind: "update"; params: SessionUpdateParams }          // validated envelope
  | { kind: "open_result"; mode: "replay" | "resync" | "created"; epoch: string }
  | { kind: "snapshot"; messages: readonly ChatMessage[]; since: HistoryCut; turn: Turn | null } // all pages folded
  | { kind: "link_down" }
  | { kind: "recreated" };                                   // UnknownSession → open{messages}
type Output =
  | { kind: "reset"; messages: readonly ChatMessage[] }      // replace everything shown
  | { kind: "update"; seq: number; update: SessionUpdate }   // apply in order
  | { kind: "turn_lost"; turnId: string; reason: string }
  | { kind: "fatal"; reason: string };
type Effect =
  | { kind: "fetch_snapshot" }          // shell pages snapshot, feeds back one `snapshot` input
  | { kind: "reopen"; since: null }     // forced resync (gap, or history_replaced)
  | { kind: "committed"; messages: readonly ChatMessage[] }; // persist hook
function reduce(view: SessionView, input: Input): { view; out: Output[]; effects: Effect[] };
```

Rules (each one is a row in the vector tables):
- `open_sent` → `opening`; every `update` while `opening`/`resyncing` goes to
  `buffer` (sorted by seq, dedupe within it). This is the load-bearing rule.
- `open_result{replay}` → apply buffer entries with `seq > applied`, in seq
  order; first one must be `applied + 1`, else **gap → `reopen{since:null}`**.
- `open_result{resync}` (also the fresh-client path) → `resyncing` +
  `fetch_snapshot`. `snapshot{messages, since: S, turn}` → **discard the
  local tail (partial round)**, `committed = messages`, `cut = S`, `applied =
  S.seq`,
  `turn` from the snapshot (`{turnId}` → `state: "running"`; `suspended` once
  `permission-events` adds it), `pending` cleared; emit `reset{messages ⊕ the user
  message of a buffered turn_start after S}` (Q2), then apply buffered
  `seq > S` with the contiguity check, then `committed` effect (persist).
- `live` + `update`: `seq ≤ applied` → drop (dedupe); `seq > applied + 1` →
  gap → `reopen`; else apply:
  - display known → `tail` + `update` output; display unknown → counts as
    applied, no output;
  - `tool_call` whose `toolCallId` is already in `committed` or `tail` →
    upsert, never a second entry (3c: the snapshot's assistant message lists
    its calls before their `tool_call` updates); `context_note` is a
    user-role history message (frontends may hide it, the transcript keeps it);
  - `turn_start` → `turn = running`; `turn_end` → `turn = null`, clear its
    `pending`, effect `fetch_snapshot` (persistence after `turn_end`, Review);
  - `permission_request` → `pending.set`, `turn.state = suspended`;
    `permission_resolved` → `pending.delete`, back to `running`;
  - `history_replaced` → `resyncing` + `fetch_snapshot` (the barrier: never
    apply later events over pre-compaction history);
  - unknown **mandatory** → `fatal` + `fatal` output ("this client is too old
    for the daemon; update it"); the shell stops reconnecting for the session.
- a `snapshot` arriving while `live` (the post-`turn_end` one) folds the tail:
  `committed = messages`, `cut = since`, `tail = tail.filter(seq > since.seq)`; no
  `reset` output (nothing visible changes); `committed` effect.
- `link_down` → `down` (state kept: the UI keeps showing it, stale).
- `recreated` → the daemon lost the session: `turn` (if any) is ended locally
  with `turn_lost` ("the daemon restarted; the turn in flight was lost"),
  tail and pending cleared, `cut = {epoch: open.epoch, seq: 0}`, `applied = 0`
  (a new session's epoch and seq space),
  `reset{committed}`.
- Guard: more than 3 forced `reopen`s in 60 s for one session → `fatal`
  ("daemon stream inconsistent") — a hostile or buggy pod cannot spin us.

**2. `link-machine.ts` (pure) — connection lifecycle + outbox survival.**

States `connecting(attempt) | up(gen, since) | backoff(attempt, untilMs) |
stopped(reason)`. Inputs: `dial_ok`, `dial_failed(kind)`, `channel_down`,
`timer`, `ack_timeout`, `dispose`. Outputs: `dial`, `schedule(ms)`,
`reopen_all`, `flush_outbox`, `status(LinkStatus)`.
- Backoff: `min(30 s, 0.5 s · 2^attempt)` with full jitter (injected
  `random`). Attempt counter resets only after the link stayed `up` ≥ 10 s
  (flap guard: a socket that opens and dies immediately keeps backing off).
  Proposal values, constants in the module.
- Terminal: `dial_failed("unauthorized")` (Q8), `VersionMismatch` at
  `initialize` (-32002), `dispose`. Everything else (`unreachable`,
  `rejected` non-401, exec errors) is transient: the TUI shows the state and
  the user can quit; a phone's OS decides when to stop.
- `LinkStatus = {state: "up"} | {state: "reconnecting", attempt, nextAtMs} |
  {state: "stopped", reason}` — presentation-free; the frontend formats it.
- **Liveness without ping:** every ack-at-once command has an ack deadline
  (proposal 15 s, not applied to `snapshot` pages or inbound `model/*`); a
  miss = `ack_timeout` → the shell closes the channel → normal reconnect. This
  catches a half-open socket (laptop slept) on the first command, which is the
  `pod-attach-resilience` symptom.
- **Outbox rules** (`survives(entry, view)` — pure, decided *after* the
  session is recovered, from the reducer view):
  | command | never sent (link was down) | sent, ack lost, **same** session | sent, ack lost, session **recreated** |
  |---|---|---|---|
  | `prompt{turnId}` | send | re-send same `turnId` (daemon dedupes; Q3 returns its outcome) | do **not** re-run: `turn_lost` (tools may have run on the dead daemon) |
  | `enqueue{id}` | send if a turn runs, else reject (TUI reconciles, `remote-session.ts:42-47`) | re-send same `id` (key checked before `running`) | reject |
  | `resolve_permission{requestId}` | send if still in `view.pending` | same | drop (request gone; dialog aborted) |
  | `cancel{turnId}` | send if `view.turn?.turnId` matches | same | drop |
  | `compact` | send | resolve if `history_replaced` seen, else reject `LinkLost` (Q9) | reject |
  | `open`, `snapshot` | re-issued by the machine, never queued | | |

**3. `turn-adapter` (pure, in `mapping.ts`) — reducer output → what a
frontend consumes.** `RemoteSession.send(prompt, signal)` keeps its shape for
the TUI but yields `SessionEvent = AgentEvent | {type: "history_reset";
messages}`: `reset` → `history_reset`; `update` → `updateToEvent`
(`client/src/mapping.ts:78`, unchanged); the generator ends on its own
`turnId`'s `turn_end`, on a snapshot whose `turn` is not its `turnId` (it
ended while away — stop reason from the re-sent `prompt{turnId}` ack, Q3), or
on `turn_lost` (as an error, so `failTurn` shows it, `tui/src/state.ts:143`).
A mobile app consumes `SessionView` + outputs directly; it never sees
`AgentEvent`.

**4. The shell — `RemoteClient` (imperative).**
- New option `channelFactory?: () => Promise<DuplexChannel>` (rejects with
  `ChannelError{kind: "unauthorized"|"unreachable"|"rejected"}`), plus
  injected `clock` (`now`, `setTimeout`, `clearTimeout`) and `random` for
  tests. The existing constructor `(channel, permissions, modelProvider,
  options)` stays: the given channel is generation 0; **without a factory a
  drop is terminal exactly as today** (worker path, every current caller) —
  8a is inert until 8b passes factories.
- Per generation: wrap the channel (`setOnClose` decorator, Experiment 3),
  build a new `RpcPeer` with the same handlers, `initialize`, then for every
  open session `open{sessionId, since: view.cut ? {epoch: view.cut.epoch, seq:
  view.applied} : undefined}` (registered *before*
  sending, LBA), then `flush_outbox`. Callbacks capture `gen`; a stale gen is
  ignored.
- Session ids are **always client-generated** (`crypto.randomUUID()` when the
  frontend gives none, today `connect.ts:28` gives none): the handler must
  exist before `open` is sent.
- `UnknownSession` on `open{since}` → `open{sessionId, messages:
  view.committed}` → reducer `recreated`. Two devices racing the recreate:
  the registry makes the second an attach.
- `fetch_snapshot` effect → page `snapshot{cursor}` until no cursor (reuse
  `RemoteClient.snapshot`'s paging: 200 per page, no-progress and 10 000-page
  guards), fold, feed one `snapshot` input with the first page's `since`/`turn`.
  A `StaleCursor` (-32011, compaction during paging) → restart the fetch
  (counts toward the reopen guard).
- `committed` effect → `options.onCommitted?.(sessionId, messages)`. This is
  the single snapshot used both for persistence and for recreate (today
  `persistingController` takes its own snapshot after each `send`,
  `local-runtime.ts:65-94`; **[8b]** switches it to `onCommitted`, so disk is
  aligned after every `turn_end` *and* every resync).
- **Obligation from `permission-events` (its Review finding 2, 2026-10-20):**
  the daemon replays a pending `permission_request` only when the attach
  replays from the cut or from a `since` *before* it; a `since` at or past it
  does not re-send it. The built `PermissionRouter.connectionClosed()`
  (`client/src/permission-router.ts`) DROPS the current and queued requests, so
  8a must either keep them across a reconnect (re-prompt them once the new
  connection is up) or re-attach without `since` (resync) — never both drop
  and re-attach with `since`, or a pending request goes unseen.
- Permissions: a `permission_request` output calls
  `permissions.request({…, signal})` once per `requestId` (a replay of a known
  id does not re-prompt — the original broker promise is still pending because
  the client object survived); the answer goes to the outbox as
  `resolve_permission`. `permission_resolved`, `turn_end`, `reset` and
  `recreated` abort the signal of every request no longer in `view.pending`.
  `permission_resolved` is display-only (pod-trust, `permission-events`): it
  closes a dialog, it never records a decision.
- `onLinkStatus(listener)` for frontends; `onError` unchanged (never a raw
  terminal write).

**5. WebSocket factory.** `webSocketChannelFactory(url, {token})` in
`ws-channel.ts` wraps `connectWebSocket` and classifies failures: close code
1006 → `unreachable`; 1002 → one `fetch` probe of the http(s) URL with the
same `Authorization` → 401 `unauthorized`, else `rejected` (Q8). The
`URL.searchParams`/headers construction (`ws-channel.ts:66-77`) is untouched;
a React Native/Swift client brings its own factory.

**6. TUI (8a, minimal):** `SessionController.send` returns
`AsyncIterable<AgentEvent | HistoryReset>` (`tui/src/App.tsx:45-51`); pure
`resetHistory(state, items)` in `state.ts` replaces `items` with
`messagesToItems(messages)` and keeps `running`; the `for await` at
`App.tsx:350` dispatches `history_reset` to it. **[8b]:** `TuiOptions.link`
→ `StatusBar` shows "reconnecting (attempt n, retry in Xs)" / "disconnected:
<reason>" (Q7); `connect.ts` passes `webSocketChannelFactory`; `pod-runtime.ts`
passes `() => kube.openExec(<same target>)` for `run` and `attach` (404 pod →
terminal); `local-runtime.ts` persists from `onCommitted`, seeds recreate from
the store record on a fresh process. The worker passes no factory.

Known limits (stated, not fixed here): a turn started from another device
while the TUI is idle is tracked by the reducer but not rendered (no `send`
generator is running) — follow-up TUI task; pod `run`/`attach` lose the turn in
flight on a drop (model-proxy rule + new stdio daemon), surfaced as
`turn_lost`, never silently re-run; a reset (`resetHistory`) rebuilds the
TUI's items from `messages`, so TUI-only rows (notices, background-exit rows,
`context_note`) are dropped with it (cosmetic; Review nit 7).

### Files

Dependency order. 8a unless marked.

1. `packages/client/src/session-reducer.ts` — new, pure (§Design 1).
2. `packages/client/src/link-machine.ts` — new, pure (§Design 2, incl.
   `survives`).
3. `packages/client/src/mapping.ts` — add the turn adapter + `HistoryReset`
   type; `updateToEvent` unchanged.
4. `packages/client/src/ws-channel.ts` — `ChannelError`,
   `webSocketChannelFactory` (+ close-code classification, 401 probe).
5. `packages/client/src/remote-client.ts` — generations, factory, outbox,
   effects executor, permission dedupe/abort, `onLinkStatus`, `onCommitted`.
6. `packages/client/src/remote-session.ts` — reducer-backed view; `send`
   over the adapter; client-generated id.
7. `packages/client/src/index.ts` — exports.
8. `packages/client/test/vectors/reattach/*.json` + `packages/client/scripts/gen-reattach-vectors.ts`
   (+ root `package.json` script `vectors:reattach`).
9. `packages/client/test/{session-reducer,link-machine,reattach.e2e}.test.ts`,
   `packages/client/test/support/{link-cutter,transcript}.ts`.
10. `packages/tui/src/App.tsx` (type + one dispatch branch),
    `packages/tui/src/state.ts` (`resetHistory`), `packages/tui/test/state.test.ts`
    (or the existing state test file) — one case.
11. **[8b]** `packages/cli/src/local-runtime.ts`, `connect.ts`,
    `pod-runtime.ts`, `main.ts` (pass `link` to `startTui`),
    `packages/tui/src/run.tsx`, `components/StatusBar.tsx`, their tests.
12. *(only if Q5 is not delivered by `permission-events`)*
    `packages/core/src/permission.ts`, `packages/tui/src/permission-ui.ts`.

No protocol, daemon or transport file changes in this child (all wire needs
are Q1–Q4 on the siblings).

### Failure modes

| Case | How state converges |
|---|---|
| Drop with a command in flight, same daemon | outbox re-sends with the same key; dedupe gives one effect (Experiment 2b `k=5` is the test) |
| Drop before the command left (link known down) | queued, sent after recovery if still meaningful (outbox table) |
| Half-open socket (laptop slept) | first command's ack deadline → channel closed → reconnect |
| Live update overtakes `open` response | buffered by seq in `opening` (LBA, Experiment 1) |
| Replay overlaps what was applied | `seq ≤ applied` dropped |
| Gap (daemon bug, hostile pod) | forced resync; > 3/min → `fatal`, visible |
| Ring evicted `since` / fresh client / phone after hours | `resync`: snapshot + buffered tail; partial round discarded and replayed in full |
| `compact` (own or another device's) during replay or live | `history_replaced` → resync; never applied over stale history |
| Daemon restarted / new stdio daemon (attach, run) | `UnknownSession` → recreate from `committed`; in-flight turn → `turn_lost`, prompt not re-run |
| Turn ended while away (resync) | snapshot `turn` ≠ mine → generator ends; outcome from re-sent `prompt{turnId}` ack (Q3) |
| Pending approval, phone dead for hours | turn stays suspended daemon-side (no timeout); on resume the request is in the replay (or rebuilt after a restart) → one dialog, Approve/Deny work |
| Answered on another device meanwhile | `permission_resolved` → dialog aborted; local answer, if queued, dropped (not in `pending`) |
| Late answer after recovery | daemon `PermissionNotPending` → dialog closed with "answered elsewhere"; never silent |
| Unknown display event | applied as a no-op (seq counted) — requires Q1 |
| Unknown mandatory event | `fatal`, "update this client"; reconnect stops for that session |
| Bad token | `unauthorized` → stopped, reason shown; no retry storm |
| Version skew | `VersionMismatch` at `initialize` → stopped |
| Endless flapping | exponential backoff to 30 s; attempt counter resets only after 10 s up |
| `dispose()` during backoff/dial | timers cleared, late dial result closed and ignored (generation) |
| Late frame on an old generation | ignored by the generation guard (`peer.ts:260`, `ws-channel.ts:20-23` deliver it) |
| Snapshot paging races a compaction | `StaleCursor` → refetch, bounded by the reopen guard |

### Tests

Red before green (§9): every test below fails on `main` + children 3/4/7
(no reconnect, no reducer). Fakes only: `createChannelPair`, the cutter,
injected clock/random, `ScriptedProvider`/gated provider, `SpyBroker`-style
broker, a spy `ExecutionEnvironment` counting tool runs. No sockets except the
existing loopback smoke test.

**A. The parent property, end to end (`reattach.e2e.test.ts`).** Real
`SessionHost` (registry) + `Connection` per channel + `Agent` with a gated
scripted model; script S1 = turn 1: 3 text chunks, a `shell` tool call that
needs permission, approved, 2 more chunks; turn 2: 2 chunks. Script S2 =
turn, `compact`, turn. `LinkCutter` (`test/support/link-cutter.ts`, the
Experiment 2b decorator) counts frames in **both** directions with one counter
and cuts after frame *k*; the client's `channelFactory` returns a new pair
bound to a new `Connection` on the **same** `SessionHost`.
1. Run uninterrupted once → `N` frames and the reference: an observer reducer
   fed every update, sampled at each daemon seq `s` → `ref(s)`.
2. For every `k ∈ 1..N` and every path — (a) re-attach (same `RemoteClient`,
   own `since`), (b) fresh client (a new `RemoteClient`, no state, opens the id
   right after the drop, mid-round), (c) forced resync (same client, `since`
   omitted, i.e. the `reopen` effect) — hold the model gate, recover, then
   assert **at the observation point** `transcript(view) == transcript(ref(s))`
   where `s` = the daemon's last emitted seq, **and** the applied seq log
   after the last `reset` is exactly `cut+1, cut+2, …` (no gap, no
   duplicate). Release the gate, run to the end, assert the same at the final
   seq, model calls = uninterrupted count, tool runs = 1.
   `transcript` (`test/support/transcript.ts`) folds `committed` messages and
   the `tail` into one canonical list (user / assistant text / tool call +
   result), so a cut anywhere gives the same list. A bridge test pins
   `transcript(messages at round end) == transcript(events of that round)` for
   S1, so the comparison itself is not vacuous.
3. Outbox: for `k` at the `prompt` request frame and at its ack frame →
   exactly one turn ran (model calls), the caller's `send` completes.
4. **Acceptance (the phone scenario):** S1, drop while the permission is
   pending; advance the injected clock 6 h (no timers fire daemon-side — no
   timeout); (a) same client: the broker was prompted **once**, approving after
   recovery runs the tool once and the turn ends; (b) fresh client with a new
   broker (app killed): prompted once on open, Approve works; (c) Deny works
   and the turn continues as denied; (d) a second attached client answers
   first → the first client's dialog is aborted and its late answer is not
   sent.

**B. Reducer table (`session-reducer.test.ts`)** — runs every JSON vector:
dedupe, gap → reopen, update-before-open-result buffered, resync discards
partial round, `history_replaced` barrier, unknown display no-op, unknown
mandatory fatal, `recreated` → `turn_lost`, reopen guard.

**C. Link machine (`link-machine.test.ts`)** — backoff sequence with
`random = () => 1`, 30 s cap, no reset before 10 s up, `unauthorized` and
`VersionMismatch` terminal, `dispose` mid-backoff, ack-timeout → down, the
outbox table row by row.

**D. Shell unit tests (`remote.test.ts`, extended)** — generation guard (a
fake channel that delivers after close: the update is ignored), single broker
across reconnect (a broker spy sees one instance and one prompt), no factory →
a drop stays terminal (today's behaviour, pins the inert default),
`webSocketChannelFactory` classification against a `Bun.serve` returning 401 /
426 / closed port (the Experiment 5 setup).

**E. TUI (8a)** — `resetHistory` replaces items and keeps `running`; an
`App` frame test (ink-testing-library, `tui/test/app.test.tsx` pattern): a
session yielding `text "abc"`, `history_reset{[user hi, assistant ab]}`,
`text "c"` renders `ab` + `c` once, never `abc` twice.

**Mutations that must turn A or B red** (§9 non-vacuity; revert after):
disable seq dedupe; skip the resync snapshot (rebuild from tail only); ignore
`history_replaced` (S2 drop around `compact`); keep the local partial round on
resync; route updates only after the `open` result (drops the overtaking
update of the LBA); re-send `prompt` with a fresh `turnId`; do not re-send
un-acked commands; re-prompt on a replayed `requestId` (acceptance (a) sees two
prompts); build a second broker on reconnect (single-broker spy). The daemon-
side mutations of the parent (`since` = raw counter, ring reset at turn
start) are owned by `session-event-stream` but the same harness catches them:
run it once against each mutant and record the result in Execution.

**JSON test-vector format** (`packages/client/test/vectors/reattach/<name>.json`,
one case per file, generated — never hand-edited):

```json
{
  "format": "tentacle/client-reattach-vector",
  "formatVersion": 1,
  "protocolVersion": 4,
  "name": "s1-k07-fresh",
  "scenario": "s1-text-tool-permission",
  "path": "reattach | fresh | forced_resync",
  "dropAfterFrame": 7,
  "initial": { "sessionId": "s-1", "committed": [], "cut": null, "applied": 0 },
  "steps": [
    { "in": { "kind": "open_sent", "since": null } },
    { "in": { "kind": "update", "params": { "sessionId": "s-1", "seq": 1, "mandatory": true,
              "update": { "type": "turn_start", "turnId": "t-1", "prompt": "hi" } } } },
    { "in": { "kind": "open_result", "mode": "resync", "epoch": "e-1" },
      "expectEffects": [{ "kind": "fetch_snapshot" }] },
    { "in": { "kind": "snapshot", "messages": [], "since": { "epoch": "e-1", "seq": 0 }, "turn": { "turnId": "t-1" } },
      "expectOut": [{ "kind": "reset", "messages": [{ "role": "user", "content": "hi" }] }, { "kind": "update", "seq": 1 }] }
  ],
  "expect": {
    "phase": "live", "cut": { "epoch": "e-1", "seq": 0 }, "applied": 1,
    "committed": [], "tail": [{ "seq": 1, "update": { "type": "turn_start", "turnId": "t-1" } }],
    "turn": { "turnId": "t-1", "state": "running" }, "pending": [],
    "transcript": [{ "role": "user", "text": "hi" }]
  }
}
```

- `in` objects are exactly the reducer `Input`s; `update.params`, the
  `snapshot` fields and `open_result.mode` are **wire payloads** and are
  validated in the test with the zod `NotificationSchemas` /
  `RequestSchemas` (the source of the exported JSON Schema; the
  `protocol-schema-export` drift gate keeps them equal). A Swift/Kotlin
  harness validates the same payloads with the exported
  `packages/protocol/schema/protocol.json`.
- `expectOut`/`expectEffects` are optional per step (exact, ordered);
  `expect` is the final `SessionView` (maps as sorted arrays) plus the
  canonical `transcript`.
- Nonces are normalised by the generator (`s-1`, `t-1`, `r-1`, by first
  appearance) so files are stable. The generator records reducer inputs from
  the A-harness runs (all `k`, all paths, S1 and S2) plus the hand-picked
  B-rows expressed as scenarios; a drift test regenerates in memory and
  compares with the committed files ("run `bun run vectors:reattach`").

### Why, item by item

(Decisions not already argued in the Review.)

- **Why buffer from before `open` is sent.** Experiment 1: a live update can
  beat the response; routing only after the result loses it — silently, with
  no gap visible until the next event. Registering first and ordering by seq
  makes arrival order irrelevant.
- **Why replay as notifications, not inline in the `open` result (Q4).**
  Inline replay still races live notifications (same experiment), so the
  client would need two merge paths; one stream of seq-stamped updates needs
  one.
- **Why contiguity is checked, not just dedupe.** Dedupe hides duplicates;
  only contiguity exposes a *loss*. A silent gap is the "missing chunk"
  transcript the parent property was revised to catch.
- **Why a gap triggers a resync instead of an error.** The client cannot
  repair a hole from events; the snapshot can. Bounded by the reopen guard so
  a broken daemon becomes a visible error, not a loop.
- **Why the reducer emits effects instead of calling the network.** Keeps it
  pure and table-testable, and lets Swift/Kotlin run the same vectors and
  check they issue the same commands (`expectEffects`), not only the same
  state.
- **Why a separate pure link machine.** Backoff, flap guard, terminal
  classification and outbox survival are branching logic (AGENTS §7: logic in
  pure modules); in the shell they would only be testable with real timers.
- **Why outbox survival is decided from the recovered view.** Whether a
  re-send is right depends on what happened while away (the request already
  resolved, the turn already ended, the session recreated). The view after
  recovery is the only place that knows; deciding at drop time would guess.
- **Why never re-run a prompt on a recreated session.** The dead daemon may
  have run its tools; the new one does not know. Re-running could do "deploy"
  twice. `turn_lost` is honest; the user re-sends deliberately.
- **Why an ack deadline instead of a client ping.** Commands already ack at
  once in v2, so a missing ack *is* a liveness signal, with no protocol
  addition and no battery cost while idle. Idle keepalive is a transport
  concern (WS ping, Q12; server `sendPings`, `session-ttl-limits`).
- **Why client-generated session ids always.** The handler must exist before
  `open` is sent (LBA); a daemon-assigned id is only known after the
  response, too late.
- **Why `RemoteSession.send` keeps the `AgentEvent` shape plus one reset
  event.** The TUI's `applyEvent` reducer stays the single display path
  (`tui/src/state.ts:183`); a resync is a reset plus normal events, not a
  second rendering path. A mobile app skips the adapter and reads the view.
- **Why the factory is optional and the default stays terminal.** 8a can land
  without changing any runtime's behaviour (worker, current
  `connect`/`attach`); the risky part — turning reconnect on per transport —
  is reviewable on its own in 8b.
- **Why the 401 probe instead of a daemon change.** The daemon already answers
  a plain GET with 401 vs 426 (`ws-server.ts:166-173`); a client-side probe
  classifies precisely without weakening "reject before the socket opens".
- **Why the property test drives real daemon objects, not a fake daemon.**
  The cut, the ring and the barrier are daemon semantics; a fake would encode
  this doc's assumptions and pass by construction. The pure vectors cover the
  client alone; the e2e run covers the contract.

### Experiments

All in `.tentacle/tmp/client-reattach-impl/`, 2026-10-19, bun 1.4.3, `main` @
`4914e9b`. Run from that directory with `bun <file>`.

**1 — a live update overtakes the response of the request that attached the
sink** (`order.ts`):

```ts
import { RpcPeer, createChannelPair } from "@tentacle/transport";
const [d, c] = createChannelPair();
const frames: string[] = [];
let sink: ((seq: number) => void) | null = null;
let seq = 10;
const daemon: RpcPeer = new RpcPeer(d, {
  onRequest: async (method) => {
    // synchronous attach: compute replay + add sink in one tick
    const replay = [8, 9, 10];
    sink = (s) => daemon.notify("session/update", { sessionId: "s", seq: s, update: { type: "agent_message_chunk", content: { type: "text", text: `c${s}` } } });
    queueMicrotask(() => sink?.(++seq)); // the agent loop emits right after attach
    void replay; return { messages: [] };
  },
});
const client = new RpcPeer(c, {
  onNotification: (_m, p) => frames.push(`notification seq=${(p as { seq: number }).seq}`),
});
const r = await client.request("session/snapshot", { sessionId: "s" }).then(
  (x) => `response ${JSON.stringify(x)}`, (e) => `error ${e.message}`);
frames.push(r);
await new Promise((res) => setTimeout(res, 20));
console.log(frames.join("\n"));
```
```
notification seq=11
response {"messages":[]}
```

**2 — cut the link after exactly frame k (daemon→client), real daemon**
(`drop-at-k.ts`; model = 6 text chunks, no timers):

```ts
function cutAfter(inner: DuplexChannel, k: number): DuplexChannel & { sent: number } {
  const ch = {
    sent: 0,
    send(data: string) {
      if (ch.sent >= k) return; // link already cut: frame lost, as on a dead socket
      ch.sent += 1;
      inner.send(data);
      if (ch.sent === k) queueMicrotask(() => inner.close()); // delivered first, then drop
    },
    close: () => inner.close(),
    setOnMessage: (h: (d: string) => void) => inner.setOnMessage(h),
    setOnClose: (h: () => void) => inner.setOnClose(h),
  };
  return ch;
}
// per k: new Connection(cutAfter(d, k), new SessionHost(...)); client RpcPeer on c;
// initialize → session/new → session/prompt; log what the client saw.
```
```
k= 1 daemonSent=1 client saw [r:init] -> rejected: connection closed
k= 2 daemonSent=2 client saw [r:init r:new] -> rejected: connection closed
k= 3 daemonSent=3 client saw [r:init r:new u1] -> rejected: connection closed
k= 4 daemonSent=4 client saw [r:init r:new u1 u2] -> rejected: connection closed
k= 5 daemonSent=5 client saw [r:init r:new u1 u2 u3] -> rejected: connection closed
k= 6 daemonSent=6 client saw [r:init r:new u1 u2 u3 u4] -> rejected: connection closed
k= 7 daemonSent=7 client saw [r:init r:new u1 u2 u3 u4 u5] -> rejected: connection closed
k= 8 daemonSent=8 client saw [r:init r:new u1 u2 u3 u4 u5 u6] -> rejected: connection closed
k= 9 daemonSent=9 client saw [r:init r:new u1 u2 u3 u4 u5 u6 r:prompt {"stopReason":"end_turn"}] -> completed
k=10 daemonSent=9 ... -> completed
k=11 daemonSent=9 ... -> completed
```

**2b — one global counter over both directions** (`drop-both.ts`, same
decorator applied to both ends, logging each frame; model = 3 chunks, counts
calls):

```
k=5: 1:c2d:initialize | 2:d2c:response | 3:c2d:session/new | 4:d2c:response | 5:c2d:session/prompt | LOST d2c -> rejected: connection closed; model calls=1
k=6: 1:c2d:initialize | 2:d2c:response | 3:c2d:session/new | 4:d2c:response | 5:c2d:session/prompt | 6:d2c:session/update | LOST d2c -> rejected: connection closed; model calls=1
```
`k=5` is the ambiguous ack: the daemon ran the turn, the client saw only a
close.

**3 — a channel decorator sees the drop before the caller sees the
rejection** (`close-hook.ts`):

```ts
import { type DuplexChannel, RpcPeer, createChannelPair } from "@tentacle/transport";
const log: string[] = [];
let generationDropped = false;
function watched(inner: DuplexChannel, onDrop: () => void): DuplexChannel {
  return { ...inner, send: (d) => inner.send(d), close: () => inner.close(),
    setOnMessage: (h) => inner.setOnMessage(h),
    setOnClose: (h) => inner.setOnClose(() => { onDrop(); h(); }) };
}
const [d, c] = createChannelPair();
new RpcPeer(d, { onRequest: () => new Promise(() => {}) }); // daemon never answers
const peer = new RpcPeer(watched(c, () => { generationDropped = true; log.push("onDrop"); }));
const p = peer.request("session/snapshot", { sessionId: "s" }).catch((e) => log.push(`rejected (${e.message}); dropped flag=${generationDropped}`));
queueMicrotask(() => d.close());
await p;
console.log(log.join("\n"));
```
```
onDrop
rejected (connection closed); dropped flag=true
```

**4 — Bun's client WebSocket has `ping()`** (`wsping.ts`; contradicts
`pod-attach-resilience` Layer 1):

```ts
let pings = 0;
const server = Bun.serve({ port: 0, fetch(req, s) { return s.upgrade(req) ? undefined : new Response("x"); },
  websocket: { message() {}, ping() { pings++; } } });
const ws = new WebSocket(`ws://localhost:${server.port}`);
await new Promise((r) => ws.addEventListener("open", r));
console.log(`bun ${Bun.version}: typeof ws.ping = ${typeof (ws as unknown as { ping?: unknown }).ping}`);
(ws as unknown as { ping?: () => void }).ping?.();
await Bun.sleep(100);
console.log(`server saw pings: ${pings}`);
ws.close(); server.stop(true);
```
```
bun 1.4.3: typeof ws.ping = function
server saw pings: 1
```

**5 — a 401 is indistinguishable from other upgrade rejections on the
socket** (`ws401.ts`):

```ts
const server = Bun.serve({ port: 0, fetch() { return new Response("unauthorized", { status: 401 }); }, websocket: { message() {} } });
for (const url of [`ws://localhost:${server.port}`, "ws://localhost:1"]) {
  const ws = new WebSocket(url);
  const seen: string[] = [];
  await new Promise<void>((r) => {
    ws.addEventListener("error", (e) => seen.push(`error(${(e as ErrorEvent).message ?? ""})`));
    ws.addEventListener("close", (e) => { seen.push(`close(code=${e.code}, reason=${JSON.stringify(e.reason)})`); r(); });
  });
  console.log(`${url.includes(":1") ? "refused" : "401    "} -> ${seen.join(" ")}`);
}
server.stop(true);
```
```
401     -> error(WebSocket connection to 'ws://localhost:49595/' failed: Expected 101 status code) close(code=1002, reason="Expected 101 status code")
refused -> error(WebSocket connection to 'ws://localhost:1/' failed: Failed to connect) close(code=1006, reason="Failed to connect")
```

**6 — an unknown update type is dropped by peer validation, seq and all**
(`unknown-update.ts`):

```ts
import { RpcPeer, createChannelPair } from "@tentacle/transport";
const [d, c] = createChannelPair();
const daemon = new RpcPeer(d);
const seen: string[] = [];
new RpcPeer(c, { onNotification: (_m, p) => seen.push(`delivered seq=${(p as { seq: number }).seq}`), onError: (e) => seen.push(`onError: ${e.message}`) });
daemon.notify("session/update", { sessionId: "s", seq: 1, update: { type: "agent_message_chunk", content: { type: "text", text: "a" } } });
daemon.notify("session/update", { sessionId: "s", seq: 2, update: { type: "progress_bar", percent: 40 } });
daemon.notify("session/update", { sessionId: "s", seq: 3, update: { type: "agent_message_chunk", content: { type: "text", text: "b" } } });
await new Promise((r) => setTimeout(r, 10));
console.log(seen.join("\n"));
```
```
delivered seq=1
onError: invalid params for notification session/update
delivered seq=3
```

### Validation (for Execution)

Narrow per slice: `bun test packages/client/test/session-reducer.test.ts`,
`…/link-machine.test.ts`, `…/reattach.e2e.test.ts`. Before done: `bun run
check` (typecheck → lint → full suite, baseline: all pass except the opt-in
live-k8s skip; lint clean). Record each §Tests mutation and its red result in
Execution. Manual (8b): `tentacle serve` + `connect`, kill the network
mid-turn and mid-approval, confirm the StatusBar state and the dialog after
recovery.

## Execution

*— claude-opus-5-5, 2026-10-20*

Built on `feat/client-reattach` from `main` @ `0bfe86c`, in the Revision's file
order. Baseline gate before any edit: tsc clean, Biome clean (295 files),
**1110 pass, 2 skip, 0 fail**.

### As built

1. `packages/client/src/session-reducer.ts` (new, pure, R1): phases
   `idle/opening/resyncing/live/down/closed/failed`; buffer from `open_sent`;
   dedupe / gap → `reopen` (guard: > 3 per 60 s → `failed`); `reset{messages,
   turn, keepRequests}`; the barrier; `recreated` → `turn_lost` + `reset`.
2. `packages/client/src/link-machine.ts` (new, pure, R2): `backoffMs`,
   `linkDropped` / `dialFailed` / `linkUp` / `stopped` (flap guard: the attempt
   counter resets only after 10 s up), `terminalReason` (`ChannelError
   "unauthorized"`, `VersionMismatch`), `LinkStatus`, `turnRecovery`.
3. `packages/client/src/permission-router.ts`: `retainOnly(sessionId, ids)`,
   plus `answeredIds` / `answerFailed` (drift 3).
4. `packages/client/src/remote-client.ts`: rewritten around generations —
   `makePeer(channel, gen)` (every callback checks its generation; the
   model-stream handlers notify on the peer that received the request),
   `onLinkClosed` (no factory → `stop`, today's behaviour), `schedule` / `dial`
   / `redial`, per-session `SessionEntry` + reducer, `openOn` / `recover` /
   `recreate` / `resync`, `sessionCall(keyed | once)`, `whenLive` waiters,
   `onLinkStatus`, `setListener`. The no-factory path of every command is the
   old direct `peer.request`.
5. `packages/client/src/remote-session.ts`: the session's
   `SessionStreamListener`; `send` yields `SessionEvent`; `output` (reset →
   `history_reset` + calls already shown; own `turn_start` after a reset →
   `user_message`; replayed `tool_call` of a shown call dropped), `recovered`
   (`turnRecovery`: re-send an acked prompt; a lost cancel rides its ack — post-Review fix 1), `linkClosed`.
6. `packages/client/src/mapping.ts`: `SessionEvent`; `index.ts` exports.
7. TUI: `state.ts` `SessionEvent`, `resetHistory`, `applySessionEvent`;
   `App.tsx` loop uses it; `SessionController.send` yields `SessionEvent`.
8. Tests (below) and the D12 adjustments in `remote.test.ts`.

### Drift from the Revision (and why)

1. **Session id (D10 revised).** `RemoteSession` passes an id only when the
   frontend gives one; without one the daemon picks it, as before. Buffering
   before `open` only matters when the session may already have updates, which
   needs a known id (every re-attach uses the id from the first answer). Saved
   the churn of every fake daemon that answers `s1`. **Known limit → 8b:** a
   drop during the very first `open` of an id-less session surfaces as an
   error; `connect` should pass an id (`local-runtime` already does).
2. **The listener gets the complete ordered stream.** Permission and
   background-exit updates go to their owners (router, exit listeners) *and*
   to the listener; `RemoteSession` ignores them. Without this the listener's
   seqs had holes (the harness's contiguity check caught it) and a mobile view
   could not show "waiting for approval".
3. **Bug found by the harness, fixed: a second dialog for an answered request.**
   With the model emitting one event per macrotask, `S1 k=13 resync` prompted
   the broker twice: the user answered while the link was down (the answer
   waits for the session to be live), the resync replay re-offered the same
   `requestId`, and the router had forgotten it at `answered()`. Fix: the router
   remembers answered ids until `permission_resolved` (or session close /
   terminal drop); `answerFailed` forgets one whose delivery really failed, so
   a later replay offers it again. Red: the failing run above; green after;
   pinned by a router test (mutation M13).
4. **`closeSession` keeps routing until the daemon answers** (`closing` flag).
   Found by the existing test "RemoteSession.close() closes once, also while
   its first send is still opening": deleting the entry at once dropped the
   `turn_end{cancelled}` that precedes the close response.
5. **Updates for a session this client has not opened are dropped** (the old
   client routed even those to the router: a pod could pop a dialog for a
   session nobody opened here). Three fake-daemon tests now `openSession("s1")`
   first.
6. **`close()` stops before closing the peer**, so the final status says
   `closed`, not `disconnected` (seen in the after-repro; asserted in E1/E2).
7. As planned: no `onCommitted` (8b); recreate seeds from the newest history
   read (seed, resync snapshot, `snapshot()` result); a never-live session is
   recovered with `create: true`.
8. `turnRecovery`'s `recreated` guard is defense in depth: on a recreate the
   `turn_lost` output fails the turn before `recovered` runs, so mutation M17
   stays green. Kept and stated.

### Tests

- `session-reducer.test.ts` (14), `link-machine.test.ts` (4),
  `permission-router.test.ts` (+3), `reattach.test.ts` (12: inert default; E1/E2
  dialog kept with `since`, no snapshot, one prompt, status sequence; E3
  answered elsewhere; unauthorized terminal; `close()` mid-backoff; generation
  guard; first open lost after/before leaving; keyed enqueue once; compact not
  re-sent; recreate → `turn_lost`, not re-run; E4 `serve` restart),
  `reattach.e2e.test.ts` (S1: 26 frames × reattach/resync + 20 × fresh; S2:
  20 × 2 + 10; every quiet point compared after recovery, contiguity, model
  calls, tool runs, prompts, the TUI-style fold, the daemon-history bridge),
  TUI `state.test.ts` (+2), `app.test.tsx` (+1 frame test).
- The harness was hardened twice when mutations stayed green (one event per
  macrotask; `check` waits for the recovery; the resync path delays its
  snapshot request 3 ms so the cut moves between `open` and snapshot).

### Mutations (each applied alone, test run, file restored byte-identical — `.tentacle/tmp/client-reattach/mutate.py`)

| # | Mutation | Result |
|---|---|---|
| M1 | reducer: drop the `seq ≤ applied` dedupe | reducer table RED (4); e2e green — a duplicate then falls into the gap rule and forces a correct resync (bounded by the guard) |
| M1b | reducer: apply duplicates | e2e RED (S1, S2) |
| M2 | reducer: no snapshot on a resync result | reducer RED (5), e2e RED (S1, S2) |
| M3 | reducer: ignore `history_replaced` | reducer RED (2), e2e RED (S2) |
| M4 | reducer: no `reset` on a snapshot (keep the partial round) | reducer RED (5), e2e RED (S1, S2) |
| M5 | reducer: do not buffer while `opening` | reducer RED (7), e2e RED (S1, S2) |
| M6 | session: re-send the prompt with a fresh `turnId` | e2e RED (S1, S2) |
| M7 | shell: keyed commands not re-sent | e2e RED (S1, S2); enqueue case RED |
| M8 | router: no dedupe of a current/queued request | e2e RED (S1) |
| M10 | shell: `router.connectionClosed()` on a reconnectable drop | E1/E2 RED; e2e RED (S1) |
| M12 | shell: no `retainOnly` on a reset | E4 RED |
| M13 | router: forget answered ids | router test RED (e2e green: corrected after Review nit 6, re-run 3/3) |
| M14 | shell: no generation guard on notifications | generation-guard case RED |
| M15 | link: `unauthorized` transient | unauthorized case RED |
| M16 | shell: `close()` neither clears the timer nor is checked by `dial` | close-mid-backoff case RED |
| M17 | link: re-send the prompt on a recreated session | green (defense in depth, drift 8) |
| M18 | shell: recover a never-live session without `create` | first-open-before-leaving case RED (after pinning it through a raw listener) |
| A1 | session: show a replayed `tool_call` of a call the reset showed | e2e RED (TUI fold) |
| A2 | session: no `user_message` after a reset | e2e RED |
| T1 | App: ignore `history_reset` | App frame test RED ("abcc") |
| T2 | state: no running-call mapping on reset | state test RED |

Not mutated: "build a second broker on reconnect" — there is no construction
site to mutate (the broker is a constructor argument, never rebuilt); the
one-prompt counts in E1/E2 and the e2e pin the observable.

### Gate

`bun run check`: tsc clean · Biome clean (304 files) · **1148 pass, 2 skip
(the opt-in live-k8s and slow-keepalive tests), 0 fail** (4542 expects, 117
files).

Pre-existing flake (`docs/eval/reaper-gc-flaky-test.md`,
`session-reaper.test.ts` "a connection forgets a session another client
closed"): appeared once in a gate run. Measured: isolated file 0/8 on the
branch and 0/8 on `main`; full suite, run concurrently, `main` 1/5, branch
2/5 — always that single test, which this task does not touch.

### After (`.tentacle/tmp/client-reattach/after.ts`: the Repro's scenario with a `channelFactory`)

```
prompts before drop: 1
link: {"state":"reconnecting","attempt":1}
link: {"state":"up"}
after drop: dialog withdrawn: false | prompts: 1
send -> completed | events: text,tool_start,tool_result,text,turn_end
tool runs: 1 | prompts: 1
link: {"state":"stopped","reason":"closed"}
```

**Unverified:** real transports (a WebSocket or k8s exec channel factory —
8b), and a half-open link: with no ack deadline (moved to 8b, R-Q2) it hangs
until the socket errors.

### Fixes after Review round 1

*— claude-opus-5-5, 2026-10-20*

Each fix has a regression test, shown red on the pre-fix code (the reviewer's
repros in `.tentacle/tmp/client-reattach-review/` re-run on the branch first:
all four reproduced), then green.

| Finding | Fix (file) | Test |
|---|---|---|
| 1 Esc while down, unacked prompt | `remote-session.ts` `sendPrompt`: the prompt's ack sends the cancel when `abortWanted` (the daemon has the turn by then). `link-machine.ts` `turnRecovery` loses `resendCancel`: an acked turn's prompt is re-sent on recovery and its ack re-sends the cancel, so the `recovered()` cancel was redundant (mutation R8 stayed green after the fix: two mechanisms for one rule) | `reattach.test.ts` "finding 1…" and "the cancel of an acked turn, lost while down…"; `link-machine.test.ts` turn recovery |
| 2 failed session, no factory, silent hang | `remote-client.ts` `sessionCall`: a `failed` entry rejects at once ("could not be resumed"), on both paths | "finding 2…" (no factory); "with a factory: a command waiting out a drop…" pins `whenLive`'s own `failed` check (R11) — the new `sessionCall` check masks it for a command issued after the failure, so that test issues the command while down |
| 3 quadratic, unbounded buffer | `session-reducer.ts` `buffered`: binary-search insert, `MAX_BUFFERED_UPDATES = 2048`, the oldest evicted; the hole they leave is a gap → forced reopen (resync), under the existing 3/min guard | `session-reducer.test.ts` "the buffer is bounded…" |
| 4 close during recovery recreates | `remote-client.ts` `recreate`: returns when `entry.closing` | "finding 4…" |
| 5 test gaps | — | R10 "snapshot() waits out a drop…"; R11 above; R12 "an update for a session this client never opened…"; R14 "an answer the daemon refused is offered again…"; R8 obsolete (see 1) |
| 6–8 nits | M13 row corrected (re-run 3/3: router test RED, e2e green); `resetHistory` limit added to Known limits; `methods.ts:54` | — |

Buffer bench (`buffer-bench.ts`): 40 000 updates buffered in 227 ms (was
4 589 ms), memory capped at 2 048 entries. The per-update cost is now O(cap)
(an immutable copy), not O(n log n) over an unbounded n.

Gate: `bun run check` green — tsc clean · Biome clean · **1157 pass, 2 skip
(opt-in), 0 fail** (1159 tests, 117 files).

Mutations (each alone, `reattach`, `session-reducer`, `link-machine`,
`reattach.e2e`; a no-op mutation stays green as the control):

| # | Mutation | Result |
|---|---|---|
| F1 | no cancel on the prompt's ack | RED (finding 1 + acked-cancel case) |
| F2 | `sessionCall` ignores `failed` | RED (finding 2) |
| F3 | no eviction past the cap | RED (bounded buffer) |
| F4 | `recreate` ignores `closing` | RED (finding 4) |
| R10 | `snapshot()` not retried | RED |
| R11 | `whenLive` ignores `failed` | RED |
| R12 | unopened sessions' updates to the router | RED |
| R14 | `answerFailed` never called | RED |

## Review

*— claude-opus-5-5, 2026-10-20 (fresh context; the **same model family as the
executor**, so blind spots we share survive both passes)*

**Verdict: REQUEST-CHANGES.** The core holds: seq ordering, generations,
keyed re-send, the router obligations (E1–E4), and the inert default for the
turn-fails-on-drop path. Four attacks found real defects, though. Two are in
8a's own design and are not reachable today (they need a factory). One
**is** reachable on every shipped runtime, a silent hang (finding 2), which
breaks "8a is inert" and "fail loud". Findings 1–3 need a fix and a red→green
test. Finding 4 is small. 5–8 are test gaps and nits.

#### Findings

1. **Major (reachable only with a factory) — Esc while the link is down does
   not cancel a prompt that never reached the daemon. The turn runs to the
   end.** `remote-session.ts:255` sends `session/cancel` from `recovered()`.
   `remote-client.ts:774` calls `recovered()` *before* `kick()` (`:776`), and
   `kick()` is what releases the prompt that `sessionCall` was holding. So the
   frames go out as `session/cancel` (no turn running yet → a no-op), then
   `session/prompt` (the turn starts). D5 says "re-send the cancel *if that
   turn still runs*", and for an unacked prompt it never does. Evidence:
   `.tentacle/tmp/client-reattach-review/cancel-down.ts` prints
   `send -> completed | events: text,text,text,text,turn_end:end_turn`, model
   calls 2, frames after the link came back
   `initialize session/open session/cancel session/prompt`. **No test covers
   it.** Mutation R8 (never re-send the cancel) stays green across all 350
   client+tui tests. Related prior art on the same seam: `TODO.md:211-214`
   item (c), "Esc while the first send is still opening does not cancel".
   Fix direction: on recovery, an unacked turn with `abortWanted` should send
   its cancel *after* the prompt is acked. Or it should not re-send the prompt
   at all, and end the turn as cancelled. Either way, it needs a red→green
   test.
2. **Moderate (every shipped runtime, no factory) — a session the reducer
   gave up on stays registered but dead. The next turn hangs forever, with no
   error.** Once the reducer reaches `failed`, it swallows every input
   (`session-reducer.ts:258`). Without a factory, `sessionCall` skips
   `whenLive` and goes straight to the peer (`remote-client.ts:895-897`), so
   the next `prompt` is acked and its `turn_end` is never delivered. Before
   this change, a lost frame lost content. Now it can stall the TUI with
   "running" shown forever. Two paths lead to `failed`: the reopen guard (> 3
   gaps a minute), or a resync/barrier snapshot that fails (StaleCursor ×3,
   "no cut", a hostile pod's bad cursor). Evidence:
   `.tentacle/tmp/client-reattach-review/failed-nofactory.ts` (a channel that
   loses the first delivery of every 3rd update) prints
   `turn 1 -> rejected: … giving up on this session`, then
   `turn 2 (link healthy, no loss) -> STILL WAITING after 3 s | daemon running: false`.
   **No test covers it.** Mutation R11 (`whenLive` ignores `failed`) is also
   green. Fix direction: a failed (or closed) entry rejects session commands
   on both paths.
3. **Moderate (perf, main/render thread) — buffering is quadratic.**
   `buffered()` (`session-reducer.ts:136-145`) copies the buffer, scans it,
   and re-sorts it on **every** update received while `opening`/`resyncing`.
   Measured with `.tentacle/tmp/client-reattach-review/buffer-bench.ts`
   (pure reducer): 5 000 updates take 98 ms, 20 000 take 1 176 ms, 40 000 take
   4 589 ms. The replay ring is 4 MiB (`hosted-session.ts:99`), and chunk
   updates are about 100 B, so a re-attach after a long turn can replay tens
   of thousands of frames. That freezes the TUI for seconds while it
   reconnects. The buffer is also unbounded while an `open` goes unanswered:
   a pod that floods updates and never answers grows laptop memory. Fix
   direction: append in order, binary-insert out of order, and cap the buffer
   (overflow → resync/fail loudly).
4. **Minor — a `closeSession` during a recovery can recreate the session it
   closes.** `openOn` turns `UnknownSession` into `recreate`
   (`remote-client.ts:670`, `:697-704`) without checking `entry.closing`.
   Evidence: `.tentacle/tmp/client-reattach-review/close-recover.ts`. With a
   restarted daemon and the close issued while the re-open is in flight, the
   frames are `open(since) session/close open(messages)`, and the new daemon
   then has `S` (`true`). The orphan is idle and detached, so it is reaped
   eventually. On `serve` it is also persisted.
5. **Minor (test gaps) — properties with no test.** Each mutation below was
   applied alone, run against `packages/client` (+`packages/tui` where
   relevant), and stayed **green**:
   - R12: updates for a session this client never opened go to the router
     again. Drift 5 cites this as a pod-trust improvement, and nothing pins it.
   - R10: `snapshot()` is not retried across a drop.
   - R11: `whenLive` ignores `failed`.
   - R14: `answerFailed` is never called.
   - R8: the cancel is never re-sent (finding 1).
6. **Nit — one mutation result in the Execution table could not be
   reproduced.** M13 claims "e2e RED (S1)". My variant drops the
   `answeredIds` check in `request()`. It turns only the router unit test red;
   the e2e stays green. That may be a different mutation, or a timing
   dependency in the k=13 resync case. The property is still pinned by the
   unit test.
7. **Nit — a reset also drops TUI-only rows.** `resetHistory`
   (`tui/state.ts:345`) rebuilds the items from `messages`, so notices and
   background-exit rows vanish. Only `context_note` is listed as a known
   limit (R5).
8. **Nit — one premise row is off by one.** "`methods.ts:55` cancel is a
   notification": `Cancel` is at `:54`, and `:55` is `Progress`.

#### Gate (re-run by the reviewer)

- `bun run check`: tsc clean · Biome clean (304 files).
- Tests, gate run 1 and gate run 2: **1147 pass, 2 skip, 1 fail** (1150
  tests, 117 files). The fail was the known GC flake (`session-reaper.test.ts`
  "a connection forgets a session another client closed") both times.
- Measured flake rate with back-to-back full suites:
  - branch: 2/5 (1148 pass / 2 skip / 0 fail on the clean runs; 4/7
    including the two gate runs);
  - `main` @ `0bfe86c` (a worktree): 2/5 (1110 pass / 2 skip on the clean
    runs).
  - Always that single test, which this task does not touch.
- Same flake, same rate: pre-existing, as `docs/eval/reaper-gc-flaky-test.md`
  documents. No other failure.
- Acceptance tests `bun test packages/client packages/tui`: **350 pass,
  0 fail**.

#### Premise table (opened on `main` @ `0bfe86c`)

| Premise | Status |
|---|---|
| Context symptom (Repro re-run in a `main` worktree) | TRUE — output identical to the doc, line for line; `after.ts` on the branch also identical |
| `permission-router.ts:135-143` `connectionClosed`; called at `remote-client.ts:186` | TRUE |
| `hosted-session.ts:20-27` since at/past a pending request is not replayed | TRUE |
| `hosted-session.ts:223-233` resumed turn emits no `turn_start`, fresh epoch | TRUE |
| `hosted-session.ts:294` fresh `requestId` | TRUE |
| `hosted-session.ts:212-214, 251-261` turn keys restored | TRUE |
| `hosted-session.ts:606-611` key checked before busy | TRUE (`:608`) |
| `hosted-session.ts:474-495` replay inside `attach`, one synchronous segment | TRUE |
| `hosted-session.ts:587-591` single emit path | TRUE (`:586-596`) |
| `hosted-session.ts:671-677` cut moves at `history_commit` | TRUE |
| `hosted-session.ts:541` snapshot `turn` | TRUE |
| `hosted-session.ts:817-820` barrier opens the epoch with its own seq | TRUE |
| `remote-session.ts:131-144` turn error from `ended` | TRUE |
| `protocol/session.ts:165-168` tool-call upsert | TRUE |
| `session.ts:120-126, 130-135, 139-143, 195-206` | TRUE |
| `jsonrpc.ts:32, 42-43`; `persisted-session.ts:233` | TRUE |
| `updates.ts:189-218` catch-all; `mapping.ts:35-51` `classifyUpdate` | TRUE |
| `connection.ts:249-264` retried open drops the old attachment; `:290-299` cancel only reaches an attached session | TRUE |
| `session-host.ts:97-113` open semantics (messages ⇒ create) | TRUE |
| `core/permission.ts:52-60` `signal` | TRUE |
| `remote-client.ts:479-502, 217-230, 310-314, 153` (main) | TRUE |
| `App.tsx:379-380`, `state.ts:188`, `resume.ts:30` | TRUE |
| `remote.test.ts:887, 936, 950, 1000` non-contiguous seqs | TRUE |
| `methods.ts:55` cancel | DRIFTED (`:54`) — nit 8 |
| "No protocol / daemon / transport / cli change; `PROTOCOL_VERSION` stays 6" | TRUE (diff stat) |

#### Mutations (each applied alone; file restored; `git diff main | sha256sum` = `5112a08e…375bd` before and after)

| # | Mutation | Result |
|---|---|---|
| R1 | reducer: drop the `seq ≤ applied` dedupe | RED (4 reducer tests); e2e green — matches M1 |
| R2 | reducer: no buffering while `opening` | RED (11: reducer, E3, E4, e2e) |
| R3 | shell: no `retainOnly` on a reset | RED (E4) |
| R4 | router: `request()` ignores `answeredIds` | RED (router unit only — nit 6) |
| R5 | shell: no generation guard on notifications | RED (generation-guard case) |
| R6 | shell: keyed commands never re-sent | RED (enqueue case, e2e S1+S2) |
| R7 | shell: a never-live session recovered without `create` | RED (first-open-before-leaving case) |
| R9 | session: an acked prompt not re-sent after recovery | RED (e2e S1+S2, timeouts) |
| R13 | link: flap guard off | RED (link-machine test) |
| R8 | session: cancel never re-sent | **green** — finding 1/5 |
| R10 | shell: `snapshot()` not retried across a drop | **green** — finding 5 |
| R11 | shell: `whenLive` ignores `failed` | **green** — finding 2/5 |
| R12 | shell: route unopened sessions' `permission_request` to the router | **green** — finding 5 |
| R14 | shell: never call `answerFailed` | **green** — finding 5 |

#### Attacks tried

1. **Cancel while down** (an unacked prompt + Esc + reconnect): **found**
   finding 1.
2. **A failed session on the no-factory path** (a lossy channel trips the
   reopen guard, then a healthy turn): **found** finding 2. The first turn
   fails loudly; the second hangs.
3. **A large replay through the reducer** (5 k / 20 k / 40 k buffered
   updates): **found** finding 3.
4. **Close racing a recover-then-recreate** (a restarted daemon, close issued
   when the re-open leaves): **found** finding 4.
5. **Stale-generation continuations** (code read of every `await` in `dial`,
   `openOn`, `recreate`, `resync`, `failSession`, `applyOpenResult`): each
   re-checks `gen === this.gen` (and the entry identity) before it mutates
   state. A handshake failure closes its own peer, and that peer's `onClose`
   finds `up` false, so nothing is double-scheduled. `close()` mid-handshake
   closes the current peer and `dial` returns. **Nothing found.** R5 confirms
   the notification guard is pinned.
6. **`whenLive` leaks** (waiters that never settle): every exit — `stop`,
   entry removed (`session_closed`, `closeSession`), `closing`, `failed`,
   `closed` — calls `kick()`, which rejects the waiter. The only waiter that
   never settles is the one "reconnecting forever", which is by design until
   `close()`. **Nothing found.**
7. **Reopen storm / pod-trust spin:** gaps are bounded at 3 a minute per
   session, then `failed`. Dials back off (full jitter, 30 s cap, flap guard).
   Every snapshot is bounded (pages, no-progress check). A hostile daemon
   cannot get a dialog for a session the client never opened: dropped, though
   untested (finding 5). A resync's withdrawn ids cannot make a lasting
   approval, because the answer mapping is unchanged. The one pod-trust gap
   found is memory: the unbounded buffer while an `open` goes unanswered
   (finding 3).
8. **Contract mapping** (`session.ts` open/snapshot/update vs. the client):
   - replay before the response → buffered from `open_sent` (R2 pins it);
   - `resync: true` → snapshot, then the buffer past its `since`;
   - another epoch → treated as a resync;
   - `UnknownSession` → recreate (`messages` ⇒ create, per
     `session-host.ts:103-105`);
   - `created: true` on a recreate race → attach, then `turn_lost`;
   - unknown display update → counted, not shown; unknown mandatory → turn
     failed + cancel (same as today).
   Nothing is "ignored" without a reason.

#### What holds

- **TUI-over-RPC, one session path:** all re-attach logic lives in
  `RemoteClient` and its pure modules. No second agent loop, no new send
  path. The TUI change is a pure fold (`applySessionEvent`).
- **Single broker:** the broker is a constructor argument, never rebuilt.
  E1/E2 and the e2e count one prompt across drops.
- **The RPC peer is not serialized:** no lock or await was added in
  `Connection`/`RpcPeer`. Waiting is per command, on `whenLive`.
- **Pod trust:** the model handlers serve on the peer that received the
  request. Unopened sessions are dropped. Prompts still go through the one
  laptop broker.
- **Obligations:** permission-events finding 2 is met (E2, R3/M10), and
  suspended-turn-resume P4 is met (E4).
- **Inert default, for drop → turn fails:** test-pinned, and the Repro on
  `main` vs `after.ts` behaves as claimed. *Except* finding 2. Two other
  no-factory changes are benign: an extra `session/snapshot` after every
  `compact` (the barrier), and a seq gap now resyncs on the same link.

#### How the executor behaved

The Revision is careful, and its premises check out (one off-by-one). The
property harness is genuinely strong: it caught a real bug (drift 3), and the
Execution reports that honestly. Drifts are declared with reasons, and the
gate claim matches my clean runs (1148/2/0). The weak spot is the classic one
from AGENTS §9: the Revision's failure-mode list was treated as the
checklist, so paths outside the harness's two scripts went untested. Those
are cancel-while-down (D5, a planned rule with no test), the failed-session
state on the no-factory path, and buffer cost at scale. All four defects
above sit exactly there. Not one of the green mutations (R8, R10–R12, R14)
was in the executor's table.

### Eval-stage review (2026-10-19, superseded by the Revision)

*— claude-opus-5-5, 2026-10-19*

**Recommend promoting after `session-event-stream`, `session-registry` and
`permission-events`.** A suspended turn (parent point 8) must render as
"waiting for your approval" with working Approve / Deny after any resync. Scope:
- A **pure, React-free reducer** (AGENTS §7 "logic lives in pure modules"):
  `(state, event | openResult | snapshotPage) → state`; applies `seq > since`,
  drops `seq ≤ since`, rebuilds on resync (discarding the partial round),
  applies `history_replaced`, ignores unknown *display* events, fails loudly on
  an unknown *mandatory* one.
- `RemoteClient`: reconnect with backoff via an injected channel factory;
  `open{sessionId, since}`; on resync, paged `snapshot` → reducer → replay;
  re-send un-acked commands with their idempotency keys.
- Persistence unchanged: the main thread persists from `snapshot` after
  `turn_end` and after every resync.
- TUI: a "reconnecting…" status via the single `StatusLine` path — never raw
  terminal writes (AGENTS §7).
- Test vectors (frame sequence + drop point + expected reducer output) written
  as **JSON fixtures**, validated against the exported schema
  (`docs/feat/protocol-schema-export.md`), so a Swift/Kotlin client can run the
  same cases.

**Why, item by item.**

- **Why in `RemoteClient`, not in each frontend.** If the TUI, the React Native
  app and an ACP adapter each implemented reconnect, they would diverge, and the
  subtle parts (the cut, seq dedupe, the compaction barrier) would be
  re-implemented wrong at least once. One session path (AGENTS §7); React
  Native imports the same TypeScript module.
- **Why a pure reducer.** The logic is a state machine with many edge cases
  (gap, duplicate, resync mid-round, barrier, unknown event). Pure and
  React-free, it can be tested exhaustively as a table, without sockets or
  rendering (AGENTS §7: logic in pure modules; the TUI harness strips SGR, so
  render-time logic is untestable).
- **Why drop `seq ≤ since` instead of trusting the daemon not to resend.**
  Re-sent events are normal: the ack-ambiguity retry, a replay overlapping
  frames that were in flight. Idempotent application is what makes recovery
  safe to repeat.
- **Why discard the partial round on resync.** The snapshot's cut sits *before*
  the round in flight (F1), so replay re-sends that round in full; keeping the
  local partial would show its first part twice.
- **Why fail loudly on an unknown mandatory event.** Ignoring it means a hang:
  a spinner forever, or an approval nobody can see. A loud "please update" is
  recoverable; a silent hang is not.
- **Why an injected channel factory.** Every reconnect needs a fresh socket.
  Injection also allows `FakeWS`-driven tests and lets React Native or Swift
  bring their own transport (the `URL.searchParams` / header issue in
  `ws-channel.ts:69-77`).
- **Why re-send un-acked commands with the same keys.** It is the ambiguous-ack
  case: without the keys a re-send duplicates the command; without the re-send
  the command is lost.
- **Why persist after `turn_end` and after every resync.** Keeps the AGENTS §7
  rule that the client persists from `snapshot`. After a resync the local state
  was rebuilt from the daemon, so persisting then keeps disk aligned with what
  the user sees.
- **Why the status goes through `StatusLine`.** "Reconnecting…" is exactly the
  kind of message someone would `console.log` mid-session, corrupting Ink's
  render (AGENTS §7: never write raw while Ink owns the terminal).
- **Why a backoff cap and stop-on-401.** Unbounded fast retries drain a phone
  battery and hammer the server; a rejected token is not transient, retrying it
  only hides the real problem from the user.
- **Why JSON test vectors.** The property is the contract, not the TypeScript
  code; a Swift or Kotlin client must pass the same cases. Writing them as data
  costs nothing now and avoids a translation later.
- **Why the suspended-turn rendering is called out.** The owner's scenario —
  phone dies on a pending approval, comes back hours later, finds the turn
  waiting with working Approve / Deny — is the acceptance test of the whole
  redesign. If it does not work end to end, the rest does not matter.

Failure modes: reconnect while a command is in flight (re-send with same key);
daemon restarted (`UnknownSession` → recreate with persisted `messages`); token
rejected (stop retrying, surface it); endless flapping (backoff cap +
user-visible state). Mobile note (owned by the mobile eval): a frozen iOS app
reconnects on foreground; this module just has to make that a normal resume.

Tests: the parent's revised property end to end (client + daemon, in-memory
channel pair): every drop point *k*, both re-attach and fresh/forced-resync
mid-round, ordered reducer output (incl. the partial message) + seq contiguity.
Mutations that must fail it: disable seq dedupe; skip the resync snapshot;
ignore `history_replaced`.
