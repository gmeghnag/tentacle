# feat/logs-cmd — `tentacle logs`: read and follow a session without shell redirects

> **Status:** implementation (plan written, NOT approved — see Owner questions)
> **Branch:** `feat/logs-cmd` (umbrella; each sub-task below gets its own `feat/<slug>` branch + doc when it starts, AGENTS §10)
> **Size:** L → split into 3 (`logs-tail` M · `logs-watch` M–L · `logs-follow-detached` M) · **Blast:** load-bearing (sub-task 2 touches the daemon fan-out, §7 "don't serialize the peer"; sub-task 3 the pod trust boundary) · **Suited:** sub-task 1 a weaker model + standard Review; sub-tasks 2–3 a strong model + mandatory fresh-context Review
> **Changelog:** one fragment per sub-task: `changelog.d/logs-tail.added.md`, `changelog.d/logs-watch.added.md`, `changelog.d/logs-follow-detached.added.md`

## Context

*— claude-opus-5-5, 2026-11-13*

**Problem.** There is no way to read or follow what a session does without
opening it in a TUI or redirecting stdout/stderr by hand. A watcher (the owner,
or an orchestrating agent) cannot wait for "an ask, an error or the turn's end"
without reading free text. Sessions that outlive the process that started them
(`run --detach`, `serve`) are the worst case: their diagnostics are split between
`daemon.log` and `relay.log` (TODO.md `feat/logs-cmd`).

**What exists already (owner's design notes, 2026-11-09, verified):**

- Each session already has a typed, one-JSON-object-per-line event log,
  `<uid>.jsonl`: a header line, then `session/log` entries
  (`packages/daemon/src/session-log-file.ts:1-22`). Entry types:
  `base`, `message`, `media_message`, `replace`, `media_replace`, `truncate`,
  `title`, `checkpoint`, `turn_start`, `turn_end`, `call_started`,
  `subagent_background`, `subagent_end` (`packages/protocol/src/session-log.ts:252-266`).
- Where it lives: laptop store `<configDir>/sessions/<projectKey(cwd)>/<uid>.jsonl`
  (`packages/cli/src/main.ts:987`, `packages/cli/src/tui-sessions.ts:84`); a
  `serve` daemon's own copy `<configDir>/daemon/<projectKey(cwd)>/<uid>.jsonl`
  plus `<uid>.state.json` (`packages/cli/src/serve.ts:109-110`).
- A pure, loud, read-only parser exists: `parseLogFile` (`session-log-file.ts:182-349`)
  — tolerates a torn last line and unknown non-critical entries, refuses
  anything else. `LogSessionStore.readRaw` reads without a lock and writes
  nothing (`packages/daemon/src/session-log-store.ts:1172-1186`).
- What the log does NOT have: it is written only at round/turn boundaries;
  pending asks live in the sidecar/memory; streaming text, tool progress and
  other display-only events are never persisted (AGENTS §7: "never
  rendering-only events"). So live following needs the daemon, and AGENTS §7
  forbids adding disk writes inside a turn for it.

**Constraint (owner's bottleneck rule):** the daemon never waits on a watcher —
a bounded queue per watcher, overflow → "N events lost" (or disconnect, said),
a server-side filter (`--only ask,error,turn_end`) so unwanted streamed text is
never even queued, and streaming coalesced like the `subagents` update (250 ms,
`packages/daemon/src/hosted-session.ts:164`).

**Repro** (2026-11-13, on `feat/logs-cmd` = main 5405b61): `logs` is not a
subcommand; `tentacle logs …` falls through to the PROMPT path, i.e. it would be
sent to the model as the text "logs --tail 5". Script
`.tentacle/tmp/logs-cmd/repro.ts`:

```ts
import { cliMode } from "../../../packages/cli/src/flags.ts";

for (const argv of [["logs", "--tail", "5"], ["logs", "-f", "abc"], ["ps"]]) {
  console.log(JSON.stringify(argv), "->", cliMode(argv));
}
```

```
$ bun .tentacle/tmp/logs-cmd/repro.ts
["logs","--tail","5"] -> prompt
["logs","-f","abc"] -> prompt
["ps"] -> ps
```

(`cliMode`, `packages/cli/src/flags.ts:696-721`.) Making `logs` a subcommand
changes `tentacle logs <words>` from a prompt to a command — the same move
`explain` and `config` made, with the same `promptHint` way back
(`packages/cli/src/main.ts:561-570`).

## Implementation

*— claude-opus-5-5, 2026-11-13*

### Load-bearing assumption

**The daemon can feed any number of watchers without ever waiting on one, and
with memory bounded per watcher — but ONLY with a pull (long-poll) delivery, not
with push notifications.** Proof:

1. Every update goes through `HostedSession.emit`, which is synchronous and never
   awaited; each attachment's `send` is called inline
   (`packages/daemon/src/hosted-session.ts:1540-1556`). A watcher hook placed
   there is a synchronous O(1) enqueue — it cannot make the agent loop wait.
2. A push design cannot bound the watcher's memory: `attachment.send` is
   `peer.notify` (`packages/daemon/src/connection.ts:533`) → `DuplexChannel.send`,
   which has no back-pressure signal at all (`packages/transport/src/channel.ts:9-18`);
   the WebSocket channel even discards `ws.send`'s return value
   (`packages/daemon/src/ws-server.ts:142-145`; Bun buffers a slow socket
   in-process). So "the queue is full" is unobservable on push: the bytes would
   pile up in the transport, unbounded.
3. A pull design bounds it: the watcher asks `session/watch_next`; the daemon
   answers with what is queued (or holds the request until something is). At
   most ONE batch is in flight per watcher, so the transport carries at most one
   capped batch; everything else waits in the daemon's bounded queue, where
   overflow is observable and counted. Holding that request never blocks other
   handlers: the peer dispatches every inbound request concurrently
   (`void this.handleRequest`, `packages/transport/src/peer.ts:322`; AGENTS §7).

The cheap test that decides it (first test of sub-task 2): a watcher that never
polls while a turn emits 10 000 `agent_message_chunk`s → every `emit` returns
synchronously, the watcher's queue stays ≤ its cap, the next `watch_next`
returns `lost = N − kept`, and the attached TUI client's stream is unchanged.

### Preconditions

- **A watcher must NOT be an `Attachment`.** `attachments.size` decides real
  behaviour: the blocking-ask fallback (`blockingUnsupported`/`recheckAsks`,
  `hosted-session.ts:1056-1080` — a watcher that declared no `permission_request`
  would make a pending ask be DENIED at once), the detached-session cap
  (`session-host.ts:906`), a quit's `ifLast` (`connection.ts:574`), and
  `session/list`'s `attached` (`hosted-session.ts:1486,1501`), which the relay's
  idle exit and `ps` read (`cli/src/relay-state.ts:270`, `cli/src/pod-resident.ts:567`).
  Watchers live in a separate set, never counted, never a model link, never
  offered an ask to answer.
- **Methods are free** (AGENTS §7 forward-compat): new `session/watch*` methods
  need no `PROTOCOL_VERSION` bump; an older daemon answers `MethodNotFound`,
  which the CLI turns into "this daemon is too old for `logs -f`".
- **Reading the file is safe without the lock**: writers either append whole
  lines or replace the file atomically (temp + rename,
  `session-log-store.ts:1008`); `parseLogFile` ignores a torn last line
  (`session-log-file.ts:187-188`). `logs` never writes, never takes the lock,
  never sets aside.
- **`session/log` needs an `open` today** (`connection.ts:267-270` → `lookup`,
  `:501-511`), and `open` attaches. A watching connection must be allowed to
  read `session/log` for the session it watches (sub-task 2), or `--tail` over
  `connect` would have to attach.
- **Untrusted text.** Messages and tool output can carry terminal escapes; a
  pod's content is pod-supplied (AGENTS §7). Text output goes through
  `untrustedText` (`packages/cli/src/untrusted-text.ts:12`); JSON output must
  escape C1 controls (U+0080–U+009F) too — `JSON.stringify` escapes only
  U+0000–U+001F.

### Design

**One output vocabulary, two sources.** A pure module maps both sources to the
same event lines (`v: 1`, `ts`, `session`, `type`, …): committed log ENTRIES
(`--tail`) and live UPDATES (`-f`). Types: `turn_start`, `turn_end`
(`stopReason`, `error?`), `user`, `assistant` (text), `tool_call` (`callId`,
`name`, a one-line argument summary), `tool_result` (`callId`, chars, head),
`call_started`, `ask` / `ask_resolved` (live only), `text` (coalesced deltas,
live only), `thought` (live only), `subagent_start` / `subagent_end`, `title`,
`segment` (a `base`: reload / compact / context_reset), `notice` (other display
updates), `lost` (`count`), `closed` (`reason`). Default output is one human line
per event; `--json` prints the NDJSON lines (Owner Q2). The NDJSON shape is a
public contract for scripts: pinned by a test, `v` bumped on a breaking change.

**Sub-task 1 — `logs-tail` (M · contained): the file reader, no daemon.**
`tentacle logs [<uid>] [--tail N] [--only …] [--json] [--summary]`.

- Session: a full uid (validated by `isValidSessionId`), else the newest session
  of this project's laptop store (`store.list()`), like `--continue`. Looked up
  in the laptop store, then this project's `serve` store
  (`daemonStoreDir`), then other projects (`findInOtherProjects`,
  `cli/src/session-projects.ts:20`), saying which file it read.
- Reads with `readRaw`-style plain `readFile` + `parseLogFile(text, uid)`
  (strict); refuses loudly (exit 1, the parser's reason) on an unreadable file.
  For a `serve` file with a sidecar, only entries up to the sidecar's head
  (`entriesThrough`, `session-log-file.ts:382`), so nothing a crash left
  uncommitted is shown.
- Projects the CURRENT segment (the history as a resume sees it), with one line
  noting older kept segments if any; applies `--only` (same category names as
  `-f`, below), keeps the last N events (default 20).
- `--summary`: tools used (count by name), files touched (paths from
  `fs_write`/`fs_edit`/`fs_multi_edit` arguments, `packages/tools/src/builtins.ts:115,188,225`),
  turns and the last outcome (`turn_end.stopReason`), open turn if any.
- `-f` in this sub-task: refused with "needs sub-task 2" — OR the file-follow
  fallback (Owner Q4).

**Sub-task 2 — `logs-watch` (M–L · load-bearing): the daemon-side watcher, `-f`
for `serve` (over `connect`).**

- Protocol, new `packages/protocol/src/watch.ts`:
  - `session/watch{sessionId, only?: WatchCategory[]}` → `{watchId, state:{running,
    turnId?, pending: PermissionRequestUpdate[]}}` — needs no `open`, attaches
    nothing, never revives an archived session (unknown/archived →
    `UnknownSession`).
  - `session/watch_next{watchId, timeoutMs?}` → `{updates: SessionUpdateParams[],
    lost: number, ended?: "closed" | "overflow" | "evicted"}` — held until the
    queue is non-empty and the coalescing window passed, or `timeoutMs` (default
    25 s, empty batch). A second concurrent `watch_next` on one watch →
    `InvalidRequest`.
  - `session/unwatch{watchId}` (idempotent).
  - `WATCH_CATEGORIES` + `watchCategoryOf(update)`: the ONE shared map from
    update to category — `ask` (permission_request/resolved), `turn`
    (turn_start/turn_end), `error` (turn_end with `stopReason: "error"`,
    session_closed), `text` (agent_message_chunk), `thought`, `tool` (tool_call,
    tool_call_update, tool_call_phase, tool_progress), `subagent`, `job`,
    `history` (history_replaced), `notice` (the rest). Used by the daemon to
    filter and by the CLI to validate `--only`.
- Daemon, new pure `packages/daemon/src/watch-queue.ts`: a queue bounded in
  bytes (`jsonSize`, `ring.ts:20`) and count; adjacent `agent_message_chunk` /
  `agent_thought_chunk` merged in place (the coalescing — a chunk storm becomes
  one update per poll); flush-now types (`ask`, `turn_end`, `session_closed`)
  wake a held poll at once, the rest after `SUBAGENTS_COALESCE_MS` (250 ms).
  Overflow drops the oldest DROPPABLE update (text, thought, tool progress,
  notice) and counts it; if only non-droppable updates remain and it is still
  full (pathological), the watch ends with `ended: "overflow"` and the CLI says
  so and exits non-zero (Owner Q3).
- `HostedSession`: a `watchers` set separate from `attachments`; `emit` offers
  each update to each watcher AFTER the attachment loop, in try/catch (a
  throwing watcher is dropped, never the turn); the filter runs before enqueue,
  so filtered text is never stored. `watch()` returns the current state
  (running turn, shown asks). On close/delete: each watcher gets `ended:
  "closed"` after the `session_closed` update. Caps: `MAX_WATCHERS_PER_SESSION`
  (8) — the oldest is ended `evicted`; a watcher that has not polled for 60 s is
  dropped (bounded leak on a hung client).
- `Connection`: its own `watches` map, released on connection close; `session/log`
  allowed for a session this connection watches (lookup falls back to the watch
  map, identity-checked like `lookup`); the handlers are synchronous except the
  held `watch_next` (a promise resolved by the queue — no lock, no await chain on
  the peer, §7).
- Client, new `packages/client/src/watch.ts`: `watchSession(peer, …)` — an async
  iterator running the poll loop, parsing each update with the EXISTING update
  schemas (unknown kinds → `notice`), surfacing `lost`/`ended`.
- CLI: `tentacle logs -f <uid> --connect <url> [--token…] [--tls…]` (the
  `connect` flags, `resolveToken`/`resolveTls`, `main.ts:584-585`);
  `--tail N` over `connect` = `session/watch` then `session/log` cold read (no
  attach). Ctrl+C → `unwatch`, exit 0.
- **Read-only is a client property.** A `serve` connection is token-authenticated
  and can already call `session/close`/`delete` without an `open`
  (`connection.ts:566-600`); `logs` simply never calls them. No new authority.

**Sub-task 3 — `logs-follow-detached` (M · load-bearing): `-f` for `run --detach`.**
`tentacle logs -f <run-name>` resolves the run in the laptop kept index (WHERE to
dial comes from the index, never a label, §7), dials the pod's resident daemon
through the engine exec bridge the way a joining `attach` does
(`pod-resident.ts:438` `runBridge`; the exact laptop-side dial to reuse is
verified in that sub-task's own plan), and runs the sub-task-2 watcher. No model
link, no broker, no save, no hand-over, no exit net: it must not appear in the
relay's "in use" read (precondition 1). All pod text is untrusted (sanitized).
`--tail` for a detached run = the laptop copy (sub-task 1), which the relay
keeps saved.

### Files

Sub-task 1 (dependency order):
- `packages/cli/src/log-events.ts` (new, pure): entry → events, update → events
  (the update half lands in sub-task 2), `--only` filter, tail, summary, text and
  JSON rendering (C1-safe).
- `packages/cli/src/logs-cmd.ts` (new): session lookup, file read, output.
- `packages/cli/src/flags.ts`: `logs` in `cliMode` + `ARGS`/`USAGE`.
- `packages/cli/src/main.ts`: dispatch before `loadConfig` needs a model (only
  `configDir`/`cwd`, like `ps`); HELP line.
- `README.md` (command list), `changelog.d/logs-tail.added.md`.

Sub-task 2:
- `packages/protocol/src/watch.ts` (new), `methods.ts` (3 methods + schema
  table), `index.ts`; `schema/protocol.json` regenerated by
  `bun run protocol:bump` at merge (never by hand).
- `packages/daemon/src/watch-queue.ts` (new, pure); `hosted-session.ts`
  (watchers, `emit` hook, close); `connection.ts` (handlers, watch map,
  `session/log` for watched sessions); `session-host.ts` if `watch` needs a
  lookup that does not open.
- `packages/client/src/watch.ts` (new), `index.ts`.
- `packages/cli/src/logs-cmd.ts`, `flags.ts` (`--connect` and friends on `logs`).
- `changelog.d/logs-watch.added.md`.

Sub-task 3: `packages/cli/src/logs-cmd.ts`, the dial helper it reuses
(`attach-run.ts` / `pod-resident.ts`), `changelog.d/logs-follow-detached.added.md`.

### Failure modes

| Case | Convergence |
|---|---|
| Watcher never polls / slow terminal | Queue bounded; oldest droppable dropped and counted; next batch says `lost: N`, printed as `… N events lost`. Daemon unaffected (sync enqueue). |
| Only non-droppable updates overflow | Watch ends `overflow`; CLI prints why, exit 2. Never silent. |
| Hung client, connection open | Not polled 60 s → watcher dropped; a later `watch_next` → `UnknownWatch`, CLI exits with that reason. |
| Connection drops | Watches released with the connection; no session state changed (never attached). CLI exits 1 with the transport error (no auto-reconnect in v1). |
| Session closed/deleted while watched | `session_closed` then `ended: "closed"`; CLI prints `closed (<reason>)`, exit 0. |
| Session id recreated after a close | Watch bound to the `HostedSession` object; ends `closed`, never follows the new one. |
| Watch on an archived / unknown session | `UnknownSession`; CLI suggests `logs --tail` on the `serve` host's store. Never reopens it. |
| Pending ask when the watch starts | Returned in `state.pending`, printed first: a watcher waiting for `ask` never misses one raised before it arrived. |
| Watcher counted as attached | Designed out (separate set); tested: an ask stays pending, `session/list.attached` unchanged, detached cap and `ifLast` unchanged. |
| Older daemon | `MethodNotFound` → "daemon too old for `logs -f`", exit 1. |
| `--only` unknown category | CLI error before dialing (schema enum); newer CLI category on older daemon → `InvalidParams`, said. |
| File torn / rewritten mid-read | Torn line ignored; a rename gives a whole old or new file; strict refusal on real corruption (exit 1, reason, path). |
| `serve` log with entries past the sidecar head | Only up to the head shown (sub-task 1, `entriesThrough`). |
| Empty session / no session in project | "no session in <project>", exit 1; `--tail 0` prints nothing. |
| Terminal escapes in model/tool/pod text | Text mode: `untrustedText`; JSON: C0 + C1 escaped. |
| Concurrent `watch_next` on one watch | Second → `InvalidRequest`; never two batches in flight. |

### Tests

Sub-task 1 (`packages/cli/test/log-events.test.ts`, `logs-cmd.test.ts`; fixtures
built with `headerLine`/`entryLines`, `session-log-file.ts:474,487`):
- each entry type → its event; tail N; `--only`; summary counts and paths;
  current-segment only with a kept older segment; `serve` file cut at the
  sidecar head; torn last line tolerated; a corrupt line → exit 1 with the
  reason; C1/ESC escaped in both modes; `cliMode(["logs",…]) === "logs"` (red on
  main — the repro above); the NDJSON shape pinned.

Sub-task 2:
- `watch-queue.test.ts` (pure): byte/count cap, drop-oldest-droppable, `lost`
  count exact, chunk merge, flush-now vs 250 ms (injected clock), overflow end.
- `hosted-session` tests: **the load-bearing test** (non-polling watcher + 10 000
  chunks: emit sync, queue ≤ cap, attached client's frames identical to a run
  without the watcher); filter excludes text from the queue (byte count proves
  it); watcher does not change `attachedCount`, a pending ask is NOT denied with
  only a watcher present (mutation check: add the watcher to `attachments` →
  the test must fail); close → `ended: "closed"`; throwing watcher does not
  break the turn.
- `connection` tests over `createChannelPair` (`transport/src/channel.ts:30`): a
  held `watch_next` does not delay a concurrent `session/resolve_permission`;
  `session/log` allowed for a watched session, refused otherwise; connection
  close releases watches; old-daemon `MethodNotFound` path in the client.

Sub-task 3: fake engine host / fake bridge (existing `attach-run` fakes): the
watch never shows up as attached in `session/list`, no exit net armed, pod text
sanitized.

### Owner questions

1. **Split** into 3 sub-tasks (`logs-tail` → `logs-watch` → `logs-follow-detached`),
   each its own branch and doc? *Rec: yes — sub-task 1 alone already serves
   ended sessions with no daemon and is safe for a weaker model.*
2. **Default output**: human lines with `--json` for NDJSON, or NDJSON always?
   *Rec: human by default, `--json` explicit (no TTY auto-switch: surprising in
   scripts).*
3. **Overflow policy**: drop-with-count, or disconnect? *Rec: drop the oldest
   droppable (text/progress) and report `N events lost`; disconnect only when
   asks/turn ends themselves would be lost.*
4. **`-f` with no reachable daemon** (a laptop session in another TUI's
   in-process worker, an ended run): refuse, or follow the FILE (committed events
   only, no asks/streaming, said on stderr)? *Rec: follow the file in sub-task 1
   (poll + re-parse by entry id) — cheap, and the only option for in-process
   sessions.*
5. **Delivery**: pull (`watch_next` long-poll) as proved above, or push with a
   credit/ack window? *Rec: pull — bounded by construction on every
   `DuplexChannel`, no new flow-control state.*
6. **`daemon.log` / `relay.log`**: should `logs` merge their free-text errors?
   *Rec: no in v1 — the stream's `turn_end{error}` and `closed` cover the
   session; `logs` prints those files' paths in `--summary` instead.*
7. **Session selector**: full uid only (+ newest by default), or uid prefixes and
   titles? *Rec: full uid + newest + `<run-name>` (sub-task 3); prefixes later
   (they need an ambiguity rule across two stores).*
8. **Limits**: 8 watchers per session, 60 s poll-idle drop, 25 s long-poll,
   queue 1 MiB — config keys or constants? *Rec: constants in v1 (they bound
   memory, not behaviour); make them keys only if a real use needs it.*

#### Owner answers (2026-11-14, one at a time)

- Q1 split: **yes, 3 sub-tasks** (logs-tail → logs-watch → logs-follow-detached) — BUT **one single review for all three** (owner): execute the three in order on one branch, then one fresh Opus review of the whole, then merge.
- Q2 output: **(a)** human lines by default, `--json` for NDJSON, no TTY auto-switch.
- Q3 overflow: **(a)** drop oldest droppable (text/progress) with `N events lost`; disconnect only when asks/turn ends would be lost.
- Q4 `-f` with no reachable daemon: **(a)** follow the FILE (poll + re-parse by entry id; committed events only; said on stderr), in sub-task 1.
- Q5 delivery: **(a)** pull (`watch_next` long-poll, 25 s).
- Q6 daemon.log/relay.log: **(a)** not merged in v1; `--summary` prints their paths.
