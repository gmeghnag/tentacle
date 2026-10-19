# feat/session-history-cut — byte-bounded ring, `history_commit` cut, `history_replaced` barrier, paged snapshot

> **Status:** reviewed (REQUEST-CHANGES) — findings 1–7 addressed in Execution §"Review fixes"; no second Review (owner's instruction); not committed
> **Branch:** `feat/session-history-cut`
> **Type:** feat · **Size:** M · **Blast:** load-bearing (the agent loop, the steering window, protocol version, the persistence read path) · **Suited:** strong model executes; mandatory fresh-context Review (AGENTS §7)

Child **3c** of `docs/eval/session-event-stream.md` (plan 3a → 3b → 3c), itself
child 3 of `docs/eval/session-reattach.md`. Both prerequisites are on `main`:
3b (`docs/feat/session-turn-events.md`) and 2b
(`docs/fix/daemon-compact-turn-guard.md`, owner decision D8). The eval keeps
the whole plan; this doc is 3c's plan, corrected against `main` @ `5f259e5`.
Where they differ, this doc wins (see "Drift from the eval's §3c").

## Context

*— claude-opus-5-5, 2026-10-20*

A client that was away must be able to rebuild exactly what happened from
`snapshot` + replay (parent point 5, review F1/F6). Three things make that
impossible on `main`:

- **No consistent cut.** `session/snapshot` returns the whole history and no
  position in the stream (`daemon/src/connection.ts:154-161`). History is
  pushed per round (`agent/src/agent.ts:256,340`) while the round's chunks
  already carry a seq, so "the last seq I saw" is not a cut: the round in
  flight is in neither the snapshot nor the replay.
- **The replay buffer is turn-scoped and count-bounded**
  (`daemon/src/hosted-session.ts:42,83,138-141,165`): the next `prompt` wipes
  the previous turn's tail, and 1024 tiny chunks overflow mid-message.
- **Compaction is out of band.** `Session.compact` replaces history in place
  (`agent/src/session.ts:97-99`) and emits nothing, so a replaying client
  applies new events over a history the daemon no longer has.

Owner decisions that bind this task (parent §"Owner decisions"): **D1** `since =
{epoch, seq}`, epoch changes per incarnation and on compaction; **D2** the cut
comes from a `history_commit` marker in the agent loop; **C** the resync
property is stated over a projected transcript (thoughts, usage, partial text of
a cancelled/failed round are legitimately absent after a resync).

**Repro** (2026-10-20, `main` @ `5f259e5`,
`.tentacle/tmp/session-history-cut/missing.ts`):

```ts
// What 3c adds, shown missing on main: a consistent cut, a ring that survives
// turns, a compaction barrier. Real Agent + Session + HostedSession.
import { Agent, Session } from "@tentacle/agent";
import { type ChatRequest, type ModelProvider, PermissionBroker, type StreamEvent } from "@tentacle/core";
import type { KnownSessionUpdateParams } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { HostedSession } from "../../../packages/daemon/src/hosted-session.ts";

const script: StreamEvent[][] = [
  [
    { type: "text", delta: "Let me " },
    { type: "text", delta: "look." },
    { type: "tool_call", toolCall: { id: "c1", name: "missing", arguments: "{}" } },
    { type: "done" },
  ],
  [{ type: "text", delta: "Done." }, { type: "done" }],
  [{ type: "text", delta: "Second turn." }, { type: "done" }],
  [{ type: "text", delta: "SUMMARY" }, { type: "done" }],
];
let call = 0;
const model: ModelProvider = {
  id: "scripted",
  async *stream(_r: ChatRequest) {
    for (const e of script[call++] ?? [{ type: "done" }]) {
      await new Promise((r) => setTimeout(r, 1));
      yield e;
    }
  },
};
const noopEnv = { id: "noop", exec() { throw new Error("x"); }, readFile() { throw new Error("x"); }, writeFile() { throw new Error("x"); } };
const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv as never });
const hosted = new HostedSession("s1", new Session(agent, "s1"), new PermissionBroker(), async () => ({ outcome: "cancelled" }));
const seen: KnownSessionUpdateParams[] = [];
let snapAt: { seq: number; messages: number; snapshotKeys: string[] } | null = null;
hosted.setSink((p) => {
  seen.push(p);
  // A client drops right after the 2nd text chunk and resyncs: the snapshot
  // carries no cut, so its best guess is "the last seq I saw".
  if (p.update.type === "agent_message_chunk" && snapAt === null && seen.filter((x) => x.update.type === "agent_message_chunk").length === 2) {
    const snap = hosted.snapshot() as Record<string, unknown> & { messages: readonly unknown[] };
    snapAt = { seq: p.seq, messages: snap.messages.length, snapshotKeys: Object.keys(snap) };
  }
});
const waitIdle = async () => { while (hosted.running) await new Promise((r) => setTimeout(r, 2)); };

hosted.prompt("t1", [{ type: "text", text: "go" }]);
await waitIdle();
const s = snapAt as unknown as { seq: number; messages: number; snapshotKeys: string[] };
console.log("1) snapshot keys:", s.snapshotKeys, "— no cut; messages at drop:", s.messages);
const replay1 = hosted.replayFrom(s.seq).filter((p) => p.update.type === "agent_message_chunk").map((p) => (p.update as { content: { text: string } }).content.text);
console.log("   replay of text after seq", s.seq, "=", JSON.stringify(replay1.join("")), "→ 'Let me look.' lost (in neither snapshot nor replay)");

const lastOfT1 = seen.at(-1)?.seq ?? 0;
hosted.prompt("t2", [{ type: "text", text: "again" }]);
await waitIdle();
console.log("2) replayFrom(0) after turn 2 starts at seq", hosted.replayFrom(0)[0]?.seq, "(turn 1 ended at", lastOfT1, ") → ring reset per turn");

const before = seen.length;
await hosted.compact();
console.log("3) updates emitted by compact:", seen.length - before, "→ no history_replaced barrier");
```

```
1) snapshot keys: [ "messages" ] — no cut; messages at drop: 1
   replay of text after seq 3 = "Done." → 'Let me look.' lost (in neither snapshot nor replay)
2) replayFrom(0) after turn 2 starts at seq 8 (turn 1 ended at 7 ) → ring reset per turn
3) updates emitted by compact: 0 → no history_replaced barrier
```

## Implementation

*— claude-opus-5-5, 2026-10-20*

### Load-bearing assumption

*Within one epoch, the history is append-only below any recorded cut length:
the agent loop's only removal (`messages.pop()`, `agent.ts:294`) never removes
an element that a cut covers, and the only wholesale replacement is
`Session.compact` (`session.ts:97-99`).*

Verified: `rg -n "messages\.(pop|splice|shift)|messages\.length = |\.length = 0" packages/agent/src packages/daemon/src`
→ exactly `agent.ts:294` (`messages.pop()`) and `session.ts:98`
(`this.messages.length = 0`). The `pop` drops the assistant message pushed at
`:256` in the **no-tool** branch of the same round (`:267-298`). The design puts
no commit marker between that push and the `pop` (markers only in the
tool-call branch, `:304-341`), and the daemon's other cut points are turn end
(no further push in that turn) and compaction (new epoch). Proved by
construction here; pinned by agent test 2 below ("no commit between the
assistant push and the `pop`").

Consequence (eval §3c "why slice"): `snapshot` returns `messages[0, cut.length)`,
so a cut that lags behind the history is still correct — everything pushed after
it is replayed (`seq > cut.seq`), never doubled or lost, whatever the microtask
order of the transport.

### Preconditions

- The agent's push order per site (eval §"Load-bearing assumption", experiment
  re-checked on this `main`): the assistant push (`agent.ts:256`) has no event;
  `tool_result` is yielded **before** its push (`:339-340`); a steer is pushed
  then yielded (`:203-204`, `:282-283`, `:362-363`, `:417-418`); the cancelled
  tool is pushed then yielded (`:311-321`); nudge (`:294-297`), background note
  (`:445`) and the user prompt (`session.ts:66-68`) have no event.
- `HostedSession.drive` consumes the generator and handles each event
  synchronously before resuming it (`hosted-session.ts:205-217`); `finishTurn`
  runs on the agent's `turn_end`, when the history is final on every path
  (`:206-208`, `agent.ts:197,241,252,300,349,397,406,422`).
- Steering invariant: no `await` between the last drain and `finishTurn`
  (`agent.ts:270-278`, `hosted-session.ts:195-202`, test "no macrotask fits
  between the last steering drain and the turn's end",
  `daemon/test/integration.test.ts`). The new markers are yielded only inside
  the tool-call branch, never between a final drain and `turn_end`.
- Compaction holds the busy slot and is exclusive with a turn
  (`hosted-session.ts:291-317`, from `fix/daemon-compact-turn-guard`), so the
  barrier never lands inside a turn.
- `turn_start` carries the prompt (`updates.ts:86-90`), so the user push
  (`session.ts:66-68`) is covered by replay.
- The snapshot is read by persistence after every turn and compaction
  (`cli/src/local-runtime.ts:68-97`) through `RemoteClient.snapshot`
  (`client/src/remote-client.ts:192-195`); both moments are cut points.
- Peer dispatch is concurrent (`transport/src/peer.ts`, AGENTS §7): a
  `snapshot` can arrive at any point of a turn — the design must not care.

### Design

Wire (`@tentacle/protocol`, `PROTOCOL_VERSION` 3 → 4):

```ts
HistoryCut       = { epoch: string(1..128), seq: int ≥ 0 }                       // D1
history_replaced = { type: "history_replaced", reason: "compact" }               // mandatory
SnapshotParams   = { sessionId, cursor?: string(1..256), limit?: int ≥ 1 }
SnapshotResult   = { messages: ChatMessage[],          // chronological slice
                     since?: HistoryCut,               // first page only
                     turn?: { turnId },                // first page only: turn running AT the cut
                     cursor?: string }                 // older page exists
DomainErrorCode.StaleCursor = -32011                   // cursor of an older epoch → restart paging
```

`since` meaning (client-reattach Q6, wording only): *every event with
`seq ≤ since.seq` is reflected in `messages` (as projected); replay `seq >
since.seq` of the same epoch carries the rest.* A client may compare `seq`s of
one epoch; `epoch` is compared for equality only.

1. **Agent marker.** `AgentEvent` gains `{ type: "history_commit" }`, yielded
   only where `messages` reflects every event yielded so far: (a) right after
   the assistant push **when it has tool calls**; (b) right after each tool
   message push (`:340`); (c) right after the cancelled-tool `tool_result`
   yield (`:316-321`). None in the no-tool branch. Consumers: daemon `drive`
   records the cut; `daemon/src/mapping.ts` → `null`; `cli/src/render.ts` →
   `""`; `tui/src/state.ts` → state unchanged; `agent/src/subagent.ts` if-chain
   ignores it. The agent loop comment at `:270-278` stays true (no marker
   between the last drain and `turn_end`).
2. **Cut** `{ seq, length, epoch, turnId }`, recorded synchronously at:
   construction (`seq 0`, `length = messages.length` — a resumed session's seed
   is covered), every `history_commit`, `finishTurn` (**after** its `turn_end`
   emit, so the cut includes it and `turnId = null`), and the compaction hook.
   A throwing sink never skips the record (try/finally).
3. **Compaction barrier.** `Session.compact(signal, onReplaced?)` calls
   `onReplaced()` synchronously right after the replacement, before
   `persist()`. `HostedSession`'s hook: new epoch (`crypto.randomUUID()`),
   `emit(history_replaced)`, `epochStart` = the barrier's seq, record the cut. A sink
   throw there is reported to `onTurnError` and swallowed (the history is
   already replaced; the compaction must still resolve). Epoch is a fresh UUID
   also at construction (D1: a re-created session under the same id never
   shares an epoch).
4. **Ring** — new pure module `daemon/src/ring.ts`, `SessionRing`: append-only
   with a head index (no O(n) `shift`), byte-sized entries
   (`JSON.stringify(params).length`), evicts the oldest while over `maxBytes`
   **but never an entry with `seq > pinSeq`** (the cut), and `since(seq)` →
   entries after `seq`, or `null` when `seq` is below the evicted floor. Seqs
   must be contiguous (`push` throws otherwise — an invariant, not input).
   Never reset. `SessionHostOptions.ringBytes`, default 4 MiB (calibration in
   the eval: ≈ 5 p99 turns). Re-evicted on every push and every cut.
5. **`replayFrom(since: HistoryCut)`** → `{ replay }` | `{ resync: true }`:
   resync when the epoch differs, `since.seq < epochStart` (a crafted seq from
   before the barrier; `epochStart` is 0 for the first epoch), `since.seq > seq` (future), or the ring evicted it.
   Synchronous (session-registry's `open` must be one tick).
6. **`snapshotPage(cursor?, limit?)`.** No cursor: `end = cut.length`. Cursor
   `"<epoch>/<end>"`: other epoch → `StaleCursor`; malformed or `end ∉
   (0, cut.length]` → `InvalidParams`. `start = limit ? max(0, end-limit) : 0`;
   `messages = history[start, end)`; `cursor` iff `start > 0`; `since` and
   `turn` only without a request cursor. `limit` omitted → everything up to the
   cut (one call).
7. **Client.** `RemoteClient.snapshot` pages with `limit = 200` until no cursor
   and returns the joined chronological history (persistence unchanged); on
   `StaleCursor` it restarts, at most 3 attempts, then throws.
   `client/src/mapping.ts`: `history_replaced` → `null` (no turn can be open
   during a compaction; the initiating client persists after it).
8. `PROTOCOL_VERSION` → 4; `bun run schema:export`.

### Drift from the eval's §3c

- `since` is `{epoch, seq}` (D1), not the string `"<epoch>.<seq>"`; the epoch is
  a UUID per incarnation and per compaction, not a counter — it also closes
  session-registry's "since from a previous incarnation" hole.
- The first snapshot page carries `turn?: {turnId}` (client-reattach Q3a): with
  a mid-turn cut, `turn_start` is at or before `since`, so without it a resynced
  client cannot know a turn is running.
- The cut at turn end is recorded **after** the `turn_end` emit (not inside
  `finishTurn` before it): a client resyncing after a turn never replays a
  dangling `turn_end`.
- Initial cut at construction (the eval left it implicit; without it a resumed
  session's seed would be invisible to `snapshot` until the first turn ended).
- `replayFrom` also rejects a seq below the current epoch's start.
- `StaleCursor` is a domain code, not `InvalidParams` + a message: a client
  must branch on it (restart paging), and a message match is not a contract.
- `ringBytes` is a `SessionHostOptions` field, **not** a `serve` flag:
  daemon-wide memory knobs belong to `session-ttl-limits`; no flag until a user
  needs one.

### Files

protocol → agent → daemon → client → cli/tui:
- `protocol/src/session.ts` (`HistoryCut`, `Snapshot*`), `protocol/src/updates.ts`
  (`history_replaced`, class), `protocol/src/jsonrpc.ts` (`StaleCursor`),
  `protocol/src/version.ts`, `protocol/schema/protocol.json` (regenerated).
- `agent/src/agent.ts` (type + 3 yields), `agent/src/session.ts` (`onReplaced`).
- `daemon/src/ring.ts` (new), `daemon/src/hosted-session.ts` (cut, ring,
  `replayFrom`, `snapshotPage`, compact hook), `daemon/src/session-host.ts`
  (`ringBytes`), `daemon/src/connection.ts` (snapshot), `daemon/src/mapping.ts`.
- `client/src/remote-client.ts` (paging loop), `client/src/mapping.ts`.
- `cli/src/render.ts`, `tui/src/state.ts`.
- Tests: `agent/test/agent.test.ts`, `agent/test/session.test.ts`,
  `daemon/test/ring.test.ts` (new), `daemon/test/history-cut.test.ts` (new),
  `client/test/remote.test.ts`, `protocol` schema drift.

### Failure modes

- **Snapshot mid-round, any transport order** → slice to the cut + replay after
  it; a lagging cut is correct (load-bearing assumption).
- **Ring overflow** → entries after the cut are pinned, so `replayFrom(fresh
  since)` is never `resync` (no resync loop); older ones evicted → `resync`.
- **Compaction racing a snapshot / pager** → the hook is synchronous with the
  replacement; old cursor → `StaleCursor` → client restarts; old `since` →
  `resync`.
- **Compaction racing a turn** → excluded by the busy slot (precondition).
- **Sink throws** in `finishTurn` / the barrier → cut still recorded (finally);
  barrier error reported to `onTurnError`, compaction resolves.
- **Hostile/buggy `since`/`cursor`** (other epoch, future, pre-barrier,
  negative, garbage) → `resync` / `InvalidParams` / `StaleCursor`; never a throw
  that kills the connection; schema bounds sizes.
- **Turn errors or is cancelled mid-round** → its partial text was streamed but
  never pushed; after a resync it is absent (decision C, documented).
- **Version skew** → `PROTOCOL_VERSION` 4, `VersionMismatch` at `initialize`.
- **Memory** → one ring per session, ≤ `ringBytes` + one pinned round.

### Tests

The exact property (decision C): *for every drop point k (each emit of a
scripted scenario: turn 1 = text → tool → steer → text; compaction; turn 2 with
a tool), a fresh client that takes `snapshot` (all pages, `limit` 2) at k and,
at the end, `replayFrom(since)` — falling back to a new snapshot on `resync` —
reconstructs a projected transcript equal to the projection of the daemon's
final history; and the replayed seqs are contiguous from `since.seq + 1`.* Run
with the snapshot taken synchronously inside the sink at emit k (the
worst-case, microtask-delivery order) and once per k a macrotask later.
Projection: user/assistant text, tool calls by id, tool results by id;
display-only events ignored.

1. `daemon/test/ring.test.ts`: eviction by bytes; pin respected (over budget
   but nothing evicted past the pin); `since` below the floor → `null`; a
   non-contiguous push throws; head-index compaction keeps `since` right.
2. `agent/test/agent.test.ts`: at every `history_commit`, the history contains
   every yielded `tool_result`/`steer` and all non-whitespace assistant text so
   far; no commit between an empty-round push and its `pop`; commit after a
   cancelled tool; no commit after the last steering drain.
3. `daemon/test/history-cut.test.ts`: the property above; within an epoch the
   replay is never `resync` with the default ring; with a tiny `ringBytes`,
   `replayFrom(snapshot().since)` in the same tick is never `resync` (pin);
   `history_replaced` emitted by compact; a pre-compaction `since` → `resync`;
   a pre-compaction cursor → `StaleCursor`; malformed cursors → `InvalidParams`;
   a crafted `{epoch: current, seq: < barrier}` → `resync`; `turn` present iff
   the cut is mid-turn; a resumed (seeded) session's snapshot returns the seed.
4. `client/test/remote.test.ts`: paging joins pages chronologically over the
   real `Connection`; a `StaleCursor` mid-paging restarts.

Mutations that must fail the property test: `since.seq` = raw counter; snapshot
not sliced to `cut.length`; marker moved above the tool push; ring reset at
turn start; no new epoch at compaction; pin disabled (tiny ring test).

## Execution

*— claude-opus-5-5, 2026-10-20*

Repro re-run on `main` @ `5f259e5` before any edit: output as in Context.

As built, in the plan's order:
1. **Protocol** — `HistoryCut`, `SnapshotTurn`, paged `Snapshot{Params,Result}`
   (`protocol/src/session.ts`), `history_replaced` + class `mandatory`
   (`updates.ts`), `DomainErrorCode.StaleCursor = -32011` (`jsonrpc.ts`),
   `PROTOCOL_VERSION` 4, schema regenerated.
2. **Agent** — `history_commit` in `AgentEvent` and its three yields
   (`agent/src/agent.ts`: after the assistant push iff it has tool calls; after
   the cancelled-tool `tool_result`; after each tool push);
   `Session.compact(signal, onReplaced?)` (`agent/src/session.ts`). Consumers:
   `daemon/src/mapping.ts`, `cli/src/render.ts`, `tui/src/state.ts`.
3. **Daemon** — `daemon/src/ring.ts` (new); `HostedSession`: ring instead of
   `turnBuffer`, cut at construction / `history_commit` / after `turn_end` /
   barrier, `replayFrom(HistoryCut)`, `snapshotPage(cursor?, limit?)`;
   `SessionHostOptions.ringBytes`; `Connection.snapshot` → `snapshotPage`.
4. **Client** — `RemoteClient.snapshot` pages (200) and restarts on
   `StaleCursor` (≤ 3 attempts); `history_replaced` → `null` in `mapping.ts`.
5. **Tests** — `daemon/test/ring.test.ts` (6), `daemon/test/history-cut.test.ts`
   (13, incl. the property in both delivery orders over all 15 drop points),
   `agent/test/agent.test.ts` (+3, and one sequence updated for the markers),
   `agent/test/compact.test.ts` (+2), `client/test/remote.test.ts` (+3); class
   tables updated in `protocol/test/updates.test.ts` and
   `daemon/test/mapping.test.ts`.

Drift from the Implementation:
- **Found by the property test, now a documented contract:** a cut at commit
  (a) already holds the assistant's `toolCalls`, while their `tool_call`
  updates come after it — so a replay can re-announce a call that is in the
  snapshot. That is inherent (an assistant message carries all its calls before
  any is announced), not a cut bug. The projection keys calls by id, and the
  protocol now says so (`protocol/src/session.ts`, snapshot comment: clients
  upsert tool calls by `toolCallId`). `client-reattach`'s reducer must do the
  same.
- The barrier sets the final cut **before** emitting `history_replaced` (its
  seq is the next one), not after: a sink that reads the snapshot re-entrantly
  would otherwise see the new epoch with the old history length.
- Nothing else; `ringBytes` not exposed on `serve` (as planned).

**Mutations** (each applied alone, the named tests run, then reverted; the tree
was verified identical with `git status`):

| Mutation | Result |
|---|---|
| M1 `since.seq` = raw counter | killed — property ×2 + pre-compaction test |
| M2 snapshot not sliced to `cut.length` | killed — property ×2 + pre-compaction test |
| M3 marker above the tool push | killed — agent tests ×4 |
| M4 ring reset at turn start | killed — 5 tests incl. property ×2 |
| M5 no new epoch at compaction | killed — property ×2, barrier, stale cursor |
| M6 pin disabled | killed — tiny-ring test |
| M7 commit also in the no-tool branch (before the `pop`) | killed — agent append-only check |
| M8 no `epochStart` check | killed — barrier test (crafted seq) |
| M9 no initial cut length | killed — seeded-session test |
| C1 no restart on `StaleCursor` | killed — client ×2 |
| C2 pages joined newest-first | killed — client paging |
| C3 first page only | killed — client ×3 |

**After** (`.tentacle/tmp/session-history-cut/after.ts` = the repro on the new
API: `snapshotPage()` and `replayFrom(since)`):

```
1) snapshot keys: [ "messages", "since" ] — messages in the snapshot at the drop: 0
   replay of text after seq 0 = "Let me look.Done." (cut at 0 )
2) replayFrom({epoch, seq: 0}) after turn 2 starts at seq 1 (turn 1 ended at 7 )
3) updates emitted by compact: 1 {
  type: "history_replaced",
  reason: "compact",
} mandatory: true
```

**Gate:** `bun run check` — typecheck clean, `biome check` 270 files no
issues, `bun test` **895 pass, 1 skip (the opt-in live-k8s), 0 fail**.

### Review fixes

*— claude-opus-5-5, 2026-10-20 (executor, after the fresh-context Review below)*

- **F1 (blocking) — history messages with no update.** Fixed by design, not by
  narrowing the projection: a client cannot tell the nudge or a background note
  from a user message in a snapshot, so excluding them would not be
  deterministic. New `AgentEvent` / display update `context_note {text, reason:
  "continue" | "background_exit"}`, yielded right **after** each push
  (`agent/src/agent.ts`: the nudge only when actually pushed; one per
  background note in `flushBackgroundExits`). Mapped in `daemon/src/mapping.ts`
  and `client/src/mapping.ts`; `tui/src/state.ts` and `cli/src/render.ts`
  render nothing (the exit itself still renders from `background_exit`, as
  before). Not on the steering window: the nudge path `continue`s into another
  round. With it, every message the loop pushes has an event (prompt →
  `turn_start`, steer → `steer`, assistant/tool → chunks/`tool_call(_update)`,
  nudge/note → `context_note`). The property scenario now includes an empty
  round (nudge) and a background exit before turn 2; the projection drops
  whitespace-only assistant text (the empty round's streamed `" "` that history
  never keeps — decision C).
- **F2 — endless paging.** `RemoteClient.readSnapshotPages` fails loudly when a
  page with a `cursor` is empty or repeats the previous cursor, and past
  10 000 pages (`client/src/remote-client.ts`). Test added.
- **F3 — persistence after an aborted stream: accepted, documented.** When the
  client fails a turn before `turn_end` (malformed/unknown-mandatory frame), the
  post-turn flush persists the history up to the last commit; the daemon still
  holds the rest and the next turn's flush persists it. Only quitting right
  after such a loud failure loses the tail — and `main` would then have
  persisted a mid-round state, not a consistent one. No code change.
- **F4 / F5 — untested properties.** Tests added: the barrier's cut is final
  before `history_replaced` reaches a re-entrant sink (X4); an update whose
  delivery throws is still in the ring and seqs stay contiguous (X12);
  `SessionHost` passes `ringBytes` (X18).
- **F6 / F7 — comments.** `ring.ts` now says the pin spans the rounds since the
  last commit (≤ `maxIterations`) and that sizes are JSON length in UTF-16
  units (one extra stringify per update). Frame size of a 200-message page vs
  the 8 MiB cap stays with `oversize-frame-hang`.
- **F8 — downstream evals out of date:** re-baselined (2026-10-20, on the
  owner's request): a dated "Re-baselined on 3c" note at the top of each
  Implementation plus the concrete shapes edited in place. `session-registry`:
  `replayFrom(HistoryCut) → {replay} | {resync}`, the epoch replaces its
  `incarnation` (`OpenResult.epoch`), a `get cut()` accessor it adds,
  `snapshotPage`. `client-reattach`: `since: {epoch, seq}`, `turn?: {turnId}`
  (no `state` yet — `permission-events` adds suspension), tool calls upserted
  by id, `context_note`, `StaleCursor`, reuse of `RemoteClient.snapshot`'s
  paging guards.

Mutations for the fixes (each alone, reverted, `git diff` hash identical after):
F1a no `context_note` for the nudge — killed (pre-compaction property); F1b none
for the background note — killed (property ×2); X4 — killed; X12 — killed; X18 —
killed; F2 no progress check — killed.

**Gate after the fixes:** `bun run check` — typecheck clean, biome 270 files no
issues, `bun test` **899 pass, 1 skip (opt-in live-k8s), 0 fail**. No second
Review was run (owner's instruction).

## Review

*— claude-opus-5-5 (fresh-context reviewer), 2026-10-20. The executor was the
same model (claude-opus-5-5), only a fresh context: blind spots we share
survive both passes.*

### Verdict: **REQUEST-CHANGES**

There is one blocking finding (F1): the contract this task publishes is false
on two agent paths, and the property test does not exercise either of them.
Everything else holds or is a nit. The fix is small: a decision plus a test,
or an event plus a test.

### Findings

1. **[Medium, blocking] "Replay carries the rest" is false for history
   entries that have no event: the empty-round nudge and the background-exit
   note.** The agent pushes `CONTINUE_NUDGE` at `agent/src/agent.ts:305` and
   the `[background] job …` note at `agent.ts:458` (`flushBackgroundExits`,
   called at `:195`). Neither has a streamed update: `background_exit` maps to
   `null` at `daemon/src/mapping.ts:146`, and the nudge yields nothing. Take a
   snapshot at any cut before such a push and replay `seq > since.seq`: the
   message is in the daemon's history, but neither the snapshot slice nor the
   replay contains it. Reproduced end to end
   (`.tentacle/tmp/session-history-cut-review/e2e.ts` part B: tool round,
   then empty round, then text). At every drop point k=1..7 the recovered
   transcript is `[user:go, assistant:Look., assistant:Done.]` and the
   daemon's is `[user:go, assistant:Look., user:Continue with the task.,
   assistant:Done.]`. A client that resyncs *after* the push does show the
   note, so two clients render different transcripts depending only on when
   they dropped. The doc's `since` meaning (Design) and the
   `protocol/src/session.ts` snapshot comment ("never doubled, never lost") are
   therefore wrong as written. The property test's scenario
   (`daemon/test/history-cut.test.ts` `SCRIPT`) has neither branch; the eval's
   own §3c point 3 listed both as "messages that have no event" and the
   question was never closed. Required: either (a) an owner decision that the
   projection excludes model-facing internal user notes, stated in the
   protocol comment and in decision C, with the property scenario extended by
   a nudge round and a background exit so the exclusion is pinned; or (b) an
   update for them (e.g. a non-display history note), plus the same test
   extension. `client-reattach`'s reducer depends on this answer.
2. **[Low] A hostile or buggy daemon can make `RemoteClient.snapshot` loop
   without bound** (`client/src/remote-client.ts:218-226`). The paging loop
   trusts `cursor` and accumulates every page. A pod (untrusted, AGENTS §7)
   that always answers with a `cursor` grows laptop memory until it crashes,
   whereas main did one bounded request. The pod can already flood updates, so
   this is availability only. Fix: fail loud on a cursor that does not
   strictly decrease, or above a page cap.
3. **[Low] A mid-turn persistence flush now saves less than main did.**
   `persistingController.flush` (`cli/src/local-runtime.ts:72-77`) runs in
   `send`'s `finally`. When `send` ends *before* `turn_end`, the snapshot is
   now sliced to the last commit, so it can lack the turn's own user prompt
   and steers that main would have written to disk. This happens when the turn
   fails on an unreadable mandatory frame (`remote-session.ts`'s `fail`, which
   then cancels) or when the consumer abandons the generator. No later flush
   covers that turn. After a normal, errored or cancelled turn, and after a
   compaction or a resume, nothing changes: the cut is at turn end or at the
   barrier (verified in the e2e trace and by reading `finishTurn`).
4. **[Low] Two claimed properties have no test.** (a) Moving the barrier's cut
   to *after* the `history_replaced` emit (mutation X4) leaves all tests green.
   That is the "re-entrant sink sees a consistent epoch" rationale given in
   Execution's drift. (b) Pushing to the ring *after* the sink (X12) leaves all
   tests green. That covers "The ring holds it even if the sink throws"
   (`hosted-session.ts:250-253`). Under X12 a throwing sink loses the entry,
   and the next `push` throws non-contiguous, which kills the turn.
5. **[Nit] `ringBytes` is not plumbed under any test**: mutation X18
   (`session-host.ts` passes `undefined`) leaves all tests green.
6. **[Nit] The pin is not "one round".** A late steer
   (`agent.ts` no-tool branch, `continue`) and the nudge chain both start
   another round without a commit. A turn made of steer-continue rounds pins
   all of them until `turn_end`. The bound is `maxIterations` rounds, not one;
   correctness is unaffected (`ring.ts` module comment).
7. **[Nit] The ring's "bytes" are JSON UTF-16 code units, and every update is
   stringified once more** (`ring.ts:15-16`). Heap per entry is larger, and
   non-ASCII text is undercounted relative to UTF-8. Paging is by message
   count (200), not bytes, so 200 large tool results can still exceed the
   8 MiB WS frame. Main had the same problem, worse, so this is an
   improvement, not a regression.
8. **[Info] Downstream evals need re-baselining.** `session-registry.md`
   still specifies `replayFrom(since: number) → … | null`, a public
   `committedSeq`, and a separate `incarnation`. The per-incarnation UUID
   `epoch` now covers its "since from a previous incarnation" hole and also
   changes on compaction. `client-reattach.md` keeps `cut: number`, and its Q3a
   asked for `turn.state: running|suspended`, of which only `{turnId}` exists
   (suspension does not exist yet). None of this breaks anything, but the next
   task must not re-plan from those docs as written. Also note the documented
   `toolCallId` upsert rule for the reducer.

### Gate (re-run by the reviewer)

`bun run check`: `tsc --noEmit` clean; `biome check .` reports "Checked 270
files … No fixes applied" (0 errors, 0 warnings); `bun test` reports **895
pass, 1 skip (the opt-in live-k8s), 0 fail**, 3333 `expect()` calls, 896
tests across 98 files. This matches Execution.

### Mutations (the reviewer's own, each reverted; tree byte-identical afterwards: `git diff | shasum` and the untracked files' hashes compared)

| # | Mutation | Result |
|---|---|---|
| X1 | turn-end cut recorded *before* the `turn_end` emit | killed ("throwing sink at turn end") |
| X2 | no `finally` around the turn-end cut | killed (same test) |
| X3 | `SessionRing.since` off by one | killed (8 tests, property ×3, ring ×5) |
| X4 | barrier cut set *after* the emit | **survived** (F4a) |
| X5 | commit cut records `turnId = null` | killed (`turn` test) |
| X6 | no "future seq" check in `replayFrom` | killed |
| X10 | no `end > cut.length` cursor check | killed |
| X12 | ring push after the sink | **survived** (F4b) |
| X16 | `onReplaced` before the replacement | killed (compact test + property ×2) |
| X17 | commit (a) moved *above* the assistant push | killed (property ×2) |
| X18 | `ringBytes` not passed by `SessionHost` | **survived** (F5) |
| X19 | `Connection` ignores `cursor`/`limit` | killed (client paging) |
| M2′ | snapshot not sliced (`end = messages.length`) | killed (property ×3), confirms Execution's M2 |
| M6′ | ring pin disabled | killed (tiny-ring + ring pin), confirms M6 |

### Premise table (line numbers on `main` @ `5f259e5`, read with a temporary worktree)

| Premise | Verdict |
|---|---|
| Repro (Context): no cut, ring reset per turn, no barrier | **TRUE**: re-run on main, output identical to the doc |
| `connection.ts:154-161` snapshot = whole history, no position | TRUE |
| `agent.ts:256,340` assistant push / tool push | TRUE |
| `hosted-session.ts:42,83,138-141,165` `MAX_REPLAY`, `turnBuffer`, `shift`, reset at prompt | TRUE |
| `session.ts:97-99` compaction replaces in place | TRUE |
| Only removals are `agent.ts:294` `pop` and `session.ts:98` `length = 0` | TRUE (rg re-run; no index assignment or in-place `content`/`toolCalls` mutation elsewhere in agent/daemon/core) |
| Steer pushed then yielded `:203-204, :282-283, :362-363, :417-418` | TRUE |
| Cancelled tool pushed then yielded `:311-321`; `tool_result` before push `:339-340` | TRUE |
| Nudge `:294-297`, background note `:445`, user prompt `session.ts:66-68` have no event | TRUE, and it is precisely why F1 exists |
| `turn_end` yields at `:197,241,252,300,349,397,406,422` | TRUE |
| Steering INVARIANT comments `agent.ts:270-278`, `hosted-session.ts:195-202` | TRUE |
| Compact holds the busy slot `hosted-session.ts:291-317` | TRUE |
| `turn_start` carries the prompt `updates.ts:86-90` | TRUE |
| Persistence reads `snapshot` after turn/compaction `local-runtime.ts:68-97`, `remote-client.ts:192-195` | TRUE |
| Load-bearing assumption (append-only past any cut within an epoch) | **TRUE** for removal. Commits exist only in the tool-call branch, after the push. The `pop` follows only a no-tool push, and no commit separates them (agent test + X17). But it is not *sufficient* for the stated contract: see F1, which is about additions with no event, not removals |

### Attacks tried

1. **Steering no-await window.** The three new yields are all inside the
   tool-call branch. In `drive`, `history_commit` is `recordCut(); continue;`,
   synchronous with no `await`. In `finishTurn`, `recordCut` is in a `finally`,
   also synchronous. Nothing lies between the late drain and `turn_end`. The
   integration test "no macrotask fits…" passes. **Holds.**
2. **Nudge and background-note paths (history with no event).** **Found F1**
   (e2e part B).
3. **Event emitted *before* its push at a commit point.** `tool_result` is
   yielded, then pushed, then committed: fine. At commit (a), the assistant's
   `toolCalls` are in the snapshot before their `tool_call` updates: a replay
   re-announces them. Documented as an upsert-by-id rule. **Holds, as a
   documented contract.**
4. **Re-entrant sink.** A sink that snapshots inside `turn_end` gets the
   previous commit's cut, with `turn` present, and the replay includes the
   `turn_end`: consistent (e2e part B k=7). A sink that synchronously starts a
   new prompt inside `turn_end` gets the new `turn_start`, and the user push
   happens synchronously in `Session.send` before the `finally` records the
   cut, so the cut covers both: consistent by reading. **Holds.**
5. **Hostile `since`/cursor** (NaN, 0.5, negative, future, other epoch,
   pre-barrier, `"/1"`, `"<e>/"`, `"<e>/1.5"`, `"<e>/999"`). Results are
   `resync`, `InvalidParams` or `StaleCursor`, never a throw that kills the
   connection: tests plus X6/X10. **Holds.**
6. **Paging under a concurrent turn.** The cursor end is fixed by the first
   page. Later pages slice `[start-limit, start)` of an append-only history,
   valid while the cut moves within the epoch. A compaction yields
   `StaleCursor`, then a restart. **Holds.** A hostile daemon's endless cursor
   is **found F2**.
7. **Persistence can save less?** After turn end, error, cancel, compaction
   and resume: no. When `send` exits early: yes. **Found F3.**
8. **Ring contiguity when the sink throws, and eviction while idle.** The
   push happens before the sink. Live `background_exit` while idle sits above
   the cut, so it is pinned (a small, bounded set). `evict` runs on each cut.
   **Holds**, but the ordering is untested (F4b).
9. **Wire e2e.** A real `SessionHost` + `Connection` + `RemoteClient` over
   `createChannelPair` (e2e part A). Mid-turn snapshots carry `since` and
   `turn: {turnId: "t1"}`. The first chunk's snapshot is `messages: []` with
   `since.seq 0`: the prompt arrives through `turn_start` in the replay.
   `RemoteClient.snapshot` sends `{sessionId, limit: 200}` and returns the
   full history after the turn. **Holds.**
10. **Protocol.** `PROTOCOL_VERSION` 3→4. The schema is regenerated (the
    drift test passes). `history_replaced` is mandatory, and a client with no
    turn handler drops it harmlessly. `StaleCursor` −32011 does not collide.
    **Holds.**

### What holds

The cut machinery is correct for everything that *has* an event: the slice to
`cut.length`, the commit points, the turn-end cut after the emit, the barrier
with a fresh epoch, the ring's pin, the byte budget and the floor arithmetic,
and the contiguous-seq invariant. `replayFrom` and `snapshotPage` are
synchronous. The steering invariant is untouched. Mutation coverage is strong
on the core property: the property test kills X3, X16, X17, M2 and M6.

### How the executor behaved

Honest and accurate. The gate counts, the mutation table (spot-checked M2 and
M6 with my own variants) and the "after" repro match what I observed. Drift is
declared, not hidden: the tool-call overlap was found by its own property test
and turned into a documented contract, which is good practice. The blind spot
is the one this review shares by construction. The property's scenario was
built from the eval's sketch (text → tool → steer → text), which omits the two
event-less history pushes the eval itself had flagged, so "the exact property"
was proven over a scenario that cannot falsify F1. Two rationale claims (X4,
X12) were asserted in comments and Execution without a pinning test.
