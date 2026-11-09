# feat/subagent-ledger-log — the persistence contract of a background sub-agent (ledger + two log types + one load derivation)

> **Status:** implementation (awaiting approval)
> **Branch:** `feat/subagent-ledger-log` (off `main` @ `67a30eb`, tasks 1–4 merged)
> **Type:** feat · **Size:** M · **Blast:** load-bearing (AGENTS §7 persistence invariant, the shared log fold/load used by the laptop AND the `serve` reload, the wire `ChatMessage`) · **Suited:** strong model executes; mandatory fresh-context Review that red-teams persistence (segments, aside, idempotence, older-build skip)

Vocabulary (owner): **agent** = the main model; **subagent** = the child of an `agent_task` call.
Source: `docs/eval/subagent-live.md` task 5 (A4, A7, F12–F17), owner answers Q8–Q12, Opus review
M3 (+ L1, M4/M5 for what 6a owns).

## Context

*— claude-opus-5-5, 2026-11-09*

**Why.** Task 6a (`feat/subagent-background`) lets a subagent outlive its `agent_task` call. Its
report then re-enters later as a user-role note, like a shell job's exit. Two things in the log
are not enough today to survive a restart honestly (eval A4, "Finding 2"):
1. **A compaction / `context_reset` while a child runs.** The new segment's `base` restates only
   messages; the summary may drop the `started in background as sa-N` result, so after a
   restart nothing says sa-N existed.
2. **A child that ended but whose report was not delivered yet.** The exit sits in memory until
   the next turn starts or a wake runs; a process death in between loses the work product.

So this task lays the persistence seam, with **no process behind it yet** (nothing launches in
background until 6a):
- a pure, React-free **`AgentJobLedger`**: the state machine of a background child's durable
  facts (running → ended → delivered/lost), the `sa-N` counter, the set re-emitted at a segment
  start. The same transitions fold the live events and replay the log;
- two **NON-critical** log types, `subagent_background` and `subagent_end{report?}`;
- **one shared load derivation** (lost / undelivered / ended-without-report note, from the
  CURRENT segment only), used by the laptop's load AND the `serve` daemon's reload;
- a display-only **`note{kind, id?}`** field on `ChatMessage` (M3). The derivation keys on it
  (structural, idempotent), and `--resume` / a resync render such a message as a notice, not as a
  user row. Shell job exit notes get it too (M3's `background_exit`), the one user-visible change
  of this task.

**Owner decisions (binding).** Q8: both types non-critical (no `PROTOCOL_VERSION` bump). Q9:
markers + report only, no tool trail. Q10: the note is written at load, with no wake. Q11:
`subagent_end` carries the report, capped. Q12: moot (serve-store merged, `79ccf1b`). M3: the
`note` field. TODO `feat/clear-keeps-jobs` (owner 2026-11-09): `/clear` hands running jobs and
subagents to the NEW session. The ledger must make that easy, not harder (see Design §8).

**Corrections to the eval, found while verifying (each proven below):**
- **The payload cannot be called `id`.** Every log entry's ENVELOPE already has `id`
  (`"<inc>/<seq>"`, `protocol/src/session-log.ts:64`). The eval's `subagent_background{id, …}`
  would be overwritten by the envelope, and the probe showed exactly that: the first run gave TWO
  notes for one child (`inc-a/7`, `inc-a/8`). The field is **`agentId`**.
- **`note.kind` cannot be a closed enum on the wire.** `note` rides `message` entries, which are
  CRITICAL. A strip schema drops an unknown *field*, but a known field with an unknown *enum
  value* fails the parse. That makes the message entry malformed, and the whole log is refused
  (`session-log-file.ts:252-256`; the reader refuses the read). Tasks 8/9 add kinds
  (`user_to_subagent`, `subagent_message`), so an enum would lock out every older build. The kind is
  a bounded free string; an unknown kind renders as a plain notice.
- **The same holds for the new non-critical types.** A KNOWN type that fails its schema refuses
  the file (`:255-256`). Their fields stay lenient: `stopReason` is a bounded string, not
  `StopReasonSchema` (6a may add `killed`), and the length caps are enforced by the EMITTER (the
  ledger), never discovered by a reader.
- `PROTOCOL_VERSION` is **19** today (`protocol/src/version.ts:10`), not 17. This task does not
  change it; 6a bumps to 20 (the eval's "18" is stale).
- L1's "four segment-start sites": only TWO are segment starts (the constructor,
  `hosted-session.ts:533-543`, and `historyReplaced`, `:2083-2084`). `recordCut` (`:1213`) and
  `setTitle` (`:1939`) log the title but start no segment.

**Repro (2026-11-09, `main` @ `67a30eb`).** `bun .tentacle/tmp/subagent-ledger-log/probe.ts`. It
shows the capability is missing (`note` is stripped) and proves the load-bearing assumption (A–E):

```ts
// Probe for feat/subagent-ledger-log (claude-opus-5-5, 2026-11-09).
import { createHash } from "node:crypto";
import { ChatMessageSchema, canonicalMessage } from "../../../packages/protocol/src/index.ts";
import { applyLogRead } from "../../../packages/client/src/session-log-reader.ts";
import {
  currentSegment, headerLine, entryLines, parseLogFile, segmentFromMessages,
} from "../../../packages/daemon/src/session-log-file.ts";
import { SessionLog } from "../../../packages/daemon/src/session-log.ts";

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
const id = "11111111-2222-4333-8444-555555555555";
const inc = "inc-a";
const msgs = [
  { role: "system" as const, content: "sys" },
  { role: "user" as const, content: "go" },
  { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "agent_task", arguments: "{}" }] },
  { role: "tool" as const, toolCallId: "c1", content: "started in background as sa-1: map repo" },
  { role: "assistant" as const, content: "ok" },
];
const seg = segmentFromMessages(msgs, undefined, inc, 1);
let seq = seg.length;
const env = (body: Record<string, unknown>) => {
  seq++;
  return { ...body, seq, id: `${inc}/${seq}`, prev: `${inc}/${seq - 1}`, ts: 2 };
};
const bg = env({ type: "subagent_background", agentId: "sa-1", callId: "c1", agentType: "explore", description: "map repo" });
const end = env({ type: "subagent_end", agentId: "sa-1", stopReason: "end_turn", report: "R".repeat(10) });
const tailMsg = env({ type: "message", critical: true, message: { role: "user", content: "next" } });
const header = headerLine({ id, cwd: "/w", model: "m", createdAt: 1 });
const text = header + entryLines(seg) + [bg, end, tailMsg].map((e) => `${JSON.stringify(e)}\n`).join("");

console.log("— A. disk log, non-critical unknown types");
const a = parseLogFile(text, id);
if (!a.ok) throw new Error(a.reason);
const cs = currentSegment(a);
console.log(" ok:", a.ok, "skipped:", a.skipped, "segment.unknown:", cs.unknown, "lastId:", a.lastId);
console.log(" projection:", cs.messages.map((m) => m.role).join(","), "len", cs.messages.length);
const critText = header + entryLines(seg) + `${JSON.stringify({ ...bg, critical: true })}\n`;
const ac = parseLogFile(critText, id);
console.log(" critical variant ok:", ac.ok, ac.ok ? "" : ac.reason);

console.log("— B. client reader (wire), same entries");
const all = [...seg, bg, end, tailMsg] as never[];
const tip = { seq, id: `${inc}/${seq}` };
const b = applyLogRead(null, [{ entries: all, more: false, tip }], sha256);
if ("error" in b) throw new Error(b.error);
console.log(" kept types:", b.entries.map((e) => e.type).join(","));
console.log(" projection len:", b.state.messages.length);
const bc = applyLogRead(null, [{ entries: [...seg, { ...bg, critical: true }] as never[], more: false, tip: { seq: (bg as { seq: number }).seq, id: (bg as { id: string }).id } }], sha256);
console.log(" critical variant:", "error" in bc ? bc.error : "accepted?!");

console.log("— C. `note` field today");
const withNote = { role: "user", content: "[background] sub-agent sa-1 was lost", note: { kind: "subagent_lost", id: "sa-1" } };
const parsed = ChatMessageSchema.parse(withNote);
console.log(" parsed keys:", Object.keys(parsed).join(","), "(note stripped:", !("note" in parsed), ")");
const { note: _n, ...without } = withNote;
console.log(" canonicalMessage equal with/without note:", canonicalMessage(withNote as never) === canonicalMessage(without as never));

console.log("— D. a seed restates messages only");
const log = new SessionLog("inc-b", () => 3);
log.start([...msgs, { role: "user", content: "lost note" }], "seed", { seq, id: `${inc}/${seq}` });
const r = log.read(undefined, 1 << 20, sha256);
console.log(" seed entry types:", r.entries.map((e) => e.type).join(","));

console.log("— E. toy derivation keyed on note.id (load → seed → load)");
type M = { role: string; content: string; note?: { kind: string; id: string } };
const derive = (entries: readonly { type: string; id?: unknown }[], messages: readonly M[]): M[] => {
  const open = new Map<string, "bg" | "end">();
  for (const e of entries) {
    const x = e as Record<string, unknown>;
    if (x.type === "subagent_background") open.set(String(x.agentId), open.get(String(x.agentId)) ?? "bg");
    if (x.type === "subagent_end") open.set(String(x.agentId), "end");
  }
  const closed = new Set(messages.flatMap((m) => (m.note ? [m.note.id] : [])));
  return [...open].filter(([sid]) => !closed.has(sid)).map(([sid, s]) => ({
    role: "user",
    content: s === "bg" ? `[background] sub-agent ${sid} was lost` : `[background] sub-agent ${sid} finished`,
    note: { kind: s === "bg" ? "subagent_lost" : "subagent_report", id: sid },
  }));
};
const rawEntries = [...seg, bg, end, tailMsg] as { type: string }[];
const load1 = derive(rawEntries, cs.messages as M[]);
const load1b = derive(rawEntries, cs.messages as M[]);
console.log(" load #1 notes:", load1.length, load1.map((n) => n.note?.kind).join(","), "| load #1 again (nothing written):", load1b.length);
const seeded = [...(cs.messages as M[]), ...load1];
const segAfterSeed = [{ type: "base" }, ...seeded.map(() => ({ type: "message" }))];
console.log(" load #2 on the seed's segment:", derive(segAfterSeed, seeded).length);
console.log(" load #2 on the old segment + appended note:", derive(rawEntries, seeded).length);
const onlyBg = [...seg, bg] as { type: string }[];
console.log(" bg without end → kind:", derive(onlyBg, msgs as M[]).map((n) => n.note?.kind).join(","));
const endOnly = [...seg, end] as { type: string }[];
console.log(" end without bg (pair lost) → kind:", derive(endOnly, msgs as M[]).map((n) => n.note?.kind).join(","));
```

Output:

```
— A. disk log, non-critical unknown types
 ok: true skipped: 2 segment.unknown: 2 lastId: inc-a/9
 projection: system,user,assistant,tool,assistant,user len 6
 critical variant ok: false line 8 is a critical entry of a type this build does not know (subagent_background): update tentacle
— B. client reader (wire), same entries
 kept types: base,message,message,message,message,message,message
 projection len: 6
 critical variant: the daemon's log has a critical entry of a type this build does not know (subagent_background): update tentacle
— C. `note` field today
 parsed keys: role,content (note stripped: true )
 canonicalMessage equal with/without note: true
— D. a seed restates messages only
 seed entry types: base,message,message,message,message,message,message
— E. toy derivation keyed on note.id (load → seed → load)
 load #1 notes: 1 subagent_report | load #1 again (nothing written): 1
 load #2 on the seed's segment: 0
 load #2 on the old segment + appended note: 0
 bg without end → kind: subagent_lost
 end without bg (pair lost) → kind: subagent_report
```

The first run used the eval's payload name `id`. It printed `load #1 notes: 2 subagent_lost,subagent_report` for ONE child, because the envelope `id` overwrote the payload. That is the `agentId` correction above.

## Implementation

*— claude-opus-5-5, 2026-11-09*

### Load-bearing assumption

**Once a message with `note.id = sa-N` is in the history, it closes sa-N for every later load, by
itself. The markers never travel past a segment start, and the message does.** So the derivation
`notes = open markers of the current segment − ids closed by a note in the messages` is
idempotent. Load twice gives the same notes (the load writes nothing). After the next persist,
the seed or appended segment holds the note, so the next load gives none.

Proven by the probe (Repro):
- **D**: a seed (`SessionLog.start(…, "seed", from)`) emits `base` + `message` entries only. No
  marker is restated. The `serve` reload is the same shape: `log.start(restored.log.logged,
  "reload", …)` then `log.commit(session.messages, …)`, so repair notes become ordinary
  `message` entries (`hosted-session.ts:528-534`).
- **E**: the toy derivation gives 1 note → 1 (load again) → 0 (seed segment) → 0 (old segment +
  appended note).
- **C**: the message survives only once `note` is in the wire schema. Today it is STRIPPED
  (`ChatMessageSchema`, `protocol/src/session.ts:34-52`: strip object), so this task must add it.
  `canonicalMessage` ignores it (`protocol/src/session-log.ts:279-292`, a fixed field list),
  so a checkpoint digest is unchanged, and builds with and without the field agree.
- **A/B** (Q8 holds): a build that does not know the types SKIPS them with the projection
  unchanged, on disk (`session-log-file.ts:236-247`, `skipped: 2`) and on the wire
  (`session-log-reader.ts:254-260`). A `critical: true` variant is refused by both, which is why
  they must stay non-critical.

### Preconditions (verified on `67a30eb`)

| # | Fact | Where |
|---|---|---|
| P1 | The v1 critical table is a `Record<LogEntryType, boolean>`: a new type without a value is a type error; non-critical needs no bump | `protocol/src/session-log.ts:12-18,181-191` |
| P2 | `projectEntry`'s default branch leaves non-projection types alone | `protocol/src/session-log.ts:226-227` |
| P3 | Disk parse: unknown non-critical → skipped + counted; unknown critical → refused; a KNOWN type that fails its schema → refused | `daemon/src/session-log-file.ts:236-256` |
| P4 | `LogSegment.entries` holds the segment's known, schema-parsed entries (what the derivation folds) | `session-log-file.ts:58-74,300` |
| P5 | Laptop load = `currentSegment` + `closeAtLoad`; the only laptop load site (`--resume`, `/sessions`, attach seed) | `session-log-store.ts:947-981` (`summarize` `:1087-1088` is the listing; it does not need notes) |
| P6 | The load already APPENDS messages (the cut-turn notes) and the seed of a closed projection is a superset → no aside | `session-log-file.ts:426-432`; laptop-store FM 13 (`docs/feat/session-log-laptop-store.md:492`) |
| P7 | `serve` reload: `rebuild` folds THROUGH the sidecar's `logHead` (paired) or uses the last segment (unpaired) → `reconcileOnReload` → `SessionHost.restore` → `HostedSession` | `daemon-state-file.ts:351-408`; `persisted-session.ts:370-428`; `session-host.ts:756-781` |
| P8 | A resumed turn (suspended on its own call's permission) keeps the history UNTOUCHED: it ends on an assistant message with unanswered calls, so nothing may be appended after it | `persisted-session.ts:323-381`; the agent flushes notes only after a resumed round (`agent.ts:810-816`) |
| P9 | Provider mappers copy message fields one by one, so a new display field never reaches the model | `providers/src/openai-provider.ts:282`; `anthropic-provider.ts:385,395` |
| P10 | Display-only `ChatMessage` fields have precedent (`spill`, `durationMs`, `denialReply`) | `core/src/model.ts:35-52` |
| P11 | Segment starts in `HostedSession`: constructor `:527-543`, `historyReplaced` `:2083-2084`; `recordCut` commits new messages `:1201-1214`; `callStarted` is the pattern for a marker pushed in a synchronous stretch `:1671` | `daemon/src/hosted-session.ts` |
| P12 | `SessionLog` marker methods are one `push` each | `daemon/src/session-log.ts:131-141,301` |
| P13 | `--resume` and a history resync both render through `messagesToItems`; a user-role message becomes a user row today | `tui/src/resume.ts:18-33`; `tui/src/state.ts:525`; `run.tsx:132` |
| P14 | Shell exit notes are user-role messages built in one place | `agent/src/agent.ts:1837-1857` (`:1853`) |
| P15 | Pod daemons and the in-process worker never persist; the laptop writes only the entries its reader validated and re-serialized | AGENTS §7; `session-log-reader.ts:129-135` |
| P16 | `core` already depends on `protocol`, and `agent`/`daemon` on `core`, so a ledger in `core` is importable by 6a's registry (agent) and by `HostedSession` (daemon) | `packages/core/package.json`, `agent/package.json`, `daemon/package.json` |

### Design

#### 1. Protocol (the shared truth)

`protocol/src/session.ts`: `ChatMessageSchema` gains

```ts
/** Display only (docs/feat/subagent-ledger-log.md): what kind of tentacle-written note this is. */
note: z.object({
  kind: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/), // free: tasks 8/9 add kinds
  id: z.string().min(1).max(64).optional(),                    // "sa-3", a job id
}).optional(),
```

It stays OUT of `canonicalMessage`, so the digest is unchanged and no version skew trips a
checkpoint. Known kinds are constants in core (`background_exit`, `subagent_report`,
`subagent_lost`), never a schema enum.

`protocol/src/session-log.ts`: two non-critical types (`...skippable()`):

| `type` | Payload (lenient, caps enforced by the emitter) |
|---|---|
| `subagent_background` | `agentId: string(1..64)`, `callId: string(1..256)`, `agentType: string(1..128)`, `description: string(0..SUBAGENT_DESCRIPTION_MAX_CHARS=512)` |
| `subagent_end` | `agentId`, `stopReason: string(1..64)`, `report?: string(0..SUBAGENT_REPORT_MAX_CHARS=64 KiB)` |

Both join `KnownLogEntrySchema` and `LOG_ENTRY_CRITICAL` (`false`). `projectEntry` is untouched
(default branch). The module comment's table lists them. **No `PROTOCOL_VERSION` change** (P1, Q8).

#### 2. Core: `ChatMessage.note` + the pure `AgentJobLedger` (`core/src/agent-job-ledger.ts`, new)

`core/src/model.ts`: `readonly note?: MessageNote` (`{kind: string; id?: string}`), documented
display-only like `spill`.

The ledger is React-free, IO-free and clock-free. ONE set of transitions serves the live path
(6a) and the replay (load):

```ts
export interface AgentJob { agentId; callId; agentType; description;
  state: "running" | "ended"; stopReason?: string; report?: string }
export class AgentJobLedger {
  /** Counter seeded from a history: 1 + the highest N of any `note.id` "sa-N" and of `\bsa-(\d+)\b` in content. */
  static fromHistory(messages: readonly ChatMessage[]): AgentJobLedger;
  nextId(): string;                                        // "sa-N", never reused
  background(j: {agentId, callId, agentType, description}): SubagentBackgroundBody | null; // null: id known (dup)
  end(agentId, stopReason, report?): SubagentEndBody | null;  // null: unknown id or already ended (dup/late: first wins)
  noteSeen(note: MessageNote): void;                       // subagent_report/subagent_lost with id → job closed (removed)
  segmentFacts(): (SubagentBackgroundBody | SubagentEndBody)[]; // re-emission set: running → [bg]; ended → [bg, end]
  running(): readonly AgentJob[];                          // H2 liveness, M7 quit count, /clear hand-over
  handOver(): AgentJob[];  adopt(jobs: readonly AgentJob[]): void; // feat/clear-keeps-jobs (§8)
  loadNotes(): ChatMessage[];                              // every job still in the ledger, as its note
}
/** THE load derivation (laptop load + serve reload): replay the segment's markers, close the ids noted in `messages`, return the notes to append. */
export function subagentLoadNotes(entries: readonly KnownLogEntry[], messages: readonly ChatMessage[]): ChatMessage[];
/** Shared text builders: 6a's live exit note uses the SAME one, so live and load read alike. */
export function subagentReportNote(job: AgentJob): ChatMessage;  // note{kind:"subagent_report", id}
export function subagentLostNote(job: AgentJob): ChatMessage;    // note{kind:"subagent_lost", id}
```

- `end` caps `report` at `SUBAGENT_REPORT_MAX_CHARS` (head + tail, with a `[… N chars cut]` line)
  and `description` at its cap, so the log never holds a value a reader must refuse (P3).
- `subagentLoadNotes` builds a ledger, replays each `subagent_*` entry through `background`/`end`,
  calls `noteSeen` for every `messages[i].note`, and returns `loadNotes()`. The notes come in
  ledger insertion order (bg order; an `end` without its `bg` is inserted at its `end`).
- Note texts (user-role, model-visible):
  - lost: `[background] sub-agent sa-N (<description>) was lost: the session restarted before it finished. Its partial work may have had side effects; check before redoing it.`
  - undelivered: `[background] sub-agent sa-N (<description>) finished (<stopReason>) before the session restarted:\n<report>`
    (exactly `subagentReportNote`, so 6a's live text differs only by its first-line wording, which the builder takes as a parameter);
  - ended without a report: `[background] sub-agent sa-N (<description>) ended (<stopReason>) before the session restarted; it left no report.`;
  - an `end` without its `bg` (the pair lost): the same texts, with `sub-agent sa-N` (no description).

#### 3. The load derivation, wired at BOTH load sites (current segment only)

- **Laptop** (`session-log-store.ts:967-968`): `const closed = closeAtLoad(segment); const
  messages = [...closed, ...subagentLoadNotes(segment.entries, closed)]`. Superseded segments
  are never read (F14). `summarize` (the listing) is unchanged; its count is short by the notes
  until the resume, which is harmless.
- **`serve` reload**: `session-log-file.ts` gains `entriesThrough(parsed, head)`, sharing
  `foldThrough`'s find loop: the segment's entries up to and including `head`. `rebuild`
  (`daemon-state-file.ts:363-385`) computes `loadNotes = subagentLoadNotes(paired ?
  entriesThrough(…) : currentSegment(parsed).entries, messages)` over the FINAL messages (logged
  prefix + sidecar tail: a note delivered after the last log write is in the tail and closes its
  id). `DaemonSessionRecord` gains `loadNotes: readonly ChatMessage[]`.
  `reconcileOnReload` appends them after its repair (closed turn) or as is (no turn). They then
  become ordinary `message` entries of the reload segment (P7, `hosted-session.ts:533-534`).
  **A resumed turn** cannot take an appended note (P8). By the recommended answer to owner Q1,
  `resumableTurn` returns `undefined` when `record.loadNotes.length > 0`: the turn is closed
  honestly ("interrupted: the daemon restarted") and the notes are appended. This only happens
  with a background child open at the crash, so it cannot happen before 6a.
- Neither load writes. The notes ride the seed / the reload segment, and the next persist makes
  them durable (P6).

#### 4. Daemon: `SessionLog` methods + `HostedSession` hooks (the seam 6a calls)

`SessionLog` (`session-log.ts`, next to `callStarted`): `subagentBackground(body)` and
`subagentEnd(body)`, one `push` each.

`HostedSession`:
- owns `private readonly agentJobs = AgentJobLedger.fromHistory(session.messages)`. It is
  session-level, so it survives `swapAgent` (F11) like `jobs`;
- `logSegmentFacts()` (L1) = `log.title(wireTitle())` + one entry per `agentJobs.segmentFacts()`.
  It replaces the title call at the two segment starts (`:543`, `:2084`). With an empty ledger it
  is exactly today's behaviour;
- `recordCut` (`:1201-1214`): after `log.commit`, every NEW committed message (`[oldCut,
  newCut)`) with a `note` → `agentJobs.noteSeen(note)`. This is synchronous and O(new), with no
  `await` in the steering window. Delivery is therefore structural: whoever pushes the note
  closes the job;
- **the two methods 6a calls** (synchronous, no `await`, like `callStarted`):
  - `backgroundAgent({callId, agentType, description}): string`: `nextId` → `background` → `log.subagentBackground`. It returns `sa-N` for the tool result (`started in background as sa-N …`).
  - `agentEnded(agentId, stopReason, report?)`: `end` → `log.subagentEnd` (a `null` from `end` logs nothing: a duplicate or late end), then `this.persist()`, as `setTitle` does (`:1937-1940`). A child may end while idle, and the report must reach disk now (on `serve`; on a pod, M5's laptop flush is 6a's).
  - plus a read-only `agentJobsRunning()` for 6a's H2 liveness and M7 quit count.

6a builds its live exit note with `subagentReportNote`, pushes it through its exit path, and
emits the markers via these two methods. It needs nothing else from this task.

#### 5. Agent: shell exit notes carry `note` (M3 `background_exit`)

`agent.ts:1853`: `messages.push({role: "user", content: note, note: {kind: "background_exit",
id: job.id}})`. The model sees the same `content` (P9).

#### 6. TUI: a noted message renders as a notice (pure, `resume.ts`)

`messagesToItems` (`resume.ts:26-33`): a user-role message with `note` becomes `{kind:
"notice", text: <first line>, body?: <the rest>, noteKind}` instead of a user row. The text is the
note's first line; for `subagent_report` the report is the `body`. An unknown kind becomes a plain
notice of the first line. `NoticeItem` (`state.ts:43-49`) gains `body?: string`; `render-lines.ts`
draws `body` under the text only when `expandAll` (Ctrl+O), else it appends `EXPAND_HINT`
(`tool-expand.ts`). This is presentation only, and the decision lives in the pure
`messagesToItems`.

#### 7. What does NOT change

- Rendering-only data stays unpersisted (Q9): `tool_progress`, the tail, the child's history.
- No wake at load (Q10): the notes are history messages, not pending exits, so `pendingExitCount`
  is untouched (`agent.ts:548-549`).
- No new update, no new method, no version bump.

#### 8. `/clear` hand-over (`feat/clear-keeps-jobs`), in one line

The old session's `agentJobs.handOver()` gives the running/ended-undelivered jobs, and the new
`HostedSession` `adopt()`s them before its first segment. Its `logSegmentFacts()` then re-emits
their markers in the new log, so the new session's load contract covers them with no new code.
(The counter needs no hand-over: an adopted id is reserved by `adopt`.)

### Files (dependency order)

1. `packages/protocol/src/session.ts`: `note` on `ChatMessageSchema`.
2. `packages/protocol/src/session-log.ts`: two schemas, union, critical table, caps exported, module comment.
3. `packages/core/src/model.ts`: `MessageNote`, `ChatMessage.note`.
4. `packages/core/src/agent-job-ledger.ts` (new) + `packages/core/src/index.ts` export.
5. `packages/agent/src/agent.ts`: `note` on the shell exit note (one line).
6. `packages/daemon/src/session-log.ts`: `subagentBackground`, `subagentEnd`.
7. `packages/daemon/src/session-log-file.ts`: `entriesThrough` (shares `foldThrough`'s loop).
8. `packages/daemon/src/session-log-store.ts`: notes in `load()`.
9. `packages/daemon/src/daemon-state-file.ts`: `loadNotes` in `rebuild`; `persisted-session.ts`: `DaemonSessionRecord.loadNotes`, append in `reconcileOnReload`, the Q1 guard in `resumableTurn`.
10. `packages/daemon/src/hosted-session.ts`: ledger, `logSegmentFacts`, `noteSeen` in `recordCut`, `backgroundAgent` / `agentEnded` / `agentJobsRunning`.
11. `packages/tui/src/state.ts` (`NoticeItem.body`), `resume.ts`, `render-lines.ts`.
12. Docs: `AGENTS.md` §7 persistence: add "sub-agent lifecycle markers and a finished sub-agent's report" to the persisted typed facts (owner Q2); the type table in `docs/feat/session-log.md` §5; `CHANGELOG.md` (line below).

No `client`/`cli` change: the reader keeps known types by the table (P15), and the laptop
writes `back.entries` as they are.

**CHANGELOG (planned line, `### Changed`):** "**Background job notices stay notices after a
resume.** The `[background] job N … finished` note the agent received now shows as a dimmed
notice when you `--resume` a session (or a terminal resyncs), not as a message you typed." (The
sub-agent notes become visible with 6a, which writes the first markers.)

### Failure modes (each: how state converges)

| # | Case | Converges to |
|---|---|---|
| 1 | **Crash between entries**: `bg` logged, the tool result not yet committed | The open turn is closed at load (`closeAtLoad`: the call is "Interrupted") and sa-N gets the lost note. The model sees both, consistently |
| 2 | Crash after `end{report}`, before the note | Undelivered → the report note at load, with no wake (Q10). Exactly once: the first note never landed |
| 3 | Crash after the note was pushed, before its log write landed | The same as 2 (the note is absent on disk): one note. If it landed, it closes the id: no note |
| 4 | **Entry without its pair**: `bg` only | Lost note |
| 5 | `end` only (its `bg` in a superseded segment, re-emission missing) | The report note (or "ended … no report") without a description. The work product is never dropped |
| 6 | A note without markers | Nothing (closed, nothing open) |
| 7 | **Duplicate / late `end`** (live) | `ledger.end` → `null`, nothing logged; first wins |
| 8 | Duplicate `end` / `bg` in one segment (replay: forged or re-emitted) | First wins; one note per id |
| 9 | **Older build** (pre-task-5) reads a log with markers | Skipped and counted, projection intact (probe A/B). It cannot derive the notes: the resumed model is told nothing, which is today's behaviour. A REPLACE by it sets the unknown lines ASIDE (laptop-store Q2), never dropped |
| 10 | Older build reads a `note` field | Stripped (probe C): the message renders as a user row again, digest unaffected |
| 11 | A task-5 build reads a newer `note.kind` / newer `stopReason` | Free strings: parsed. An unknown kind renders as a plain notice |
| 12 | **Compaction / `context_reset`** while a job is open | `logSegmentFacts` re-emits `bg` (+ `end`) at the new `base` (6a populates the ledger; tested here with a seeded ledger). Only the LAST segment is derived (F14); a superseded segment's open `bg` is never a loss |
| 13 | `keepSuperseded` on, the old segment holds an open `bg` and the new one its re-emission + note | Current segment: closed. The superseded one is never read |
| 14 | **Pod** (never persists) | The pod daemon emits markers; the laptop keeps them after validation (P15) and derives at its own load. A report that ended after the laptop's last read is gone with the pod (eval A4; M5's flush is 6a's) |
| 15 | Hostile pod forges `bg` / `end{report}` | Schema-valid, capped (64 KiB) text injected at load. This is the same class as a forged `message` entry, accepted (eval F16; AGENTS §7 "a pod is not trusted") |
| 16 | Hostile pod sends an over-cap report | The KNOWN type fails its schema, so the reader refuses the read (`session-log-reader.ts`). This is the existing behaviour for any malformed entry: retried cold, then reported |
| 17 | `serve` reload: markers after the sidecar's `logHead` (a write whose sidecar did not land) | Ignored, as the whole tail is (AGENTS §7: "reads the log only up to the entry the sidecar names"). A report in that window reads "lost". The window is one write |
| 18 | `serve` reload with a resumable turn AND notes | Q1 (a): the turn is closed, the notes are appended. (b) is listed in Q1 |
| 19 | Archived `serve` session | Derived only at its explicit `reopen` (it goes through `restore`), never at close (eval F10) |
| 20 | **Id reuse** after a load | `fromHistory` seeds the counter from note ids AND `sa-N` in text (the `started in background as sa-N` result), so a new child never takes an id the model has seen. A user typing "sa-900" only skips numbers |
| 21 | **Report size** | Capped by the ledger before logging (head + tail + `[… N chars cut]`). The note built at load carries the capped copy; a spilled report's preview already points at the spill file |
| 22 | Empty history / no markers | `subagentLoadNotes` → `[]`; load output is byte-identical to today |

### Tests (red before green; existing fakes and seams)

Red = on `main` the capability is missing (the line is skipped, or `note` is stripped), so each
test below fails there. Mutations are run once by the executor and recorded in Execution.

- `protocol/test/session-log.test.ts`: the critical-table pin gains both types (`false`). The
  schemas accept `agentId`/`stopReason: "killed"` (a future reason) and refuse an over-cap report.
  The payload's `agentId` survives next to an envelope `id`.
- `protocol/test/…` (session or session-log): `note` parses with an UNKNOWN kind (forward
  compat); `canonicalMessage` with and without `note` is equal (the existing fixed vector is
  unchanged). *Mutation: add `note` to `canonicalMessage` → red.*
- `core/test/agent-job-ledger.test.ts` (new): transitions; dup/late `end` → `null`; `noteSeen`
  closes; `segmentFacts` (running → bg; ended → bg+end; delivered → none); `fromHistory` counter
  (note ids, text, none → `sa-1`); report/description caps; `subagentLoadNotes` cases FM 1–8, 22;
  **idempotence**: notes(entries, msgs) = notes(entries, msgs), and notes(entries, msgs + notes)
  = `[]`. *Mutation: skip `noteSeen` → the idempotence test is red.*
- `daemon/test/session-log-store.test.ts` (laptop load, real files under a temp dir): an open
  `bg` → `load()` ends with the lost note (red on main: skipped). Load twice → one note each,
  file bytes unchanged. A note already present → none. An open `bg` in a SUPERSEDED segment only
  → none. *Mutation: derive over all segments → red.* An open turn + an open `bg` → the
  cut-turn notes, then the lost note.
- `daemon/test/session-log-file.test.ts`: `entriesThrough` = `foldThrough`'s segment, cut at
  `head`; `null` cases match.
- `daemon/test/…` serve reload (the existing `daemon-state-file` / `session-host` restore tests):
  a paired record with an open `bg` before `logHead` → the restored history ends with the note,
  and the reload segment's log has it as a `message` entry. A marker after `logHead` → ignored
  (FM 17). A resumable turn + an open `bg` → closed, with the notes appended (Q1). Without notes,
  the same turn is still resumed (no regression of suspended-turn-resume).
- `daemon/test/hosted-session…` (real `HostedSession`, as the session-log review's `markers.ts`):
  `backgroundAgent` returns `sa-1`, `sa-2` and logs `subagent_background`. `agentEnded` logs
  `subagent_end` once (a second call logs nothing) and persists (spy persister). A committed note
  → `noteSeen`, and the next compaction re-emits nothing for it. A running job → `historyReplaced`
  re-emits its `bg` right after the new `base` + title. *Mutation: drop `logSegmentFacts` at
  `historyReplaced` → red.*
- `client/test/session-log-reader.test.ts`: the new types are KEPT (validated, re-serialized:
  an extra field is stripped). An over-cap report refuses the read.
- `agent/test/…` (an existing background-exit test): the shell exit note carries
  `note{background_exit, id}`, and its `content` is unchanged.
- `tui/test/resume.test.ts` (pure): a noted user message → a notice (not a user row); the report
  is the `body`; an unknown kind → a plain notice. One `app.test.tsx` frame: a resumed note shows
  collapsed with the hint, and Ctrl+O shows the body.
- Gate before done: `bun run check` (typecheck → lint, baseline clean → full `bun test`, opt-in
  skips only).

### Owner questions (all, at once)

**Q1. A `serve` reload finds a turn it could resume (suspended on its own call's permission) AND a
lost/undelivered sub-agent note to add.** The note cannot go after that turn's unanswered calls
(an invalid history).
(a) close that turn instead of resuming it, honestly ("interrupted: the daemon restarted"), and
append the notes; the user re-asks;
(b) resume the turn and hold the notes in a new agent seam ("pending notes", flushed after the
resumed round, not counted for wakes), with the markers re-emitted until delivered.
**Recommend (a):** a few lines in `resumableTurn`, no agent-loop change. It only happens when a
background sub-agent was running at the crash, and that child's death already changes the turn's
premises. (b) is a load-bearing agent seam for a rare case. It can be added later without a
format change.

**Q2. AGENTS §7 wording.** The persistence bullet lists what is persisted ("`ChatMessage`s and
the log's typed facts about them (turn/call markers, title, checkpoints)"). OK to add
"sub-agent lifecycle markers (with a finished sub-agent's report)" in this task's branch?
(a) yes; (b) no, keep §7 as is and document the types only in `docs/feat/session-log.md`.
**Recommend (a):** §7 is the list a reviewer checks "is this rendering-only?" against. The report
is model-visible content, not rendering, so it belongs there.

**Owner answers (2026-11-09):** Q1 **(a)** — close the resumable turn honestly and append the notes. Q2 **(a)** — add the sub-agent lifecycle markers (with a finished sub-agent's report) to AGENTS §7's persistence bullet, in this branch.

## Execution

*— deepseek-v4.1-flash (tentacle), 2026-11-09*

**Verdict: DONE** for every item the plan assigns to this task. The plan's own order was
followed; the drifts are listed below and none of them changes a contract.

### As built, in order

| # | File | What |
|---|---|---|
| 1 | `packages/protocol/src/session.ts` | `ChatMessageSchema.note{kind, id?}`: `kind` a bounded FREE string (never an enum: the message entry is CRITICAL, so an unknown value would refuse the whole log), `id` optional. |
| 2 | `packages/protocol/src/session-log.ts` | `SUBAGENT_DESCRIPTION_MAX_CHARS` (512) / `SUBAGENT_REPORT_MAX_CHARS` (64 KiB); `LogSubagentBackgroundEntrySchema` (`agentId, callId, agentType, description`) and `LogSubagentEndEntrySchema` (`agentId, stopReason` free string, `report?`); both in `KnownLogEntrySchema` and `LOG_ENTRY_CRITICAL` as `false`; module comment + the critical-table comment updated. **No `PROTOCOL_VERSION` change** (still 19). |
| 3 | `packages/core/src/model.ts` | `MessageNote`, `ChatMessage.note`, and the `NOTE_KIND` constants (`background_exit`, `subagent_report`, `subagent_lost`). |
| 4 | `packages/core/src/agent-job-ledger.ts` (new) | `AgentJobLedger` (`fromHistory`, `nextId`, `background`, `end`, `noteSeen`, `segmentFacts`, `running`, `handOver`, `adopt`, `loadNotes`), `capText`, `subagentLostNote`, `subagentReportNote`, and `subagentLoadNotes` (THE load derivation). Exported from `core/src/index.ts`. |
| 5 | `packages/agent/src/agent.ts:1853` | The shell exit note carries `note{kind: "background_exit", id: job.id}`; `content` unchanged. |
| 6 | `packages/daemon/src/session-log.ts` | `SessionLog.subagentBackground` / `.subagentEnd`, one `push` each. |
| 7 | `packages/daemon/src/session-log-file.ts` | `entriesThrough(parsed, head)` — `foldThrough`'s find loop extracted and shared by both. |
| 8 | `packages/daemon/src/session-log-store.ts` | `load()`: `[...closeAtLoad(segment), ...subagentLoadNotes(segment.entries, closed)]`. `summarize` deliberately unchanged. |
| 9 | `packages/daemon/src/daemon-state-file.ts` | `rebuild`: `derivedFrom` = `entriesThrough` when paired, else the last segment; `loadNotes = subagentLoadNotes(derivedFrom, messages)` over the FINAL messages; `DaemonSessionRecord.loadNotes` added. `session-persister.ts` (`toRecord`) sets `loadNotes: []` (a live session's notes were applied at its reload). |
| 10 | `packages/daemon/src/persisted-session.ts` | `DaemonSessionRecord.loadNotes`; `reconcileOnReload` appends them (after a closed turn's repair, or as is with no turn); `resumableTurn` returns `undefined` when `loadNotes.length > 0` — **owner Q1 (a)**. |
| 11 | `packages/daemon/src/hosted-session.ts` | `agentJobs = AgentJobLedger.fromHistory(session.messages)`; `logSegmentFacts()` replaces the bare `log.title` at BOTH segment starts (constructor `:556`, `historyReplaced` `:2097`); `recordCut` calls `agentJobs.noteSeen` for every newly committed message with a `note`; the seam `backgroundAgent` / `agentEnded` / `agentJobsRunning`. |
| 12 | `packages/tui/src/{state,resume,render-lines}.ts` | `NoticeItem.body` + `noteKind`; `messagesToItems` maps a noted user message to a notice (first line = text, rest = body); `noticeLines` draws the body only when expanded, else `EXPAND_HINT`; the item cache keys `expandAll` for a notice with a body. |
| 13 | Docs | `AGENTS.md` §7 (owner Q2 (a)), `docs/feat/session-log.md` §5b + the item-14 table note, `CHANGELOG.md` `[Unreleased] ### Changed`. `TODO.md` untouched, as instructed. |
| 14 | `packages/protocol/schema/protocol.json` | Regenerated by `bun run schema:export` (the drift gate in `protocol/test/json-schema.test.ts`). |

### Drift from the plan (and why)

1. **`AgentJobLedger.end` records an end without its `bg` (the plan's signature says `null`).** The
   plan's semantic line ("`null`: unknown id") contradicts its own FM 5 and Design §2 ("an `end`
   without its `bg` … the same texts, with `sub-agent sa-N`"): a `null` there would drop the work
   product, which FM 5 forbids. Implemented as: an unknown id creates an ORPHAN job (`callId: ""`)
   and returns the `end` body; a null is returned only for a DUPLICATE/late end (`state ===
   "ended"`), which is FM 7/8. A `bg` for the same id arriving in a later segment is not adopted
   over the orphan (first wins). **Consequence: `segmentFacts()` skips the `background` of an
   orphan** — `subagent_background.callId` is `min(1)`, so re-emitting it would produce a
   malformed KNOWN entry and a reader would refuse the whole log. Test:
   `agent-job-ledger.test.ts` "an ORPHAN `end` …".
2. **`AgentJobLedger` gained no `jobs` accessor.** The plan lists none; `handOver` returns the
   open jobs, which is what `feat/clear-keeps-jobs` needs. Nothing else reads the map.
3. **`subagentReportNote(job, headline?)`** — the plan says the builder "takes its first-line
   wording as a parameter" for 6a; implemented as an optional `headline`.
4. **`DaemonSessionRecord.loadNotes` is REQUIRED (not optional).** The plan does not say which.
   Required forces every producer (`rebuild`, `toRecord`, the test fixtures) to be explicit — the
   safe direction for a field a reload appends. Fixture types default it (`daemon-store-spy.ts`).
5. **`render-lines.ts` also had to make the row cache notice-aware** (`expandMatters`), else a
   Ctrl+O flip would keep the cached collapsed rows. Not in the plan; strictly necessary.
6. **The serve-reload derivation falls back to the last segment's entries** when
   `entriesThrough` returns `null` (the pair is unprovable). The plan describes only the paired
   case; the unpaired path must derive from the same segment its history came from.
7. **`packages/protocol/schema/protocol.json` regenerated** (`bun run schema:export`): the drift
   gate in `protocol/test/json-schema.test.ts` fails otherwise. The plan does not list it.
8. **Two pre-existing tests needed the new field**: `daemon/test/persistence.test.ts` (two
   record literals) and `daemon/test/session-list.test.ts` (one) gained `loadNotes: []`; the
   `Fixture` type in `support/daemon-store-spy.ts` omits it. Pure type plumbing.

### Red / green

**RED, on `main`'s sources** (each source file reverted to `HEAD` with `git show`, its new test
run, the file restored and its sha256 checked — `.tentacle/tmp/subagent-ledger-log/red.sh`):

```
===== RED: packages/protocol/src/session.ts reverted to HEAD
error: expect(received).toEqual(expected)
(fail) ChatMessage.note > a note parses with an UNKNOWN kind and an id — forward compatible, never an enum
error: expect(received).toBe(expected)   Expected: false  Received: true
(fail) ChatMessage.note > a malformed note is refused: a bad kind, an over-long id, …
 19 pass  2 fail                                    restored packages/protocol/src/session.ts: SHA-OK

===== RED: packages/protocol/src/session-log.ts reverted to HEAD
SyntaxError: Export named 'SUBAGENT_DESCRIPTION_MAX_CHARS' not found in module .../index.ts
 0 pass  1 fail                                     SHA-OK   (capability absent: the types do not exist)

===== RED: packages/tui/src/resume.ts reverted to HEAD
error: expect(received).toMatchObject(expected)
(fail) messagesToItems > a NOTED user message becomes a notice, not a row the person typed
Received: "› [background] sub-agent sa-1 (map) finished (end_turn):\n  THE REPORT"
(fail) messagesToItems > the body shows only when expanded (Ctrl+O); collapsed, …
 7 pass  3 fail                                     SHA-OK

===== RED: packages/agent/src/agent.ts reverted to HEAD
error: expect(received).toEqual(expected)
(fail) background-job exit trigger > surfaces a finished job at the next turn and injects a note
 2 pass  1 fail                                     SHA-OK

===== RED: packages/daemon/src/session-log-file.ts reverted to HEAD
(fail) entriesThrough (…)> the segment's entries from its base THROUGH `head` …
 0 pass (export missing)                            SHA-OK

===== RED: packages/daemon/src/session-log-store.ts reverted to HEAD
error: expect(received).toEqual(expected)
(fail) … > an open `bg` becomes the lost note at load; loading twice gives ONE note each time …
(fail) … > an open turn's repair comes first, then the lost note (both appended, order kept)
 29 pass  2 fail                                    SHA-OK

===== RED: packages/daemon/src/daemon-state-file.ts reverted to HEAD
(fail) serve reload … > an open `bg` before `logHead` becomes a load note, appended by reconcileOnReload
error: expect(received).toEqual(expected)  Expected: []  Received: undefined
(fail) FM 17: a marker AFTER the sidecar's `logHead` is ignored
(fail) a note in the sidecar's TAIL closes its id
 0 pass  3 fail                                     SHA-OK

===== RED: packages/daemon/src/persisted-session.ts reverted to HEAD
error: expect(received).toBeUndefined()  Received: { turnId: "T", … }
(fail) persisted-session (pure) > Q1 (a): a resumable turn with a sub-agent note … is CLOSED
 114 pass  1 fail                                   SHA-OK

===== RED: packages/daemon/src/hosted-session.ts reverted to HEAD
TypeError: hosted.backgroundAgent is not a function
(fail) … > backgroundAgent hands out sa-1, sa-2 and logs `subagent_background` for each
(+ the rest of the seam tests)                       SHA-OK
```

Four of the groups are red on a *missing export/symbol* rather than on an assertion (a brand-new
module, or a method that does not exist, cannot even be reached on `main`: `entriesThrough`,
`backgroundAgent`/`agentEnded`/`agentJobsRunning`, the `SUBAGENT_*` caps, the `AgentJobLedger`). That is the capability-missing RED the plan predicts
("the line is skipped, or `note` is stripped"); the assertion-level proof for those groups is the
mutation list below, where the symbol exists and the behaviour is wrong.

**Mutations (one per behaviour group; each run, then restored and sha256-checked —
`.tentacle/tmp/subagent-ledger-log/mutate.sh` plus two python patches):**

| Group | Mutation | Red line |
|---|---|---|
| ledger idempotence | `subagentLoadNotes` drops the `noteSeen` pass | `(fail) idempotence: the same inputs give the same notes; with them in the messages, none` + `a re-emitted pair at a new segment …` (14 pass, 2 fail) |
| ledger re-emission | `segmentFacts` emits only a `bg` (`if (false && …)`) | `(fail) background → running; end → ended; segmentFacts re-emits …` + the dup/late `end` case (14 pass, 2 fail) |
| orphan safety | drop the `callId !== ""` guard | `(fail) an ORPHAN \`end\` … never a \`background\` with an empty \`callId\`` (16 pass, 1 fail) |
| derivation locale | laptop load derives over ALL segments | `(fail) an open \`bg\` in a SUPERSEDED segment only: no note` (30 pass, 1 fail) |
| older-build skip | `subagent_end` made CRITICAL | `(fail) the critical table is the owner's …` + `both types are NON-critical …` + `the fields stay lenient …` (8 pass, 3 fail) |
| Q1 close | `resumableTurn` ignores `loadNotes` | `(fail) Q1 (a): a resumable turn with a sub-agent note to append is CLOSED` (114 pass, 1 fail) |
| segment start | `historyReplaced` drops `logSegmentFacts` | `(fail) a RUNNING child's \`bg\` is re-emitted right after the new base` + `an ENDED undelivered child re-emits BOTH markers` (5 pass, 2 fail) |
| digest | `canonicalMessage` includes `note` | `(fail) the digest ignores \`note\`: a checkpoint never trips on it` (20 pass, 1 fail) |
| TUI frame | `render-lines` always draws the body | `(fail) a noted message in the App (the --resume path) > collapsed: the notice + the expand hint` (0 pass, 1 fail) |
| drift invariant | (no mutation: the test asserts the real D1 hook with markers logged) | green, with `readAll(...).filter(isMarker).length > 0` proving the mix is non-empty |

Every restore printed `SHA-OK` for the file it mutated, and the full sweep
(`shasum -a 256 -c baseline.sha256`, 32 files) came back 32/32 OK right after the last mutation.
Six of those files were then edited AGAIN on purpose (a biome format pass, the orphan `end` guard
and its test, one `steeringIds` type fix, the markers-in-the-mix drift test), so they differ from
that baseline now — by design, not by a failed restore.

### Gate (re-run by the executor)

```
bunx tsc --noEmit                 → no output (clean)
bunx tsc -p apps/mobile           → no output (clean)
bunx biome check .                → Checked 771 files. No fixes applied. 0 errors, 0 warnings
bun test packages                 → 5932 pass · 3 skip · 0 fail · 400 files (181.92s)
bun test apps                     → 3 pass · 0 fail
```

(The whole gate was re-run after EVERY source change; the final `bun test packages` ran last, with
the orphan `end` guard, its test, and the markers-in-the-mix drift test in place. Earlier runs of
the same command, at earlier states of the branch, read 5930/3/0 and 5931/3/0.)

The 3 skips are the documented opt-ins (live k8s, live docker, the real-socket keepalive). Lint
baseline (AGENTS §6, clean) held: the two `bunx biome check` findings on my own files during the
run were formatting/import-order and were fixed with `biome check --write`.

### Not done / not verified (honest list)

- **No background launching.** That is 6a, as the plan says; `backgroundAgent` / `agentEnded` /
  `agentJobsRunning` exist and are tested, nothing calls them in production yet.
- **No agent-loop change for notes** (Q10: no wake at load). The notes are history messages; the
  relay into a *turn* is 6a's.
- **No `/clear` hand-over wiring.** The plan's §8 is "in one line" future work
  (`feat/clear-keeps-jobs`): `handOver()` / `adopt()` exist and are unit-tested, no caller.
- **A live `HostedSession` mount of the FULL resume path** (a real `serve` process death →
  restart → reload → a client seeing the note) was NOT exercised end to end: the reload is tested
  at the `rebuild` → `reconcileOnReload` seam (the real decoders, the real functions), and the
  laptop path against real files under a temp dir. The daemon process lifecycle itself is
  unchanged by this task. Verify with a `serve` crash-restart if wanted.
- **`bun test packages` was run three times** (after each batch of source changes: 5930, 5931,
  then 5932 pass); the counts above are from the last one. A narrow run of the six touched
  packages between them read 2990 pass · 1 skip · 0 fail (the two other opt-in skips live in
  packages the subset's file set did not include).
- **The pod path (FM 14/15/16)** was reasoned from the reader's code and the probe's A/B output,
  not re-tested with a live pod: no pod daemon exists before 6a to emit a marker.

## Review

*— (reviewer), (date)*
