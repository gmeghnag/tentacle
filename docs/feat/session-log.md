# feat/session-log — the laptop↔daemon read-back becomes a typed event log (`session/log {after}`)

> **Status:** execution (plan approved 2026-11-07, see "Owner answers")
> **Branch:** `feat/session-log` (off `main` @ `9dc71ec`)
> **Type:** feat · **Size:** L · **Blast:** load-bearing (protocol + `PROTOCOL_VERSION`, the TUI-over-RPC session path, the persistence invariant, "a pod is not trusted") · **Suited:** strong model executes; mandatory fresh-context Review (`docs/REVIEWER-BRIEF.md`) red-teaming §7 persistence / single session path / pod-not-trusted / don't-serialize-the-peer
>
> Task 1 of 3 decided in `docs/eval/session-persistence-format.md` "## Owner decisions (2026-11-07)": `feat/session-log` (this, wire) → `feat/session-log-laptop-store` (task 2, disk log) → `feat/session-log-serve-store` (task 3).

## Context

*— claude-opus-5-5, 2026-11-07*

**Problem.** Since `fix/run-session-never-saved` (on `main`), the laptop saves after every
committed round: `persistingController` flushes at every `tool_result`
(`packages/cli/src/local-runtime.ts:445-447`), at turn end (`:452-455`), after a compaction
(`:467-470`), on title / idle (`:414`, `:423-428`). Each flush calls `inner.readBack()`
(`:354`) → `RemoteClient.readBack` (`packages/client/src/remote-client.ts:1093-1116`) →
`readSnapshotPages` (`:2112-2145`): the WHOLE history, newest first, in pages of
`SNAPSHOT_PAGE = 200` messages (`:119`), one RPC round trip each. On the k8s exec link that
is ~1.1–1.7 s of link occupancy per round at 500k tokens, ahead of the streamed chunks
(eval M1/M2, estimated, never measured end to end).

**Owner decisions this task implements (binding, eval "Owner decisions" 1, 3, 4, 5):**
- the read-back becomes a typed event log `session/log {after}`;
- `type` on every entry from day one (discriminator only; settings/usage/sub-agent/permission
  types later, when a reader needs them);
- the fresh-context review's F1–F5 are requirements: **F1** lineage (parent link +
  daemon incarnation id; a fork is detected and set aside, never spliced) · **F2** a
  whole-projection checkpoint (or the chain) · **F3** a removal entry + derivation reset at
  `historyReplaced` · **F4** the laptop keeps only KNOWN, validated, re-serialized entries
  from a pod (unknown pod entries dropped) · **F5** a cold read starts at the last compaction;
- acceptance includes an end-to-end pod measurement (2 MB session: read-back time + delay
  of a chunk streamed during it);
- in THIS task the laptop still writes today's JSON record. The entry schema is designed so
  task 2 appends it to disk unchanged, and so task 2 can add "keep superseded history"
  (compaction + `context_reset`, config, default `false`).

**Constraints.** Pre-public: breaking change allowed, with a `PROTOCOL_VERSION` bump and no
compat shims (AGENTS §7). Do not serialize the RPC peer (`packages/transport/src/peer.ts:322`
`void this.handleRequest`). The pod is not trusted: everything read from it is validated on
the laptop. The agent loop's steering window must not gain an `await`
(`hosted-session.ts:1492-1499`, `:1629-1630`).

**Repro** (2026-11-07, `main` @ `9dc71ec`, `.tentacle/tmp/session-log/repro.ts`, real
`SessionHost` + `Connection` + `RemoteClient` over `createChannelPair`, no model call):

```ts
// Repro (feat/session-log Context): today every read-back (`RemoteClient.readBack`,
// called by the laptop's persistingController after every committed round) moves
// the WHOLE history over RPC, page by page — even when nothing changed.
// Real stack in-process: SessionHost + Connection + RemoteClient over a channel pair.
// Usage (from this folder): bun repro.ts [targetBytes]
import { Agent } from "@tentacle/agent";
import { type ChatMessage, type ExecutionEnvironment, PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { Method } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { GatedModel } from "../../../packages/client/test/support/fakes.ts";
import { RemoteClient } from "../../../packages/client/src/remote-client.ts";

const target = Number(process.argv[2] ?? 2_000_000);
const env = {} as ExecutionEnvironment;
const host = new SessionHost({
  defaultCwd: "/tmp/session-log-repro",
  createAgent: () => {
    const permissions = new PermissionBroker();
    const agent = new Agent({
      model: new GatedModel([]),
      tools: new ToolRegistry(),
      env,
      requestPermission: (req, options) => permissions.request(req, options),
    });
    return { agent, permissions };
  },
});
const [d, c] = createChannelPair();
new Connection(d, host);
let requests = 0;
let responseChars = 0;
const pending = new Set<number | string>();
const link: DuplexChannel = {
  send: (data) => {
    const frame = JSON.parse(data) as { id?: number | string; method?: string };
    if (frame.method === Method.Snapshot && frame.id !== undefined) {
      requests++;
      pending.add(frame.id);
    }
    c.send(data);
  },
  close: () => c.close(),
  setOnMessage: (h) =>
    c.setOnMessage((data) => {
      const frame = JSON.parse(data) as { id?: number | string };
      if (frame.id !== undefined && pending.delete(frame.id)) responseChars += data.length;
      h(data);
    }),
  setOnClose: (h) => c.setOnClose(h),
};
const client = new RemoteClient(link, new PermissionBroker());

// A seeded history of ~target chars: system + (user, assistant+call, tool) rounds.
const messages: ChatMessage[] = [{ role: "system", content: "s".repeat(6000) }];
let size = 6000;
for (let i = 0; size < target; i++) {
  const round: ChatMessage[] = [
    { role: "assistant", content: "a".repeat(900), toolCalls: [{ id: `c${i}`, name: "x", arguments: "{}" }] },
    { role: "tool", content: "t".repeat(1500), toolCallId: `c${i}` },
  ];
  messages.push(...round);
  size += 2400;
}
await client.initialize();
const session = client.newSession(messages, crypto.randomUUID());
await session.openSeeded();
console.log(`seeded messages=${messages.length} chars≈${size}`);
for (let save = 1; save <= 3; save++) {
  requests = 0;
  responseChars = 0;
  const t0 = performance.now();
  const back = await session.readBack();
  const ms = performance.now() - t0;
  console.log(
    `read-back #${save} (no change since the last): messages=${back?.messages.length} snapshot requests=${requests} response chars=${responseChars} in-process ms=${ms.toFixed(1)}`,
  );
}
client.close?.();
process.exit(0);
```

Output:

```
seeded messages=1663 chars≈2000400
read-back #1 (no change since the last): messages=1663 snapshot requests=9 response chars=2116736 in-process ms=4.3
read-back #2 (no change since the last): messages=1663 snapshot requests=9 response chars=2116743 in-process ms=2.9
read-back #3 (no change since the last): messages=1663 snapshot requests=9 response chars=2116743 in-process ms=3.4
```

A read-back with NOTHING new still moves 2.1 MB in 9 round trips. After this task, reads #2
and #3 must move one small frame (no entries), and a read after one round must move
O(that round).

## Implementation

*— claude-opus-5-5, 2026-11-07*

### Load-bearing assumption

> **The daemon can derive an EXACT, ordered log of its committed history at synchronous
> points it already has.** Every change to `session.messages[0, cut.length)` is either
> (a) an append or an element REPLACEMENT (a new object at an index) that happens before a
> derivation point in the same session, with no shrink behind a cut, or (b) a whole
> replacement announced synchronously by `historyReplaced`. So a reference diff of
> `messages[0, cut.length)` against the previous derivation's reference copy, taken at
> those points, misses nothing.

**Status: PROVEN statically (complete mutation inventory below), to be pinned empirically
FIRST in Execution by test D1 (drift invariant) before any wiring.**

Proof:

1. *Messages are immutable values.* Every `ChatMessage` field is `readonly`
   (`packages/core/src/model.ts:28-50`); a grep for in-place field edits
   (`Object.assign(message…`, `as { -readonly`, `Mutable<ChatMessage`, `copyWithin`) over
   `agent|daemon|core|exec|tools/src` finds none. So "changed" ⇔ "a different object at
   that index": reference identity is an exact detector.
2. *Complete inventory of mutations of a history array* (grep
   `messages\.(pop|splice|push|shift|unshift|length =|…)|messages\[…\] =` and
   `\w\[…\] = { ...` over `packages/*/src`; non-history arrays — provider request builders —
   excluded):

   | Site | Kind | Behind a cut? | Derivation point that sees it |
   |---|---|---|---|
   | `agent.ts:710, 832, 837, 845, 866, 922, 937, 975, 997, 1011, 1051, 1094, 1110, 1305, 1358, 1480, 1549, 1653, 1791, 1835, 1860`; `session.ts:132` | push | no (past the cut) | the next `history_commit` → `recordCut` (`hosted-session.ts:1512-1522`) or `finishTurn` → `recordCut` (`:1628`) |
   | `agent.ts:1009` `messages.pop()` | shrink | **never** behind a cut: the round's commit is only yielded when it has calls (`agent.ts:948-950`); the event contract says "never between a push and the `pop`" (`agent.ts:289-291`); the daemon's cut invariant relies on it (`hosted-session.ts:31-40`) | — (derivation reads `[0, cut.length)` only, so an uncommitted message never enters the log) |
   | `agent.ts:1156` `messages[target] = {...message, contextUsage}` | replace, possibly behind the cut | yes | the next `recordCut` (pointer diff finds index `target`) |
   | `persisted-session.ts:542` `closeFailedTurn` (called `hosted-session.ts:1569`) | replace of the last message (or push `:544`) | yes (the last committed message) | `finishTurn` → `recordCut` right after (`:1571` → `:1628`) |
   | `session.ts:92` `replaceAgent` head swap (called by `swapAgent`, `hosted-session.ts:1465`) | replace index 0 | yes | **none today** — `swapAgent` persists (`:1470`) but does not move the cut. **This plan adds a derivation call in `swapAgent`.** (Idle: `assertIdle` is checked by the caller in the same stretch, `:1474-1486`.) |
   | `session.ts:239-240` compaction, `agent.ts:1763-1764` `context_reset` | whole replacement, SAME array (`length = 0; push`) | yes | `historyReplaced` runs synchronously after both: `session.ts:242` `onReplaced` → `hosted-session.ts:1894-1896`; `context_reset` event → `:1529-1534`. The derivation RESETS its reference copy there (F3) — a diff across it would compare the same array object |
   | `persisted-session.ts:510, 704` (`labelUnansweredCalls`, steering re-push) | push | reload repair, BEFORE the `HostedSession` exists | construction (`hosted-session.ts:478-484`): the first derivation is a `base` of the repaired history |

3. *Sub-agents and parallel tools add no site.* A child runs over its own history
   (`packages/agent/src/subagent.ts:174`, `:278`); only its final result reaches the parent
   as a tool message, pushed and committed like any other. A parallel group pushes its
   results and yields ONE commit after every push (`agent.ts:1552-1554`): one derivation,
   several `message` entries.

The second assumption the design leans on — **request handlers run concurrently and a
`session/log` read can run at any microtask** (`peer.ts:322`) — is why the log is served
ONLY from entries already derived, never from the live `session.messages` (which can be
mid-replacement between `agent.ts:1763` and `hosted-session.ts:1532`).

### Preconditions (verified on `main` @ `9dc71ec`)

- **P1** The cut moves only at `history_commit`, turn end, the idle wake, and a history
  replacement; `messages[0, cut.length)` reflects every update `≤ cut.seq`
  (`hosted-session.ts:31-40`, `recordCut` `:1122-1131`, `historyReplaced` `:1930-1956`,
  `maybeWake` `:1688`).
- **P2** Today's snapshot slices the LIVE array at the cut (`hosted-session.ts:1074-1092`,
  `:1082`), and the client's read is restarted on `StaleCursor` (`remote-client.ts:2099-2110`).
- **P3** The peer validates every result against `RequestSchemas[method].result`
  (`peer.ts:447-458`, strip schemas → unknown fields dropped; a parse failure rejects the
  call). So the wire schema of `session/log` decides what survives inbound: unknown entry
  types must be representable as an open envelope, or ONE unknown entry rejects the whole
  read.
- **P4** Inbound frame cap: `maxFrameBytes` (`peer.ts:281-286`; `ws-server.ts:54` 8 MiB).
  The repo's pattern for bounded batches is a char budget with "a single larger item travels
  alone" (`remote-client.ts:372-377`).
- **P5** A new session is built from `open{messages}` by `SessionHost.open` → `build`
  (`session-host.ts:476-494`, `:862-910`; `new Session(agent, id, {messages})` `:880`); a
  serve reload / reopen goes through `restore` (`:472`). Each `HostedSession` mints a fresh
  epoch per incarnation (`hosted-session.ts:473-484`).
- **P6** The client already keeps "the newest history this client read" for a recreate
  (`remote-client.ts:291-292`), seeds `open{messages}` from it (`:1666-1671`, `:1785-1796`),
  and tracks lag with `turnEndsApplied` / `turnEndsInHistory` (`:310-312`, `:1859-1862`).
- **P7** `readBack` already waits out a drop and repeats (read-only) (`remote-client.ts:1105-1115`).
- **P8** Consumers of `readBack` for persistence: only `persistingController`
  (`local-runtime.ts:354`), used by `createLocalRuntime` (worker, `run`, `attach`). `connect`
  keeps no laptop copy and never reads back (grep: no `readBack`/`saver` in `connect.ts`).
  `session/snapshot` is ALSO the display resync (`remote-client.ts:1823-1856`, reducer
  `fetch_snapshot` `:1926-1928`) — out of scope here (see Q1).
- **P9** Laptop Q6 guard: a strict-prefix copy goes to `<uid>.stale-<ms>-<hex>.aside`
  (`session-store.ts:408-417`, `:504-520`), notice via `NoticeHub`
  (`cli/src/tui-sessions.ts:66-72`). A DIVERGENT (non-prefix) copy silently replaces the file
  today — the F1 silent drop.
- **P10** `/clear` closes the session and starts a NEW uid (`tui/src/App.tsx:1814-1820`): the
  old record stays intact. `/clear` supersedes nothing (owner decision 3 asked to evaluate it:
  nothing to keep — Q8).
- **P11** No `session/update` is needed: the laptop reads at its own flush points. So
  `UPDATE_CLASS` (`protocol/src/updates.ts:287-310`) is untouched.
- **P12** `PROTOCOL_VERSION = 16` (`protocol/src/version.ts:7`); `schema/protocol.json` is
  generated from zod and pinned by a drift test (`protocol/src/json-schema.ts:1-23`,
  `protocol/test/json-schema.test.ts`); an "anything" schema must be listed there.

### Design

#### 1. The entry (protocol — the shared truth; task 2 writes it to disk unchanged)

Envelope, on every entry:

| Field | Meaning |
|---|---|
| `type` | discriminator (`/^[a-z][a-z0-9_]*$/`, ≤ 64) — owner decision 4 |
| `seq` | int ≥ 1, strictly +1 per entry along a lineage; continues across compactions and across a reseeded incarnation |
| `id` | `"<inc>/<seq>"` — opaque, unique (inc = the incarnation's UUID) |
| `prev` | the previous entry's `id`, `null` only on a lineage's first entry — the **parent link (F1)** |
| `ts` | ms, the daemon's clock (display only; never ordering) |
| `critical` | optional `true`: a reader that does not know `type` must refuse the log (it cannot project without it); absent = skippable. Known types fix their own value; see Q4 |

**Why `prev`-by-id and not a content hash (F1 allows either):** the laptop can only verify a
content hash over fields it knows. Forward compatibility (fields are free, AGENTS §7) means a
newer daemon may add a `ChatMessage` field this laptop strips (P3), so a recomputed hash would
mismatch on every read and force endless cold reads. A content hash is no security against a
pod either (it writes the entries). Opaque ids give the parent chain (fork detection); the
**projection digest** (below) catches derivation drift (F2) over the fields both ends know.

v1 types (minimal — owner decision 4):

| `type` | Payload | Critical | Effect on the projection |
|---|---|---|---|
| `base` | `{inc, reason: "create"\|"seed"\|"reload"\|"compact"\|"context_reset", count}` | yes | RESET: the projection becomes the `count` `message` entries that follow. Starts a segment. Every incarnation starts with one |
| `message` | `{message: ChatMessage}` | yes | append |
| `replace` | `{index, message}` | yes | `projection[index] = message` (`index < length`) |
| `truncate` | `{length}` | yes | `projection.length = length` (`length ≤ length`) — **F3's removal entry**; nothing emits it today (premise: no shrink behind a cut), the derivation emits it if one ever appears instead of losing it |
| `title` | `{title: SessionTitle}` | no | the daemon's title (replaces `snapshot.title` in the read-back) |
| `checkpoint` | `{count, digest}` | no | assert `projection.length === count` and `projectionDigest(projection) === digest` (**F2**) |

Pure helpers in protocol (node-free — `apps/mobile` imports `@tentacle/protocol`):
`canonicalMessage(m)` — a JSON array of the KNOWN `ChatMessageSchema` fields in a fixed
order (`role, content, toolCalls[id,name,arguments], toolCallId, spill, durationMs,
denialReply, contextUsage[used,window]`, `null` when absent); and
`projectionDigest(messages, sha256)` = `sha256(concat(sha256(canonicalMessage(m_i))))` with
the hasher INJECTED (each side passes `node:crypto` `createHash("sha256")`). One
implementation, both ends; a fixed test vector pins it. Fields unknown to the protocol version
are outside the digest, so a newer daemon's extra field never trips it.

Disk-readiness for task 2: entries are self-describing (envelope + type), ordered by `seq`,
linked by `prev`, and segments start at `base`: task 2 appends the VALIDATED,
RE-SERIALIZED entries the client returns (F4) as JSONL lines with no transformation. "Keep
superseded history" (task 2): the reader already receives the old segment's tail before the
`base` (retention, §2), so task 2 decides per its config (default `false`) to rotate the file
at a `base{compact|context_reset}` or keep appending. `gap: true` (§3) tells it when entries
between its head and the `base` were not available (more than one segment behind).

#### 2. Daemon: derive and serve (pure module + 6 hooks)

New pure module `packages/daemon/src/session-log.ts` (`SessionLog`, React/IO-free, unit-tested
with plain arrays):

- `constructor(inc, now)`; `start(messages, reason, base?: {seq, id})` → `base` + `count`
  `message` entries; `seq = base ? base.seq + 1 : 1`, `prev = base?.id ?? null`.
- `commit(messages, length)`: diff `messages[0, length)` against the reference copy:
  `replace` for each `i < min(old, length)` whose reference differs; `truncate` if
  `length < old`; `message` for each `i ≥ old`. Reference copy := `messages.slice(0, length)`.
  O(n) pointer compares (eval M8: 5 µs at 3 353 messages) — the only work inside the
  steering window (`finishTurn` → `recordCut`), no `await`, no stringify.
- `replaced(messages, reason)`: new segment `base{reason}` + its messages; the reference copy
  is RESET (F3). Retention: the current segment + the previous one; older segments are
  dropped (F5 memory bound: at most two context windows of entries, which reference the
  same message objects).
- `title(t)`: a `title` entry when the wire title (`wireTitle()`, `hosted-session.ts:1095-1098`)
  differs from the last one logged.
- `checkpoint()`: a `checkpoint` entry whose `digest` is computed LAZILY — from the reference
  copy captured at that point (immutable messages, proof 1) — by the first read that serves
  it, never in the steering window. Emitted at turn end and after a compaction (Q6).
- `read(after?: {seq, id}, maxChars)`: synchronous, pure over the retained entries →
  `{entries, more, tip: {seq, id}, rebased?: true}`:
  - `after` absent → **cold read from the last `base`** (F5);
  - `after` = a retained entry (same `seq` AND `id`) → the entries after it, crossing at most
    one `base`;
  - otherwise (unknown id, another incarnation, evicted) → `rebased: true` + from the last
    `base`.
  Paged by a char budget `LOG_PAGE_MAX_CHARS = 256 * 1024` (a single larger entry travels
  alone; the per-entry size is computed once and cached) — below `maxFrameBytes` (P4) and no
  worse than today's ~230 KB page for head-of-line delay.

Hooks in `HostedSession` (each synchronous, inside the stretch that already exists):
constructor after the cut is set (`hosted-session.ts:478-484`: `start(messages, restored ?
"reload" : seeded ? "seed" : "create", logBase)`); `recordCut` (`:1122-1131`: `commit(messages,
cut.length)` + `title`); `historyReplaced` (`:1930-1950`, before the emit: `replaced`);
`swapAgent` (`:1465`: `commit` — the head swap, proof row 6); `setTitle` (`:1810-1812`:
`title`); `finishTurn` after `recordCut` (`:1628`) and `compact`'s `finally` (`:1913-1915`):
`checkpoint`. New method `logRead(after, limit)`.

`Connection`: `case Method.Log` → `this.lookup(id).logRead(…)` — synchronous like `snapshot`
(`connection.ts:241-242`, `:310-313`): no lock, no await (§7). `SessionHost.open` passes
`params.logBase` to `build` only for a session this open CREATES from `messages`
(`session-host.ts:476-494`); ignored in every other case (like `title`, `settings`).
`logBase` is client-supplied numbering only — it grants nothing.

#### 3. Client: read, validate, project, classify (pure module + `readBack`)

New pure module `packages/client/src/session-log-reader.ts`:
`applyLogRead(state | null, pages, sha256) → {state, outcome, aside?, gap?, entries} | {error}`.

Validation (F4 — the pod is not trusted), per entry: a KNOWN `type` → parsed by its strict-ish
zod schema (strip) → the re-serialized object is what is kept; an UNKNOWN `type` → dropped if
not `critical`, the whole read refused if `critical` (cannot project); `seq` = previous + 1;
`prev` = previous `id`; `replace.index < length`; `truncate.length ≤ length`; a `base` is
followed by exactly `count` `message` entries; message bounds as `ChatMessageSchema`. Any
violation → the read fails (no partial state), the caller retries once cold, then reports.

Classification of a read against the held state `{inc, head, messages, digests}`:

| Read | Rule | Outcome |
|---|---|---|
| not `rebased`, `entries[0].prev === head.id` | linear tail | apply |
| `rebased`, the `base`'s `inc === held.inc` | same incarnation ⇒ one writer, linear by construction; superseded entries skipped | apply the `base`; `gap: true` |
| `rebased`, `base.prev === head.id` (a reseed from THIS head) | continuation across incarnations | apply |
| `rebased` otherwise (a new lineage) | compare the new projection P′ to mine P by per-message digests: P′ = P, or P is a prefix of P′ → continuation; anything else (P′ a strict prefix of P, or divergent) → **FORK** | continuation: adopt silently. FORK: return `aside = P`, adopt P′ (**F1: set aside, never spliced**) |
| `checkpoint` mismatch | derivation drift (F2) | one cold read; if it still mismatches, keep the cold projection (it is what this build can represent) and report once — never loop |

Why "adopt the daemon's": the daemon owns the live conversation (§7 persistence); the
laptop's divergent copy is preserved, never lost — strictly better than today's silent
replace (P9). See Q3.

`RemoteClient` (`remote-client.ts`): `readBack` (`:1093-1116`) reads `session/log` pages
(`after` = the last received entry) into a STAGING state until `more: false`, then commits
(`entry.log`, and `historyRead` — `entry.history` stays "the newest history read", P6);
keeps the `whenLive` retry loop (P7); a rebase between two pages restarts the read cold
(bounded, like `SNAPSHOT_ATTEMPTS` `:121`). `ReadBack` (`:186-189`) gains
`entries` (the validated known entries of this read, for task 2), `aside?` and `gap?`. The
recreate paths (`:1666-1671`, `:1785-1796`) add `logBase: entry.log.head` when held. The
snapshot path (`readSnapshot*`, resync) is unchanged (Q1).

#### 4. CLI: the same JSON record, plus the fork aside

`persistingController` (`local-runtime.ts:349-389`): unchanged flow; when `back.aside` is
present it first hands the held copy to a new `setAside(messages)` callback. The runtime's
callback (`:728-750`) builds the record like `persist` and calls `deps.saver.saveAside(record)`
→ `JsonSessionStore.saveAside` (new; reuses `writeAtomic`'s aside naming,
`session-store.ts:508-510`) → notice "⚠ Session <id8>: the daemon's history diverged from this
copy (a restarted daemon was reseeded from another copy) — this copy saved aside in <file>".
`cutHistory` (`:278-297`) and the Q6 guard stay as they are (task 2 removes them).

#### 5. Q5 (owner, 2026-11-07): turn markers are IN this task

*— claude-opus-5-5, 2026-11-07 (executor; re-verified on `9dc71ec`)*

Three more v1 types, all `critical: false` (owner table, item 14). Emitted by the daemon now;
their disk reader (moving `cutHistory` to load) is task 2. The laptop validates and keeps
them (F4) in `ReadBack.entries`; the projection ignores them.

| `type` | Payload | Emitted (each synchronous, in a stretch that exists) |
|---|---|---|
| `turn_start` | `{turnId}` | when a turn is accepted: `prompt` (`hosted-session.ts:1215`, which the wake turn reuses, `:1694`) and `startSuccessor` (send-now, `:1401`) — BEFORE the turn's messages (the prompt is pushed by the generator but enters the log at the turn's first commit) |
| `turn_end` | `{turnId, stopReason}` | in `finishTurn` (`:1597-1645`), AFTER the derivation at `recordCut` (`:1628`), so it follows the turn's last message; not for an unstarted send-now (`endUnstarted` `:1423`: no `turn_start`, nothing delivered) |
| `call_started` | `{callId}` | on the agent's `tool_phase running` event in `drive` (`:1550`; yielded by `signalRunning`, `agent.ts:1563-1569`, "right BEFORE the call starts", for a single call `:1336` and each call of a group) — the call starts only on the next pull, so the entry precedes the start; it follows the assistant message naming the call (committed before any call runs, `agent.ts:948-950`) |

A turn open across a `base` (a `context_reset` mid-turn, a `serve` reload with a resumed turn)
is named on the `base` itself: `base.turn?: turnId`. So a cold read from the last `base` (F5)
knows a turn is open without the `turn_start` before it. Rule for task 2's reader: a turn is
open from its `turn_start` (or a `base` carrying `turn`) to its `turn_end`.

#### 6. Executor additions found while re-verifying (drift-free refinements)

- `RemoteClient.snapshot()` today is `readBack().messages` (`remote-client.ts:1085-1087`) and
  is used by tests and `RemoteSession.snapshot` (no production caller outside the client).
  It keeps the SNAPSHOT path (unchanged behaviour, Q1); only `readBack` moves to the log.
- A recreate sends `logBase` only when `entry.history` IS the log projection (same array):
  `entry.history` can also come from a display resync (`:1840`, `:1944`), and a `logBase`
  must name the head of exactly the messages sent; otherwise none is sent and the content
  compare of the classification table decides.
- `HostedSession` gains a trailing constructor argument `log: SessionLogOptions = {}`
  (`{base?, verify?}` — `verify` is the test-only D1 replay assertion).
- An aside is written BEFORE the main file is replaced, and a failed aside write keeps the
  main file untouched and is retried at the next save (the controller holds it), so the old
  copy is never lost between the two writes.

### Files (dependency order; smallest diff)

1. `packages/protocol/src/session-log.ts` (new): envelope + v1 entry schemas,
   `LogParamsSchema {sessionId, after?: {seq, id}, limit?}`,
   `LogResultSchema {entries: LogEntryWire[] (envelope .passthrough()), more, tip, rebased?}`,
   `canonicalMessage`, `projectionDigest`, `LOG_PAGE_MAX_CHARS`.
   `packages/protocol/src/session.ts`: `OpenParamsSchema.logBase?` (`:496-513`).
   `packages/protocol/src/methods.ts`: `Method.Log = "session/log"` + `RequestSchemas`
   (`:60-91`, `:109-121`). `packages/protocol/src/version.ts`: `16 → 17`.
   `packages/protocol/src/index.ts` (exports), `packages/protocol/src/json-schema.ts`
   (list the passthrough envelope if the exporter flags it) + regenerate
   `packages/protocol/schema/protocol.json` (`bun run schema:export`).
2. `packages/agent/src/session-store.ts`: `saveAside(record)` (S).
3. `packages/daemon/src/session-log.ts` (new, pure). `packages/daemon/src/hosted-session.ts`:
   the 6 hooks + `logRead`. `packages/daemon/src/connection.ts`: `Method.Log`.
   `packages/daemon/src/session-host.ts`: `logBase` → `build` → `HostedSession`.
4. `packages/client/src/session-log-reader.ts` (new, pure). `packages/client/src/remote-client.ts`:
   `readBack`, `ReadBack`, `entry.log`, recreate `logBase`.
5. `packages/cli/src/session-saver.ts`: `saveAside`. `packages/cli/src/local-runtime.ts`:
   `setAside` callback + its wiring.
6. Docs on this branch: this doc (`docs/feat/session-log.md`); `ARCHITECTURE.md` read-back
   paragraph; `TODO.md` row. AGENTS §7 persistence wording NOT changed here (task 2, owner
   default 5).

No TUI change (the notice rides `NoticeHub`).

### Failure modes (each: how state converges)

| # | Case | Convergence |
|---|---|---|
| 1 | **Disconnect mid-read** (between pages) | staging is discarded; `whenLive` repeats the read after the reconnect (P7) from the last COMMITTED head; read-only, so repeating is safe |
| 2 | **Daemon restart, pod daemon (new incarnation, nothing kept)** | the client recreates with `messages` + `logBase` (P6); the new daemon's `base{seed}` has `prev = logBase.id` → continuation; costs one full read of the seed (rare event) |
| 3 | **Daemon restart, `serve` reload** | `base{reload}`, `prev: null`, new `inc` → new lineage; content compare → equal ⇒ adopt silently. Only `createLocalRuntime` readers persist (P8): `connect` is unaffected. Continuing the lineage across a serve reload is task 3 (Q12) |
| 4 | **Several TUIs** (a detached run's, eval objection 5) | each `RemoteClient` holds its own head; the daemon's read is stateless (no per-client cursor daemon-side). Two TUIs reseeding two new daemons after a pod loss → each sees the other's lineage as new; equal or prefix ⇒ adopt, divergent ⇒ FORK aside (F1), never a splice. Their JSON writes still race as today (last rename wins + Q6), unchanged |
| 5 | **The F1 scenario** (A on D1 holds 49–50; B reseeds D2 at 48; A reads D2) | D2 is a new lineage with `base.prev = 48 ≠ 50`; P′ (…48[,51]) is not an extension of P (…50) → FORK: A's copy aside, D2's adopted, notice. Test C3 |
| 6 | **Compaction between reads** | `after` is in the retained previous segment → old tail + `base{compact}` + new messages (exact; task 2 can keep the old tail). Two segments behind → `rebased`, same `inc` → `gap: true` |
| 7 | **Compaction between two PAGES of one read** | the next page's `after` is still retained → continues; if evicted → `rebased` → restart cold (bounded attempts) |
| 8 | **`context_reset` mid-turn** | `historyReplaced` runs synchronously after the in-place replacement (proof row 7) → `base{context_reset}`; the turn's later commits append to the new segment. A read in the microtask gap between `agent.ts:1763` and `hosted-session.ts:1532` sees only already-derived entries (served from the log, never from the live array) |
| 9 | **`/clear` mid-turn** | close + new uid (P10): the old session's last read stands as today; the new session's log starts with `base{create}`. Nothing superseded |
| 10 | **Failed turn** | `closeFailedTurn` replaces/pushes, `finishTurn` → `recordCut` → `replace`/`message` entries + `checkpoint` |
| 11 | **`/settings` head swap** | `swapAgent` → `commit` → `replace{index: 0}` (the hook this plan adds — the one place today's design would miss) |
| 12 | **Sub-agents, parallel tools** | no new mutation site (proof 3); one commit for a parallel group → several `message` entries in one derivation |
| 13 | **Annotation (`contextUsage`) behind the cut** | picked up at the next `recordCut` as a `replace` (the snapshot showed it at once; the log shows it one cut later — it is model-visible only on the next request, which a cut precedes) |
| 14 | **Version skew** | `PROTOCOL_VERSION 17`: a mixed pair fails at `initialize` with `VersionMismatch` (no snapshot fallback, pre-public rule). Same version, newer daemon: a new optional field is stripped (P3) and outside the digest; a new NON-critical type is dropped by the laptop (F4); a new CRITICAL type requires a version bump (rule written in the protocol module, like `UPDATE_CLASS` mandatory) — an un-bumped one fails the read loudly, never half-projects |
| 15 | **Oversized frames** | pages are bounded by `LOG_PAGE_MAX_CHARS`; a single entry larger than the budget travels alone (as today a message larger than a page does); a single message > `maxFrameBytes` fails the read exactly as the snapshot does today (`oversize-frame-hang` behaviour unchanged) |
| 16 | **Hostile pod** | malformed / out-of-order / dangling `prev` / out-of-range `replace`/`truncate` / wrong `count` → read refused, nothing committed, retried once cold, reported via `onFlushError`; the held copy is untouched. A pod can still feed a different history (true today); it can no longer make the laptop silently LOSE its copy (fork ⇒ aside). Unknown types never reach the laptop's state (F4). `logBase` sent TO a pod grants nothing |
| 17 | **Empty / fresh session** | `base{create}` + the system message; the read before the first send returns `null` as today (`remote-session.ts:479-480`) |
| 18 | **Derivation bug** | caught by the `checkpoint` digest in production (one cold read, then a reported mismatch) and by test D1 in CI |
| 19 | **Daemon memory** | two segments of entry envelopes referencing live message objects; the superseded segment is freed at the next `base` |

### Tests (red first; fakes and seams that exist)

Seams: `SessionHost` + `Connection` + `RemoteClient` over `createChannelPair` with a frame
filter (the `dial()` pattern of `packages/client/test/context-reset.test.ts:83-139`),
`GatedModel` (`client/test/support/fakes.ts:23`), the cli fakes of
`packages/cli/test/local-runtime.test.ts`, an in-memory `SessionStoreIo`.

**Red on `main` (the headline properties):**
- **R1 — steady-state cost** (`client/test/session-log.test.ts`): on a seeded ~2 MB session,
  a second `readBack` with no change moves ≤ 1 frame and < 1 KB of response; after one round
  it moves < 16 KB. RED on main: 9 requests, 2.1 MB (repro above).
- **R2 — fork is set aside, not lost** (`cli/test/local-runtime.test.ts`): the F1 scenario
  (A holds a divergent history; the daemon now holds another lineage) → an `.aside` file
  holds A's copy and a notice is raised. RED on main: the main file is silently replaced, no
  aside (P9).

**Daemon (pure `session-log.ts` + `hosted-session`):**
- **D1 — drift invariant** (run FIRST): a test-only option makes `HostedSession` assert after
  every derivation that `replay(log)` deep-equals `messages[0, cut.length)`; driven through a
  multi-round turn, a parallel group, a failed turn, a `contextUsage` annotation, a head swap,
  a compaction, a `context_reset`, a wake turn. **Mutation:** a "since length" derivation
  (appends only) must FAIL it (head swap, annotation, `closeFailedTurn`); removing the
  `swapAgent` hook must FAIL it; not resetting at `historyReplaced` must FAIL it.
- D2 `replace` for index 0 / mid / last; D3 `truncate` on a shrink (synthetic — F3); D4
  `base` + retention (current + previous segment; an `after` two segments back → `rebased`);
  D5 paging by char budget, an oversized single entry alone, `more`; D6 `logBase` honoured
  only on a create-from-messages; D7 `checkpoint` digest is lazy (no hashing inside
  `finishTurn` — a spy hasher counts zero calls until a read); D8 `logRead` is synchronous
  and a `session/log` is answered while a `session/prompt` is in flight (peer not
  serialized, §7).

**Client (pure `session-log-reader.ts`):** C1 linear tail; C2 same-`inc` rebase → `gap`;
C3 reseed continuation (`base.prev === head`); C4 new lineage equal / prefix → adopt, strict
prefix / divergent → FORK with `aside`; C5 unknown non-critical dropped and ABSENT from
`entries` (F4 — mutation: keeping it fails); C6 unknown critical → error, state untouched; C7
each malformed case of failure mode 16 → error, state untouched; C8 checkpoint mismatch →
one cold read, then reported once (no loop); C9 `canonicalMessage`/`projectionDigest` test
vector, identical result for the daemon's object (spread order) and the laptop's parsed
object (schema order).

**Integration (client↔daemon):** I1 disconnect between pages → repeated from the committed
head, no partial commit; I2 compaction between two pages; I3 pod-daemon loss → recreate with
`logBase` → continuation, no aside; I4 two clients on one session each converge to the same
projection; I5 the saved JSON record after each round equals today's (same `cutHistory`
mid-turn closing) — regression guard for the unchanged disk format.

**Protocol:** `session/log` schemas round-trip; an envelope with an unknown `type` and extra
fields passes the RESULT schema (P3 — one unknown entry must not reject the read);
`OpenParams.logBase` bounds; `schema/protocol.json` drift test regenerated.

**Acceptance — end-to-end pod measurement** (owner decision 1; script in
`.tentacle/tmp/session-log/pod-measure.ts`, pasted into Execution with its output; run on
`main` first, then on the branch):
1. *Simulated link* (always runnable): a `DuplexChannel` wrapper with one ordered queue per
   direction, 47.5 ms one-way-RTT/2 latency and 12 Mbit/s (the `rpc-flow-control.md`
   figures); a 2 MB seeded session; measure (a) cold read-back time, (b) steady-state
   read-back time after one round, (c) the delay of a `session/update` chunk the daemon
   emits right after a read-back response is queued (pod→laptop direction, the one the TUI
   stream shares).
2. *Real pod* (`TENTACLE_K8S_SERVER`, opt-in, Q10): the same three numbers over
   `KubeClient.openExec` with a `run` of a pre-seeded 2 MB record.
   Pass (proposed, Q10): (b) ≤ 1 RTT + 50 ms and < 16 KB; (c) ≤ 1 RTT + 100 ms during a
   steady-state read; (a) reported, not gated (≈ today's snapshot).

**Gate:** `bun run check` (typecheck → lint 0/0 → test, opt-in skips only), AGENTS §6.

### Owner questions (all at once; each with a recommendation)

1. **Display resync keeps `session/snapshot` in this task** (the log replaces only the
   persistence read-back)? — **Yes.** The resync needs the stream cut (`since`, `turn`,
   `queued`, P8) consistent with the replay ring; folding that into the log is a separate
   design. Record a follow-up `feat/session-log-resync` (after task 3) to make the snapshot's
   history come from the log.
2. **Bump `PROTOCOL_VERSION` 16 → 17 with no fallback to `snapshot` for an older daemon?** —
   **Yes** (pre-public rule; the new client cannot persist without `session/log`).
3. **Fork policy: adopt the daemon's lineage and set the laptop's divergent copy aside (with
   a notice)**, rather than keep the laptop's and refuse the daemon's? — **Adopt + aside.**
   The daemon owns the live conversation; nothing is lost; strictly safer than today's silent
   replace.
4. **A per-entry `critical` flag now** (unknown + critical → refuse; unknown + not → skip)?
   — **Yes**: one optional boolean; task 2's loader needs it for files a newer build wrote.
   Rule: adding a critical type = `PROTOCOL_VERSION` bump.
5. **Turn markers (`turn_start`/`turn_end`/`call_started`) in this task or in task 2?** —
   **Task 2**: their only reader is the disk loader (moving `cutHistory` to load); additive,
   non-breaking for the same build. This task keeps `cutHistory` on the laptop.
6. **F2 as BOTH the parent chain and a lazy projection-digest `checkpoint` at turn end and
   after a compaction** (mismatch → one cold read → reported, no loop)? — **Yes.** The chain
   alone cannot see daemon-side derivation drift; the digest is ~ms per turn daemon-side, off
   the steering window.
7. **Daemon retention = current segment + the previous one** (a reader further behind gets
   `rebased` + `gap`)? — **Yes**: makes "keep superseded" exact for any reader that saves
   every round, with memory ≤ two context windows.
8. **`/clear` excluded from "keep superseded history"** (it starts a new uid; the old record
   is already kept intact, P10)? — **Yes.**
9. **Config key for task 2: `sessions.keepSuperseded: boolean`, default `false`**, covering
   `compact` and `context_reset`? — **Yes** (named now so task 2 does not re-decide it).
10. **E2E measurement: can the executor use a cluster (`TENTACLE_K8S_SERVER`), and are the
    proposed pass thresholds right?** — Recommend: a cluster run is REQUIRED for Review sign-off;
    if none is available during Execution, the simulated-link numbers gate Execution and the
    cluster run is a named Review item. Thresholds as in Tests.
11. **The title rides the log (`title` entry, non-critical) instead of `snapshot.title` in
    the read-back?** — **Yes** (one read primitive for persistence).
12. **Continue the lineage across a `serve` reload now** (store the head in the daemon record:
    `DAEMON_RECORD_VERSION` 8 → 9)? — **No, task 3**: no laptop copy exists behind `connect`
    (P8), so nothing forks today.
13. **Keep this as ONE L task, or split?** — **One L.** The new logic is two pure modules
    (contained, unit-tested); the load-bearing part is 6 hooks + one method + `readBack`. A
    split (1a protocol+daemon serving an unused method, 1b client+cli) would leave dead code
    on `main` between them and a daemon half nobody exercises end to end — the eval's own
    round-1 reasoning. Fallback if Review finds the branch illegible: split exactly there.

### Notes / debt (deliberate)

- The JSON record, the Q6 guard and `cutHistory` stay (task 2 removes them).
- `session/snapshot` stays for the display resync (Q1); attach still costs one full snapshot
  (display) + one cold log read (persistence), as today's two full reads.
- `serve` lineage across reloads: task 3 (Q12).
- Mobile: `docs/eval/mobile-app.md` gets the line that task 12 builds its cache on
  `session/log {after}` (owner default 5) — a docs carve-out edit on `main`, not this branch.

## Execution

*— claude-opus-5-5, 2026-11-07*

**Result: done.** Protocol 16 → **17**. Gate (once, at the end): `bunx tsc --noEmit` clean ·
`bunx biome check .` 0 errors / 0 warnings · `bun test packages` **5379 pass, 3 skip (the
opt-in live-k8s / live-docker / slow-socket), 0 fail**. `tsc -p apps/mobile` (the second half
of `bun run typecheck`) fails in this worktree on `react-native` not installed / lib.dom ×
`@types/ws` — environmental (no error under `packages/`); CI installs and checks it.

### As built, in order

1. **Implementation updated for Q5 first** (§5 above) and re-verified on `9dc71ec`; every
   citation touched matched (`hosted-session.ts` constructor `:478-484`, `recordCut`
   `:1122-1131`, `swapAgent` `:1456-1472`, `historyReplaced` `:1930-1956`, `finishTurn`
   `:1597-1645`, `compact` `:1880-1922`; `remote-client.ts` `readBack` `:1093-1116`,
   recreate `:1666-1671` / `:1785-1796`; `local-runtime.ts` `:354`, `:445-447`).
2. **Protocol** — `packages/protocol/src/session-log.ts` (new: envelope `.passthrough()` for
   the result, 9 strip schemas incl. `turn_start` / `turn_end` / `call_started`, the owner's
   `LOG_ENTRY_CRITICAL` table, `canonicalMessage` / `messageDigest` / `projectionDigest`,
   `LOG_PAGE_MAX_CHARS`); `Method.Log` + `RequestSchemas`; `OpenParams.logBase`;
   `PROTOCOL_VERSION = 17`; `schema/protocol.json` regenerated (`bun run schema:export`).
3. **Runtime proof D1 (load-bearing assumption) — HOLDS.** Pure `SessionLog`
   (`packages/daemon/src/session-log.ts`) + the hooks EXCEPT `swapAgent`, then D1
   (`packages/daemon/test/session-log.test.ts`): multi-round turn, a parallel group (one
   commit), a failed turn (`closeFailedTurn`), `contextUsage` annotations, a head swap, a
   compaction, a `context_reset` mid-turn, a wake turn. **Red without the `swapAgent` hook**:
   exactly one drift, at the read after the swap (`at a read: replay != snapshot (8
   messages)`); green with it. D1b adds the real `agent_task` sub-agent: the child's history
   never reaches the parent's log.
4. **Daemon** — hooks in `HostedSession` (constructor `start`, `recordCut` `commit`+`title`,
   `historyReplaced` `replaced` before the emit, `swapAgent` `commit`, `setTitle` `title`,
   `prompt` / `startSuccessor` `turnStart`, `drive` on `tool_phase running` `callStarted`,
   `finishTurn` `turnEnd`+`checkpoint` after `recordCut`, `compact`'s `finally` `checkpoint`)
   + `logRead`; `Connection` `case Method.Log` (synchronous, no lock); `SessionHost.open`
   passes `logBase` to `build` only for a session created FROM `messages`.
5. **Client** — pure `packages/client/src/session-log-reader.ts` (`applyLogRead`: chain over
   every entry, F4 parse/drop/refuse, projection with per-message digests, checkpoint drift,
   classification cold / linear / rebased(gap) / reseed / adopt / fork(aside));
   `RemoteClient.readBack` → `readLog` (staging pages, commit only a complete valid read,
   a refused read retried cold, a drifted checkpoint re-read cold once then reported once,
   bounded `LOG_ATTEMPTS = 3`, `LOG_MAX_PAGES = 10 000`, the `whenLive` loop kept); `ReadBack`
   gains `entries` / `aside?` / `gap?`; recreate sends `logBase` via `logBaseOf`.
6. **CLI** — `JsonSessionStore.saveAside` (Q6 aside naming, never touches `<uid>.json`);
   `SessionSaver.saveAside` (+ notice); `persistingController` 7th argument `setAside`
   (awaited BEFORE `persist`; a failure keeps the file and is retried at the next save);
   `createLocalRuntime` wires it and passes a node `sha256` to `RemoteClient`.
7. Docs: this section, `CHANGELOG.md` `[Unreleased]` → `### Changed`, `TODO.md` row.

### Drift from the Implementation (and why)

- **`prev` is OPTIONAL (absent on a lineage's root), not `null`.** The repo's wire-hygiene test
  (`json-schema.test.ts` "null appears only where it carries meaning") forbids `null` for
  "none"; absent says the same.
- **`base.turn?`** (Q5): the turn open at a base, so a cold read from the last base (F5)
  knows it (§5).
- **The title is re-logged at every segment start** (`SessionLog.segment` resets the last
  title): without it a cold read after a compaction had no title.
- **`LogParams.maxChars`** (a char budget) instead of the plan's `limit`.
- **`RemoteClient.snapshot()` stays on the snapshot path**; only `readBack` moved (§6).
- **`sha256` is injected into `RemoteClient`** (`RemoteClientOptions.sha256`; default
  `Bun.CryptoHasher` when on Bun; without one `readBack` refuses): `apps/mobile` imports
  `RemoteClient`, so no `node:crypto` there. The CLI passes `node:crypto` explicitly.
- **D1 checks at READ points too** (a cold read's replay = `snapshotPage()` at each pull), not
  only after each derivation: the derivation-only check did NOT catch the missing
  `swapAgent` hook (the next compaction re-based before any derivation compared) — the
  exact property is "what a reader gets = the committed prefix", which this checks.
- **Mutation "no reset at `historyReplaced`"** is caught by D1's segment assertion, not by
  drift: the reference copy is a `slice`, so a diff across the in-place replacement is still
  content-exact. The reset is needed for the segment (`base`, F5 cold read, retention), which
  is what fails.
- **`ARCHITECTURE.md` not edited**: it has no read-back paragraph to update.
- Existing tests edited (never overwritten): version pins 16 → 17
  (`daemon/test/session-settings`, `protocol/test/session-settings`,
  `protocol/test/update-settings`); `daemon/test/version-mismatch` (15↔16 now against the
  current daemon; new 16↔17 case; 10↔current text); `protocol/test/json-schema` (`session/log`
  fixtures incl. an unknown entry type, 6 discriminated unions); `client/test/session-titles`
  C1 (its fake daemon answers `session/log`); `cli/test/local-runtime` H35 ×3 (the read-back
  frame/method is `session/log` / `logRead`).

### Tests and red/green evidence

New: `protocol/test/session-log.test.ts` (C9 fixed vector
`3bb2c9d0…56c2`, spread vs schema order, P3 unknown entry passes the result parse, bounds,
the critical table vs each schema), `daemon/test/session-log.test.ts` (D1, D1b, D2–D8),
`client/test/session-log-reader.test.ts` (C1–C8), `client/test/session-log.test.ts` (R1,
I1–I4, F2 over the wire), `cli/test/local-runtime.test.ts` + R2, aside ordering, I5.

Red first: the headline tests are red on `main`'s code, on their assertion (the file swapped
in temporarily with `git show 9dc71ec:… >`, restored from a `cp` backup, `shasum -c` OK):
**R1** with `main`'s `remote-client.ts`: `Expected: <= 1, Received: 9` (requests);
**R2** with `main`'s `local-runtime.ts` + `remote-client.ts`: `Expected length: 1, Received
length: 0` (no aside). The new pure modules' tests can only be red by a missing import on
`main`, so their non-vacuity is shown by mutation instead:

| Mutation (each restored, `shasum -c` OK) | Caught by |
|---|---|
| no `commit` in `swapAgent` | D1 (one drift at the read after the swap) |
| "since length" derivation (no `replace`) | D1 (6 drifts: annotation, failed turn, head swap) |
| `historyReplaced` diffs instead of starting a segment | D1 (`base` reasons) |
| checkpoint hashed in `finishTurn` (eager read) | D7 (`hashes` 4 ≠ 0) |
| unknown entries kept in `entries` | C5 |
| never classify a fork | C3 + C4 |
| no `logBase` on recreate | I3 |
| aside fire-and-forget (not awaited, not retried) | "aside lands BEFORE…" |

Failure modes → tests: disconnect mid-read I1 · pod daemon restart → reseed I3 (D6 for
`logBase` scope) · new lineage / serve reload C4 · F1 fork C3 + R2 · several TUIs I4 ·
compaction between pages I2, between reads D4 · `context_reset` mid-turn D1 (`base.turn`) ·
failed turn / head swap / annotation / parallel group / wake D1 · sub-agents D1b ·
version skew `version-mismatch` 16↔17 · oversized D5 (budget, a larger entry alone) ·
unknown critical / non-critical from a pod C5 / C6 · malformed C7 · retention gap → `rebased`
D4 + C2 · checkpoint drift C8 + F2-over-the-wire · lazy digest D7 · peer not serialized D8 ·
disk format unchanged I5.

### Acceptance — simulated link (`.tentacle/tmp/session-log/pod-measure.ts`)

Real stack, 47.5 ms one way, 12 Mbit/s, one ordered queue per direction, a 1663-message
~2 MB seeded session; (c) = a `session/update` the daemon emits right after the read-back's
first response is queued pod→laptop. "main" = this branch with `main`'s `remote-client.ts`
swapped in (its read-back is the snapshot path; the daemon's `snapshotPage` is unchanged).

| | main | branch |
|---|---|---|
| (a) cold read-back | 2295 ms · 9 frames · 2067 KiB · chunk +219 ms | 2600 ms · 10 frames · 2349 KiB · chunk +223 ms |
| (b) after one round | 2293 ms · 9 frames · 2067 KiB · chunk +218 ms | **101 ms · 1 frame · 1.2 KiB · chunk +51 ms** |
| (b') nothing new | 2295 ms · 9 frames · 2067 KiB · chunk +218 ms | **97 ms · 1 frame · 0.3 KiB · chunk +49 ms** |

Proposed gates (Q10): (b) ≤ 1 RTT + 50 ms = 145 ms and < 16 KB → **pass**; (c) during a
steady read ≤ 1 RTT + 100 ms = 195 ms → **pass** (51 ms). (a) reported, not gated: **+13 %**
vs the snapshot (entry envelopes, +14 % bytes) — paid once per attach / cold start.

### Unverified (and how to verify)

- **Real cluster** (Review item, Q10): not run here (no cluster). Command below.
- A hostile pod that forges `base.inc` (claims the held incarnation) or `base.prev` (claims a
  reseed from the held head) can replace the laptop's copy WITHOUT an aside; it could always
  feed any history (as today). F1's aside protects the honest daemon-restart fork it was
  specified for. Verify: Review decides whether "rebased"/"reseed" should also require
  the content to extend the held copy, else aside (costs an aside per double-compaction gap).
- A single message larger than `maxFrameBytes` fails the read as the snapshot does today —
  unchanged, not re-tested.

### Real-cluster run (Review)

```sh
# laptop, this branch
bun run compile                                    # → dist/tentacle (protocol 17)
./dist/tentacle run --image <image> --engine kubernetes -n <ns> --name sl-measure
#   in the TUI: /quit at once — the pod is KEPT (no --rm) with the branch binary injected
bun .tentacle/tmp/session-log/pod-measure-k8s.ts "$PWD" <ns> sl-measure [/usr/local/bin]
#   prints: daemon protocol 17, (a) cold, (b) after one round, (b') nothing new,
#   each with frames / KiB and the update's head-of-line delay vs an idle rename
./dist/tentacle rm sl-measure
```
(`pod-measure-k8s.ts` is gitignored scratch: it opens `serve --bridge --model-proxy` on the
pod through `buildEngineHost("kubernetes")` + `openExec`, with kubeconfig or
`TENTACLE_K8S_SERVER`/`_TOKEN`; validated here with `--local`: protocol 17, 10 → 1 frames,
2349 → 1.2 KiB.) Pass: as the simulated gates above, with the measured RTT.

### Owner live checklist

1. `run` on a cluster, a long session (`--resume` a big one): replies stream without the
   per-round stall; the session file still updates after each tool result and at turn end.
2. Kill the pod daemon mid-session (delete the pod's daemon process / reconnect): the session
   is recreated, no `.aside`, no notice.
3. Two terminals on one detached run; restart the pod; let terminal B reseed first and send a
   turn, then terminal A sends one: A shows "⚠ Session …: the daemon's history diverged …
   saved aside in …" and `<uid>.stale-….aside` holds A's old copy.
4. `/compact` mid-session, then keep going: saves continue (no error notice), the file holds
   the compacted history.
5. A laptop on the old build against a pod on this one (or reverse): refused at connect with
   the "update" message, nothing half-works.

### Scripts (gitignored scratch, pasted per AGENTS §6)

<details><summary><code>.tentacle/tmp/session-log/pod-measure.ts</code> (simulated link; output in the table above)</summary>

```ts
// Usage: bun pod-measure.ts <worktree-root> [targetBytes]
const root = process.argv[2];
if (!root) throw new Error("usage: bun pod-measure.ts <worktree-root> [targetBytes]");
const target = Number(process.argv[3] ?? 2_000_000);
const { Agent } = await import(`${root}/packages/agent/src/index.ts`);
const { PermissionBroker } = await import(`${root}/packages/core/src/index.ts`);
const { Connection, SessionHost } = await import(`${root}/packages/daemon/src/index.ts`);
const { ToolRegistry } = await import(`${root}/packages/tools/src/index.ts`);
const { createChannelPair } = await import(`${root}/packages/transport/src/index.ts`);
const { RemoteClient } = await import(`${root}/packages/client/src/remote-client.ts`);
const { createHash } = await import("node:crypto");
type Channel = ReturnType<typeof createChannelPair>[0];
const ONE_WAY_MS = 47.5;
const BITS_PER_MS = 12_000_000 / 1000;
const READS = new Set(["session/log", "session/snapshot"]);
/** One direction: ordered, serialised at 12 Mbit/s, then 47.5 ms of flight. */
function direction(deliver: (data: string) => void) {
  let busyUntil = 0;
  return (data: string): number => {
    const now = performance.now();
    busyUntil = Math.max(now, busyUntil) + (Buffer.byteLength(data) * 8) / BITS_PER_MS;
    const at = busyUntil + ONE_WAY_MS;
    setTimeout(() => deliver(data), Math.max(0, at - now));
    return at;
  };
}
const model = { id: "m", async *stream() { yield { type: "text", delta: "ok" }; yield { type: "done" }; } };
const host = new SessionHost({
  defaultCwd: "/tmp/pod-measure",
  createAgent: () => {
    const permissions = new PermissionBroker();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: {} as never,
      requestPermission: (req: never, options: never) => permissions.request(req, options) });
    return { agent, permissions };
  },
});
const [daemonEnd, d2] = createChannelPair();
new Connection(daemonEnd, host);
let onClientMessage: (data: string) => void = () => {};
const readIds = new Set<number | string>();
let probe = { armed: false, sentAt: 0, arrivedAt: 0, firstResponseQueuedAt: 0 };
let readBytes = 0;
let readFrames = 0;
const toClient = direction((data) => {
  if (probe.sentAt > 0 && probe.arrivedAt === 0 && data.includes('"session_title"')) probe.arrivedAt = performance.now();
  onClientMessage(data);
});
d2.setOnMessage((data: string) => {
  const frame = JSON.parse(data) as { id?: number | string };
  const isRead = frame.id !== undefined && readIds.delete(frame.id);
  if (isRead) { readBytes += Buffer.byteLength(data); readFrames++; }
  toClient(data);
  if (isRead && probe.armed) {
    probe.armed = false;
    probe.firstResponseQueuedAt = performance.now();
    // The daemon streams an update right after: queued behind that response.
    queueMicrotask(() => { probe.sentAt = performance.now(); host.get("S")?.rename(`probe ${probe.sentAt.toFixed(0)}`); });
  }
});
const toDaemon = direction((data) => d2.send(data));
const clientEnd: Channel = {
  send: (data: string) => {
    const frame = JSON.parse(data) as { id?: number | string; method?: string };
    if (frame.method && READS.has(frame.method) && frame.id !== undefined) readIds.add(frame.id);
    toDaemon(data);
  },
  close: () => d2.close(),
  setOnMessage: (h: (data: string) => void) => { onClientMessage = h; },
  setOnClose: (h: () => void) => d2.setOnClose(h),
};
const client = new RemoteClient(clientEnd, new PermissionBroker(), undefined, {
  sha256: (t: string) => createHash("sha256").update(t).digest("hex"),
});
await client.initialize();
const seed: unknown[] = [{ role: "system", content: "s".repeat(6000) }];
for (let i = 0, size = 6000; size < target; i++, size += 2400) {
  seed.push(
    { role: "assistant", content: "a".repeat(900), toolCalls: [{ id: `c${i}`, name: "x", arguments: "{}" }] },
    { role: "tool", content: "t".repeat(1500), toolCallId: `c${i}` },
  );
}
const session = client.newSession(seed, "S");
await session.openSeeded();
async function measure(label: string) {
  readBytes = 0; readFrames = 0;
  probe = { armed: true, sentAt: 0, arrivedAt: 0, firstResponseQueuedAt: 0 };
  const t0 = performance.now();
  const back = await session.readBack();
  const ms = performance.now() - t0;
  while (probe.sentAt > 0 && probe.arrivedAt === 0) await new Promise((r) => setTimeout(r, 5));
  console.log(`${label}: read-back ${ms.toFixed(0)} ms, ${readFrames} response frame(s), ${(readBytes / 1024).toFixed(1)} KiB, messages=${back?.messages.length}; chunk emitted after the first response: +${(probe.arrivedAt - probe.sentAt).toFixed(0)} ms`);
}
console.log(`seeded ${seed.length} messages (~${(target / 1e6).toFixed(1)} MB); link ${ONE_WAY_MS} ms one way, 12 Mbit/s`);
await measure("(a) cold");
for await (const _ of session.send("one round")) { /* drain */ }
await new Promise((r) => setTimeout(r, 300));
await measure("(b) steady, after one round");
await measure("(b') steady, nothing new");
process.exit(0);
```

Raw output, branch:

```
seeded 1663 messages (~2.0 MB); link 47.5 ms one way, 12 Mbit/s
(a) cold: read-back 2600 ms, 10 response frame(s), 2348.9 KiB, messages=1663; chunk emitted after the first response: +223 ms
(b) steady, after one round: read-back 101 ms, 1 response frame(s), 1.2 KiB, messages=1665; chunk emitted after the first response: +51 ms
(b') steady, nothing new: read-back 97 ms, 1 response frame(s), 0.3 KiB, messages=1665; chunk emitted after the first response: +49 ms
```

Raw output, `main`'s `remote-client.ts` swapped in:

```
(a) cold: read-back 2295 ms, 9 response frame(s), 2067.1 KiB, messages=1663; chunk emitted after the first response: +219 ms
(b) steady, after one round: read-back 2293 ms, 9 response frame(s), 2067.2 KiB, messages=1665; chunk emitted after the first response: +218 ms
(b') steady, nothing new: read-back 2295 ms, 9 response frame(s), 2067.2 KiB, messages=1665; chunk emitted after the first response: +218 ms
```
</details>

<details><summary><code>.tentacle/tmp/session-log/pod-measure-k8s.ts</code> (real pod, for Review)</summary>

```ts
// Usage:
//   bun pod-measure-k8s.ts <worktree-root> <namespace> <pod> [binDir=/usr/local/bin] [targetBytes]
//   bun pod-measure-k8s.ts <worktree-root> --local          (smoke: in-process daemon, no link)
const [root, nsOrLocal, pod, binDir = "/usr/local/bin", targetArg] = process.argv.slice(2);
if (!root || !nsOrLocal) throw new Error("usage: see the header");
const target = Number(targetArg ?? 2_000_000);
const { PermissionBroker } = await import(`${root}/packages/core/src/index.ts`);
const { RemoteClient } = await import(`${root}/packages/client/src/remote-client.ts`);
const { createHash } = await import("node:crypto");
type Channel = { send(data: string): void; close(): void; setOnMessage(h: (data: string) => void): void; setOnClose(h: () => void): void };
const model = { id: "laptop-fake", async *stream() { yield { type: "text", delta: "ok" }; yield { type: "done" }; } };
let raw: Channel;
if (nsOrLocal === "--local") {
  const { Agent } = await import(`${root}/packages/agent/src/index.ts`);
  const { Connection, SessionHost } = await import(`${root}/packages/daemon/src/index.ts`);
  const { ToolRegistry } = await import(`${root}/packages/tools/src/index.ts`);
  const { createChannelPair } = await import(`${root}/packages/transport/src/index.ts`);
  const host = new SessionHost({ defaultCwd: "/tmp/pod-measure", createAgent: () => ({
    agent: new Agent({ model, tools: new ToolRegistry(), env: {} as never }), permissions: new PermissionBroker() }) });
  const [d, c] = createChannelPair();
  new Connection(d, host);
  raw = c;
} else {
  if (!pod) throw new Error("a pod name is required");
  const { buildEngineHost } = await import(`${root}/packages/cli/src/engine-select.ts`);
  const { podDaemonCommand } = await import(`${root}/packages/cli/src/engine-runtime.ts`);
  const built = buildEngineHost("kubernetes", { namespace: nsOrLocal });
  raw = built.host.openExec(
    { name: pod, container: built.host.defaultContainer, command: podDaemonCommand(`${binDir}/tentacle`) },
    { onStderr: (chunk: string) => process.stderr.write(`[pod] ${chunk}`) },
  );
}
const READS = new Set(["session/log", "session/snapshot"]);
const readIds = new Set<number | string>();
let readBytes = 0;
let readFrames = 0;
let titleAt = 0;
let onMessage: (data: string) => void = () => {};
raw.setOnMessage((data) => {
  const frame = JSON.parse(data) as { id?: number | string };
  if (frame.id !== undefined && readIds.delete(frame.id)) { readBytes += Buffer.byteLength(data); readFrames++; }
  if (titleAt === 0 && data.includes('"session_title"')) titleAt = performance.now();
  onMessage(data);
});
const channel: Channel = {
  send: (data) => {
    const frame = JSON.parse(data) as { id?: number | string; method?: string };
    if (frame.method && READS.has(frame.method) && frame.id !== undefined) readIds.add(frame.id);
    raw.send(data);
  },
  close: () => raw.close(),
  setOnMessage: (h) => { onMessage = h; },
  setOnClose: (h) => raw.setOnClose(h),
};
const client = new RemoteClient(channel, new PermissionBroker(), model, {
  sha256: (t: string) => createHash("sha256").update(t).digest("hex"),
});
const init = await client.initialize();
console.log(`daemon protocol ${init.protocolVersion}`);
const seed: unknown[] = [{ role: "system", content: "s".repeat(6000) }];
for (let i = 0, size = 6000; size < target; i++, size += 2400) {
  seed.push(
    { role: "assistant", content: "a".repeat(900), toolCalls: [{ id: `c${i}`, name: "x", arguments: "{}" }] },
    { role: "tool", content: "t".repeat(1500), toolCallId: `c${i}` },
  );
}
const id = `session-log-measure-${crypto.randomUUID()}`;
const session = client.newSession(seed, id);
await session.openSeeded();
async function titled(): Promise<number> {
  titleAt = 0;
  const sent = performance.now();
  await client.rename(id, `probe ${sent.toFixed(0)}`);
  while (titleAt === 0) await new Promise((r) => setTimeout(r, 2));
  return titleAt - sent;
}
const idle = Math.min(await titled(), await titled(), await titled());
console.log(`seeded ${seed.length} messages (~${(target / 1e6).toFixed(1)} MB); idle rename→session_title ${idle.toFixed(0)} ms`);
async function measure(label: string) {
  readBytes = 0; readFrames = 0;
  const t0 = performance.now();
  const reading = session.readBack();
  const delay = titled(); // same tick: queued behind the read's first response
  const back = await reading;
  const ms = performance.now() - t0;
  const extra = (await delay) - idle;
  console.log(`${label}: read-back ${ms.toFixed(0)} ms, ${readFrames} frame(s), ${(readBytes / 1024).toFixed(1)} KiB, messages=${back?.messages.length}; update delayed +${extra.toFixed(0)} ms vs idle`);
}
await measure("(a) cold");
for await (const _ of session.send("one round")) { /* drain */ }
await new Promise((r) => setTimeout(r, 300));
await measure("(b) steady, after one round");
await measure("(b') steady, nothing new");
await client.closeSession?.(id);
process.exit(0);
```

`--local` smoke output (this machine): `daemon protocol 17` · (a) 10 frames 2348.9 KiB ·
(b) 1 frame 1.2 KiB · (b') 1 frame 0.3 KiB.
</details>

## Review

*— <reviewer model-id>, <date>*

(empty)

### Owner answers (2026-11-07) — plan APPROVED

*— recorded by the orchestrator (claude-opus-5-5), 2026-11-07*

1. Q1 YES — display resync keeps `session/snapshot`; follow-up `feat/session-log-resync` after task 3.
2. Q2 YES — `PROTOCOL_VERSION` 16 → 17, no fallback to `snapshot` for persistence.
3. Q3 YES — on a fork: adopt the daemon's lineage, set the laptop's divergent copy aside with a notice.
4. Q4 YES — per-entry `critical` (boolean, optional, default `false`): unknown + `critical:false` → skip; unknown + `critical:true` → refuse with a clear error; adding a `critical:true` type = `PROTOCOL_VERSION` bump.
5. Q5 **IN THIS TASK (owner overrode the recommendation)** — turn markers `turn_start` / `turn_end` / `call_started` are part of task 1's entry schema and are emitted by the daemon now (task 2 adds their disk reader / moves `cutHistory` to load).
6. Q6 YES — F2 = parent chain AND a lazy projection-digest `checkpoint` at turn end and after a compaction (mismatch → one cold read → reported, no loop).
7. Q7 YES — daemon retention = current segment + the previous one; a reader further behind gets `rebased` + `gap`.
8. Q8 YES — `/clear` excluded from keep-superseded.
9. Q9 YES — config key `sessions.keepSuperseded: boolean`, default `false` (compaction + context_reset), implemented in task 2.
10. Q10 YES — a real cluster run (`TENTACLE_K8S_SERVER`) is REQUIRED for Review sign-off; simulated-link numbers gate Execution.
11. Q11 YES — the title rides the log (`title` entry, non-critical).
12. Q12 YES — `serve` lineage across reloads deferred to task 3.
13. Q13 YES — one L task (fallback split point if Review finds it illegible: protocol+daemon / client+cli).
14. **Critical table (owner, 2026-11-07) — APPROVED, binding:** `critical: true` = `base`, `message`, `replace`, `truncate`; `critical: false` = `title`, `checkpoint`, `turn_start`, `turn_end`, `call_started`. **Owner rule: any new `critical` value (a new type, or changing one) is decided WITH the owner** — the executor must not add or change one on its own: write it as an owner question in the doc and keep the table above.
