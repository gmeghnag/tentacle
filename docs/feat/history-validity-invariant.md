# feat/history-validity-invariant — should the message history have an enforced well-formedness invariant?

> **Status:** feat — promoted by the owner 2026-11-10 after a live session poison (llama.cpp 500 "Failed to parse tool call arguments as JSON" on every request after one invalid `fs_write` call)
> **Branch:** `feat/history-validity-invariant`
> Type: feat · Size: L · Blast: load-bearing · Suited: DeepSeek exec, one fresh Opus review

## Context

*— claude-opus-5-5, 2026-10-17*

**The question being decided:** is it true that *nothing* guarantees the
`ChatMessage[]` history is well-formed before it is persisted or sent to the
model, and if so, should we add one pure `validateHistory` / `repairHistory`
module applied at the persist boundary, before each model request, and on
resume, instead of fixing each symptom on its own?

"Well-formed" here means what an OpenAI-compatible chat endpoint needs: every
assistant `tool_calls[i].id` is answered by exactly one following `tool`
message before the next non-tool message; no orphan `tool` messages; every
`tool_calls[i].arguments` is valid JSON of bounded size. Two consecutive `user`
messages are allowed, but strict servers may reject them.

### Evidence (source, verified)

- **The assistant turn is committed before its tools run.** `packages/agent/src/agent.ts:244-248`
  pushes `{role:"assistant", toolCalls}`. The matching `tool` messages are pushed
  one at a time at `agent.ts:300`, at the end of the loop body at `agent.ts:283-301`.
  Between the two there are four `await`/`yield` points that can throw or suspend
  forever: `yield tool_start` (:284), the progress drain (:294), `runTool`
  (:293, which calls `gate.authorize` at :424), `transformResult` (:298), and
  `yield tool_result` (:299). No `try`/`finally` in the loop answers the
  outstanding call ids.
- **Persistence runs on every exit path.** `Session.send` persists in `finally`
  (`packages/agent/src/session.ts:69-75`), so a throw *or* a consumer `.return()`
  writes whatever half-built history exists. On the worker/pod path,
  `persistingController` (`packages/cli/src/local-runtime.ts:65-89`) reads the
  daemon `snapshot` in its own `finally` (:79). The client-side `RemoteSession.send`
  (`packages/client/src/remote-session.ts:56-70`) does not cancel the daemon turn
  when its consumer returns early, so that flush can also capture a **mid-turn**
  snapshot (from reading the code; not run).
- **Invalid arguments are stored verbatim.** `ToolCall.arguments` is pushed
  as-is (`agent.ts:244`). `runTool` swallows the parse error (`agent.ts:419-423`),
  and the registry returns a tool error, `invalid JSON arguments` (`packages/tools/src/registry.ts:62-67`).
  The history stays well-paired, but the bad string is kept and re-sent on every
  later request. `toWireMessage` (`packages/providers/src/openai-provider.ts:206-219`)
  is a pure field rename with no checks. It sends `function.arguments` as the stored string.
- **Resume does no repair.** `JsonSessionStore.load` is a bare cast,
  `(await f.json()) as SessionRecord` (`packages/agent/src/session-store.ts:69-78`).
  `SessionHost.create` → `new Session(agent, id, {messages})`
  (`packages/daemon/src/session-host.ts:40`) → `[...options.messages]`
  (`session.ts:38-41`). `grep -rni "validateHistory\|repairHistory\|repair" packages/*/src` finds no
  history validator anywhere.
  > **Update 2026-10-20 (`fix/session-store-durability`):** `load` is no longer a
  > cast: `parseSessionRecord` checks the record and each message's *shape*
  > (strict wire keys, role, string content, 3-key tool calls) and reports a bad
  > file. It does **not** check history *validity* (call/result pairing,
  > argument JSON) — that remains this eval's question, and a repair on resume
  > would sit after `parseSessionRecord`.
- **Producers that are already guarded (these weaken the "realistic trigger" side).**
  - The RPC permission path turns every reject into `cancelled` → `allowed:false`
    (`packages/daemon/src/connection.ts:179-189`).
  - The TUI requester never rejects (`packages/tui/src/permission-ui.ts:81-97`).
  - `ToolRegistry.execute` catches tool throws (`registry.ts:77-81`).
  - `writeSpill` (`agent.ts:403-410`) and `summarizeLargeOutput` (`result-pipeline.ts:222-225`)
    catch their own errors.
  - An abort mid-tool still produces a result for every call (scenario D below).
  So today the dangling-call path needs an **unguarded** throw. Examples: a new
  transform, a requester installed outside these two, `EventQueue`, or a
  consumer-side throw while the generator is suspended at a `yield`, such as
  `HostedSession.emit` → `peer.notify` → `channel.send` (`packages/transport/src/peer.ts:146-148`,
  which does not catch).

### Repro (throwaway, outside the repo)

Script: `/private/tmp/claude-501/-Users-gmeghnag-tentacle/940cbe8a-0696-4371-ac65-d55e244ce698/scratchpad/hv.ts`.
It drives real `Agent` + `Session` + `ToolRegistry` + `OpenAIProvider` (with
injected `fetch`) through a scripted fake model, and dumps the `onPersist`
snapshot. Actual output:

```
A. permission requester throws
  [A] send threw: Error: requester boom
  [A] persisted: user -> assistant[tool_calls:c1]
B. result transform throws
  [B] send threw: Error: transform boom
  [B] persisted: user -> assistant[tool_calls:c1]
C. consumer breaks after tool_start (2 calls in one turn)
  [C] persisted: user -> assistant[tool_calls:c1,c2]
D. abort mid-tool (falsification: should NOT dangle)
  [D] persisted: user -> assistant[tool_calls:c1,c2] -> tool(for c1) -> tool(for c2)
E. invalid-JSON / oversize arguments persisted verbatim
  [E] persisted: user -> assistant[tool_calls:c1] -> tool(for c1) -> assistant
  [E] stored args (len 76): {"path":"a","new_string":"""""""""""""""...  JSON.parse ok? false
  [E] tool result: invalid JSON arguments for t
F. resume poisoned history (A) + next turn → wire payload via OpenAIProvider
  [F] wire roles: user -> assistant[tool_calls:c1] -> user -> user -> user
  [F] tool messages answering c1: 0
G. /compact on poisoned history (rescue path?)
  [G] summariser request roles: system -> user ; after compact: user (before=2, after=1)
  [G] after next send-style push: user -> user  (consecutive user msgs)
H. consumer throws AT the tool_result yield (tool already ran; e.g. sink/emit throws)
  [H] send threw: Error: sink boom
  [H] persisted: user -> assistant[tool_calls:c1]
  [H] tool executed 1x, but its result is not in history
```

### Veracity per sub-claim

| # | Sub-claim | Verdict | Decisive evidence |
|---|---|---|---|
| 1 | Assistant `toolCalls` are pushed before tools run; a throw in between leaves dangling calls | **CONFIRMED** | A, B, H: `assistant[tool_calls:c1]` with no `tool(for c1)` |
| 2 | Consumer `.return()` mid-tool leaves dangling calls | **CONFIRMED** (in-process `Session`) | C: both `c1` and `c2` unanswered. H is worse: the tool **ran** (side effect done) but its result was lost |
| 3 | The broken history reaches disk | **CONFIRMED** | `onPersist` snapshot in A/B/C/H. Daemon path: `persistingController` `finally` (code-read) |
| 4 | Resume does no repair | **CONFIRMED** | F: the resumed session sends `tool_calls:c1` with 0 answering `tool` messages. No validator exists in the repo |
| 5 | OpenAI-compatible servers reject it on every later request | **PARTIALLY** | The wire payload is malformed (F). OpenAI's API rejects an unanswered `tool_call_id` with a 400. llama.cpp parses the stored `arguments` as JSON when it applies the chat template, which matches the incident's `500 "parse error col 167795"` for invalid args (E). Not run against a live server; tolerance of dangling ids varies by server and template |
| 6 | Poisoned "until hand-edited with jq" | **PARTIALLY** | G: `/compact` is an unadvertised rescue. `renderMessage` (`packages/agent/src/compact.ts:19-26`) flattens tool calls to `[called: name]` and **drops arguments**, so neither dangling ids nor 167 KB of args reach the summariser. It loses detail, and it depends on a non-empty summary (see `docs/fix/compact-empty-summary-wipe.md`) |
| 7 | Invalid-JSON args are persisted as-is | **CONFIRMED** | E: `JSON.parse ok? false` on the stored string. The 2026-10-16 incident's error column is one past the 167,794-char argument, i.e. unterminated JSON |
| 8 | Oversize args are persisted | **CONFIRMED** (by code; size is irrelevant to the path) | No length check anywhere between the SSE assembly and `agent.ts:244` (TODO "Oversize / degenerate tool-call guard") |
| 9 | Orphan `tool` messages | **NOT REPRODUCED** | No current producer: `agent.ts:300` only answers ids from the same turn. They are reachable only from a hand-edited or corrupted session file loaded on resume (no validation, row 4) |
| 10 | Consecutive `user` messages | **CONFIRMED** (benign today) | G (compact + next send). Also F: a dangling turn plus the next prompt, and `CONTINUE_NUDGE` (`agent.ts:275`) |
| — | Abort mid-tool dangles | **FALSIFIED** (good) | D: every call is answered. Cancellation is not a trigger |

**Severity:** 🟡 medium-high impact, low-to-medium frequency. The impact is
session poisoning. It persists across restarts, survives `--resume`, and also
stays in the daemon's in-memory `Session` for the rest of that process. In H it
also loses a result whose side effect really happened. Frequency is low today,
because every known in-tree throw site is guarded. But the safety comes from
each call site being disciplined, not from any invariant, so the next
unguarded throw or regression re-opens it silently. Invalid/oversize arguments
(rows 7–8) are not hypothetical: they caused the 2026-10-16 incident.

**Triggers (ranked by realism):**
1. The model emits malformed or degenerate `arguments`. This has been observed
   (a repetition loop). The SSE stream truncated by an abort is the sibling case
   in `docs/eval/sse-abort-truncated-toolcall.md`.
2. A consumer-side throw while the generator is suspended at a `yield`, mid-tool.
   For example, `channel.send` throws inside `HostedSession.emit`. That can lose
   an executed tool's result (H).
3. A new or unguarded throw in `authorize` / requester / transform / progress
   (A, B).
4. A hand-edited or corrupted session file on `--resume` (row 9).

## Implementation

*— claude-opus-5-5, 2026-11-10 (revised the same day for the owner's answers: Q1 (b) marker, Q2 (a), Q3 (b) notice, Q4 (b) exception-safe loop)*

**Scope: three parts, implemented in this order.**
- **Part A, the wire repair.** The model's copy of the history is always valid
  (rules 1–6 below). This is what un-poisons the owner's session.
- **Part B, the exception-safe tool loop** (Q4). A throw or a consumer stop
  never leaves an assistant tool call without a result in the **stored**
  history.
- **Part C, the one-time notice** (Q3). The user is told once per session that
  the model was sent a repaired copy.

**The live incident (2026-11-10).** `tentacle connect` → `serve` → llama.cpp
`server-cuda13` with a local Qwen. The model emitted an `fs_write` call whose
`arguments` were invalid JSON (a long file body; "invalid string" at column 1902).
The registry answered `invalid JSON arguments for fs_write`
(`packages/tools/src/registry.ts:80-84`), but the call was committed verbatim
(`packages/agent/src/agent.ts:1166-1170`). `toWireMessage` re-sends it as is
(`packages/providers/src/openai-provider.ts:281-294`, `arguments: tc.arguments`
at :287). Every later request then got llama.cpp `500 "Failed to parse tool call
arguments as JSON … column 1902"`.

**Repro (red, run 2026-11-10, current code).** Script
`.tentacle/tmp/history-validity/repro.ts`. It uses the real `Agent` + `Session` +
`ToolRegistry` + `OpenAIProvider`, against a `Bun.serve` fake. Like llama.cpp, the
fake returns 500 when any `tool_calls[].function.arguments` does not parse to a
JSON object. Turn 1: the model calls `fs_write` with
`{"path":"a.txt","content":"line1\nunterminated`. Turn 2: "hey".

```
[write a file] tool_result {"content":"invalid JSON arguments for fs_write","isError":true}
[write a file] THREW: ModelRequestError: … status 500: {"error":{"code":500,"message":"Failed to parse tool call arguments as JSON: …
[hey] THREW: ModelRequestError: … status 500: {"error":{"code":500,"message":"Failed to parse tool call arguments as JSON: …
stored args: "{\"path\":\"a.txt\",\"content\":\"line1\nunterminated"
```

The poison hits even earlier than the incident report says. The very next
round of the **same** turn fails, so the model never gets to retry. Every
later turn fails too.

### Load-bearing assumption

**Repairing only the request's copy of the history is enough. The stored history
can stay verbatim, because the server rejects only what is in the request body.**
In this codebase, the request body is built from the session history at exactly
three sites. All three are in `Agent`, and all three use `messages.map(renderForModel)`:
- `agent.ts:1105`: each round. The request is streamed at `:1117`.
- `agent.ts:1292`: the final no-tools round at `max_iterations`. It is streamed at `:1309`.
- `agent.ts:1422`: `contextUsage`, the exact count. For llama.cpp this is
  `POST /apply-template` (`openai-provider.ts:143-173`), which parses the same
  arguments.

So a repair at those three sites reaches every runtime: worker, pod, `serve`,
`connect`, and sub-agents (`subagent.ts:380` builds a child `Agent`).

**Proved: yes.**
- *Statically*, `rg '\.stream\(|countTokens\('` over `packages/*/src` finds
  only these other request sites, and none of them sends history tool calls:
  - `compact.ts:77,115`: the summariser input is flattened by `renderMessage`
    (`compact.ts:25-33`), which keeps only call **names** (`[called: …]`) and drops arguments.
  - `hosted-session.ts:2451`: the title job, built from the user's input only.
  - `remote-client.ts:2716,2926`: the laptop relay of a pod's `model/stream`. It
    forwards a request that one of the three Agent sites built in the pod.
- *Empirically*, `.tentacle/tmp/history-validity/cure.ts` is the repro above with
  one change: the model is wrapped so that only the **request's** copy has
  non-object arguments replaced by `"{}"`. The stored history is not touched.
  The Q1 (b) marker is just as much a plain JSON object, so the proof carries
  over: the fake server's check (`JSON.parse` → plain object) accepts it.
  Output:
  ```
  [write a file] tool_result {"content":"invalid JSON arguments for fs_write","isError":true}
  [write a file] text {"type":"text","delta":"reply 2"}
  [write a file] turn_end {"type":"turn_end","reason":"end_turn"}
  [hey] text {"type":"text","delta":"reply 3"}
  [hey] turn_end {"type":"turn_end","reason":"end_turn"}
  stored args: "{\"path\":\"a.txt\",\"content\":\"line1\nunterminated"
  ```
  The same turn continues, the next turn works, and the stored bytes are unchanged.

**Part B also rests on one language fact. It was proved by running it.** A
`finally` in a generator that is delegated through `yield*` runs to
completion before any of the following happens:
- (1) the generator's own throw reaches the consumer's `catch`;
- (2) a throw in the consumer's `for await` body reaches the consumer's
  `catch` (`for await` calls `return()`, which runs the inner `finally`);
- (3) the outer generator's `finally` runs.

Script: `.tentacle/tmp/history-validity/finally-order.ts`. It has the shape
`runToolCalls` ⊂ `Session.send` ⊂ `HostedSession.drive`. Output:

```
throw/null:          consumer got tool_start → inner finally (push synthesized answers) → outer finally (Session persist) → consumer catch: authorize boom
yield/tool_result:   consumer got tool_start → consumer got tool_result → inner finally (push synthesized answers) → outer finally (Session persist) → consumer catch: sink boom
yield/tool_start:    consumer got tool_start → inner finally (push synthesized answers) → outer finally (Session persist) → consumer catch: sink boom
```

This means answers pushed in `runToolCalls`'s `finally` are already in
`session.messages` when two things happen:
- `Session.send`'s `finally` persists (`packages/agent/src/session.ts:148-160`);
- `HostedSession.drive`'s `catch` runs `closeFailedTurn` and then `finishTurn`
  (`packages/daemon/src/hosted-session.ts:2235-2248`).

### Preconditions

- **P1. No producer puts a non-`tool` message inside a tool block.** Here a
  "tool block" means an assistant message with `toolCalls`, followed by its
  `tool` results.
  - Every `role:"user"` push in `agent.ts` sits outside `runToolCalls`:
    `:1027-1085` (iteration top), `:1204/:1227/:1247` (no-call rounds),
    `:1287/:1346` (final round), and `flushAgentMessages`/`flushBackgroundExits`
    (`:2080-2175`), which are called at the iteration top (`:1091`).
  - Inside a round, the only pushes are `tool` messages: `:1538`, `:1593`,
    `:1717`, `:1786`, `:1890`.
  - The reload already treats "a note after a suspended turn's unanswered calls"
    as an invalid history (`packages/daemon/src/persisted-session.ts:348-354`).
  - So "a tool block is the maximal run of `tool` messages right after its
    assistant" matches every producer's history.
- **P2. Dangling calls are already closed honestly on reload, in the stored
  history.** See `reconcileOnReload` → `labelUnansweredCalls`
  (`persisted-session.ts:395-440`, `:240-256`), with notes `NOT_RUN_NOTE` /
  `INTERRUPTED_NOTE` (`:199-216`).
  - A **suspended** turn's dangling calls must stay dangling in storage. This is
    what lets it resume (`resumableTurn` `:341-373`, `suspendedCalls`
    `packages/agent/src/resume.ts:21-44`).
  - So the new repair must **never** write to the stored history. If it did, it
    would answer a resumable turn's calls and break resume.
- **P3. The stored format already accepts any argument string.** `ToolCall.arguments`
  is `z.string()` (`packages/protocol/src/model.ts:16`, `session.ts:31`), and the log
  entry stores it as is (`protocol/src/session-log.ts:329,345`). A poisoned session
  therefore loads today (the owner's "hey" did reach the model), so no parse or
  format change is needed for it to load.
- **P4. Rendering is per message.** `renderForModel` (`context-awareness.ts:50-56`)
  maps each message on its own. A repair that runs *before* it, on the whole
  list, composes cleanly.
- **P5. The steering window (§7) is not involved.** The three sites build the
  request synchronously, before the stream or count `await`. None of them is in the
  drain → `turn_end` stretch (`agent.ts:1209-1222`). The repair is synchronous and
  adds no `await`.
- **P6. The registry and the Anthropic provider already read `""` as `{}`**
  (`registry.ts:81`, `anthropic-provider.ts:420-432`). The Anthropic provider
  already turns unparseable arguments into `{}`. However, it sends *non-object*
  JSON such as `[]` or `"x"` as is, and `tool_use.input` must be an object. The
  OpenAI provider sends `""` and bad JSON verbatim. By code reading (not run
  live), llama.cpp's `json::parse("")` throws, so `""` is a latent poison too.
- **P7. A call waiting on a permission ask is an `await`, not an exit.**
  `authorizeCall` awaits `gate.authorize` (`agent.ts:2284`). Nothing calls
  `.return()`/`.throw()` on an agent generator (`rg '\.return\(|\.throw\('`
  over `agent`/`daemon`/`client`/`cli` src finds nothing). A consumer can only
  stop the generator while it is suspended at a `yield`.
  - So a turn suspended on an ask runs no `finally`. It stays suspended, and a
    process death leaves exactly the shape the reload resumes (P2).
  - The Part B `finally` runs only on a real abnormal exit: a throw, or a
    consumer stop at a `yield`.
- **P8. Cancellation already answers every call on the NORMAL path.**
  - Alone calls: `agent.ts:1532-1550`.
  - `authorizeCall` returns `done`+cancelled (`:2290-2301`).
  - Groups: `:1655-1657`, `:1688-1696`, `:1753-1763`.
  - Eval scenario D: `close()` aborts the controller, then calls `finishTurn`
    synchronously (`hosted-session.ts:2759-2779`). The generator then unwinds
    through these normal paths.
  - So Part B must be a no-op on every normal return, cancel included. It is
    gated by a `settled` flag (Design, Part B).
- **P9. `authorizeCall` never runs the tool** (`agent.ts:2271`, "Never runs the
  tool"). The tool runs only in `executeCall` (`:2322-2342`), and it is reached
  only from `:1573` (alone) and `runPrepared` (`:1829-1836`, groups).
  - So "this call started" is exactly "`executeCall`/`runPrepared` was called
    for it".
  - A call not marked started has certainly not run. This makes the "Not run"
    note honest.
- **P10. The protocol rule for a new update.** A `display` update needs:
  - a union member in `SessionUpdateSchema` (`packages/protocol/src/updates.ts:325-350`);
  - an `UPDATE_CLASS` entry (`:363-399`; a `Record`, so a missing entry is a compile error);
  - the daemon mapping (`packages/daemon/src/mapping.ts`, `eventToUpdate`, e.g. `:246-247`);
  - the client reverse mapping (`packages/client/src/mapping.ts:288-289`).

  An older client skips an unknown `display` kind and reports `unsupported`
  once (AGENTS §7). So a display-only addition needs **no** `PROTOCOL_VERSION`
  bump (currently `21`, `packages/protocol/src/version.ts:17`).
  - The committed `packages/protocol/schema/protocol.json` is drift-gated
    (`packages/protocol/test/json-schema.test.ts:38-39`). Regenerate it with
    `bun run schema:export`.
  - `AgentEvent` switches are exhaustive in four places:
    `daemon/src/mapping.ts`, `client/src/mapping.ts`, `cli/src/render.ts:53`,
    and `tui/src/state.ts:488`. `tsc` flags each one.

### Design

**Where the invariant is enforced: decided.**

| Boundary | Enforce? | Why |
|---|---|---|
| **Wire** (the 3 Agent request sites) | **Yes. This is the invariant.** | Proved sufficient (above). It protects every runtime and also heals history that is already poisoned, because every request goes through it. It is deterministic, so a given history always renders the same bytes and the provider prompt cache holds (`agent.ts:1101-1103`). |
| **Provider** (`toWireMessage`, Anthropic `parseArgs`) | **Yes, syntax only** (args → a JSON-object string). | This is a last line of defence for requests the local Agent did not build: the relay of a pod's `model/stream` (`remote-client.ts:2716`), from an older or untrusted pod daemon. It adds no note and does no pairing work. |
| **Persist** (laptop `<uid>.jsonl`, `serve` store) | **No.** | The log is the record of what happened. §7: content is "never silently lost". Replacing the model's bytes at persist would drop them, and a changed entry would force a segment rewrite of the user's file. The wire repair makes the stored bytes harmless. |
| **Load / resume** | **No** (no destructive repair; P2 already closes cut turns honestly). | Repairing on load would answer a **suspended** turn's dangling calls and break resume (P2). It would also diverge the daemon's copy from the laptop's. The owner's poisoned session recovers with **zero** on-disk edits, because its next request goes through the wire repair (Tests T3/T4). |

**The pure module.** It goes in `packages/core/src/history-validity.ts`. It is
React-free and I/O-free, depends only on `ChatMessage`/`ToolCall` from
`./model.ts`, and is exported from `packages/core/src/index.ts`. It lives in
`core`, not `agent`, because `@tentacle/providers` depends on `@tentacle/core`
only (`packages/providers/package.json`), and both layers call it.

```ts
export type HistoryIssue =
  | { readonly kind: "empty_arguments"; readonly index: number; readonly callId: string }
  | { readonly kind: "invalid_arguments"; readonly index: number; readonly callId: string; readonly bytes: number }
  | { readonly kind: "unanswered_call"; readonly index: number; readonly callId: string }
  | { readonly kind: "orphan_tool_result"; readonly index: number; readonly toolCallId: string | undefined };

/** The marker that stands in for invalid arguments (owner Q1 (b)). */
export function invalidArgumentsMarker(bytes: number): string; // JSON.stringify({ _invalid_arguments: true, bytes })
/**
 * `raw` if it parses to a plain JSON object (non-null, non-array);
 * `"{}"` if `raw.trim() === ""`; otherwise `invalidArgumentsMarker(utf8Bytes(raw))`.
 */
export function wireArguments(raw: string): string;
/** The repaired copy + what was repaired. Returns the INPUT array itself when there is nothing to repair. */
export function repairHistory(messages: readonly ChatMessage[]): {
  readonly messages: readonly ChatMessage[];
  readonly issues: readonly HistoryIssue[];
};
/** `repairHistory(messages).issues` — one implementation, so the two can never disagree. */
export function validateHistory(messages: readonly ChatMessage[]): readonly HistoryIssue[];
export function invalidArgumentsNote(bytes: number): string;
export const UNANSWERED_CALL_NOTE: string;

/** What the user is told (Part C): counts of the issues that change what the model sees. */
export interface RepairCounts {
  readonly invalidArguments: number;
  readonly unansweredCalls: number;
  readonly orphanResults: number;
}
/** `null` when all three are 0 (`empty_arguments` is NOT counted: it is no error). */
export function repairCounts(issues: readonly HistoryIssue[]): RepairCounts | null;
/** The one notice line, shared by the TUI and the plain CLI renderer (Part C). */
export function describeRepairs(counts: RepairCounts): string;

/**
 * Part B: the tool messages that answer every call of `calls` still unanswered
 * in `owner`'s block, `noteFor(call)` as content, in call order. `[]` when
 * `owner` is no longer in `messages` (a context reset replaced the history) or
 * when anything other than `tool` messages follows it (never create an orphan;
 * the wire repair covers such a history).
 */
export function answerOutstandingCalls(
  messages: readonly ChatMessage[],
  owner: ChatMessage,
  calls: readonly ToolCall[],
  noteFor: (call: ToolCall) => string,
): ChatMessage[];
```

**Repair rules.** These are exact. `index` is the position in the **input**.
1. **Arguments.** Each `toolCalls[k].arguments` → `wireArguments(raw)`.
   - If `raw.trim() === ""`, the result is `"{}"`. The issue is
     `empty_arguments` and gets no note. The registry and the Anthropic provider
     already treat `""` as `{}`, so this is not an error.
   - If `raw` is not empty and does not parse to a plain object, the result is
     the **marker** and the issue is `invalid_arguments` (owner Q1 (b)).
     - The marker is exactly `JSON.stringify({ _invalid_arguments: true, bytes })`,
       i.e. `{"_invalid_arguments":true,"bytes":1902}`. The key order is fixed:
       `_invalid_arguments` first, then `bytes`.
     - `bytes` is the UTF-8 length of `raw`: `new TextEncoder().encode(raw).length`.
     - The marker is a plain JSON object, so it passes `wireArguments` unchanged.
       This keeps the repair idempotent (rule 6), and the provider guard does
       not rewrite an already repaired request.
   - Only the **copy** of the assistant message changes. The input objects are
     never mutated.
2. **Telling the model.** In the copy, the paired `tool` message of an
   `invalid_arguments` call gets `"\n\n" + invalidArgumentsNote(bytes)`
   appended to its `content`. The note text is exactly:
   `[history: this call's original arguments (N bytes) were not a valid JSON object, so this copy of the conversation shows {"_invalid_arguments":true,"bytes":N} in their place. That marker is not a tool input: never send it as arguments.]`
   - The last sentence is there because the model sees the marker as something
     it "called", and the owner accepted that risk.
   - If the model imitates the marker anyway, it is a valid object. The tool's
     schema rejects it (`registry.ts:86-92`), so the wire stays valid.
   - The note does **not** claim the call did not run. An MCP tool with a
     permissive schema may run on `[]`. The paired result, which the registry
     wrote, already says what happened.
   - A synthesized error is never phrased like a success. This is the eval's
     honesty requirement.
3. **Unanswered call.** A tool block is the assistant message plus the maximal
   run of `tool` messages right after it (P1). Each call that no message in its
   block answers gets a synthesized message:
   `{role:"tool", toolCallId, content: UNANSWERED_CALL_NOTE}`. These go at the end
   of the block, in call order. If the call's arguments were also invalid, the
   content is `UNANSWERED_CALL_NOTE + "\n\n" + invalidArgumentsNote(bytes)`.
   - `UNANSWERED_CALL_NOTE` is
     `"Interrupted: no result was recorded for this call; it may or may not have run. Check before retrying."`.
     This matches the wording of `INTERRUPTED_NOTE` (`persisted-session.ts:202`).
     Core cannot import from daemon, so this is a separate constant.
4. **Orphan tool message.** These are dropped from the copy:
   - a `tool` message outside any block;
   - a `tool` message in a block whose `toolCallId` is undefined, not one of the
     block's call ids, or already answered earlier in the block (a duplicate).

   Each one is an issue. The stored message is untouched.
5. **Consecutive same-role messages.** These are left alone. No issue is raised.
   The OpenAI-compatible servers in use accept them (eval row 10). If a strict
   template ever rejects them, a capability flag can be added later (Notes).
6. **Idempotent and minimal.**
   - `repairHistory(repairHistory(x).messages).issues` is empty.
   - `validateHistory(repairHistory(x).messages)` is empty.
   - A valid history returns **the same array reference** with no issues, so the
     payload is byte-identical and the prompt cache holds.

**Wiring in the agent (Part A).** Add one helper next to `renderForModel` in
`packages/agent/src/context-awareness.ts`:

```ts
/** The model's copy of the history: repaired for the wire (repairHistory), then rendered; plus what to tell the user. */
export function modelView(history: readonly ChatMessage[]): {
  readonly messages: ChatMessage[];
  readonly repairs: RepairCounts | null;
} {
  const repaired = repairHistory(history);
  return { messages: repaired.messages.map(renderForModel), repairs: repairCounts(repaired.issues) };
}
```

Change these three sites, and no others:
- **`agent.ts:1104-1109`**, the round request.
  - Before building `request`, add `const view = modelView(messages);`.
  - Build `request` with `messages: view.messages`.
  - Right after the `request` object, and before `const sent = messages.length`
    (`:1110`), add:
    `if (view.repairs) { yield { type: "history_repaired", ...view.repairs }; }`.
- **`agent.ts:1291-1292`**, the final no-tools round. The same change:
  `const view = modelView(messages);`, then `...view.messages` replaces
  `...messages.map(renderForModel)`.
  - Add the same `if (view.repairs) yield …` right before `finalMessages` is
    built. The code is inside the `try` at `:1290`, which is fine: a yield of a
    display event cannot throw a model error.
- **`agent.ts:1422`**, `contextUsage` (not a generator).
  - Use `messages: modelView(messages).messages`.
  - It yields nothing; the notice comes from the next round.

Further rules for these sites:
- The estimate (`estimateUsed`, `context-awareness.ts:87-101`) stays on the
  stored history (F8).
- `notifyModelRequest` (`agent.ts:1115`) then sees the repaired request, which
  is the request actually sent.
- The new `yield`s carry no history change, so they are not a `history_commit`
  point. They sit before the stream's `await`, outside the drain → `turn_end`
  stretch (`:1209-1222`), so the steering invariant is untouched (P5). The
  existing `midNotes` yields at `:1094-1096` are the same kind of pre-request
  yield.

**Provider guard (Part A).**
- `toWireMessage` (`openai-provider.ts:287`): change
  `arguments: tc.arguments` to `arguments: wireArguments(tc.arguments)`.
  - This yields the same marker as the Agent repair: one function, so the bytes
    are identical.
  - On an already repaired request it changes nothing.
- `parseArgs` (`anthropic-provider.ts:420-432`): return `{}` for a parsed value
  that is not a plain object.
  - Anthropic's `tool_use.input` is an object, and the Agent's copy already
    holds the marker object, so this only touches requests the Agent did not
    build.
  - Fix its comment. "The agent loop guarantees parseable arguments" is false
    today; after this change, the Agent's wire repair guarantees it.

**Part B: the exception-safe tool loop (owner Q4).** All of it goes in
`packages/agent/src/agent.ts`, with the pure helper `answerOutstandingCalls` in
core.

1. **Two notes**, added next to `CANCELLED_TOOL_NOTE` (`agent.ts:190-192`).
   Both are error-phrased and never read as a success:
   ```ts
   /** A call the turn's unexpected stop reached before it started (P9: certainly not run). */
   const TURN_STOPPED_NOT_RUN_NOTE =
     "Not run: the turn stopped unexpectedly before this call started. Ask again if it is still needed.";
   /** A call that had started when the turn stopped unexpectedly: its result was not recorded. */
   const TURN_STOPPED_INTERRUPTED_NOTE =
     "Interrupted: the turn stopped unexpectedly after this tool started; its result was not recorded. It may have completed — check before retrying.";
   ```
   - The cause is **not** in the note. The `finally` cannot see the error, and
     a raw error may carry secrets.
   - `drive`'s `catch` appends the redacted cause as the assistant's
     `Failed: …` note, through `closeFailedTurn`
     (`hosted-session.ts:2240-2243`, `persisted-session.ts:280-289`). That
     function pushes an assistant message after a trailing `tool` message
     (`:286-287`), so the roles stay valid.
2. **`runToolCalls`** (`agent.ts:1466-1598`). Wrap the whole body after
   `const round = planRound(...)` (`:1503-1508`) in
   `try { … } finally { … }`, with these locals declared before the `try`:
   ```ts
   const owner = messages.findLast(
     (m) => m.role === "assistant" && (m.toolCalls ?? []).some((c) => c.id === calls[0]?.id),
   );
   const started = new Set<string>();   // ids whose executeCall/runPrepared was invoked (P9)
   let inHand: ChatMessage | undefined; // an alone call's finished message, between its tool_result yield and its push
   let settled = false;                 // set immediately before every normal `return`
   ```
   Changes inside the body:
   - At `:1527`, `return "context_reset"` becomes
     `settled = true; return "context_reset";`.
   - At `:1597`, `return undefined` becomes `settled = true; return undefined;`.
   - At `:1573`, put `started.add(call.id);` on the line **before**
     `const resultPromise = this.executeCall(prepared, ctx)…`.
   - At `:1585-1595`, after `const result = keepDenialReply(raw, transformed);`:
     1. add `const message = toolMessage(call.id, result, durationMs); inHand = message;`;
     2. keep the `yield { type: "tool_result", … }` as is;
     3. replace `messages.push(toolMessage(call.id, result, durationMs));` with
        `messages.push(message); inHand = undefined;`;
     4. keep the `history_commit` yield after it.

     The event order is unchanged: `tool_result`, push, `history_commit`.
   - Pass `started` to `runGroup` (a new last parameter) at `:1512`.

   The `finally`. It has **no `yield` and no `await`**: synchronous pushes only.
   ```ts
   } finally {
     if (!settled && owner !== undefined && messages.lastIndexOf(owner) !== -1) {
       if (inHand !== undefined) {
         messages.push(inHand); // H: the REAL result, already transformed (redaction/spill applied)
       }
       messages.push(
         ...answerOutstandingCalls(messages, owner, calls, (c) =>
           started.has(c.id) ? TURN_STOPPED_INTERRUPTED_NOTE : TURN_STOPPED_NOT_RUN_NOTE,
         ),
       );
     }
   }
   ```
   - Why `owner` is checked by identity: a context reset replaces `messages` in
     place (`:1998-1999`). If an abnormal exit happens after that commit, it
     must not append answers to the fresh history. The old assistant is gone,
     so `lastIndexOf` is `-1` and nothing is pushed.
   - Why only an **untransformed** result is never pushed (scenario B, a
     transform throws): the transforms carry redaction and spill. Pushing the
     raw output could leak what a transform exists to hide. Such a call is
     `started`, so it gets `TURN_STOPPED_INTERRUPTED_NOTE`.
3. **`runGroup`** (`agent.ts:1627-1792`).
   - Add the parameter `started: Set<string>`.
   - Add `started.add(prepared.call.id);` as the **first statement** of
     `runPrepared` (`:1829-1836`), before its `await`, and add `started` as its
     new parameter. Pass it through at `:1708` and `:1749`.
   - Wrap the body after the `answer` helper (`:1641-1650`) in
     `try { … } finally { … }`, with
     `const pushed = new Set<number>(); let groupSettled = false;` declared
     before it.
     - At `:1717`, after the push, add `pushed.add(index);`.
     - Before the `return` at `:1722`: `groupSettled = true;`.
     - In the final loop `:1783-1788`, add `pushed.add(index)` after each push.
       After the loop, and **before** the `history_commit` yield at `:1791`, add
       `groupSettled = true;`.
   - The `finally`, again with no `yield` and no `await`:
     ```ts
     } finally {
       queue.close(); // idempotent (event-queue.ts:24-34); late completions are dropped (push after close is a no-op, :11-14)
       if (!groupSettled) {
         for (const [index, call] of calls.entries()) {
           const run = answered.get(index);
           if (run !== undefined && !pushed.has(index)) {
             messages.push(toolMessage(call.id, run.result, run.durationMs));
           }
         }
       }
     }
     ```
   - This keeps the results the clients **already saw**. Their `tool_result`
     was yielded through `answer`, and the result is transformed, because
     `finishCall` (`:1844-1867`) never throws. Calls without a result are then
     answered by `runToolCalls`'s `finally`: "Interrupted" if `started`, else
     "Not run".
   - A call of phase 2 that is still running keeps running in the background,
     exactly as today. Its late result is dropped by the closed queue, and its
     note says "may have completed" (Notes/debt).
4. **`runUserSkill`** (`agent.ts:2019-2072`) has the same shape: it pushes the
   assistant at `:2026`, then yields.
   - Declare `const owner = messages.at(-1);` right after the push at `:2026`.
     Also declare `let inHand: ChatMessage | undefined; let settled = false;`.
   - Wrap `:2027-2071` in `try/finally`.
   - Keep the `toolMessage(...)` in `inHand` across the `tool_result` yield
     (`:2063-2070`), with the same pattern as in step 2.
   - Set `settled = true` after the final `history_commit` yield.
   - In the `finally` (no yield, no await): `if (!settled && owner && messages.lastIndexOf(owner) !== -1)`,
     push `inHand` if set, then
     `answerOutstandingCalls(messages, owner, [call], () => TURN_STOPPED_INTERRUPTED_NOTE)`.
     A skill read has no "not started" window worth distinguishing: it is a
     read, so "Interrupted" is the conservative choice.
5. **Not changed:**
   - `runContextReset`. An abnormal exit inside it is answered by
     `runToolCalls`'s `finally`: "Not run", because a reset is never `started`.
     After its commit the owner is gone, so nothing is pushed.
   - The cancel paths (P8).
   - `authorizeCall`.
   - The resume seam (`runMessages` with `resumeFrom`, `agent.ts:981`). It
     calls `runToolCalls` with the remaining calls, and `owner` is then the
     existing assistant message, found by the first remaining call's id.

**How Part B interacts with the rest:**
- **Cancel.** It has no effect. A cancel ends through the normal paths (P8), so
  `settled` is `true` and the `finally` does nothing. T5f pins that the
  history is byte-identical to today's (eval scenario D).
- **Permission asks.** A pending ask is an `await`, and no `finally` runs (P7).
  The turn stays suspended; on a reload it is resumed or closed by P2,
  unchanged.
  - An ask that **rejects** is scenario A. Today the RPC path turns a reject
    into `cancelled` (`daemon/src/connection.ts`), so a reject is possible only
    from a requester installed elsewhere. The call is answered "Not run", and
    the error goes on to `drive`.
- **Parallel calls.** Covered by step 3: results already seen are kept, and
  the others get "Interrupted" or "Not run". The `started` set is shared
  between the alone path and the group path, so every call of the round is
  classified once.
- **The steering window.** The `finally` blocks run only on abnormal exits.
  Those never reach the drain → `turn_end` stretch, which lives in
  `runMessages` *after* `runToolCalls` returned (`agent.ts:1209-1252`). They
  have no `await`, so no macrotask can interleave.
- **Persistence.** The pushed answers are in `session.messages` before the
  error reaches either consumer (proved above).
  - In-process `Session.send` persists them in its `finally` (`session.ts:156-160`).
  - `serve`/`drive` runs `closeFailedTurn`, then `finishTurn`, which moves the
    cut and persists (`hosted-session.ts:2240-2248`).
  - The laptop's copy reads them from `session/log` at turn end, like any
    `tool` message.
  - No `history_commit` is yielded from a `finally`, because a `finally`
    cannot yield. The cut moves at `finishTurn`.
  - If the process dies between the push and that persist, the last persisted
    cut lacks the answers. The reload then labels the dangling calls (P2), so
    it converges either way.
  - These are plain `tool` messages, so there is no new log entry type and no
    format change.

**Part C: the one-time notice (owner Q3).** A new `display` update,
`history_repaired`, is sent at most **once per loaded session**.

1. **Agent event** (`agent.ts`, the `AgentEvent` union at `:302`). Add this
   member, next to `context_note` (`:375-378`):
   ```ts
   // The model was sent a repaired copy of the history (docs/feat/history-validity-invariant.md).
   // Display only: no history change, never a commit point.
   | {
       readonly type: "history_repaired";
       readonly invalidArguments: number;
       readonly unansweredCalls: number;
       readonly orphanResults: number;
     }
   ```
   It is yielded by Part A's two generator sites whenever `view.repairs` is
   not `null`, which can be every round. The deduplication is in the daemon
   (step 3), which outlives an agent swap (`assertIdle` + `updateSettings`
   swap the agent, `hosted-session.ts:2138-2149`).
2. **Protocol** (`packages/protocol/src/updates.ts`). Add:
   ```ts
   /**
    * The model was sent a repaired copy of the session's history (invalid tool
    * arguments replaced by a marker, unanswered calls answered, stray tool
    * results left out; docs/feat/history-validity-invariant.md). The stored
    * history is unchanged. Sent at most once per loaded session. Display only.
    */
   export const HistoryRepairedSchema = z.object({
     type: z.literal("history_repaired"),
     invalidArguments: z.number().int().nonnegative(),
     unansweredCalls: z.number().int().nonnegative(),
     orphanResults: z.number().int().nonnegative(),
   });
   ```
   - Add it to `SessionUpdateSchema` (`:325-350`).
   - Add `history_repaired: "display",` to `UPDATE_CLASS` (`:363-399`), with
     the comment `// A notice; nothing waits on it (the repair is in the model's copy only).`
   - Export it like its siblings.
   - Run `bun run schema:export` and keep the regenerated
     `packages/protocol/schema/protocol.json`.
   - **No `PROTOCOL_VERSION` bump** (P10): the update is display-only, and an
     older client skips it with `unsupported` once.
3. **Daemon** (`packages/daemon/src/hosted-session.ts`).
   - Add the field `private historyRepairNoticed = false;`.
   - In `drive` (`:2169-2232`), before `const update = eventToUpdate(named);`
     (`:2224`), add:
     ```ts
     if (event.type === "history_repaired") {
       if (this.historyRepairNoticed) {
         continue;
       }
       this.historyRepairNoticed = true;
     }
     ```
     This is synchronous, adds no `await`, and keeps the drive-loop invariant
     (`:2155-2161`).
   - In `packages/daemon/src/mapping.ts` `eventToUpdate`, add
     `case "history_repaired": return { type: "history_repaired", invalidArguments: event.invalidArguments, unansweredCalls: event.unansweredCalls, orphanResults: event.orphanResults };`.
   - **"Once per session" means once per `HostedSession` instance**: per
     process lifetime of a loaded session. A daemon restart or a reopen notifies
     again, once.
     - Persisting the flag would need a sidecar field, i.e. a
       `DAEMON_STATE_VERSION` change, for a pure notice. Not done.
     - A sub-agent's own repairs are not surfaced. `subagent.ts:454-470`
       handles child events with an `if` chain, so the new type is ignored
       there; this is debt.
     - In `run`/`attach` the notice comes from the pod's daemon. It is
       display-only and has no laptop effect, so the "a pod is not trusted"
       rule needs no gate.
4. **Client** (`packages/client/src/mapping.ts`, the update → `AgentEvent`
   switch at `:288`). Add
   `case "history_repaired": return { type: "history_repaired", invalidArguments: update.invalidArguments, unansweredCalls: update.unansweredCalls, orphanResults: update.orphanResults };`.
   It is turn-scoped, like `context_note`, so it rides the turn's event stream.
5. **TUI** (`packages/tui/src/state.ts`, the reducer's `AgentEvent` switch next
   to `case "context_note"` at `:488`). Add
   `case "history_repaired": return appendNotice(state, describeRepairs(event));`.
   - `appendNotice` is at `:172-184`. `describeRepairs` comes from `@tentacle/core`.
   - The rendering is the existing notice row. No component changes.
6. **Plain CLI renderer** (`packages/cli/src/render.ts`, the switch at
   `:53`). Add `case "history_repaired": return \`\n${describeRepairs(event)}\n\`;`.
7. **`describeRepairs` text** (core). It joins the non-zero parts with `", "`:
   - `N tool call(s) with invalid arguments`
   - `N unanswered tool call(s)`
   - `N stray tool result(s)`

   It is singular for 1 and plural otherwise ("1 tool call", "2 tool calls").
   The whole line:
   `history repaired for the model: <parts> — the saved session is unchanged`.
   Example: `history repaired for the model: 1 tool call with invalid arguments — the saved session is unchanged`.

**Not changed.**
- Persisted format: no change. No `schemaVersion` / `DAEMON_STATE_VERSION`
  bump. Part B's answers are ordinary `tool` messages, and Part C's flag is
  in memory.
- Protocol: one additive **display** update, so no `PROTOCOL_VERSION` bump.
- The registry's error text: unchanged.

### Files

In dependency order. Each file is followed by its test, which is run red
first.

| # | File | Change | Test |
|---|---|---|---|
| 1 | `packages/core/src/history-validity.ts` (new) | The pure module: `invalidArgumentsMarker`, `wireArguments`, `repairHistory`, `validateHistory`, `invalidArgumentsNote`, `UNANSWERED_CALL_NOTE`, `RepairCounts`, `repairCounts`, `describeRepairs`, `answerOutstandingCalls` | T1 |
| 2 | `packages/core/src/index.ts` | `export * from "./history-validity.ts";` | — |
| 3 | `packages/core/test/history-validity.test.ts` (new) | T1 | — |
| 4 | `packages/protocol/src/updates.ts` | `HistoryRepairedSchema`, union member, `UPDATE_CLASS` `display` | T6a |
| 5 | `packages/protocol/schema/protocol.json` | Regenerated with `bun run schema:export` (never hand-edited) | the existing drift gate |
| 6 | `packages/protocol/test/updates.test.ts` | T6a | — |
| 7 | `packages/providers/src/openai-provider.ts` | `toWireMessage` uses `wireArguments` (:287) | T2 |
| 8 | `packages/providers/src/anthropic-provider.ts` | `parseArgs`: non-object → `{}`, comment fixed (:420-432) | T2 |
| 9 | `packages/providers/test/wire-arguments.test.ts` (new) | T2 | — |
| 10 | `packages/agent/src/context-awareness.ts` | `modelView` | T3 |
| 11 | `packages/agent/src/agent.ts` | Part A: the three sites (:1104-1109, :1291-1292, :1422) + the `history_repaired` yields + the `AgentEvent` member (:302-…). Part B: the two notes (:190-192), `runToolCalls` try/finally (:1466-1598), `runGroup` try/finally + `started` (:1627-1792), `runPrepared` `started` (:1829-1836), `runUserSkill` try/finally (:2019-2072) | T3, T5 |
| 12 | `packages/agent/test/history-validity-e2e.test.ts` (new) | T3 | — |
| 13 | `packages/agent/test/tool-loop-finally.test.ts` (new) | T5 | — |
| 14 | `packages/daemon/src/mapping.ts` | `eventToUpdate` case | T6b |
| 15 | `packages/daemon/src/hosted-session.ts` | `historyRepairNoticed` + the dedup in `drive` (:2224) | T6c |
| 16 | `packages/daemon/test/mapping.test.ts` | T6b | — |
| 17 | `packages/daemon/test/history-validity-daemon.test.ts` (new) | T4 (reload) + T5g (failed turn persisted answered) + T6c (once per session) | — |
| 18 | `packages/client/src/mapping.ts` | update → `AgentEvent` case (:288) | T6d |
| 19 | `packages/client/test/mapping.test.ts` | T6d | — |
| 20 | `packages/cli/src/render.ts` | `case "history_repaired"` (:53) | T6e |
| 21 | the existing cli render test (`rg -l "render.ts" packages/cli/test`) | T6e | — |
| 22 | `packages/tui/src/state.ts` | reducer `case "history_repaired"` → `appendNotice(state, describeRepairs(event))` (:488) | T6f |
| 23 | `packages/tui/test/state.test.ts` | T6f | — |
| 24 | this doc | Execution + Review | — |

`apps/mobile` needs no change: `rg context_note apps/mobile` finds no
`AgentEvent` switch. `bun run typecheck` (which includes `tsc -p apps/mobile`)
confirms it.

### Failure modes

- **F1. Valid history.** It must produce an identical payload: the same array
  reference, so there is no copy and the bytes are unchanged. Pinned by T1 and T2.
  If this broke, a prompt-cache miss on every request would be the symptom.
- **F2. Repair is not idempotent, or it oscillates.** The cache would break
  request by request. Pinned by the T1 idempotence assertions.
- **F3. Suspended turn on `serve` reload.** Its dangling calls must stay dangling
  in storage (P2). The repair is view-only, so `reconcileOnReload` and
  `suspendedCalls` see the stored history unchanged. The existing
  suspended-turn-resume tests must stay green. T4b additionally asserts that
  `contextUsage` over a suspended history does not change `session.messages`.
- **F4. A dangling call in the middle of the history** (followed by user turns).
  The synthesized result goes at the end of **its** block, before the next
  non-tool message. This is the position OpenAI requires. Pinned by T1.
- **F5. Invalid arguments and a dangling call together.** One synthesized message
  carries both notes (T1).
- **F6. A pod relay from an older or untrusted daemon** that sends raw arguments.
  The provider guard rewrites them to the marker on the laptop (T2). That
  request has no note, which is acceptable: the request is still valid. A pod can already send
  arbitrary prompts through the relay, so there is no security delta (§7 "a pod is
  not trusted": this is not a new laptop effect).
- **F7. An oversize argument that is valid JSON** (for example a 167 KB file
  body). It is **not** repaired, because it does not poison the wire (owner Q2).
  It costs context, and that belongs to the "Oversize / degenerate tool-call
  guard" TODO (`TODO.md:90`).
- **F8. The token estimate counts the stored arguments**
  (`token-counter.ts:44`, `estimateUsed`), not the repaired `{}`.
  - It over-counts only the unanchored tail, and only until the next request
    re-anchors it on the provider's real count of the repaired copy
    (`anchorContext`, `agent.ts:1131`).
  - The over-count is conservative: it could trigger compaction earlier, never
    later. Accepted.
  - Do not repair a `slice` of the history: a slice that starts mid-block would
    see its tool results as orphans.
- **F9. Cost.** Each request does one `JSON.parse` per stored tool call. This is
  O(total argument bytes), roughly ms for MB, against model latency in seconds.
  Accepted. Memoizing by `ToolCall` identity (`WeakMap`) is listed as debt, to
  do only if profiling ever shows it.
- **F10. Duplicate call ids inside ONE assistant message.** These are out of
  scope. Pairing is by id: the first answer satisfies the id, and a second answer
  with the same id is dropped as a duplicate (rule 4). No producer emits
  duplicate ids (the provider assigns a UUID to an id-less call,
  `openai-provider.ts:114`). This is listed as debt.
- **F11. Compaction and context reset.** Neither is affected:
  `renderMessage` drops arguments, and the rebuilt history goes through the same
  three sites afterwards.
- **F12. The model imitates the marker** (Q1 (b)). The marker is a valid
  object, so the wire stays valid. The tool's schema rejects it, and the model
  gets an `invalid arguments` error to retry from (`registry.ts:86-92`). The
  note tells it not to send the marker. Pinned by T1 (idempotence: a stored
  marker is not an issue).

Part B:
- **F13. A double answer.** A normal exit, including a cancel, must never run
  the `finally` fill: `settled` / `groupSettled` gate it. Even if it did run,
  `answerOutstandingCalls` skips answered ids.
  - T5f: the cancel history is byte-identical to today's.
  - The mutation "drop the `settled` gate" must still pass T5f, because of the
    answered-id skip. This shows the two guards are independent.
- **F14. A suspended turn is closed by mistake.** A pending ask never exits the
  generator (P7), so no `finally` runs. T5h pins that a turn suspended on an
  ask, whose generator is simply never resumed, leaves the history dangling
  (the reload's input, unchanged).
- **F15. Raw output leaks through the `finally`.** Only an already
  **transformed** result (`inHand`, or a group's `answered`) is ever pushed. A
  transform that throws gives the "Interrupted" note (T5b asserts that the raw
  content is absent from the history).
- **F16. Answers land in a fresh history after a context reset.** `owner` is
  checked by identity, so nothing is pushed (T5i).
- **F17. A group's background call finishes after the turn failed.** Its
  result is dropped (the queue is closed, and push after close is a no-op), and
  its note says "may have completed". This is the same as today, minus the
  dangling id. It is debt: such a call is not aborted.
- **F18. The `finally` yields or awaits.** That would break the drive-loop
  invariant and return-protocol semantics. It is forbidden in the Design; the
  Review checks it with `rg -n "finally" -A 15` on the changed blocks.
- **F19. A crash between the `finally` push and `finishTurn`'s persist.** The
  answers are not on disk, so the reload labels the dangling calls (P2). This
  converges.

Part C:
- **F20. The notice is shown on every round.** The dedup is in `drive`, per
  `HostedSession` (T6c: two turns over a poisoned history give exactly one
  update).
- **F21. An older client.** It gets an unknown `display` kind → `unsupported`
  once, and the turn goes on (AGENTS §7). No bump.
- **F22. An `empty_arguments`-only repair raises a notice.** It must not:
  `repairCounts` ignores that kind, so the result is `null` and nothing is
  yielded (T1, T6c).
- **F23. An agent swap mid-session** (`updateSettings`). The flag lives on
  `HostedSession`, not on the `Agent`, so the notice is not repeated.

### Tests

These are red before green. The red runs on the current code are shown by the
repro above (the same shapes).
- **T1. Core unit tests** (`history-validity.test.ts`). Each rule is checked on a
  hand-built history:
  - invalid JSON (the incident shape: an unterminated string);
  - non-object JSON (`[]`, `"x"`, `null`, `1`);
  - `""` → `{}` with no note;
  - an unanswered call, both trailing and mid-history (F4);
  - invalid arguments plus unanswered (F5);
  - an orphan tool message: outside a block, an unknown id, a duplicate answer, and `toolCallId` undefined;
  - consecutive users left alone.

  For each case, assert:
  - the exact output roles, ids and contents;
  - the exact `issues`;
  - the input array and its objects are unchanged (deep-equal to a pre-call `structuredClone`);
  - idempotence;
  - `validateHistory(repaired) = []`;
  - a valid history → `toBe` (the same reference).

  Include the eval's A/B/C/E/F/H shapes as fixtures.

  Also assert:
  - **The marker:** `wireArguments('{"a":')` is exactly
    `{"_invalid_arguments":true,"bytes":5}`. A non-ASCII raw value counts UTF-8
    bytes, e.g. `"é"` is 2. `wireArguments(marker) === marker`.
  - **The note:** the exact `invalidArgumentsNote(1902)` text.
  - **`repairCounts`:** `null` for `[]` and for an `empty_arguments`-only list;
    otherwise the exact counts.
  - **`describeRepairs`:** the exact line for `{1,0,0}`, for `{2,1,1}`
    (`history repaired for the model: 2 tool calls with invalid arguments, 1 unanswered tool call, 1 stray tool result — the saved session is unchanged`),
    and for `{0,0,3}`.
  - **`answerOutstandingCalls`:**
    - every call answered → `[]`;
    - two calls, one answered → one message for the other, with its note;
    - `owner` absent from `messages` → `[]`;
    - a `user` message after the block → `[]`;
    - the input array is never mutated.
- **T2. Provider wire.** Use the `Bun.serve` body-capture pattern of
  `packages/providers/test/tool-duration.test.ts`.
  - OpenAI: for invalid or non-object arguments, the body carries
    `"arguments":"{\"_invalid_arguments\":true,\"bytes\":N}"`. For `""` it carries
    `"arguments":"{}"`. A valid history's body is byte-identical to the
    pre-change mapping.
  - Anthropic `buildPayload`: `tool_use.input` is `{}` for `[]` / `"x"`.
  - Red: the current `toWireMessage` sends the raw string.
- **T3. End-to-end, the incident**, in `packages/agent/test/history-validity-e2e.test.ts`.
  - Setup: a fake llama.cpp server (`Bun.serve`) that returns
    `500 {"error":{"code":500,"message":"Failed to parse tool call arguments as JSON: …"}}`
    when any `messages[].tool_calls[].function.arguments` does not `JSON.parse`
    to a plain object. It checks this on `/v1/chat/completions` **and**
    `/apply-template`. It drives the real `OpenAIProvider` (`baseURL` = the fake),
    plus `Agent` + `Session` + a `ToolRegistry` with an `fs_write`-named tool
    (the `noopEnv` pattern of `packages/agent/test/session.test.ts:59-70`).
  - **T3a.** Turn 1: the model calls `fs_write` with invalid arguments, then the
    same turn's next round succeeds (text, `turn_end: end_turn`). Turn 2, "hey",
    succeeds.
    - The captured round-2 request carries the marker
      `{"_invalid_arguments":true,"bytes":N}`, where N is the UTF-8 length of the
      bad string. The paired tool content ends with the exact
      `invalidArgumentsNote(N)`.
    - The turn's events contain one `history_repaired`
      `{invalidArguments:1, unansweredCalls:0, orphanResults:0}` per repaired
      round. The Agent does not deduplicate; the daemon does (T6c).
    - `session.messages` still holds the **original** bytes (non-destructive).
    - Red on the current code: both turns throw the 500.
  - **T3b. The owner's case, offline.** Build
    `new Session(agent, "s", { messages: poisoned })`, the constructor
    `SessionHost` uses (`packages/daemon/src/session-host.ts:950`). `poisoned`
    is a history already holding the bad call, its registry error, and two
    failed "hey" turns closed with `closeFailedTurn`-style notes. `send("hey")`
    must succeed. Red on the current code.
  - **T3c. `max_iterations` final round** (`agent.ts:1292`): `maxIterations`
    is small enough that the final no-tools round follows an invalid call, and
    it succeeds.
  - **T3d. Exact count** (`agent.ts:1422`): `agent.contextUsage(poisoned)`
    returns `exact: true`, and the fake `/apply-template` + `/tokenize` answer.
    Red: it falls back to `exact: false`.
  - **Mutation (non-vacuity, §9).** Revert each of the three sites, one at a time,
    to `messages.map(renderForModel)`. Then T3a, T3c and T3d respectively must go
    red. Also disable the provider guard alone: T3 must stay green, which proves
    that the Agent repair, and not the guard, carries the note. Record the
    results in Execution.
- **T4. `serve` reload of a poisoned store.** Use the existing persistence
  harness of `packages/daemon/test/persistence.test.ts`.
  - **T4a.** Write a daemon store record whose history holds the invalid call.
    Restart, then prompt through the fake llama.cpp provider: it succeeds. The
    `<uid>.jsonl` on disk still contains the original argument bytes (no rewrite
    of that entry).
  - **T4b.** On a reload of a turn **suspended** on a permission, with a dangling
    call, the turn still resumes (it is asked again), and `contextUsage` on it
    leaves the history unchanged (F3).
- **T5. Part B, the exception-safe loop**, in
  `packages/agent/test/tool-loop-finally.test.ts`.
  - Setup: real `Agent` + `Session` + `ToolRegistry`, a scripted model (the
    `ScriptedProvider` of `packages/agent/test/session.test.ts`), and the
    `noopEnv`. Every case asserts the **full** `session.messages` (roles, ids,
    contents), and that `validateHistory(session.messages)` is `[]`.
  - Red on the current code: every case below except T5f and T5h ends with an
    unanswered `assistant[tool_calls]`. This is the eval's repro output for
    A/B/C/H.
  - **T5a (A).** A tool with `permission: "ask"` and a requester that throws
    (`requestPermission`, the seam of `packages/agent/test/permission.test.ts:213-221`).
    - `send` rejects with the requester's error.
    - The history is `user`, `assistant[c1]`, then `tool(c1)` with content
      `TURN_STOPPED_NOT_RUN_NOTE`.
  - **T5b (B).** `config.resultTransforms` holds one transform that throws, on
    a call alone.
    - `send` rejects.
    - `tool(c1)` is `TURN_STOPPED_INTERRUPTED_NOTE` (the call was `started`).
    - The tool's raw output string does **not** appear anywhere in
      `session.messages` (F15).
  - **T5c (C).** Two calls in one message, sequential. The consumer `break`s
    out of `for await` right after the first `tool_start`.
    - Both are answered with `TURN_STOPPED_NOT_RUN_NOTE`, because neither was
      started.
  - **T5d (H).** The consumer throws on receiving the first `tool_result`.
    - `tool(c1)` holds the **real** transformed result (`inHand`), not a note.
    - The tool's execute spy ran exactly once.
  - **T5e (parallel).** `toolExecution: { mode: "parallel", maxParallel: 2 }`,
    three read-class calls, and a `beforeRun` that resolves `true` (copy the
    setup of `packages/agent/test/parallel-tools.test.ts`). The
    consumer throws on the **first** phase-2 `tool_result`.
    - That call's real result is in the history (the group `finally`).
    - The other two are `TURN_STOPPED_INTERRUPTED_NOTE`, because they were
      started (`runPrepared`).
    - The answers follow call order, then the synthesized ones.
  - **T5f (cancel, falsification).** Abort mid-tool, exactly the eval's
    scenario D. `session.messages` deep-equals the same run on the pre-change
    code: `CANCELLED_TOOL_NOTE` answers and no `TURN_STOPPED_*` note anywhere.
    This must be green both before and after (it is a guard, not a red test).
  - **T5g (`serve`, persisted).** This one goes in
    `packages/daemon/test/history-validity-daemon.test.ts`. On a daemon with a
    store, a tool's requester throws.
    - The turn ends `error`.
    - The persisted `<uid>.jsonl`, read back, holds `tool(c1)` with
      `TURN_STOPPED_NOT_RUN_NOTE`, then the `closeFailedTurn` assistant note.
    - A reload adds no second answer: `labelUnansweredCalls` finds nothing.
  - **T5h (suspension untouched).** A requester whose promise never settles.
    Start `send`, pull until the ask is raised, then stop pulling (do **not**
    `return()`).
    - `session.messages` ends with the dangling `assistant[c1]`.
    - Nothing is synthesized (F14).
  - **T5i (context reset).** Use the setup of
    `packages/agent/test/context-reset-loop.test.ts`: a `context_reset` call
    whose commit is followed by
    a consumer throw at the `context_reset` yield.
    - The fresh history gets **no** `TURN_STOPPED_*` message (F16).
  - **T5j (user skill).** Use the setup of
    `packages/agent/test/user-skill.test.ts`: `send("x", undefined, { skill })`,
    and the consumer
    throws at the skill's `tool_result`.
    - The history keeps the real activator result (`runUserSkill`'s `inHand`).
  - **Mutations** (each must turn the named test red; record each one in
    Execution):
    - Delete `runToolCalls`'s `finally` body → T5a, T5b and T5c go red.
    - Delete the `inHand` push → T5d goes red (the note replaces the real result).
    - Delete `started.add` in the alone path → T5b goes red (it says "Not run").
    - Delete `started.add` in `runPrepared` → T5e goes red.
    - Delete the group `finally` → T5e goes red (the real result is missing).
    - Drop the `owner` identity check → T5i goes red.
- **T6. Part C, the notice.**
  - **T6a (protocol, `updates.test.ts`).**
    - `SessionUpdateSchema.parse` accepts
      `{type:"history_repaired",invalidArguments:1,unansweredCalls:0,orphanResults:0}`.
    - It rejects a negative count.
    - `UPDATE_CLASS.history_repaired === "display"`.
    - `PROTOCOL_VERSION` is still `21`.
    - The drift gate (`json-schema.test.ts`) is green after `schema:export`.
  - **T6b (daemon mapping).** `eventToUpdate` maps the event field by field.
  - **T6c (once per session, `history-validity-daemon.test.ts`).** Two prompts
    over a poisoned history, through the fake llama.cpp provider.
    - The attached client receives **exactly one** `history_repaired` update.
    - A valid history gives zero.
    - A history whose only issue is `""` arguments gives zero (F22).
    - Mutation: remove the `historyRepairNoticed` check → two updates (red).
  - **T6d (client mapping).** The update maps to the `AgentEvent` field by field.
  - **T6e (cli render).** The plain renderer prints the `describeRepairs` line.
  - **T6f (TUI reducer, `state.test.ts`).** The event appends exactly one
    `notice` item with the `describeRepairs` text.
  - **Red** for T6a–T6f: the type and cases do not exist, so the tests fail to
    compile or assert on the current code.
- **Gate.** Run `bun test` (full), `bun run typecheck` and `bun run lint` against
  the §6 baseline.

### Execution order (for the executor)

Do one part at a time. Run the narrow tests per slice (§4), and record each
red/green and each mutation in Execution.
1. **Part A.** Files 1–3, 7–12. Red: run `repro.ts`'s shape as T3a on the
   current code. Then make T1, T2 and T3 green, and run the T3 mutations.
2. **Part B.** File 11 (the Part B hunks), 13, and T5g in file 17. Red: T5a–e,
   T5i and T5j on the code after Part A. T5f and T5h are green both before and
   after. Run the T5 mutations.
3. **Part C.** Files 4–6, 14–23, plus the `AgentEvent` member and the yields in
   file 11. Red: T6. Run the T6c mutation.
4. **Gate.** `bun test` (full), `bun run typecheck`, `bun run lint`. Then the
   fresh-context Opus Review (§10: load-bearing).

### Owner decisions (2026-11-10)

The owner chose:
- **Q1 (b), the marker** `{"_invalid_arguments":true,"bytes":N}`, plus the
  note on the paired result (rules 1–2, F12).
- **Q2 (a).** Valid but oversize arguments are not handled here (F7).
- **Q3 (b), the one-time notice.** It is a display update with no bump,
  sent once per loaded session (Part C).
- **Q4 (b), the exception-safe loop**, in this task, so the Size is L (Part B).

### Notes / debt

- Subsumes the *persistence/poison* half of `TODO.md:90` (oversize/degenerate
  guard). Its early-reject half stays open, and it should call `wireArguments`.
- Subsumes the history-corruption consequence of `TODO.md:154` (a requester
  throw escapes): Part B answers the call. The throw still ends the turn as an
  error, which is intended.
- The notice is in memory, once per **loaded** session. A daemon restart or a
  reopen shows it again, once. Persisting the flag would change the sidecar
  format.
- A sub-agent's own repairs are not surfaced as a notice (`subagent.ts:454-470`
  ignores the event).
- When the turn fails, a group's phase-2 calls that are still running are not
  aborted (F17), which is the same as today.
- `TODO.md:161` (consecutive `user` after compaction): a deliberate no-op (rule 5).
- `docs/eval/sse-abort-truncated-toolcall.md` is a *producer* of invalid
  arguments. Its local fix is still worth doing; this module is the backstop.
- Debt: a `WeakMap` memo (F9); duplicate ids within one message (F10); a
  provider capability flag to merge consecutive same-role messages (rule 5); the
  registry's `invalid JSON arguments for <tool>` could carry the parse position
  and a hint, so the model's retry gets it right the first time.
- Unverified: llama.cpp rejecting `""` arguments (P6). This is from reading the
  code only. T2 makes it moot, because `""` is never sent.


**Answers (owner, 2026-11-10):** **Q1 (b)** the invalid arguments become a MARKER OBJECT in the sent copy (e.g. `{"_invalid_arguments":true,"bytes":N}`), not `"{}"` · Q2 (a) valid-but-huge arguments are not handled here · **Q3 (b)** a ONE-TIME per-session notice in the TUI when the sent history was repaired (a new display-class update) · **Q4 (b)** the exception-safe tool loop (`try/finally` in `runToolCalls`) is IN this task → Size L. Executor: DeepSeek, then a fresh Opus review (owner).

## Execution

*— deepseek (tentacle --profile deepseek), 2026-11-10*

**Two runs.** The first stopped mid-way (a malformed tool call); its uncommitted
work was verified, completed and kept. The second finished Parts A–C, the tests
and the gate. Nothing below is from the first run unless it says so.

### Part A — the wire repair

Files 1–3 and 7–9 were already written in the worktree (verified here, not
redone): `packages/core/src/history-validity.ts`, its test, the `index.ts`
export, and both provider guards. Fixed in this run:
- `packages/providers/test/wire-arguments.test.ts` did not parse (an unterminated
  `describe`): completed with the `""` → `{}`, verbatim-object, marker-idempotent
  and Anthropic `buildPayload` cases (T2).
- `packages/core/test/history-validity.test.ts`: 33 pass as written (T1).

**T2 red (inverse edit, then restored).** `arguments: tc.arguments` →
`(fail)` on the marker, the non-object and the `""` cases (3 red, 5 pass);
`parseArgs` returning the parsed value unguarded → the non-object case red.
Both restored, 8 pass.

**Part A wiring (files 10–11).**
- `context-awareness.ts`: `modelView(history)` = `repairHistory` → `renderForModel`
  per message, plus `repairCounts`; one helper, the three sites use it.
- `agent.ts`: the round request (`:1116`), the final no-tools round (`:1307`)
  and `contextUsage` (`:1442`) now build from `modelView(...)`; the two
  generator sites yield `history_repaired` when `view.repairs !== null`. The
  estimate stays on the stored history.

**T3 (`packages/agent/test/history-validity-e2e.test.ts`).** A `Bun.serve`
fake in llama.cpp's shape (500 on any request whose
`messages[].tool_calls[].function.arguments` is not a JSON object, checked on
`/v1/chat/completions` and `/apply-template`; `/tokenize` answers). The real
`OpenAIProvider`, `Agent`, `Session`, `ToolRegistry` with an `fs_write`-named
tool.
- T3a (the incident: turn 1 bad call, the same turn's next round, then "hey"):
  green; round 2's body carries the marker, the paired tool content ends with
  the exact `invalidArgumentsNote`, `session.messages` keeps the model's
  original bytes, one `history_repaired {1,0,0}`.
- T3b (the owner's case offline: `new Session(agent,"s",{messages: poisoned})`):
  green.
- T3c (`maxIterations: 1`, the final no-tools round after an invalid call):
  green; the note proves this site repaired the copy.
- T3d (`contextUsage` over the poisoned history): `exact: true`, `used: 4`, one
  `/apply-template` read, `session.messages` unchanged, and the note is in the
  counted body.
- **Mutations, all recorded red→green.** Reverting site 1 → T3a red (the note is
  missing). Reverting site 2 → T3c red. Reverting site 3 → T3d red. Disabling
  the provider guard alone → T3 **stays green**, so the Agent repair (and its
  note), not the guard, is what carries T3.
  - **Drift from the plan's mutation recipe:** the plan expected sites 2 and 3
    to go red on "the 500" alone. They do not: the provider guard sanitizes the
    bytes first, so the 500 never happens. Both sites' tests therefore assert
    the **note** (a property only `modelView` produces) as well as the marker,
    which is the exact property that dies when the site is reverted.

### Part B — the exception-safe tool loop

`agent.ts` only, with `answerOutstandingCalls` from core.
- The two notes next to `CANCELLED_TOOL_NOTE` (`TURN_STOPPED_NOT_RUN_NOTE`,
  `TURN_STOPPED_INTERRUPTED_NOTE`), exactly the plan's wording.
- `runToolCalls`: `owner` (found by the first call's id), `started`,
  `inHand`, `settled`; the body in `try`/`finally`; `settled = true` before
  both normal returns; `started.add(call.id)` before the alone path's
  `executeCall`; the lone result held in `inHand` across its `tool_result` yield;
  the `finally` pushes the real in-hand result and then
  `answerOutstandingCalls(...)`, gated on `!settled && owner still in messages`.
  Event order (`tool_result` → push → `history_commit`) is unchanged.
- `runGroup`: new `started` parameter; `pushed` / `groupSettled`; the body in
  `try`/`finally`; both push loops record `pushed`; `groupSettled` before the
  fallback return and before the final `history_commit`; the `finally` closes
  the queue (idempotent; late completions dropped) and pushes results the client
  already saw.
- `runPrepared`: new `started` parameter, `started.add(prepared.call.id)` as its
  first statement, before the `await`; both call sites pass it.
- `runUserSkill`: `owner` from `messages.at(-1)` after the push, `inHand` across
  the `tool_result` yield, `settled` before the final commit, the same `finally`
  with `TURN_STOPPED_INTERRUPTED_NOTE` (a read has no "not started" window).

**T5 (`packages/agent/test/tool-loop-finally.test.ts`, T5g in the daemon test).**
Every case asserts the full `session.messages` shape and that
`validateHistory(repairHistory(messages).messages)` is `[]`.
- T5a (requester throws): `Not run`, not one execution, the turn rejects.
- T5b (a transform throws, alone): `Interrupted`, and the tool's raw
  `SECRET-RAW-OUTPUT` appears nowhere in the history (F15).
- T5c (consumer `break`s after the first `tool_start`): both calls `Not run`.
- T5d (consumer throws at the first `tool_result`): the REAL transformed result
  is in the history; the tool ran exactly once.
- T5e (a landed group; the consumer throws at the first phase-2 result): the
  seen result is kept, the started call says `Interrupted`, the unstarted one
  `Not run`, and the block is well-formed.
- T5f (cancel — a guard, green before and after): the cancel path's own
  `CANCELLED` note, and no `TURN_STOPPED_*` anywhere.
- T5g (`packages/daemon/test/history-validity-daemon.test.ts`, real
  `SessionPersister` on real disk): the requester throws; the persisted log
  holds `tool(c1)` = `Not run`, then the failed-turn assistant note, and
  `reconcileOnReload` adds no second answer.
- T5h (suspension untouched): pulling to the `tool_start` and stopping WITHOUT
  `return()` leaves the dangling `assistant[c1]` and synthesizes nothing.
- T5i (context reset): a throw at the `context_reset` yield leaves the fresh
  history with no synthesized answer.
- T5j (user skill): a throw at the skill's `tool_result` keeps the real
  activator result.

**T5 mutations (each red, then restored).**
- Delete `runToolCalls`'s `finally` body → T5a, T5b, T5c, T5d, T5e red.
- Delete the `inHand` push → T5d only.
- Delete `started.add` in the alone path → T5b only.
- Delete `started.add` in `runPrepared` → T5e only.
- Empty the group's `finally` body → T5e only.
- **`owner` identity check:** dropping it alone does **not** make T5i red — the
  property is guarded twice (`runToolCalls`'s `lastIndexOf` check AND
  `answerOutstandingCalls`'s own `lastIndexOf(owner) === -1 → []`). Mutating
  **both** goes red (verified: `answerOutstandingCalls` was called with
  `at = -1` and pushed a `Not run` message into the fresh history). Recorded as
  drift: defence in depth masks a single mutation here.

**T5h drift (a test's shape, not the code's).** The plan says "stop pulling (do
not `return()`)"; `for await` + `break` *does* call `return()`. The test drives
`gen.next()` directly instead. That also showed the design's own distinction
vividly: a `break` genuinely is an abnormal exit and correctly synthesizes
`Not run`.

### Part C — the one-time notice

- `protocol/updates.ts`: `HistoryRepairedSchema`, the union member,
  `UPDATE_CLASS.history_repaired = "display"` (with the comment). **No
  `PROTOCOL_VERSION` bump** (still 21, pinned by T6a).
  `packages/protocol/schema/protocol.json` regenerated with
  `bun run schema:export` (never hand-edited); the drift gate is green.
- `agent.ts`: the `history_repaired` `AgentEvent` member next to
  `context_note`; the two yields landed with Part A.
- `daemon/src/mapping.ts`: the field-by-field case.
- `daemon/src/hosted-session.ts`: `private historyRepairNoticed = false;` and,
  in `drive` before `eventToUpdate`, the synchronous dedup (`continue` on a
  repeat). No `await` added; the drive-loop invariant is untouched.
- `client/src/mapping.ts`: the update → `AgentEvent` case.
- `cli/src/render.ts`: `case "history_repaired"` → the shared `describeRepairs`
  line.
- `tui/src/state.ts`: `case "history_repaired"` → `appendNotice(state,
  describeRepairs(event))` (one notice row; no component change).

**T6.**
- T6a (`protocol/test/updates.test.ts`): parses; a negative and a
  non-integer count are refused; `UPDATE_CLASS` is `display`;
  `PROTOCOL_VERSION === 21`; the JSON-schema drift gate green.
- T6b (`daemon/test/mapping.test.ts`): field by field, plus the type added to
  the "covers every known type" samples list (that list is what caught it).
- T6c (`daemon/test/history-validity-daemon.test.ts`, real `SessionHost` +
  `Connection` over the fake llama.cpp endpoint): two prompts over a poisoned
  history give **exactly one** `history_repaired {invalidArguments: 1}`; a valid
  history gives zero; a history whose only issue is `""` arguments gives zero
  (F22). **Mutation:** dropping the `historyRepairNoticed` check → two updates
  (red), restored.
- T6d (`client/test/mapping.test.ts`), T6e (`cli/test/render.test.ts`: the exact
  line, `—` included), T6f (`tui/test/state.test.ts`: exactly one new `notice`
  item with the exact text).
- Red for T6a–T6f on the old code: the type and the four switch cases did not
  exist, so `tsc` failed on the four exhaustive switches (that is exactly the
  red the plan predicts; recorded from the typecheck before Part C).

### T4 — reload of a stored poisoned session

- **T4a** (`daemon/test/history-validity-daemon.test.ts`, real
  `SessionPersister` + `LogSessionStore` on real disk): a real daemon turn
  commits the invalid call; after `stop()`, the `<uid>.jsonl` on disk still
  contains the model's original bytes (`unterminated`), the reload's record
  keeps them (`toBe(BAD)`), and **only the view** (`repairHistory(...)`) differs.
  No rewrite of that entry.
- **T4b** (F3, suspension): no new test — this is the *existing* contract, and
  the plan's own precondition is that it must stay green. Verified:
  `packages/daemon/test/persistence.test.ts` + `serve-log-store.test.ts` =
  138 pass. The repair is view-only (asserted in T3d and T4a that
  `session.messages` / the record are unchanged), so `reconcileOnReload` and
  `suspendedCalls` see exactly the stored history.

### Gate

`bun run typecheck` green (including `tsc -p apps/mobile`: no `AgentEvent`
switch there). `bun run lint` green (the §6 baseline is clean; 0 errors, 0
warnings after `biome check --write` on the touched files). Per-package test
runs, all green:
- `packages/core` + `packages/protocol` + `packages/providers`: 465 pass.
- `packages/agent`: 521 pass across 46 files (512 before the two new test files).
- `packages/daemon`: 737 pass, 1 skip (the opt-in keepalive).
- `packages/client`: 518 pass.
- `packages/tui`: 1430 pass.
- `packages/cli`: 2407 pass.
No new failure and no non-opt-in skip.

**`bun run check` (the gate, full suite): green.** `tsc --noEmit` +
`tsc -p apps/mobile` clean, `biome check .` clean (855 files, 0 errors, 0
warnings — the §6 baseline), `bun test` **6704 pass, 3 skip, 0 fail** across 467
files. The 3 skips are exactly the documented opt-ins (`TENTACLE_DOCKER_TESTS`,
`TENTACLE_K8S_SERVER`, `TENTACLE_SLOW_TESTS`) — none is mine.

### Drift from the Implementation (all named above, in one place)

1. **T3's mutation recipe for sites 2 and 3.** The provider guard sanitizes
   first, so a revert of the site alone no longer produces a 500. The tests
   assert the note (a `modelView`-only property) to make each site's mutation
   red. The guard's own mutation (T3 with it disabled) stays green, as the plan
   intends.
2. **T5i's `owner`-check mutation** is masked by `answerOutstandingCalls`'s own
   guard. Both are correct (defence in depth); the mutation is recorded as
   needing both edits.
3. **T5h's test shape**: `gen.next()` instead of `for await` + `break` (which
   is itself a `return()`).
4. **`SessionHost.close(id)`**, not a bare `close()`, in the daemon harness.
5. **`fs_edit`/`fs_write` with long bodies repeatedly produced malformed tool
   arguments in this run** (the very failure mode this task repairs). Files were
   therefore written in small appended pieces and, where that was impossible,
   with shell heredocs. No source line was written from a guessed body: every
   edit was followed by `tsc` and the narrow test.

### Not done / left as debt (unchanged from the plan's Notes)

- The sub-agent's own repairs are not surfaced as a notice.
- The notice is per loaded session, in memory; a daemon restart shows it once
  more.
- Duplicate ids within one message (F10), the `WeakMap` memo (F9), a
  capability flag for consecutive same-role messages (rule 5), and the
  registry's error carrying the parse position: all still debt.
- Persisted format untouched: no `schemaVersion` / `DAEMON_STATE_VERSION` bump.

### Verdict

**DONE.**
- Gate: `bun run check` green — typecheck (incl. mobile) · lint (0 errors, 0
  warnings) · `bun test` 6704 pass / 3 skip (the documented opt-ins) / 0 fail.
- Drifts (5, all in "Drift from the Implementation" above): T3's mutation recipe
  needs the note (the guard sanitizes first); T5i's `owner` mutation needs both
  guards edited; T5h drives `gen.next()` instead of `for await`+`break`;
  `SessionHost.close(id)`; the long-body tool-call failure of this very run
  forced small appends.
- Not done (deliberate, per the plan's Notes): sub-agent repairs are not
  surfaced; the notice is in memory per loaded session; F9/F10/rule-5/registry
  -error debt; no persisted-format change.
- **Uncommitted**, as instructed (`docs/feat/history-validity-invariant.md`,
  `CHANGELOG.md`, 6 new files, 17 edited). Nothing was committed, no
  `git checkout`/`restore`/`stash` was used, `TODO.md` is untouched, and the
  scratch files live only under `.tentacle/tmp/`.

## Review

*— claude-opus-5-5, 2026-10-17*

**Verdict: the architectural claim holds.** No history-validity invariant exists.
Well-formedness depends on each producer behaving, and nothing checks the list
at the three places it crosses a boundary: persist, wire, and resume. The
falsification attempts narrowed the claim but did not break it:
- cancellation is safe (D);
- orphan `tool` messages have no live producer;
- "poisoned until jq" is overstated, because `/compact` rescues it, lossily;
- server rejection is shown for invalid args via the incident, and for
  dangling ids only by OpenAI's documented contract, not run live.

**Recommendation: promote to `feat/history-validity-invariant` (M, load-bearing).**
The design is sound and fits AGENTS §7 ("logic lives in pure modules"): one
React-free, I/O-free `packages/agent/src/history.ts` with
`validateHistory(messages) → Issue[]` and `repairHistory(messages) → {messages, repairs}`:
- **Dangling calls.** For each unanswered `tool_call_id`, synthesize
  `{role:"tool", isError-style content: "tool call was interrupted; no result recorded"}`
  right after its assistant turn. This is better than dropping the call, which
  would hide H's real side effect from the model.
- **Invalid or oversize arguments.** Replace the stored string with `"{}"` (or a
  small JSON marker), and say so in the paired tool result. This keeps the
  model-visible error without re-sending the bad bytes.
- **Orphan tool messages.** Drop them.
- **Consecutive users.** Leave them alone, or merge them only behind a provider
  capability flag. Do not normalize them by default; OpenAI-compatible servers
  accept them.

Apply it at:
1. the **request boundary**, i.e. `toWireMessage`'s caller, or at the top of each
   `runMessages` round. This is the one place that protects every runtime
   (worker, pod, connect, subagent).
2. the **persist boundary**: `Session.persist` and `persistingController.flush`.
3. **resume**: `SessionHost.create` / `Session` constructor.

Also make the loop itself sound, not just repaired after the fact: wrap the
`agent.ts:283-301` body so a throw or `.return()` answers the remaining ids
before propagating. The repair module is then a backstop, not the main
mechanism. Prefer repair-in-memory plus repair-on-persist over rejecting, so a
user session never hard-fails. Surface every repair as a visible event or log
line, so it is not a silent rewrite (§8: "a silent drop is a bug").

**Load-bearing assumption to prove first when promoted:** the repaired history
must be semantically honest to the model. A synthesized error result must never
be mistaken for a tool success. Test it with A/B/C/H as red-before-green cases
plus a mutation test (disable the repair → the wire payload has an unanswered id).

**Subsumes / relates to TODO items:**
- *"A throw from the permission `requester` (or `gate.authorize`) escapes"*
  (`TODO.md:125`). **Subsumed** for the history-corruption consequence. The
  uncaught-propagation part (the turn ends as an error) remains, but it becomes
  harmless.
- *"Oversize / degenerate tool-call guard"* (`TODO.md:61`). **Partly subsumed.**
  The repair covers the *persistence/poison* half: bad args are normalized
  before disk and wire. The *early-reject-with-actionable-error* half, which
  stops the call at SSE assembly so the model can retry, stays its own `feat`.
  It should call the same pure validator for its size/JSON check.
- *"`compactedHistory` can leave two consecutive `user` messages"* (`TODO.md:131`).
  **Subsumed as a policy decision** inside the module (a no-op by default, behind
  a capability flag if a strict provider ever needs it).
- **Sibling evals, not duplicated here:**
  - `docs/eval/sse-abort-truncated-toolcall.md`: one *producer* of invalid args.
    Its local fix is still worth doing; this module is the backstop.
  - `docs/fix/compact-empty-summary-wipe.md`: the `/compact` rescue path in
    row 6 depends on it.
  - `docs/fix/daemon-compact-turn-guard.md`: a concurrent compact during a turn
    is another way to mutate history mid-turn. That needs its own guard;
    validation does not make a race safe.

**Unverified (one line):** whether the target llama.cpp / vLLM builds reject an
unanswered `tool_call_id`. To check, POST the scenario-F payload (from `hv.ts`)
to the live endpoint.

## Review

*— claude-opus-5-5, 2026-11-10* (fresh context, adversarial; a different model
family from the executor, deepseek. Scope: `git diff main...HEAD`, HIGH/MEDIUM
only, one round.)

**Verdict: REQUEST-CHANGES.** There is one MEDIUM finding with a small fix.
Everything else red-teamed below holds.

### Findings

1. **MEDIUM: the one-shot CLI repeats the "once per session" notice on every
   repaired round** (owner Q3 (b) is broken on one runtime).
   - **Where:** `packages/cli/src/main.ts:1929` consumes `agent.run(...)`
     directly, with no daemon and so no `HostedSession`. `AnswerSplit.push`
     (`packages/cli/src/render.ts:137`) renders every `history_repaired` via
     `render` (`render.ts:56-59`). The Agent yields one notice per repaired
     request (`agent.ts:1136-1138`, `:1320-1322`). The only dedup is
     `hosted-session.ts:2230-2237`, and F20/F23 assume that dedup covers every
     path.
   - **Failure scenario (reproduced):**
     `.tentacle/tmp/history-validity/oneshot.ts` uses the T3 fake llama.cpp
     server and the real `OpenAIProvider` + `Agent`. In one `agent.run`, round 1
     makes an invalid `fs_write` call, rounds 2–3 make valid calls, and round 4
     is text. Output: `history_repaired in ONE agent.run: 3`, `turn_end
     end_turn`. So `tentacle "<prompt>"` prints `history repaired for the
     model: …` to stderr once per later round of the same turn.
   - **Exact fix:** add a `private repairNoticed = false` to `AnswerSplit`. In
     `push`, if `event.type === "history_repaired"` and the flag is already
     set, return `{ out: "", err: "" }`; otherwise set the flag and render.
     `AnswerSplit` is one instance per one-shot run (`main.ts:1927`). The repl
     creates one per turn (`repl.ts:56`), but it goes through the daemon,
     which already dedups, so this is harmless there. Add a
     `cli/test/render.test.ts` case: two `history_repaired` events pushed into
     one `AnswerSplit` give exactly one stderr line. Show it red first.
     Alternatively, filter in the `main.ts:1929` loop. Do not dedup in the
     Agent: T3a pins "one per repaired round" there on purpose.

### Gate (re-run by the reviewer)

`bun run check` exits 0:
- `tsc --noEmit` and `tsc -p apps/mobile` are clean.
- `biome check .`: 855 files, no fixes, 0 errors / 0 warnings (the §6
  baseline).
- `bun test`: **6704 pass, 3 skip, 0 fail**, 6707 tests in 467 files. The 3
  skips are the documented opt-ins.

### Mutations (non-vacuity, §9; each restored; `git status --porcelain` empty afterwards)

- **M1.** `answerOutstandingCalls`'s never-splice guard disabled
  (`history-validity.ts:329`). Result: `answerOutstandingCalls > a non-tool
  message after the block: nothing (never splice)` fails (1 fail, 46 pass
  across core + T5 + daemon files).
- **M2.** `runGroup`'s `finally` no longer pushes results the client already
  saw (`agent.ts`, the `!pushed.has(index)` branch). Result: T5e fails (1 fail,
  8 pass).

### Attacks tried

- **(1) Copy-only repair; stored bytes; resume.** Holds.
  - `repairHistory` never mutates its input and returns the same array when
    nothing changed (`history-validity.ts:239`; pinned by `toBe(history)` at
    `core/test/history-validity.test.ts:103,111,299`).
  - `modelView` only feeds the request and the count (`agent.ts:1129`, `:1320`,
    `:1455`). No write path calls it.
  - T4a shows the on-disk `<uid>.jsonl` keeps the original bytes.
  - Resume: the Part B `finally` runs only at a `yield` stop or a throw. A
    permission ask is an `await` in `authorizeCall`, and `drive`'s `for await`
    cannot call `return()` while `next()` is pending. So a suspended turn's
    calls stay dangling (P7 verified).
  - The existing resume suites are in the green gate.
  - Byte identity for a valid history matches `main`. The one exception is a
    stored `""` argument, which now goes out as `"{}"` on the OpenAI wire: one
    cache miss after upgrade, then stable. Not a finding.
- **(2) Repair rules.** Hold.
  - Marker + note, never mistaken for real input: a stored marker is valid and
    raises no issue, which makes the repair idempotent.
  - Unanswered calls are answered at the end of their own block; orphans,
    duplicate answers and unknown ids are dropped.
  - The owner's poisoned session recovers with no edits (T3b, T4a).
- **(3) Part B.** Holds.
  - Normal exits, including cancel, set `settled` / `groupSettled` before
    returning. The fill also skips answered ids, so there are no double
    answers.
  - Only an already-transformed result (`inHand`, or the group's `answered`)
    is pushed. A throwing transform yields `Interrupted` and the raw output
    never appears (T5b).
  - The group's `finally` runs before the caller's, so the block order stays
    valid.
  - `started` is set synchronously before `executeCall` / `runPrepared`'s
    await, which keeps "Not run" honest.
  - A `beforeRun` (landed-check) throw gives `Not run` for calls that were
    never started. That is correct.
  - Persistence: the answers are in `session.messages` before `drive`'s catch
    runs `closeFailedTurn` and `finishTurn`, which persist them (T5g; no second
    answer on reload). On `main`, `closeFailedTurn` added nothing after
    `assistant[toolCalls]` (`persisted-session.ts:284-288`), so this closes a
    real dangling-call producer.
  - Steering window: the `finally` neither yields nor awaits, and the
    `drive` loop gains no `await`.
  - `agent_task`: `subagent.ts:454` never breaks out of the child generator.
    The child's own repairs are not surfaced (declared debt).
  - A running call left behind on an abnormal exit is not aborted (F17).
    That was already true on `main`.
- **(4) Part C.** Holds, except Finding 1.
  - `UPDATE_CLASS.history_repaired = "display"`, and `PROTOCOL_VERSION` is
    untouched (no `version.ts` in the diff).
  - Schema regenerated; both mappings, the CLI render and the TUI `state.ts`
    are wired.
  - The daemon dedup is synchronous inside `drive`.
- **(5) Providers.** Hold.
  - OpenAI `wireArguments` returns valid object JSON verbatim.
  - Anthropic `parseArgs` changes only non-object JSON, which becomes `{}`.
  - Neither can hide an agent-side bug from the tests: disabling the guard
    leaves T3 green, and reverting a `modelView` site makes it red (the note
    is asserted).
- **Other request sites** (`rg renderForModel|countTokensBounded|stream({`).
  - All three Agent sites are covered.
  - Compaction drops arguments (F11), and the title job uses user input only.
  - Pod `model/stream` / `model/countTokens` relays hit the provider guard on
    the laptop (F6).

### What does not hold, or is weak (below the reporting bar, for the record)

- T5h passes on both the old and the new code: it is a guard, not a red/green
  test.
- The round site yields `history_repaired` before `sent = messages.length`
  (`agent.ts:1136-1140`). Only microtasks fit there, so this is harmless today.

### How the executor behaved

- The Execution is accurate. Every claim I spot-checked matched the code:
  sites, mutations, T5 cases, the gate counts (identical to mine).
- Drifts are named honestly, including the masked `owner` mutation and the
  malformed-tool-call trouble during its own run.
- The miss is the plan's (F20 assumes all notices go through `drive`). The
  executor did not cause it.
