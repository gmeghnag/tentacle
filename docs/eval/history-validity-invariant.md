# eval/history-validity-invariant — should the message history have an enforced well-formedness invariant?

> **Status:** eval (Context + Review; direct-to-`main`, no branch; Implementation empty until promoted)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10)
> **Prospective work (if promoted):** Type: `feat` · Size: M · Blast: load-bearing (agent-loop history writes, the persist boundary, and the resume path — the `fs_edit`/session-poison class) · Suited: strong model executes + mandatory fresh-context Review per §10.

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
| 6 | Poisoned "until hand-edited with jq" | **PARTIALLY** | G: `/compact` is an unadvertised rescue. `renderMessage` (`packages/agent/src/compact.ts:19-26`) flattens tool calls to `[called: name]` and **drops arguments**, so neither dangling ids nor 167 KB of args reach the summariser. It loses detail, and it depends on a non-empty summary (see `docs/eval/compact-empty-summary-wipe.md`) |
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

*— (empty until promoted)*

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
  - `docs/eval/compact-empty-summary-wipe.md`: the `/compact` rescue path in
    row 6 depends on it.
  - `docs/eval/daemon-compact-turn-guard.md`: a concurrent compact during a turn
    is another way to mutate history mid-turn. That needs its own guard;
    validation does not make a race safe.

**Unverified (one line):** whether the target llama.cpp / vLLM builds reject an
unanswered `tool_call_id`. To check, POST the scenario-F payload (from `hv.ts`)
to the live endpoint.
