# eval/daemon-side-persistence — `serve` persists session history on its own host

> **Status:** implementation drafted — awaiting owner approval (2026-10-19)
> **Branch:** none until promoted (then `feat/daemon-side-persistence`; Part B → `feat/suspended-turn-resume` if the split in Open question 1 is approved)
> **Type:** eval → feat · **Size:** L as one task → proposed split into two M (Part A here, Part B a new doc; Open question 1) · **Blast:** load-bearing (agent loop, persistence + pod-trust invariants, AGENTS §7 rule change) · **Suited:** strong model executes; mandatory fresh-context Review per part

## Context

*— claude-opus-5-5, 2026-10-19*

**Question being decided:** with sessions that outlive their connection and
turns that stay suspended on a permission for hours
(`docs/eval/session-reattach.md` points 8 and 10), should a `tentacle serve`
daemon persist session history on its own host? **Answer from the owner's
scenario: yes, for `serve`** — promoted from an open question to a v2 child.

Scenario that decides it (2026-10-19): the phone dies while a permission is
pending; hours later it reconnects. With client-only persistence (AGENTS §7
today), everything the agent did after the phone's last snapshot exists only in
daemon memory: a daemon restart in that window loses it, and the suspended turn
cannot be rebuilt. The owner's requirement is that the turn waits, intact,
until they return.

Why the current rule exists, and why it still holds for pods: in pod `run` /
`attach` the daemon is not trusted and its filesystem is ephemeral, so the
laptop must own the record. A `serve` on the user's own machine is a
different trust situation.

## Implementation

> **Owner decisions (2026-10-19):** the open questions below are resolved in
> the parent, `docs/eval/session-reattach.md` §"Owner decisions after the
> children's Implementation drafts" (A–G, D1–D10). Where a question or
> design point here disagrees, the parent decision wins.


*— claude-opus-5-5, 2026-10-19 (draft, awaiting owner approval)*

Verified against `main` @ `4914e9b` (steering-over-rpc merged). Cited lines
are on that commit. The earlier v2 children (`session-event-stream`,
`session-registry`, `session-ttl-limits`, `permission-events`,
`session-store-durability`) are **not implemented yet**. Where this plan leans on
them, it names the interface it assumes (§ *Assumed interfaces*) and does not
redesign it.

### Open questions / contradictions (owner decisions needed before Execution)

1. **Ordering contradiction: rebuilding a suspension needs `permission-events`,
   which is scheduled *after* this child.** On restart the rebuilt turn re-runs
   `gate.authorize`, which calls the session's requester
   (`permission-gate.ts:74`). Until `permission-events` lands, that requester is
   a daemon→client request bound to one connection (`hosted-session.ts:48-52`,
   `connection.ts:222-232`). After a restart no connection exists, so the
   request fails and is coerced to `cancelled`, which is a **deny**
   (`connection.ts:228-231`). That violates the owner rule "a denial only ever
   comes from a person". `permission-events`' own scope already says it
   rebuilds the suspension on restart, and the parent table makes it depend on
   this child only for that point. **Recommendation:** split this child in two:
   - **Part A, `daemon-side-persistence` (this doc, M, stays at step 6, before
     `permission-events`).** It adds the daemon store, writes at every committed
     boundary, reload-as-detached on startup, the record format *including* the
     pending-permission record and the steering queue, the store lock, pods
     unchanged, and the AGENTS §7 amendment. A turn that was suspended at a
     restart is **reconciled honestly, not resumed**: the pending call is answered
     with "not run: the daemon restarted while this was waiting for your
     approval", queued steers are kept as user messages, and the session reloads
     idle. Nothing is denied on the user's behalf and nothing runs.
   - **Part B, `suspended-turn-resume` (new doc, M, after `permission-events`).**
     It adds the agent-loop resume seam, `Session.resume`, rebuilding the
     suspension so the gate re-asks through the event-based requester (new
     nonce), and the await-before-run clear of the pending record.
     `permission-events` then drops its "survives restart" bullet, which moves to
     Part B.

   Part B is fully planned below (marked **[B]**), so the split is only a doc
   move: an executor creates `docs/eval/suspended-turn-resume.md` from the [B]
   items. *Alternative:* keep one task. It is then **L** (agent + daemon + cli
   + AGENTS.md, two packages of tests) and must move after `permission-events`.
   That works too, but it delays the store, which `permission-events` does not
   need.
2. **The `since` token must not survive a restart unchanged.** The ring and
   `seq` are in memory (`hosted-session.ts:32-34`), so a restarted daemon
   starts counting again. A client returning with `since = 500` from before the
   restart would then get either a "future" token (resync, fine) or, once the
   new daemon has passed 500, a valid-looking token whose replay **skips** new
   events that reuse old seq numbers (the client dedupes them by seq). This is a
   silent gap. **Recommendation:** `session-event-stream` makes `since` opaque.
   This child adds a per-process **boot epoch** (random, minted at `serve`
   start) to the token (`<epoch>.<seq>`). Any epoch mismatch → `resync`. This
   adds a field to an opaque token and does not redesign it. Persisting `seq`
   instead would not work: events after the last write would be re-numbered.
3. **Idempotency keys must be persisted too.** `session-event-stream` keeps
   `turnId → ack` (and `enqueue` ids) for the session's lifetime (review F8).
   If that map lives only in memory, a phone that retries `prompt{turnId}` after
   a restart **runs the turn twice**, which is exactly F8, moved one layer down.
   **Recommendation:** the record carries both id sets (a few bytes per turn).
   This is in scope here.
4. **"Allow always" grants (`PermissionGate.grantedTools` / `shellPrefixes`,
   `permission-gate.ts:55-58`) are memory-only.** After a restart the user is
   re-asked for commands they had approved for the session. This fails safe
   (more prompts, never fewer). **Recommendation:** do not persist grants in this
   task. Persisting them needs a gate export/import API and its own pod-trust
   review. Open a follow-up if the re-prompts annoy.
5. **What `session/close` does to the daemon record.** **Recommendation:**
   `close` deletes it. The daemon copy exists to keep *live* sessions alive
   across a restart, and the client keeps its own copy (Review: offline viewing,
   `open{messages}` recovery). Without deletion, `<store>/` grows forever with
   sessions nobody can reach without re-opening them.
6. **Sub-agent suspensions are not resumable (both parts).** A permission
   requested *inside* an `agent_task` sub-agent comes from the child's own loop.
   The child shares the parent's broker (`wiring.ts:124`) and its history lives
   only in the child's memory (`subagent.ts`). A restart cannot rebuild it
   without re-running the sub-agent, and its tools may already have had side
   effects. **Recommendation:** on reload, answer the `agent_task` call with an
   explicit "interrupted by a daemon restart while a sub-agent waited for
   approval; its partial work is lost". The session reloads idle, and the
   suspension is lost *visibly*. Persisting child conversations is a separate L
   item. **The owner should confirm** that this exception to "the suspension
   survives a restart" is acceptable.
7. **Dependency on `session-store-durability`.** This plan reuses
   `JsonSessionStore`. That store's `save` writes in place today
   (`session-store.ts:63-66`), a crash mid-write truncates the file, and `load`
   swallows parse errors (`:69-79`). A daemon that writes on *every* boundary
   multiplies that crash window. **Recommendation:** make
   `fix/session-store-durability` (atomic rename, serialized latest-wins
   queue, validated loud load) a **hard prerequisite** of Part A, not something
   re-implemented here (Review: one durability implementation).

### Load-bearing assumption

> The history persisted at the moment the permission is requested, plus
> `{pendingToolCallId, steering}`, is enough to rebuild the suspended turn
> **without re-running the model round**: the rebuilt turn re-asks for exactly
> the call the user was looking at, runs the rest of that round's calls, and
> then continues the loop. The final history is byte-identical to an
> uninterrupted run.

**Verdict: the data is sufficient. The loop cannot resume mid-round today, so a
minimal agent-loop change is needed (Part B).**

Code facts:
- **The assistant message, with all its `toolCalls`, is committed before any
  tool is authorized.** It is pushed at `agent.ts:256-260`. The per-call loop
  follows at `:304-341`, and authorization sits inside `runTool`
  (`:333` → `:486-500`, `gate.authorize` at `:495`). Each answered call's
  `tool` message is pushed at `:340` before the next call's `tool_start`
  (`:324`). So while call *k* waits in `authorize`, `messages` =
  `…, assistant{toolCalls: c1..cn}, tool(c1) … tool(c_{k-1})`, which is
  exactly what has happened and nothing more.
- **Nothing besides history determines the decision.** `authorize`
  (`permission-gate.ts:63-79`) depends only on the tool, its parsed input, and
  the in-memory grants (`:70-72`). It keeps no per-request state that a re-ask
  would need. Re-asking means calling `authorize` again with the same
  `(tool, input)`, and `input` is re-parsed from the stored `call.arguments`
  (`agent.ts:489-494`).
- **The daemon sees the suspension synchronously, with the right call id.**
  `HostedSession` sets `currentToolCallId` on the `tool_start` event
  (`hosted-session.ts:101-103`) before the generator resumes into `runTool`. So
  the requester wrapper (`:48-52`) knows the call id and can copy
  `session.snapshot()` (`session.ts:46-48`) at that moment.
- **But `runMessages` always starts with a model round** (`agent.ts:195-217`).
  It cannot be entered "at call *k*". Today's only re-entry,
  `Session.send("")` (`session.ts:62-76`), sends the dangling
  `assistant{c1..cn}` back to the model and never runs `c2..cn`. That is the
  unwanted re-ask: an extra model round, and the approval the user saw no longer
  matches what runs.

**Experiment** (`.tentacle/tmp/daemon-side-persistence-impl/resume.ts`,
2026-10-19, bun 1.4.3). It uses a real `Agent` + `Session` + `PermissionGate` +
`ToolRegistry(builtinTools)`, a scripted model, and a fake env. Round 1 asks
for `c1 fs_read` (permission `none`), `c2 shell "echo two"` (`ask`) and
`c3 shell "echo three"` (`ask`); round 2 answers in text. A steer is enqueued
while `c2` is pending.

```ts
// Load-bearing assumption: persisted history + {pendingToolCallId, steering}
// captured AT the permission request is enough to rebuild the suspended turn
// WITHOUT re-running the model round. Real Agent + Session + PermissionGate +
// ToolRegistry; scripted model; fake env.
import { Agent, PermissionGate, Session } from "@tentacle/agent";
import type { ChatMessage, ChatRequest, ExecutionEnvironment, ModelProvider, PermissionRequest, StreamEvent } from "@tentacle/core";
import { ToolRegistry, builtinTools } from "@tentacle/tools";

const ROUND1: StreamEvent[] = [
  { type: "tool_call", toolCall: { id: "c1", name: "fs_read", arguments: JSON.stringify({ path: "a.txt" }) } },
  { type: "tool_call", toolCall: { id: "c2", name: "shell", arguments: JSON.stringify({ command: "echo two" }) } },
  { type: "tool_call", toolCall: { id: "c3", name: "shell", arguments: JSON.stringify({ command: "echo three" }) } },
  { type: "done" },
];
const ROUND2: StreamEvent[] = [{ type: "text", delta: "all done" }, { type: "done" }];

class Scripted implements ModelProvider {
  readonly id = "scripted";
  calls: ChatRequest[] = [];
  constructor(private readonly script: StreamEvent[][]) {}
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) });
    for (const e of this.script[this.calls.length - 1] ?? [{ type: "done" }]) yield e as StreamEvent;
  }
}
function env(execs: string[]): ExecutionEnvironment {
  return {
    id: "fake",
    async exec(c: string) { execs.push(c); return { stdout: `ran ${c}`, stderr: "", exitCode: 0 }; },
    async readFile() { return "A-CONTENT"; },
    async writeFile() {},
  } as ExecutionEnvironment;
}
const tools = () => new ToolRegistry().registerAll(builtinTools);
const roles = (m: readonly ChatMessage[]) =>
  m.map((x) => x.role === "assistant" && x.toolCalls ? `assistant[${x.toolCalls.map((t) => t.id)}]` : x.role === "tool" ? `tool(${x.toolCallId})` : `${x.role}:${JSON.stringify(x.content).slice(0, 24)}`).join(" -> ");
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- A. uninterrupted reference run (steer enqueued while c2 is pending) ----------
{
  const execs: string[] = []; const model = new Scripted([ROUND1, ROUND2]);
  let session!: Session; const prompts: string[] = [];
  const agent = new Agent({ model, tools: tools(), env: env(execs), requestPermission: async (r: PermissionRequest) => {
    prompts.push(String(r.detail)); if (r.detail === "echo two") { session.enqueue("steer-1"); await tick(); } return { allowed: true }; } });
  session = new Session(agent, "S");
  for await (const _ of session.send("go")) {}
  console.log("A uninterrupted: model calls =", model.calls.length, "| prompts =", prompts, "| execs =", execs);
  console.log("A history:", roles(session.messages));
  (globalThis as any).A = JSON.stringify(session.messages);
}

// ---------- B. suspend on c2, capture record, abandon process state, rebuild ----------
let record: { messages: ChatMessage[]; pendingToolCallId: string; steering: string[] };
{
  const execs: string[] = []; const model = new Scripted([ROUND1, ROUND2]);
  let session!: Session; let current = "";
  const agent = new Agent({ model, tools: tools(), env: env(execs), requestPermission: (r: PermissionRequest) => {
    // The daemon's requester sees the exact suspension state, synchronously:
    record = { messages: JSON.parse(JSON.stringify(session.snapshot().messages)), pendingToolCallId: current, steering: [] };
    return new Promise(() => {}); // suspended forever (the "process" dies here)
  } });
  session = new Session(agent, "S");
  const gen = session.send("go");
  (async () => { for await (const e of gen) { if (e.type === "tool_start") current = e.id; } })();
  await tick(); await tick();
  session.enqueue("steer-1"); // accepted while suspended
  record!.steering = [...(session as any).steering]; // re-written on every enqueue while suspended
  console.log("\nB before restart: model calls =", model.calls.length, "| execs =", execs);
  console.log("B record.pendingToolCallId =", record!.pendingToolCallId, "| steering =", record!.steering);
  console.log("B record.messages:", roles(record!.messages));
}

// ---------- B'. TODAY's only entry: Session.send("") over the restored history ----------
{
  const execs: string[] = []; const model = new Scripted([ROUND2]);
  const agent = new Agent({ model, tools: tools(), env: env(execs), requestPermission: async () => ({ allowed: true }) });
  const s = new Session(agent, "S", { messages: JSON.parse(JSON.stringify(record!.messages)) });
  for await (const _ of s.send("")) {}
  console.log("\nB' today (send \"\"): model calls =", model.calls.length, "| execs =", execs,
    "| 1st request:", roles(model.calls[0]!.messages));
}

// ---------- B''. PROTOTYPE of the proposed seam: run pending calls, THEN the loop ----------
{
  const execs: string[] = []; const model = new Scripted([ROUND2]); const prompts: string[] = [];
  const requester = async (r: PermissionRequest) => { prompts.push(String(r.detail)); return { allowed: true }; };
  const reg = tools(); const e = env(execs);
  const agent = new Agent({ model, tools: reg, env: e, requestPermission: requester });
  const messages: ChatMessage[] = JSON.parse(JSON.stringify(record!.messages));
  const steering = [...record!.steering];
  // what `runMessages(..., { resumeFrom })` would do before its first model round:
  const last = messages.findLastIndex((m) => m.role === "assistant");
  const answered = new Set(messages.slice(last + 1).map((m) => m.toolCallId));
  const calls = messages[last]!.toolCalls!;
  const from = calls.findIndex((c) => c.id === record!.pendingToolCallId);
  const gate = new PermissionGate(requester);
  for (const call of calls.slice(from)) {
    if (answered.has(call.id)) continue;
    const tool = reg.get(call.name)!;
    const ok = await gate.authorize(tool, JSON.parse(call.arguments));
    const res = ok ? await reg.execute(call.name, call.arguments, { sessionId: "S", signal: new AbortController().signal, env: e }) : { content: "denied" };
    messages.push({ role: "tool", content: res.content, toolCallId: call.id });
  }
  for await (const _ of agent.runMessages(messages, "S", undefined, () => steering.splice(0))) {}
  console.log("\nB'' resumed: model calls =", model.calls.length, "| prompts =", prompts, "| execs =", execs);
  console.log("B'' 1st request:", roles(model.calls[0]!.messages));
  console.log("B'' history == A history:", JSON.stringify(messages) === (globalThis as any).A);
}
process.exit(0);
```

Output:

```
A uninterrupted: model calls = 2 | prompts = [ "echo two", "echo three" ] | execs = [ "echo two",
  "echo three"
]
A history: user:"go" -> assistant[c1,c2,c3] -> tool(c1) -> tool(c2) -> tool(c3) -> user:"steer-1" -> assistant:"all done"

B before restart: model calls = 1 | execs = []
B record.pendingToolCallId = c2 | steering = [ "steer-1" ]
B record.messages: user:"go" -> assistant[c1,c2,c3] -> tool(c1)

B' today (send ""): model calls = 1 | execs = [] | 1st request: user:"go" -> assistant[c1,c2,c3] -> tool(c1)

B'' resumed: model calls = 1 | prompts = [ "echo two", "echo three" ] | execs = [ "echo two",
  "echo three"
]
B'' 1st request: user:"go" -> assistant[c1,c2,c3] -> tool(c1) -> tool(c2) -> tool(c3) -> user:"steer-1"
B'' history == A history: true
```

What it shows:
- **The record captured at the request is exact** (B). It holds
  `assistant[c1,c2,c3] -> tool(c1)`, pending = `c2`, and the steer accepted
  during the suspension.
- **Today's re-entry is wrong** (B'). The model is called over a history with
  two unanswered calls, and `c2`/`c3` never run.
- **"Run the unanswered calls from the pending one, then enter the loop" is
  correct** (B''). `c1` is not re-run. `c2` and `c3` are each asked once and
  each run once. The steer is drained at the first iteration top, where it
  would have been drained anyway (`agent.ts:201-205`). There is one model
  round after the restart (1 before + 1 after = 2, the same as A), and the
  final history is **identical** to A.

### Preconditions

- **P1: history is shared by reference and committed per push.** `Session`
  passes its own `messages` array to `runMessages` (`session.ts:70`). The loop
  pushes into it (`agent.ts:203,256,282,296,311,340,363,402,417`), and `snapshot()` copies
  it (`session.ts:46-48`). Any synchronous snapshot is a well-defined prefix of
  the turn.
- **P2: tool calls run sequentially.** This is the `for` loop at
  `agent.ts:304-341`, so at most one call is in `authorize` at a time. The
  "calls before the pending one are answered" check depends on this. If
  `docs/eval/parallel-tool-calls.md` lands, revisit P2.
- **P3: the steering queue lives in `Session`.** It is private
  (`session.ts:32`), `send` resets it (`:65`), `enqueue` pushes to it
  (`:83-85`), and the loop drains it at each iteration top (`agent.ts:202`),
  at the late drain (`:279`) and in the final report (`:361,416`).
  `Connection.enqueue` is synchronous and rejects when no turn is running
  (`connection.ts:155-167`). A turn suspended on a permission is `running`
  (`hosted-session.ts:68-70`: the controller is set for the whole turn), so
  an enqueue is accepted while it waits.
- **P4: the steering invariant.** The comment is at `agent.ts:270-278`, and
  the test at `daemon/test/integration.test.ts:424-463` arms a macrotask in
  the last drain and asserts `running === false` when it fires. A turn
  awaiting a microtask is fine; awaiting I/O (a macrotask) between the last
  drain and the controller being cleared (`hosted-session.ts:113-115`) is not.
- **P5: `serve` and the pod daemon are separate entry points with separate
  `SessionHost`s.** They are `startDaemon` (`cli/src/serve.ts:28-43`, the ws
  `serve`, `main.ts:221-236`) and `startStdioDaemon` (`serve.ts:54-121`, the
  `serve --stdio` used inside pods, `main.ts:192-200`). The in-process worker
  builds a third host (`cli/src/worker.ts:80`). So "serve only" can be
  **structural**: only `startDaemon` passes a store. Nothing needs to detect
  the runtime.
- **P6: the client store dir is `<configDir>/sessions`** (`main.ts:269,452`).
  A `serve` on the same machine as a TUI shares `configDir`, and the client
  uses the same session uid (it owns the uid, AGENTS §7). The daemon store
  therefore needs its **own** directory, or two writers would race on one
  file (`session-store-durability` repro (e)).
- **P7: no tool has permission `ask` and also nests permission requests.**
  `agent_task` is `permission: "none"` (`tools/src/task.ts:52`), so any
  request raised while the current parent call is `agent_task` comes from a
  sub-agent. Classifying a pending request as resumable depends on this
  (Design A4). A test pins it.
- **P8: `ChatMessage` round-trips through JSON.** In the experiment,
  `JSON.parse(JSON.stringify(messages))` re-ran to an identical history,
  `toolCalls` included.
- **Store lock primitive (verified,
  `.tentacle/tmp/daemon-side-persistence-impl/lock.ts`, bun 1.4.3).**
  `openSync(path, "wx")` gives `EEXIST` on the second take, and
  `process.kill(pid, 0)` tells a live holder from a dead one:
  ```ts
  import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
  const path = `${import.meta.dir}/store.lock`;
  rmSync(path, { force: true });
  const take = (pid: number) => { const fd = openSync(path, "wx"); writeSync(fd, String(pid)); closeSync(fd); };
  take(process.pid);
  console.log("first take: ok");
  try { take(process.pid); } catch (e) { console.log("second take:", (e as NodeJS.ErrnoException).code); }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
  console.log("holder alive (self):", alive(Number(readFileSync(path, "utf8"))));
  const dead = Bun.spawnSync(["true"]).pid;
  console.log("holder alive (exited child):", alive(dead));
  rmSync(path);
  ```
  ```
  first take: ok
  second take: EEXIST
  holder alive (self): true
  holder alive (exited child): false
  ```

### Assumed interfaces (from unimplemented children — not redesigned here)

- **`session-store-durability`:** `JsonSessionStore.save` is atomic
  (temp + rename), serialized per uid with latest-wins coalescing, and
  rejects instead of crashing. `load` returns a validated record, or a typed
  *corrupt* result that is distinct from *absent*. `list` skips and reports
  bad files. Extra fields on a record are preserved verbatim, which this plan
  relies on to store `DaemonSessionRecord extends SessionRecord` in the same
  class.
- **`session-event-stream`:** `HostedSession` has **one synchronous place**
  where it advances the consistent cut (`committedSeq`) after a history push
  (round end, each tool result, turn end, compaction via `history_replaced`).
  Call it `onCommitted()`. A turn driver separate from `prompt` emits
  `turn_start{turnId}` / `turn_end{turnId,…}` and clears the controller in one
  synchronous segment. There are lifetime idempotency maps for `turnId` and
  `enqueue.id`, and an opaque `since`.
- **`session-registry`:** `SessionHost` is the registry
  (`open/get/close`). `HostedSession` has a set of sinks and a `close()`. A
  live id is always attached, never overwritten. This plan adds one registry
  entry point, `restore(record)` (insert a detached live session), and one
  hook, `onClosed(id)`.
- **`session-ttl-limits`:** the reaper reads a per-session "last active"
  time and skips running or suspended turns. This plan supplies that time from
  the record on reload.
- **`permission-events`** (Part B only): the requester emits a
  `permission_request` event with a fresh nonce into the ring and resolves
  when any client answers. No timeout, no connection binding.

### Design

**Part A — `daemon-side-persistence` (this doc).**

A1. **Record format.** Add `DaemonSessionRecord` to
`daemon/src/persisted-session.ts`, a new pure module (validation + mapping, no
I/O):

```ts
interface DaemonSessionRecord extends SessionRecord {   // agent/src/session-store.ts:13-23
  readonly kind: "tentacle.daemon-session";
  readonly schemaVersion: 1;                              // of THIS record, independent of PROTOCOL_VERSION
  readonly lastActiveAt: number;                          // TTL clock (session-ttl-limits)
  readonly turnIds: readonly string[];                    // idempotency (Open question 3)
  readonly enqueueIds: readonly string[];
  readonly turn?: {                                       // present iff a turn was running at the write
    readonly turnId: string;
    readonly steering: readonly string[];                 // Session's queue, verbatim, in order
    readonly pending?: {                                  // present iff suspended on a permission
      readonly toolCallId: string;
      readonly tool: string;
      readonly resumable: boolean;                        // A4
      readonly requestedAt: number;
    };
  };
}
```

`parseDaemonRecord(json) → {ok, record} | {ok:false, reason}` checks `kind`,
`schemaVersion === 1`, and the field types. A different `schemaVersion`
returns `reason: "unsupported-version"`. Such a file is **never overwritten**
and is reported by name (Failure modes). Messages are stored as `ChatMessage`
JSON, the same as the client store (P8).

A2. **The persister: a write that can never be awaited in the turn.** Add
`daemon/src/session-persister.ts`:
- `schedule(id, build: () => DaemonSessionRecord): void` returns **`void`, not
  a Promise**, so an `await` on it is a type error under the repo's lint and
  cannot be written by accident in the end-of-turn window. `build` runs
  **synchronously** inside `schedule`: it copies `snapshot()` and the steering
  queue *now*, so the content is the cut at the call site, not at the later I/O.
  It then hands the record to `store.save` (latest-wins per uid, serialized by
  the durability fix).
- `flush(id): Promise<void>` resolves when the latest scheduled record for
  `id` is durable, and rejects if that write failed. It is used **only**
  outside the end-of-turn window: by the Part B permission-resolution path and
  by enqueue-while-suspended (A5).
- `drain(): Promise<void>` waits for every pending write, for shutdown.
- `remove(id)` handles `close` (Open question 5): it cancels any queued write
  for `id`, then deletes the file.
- A failed write → `onError(error)`, the daemon's existing sink
  (`serve.ts:24-25`, printed at `main.ts:227`). The session keeps serving from
  memory and the next `schedule` retries with fresher data. It is never thrown
  into the agent loop.

A3. **Where writes happen (the cut).** Each write sits at a point where the
history is a committed prefix (P1):
- **every committed boundary**: inside `HostedSession.onCommitted()` (assumed,
  event-stream). This covers round end, each tool result and compaction
  (`session.ts:97` also calls `onPersist`; wire `Session`'s existing
  `onPersist` hook to `schedule` as well, so a `compact` reached by any path
  writes);
- **turn start**: right after the turn driver marks the turn running, to
  record `turn.turnId` and the user prompt. The `turnIds` entry is written
  here, so the dedupe key is durable before the model is called;
- **suspension**: in the requester wrapper (`hosted-session.ts:48-52`),
  synchronously, *before* forwarding the request. The record gets
  `turn.pending = {toolCallId: currentToolCallId, tool, resumable, requestedAt}`;
- **enqueue**: after `Session.enqueue` pushes (A5);
- **turn end**: in the turn driver, **after** the synchronous segment that
  emits `turn_end` and clears the controller. The record has no `turn`. This
  is plain sequential code after the segment (`controller = null;
  persister.schedule(...)`). Because `schedule` returns `void`, nothing in
  the segment awaits. **Update the INVARIANT comment** at `agent.ts:270-278`,
  which names `HostedSession.prompt`, to name this write: "the daemon's turn-end
  write is `persister.schedule` (void, sync capture) after the controller is
  cleared — never `await persister.flush` here".

A4. **Classifying a pending request (pure, `persisted-session.ts`).**
`classifyPending(messages, currentToolCallId, currentToolName, request)` →
`resumable: boolean`. It is true iff all of these hold:
- `request.tool === currentToolName`;
- the last `assistant` message contains `currentToolCallId`;
- every call before it in that message is answered by a `tool` message after
  it, and it is not answered itself.

A sub-agent's request fails the first check (P7: the parent's current call is
`agent_task`, which never asks). This is the Open question 6 case.
`HostedSession` records the current tool's **name** together with the id it
already tracks (`hosted-session.ts:101-103`).

A5. **Steering is persisted, and an acked steer while suspended is durable.**
`Session` gets `pendingSteering(): readonly string[]` (a copy). Every record
built while a turn runs includes it. `HostedSession.enqueue` keeps the
synchronous `running` check and push, so the invariant is unchanged. It then
calls `schedule`. When the turn is **suspended**, the `enqueue` handler (made
async, *after* the synchronous push) awaits `persister.flush(id)` before
acking. An ack then means the steer is on disk. This await comes after the push
and is not inside the end-of-turn window, and peer dispatch stays concurrent
(AGENTS §7). When the turn is running but not suspended, the ack does not wait.
A crash then ends the turn anyway, and A6 keeps the persisted steers.

A6. **Reload on `serve` start (`SessionHost.restore`).** `startDaemon`
creates the persister over `JsonSessionStore(<configDir>/daemon/sessions)`
(P6), takes the lock (A7), then calls `list()`. For each valid record it calls
`reconcileOnReload(record)`, a pure function in `persisted-session.ts` that
returns `{messages, notes}`:
- no `turn` → the history is used as is;
- `turn` present (the daemon died mid-turn):
  - every unanswered call in the trailing assistant message is answered
    synthetically, right after the existing answers. Calls run in order (P2),
    so this needs only two texts:
    - **"Interrupted"** for the first unanswered call when there is **no**
      `pending`. It was in flight and may have run: `"Interrupted: the daemon
      restarted while this tool was running; it may or may not have completed.
      Check before retrying."`;
    - **"Not run"** for the pending call, and for every call after the first
      unanswered one. None of them started: `"Not run: the daemon restarted
      before this call ran (it was waiting for approval or queued behind
      one). Ask again if it is still needed."`.

    In **Part B**, a `resumable` pending turn is resumed instead (B3);
  - `turn.steering` entries are appended as `user` messages. This mirrors
    "kept in the history rather than dropped" at `agent.ts:411-419`.

  `restore` then builds the agent through the normal factory (`session-host.ts:39-41`).
  It registers the session **detached** with `lastActiveAt` from the record
  (TTL; a record already past the TTL and not suspended → close + `remove`),
  seeds the `turnIds`/`enqueueIds` dedupe maps, and schedules one write of the
  reconciled record. It does **not** emit stream events: no client is
  attached, and the boot epoch (Open question 2) forces any returning client to
  resync from the snapshot.

  An invalid, corrupt or unsupported record is skipped. `serve` prints one
  pre-listen line per skipped file (path + reason) and keeps the file. `serve`
  owns stdout/stderr (no Ink), so this is allowed.

A7. **One daemon per store.** Before reloading, `startDaemon` takes
`<store>/.lock` with `openSync(…, "wx")` and writes its pid. On `EEXIST` it
reads the pid. A live holder → `serve` refuses to start: "another tentacle
serve (pid N) owns <dir>; stop it or remove <dir>/.lock". A dead holder → the
lock is taken over (unlink + retake once). The lock is released on shutdown,
after `persister.drain()`. `SIGINT` handling (`main.ts:230-235`) becomes:
`server.stop()` → `await persister.drain()` → release the lock → resolve.

A8. **Pods unchanged, structurally.** Only `startDaemon` passes
`persistence`. `startStdioDaemon` (`serve.ts:67-91`) and the worker
(`worker.ts:80`) construct `SessionHost` without it, so `HostedSession` holds
`persister: null` and every `schedule` is skipped. To make that testable,
extract each host construction into an exported factory
(`createServeSessionHost(config, persistence)`,
`createStdioSessionHost(config, opts)`). Pod sessions keep laptop-side
persistence from `snapshot` (AGENTS §7).

A9. **AGENTS §7 amendment (rides this branch, §10(c)).** Replace the first
sentence of "Persistence lives on the laptop/main thread" with:

> **Persistence lives on the laptop/main thread — and, where the daemon is
> trusted (`serve` on the user's own host), the daemon also persists.** The
> client always persists its own copy from `snapshot` (offline viewing,
> `open{messages}` recovery); a `serve` daemon additionally writes each live
> session to `<configDir>/daemon/sessions/` at every committed boundary and
> reloads it on start, and on re-attach the daemon's copy wins. Pod daemons
> (`serve --stdio`, `run`/`attach`) never persist: a pod-written record is
> pod-supplied data (next bullet). The daemon's turn-end write is
> fire-and-forget (`schedule`, never awaited) — steering invariant.

The rest of the bullet (main owns the uid, persist only `ChatMessage`s) stays.
Add a cross-reference from the pod-trust bullet: "this is why pod daemons
store nothing durable".

**Part B — `suspended-turn-resume` [B] (after `permission-events`).**

B1. **Agent seam (minimal loop change).** Make two changes in `agent.ts`:
- Extract the per-call body at `:304-341` into
  `private async *runToolCalls(calls, messages, toolContext, signal)`. The
  behaviour stays identical, the abort/synthetic-answer branch included.
- Add an optional 5th parameter:
  `runMessages(messages, sessionId, signal?, drainSteering?, opts?: { resumeFrom?: string })`.

With `resumeFrom` set, before `flushBackgroundExits` and the first iteration,
the loop validates the trailing shape with the same pure check as A4. On a
mismatch it throws `ResumeShapeError`, and the caller falls back to A6's
reconciliation. On a match it runs `yield* this.runToolCalls(unanswered calls
from resumeFrom on)` and then enters the loop as usual. Calls *before*
`resumeFrom` are never re-run. Without `opts`, behaviour is byte-identical to
today, and `Session.send` never passes it. **Explicit opt-in on purpose:**
auto-resuming any dangling call would re-execute a call that was interrupted
mid-run (history-validity repro H: the side effect already happened).

B2. **`Session.resume(toolCallId, steering, signal)`** is a generator like
`send` (`session.ts:62-76`), with two differences: it **does not reset**
the steering queue (it seeds it from the record), and it pushes no user
message. It calls `runMessages(..., { resumeFrom: toolCallId })` and persists
in `finally` like `send`.

B3. **Rebuild on reload.** In `reconcileOnReload`, a `turn.pending` with
`resumable: true` returns `{messages, resume: {turnId, toolCallId, steering}}`
instead of answering the call. `restore` then starts the turn driver on
`Session.resume(...)` with the persisted `turnId`, so the client's
`prompt{turnId}` still ends with `turn_end{turnId}`. Like any turn, it emits
`turn_start{turnId}`. The gate re-asks for `toolCallId`: the requester (now
event-based, `permission-events`) emits `permission_request` with a **new
nonce** and suspends again, with no timeout. The turn is `running`, so the TTL
reaper skips it and `enqueue` is accepted.

B4. **The pending record is cleared durably before the tool runs.** In the
requester wrapper, once the human's answer arrives, the wrapper sets
`turn.pending = undefined` in memory, then `schedule`s and **awaits
`persister.flush(id)`**, and only then returns the answer to the gate. The
tool therefore never starts while the disk still says "pending". Without this,
a crash between "approved" and the write would re-ask the call after the
restart and, if approved again, **run it twice**. This await is inside
`authorize` (`permission-gate.ts:74`), mid-round, so it is far from the
end-of-turn window, and the steering invariant does not apply there. If the
flush fails, the error is logged and the tool still runs (the user approved
it). The residual risk is a re-prompt after a restart for a call that already
ran. That needs a second human approval, so it is never a silent second run
(Failure modes).

### Files

Dependency order (agent → daemon → cli → docs). A = Part A, B = Part B.

1. **A** `packages/agent/src/session.ts`: `pendingSteering()`. **B**: `resume()`.
2. **B** `packages/agent/src/agent.ts`: extract `runToolCalls`, the
   `opts.resumeFrom` parameter, `ResumeShapeError`. **A**: update the
   INVARIANT comment text at `:270-278` (A3).
3. **A** `packages/daemon/src/persisted-session.ts` (new, pure):
   `DaemonSessionRecord`, `parseDaemonRecord`, `classifyPending`,
   `reconcileOnReload`. **B**: the `resume` branch.
4. **A** `packages/daemon/src/session-persister.ts` (new): `schedule` /
   `flush` / `drain` / `remove`, plus the lock helpers (`acquireStoreLock` /
   `release`).
5. **A** `packages/daemon/src/hosted-session.ts`: optional persister, current
   tool name, write points (A3), pending capture in the requester wrapper,
   enqueue-while-suspended flush, `lastActiveAt`. **B**: clear-then-flush (B4),
   resumed turn driver.
6. **A** `packages/daemon/src/session-host.ts`: `persistence?` option,
   `restore(record)`, `remove` on close. Exported from `daemon/src/index.ts`.
7. **A** `packages/daemon/src/connection.ts`: `enqueue` becomes async after the
   synchronous push (A5), only when suspended + persisted.
8. **A** `packages/cli/src/serve.ts`: `createServeSessionHost` /
   `createStdioSessionHost`; `startDaemon` opens the store, takes the lock and
   reloads; it returns `{server, shutdown}`.
9. **A** `packages/cli/src/main.ts`: `serve` prints skipped records and the lock
   error pre-listen; on SIGINT it drains and releases the lock (`:221-236`).
10. **A** `AGENTS.md` §7: the amendment (A9).
11. Tests (below): `packages/agent/test/resume.test.ts` (B),
    `packages/daemon/test/persistence.test.ts` (A+B), an extension of
    `daemon/test/integration.test.ts` (steering invariant with a persister),
    and `packages/cli/test/serve-persistence.test.ts` (A).

No protocol schema change in Part A beyond the epoch inside the opaque `since`
(Open question 2), so no `PROTOCOL_VERSION` bump of its own.

### Failure modes

| Case | What happens / how state converges |
|---|---|
| Crash mid-write | Atomic rename (durability prerequisite): the old record or the new one, never half. At most the writes since the last committed boundary are lost. |
| Crash mid-turn, not suspended | `turn` is present without `pending`. Unanswered calls get the "Interrupted… may or may not have completed" result, never re-run. Steers become user messages. The session reloads idle, and a client re-attaching resyncs (epoch) and sees no running turn. |
| Crash while suspended (A) | The pending call gets "Not run…". The user sees it in the snapshot and can re-prompt. Nothing was denied or run. |
| Crash while suspended (B) | The turn is rebuilt and `permission_request` is re-emitted with a new nonce. Approving runs the tool exactly once. |
| Crash after approval, before the tool started (B) | B4: the disk already has no `pending` → treated as interrupted, not re-asked. A flush failure in that window → re-prompt (human-gated), logged. |
| Late answer to the pre-restart nonce | `permission-events`: `PermissionNotPending`. The new nonce is unrelated, so the old answer never binds to the rebuilt request. |
| `ResumeShapeError` (record and history disagree) | Fall back to the A reconciliation (answered as "Not run"). Logged with the session id, never a silent drop. |
| Disk full / EACCES | `onError` logs it, the session keeps serving from memory, and the next `schedule` retries. An enqueue-while-suspended whose flush fails is acked with an error (`PersistFailed`, an `RpcError` domain code) **after** the push, so the client knows the steer is queued but not durable. Never an unhandled rejection (durability repro (b)). |
| Two `serve`s on one store | A7 lock: the second refuses to start. A stale lock from a dead pid is taken over. A pid reused after a reboot gives a false "held": the message names the lock file to remove (documented limit). |
| Record from an unknown `schemaVersion` | Skipped, reported by path, never overwritten (a downgrade cannot destroy a newer daemon's data). |
| Corrupt or wrong-shape file | Skipped and reported (durability `list`). Other sessions still load. |
| Client returns with a pre-restart `since` | The epoch mismatches → resync (Open question 2). It never replays across the restart. |
| Client retries `prompt{turnId}` after a restart | `turnIds` is persisted → cached ack, never re-run (Open question 3). |
| `open{messages}` for a reloaded id | Registry rule: a live id is attached and never overwritten, so the daemon's copy wins (Review). |
| `close` racing a scheduled write | `remove` cancels the queued write before deleting, so the file is not resurrected. |
| Background jobs | Killed on daemon exit (`background-process-groups` exit net). They are not restored. A later `shell_output` on an old id returns the tool's normal unknown-job error. Documented limit. |
| Sub-agent suspension | Not resumable (Open question 6): the `agent_task` call is answered with an explicit interrupted note. |
| Pod daemon | No persister → no file is ever opened (A8). |
| Remembered grants after a restart | Lost → re-asked (Open question 4). Fails safe. |

### Tests

Red before green (§9): each test is shown failing on `main` (or with the
feature stubbed) first. Fakes: the repo's `ScriptedProvider` pattern
(`agent/test/permission.test.ts:23-33`), a fake env, real
`Agent`/`Session`/`PermissionGate`. **Fake store** `SpyStore`: an in-memory
`save` that resolves on demand (`release()`), exposing `durable` (the last
*completed* save per uid) and `saves[]`. There is no real disk except in the
cli test, which uses a temp `configDir`.

**Part A**
1. **Restart after `turn_end` → history intact.** Run a turn on a host with
   `SpyStore`, then build a *new* `SessionHost` over the same store and
   `restore` → `snapshot()` deep-equals the pre-restart history, and the
   session is detached and idle. Property: snapshot equality, not "a file
   exists".
2. **Restart mid-suspension (A semantics).** Suspend on `c2` of
   `[c1 none, c2 ask, c3 ask]`, enqueue `steer-1`, then restart → history =
   `…assistant[c1,c2,c3], tool(c1), tool(c2:"Not run…"), tool(c3:"Not run…"),
   user:"steer-1"`, and the exec spy is empty. Property: no "Interrupted" text
   when a pending record exists (nothing was in flight). Mutation: label every
   unanswered call "Interrupted" → fail.
3. **Crash mid-tool (no pending).** `durable` was captured while `c1` (of
   `[c1, c2]`) ran → on reload `c1` gets "Interrupted", `c2` gets "Not run",
   and neither is re-executed.
4. **Steering invariant with persistence.** Copy the macrotask test
   (`integration.test.ts:444-463`) with a `SpyStore` whose `save` never
   resolves until released → `runningAtNextMacrotask.at(-1) === false`.
   **Mutation:** make the turn driver `await persister.flush()` before
   clearing the controller → it must fail.
5. **Enqueue while suspended is durable at ack.** Suspend, send `enqueue`
   → the ack does not resolve before `SpyStore.release()`, and after it
   resolves `durable.turn.steering` contains the text. Mutation: drop the
   flush → the ack resolves while `durable` lacks it → fail.
6. **Idempotency across a restart.** `prompt{turnId:T}`, restart, re-send
   `prompt{turnId:T}` → cached ack, and the model spy is called 0 times.
   Mutation: do not persist `turnIds` → it runs twice.
7. **Pods write nothing.** `createStdioSessionHost` (and the worker host) over
   a temp `configDir`: run a turn, then `<configDir>/daemon` does not exist.
   Plus the type-level fact that `persistence` is absent.
8. **Lock.** A second `startDaemon` on the same `configDir` refuses with the
   pid in the message. A lock holding a dead pid is taken over.
9. **Bad records.** Truncated, wrong `kind` and `schemaVersion: 2` files are
   skipped, reported by path, and left on disk unchanged (byte compare); the
   valid ones still load.
10. **Store failure.** `SpyStore.save` rejects → `onError` is called, no
    `unhandledRejection` (spy on `process.on`), and the turn completes.
11. **P7 pinned.** `createTaskTool(...).permission === "none"`, and
    `classifyPending` returns `false` for a request whose tool differs from the
    current call (sub-agent shape).

**Part B**
12. **The load-bearing property** (agent level, `resume.test.ts`, the
    experiment's scenario). Uninterrupted run A versus suspend → JSON
    round-trip → `Session.resume`. Both of these must hold:
    - history deep-equal to A;
    - model calls after the resume = 1, and its first request ends with
      `tool(c2), tool(c3), user:steer-1`.

    Exec counts are each 1, and `c1` is not re-run. **Mutations:** implement
    `resume` as `send("")` → model-call count and history fail; drop the
    `answered` skip → `c1` runs twice → fail; reset steering in `resume` → the
    steer is missing → fail.
13. **Daemon restart mid-suspension (end to end).** Restart → the session
    reloads, `permission_request` is re-emitted with a nonce ≠ the old one, and
    approving runs the tool **exactly once** (exec spy). The old nonce →
    `PermissionNotPending`.
14. **Cleared before run (B4).** The tool's `execute` reads
    `SpyStore.durable` and records whether `turn.pending` is present → it must
    be absent. Mutation: `schedule` without `flush` → present → fail.
15. **Shape mismatch.** A record whose `pending.toolCallId` is not in the
    trailing assistant → `ResumeShapeError` → falls back to "Not run", logged,
    and nothing executes.
16. **Default path unchanged.** `runMessages` without `opts`: the existing
    `agent.test.ts` / `steering.test.ts` / `permission.test.ts` pass unchanged
    (the refactor guard for `runToolCalls`).

Gate per §4: the narrow files during iteration, then `bun run check`.

### Why, item by item

(Decisions not already argued in the Review.)

- **Why split A/B instead of one task.** Rebuilding a suspension needs a
  requester that works with no connection. Before `permission-events` the only
  requester turns "nobody connected" into a deny (`connection.ts:228-231`),
  which is the one outcome the owner forbade. A alone is still strictly better
  than today: history and acked steers survive, and a suspension is lost
  *visibly* ("Not run") instead of with the whole session. Each half is M, with
  its own red/green property.
- **Why capture the pending record in the requester wrapper, not in the
  agent.** It is the one place that already knows the call id
  (`hosted-session.ts:49`) and runs synchronously at the suspension. Putting it
  in the agent would add daemon concerns to a loop that every runtime shares.
- **Why `resumeFrom` is explicit and validated.** A dangling call has two
  possible meanings: "never authorized" (safe to ask again) and "was running"
  (unsafe to re-run). Only the pending record tells them apart, so the loop must
  never infer it from history alone.
- **Why calls after the pending one are re-run through the gate on resume.**
  They never started, and in an uninterrupted run they would be asked next
  anyway. The experiment shows the same prompts in the same order (B'' vs A).
- **Why `schedule` returns `void`.** The steering invariant has no robust
  test, because it depends on microtask order (`session-event-stream` Review).
  Making the dangerous form (`await persister.schedule`) a type/lint error is
  cheaper and stronger than a comment.
- **Why the build function runs synchronously inside `schedule`.** If the
  snapshot were taken when the I/O starts, later pushes would leak in, and the
  record would not match any cut. Synchronous capture makes each write equal
  the history at its call site.
- **Why flush (await) at exactly two points.** These are the two acks the user
  relies on: "I approved, so it runs once" (B4) and "I queued it, so it is not
  lost" (A5). Everywhere else, latency matters more than the ms-wide window, and
  a crash there loses only what a crash during the write would.
- **Why a separate store directory.** P6: the client uses the same uid in
  `<configDir>/sessions`. One directory would mean two writers racing on one
  file, with different record shapes.
- **Why reconcile honestly instead of dropping the dangling call.** The model
  must know a call was not run, or may have run. `history-validity-invariant`
  reaches the same conclusion (synthesize, don't drop). This reconciler is a
  narrow first instance of it. When that eval lands, its `repairHistory` must
  take the pending call id as an exception (the parent, point 8: "awaiting
  permission" is legitimate), and this function can delegate to it.
- **Why a boot epoch instead of persisting `seq`.** Every streamed chunk
  carries a seq, and persisting each one would mean a write per text delta.
  The epoch makes every pre-restart token invalid for free, and `resync` is
  already the designed path for "your token is useless".
- **Why grants are not persisted (yet).** Losing them only adds prompts.
  Persisting a lasting approval is exactly the kind of state the pod-trust rule
  scrutinises, and it deserves its own review even on `serve`.

## Execution

*(empty — an eval)*

## Review

*— claude-opus-5-5, 2026-10-19*

**Recommend promoting after `session-registry`, before `permission-events`.**
Scope:
- `serve` only: the daemon writes each session's history (and the pending
  permission record, if any) to a store on its host after every committed
  boundary (round end, turn end, compaction — the same cut as
  `session-event-stream`). On startup it reloads sessions as detached.
- **Never `await` the store inside the end-of-turn window.** Steering
  invariant (`agent.ts`, `fix/steering-over-rpc`): no `await` between the final
  steering drain and the turn being marked ended. The turn-end write starts
  *after* the turn is marked ended, or is queued without being awaited in that
  stretch. (The steering task doc says no end-of-turn hook is planned; this
  child is that hook.)
- **Persist the pending steering queue** together with the pending permission
  record, and re-queue it on restart.
- Pod modes unchanged: the laptop persists from `snapshot`; the pod daemon
  stores nothing durable.
- The client still persists its own copy (offline viewing, `--resume` against a
  daemon that lost the session); on re-attach the daemon's copy wins.
- Reuse the session-store code and its durability fixes rather than a second
  store (`docs/eval/session-store-durability.md`: atomic write, schema check).
- AGENTS §7 "persistence lives on the laptop" must be amended to say *where the
  daemon is trusted (`serve`), it also persists* — a rule change, so it rides
  this task's branch with Review (§10).

**Why, item by item.**

- **Why `serve` only, and not pods.** In pod modes the daemon is not trusted
  (AGENTS §7): a record it writes is pod-supplied data. If we reloaded it as
  history we would let whoever controls the pod fabricate a conversation —
  e.g. inject instructions the model then follows on resume. Pods are also
  ephemeral (`run` deletes its pod on exit), so a store there protects nothing.
  On `serve` the host is the user's own machine.
- **Why write at committed boundaries (the stream's cut).** A restored session
  must correspond exactly to some `since` token, so a client re-attaching after
  a restart gets a consistent snapshot + replay. Writing mid-round would store
  half a message the agent cannot resume from.
- **Why reload sessions as detached.** After a restart nobody is attached; the
  idle TTL starts and suspended turns re-emit their `permission_request`, so
  the first client to re-attach sees the pending approval.
- **Why the client still keeps its own copy.** Offline viewing (phone in
  airplane mode), and recovery when the daemon lost the session (pods, disk
  loss) via `open{messages}`.
- **Why the daemon's copy wins on re-attach.** The daemon executed the turns;
  the client's copy can be behind, never ahead — a client never authors history
  except prompts, which go through the daemon anyway.
- **Why reuse the session-store code.** One durability implementation.
  `session-store-durability` found in-place writes that truncate on crash; a
  second store would re-introduce exactly those bugs.
- **Why amend AGENTS §7 in this task.** Otherwise the next model reads
  "persistence lives on the laptop", sees a daemon store, and removes it as an
  invariant violation.
- **Why the store must not be awaited at turn end.** This child is precisely
  the "async persist at end of turn" the steering invariant forbids. With an
  `await store.save()` between the final drain and "turn ended", a
  `session/enqueue` arriving during the write is accepted (the turn is still
  running), never drained (the drain already happened), and lost when the turn
  ends — silently. Writing after the turn is marked ended costs nothing: the
  data is the same, and a crash in between loses at most what a crash during
  the write would.
- **Why persist the steering queue.** A turn suspended on a permission is
  running, so `enqueue` is accepted and queued for the round after approval.
  The queue lives in memory: a restart during an hours-long suspension would
  drop those messages silently — the bug class steering closed.
- **Why "resume from a pending tool call" is the load-bearing assumption.** If
  the loop cannot resume from "assistant tool call awaiting approval" without
  re-running the model round, a restart re-asks the model: a different tool
  call comes back, and the approval the user is looking at no longer matches
  what would run — plus the cost of the extra round.

Load-bearing assumption to prove first: the persisted history plus the pending
permission record is enough to rebuild a suspended turn — i.e. the agent loop
can resume from "assistant tool call awaiting approval" without replaying the
model round. Verify against `agent/src/agent.ts` (where tool authorization sits
relative to the assistant-message push).

Failure modes: crash mid-write (atomic rename); disk full (surface, keep serving
from memory); two daemons on one store (lock or refuse); a store from an older
protocol version (version the file; refuse or migrate explicitly).

Tests: restart mid-suspension → session reloads, `permission_request`
re-emitted, approving runs the tool once; restart after `turn_end` → history
intact; a pod-mode daemon writes nothing.
