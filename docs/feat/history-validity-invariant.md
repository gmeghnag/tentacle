# feat/history-validity-invariant — should the message history have an enforced well-formedness invariant?

> **Status:** feat — promoted by the owner 2026-11-10 after a live session poison (llama.cpp 500 "Failed to parse tool call arguments as JSON" on every request after one invalid `fs_write` call)
> **Branch:** `feat/history-validity-invariant`
> Type: feat · Size: M · Blast: load-bearing · Suited: DeepSeek exec, one fresh Opus review

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

*— claude-opus-5-5, 2026-11-10*

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

/** `raw` if it parses to a plain JSON object (non-null, non-array); "{}" otherwise. */
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
```

**Repair rules.** These are exact. `index` is the position in the **input**.
1. **Arguments.** Each `toolCalls[k].arguments` → `wireArguments(raw)`.
   - If `raw.trim() === ""`, the issue is `empty_arguments` and gets no note. The
     registry and the Anthropic provider already treat `""` as `{}`, so this is
     not an error.
   - If `raw` is non-empty and the result differs, the issue is
     `invalid_arguments`. `bytes` is the UTF-8 length (`new TextEncoder().encode(raw).length`).
   - Only the **copy** of the assistant message changes. The input objects are
     never mutated.
2. **Telling the model.** The paired `tool` message of an `invalid_arguments`
   call gets `"\n\n" + invalidArgumentsNote(bytes)` appended to its `content`, in
   the copy. The note text is:
   `[history: this call's arguments (N bytes) were not a valid JSON object; they are omitted from this copy of the conversation.]`
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

**Wiring in the agent.** Add one helper next to `renderForModel` in
`packages/agent/src/context-awareness.ts`:

```ts
/** The model's copy of the history: repaired for the wire (repairHistory), then rendered. */
export function modelMessages(history: readonly ChatMessage[]): ChatMessage[] {
  return repairHistory(history).messages.map(renderForModel);
}
```

Replace `messages.map(renderForModel)` with `modelMessages(messages)` at `agent.ts:1105`,
`:1292` and `:1422`, and nowhere else. The estimate (`estimateUsed`,
`context-awareness.ts:87-101`) stays on the stored history (see failure mode F8).
`notifyModelRequest` (`agent.ts:1115`) then sees the repaired request, which is
the request actually sent.

**Provider guard.**
- `toWireMessage` (`openai-provider.ts:287`): change
  `arguments: tc.arguments` to `arguments: wireArguments(tc.arguments)`.
- `parseArgs` (`anthropic-provider.ts:420-432`): return `{}` for a parsed value
  that is not a plain object. Also fix its comment ("The agent loop guarantees
  parseable arguments" is false today. After this change, the Agent's wire
  repair guarantees it.)

**Surfacing.** No new user-visible event (owner Q3). The user already sees the
failed call's row, `invalid JSON arguments for fs_write`, and the repair changes
only the model's copy. Nothing stored is dropped, so nothing is silently lost.

**Not changed.** Protocol: no change, no `PROTOCOL_VERSION` bump. Persisted
format: no change (no `schemaVersion` / `DAEMON_STATE_VERSION` bump). The
registry's error text and `runToolCalls`'s exception safety are unchanged (owner Q4).

### Files

In dependency order:
1. `packages/core/src/history-validity.ts` (new): the pure module above.
2. `packages/core/src/index.ts`: add `export * from "./history-validity.ts";`.
3. `packages/core/test/history-validity.test.ts` (new): unit tests T1.
4. `packages/providers/src/openai-provider.ts`: `toWireMessage` uses `wireArguments` (:287).
5. `packages/providers/src/anthropic-provider.ts`: `parseArgs` rejects non-objects (:420-432).
6. `packages/providers/test/wire-arguments.test.ts` (new): T2.
7. `packages/agent/src/context-awareness.ts`: add `modelMessages`.
8. `packages/agent/src/agent.ts`: the three sites (:1105, :1292, :1422) plus the import (:57).
9. `packages/agent/test/history-validity-e2e.test.ts` (new): T3 (with the fake llama.cpp server).
10. `packages/daemon/test/persistence.test.ts`, or a new `history-validity-reload.test.ts` beside it: T4.
11. `TODO.md`: mark the related items (see Notes). This doc: Execution + Review.

There are no `client`/`cli`/`tui` changes.

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
  The provider guard rewrites them to `{}` on the laptop (T2). That request has no
  note, which is acceptable: the request is still valid. A pod can already send
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
- **T2. Provider wire.** Use the `Bun.serve` body-capture pattern of
  `packages/providers/test/tool-duration.test.ts`.
  - OpenAI: the body for invalid, `""` or non-object arguments carries
    `"arguments":"{}"`; a valid history's body is byte-identical to the
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
    - The captured round-2 request carries `"arguments":"{}"`, and the paired
      tool content ends with the `[history: … (N bytes) …]` note.
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
- **Gate.** Run `bun test` (full), `bun run typecheck` and `bun run lint` against
  the §6 baseline.

### Owner questions

Decisions only the owner can make. Each lists the recommendation first.

- **Q1. What replaces invalid arguments in the model's copy?**
  - **(a) `"{}"`, plus the note appended to the paired tool result** *(recommended)*.
    The arguments slot stays a plain, schema-neutral object. The explanation goes
    where the model reads outcomes. The model cannot learn to imitate a marker.
  - (b) A marker object, `{"_invalid_arguments":true,"bytes":N}`. This is
    self-describing, but the model sees it as something it "called" and may copy it.
  - (c) An object with a truncated prefix of the raw string, `{"_raw_prefix":"…"}`.
    This shows the model what it wrote, but re-sends model bytes. Larger, and of
    little use.
- **Q2. Also replace valid but oversize arguments in the model's copy?**
  - **(a) No. This task repairs only what poisons the wire** *(recommended)*.
    Size belongs to the "Oversize / degenerate tool-call guard" (`TODO.md:90`),
    which rejects early, at assembly, with an actionable error. It will reuse
    `wireArguments` for the JSON check. Hiding a *successful* write's content from
    the model would make it lose track of what it did.
  - (b) Yes, above N KiB (for example 64 KiB) → `{}` plus a note.
- **Q3. Surface the repair to the user?**
  - **(a) No new event** *(recommended)*. The failed call's row already shows the
    error, and the repair changes only the model's copy. Nothing stored is
    dropped. Adding an event would need a new `session/update` display kind, which
    is protocol work for no new information.
  - (b) A one-time notice per session when a repair first happens, as a new
    display update kind (`UPDATE_CLASS`, no version bump).
- **Q4. Also make the loop itself exception-safe** (a `try/finally` in
  `runToolCalls` that answers the outstanding ids before propagating; eval
  scenarios A/B/C/H)?
  - **(a) Defer it to its own `fix`** *(recommended)*. With this feature, dangling
    ids can no longer poison the wire (rule 3), and the reload already closes cut
    turns honestly (P2). The `finally` touches the five tool-push sites of the
    load-bearing loop (`agent.ts:1538-1890`), and H's lost result needs its own
    design (push before yield). That is a separate change with a separate review.
    It extends `TODO.md:154`.
  - (b) Include it here (Size → L).

### Notes / debt

- Subsumes the *persistence/poison* half of `TODO.md:90` (oversize/degenerate
  guard). Its early-reject half stays open, and it should call `wireArguments`.
- Subsumes the history-corruption consequence of `TODO.md:154` (a requester throw
  escapes): dangling ids are now harmless on the wire.
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

*— (empty until promoted)*

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
