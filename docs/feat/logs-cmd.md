# feat/logs-cmd — `tentacle logs`: read and follow a session without shell redirects

> **Status:** implementation approved (owner 2026-11-14); all three sub-tasks executed — see *Execution — logs-tail* / *Execution — logs-watch* / *Execution — logs-follow-detached*; one fresh-context review due for the three together (owner)
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
- Q7 selector: **(a)** newest by default, full uid, `<run-name>` in sub-task 3; prefixes/titles later.
- Q8 limits: **(a)** constants in v1.

Implementation APPROVED (owner 2026-11-14).

### Execution — logs-tail

*— claude-opus-5-5, 2026-11-14*

**As built, in order.** (1) The Context's repro re-run first, on this branch
before any edit: `["logs","--tail","5"] -> prompt`, `["logs","-f","abc"] ->
prompt`, `["ps"] -> ps` — the capability is missing, as the doc says. (2)
`packages/cli/src/log-events.ts` (new, pure): `LogEvent`, `eventsOf` (the
entry→event map, folding the projection with the SAME rules as
`projectEntry`), `categoriesOf`/`parseOnly`/`filterEvents`, `takeLast`,
`formatEvent`, `jsonLine` (C1/DEL escaped), `filesTouched`, `summarize`,
`formatSummary`. (3) `packages/cli/src/logs-cmd.ts` (new): the lookup
(this project's laptop store → this project's `serve` store → other projects'
both), an unlocked `readRaw` + strict `parseLogFile`, the `serve` cut at the
sidecar's `logHead` (`entriesThrough`), the current segment only, and the `-f`
file fallback (owner Q4). (4) `flags.ts`: `logs` in `SUBCOMMANDS`/`CliMode`,
its `ARGS` spec, `USAGE.logs`, `modeUsesModel(...)` = false. (5) `main.ts`: the
dispatch beside `ps`/`rm` (before any engine work), the `logs` prompt-hint arm,
two test seams (`logsSleep`, `logsSignal`), and the HELP entry. (6) `README.md`
— the command line, a short section, and one clause in the summary. (7)
`changelog.d/logs-tail.added.md`.

**Drift from the Implementation, and why.**

1. *`LOG_CATEGORIES` is `ask, turn, error, text, thought, tool, subagent, job,
   history, notice`* — exactly the plan's list. Sub-task 1 only ever produces
   the subset its entry types can (`turn`, `error`, `text`, `tool`,
   `subagent`, `history`, `notice`); `ask`/`thought`/`job` are accepted by
   `--only` today so a script written now keeps working once sub-task 2's
   watcher feeds them (refusing a name the doc publishes would be the drift).
2. *`messages` in `--summary` counts the history's messages*, not the emitted
   text events: an assistant turn with no text but two tool calls is ONE
   message and three events. A test pins it.
3. *`--only` accepts names no entry type of sub-task 1 can produce* (see 1) but
   does NOT accept an unknown one, and the refusal names it and the choices.
4. *A state file this build cannot read* (a newer `schemaVersion`) does not
   refuse the whole read the way `load` would: the LOG parsed strictly, so it
   is shown as its current segment, and the sidecar's reason is printed on
   stderr. The plan only fixed "cut at the sidecar's head"; refusing a readable
   log over a sidecar this build merely does not know would make the
   forward-compat failure worse than the fact it guards (nothing is written,
   nothing is hidden that the log itself does not say). Named here because it is
   a judgement, not a reading of the plan.
5. *`-f` is `--follow`'s one-letter alias* (as `tail -f`), plus `--follow` in
   full; the plan wrote only `-f`.
6. *The run's free-text log paths come from the laptop's kept index*
   (`readKept` + `runDirFor`, `run-state.ts:129`) — the plan's Files list did
   not name `kept-index.ts`/`run-state.ts` for sub-task 1, because owner Q6
   (paths in `--summary`) is a sub-task-1 obligation.

**Deliberately not done (sub-task 2/3).** No protocol, daemon, client or watcher
change: `-f` follows the file only, says so on stderr, and a live ask/streaming
delta is not shown. `logs -f <uid> --connect` is not accepted yet (a flag, not a
behaviour change, so it lands with the watcher it drives). `-f`'s stop is the
process's own default (Ctrl+C), through the `logsSignal` seam `main` passes; the
graceful `unwatch`-then-exit-0 shape belongs to the watcher (the plan puts it
there), and a file follow has nothing to release.

**Verification (the gate, on the final tree).** `bunx tsc --noEmit` clean;
`bun run lint` — 1068 files, 0 errors/0 warnings (the §6 baseline);
`bun test` — 8309 pass, 3 skip (the three opt-in skips), 0 fail. Two earlier
full runs each showed one or two timeouts in `packages/cli/test/attach-run.test.ts`
(a `/quit` case and an "attach without re-injecting" case, at 5 s / 62 ms under
suite load); that file passes alone (61/61) and the final whole-suite run is
green, and nothing in this task touches the attach path or the engine runtime
(the diff is `flags.ts`, `main.ts`'s `logs` branch, two new modules and their
tests), so those are the suite's known timing flake, not this change.

**Tests (red before green).** New: `packages/cli/test/log-events.test.ts` (12
tests) and `packages/cli/test/logs-cmd.test.ts` (19). Each names the mutation
that turns it red; the mutation check was RUN, not asserted (13 mutations, each
applied to the source, the two test files run, the source restored). Pasted
output (mutation → pass/fail → the test that went red):

```
M1  cliMode drops `logs`                                  → 14 fail
M2  sidecar head ignored (whole segment shown)             → 1 fail  · a serve copy is cut at the sidecar's head
M3  follow does not resume by entry id (reprints all)      → 1 fail  · -f prints the first batch, then only what is new
M4  the file is parsed LAX (malformed entry half-loaded)   → 1 fail  · a malformed message is refused, not half-loaded
M5  an unknown --only category is accepted                 → 2 fail  · an unknown name is refused / --only narrows
M6  newest is taken as the OLDEST record                   → 1 fail  · the newest session of this project
M7  JSON does not escape C1                                → 2 fail  · C1-escaped / JSON escapes DEL and C1
M8  files touched counts every tool's path                 → 1 fail  · paths of fs_write/fs_edit/fs_multi_edit
M9  no `segment` event for a base entry                    → 6 fail  · whole turn / title+sub-agent / serve cut
M10 tool arguments are not sanitized to one line           → 1 fail  · a whole turn (args stay one line)
M11 text mode prints raw text (no untrustedText)           → 1 fail  · text mode strips ESC and C1
M12 media_message/media_replace folded as unknown          → 1 fail  · an image's prompt survives a replace
M13 --summary names no run                                 → 1 fail  · a detached run's daemon/relay log paths
```
Plus `USES_MODEL.logs: true` → 3 fail in
`packages/cli/test/model-free-commands.test.ts` (a failing `apiKeyCommand` must
not stop `logs`).

**Evidence (the capability, on the final tree).** A hand-built laptop log for the
current folder, then the three modes (`.tentacle/tmp/logs-cmd/demo.ts`, gitignored
— the script builds `base`, a turn, a message with an ESC-wrapped text and an
`fs_write` call, the result, and `turn_end`):

```
$ TENTACLE_CONFIG_DIR=… bun packages/cli/src/main.ts logs --tail 6
02:16:09 · you: add a parser
02:16:09 · agent: [31mwriting [0m            ← the ESC is gone: untrustedText
02:16:09 · tool fs_write {"path":"src/parse.ts","content":"…"}
02:16:09 · call c1 started
02:16:09 · result 29 chars: wrote src/parse.ts (42 lines)
02:16:09 · turn end t1 — end_turn
$ TENTACLE_CONFIG_DIR=… bun packages/cli/src/main.ts logs --json --tail 1
{"v":1,"ts":…,"session":"025e6a9d-…","type":"turn_end","turnId":"t1","stopReason":"end_turn"}
$ TENTACLE_CONFIG_DIR=… bun packages/cli/src/main.ts logs --summary
session   025e6a9d-d332-4a45-9051-8a957fa31811
file      …/sessions/logs-cmd-b14189bc618d/025e6a9d-….jsonl
project   …/worktrees/logs-cmd
model     claude-x
messages  3
turns     1 (last end_turn)
tools     fs_write ×1
files     src/parse.ts
```

**Gate line.** `tsc --noEmit` OK · `bun run lint` OK (0/0) · `bun test` 8309
pass / 3 opt-in skips / 0 fail.

### Execution — logs-watch

*— rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, 2026-11-15*

**Repro (red, before any edit).** `.tentacle/tmp/logs-cmd/repro-watch.ts` on the
branch as it stood:

```
$ bun .tentacle/tmp/logs-cmd/repro-watch.ts
parse logs --connect: {"ok":false,"error":"unknown option --connect"}
Method.Watch: undefined | Method.WatchNext: undefined | Method.Unwatch: undefined
WATCH_CATEGORIES: undefined
UnknownWatch code: undefined
HostedSession.watch: undefined
```

**As built, in order** (the Implementation's dependency order).

1. `packages/protocol/src/watch.ts` (new): `WATCH_CATEGORIES`,
   `watchCategoriesOf` (the ONE update→category map), `watchAccepts`,
   `WatchState`, the three methods' params/results, `MAX_WATCHERS_PER_SESSION`
   (8), `WATCH_POLL_TIMEOUT_MS` (25 s) + a 60 s max. `methods.ts`: the three
   names and their schema-table entries. `index.ts`: the export.
   `jsonrpc.ts`: `DomainErrorCode.UnknownWatch = -32018`.
   `schema/protocol.json` regenerated with `bun run schema:export` (+149 lines,
   `x-protocol-version` unchanged — new methods are free, AGENTS §7).
2. `packages/daemon/src/watch-queue.ts` (new, pure): `WatchQueue` — byte AND
   count bound, drop-oldest-droppable, exact `lost` count, adjacent-chunk
   merging (a NEW update, never a mutation of the emitter's), `dueAt` (the
   coalescing window), `end` (first reason wins, queue kept for the last batch).
3. `packages/daemon/src/watchers.ts` (new): `SessionWatchers` — the watcher set
   (never `attachments`), `offer` from `emit` (per-watcher try/catch, idle drop,
   filter before the queue), `next` (the held poll, one in flight), `close`,
   `endAll`, injected clock+timers.
4. `HostedSession`: a `watchers` field built with the session's own `now`;
   `emit` offers each update to the watchers AFTER the attachment loop;
   `watch(only)` / `watchNext` / `unwatch`; `close` ends them all after
   `session_closed`. `PendingAsk` now keeps its streamed `update`, which is what
   `state.pending` repeats.
5. `Connection`: a `watches` map (released on close), the three handlers,
   `session/log` served through a new `readable()` (an opened session OR a
   watched one, identity-checked like `lookup`), `dropStaleWatches`.
6. `packages/client/src/watch.ts` (new): `openWatch` / `pollWatch` (parses every
   update with the EXISTING schema, surfaces `lost`/`ended` and unknown kinds) /
   `closeWatch` / `UNKNOWN_WATCH_HINT`; exported from `index.ts`.
7. CLI: `log-events.ts` gains the update half of the ONE vocabulary
   (`updateEvents`), the live event types (`text`, `thought`, `ask`,
   `ask_resolved`, `lost`, `closed`), their categories and their rendering;
   `logs-cmd.ts` gains `--connect` (`followDaemon`: the poll loop, `unwatch` in
   `finally`, exit 0/1/2) and `readDaemon` (`--tail` over `session/log`);
   `flags.ts` gives `logs` the `connect` token/TLS flags; `main.ts` resolves
   them and passes a `logsDial` seam.
8. `README.md` (the live paragraph + the new usage line),
   `changelog.d/logs-watch.added.md`.

**Drift from the Implementation, and why.**

1. *`WATCH_COALESCE_MS` (250 ms) lives with the queue, not imported from
   `hosted-session.ts`*: `hosted-session` imports `watchers`, so importing
   `SUBAGENTS_COALESCE_MS` back would be a cycle. Same value, pinned by a test.
2. *The merge produces a NEW update instead of concatenating in place.* The
   in-place version mutates the object the replay ring and every other
   attachment hold: the stream would grow under them. A test pins that the
   emitter's object is untouched.
3. *`updateEvents` folds the state-only updates (plan, usage, queue, settings,
   `subagents`/`jobs` lists, steer) into NO line*, where the plan listed
   `notice` as "the rest". They arrive many times per turn (a usage tick per
   round) and each carries state a line-per-event follower has no question for;
   every fact a follower needs is in the turn's own events. Named because it is
   a judgement about the vocabulary, not a reading of the plan.
4. *`ended: "evicted"` exits 1, not 0*: an eviction is not the session ending,
   so a script must see it. Only `closed` is a normal stop (0); `overflow` is 2
   (owner Q3's "said, exit non-zero").
5. *A `lost` event belongs to EVERY `--only` filter* (its category list is all
   of them): dropping the "N lost" notice because the user filtered to `ask` is
   exactly the silent drop owner Q3 forbids.
6. *`--connect` requires a uid, and refuses `--summary`.* A remote "newest"
   would be another project's newest on that host — a guess; and a summary is a
   FILE's facts (path, project, kept segments) that a remote read has not got.
   Both refuse with the command to run instead (exit 1).
7. *The watcher's hold sleeps to the next interesting instant* (the coalescing
   window's end or the deadline) rather than one timer per window: a push wakes
   it early and the loop recomputes. Same observable behaviour, one timer.
8. *An ended watcher is forgotten once its last batch is delivered, and `open`
   prunes already-ended ones.* Without this the 8-watcher cap could never free a
   slot (found by the cap test hanging), and a client could park 8 unread ended
   queues per session.
9. *`--tail --connect` starts a watch first, then reads `session/log`*: that is
   how the connection earns the read without an `open` (sub-task 1's
   precondition), so `--tail` attaches nothing. A test asserts `attachedCount`
   is unchanged.

**Deliberately not done.** No auto-reconnect (v1, as the plan's failure table
says: a dropped connection exits 1 with the transport error). No `-f` for a
`run --detach` pod daemon (sub-task 3). `daemon.log`/`relay.log` are still not
merged (owner Q6). The file-follow fallback (owner Q4) is untouched and still
what `-f` does without `--connect`.

**Tests (red before green).** New: `packages/daemon/test/watch-queue.test.ts`
(15, pure), `packages/daemon/test/watch-hosted.test.ts` (12, the load-bearing
block first), `packages/daemon/test/watch-connection.test.ts` (8),
`packages/cli/test/logs-watch.test.ts` (14). Plus the protocol fixture set for
the three methods (`packages/protocol/test/json-schema.test.ts`) and the
category-drift pin (`LOG_CATEGORIES` must equal `WATCH_CATEGORIES`).

The load-bearing test, as the plan specified it: a watcher that never polls
while a turn streams 10 000 chunks — `prompt` returns at once, the turn finishes
promptly, the attached client's frame list is IDENTICAL to the same run without
the watcher, and the next poll returns ONE coalesced `agent_message_chunk` of
10 000 characters (`lost: 0`: merging, not dropping, absorbed the storm).

**Mutation checks — RUN, not asserted.** Each mutation was applied to the
source, the named test files run, the source restored (17 mutations, two
rounds; the second round re-expressed five that the first could not write in
`sed`). Pasted: mutation → failing tests → the test that went red.

```
M1  queue's COUNT cap ignored (items.length > MAX → false)      → 2 fail · an ask or a turn's end is NEVER dropped
M2  queue's BYTE cap ignored                                    → 1 fail · holds at most WATCH_QUEUE_MAX_BYTES
M3  drop ANY entry when full (findIndex → 0)                    → 1 fail · an ask or a turn's end is NEVER dropped
M4  never merge adjacent chunks                                 → 1 fail · adjacent text chunks merge into ONE
M5  the filter always accepts (accepts → true)                  → 4 fail · a failed turn's end is `turn` AND `error`
M6  watch() adds to `attachments`                               → 1 fail · a watcher is NOT an attachment
M7  close() does not endAll                                     → 2 fail · a failed turn's end is… / a closing session
M8  two concurrent watch_next allowed                           → 2 fail · a second concurrent watch_next is InvalidParams
M9  a watcher's throw escapes `offer`                           → 1 fail · a throwing watcher is DROPPED, never the turn
M10 session/log via lookup only (a watch does not count)        → 1 fail · session/log is readable for a WATCHED session
M11 an unknown watch id resolves instead of UnknownWatch        → 1 fail · unwatch is idempotent and releases the watcher
M12 text mode prints the raw text (no untrustedText)            → 1 fail · text mode sanitises a pod's escapes
M13 `lost` gets one category instead of all                     → 1 fail · a lost count belongs to every --only
M14 a failed turn_end is only `turn`                            → 1 fail · a failed turn's end is `turn` AND `error`
M15 session_closed is `notice`, not `error`                     → 1 fail · a closed session is an `error` event
M16 Ctrl+C exits 1 instead of 0                                 → 1 fail · a Ctrl+C stops the follow with exit 0
M17 MethodNotFound not worded as "too old"                      → 1 fail · a daemon too old for session/watch says so
M18 --tail --connect reads without a watch first                → 1 fail · --tail reads the log without attaching
```

The two that first passed (M9, M11) were TEST weaknesses, not code wins: the
throw test stubbed the whole `offer` instead of one watcher's queue (so it
could not see a sibling lose the stream), and the unknown-id test stopped at
`unwatch`, which is deliberately idempotent. Both tests were rewritten to pin
the real property (a broken watcher is dropped while its sibling keeps
streaming; an unwatched/released id is `UnknownWatch` on the next poll) and were
then RED on their mutation — the loop §9 warns about, caught by mutating.

**Gate line.** `bunx tsc --noEmit` OK · `bun run lint` OK (1076 files, 0
errors/0 warnings — the §6 baseline) · `bun test` 8358 pass / 3 opt-in skips /
0 fail (8309 + the 49 new tests of this sub-task).

### Execution — logs-follow-detached

*— claude-sonnet-4-6 (tentacle executor), 2026-11-15*

**Repro (red, before any edit).** The capability is missing by construction on
this branch: `logs -f <run-name>` never looked at the kept index, so the word
went straight to `resolve()` as a session id and answered
`[error] no session box in …` for a run `ps` lists (and the same for
`--tail <run-name>`). The missing seam is `logsHostFor` on `main`'s IO: without
it a detached run's pod cannot be reached at all. Proven as the first RED below.

**As built, in order** (the Implementation's dependency order).

1. `packages/cli/src/logs-run.ts` (new, pure): `pickRun` — WHICH kept entry and
   WHICH session a word names. One place wins; a name at several places takes the
   ONE that is live, and is `ambiguous` with none (or two) live; a run dir's
   `owner.json` counts only when its `created` matches the entry's (a run dir
   outlives a reused name); no record and no `entry.sessionId` is `no-session`;
   no entry at all is `absent`. `live` is the run dir's lock (`lockHolder`).
2. `packages/cli/src/logs-cmd.ts`: `followDaemon` split so the WATCHER takes an
   already-dialled channel (`watchChannel(…, where)`) — one follower for a
   `serve` URL and for a pod, none of sub-task 2's loop duplicated; `followRun`
   (`hostFor` → `dialVerdict` → `openExec(podDaemonCommand(binPath))` →
   `watchChannel`); `followFile` (an ended run's saved copy); `resolveWord` (a
   word is a run first, else a session id — a run is matched only against the
   index's own names); `logsCommand` routes `-f` to `followRun` and `--tail` to
   the run's SESSION, so it reads the relay's saved laptop copy.
3. `packages/cli/src/main.ts`: the `logsHostFor` seam, and in a real run
   `buildEngineHost(entry.engine, hostOptionsFor(entry))` — WHERE comes from the
   kept index, never a label. `flags.ts`/`main.ts`: the usage line.
4. `README.md` (the detached-run paragraph + the usage line),
   `changelog.d/logs-follow-detached.added.md`.

**Drift from the Implementation, and why.**

1. *The dial is composed here, not imported from `attach-run.ts`.* The plan said
   "the exact laptop-side dial to reuse is verified in that sub-task's own
   plan". Verified: `attach`'s dial is three `EngineHost` calls inside
   `attachEngineRuntime` (`engine-runtime.ts:1046-1050`) with no state of their
   own — there is no helper to import. The PARTS are reused (`podDaemonCommand`,
   `dialVerdict`'s preflight, `hostOptionsFor`), so the seam is the same, while
   `attachEngineRuntime` (broker, saver, model link, exit net) does not run for
   a follower. `watchChannel` is the extracted shared follower: no send/stream
   logic is copied.
2. *A run whose lock is released is NOT dialled.* The plan's sub-task-3 text has
   only the live path. An ended run's resident is gone with its relay, so
   dialling would exec into a dead workload: `-f` says so once and follows the
   laptop copy (owner Q4's fallback, sub-task 1's code), which is also what
   makes the ended case honest rather than silent.
3. *`--tail <run-name>` resolves the run but never dials* — the plan's own rule
   ("`--tail` for a detached run = the laptop copy"), implemented as one
   selector so a word means the same thing in both halves.
4. *`--connect` still needs an explicit uid.* Only a bare `-f` word is a run
   name: a remote daemon's kept index is not this laptop's.
5. *`container` comes from `host.defaultContainer`, not the kept entry.* k8s
   execs into the agent container; a name read off the workload would let
   pod-supplied input choose where we run.

**Deliberately not done.** No auto-reconnect (v1, unchanged from sub-task 2). No
`--summary` of a pod's live state (a summary is a FILE's facts). The relay's
`daemon.log`/`relay.log` are still not merged (owner Q6). Nothing is published to
`session/list` for a follower — staying invisible is the point.

**Tests (red before green).** New: `packages/cli/test/logs-follow-detached.test.ts`
(13: 5 pure `pickRun`, 7 `-f` over a fake engine whose `openExec` returns a real
`SessionHost`+`Connection` — the pod daemon —, 1 `--tail`). RED was demonstrated
by disabling the new dispatch (`resolveWord` → the word as a session id), which
failed 6 of the 13 on the property each names (not on an import). The
load-bearing pair: `attachedCount` is unchanged across a whole follow (a
follower is not an attachment, so the relay's "in use" read and `ps` never see
it), and no `create`/`remove`/`removeBestEffort` is called — no exit net, no
lifecycle of any kind.

**Mutation checks — RUN, not asserted.** Each mutation was applied to the source,
the test file run, and the source restored from a copy under
`.tentacle/tmp/logs-cmd/`. Mutation → red test(s):

```
M1  pickRun: live is always true                     → 2 · one entry, live … / an ended run is NOT dialled
M2  pickRun: the first entry wins (never ambiguous)   → 3 · … two places, one live … / ambiguous … / the CLI's ambiguous refusal
M3  pickRun: any owner.json is trusted                → 1 · another workload's record is not this run's
M4  an ended run is dialled anyway                    → 1 · an ended run is NOT dialled
M5  no dialVerdict preflight                          → 1 · a gone workload is refused in the engine's words
M6  the run name printed raw (no untrustedText)       → 1 · pod text cannot reach the terminal raw
M7  host.removeBestEffort() on the way out            → 1 · … follows live, unattached (the no-lifecycle claim)
M8  no-session falls through to a session id          → 1 · a kept run with no session yet is refused
M9  the follower calls `session/open` before watching → 1 · … follows live, unattached (attachedCount)
M10 the exec runs `serve --stdio`, not the bridge     → 1 · … follows live, unattached (the command)
M11 `--tail` ignores the run word                     → 1 · --tail <run-name> reads the run's session FILE
M12 no run resolution at all                          → 6 · the whole run-selection path
M13 MethodNotFound not worded as "too old"            → 1 · a pod's older tentacle says so
```

Every one was RED on the assertion of its property; M12 is the REPRO re-run as a
mutation (the same shutdown of the new dispatch).

**Gate line.** `bunx tsc --noEmit` OK · `bun run lint` OK (1078 files, 0
errors/0 warnings — the §6 baseline) · `bun test` 8371 pass / 3 opt-in skips /
0 fail (8358 + the 13 new tests of this sub-task).

### Fix round 1

*— claude-opus-5-5, 2026-11-14*

Fixing the two MEDIUM findings of the Review above; no other code touched.

**Repro first.** Re-ran the review's repro (`.tentacle/tmp/logs-cmd/two-watches.test.ts`,
real `Connection` + `SessionHost`) on the unmodified branch — both symptoms
reproduced:

```
first watch after a second watch: "ERR unknown watch: dd7d2b27-… (not on this connection)"
watch after a failed session/log: "ERR unknown watch: 9a86fe3d-… (not on this connection)"
```

**Finding 1 — FIXED.** `packages/daemon/src/connection.ts:653-661`
`dropStaleWatches` iterated `this.watches` (keyed by **watchId**) and passed the
key to `this.host.get(id)` as a **session id** — always `undefined`, so every
watch the connection held was unwatched on each `session/watch` and on each
refused `session/log`. The sweep now compares the watch's own session id and
unwatches by the map key:

```ts
for (const [watchId, watch] of this.watches) {
  // The map key is a WATCH id; the identity check is per SESSION id.
  if (this.host.get(watch.hosted.id) !== watch.hosted) { watch.hosted.unwatch(watchId); this.watches.delete(watchId); }
}
```

The identity check it exists for (a session closed and recreated under the same
id) is unchanged — and now actually what it drops.

**Finding 2 — FIXED (non-vacuity).** Two red-first tests in
`packages/daemon/test/watch-connection.test.ts` (`daemon()` now also returns the
`connection`, which the repo had only exposed as `watchedSessionIds` for
diagnostics):

- `two watches on one connection both stay live (a watchId is not a sessionId)` —
  watch A, then B on one connection: A still polls, `watchedSessionIds` is
  `[A, B]`, and a refused `session/log` (the sweep's other trigger) drops
  neither.
- `a session id closed and recreated under the same id drops its stale watch` —
  the failure-mode row that had no connection-level test: the old watchId is
  `UnknownWatch` after the recreate, the fresh watch polls, one id held.

**Red before green** (unmodified source, tests added): `9 pass / 1 fail` — the
two-watches test failed on the property (`RpcError: unknown watch: b8929199-…
(not on this connection)`), not on a compile/import error. After the source fix:
`10 pass / 0 fail`.

**Mutations** (source edited in place, run, restored from
`.tentacle/tmp/logs-cmd/connection.fixed.bak`):

```
M1  dropStaleWatches(){ return; }                     → 1 · … drops its stale watch (UnknownWatch expected, got a live poll)
M2  host.get(watchId) !== watch.hosted  (the bug)      → 1 · two watches on one connection both stay live
```

M1 shows finding 1's fix did not make the identity check vacuous, M2 shows the
key-confusion is what the first test pins — so the pair covers both the "drop
too much" and the "drop nothing" side.

**Gate line.** `bunx tsc --noEmit` OK · `bun run lint` OK (1078 files, 0
errors/0 warnings — the §6 baseline) · `bun test` 8373 pass / 3 opt-in skips /
0 fail (8371 + the 2 new tests).

## Review

*— claude-opus-5-5, 2026-11-14* (fresh context; same model family as the logs-tail executor — shared blind spots possible)

**Verdict: REQUEST-CHANGES**

**Findings (HIGH/MEDIUM only).**

1. **MEDIUM — `packages/daemon/src/connection.ts:655-662` `dropStaleWatches` compares a watchId as a sessionId.** `this.watches` is keyed by `watchId`, but the loop calls `this.host.get(id)` with that key: always `undefined`, so EVERY watch already held by the connection is unwatched. It runs on every `session/watch` (`:626`) and on every refused `session/log` (`:686`). Repro (`.tentacle/tmp/logs-cmd/two-watches.test.ts`, real `Connection`+`SessionHost`): watch A, then watch B on the same connection → `watch_next(A)` = `unknown watch … (not on this connection)`; watch A again, then `session/log{sessionId:"nope"}` → `watch_next(A)` = `UnknownWatch`. A protocol client following two sessions over one connection (an orchestrator, a future TUI pane) silently loses the first follow; the close-and-recreate identity check the method exists for only "works" because it drops everything. Fix: compare `this.host.get(watch.hosted.id) !== watch.hosted`.
2. **MEDIUM (test non-vacuity, §9) — `dropStaleWatches` is untested.** Mutation `dropStaleWatches(){ return; }` → `watch-connection`, `watch-hosted`, `logs-watch`, `logs-follow-detached`: 47 pass / 0 fail. Neither the close-then-recreate case (the doc's failure-mode row "Session id recreated after a close") at the connection layer nor two watches on one connection is pinned. Needs a red-first test for both.

**Gate.** `bun run typecheck` clean · `bun run lint` 1078 files, 0/0 · touched test files (10, incl. protocol `json-schema`/`version`): 128 pass / 0 fail. Full `bun test` not re-run by this review (scope: touched files, per the reviewer's instructions).

**Attacks tried.**
- §7 "don't serialize the peer": `watch_next` returns the hold's promise, no lock/await chain in `Connection`; `watch`/`unwatch` synchronous — holds.
- Watcher counted as attached: separate `SessionWatchers` set, `emit` offers after the attachment loop in per-watcher try/catch; relay's in-use read (`relay-state.ts:290`) uses `session/list.attached` — holds. Note (below MEDIUM): the pod resident's own idle exit counts open sockets (`pod-resident.ts:349`), so a running `logs -f <run>` keeps the resident alive; benign (it only lasts while the user follows), but the doc's "invisible to in-use" is true for the relay, not the resident.
- Pod trust boundary (sub-task 3): WHERE from the kept index, container from `host.defaultContainer`, a daemon→follower request is refused (`onRequest` throws), no `open`/broker/save/exit net, all pod strings through `untrustedText`/C1-escaped JSON — holds.
- Archived/unknown session on `session/watch` → `UnknownSession` via `host.get`, never `open` — holds.
- `session/log` via a watch: identity-checked like `lookup` — holds (apart from finding 1's side effect on the failure path).
- Mutation of `dropStaleWatches` → survived (finding 2).

**Executor behaviour.** The three Execution sections are honest and specific, with run mutation tables and drift named; the one gap is a helper whose stated purpose was never exercised by a test, which hid a key-confusion bug.

### Round 2

*— claude-opus-5-5, 2026-11-14* (same fresh-context reviewer; reviewed `cc38f4e`, `git diff HEAD~1`)

**Verdict: PASS** (APPROVE)

- **Finding 1 — fixed.** `connection.ts:656-661` now checks `this.host.get(watch.hosted.id) !== watch.hosted`, keyed by session id; it unwatches and deletes by `watchId`. My round-1 repro (`.tentacle/tmp/logs-cmd/two-watches.test.ts`) now returns `{"updates":[],"lost":0}` in both cases: after a second watch, and after a refused `session/log`.
- **Finding 2 — fixed, and the tests are non-vacuous.** Two new tests in `watch-connection.test.ts`. Mutation M1 (put back `host.get(watchId)`) → `two watches on one connection both stay live` goes RED. Mutation M2 (stale check never true, i.e. a no-op) → `a session id closed and recreated under the same id drops its stale watch` goes RED: without the sweep, the old watch answers `ended: "closed"` and not `UnknownWatch`. Both reverted; `git status` clean.
- **Regressions on the diff:** none. The only other code change is a field reordered in the test fixture's return object. The executor's `### Fix round 1` doc section is additive.
- **Gate:** `bun run typecheck` clean · `bun run lint` 1078 files, 0/0 · touched test files 130 pass / 0 fail (128 + the 2 new). Full `bun test` not re-run by this review.
