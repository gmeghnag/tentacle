# fix/truncated-reply-silent — a cut-off reply is accepted as complete, and a dead turn ends with nothing shown

> **Status:** context + implementation drafted; awaiting owner decisions Q1–Q5
> **Branch:** `fix/truncated-reply-silent`
> **Type:** fix · **Size:** S–M · **Blast:** cross-module · **Suited:** DeepSeek exec (fresh-context Review: it touches the agent loop)

## Context

*— deepseek (tentacle --profile deepseek), 2026-11-11*

### The incident (owner, live, local Qwen on llama-server)

Session `07812559-733667e1c262/9c34a8cb…`, 2026-11-11. Two distinct defects
appeared in one turn:

1. A reply was cut mid-sentence (`…la vera soluzione è`) and **accepted as the
   complete answer** — the turn ended `end_turn` normally.
2. The owner's next message produced **three empty rounds** (the reply, plus two
   `Continue with the task.` nudges) and the turn then ended `end_turn` with
   **nothing shown at all**. The TUI looked hung.

The trigger for the cut was config/server skew, not tentacle: llama-server's slot
context is 24064 tokens (`/slots` `n_ctx`, `--parallel 3`) while the config says
`contextWindow: 174080`, so the answer hit the slot limit at ~24k. That is the
owner's setup to fix — but **both tentacle behaviours are wrong regardless of it**,
which is what this task fixes.

### Triage: what actually happens today

Every row below is measured on this branch with a fake OpenAI-compatible SSE
server (`Bun.serve`, no key, no real API), never inferred from reading. Scripts:
`bun .tentacle/tmp/truncated-reply/<script>.ts` (gitignored, AGENTS §6). Outputs
captured **2026-11-11** on `32d35c4`.

Shared prologue of `repro.ts` / `e2e.ts` / `tui-e2e.ts` — `model` selects the
scripted body, so nothing else is needed:

```ts
const f = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const t = (s: string) => f({ choices: [{ delta: { content: s } }] });
const r = (s: string) => f({ choices: [{ delta: {}, finish_reason: s }] });
const tool = (n: string, a: string) =>
  f({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: n, arguments: a } }] } }] });
const BODIES: Record<string, () => string> = {
  length: () => t("la vera") + t(" soluzione") + r("length"),
  nodone: () => t("la vera") + t(" soluzione"),
  empty_length: () => r("length"),
  toolcut_length: () => tool("fs_write", '{"path":"a.ts",') + r("length"),
};
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { model?: string };
    return new Response((BODIES[body.model ?? ""] ?? (() => ""))(), {
      headers: { "content-type": "text/event-stream" },
    });
  },
});
const baseURL = `http://localhost:${server.port}/v1`;
```

#### Case (1) — `finish_reason: "length"` is taken as a finished answer

`OpenAIProvider.stream` never reads `finish_reason` for anything except
draining the tool-call assembler (`packages/providers/src/openai-provider.ts:206`).
`StreamEvent` (`packages/core/src/model.ts:113-117`) has no field that could carry
it, so nothing downstream can know.

```
$ bun .tentacle/tmp/truncated-reply/repro.ts
--- length: [{"type":"text","delta":"la vera"},{"type":"text","delta":" soluzione"},{"type":"done"}]
--- nodone: [{"type":"text","delta":"la vera"},{"type":"text","delta":" soluzione"},{"type":"done"}]
--- empty_length: [{"type":"done"}]
--- toolcut_length: [{"type":"tool_call","toolCall":{"id":"c1","name":"fs_write","arguments":"{\"path\":\"a.ts\","}},{"type":"done"}]
```

`length` and a body that just stops are **byte-identical to a normal reply**. At
the agent loop:

```
$ bun .tentacle/tmp/truncated-reply/e2e.ts
=== length
["text:\"la vera\"","text:\" soluzione\"","turn_end"]
=== nodone
["text:\"la vera\"","text:\" soluzione\"","turn_end"]
=== empty_length
["context_note","turn_end"]
```

`turn_end` with no reason qualifier is `end_turn`; the truncated text is pushed
as the assistant's answer (`packages/agent/src/agent.ts:1222-1226`). **Confirmed:
today's behaviour is exactly the reported one.**

**Contrast — Anthropic already does this right** (the shape to copy):
`packages/providers/src/anthropic-provider.ts:256-269` refuses a tool call cut by
`max_tokens`/`refusal` (`TRUNCATING_STOP_REASONS`, `:41`), and `:245-254` refuses
a stream that ends inside an open `tool_use` block. Text cut by `max_tokens` is
still accepted there — that half is missing on both providers.

#### Case (2) — a stream that just stops is byte-identical to a finished one.

Confirmed on today's code:
- `finish_reason: "length"` is read at `openai-provider.ts:206` only to drain
  the tool-call assembler; the value itself is dropped.
- `StreamEvent` (`packages/core/src/model.ts:113-117`) has no field to carry it,
  so the agent loop cannot know the reply was cut.

`parseSSE` returns quietly on a body that ends (`packages/providers/src/sse.ts:36-38`)
and the provider's own "flush what is open" branch
(`openai-provider.ts:214-221`) exists precisely because it cannot tell a clean
end from a cut one.

#### Case (3) — an empty reply with `finish_reason: "length"`

This is an ASSUMPTION about llama-server (not tested against a real one): a
prompt already at/over the slot's `n_ctx` leaves no room to generate, so the
server sends an empty delta and `finish_reason: "length"`. The owner's live
symptom (3 empty rounds) fits it.

What tentacle does with it is measured, not assumed — see case (4): the provider
yields a bare `done`, the loop counts an empty round.

#### Case (4) — the empty-round nudges run out and the turn ends with nothing

Three empty calls, then the loop's bounded nudge (`MAX_EMPTY_CONTINUES = 2`,
`packages/agent/src/agent.ts:189`) is exhausted and `turn_end{end_turn}` is
yielded (`:1299-1309`):

```
$ bun .tentacle/tmp/truncated-reply/agent4.ts
model rounds: 3
events: ["context_note(continue):Continue with the task.","turn_end"]
history: [{"role":"user","content":"hi"},{"role":"user","content":"Continue with the task."},{"role":"assistant","content":""}]
```

Three model calls for ONE nudge note: the first empty round pushes nothing and
pushes no note (`:1302` dedupes against the previous message), the second adds
the note, the third exhausts the budget. **The user sees no event at all** —
`context_note{reason:"continue"}` is deliberately hidden by both frontends
(`packages/tui/src/state.ts:489-490`, `packages/cli/src/render.ts:53-54`).

TUI frames of the REAL `App` (`ink-testing-library`, the pattern of
`packages/tui/test/app.test.tsx:104-125`), after Enter on `hi`:

```
$ bun .tentacle/tmp/truncated-reply/tui-e2e.ts
=== length: ===
⏺ Tentacle ready. Type a task, or /help for commands.

› hi

⏺ la vera soluzione
...
=== empty_length: ===
⏺ Tentacle ready. Type a task, or /help for commands.

› hi

(bottom bar) ❯  Type a task or /command ...  ⏵⏵ auto-accept off
```

Case (1) shows the truncated text as if complete. Case (3)/(4) shows **`› hi`
and nothing else** — no error, no notice, no `stopped` line: the reported
"looks hung". `turn_end{end_turn}` renders nothing
(`packages/tui/src/state.ts:512-519` only clears the running flag).

#### Case (5, found while triaging) — tool arguments cut by `length` are RUN

Not in the report, same root cause, worse consequence: with a tool call whose
`arguments` stop mid-JSON, the call is dispatched and the round repeats until the
step cap.

```
$ bun .tentacle/tmp/truncated-reply/toolcut2.ts
rounds: 17
tool_result(isError=true:"invalid JSON arguments for echo")
turn_end(max_iterations)
```

17 rounds on one truncated call (16 iterations + the final no-tools report).
On the owner's session the same shape is 16 wasted rounds per truncation.

### Recommendation (summary)

| Case | Today | After this fix (recommended) |
| --- | --- | --- |
| (1) text + `length` | accepted as the answer | text kept, visible notice, then ONE bounded "continue" (Q1a) |
| (2) body just ends | identical to (1) | a failed turn (an incomplete stream is an error) |
| (3) empty + `length` | silent empty round | notice; the round is not the model's choice, so it does not eat the nudges |
| (4) nudges exhausted | nothing shown, `end_turn` | a visible notice saying the model returned nothing |
| (5) tool args cut | the call runs, 16 wasted rounds | refused, turn fails loudly |

## Implementation

*— deepseek (tentacle --profile deepseek), 2026-11-11*

### Load-bearing assumption

**A `finish_reason` the provider has already parsed is the only place the fact
"this reply was cut" exists, and it is currently discarded.** Proven, not
assumed: `openai-provider.ts:206` receives it and uses it only to drain
`ToolCallAssembler`; `StreamEvent` (`packages/core/src/model.ts:113-117`) has no
field for it. Grep for `finish_reason|stop_reason` over every
`packages/*/src/` returns exactly two files — `openai-provider.ts` and
`anthropic-provider.ts`. No non-test source outside the providers can see the
fact at all. So the fix MUST start at the provider boundary: nothing downstream
can reconstruct it.

### Preconditions (verified against this branch)

- `OpenAIProvider` drops `finish_reason` (`openai-provider.ts:206-212`); a body
  that ends without it is indistinguishable (`sse.ts:36-38`, `:214-221`).
- `AnthropicProvider` already refuses a TRUNCATED TOOL CALL
  (`anthropic-provider.ts:256-269`, `TRUNCATING_STOP_REASONS` at `:41`) and an
  unclosed `tool_use` block (`:245-254`) — by throwing `ModelRequestError`.
  Text cut by `max_tokens` is accepted there too: the gap is in both providers.
- The agent loop turns any provider throw into a failed turn, except an abort
  (`agent.ts:1178-1210`); a non-abort throw is re-raised after keeping streamed
  text (`:1206-1209`), and the daemon turns it into `turn_end{error}`
  (`hosted-session.ts:2330-2345`).
- The empty-round nudge is bounded at 2 (`agent.ts:189`) and its note is hidden
  by both frontends (`tui/src/state.ts:489-490`, `cli/src/render.ts:53-54`).
- A new update KIND of class `display` needs **no** `PROTOCOL_VERSION` bump
  (AGENTS §7; `updates.ts:415-418` is the precedent from `dsml_leak`, and
  `version.ts:23` stays 22). Adding a value to `context_note.reason` WOULD be
  breaking — an older client sees a KNOWN kind failing its schema and reports
  `malformed` (the `dsml_leak` Review MEDIUM-1 finding).
- `UPDATE_CLASS` is a total `Record` (`updates.ts:405`), so a new kind without a
  class is a compile error; `KNOWN_UPDATE_TYPES` derives from it (`:446`).
- `StopReasonSchema` already has `max_tokens` (`protocol/src/session.ts:253-259`)
  and the TUI folds it to `end_turn` (`client/src/mapping.ts:71-82`), so the wire
  can carry the outcome with no schema change.

### Design

One new fact on the provider boundary, carried to the user in ONE new display
update kind, plus a bounded recovery in the loop.

**1. `StreamEvent` gains the stop reason** (`packages/core/src/model.ts:113-117`):
`{ type: "done"; usage?: Usage; stopReason?: "stop" | "length" | "tool_calls" | "other" }`.
Additive and optional, so every existing producer/consumer keeps compiling.

**2. Both providers name it.** `OpenAIProvider` records the last
`finish_reason` (`openai-provider.ts:206`) and reports it on `done`
(`:230`). `AnthropicProvider` maps `stop_reason` (already tracked at
`:230-232`) the same way: `max_tokens`/`refusal` → `"length"`. A reply whose
body ended with no `finish_reason` at all reports `"other"` — the caller's
signal that the stream was cut, never finished (case 2).

**3. The agent loop decides** (`packages/agent/src/agent.ts`, the `done` case at
`:1170-1175`):
- `stopReason === "other"` (no finish_reason: the body was cut) → the turn
  FAILS: `yield {type:"truncated_reply", ...}` then re-throw a
  `ModelStreamCutError` so the daemon reports `turn_end{error}`. Partial text
  already shown is kept in the history (the existing `:1206-1209` rule), never
  presented as an answer.
- `stopReason === "length"` with text → keep the text as the answer AND yield
  the notice (the reply is real work, just unfinished).
- `stopReason === "length"` with NO text and NO tool call → an empty round that
  is NOT the model's choice: count it against a separate bounded budget and
  yield the notice (case 3), so the loop never burns its nudges on it.
- `stopReason === "length"` with a tool call → refuse exactly as Anthropic does
  today (`anthropic-provider.ts:256-269`): the arguments may be partial JSON, so
  the call is never run (case 5).

**4. One new display update KIND — `truncated_reply`.** Class **`display`**
(`UPDATE_CLASS`, `packages/protocol/src/updates.ts:405-443`), so
**`PROTOCOL_VERSION` does NOT bump** (AGENTS §7 rule 2: "display: free to add";
an older client shows `unsupported` once and keeps working; nothing waits on it).
Its own kind, NOT a `context_note.reason` value — for the reason proved in
`dsml_leak`'s Review MEDIUM-1: a new enum member of a KNOWN kind fails an older
client's schema as `malformed context_note`.
Same shape both ways: `{ type: "truncated_reply", reason: "length" | "cut" }`.

The user-facing sentence is built once, in a pure core function
(`describeTruncation(reason, { answered }: …)`, next to `describeRepairs` in
`packages/core/src/history-validity.ts:283` — the established pattern), so the
TUI and the CLI cannot drift: presentation is the components' job, wording is
not (AGENTS §7).

Wiring both ends (AGENTS §7: "a new `session/update` variant → a union member +
its reverse mapping"):
`agent.ts` (event) → `daemon/src/mapping.ts:250` (event → update) →
`protocol/src/updates.ts` (schema + `UPDATE_CLASS`) →
`client/src/mapping.ts:290` (update → event) → `tui/src/state.ts:495`
(`appendNotice`) and `cli/src/render.ts:56` (`case`).

**5. The dead turn (case 4) gets its own notice, not silence.** When the nudge
budget runs out with nothing said (`agent.ts:1299-1309`), yield
`{ type: "empty_turn" }` — a SECOND new `display` kind, or (owner Q3) reuse
`truncated_reply` with `reason: "empty"`. One kind is cleaner; two are more
honest. The notice is the whole point of this task's second half: a turn that
produced nothing must SAY so.

**6. Why not auto-compact on `length`** (Q1 option c): `MAX_EMPTY_CONTINUES`
lives in the loop, and compaction is `Session.compact` one layer up
(`agent/src/session.ts:255`, a daemon `session/compact` RPC at
`hosted-session.ts:2673`) — the loop cannot call it. A compaction from inside a
round is therefore a real design change (§7: one seam, no second path), not a
two-line special case. Recommended: notice only (a), with "continue" (b) offered
as the next step if the owner wants recovery in the same turn.

### Files

In dependency order (smallest diff; `P` = protocol, everything after is
additive):

1. `packages/core/src/model.ts` — `StreamEvent.done.stopReason?` (5 lines).
2. `packages/core/src/truncation.ts` (new) — `describeTruncation`, the notice text
   for each case, pure + unit-tested; `core/src/index.ts` re-exports it.
3. `packages/providers/src/openai-provider.ts` — record `finish_reason`
   (`:206`), report on `done` (`:230`).
4. `packages/providers/src/anthropic-provider.ts` — map `stop_reason` on `done`
   (`:280`), reusing its existing `TRUNCATING_STOP_REASONS` (`:41`).
5. `packages/agent/src/agent.ts` — the four `done` branches (`:1170-1175`), the
   empty-round notice (`:1299-1309`), two new `AgentEvent` variants (`:404-423`).
6. `packages/protocol/src/updates.ts` — `TruncatedReplySchema`,
   `EmptyTurnSchema`, `UPDATE_CLASS` entries, union member (`:380`).
   **No `PROTOCOL_VERSION` bump.**
7. `packages/daemon/src/mapping.ts` — `truncated_reply` / `empty_turn` cases
   (next to `:250`).
8. `packages/client/src/mapping.ts` — reverse mapping (next to `:290`).
9. `packages/tui/src/state.ts` (`:495`) and `packages/cli/src/render.ts` (`:56`)
   — show both notices.
10. `packages/protocol/schema/protocol.json` — regenerated
    (`bun run schema:export`); the drift gate fails otherwise.
11. `CHANGELOG.md` (Fixed).

### Failure modes

Each with how state converges:

- **Cancel mid-stream** (Esc): the abort check precedes everything
  (`agent.ts:1182-1186`, `:1216-1220`). A cancel is `turn_end{cancelled}` and no
  notice — a truncation says `error`/`length`, never `cancelled`. `parseSSE`'s
  quiet `return` on abort (`sse.ts:32-34`) stays as is: making it throw is
  `eval/sse-abort-truncated-toolcall.md`'s separate question.
- **Tool-call args cut by `length`** (case 5): refused before dispatch, so no
  partial call enters the history and no 16-round loop (`toolcut2.ts`). Same
  refusal Anthropic already has.
- **Sub-agent children**: they read the parent's `AgentEvent`s
  (`subagent.ts:482-484` records `turn_end.reason`), so `stopReason: "error"`
  makes the child stop instead of continuing (`:488-495`), and its report is the
  existing "finished without producing a report" note (`:529-534`), which names
  the reason. No new plumbing.
- **`connect` / `serve`**: no laptop copy; the `serve` daemon writes the log. The
  notice is rendering-only, so it is never persisted (AGENTS §7) and a replay
  shows no stale notice.
- **Pod (`run`/`attach`)**: the daemon-side agent runs the loop, so it takes the
  same branches; only the new `display` kind crosses the tunnel. An OLDER laptop
  shows `unsupported` once — acceptable for display class, and the reason no
  bump is needed.
- **A server that never sends `finish_reason` but IS complete** (some
  OpenAI-compatible shims): reported `"other"` → the turn fails where it used to
  succeed. This is the one real regression risk; Q2 decides it, and
  `tool-call-split-e2e`-style fakes pin the behaviour both ways.
- **Empty reply that is genuinely the model's choice** (a small model returning
  nothing): unchanged — the bounded nudge still runs, then the new empty-turn
  notice replaces silence.

### Tests

Red-before-green (§9), each shown failing on today's code first; all use fake SSE
servers in the shape of `packages/providers/test/openai-provider.test.ts` /
`select-provider.test.ts:114-190` (no keys, no real API).

| Test file | Pins | RED on today because |
| --- | --- | --- |
| `providers/test/openai-stop-reason.test.ts` | `done.stopReason` is `"length"` / `"stop"` / `"other"` for the three bodies | `done` has no such field |
| `providers/test/anthropic-stop-reason.test.ts` | `max_tokens` → `"length"` | field absent |
| `agent/test/truncated-reply.test.ts` | text+`length` → text kept + `truncated_reply` notice; then `turn_end` | no event exists |
| `agent/test/truncated-reply.test.ts` | no-finish-reason → `truncated_reply{cut}` + failed turn | today: `end_turn` with the text as the answer |
| `agent/test/truncated-reply.test.ts` | tool call cut by `length` → refused, no `tool_start`, 1 round | today: 17 rounds (measured) |
| `agent/test/empty-turn.test.ts` | nudges exhausted → `empty_turn` notice before `turn_end` | today: nothing (measured) |
| `protocol/test/truncated-kind.test.ts` | the kinds are `display`, `PROTOCOL_VERSION` is still 22, `context_note.reason` did NOT grow, the catch-all parses an older client's frame | kinds absent |
| `daemon/test/mapping.test.ts`, `client/test/mapping.test.ts` | both mappings round-trip | absent |
| `tui/test/state.test.ts`, `cli/test/render.test.ts` | the notice is VISIBLE (and a `context_note{continue}` still is not) | absent |
| `core/test/truncation.test.ts` | the wording, one function | absent |

### Owner questions

Each has my recommendation FIRST. Q1 and Q2 gate execution; Q3–Q5 are smaller.

#### Q1 — what should `finish_reason: "length"` do?

- **(a) RECOMMENDED — a visible notice, PLUS one bounded "continue" re-ask.**
  The owner asked for the complete UX, and this is the cheapest shape that
  actually recovers the answer: keep the partial text, show
  `truncated_reply{length}`, then re-ask ONCE with a note telling the model to
  resume from where it stopped. It is the `dsml_leak` pattern exactly
  (`MAX_DSML_REASKS = 1`, `agent.ts:195`, re-ask at `:1192-1203`), which is
  already reviewed, bounded and tested — so it is reuse, not new design. The
  re-ask note rides the conversation as a `context_note` with the EXISTING
  `reason: "continue"` (no enum growth), and must not consume the step budget
  (`budgetFrom--`, as `dsml_leak` does). Bounded to ONE because a truncation
  caused by a FULL context re-truncates immediately: a second would loop.
- **(b) a visible notice only.** Smaller (no new control flow, no extra model
  call), and it already fixes the reported "silently accepted". But the user
  still has to type "continue" themselves — the very interruption the empty-round
  nudge was invented to remove.
- **(c) a notice plus auto-compaction, then retry.** The most complete answer on
  paper, but the agent loop cannot do it: compaction is `Session.compact`
  (`agent/src/session.ts:255`) driven through the daemon's busy slot and its own
  RPC (`hosted-session.ts:2673`). Driving it from inside a round is a new seam
  across AGENTS §7's "one session path", so it belongs in its own `feat` where
  the daemon owns that state transition. Recommended against HERE.

#### Q2 — cut stream: error or notice?

- **(a) RECOMMENDED — treat it as an ERROR: the turn fails.**
- **(b) a truncation notice, turn ends `end_turn`.**

Why (a): an incomplete stream is not a slower answer, it is missing data. Presenting it as complete is the bug being fixed. The realistic cause is a dropped connection, a proxy timeout or a crashed llama-server: all real failures.

There is also a concrete precedent for (a) in this codebase: `AnthropicProvider` ALREADY throws on a stream that ends inside an open `tool_use` block (`anthropic-provider.ts:245-254`), on exactly that reasoning.

Risk of (a): an OpenAI-compatible shim that never sends `finish_reason` yet is genuinely complete would now fail its turn. That is why a fake server must pin both shapes, and why this is the one question I would not settle without the owner.

#### Q3 — one notice kind or two?

- **(a) RECOMMENDED — two kinds:** `truncated_reply` (a cut reply) and `empty_turn` (nothing at all). They are different facts with different remedies, and the user reads a different sentence for each.
- **(b) one kind, `reason: "length" | "cut" | "empty"`.** Fewer protocol entries, but it conflates "your answer was cut" with "the model said nothing".

#### Q4 — does the same fix cover Anthropic text truncation?

- **(a) RECOMMENDED — yes, both providers, one seam.** `max_tokens` on Anthropic cuts text the same way today, and `TRUNCATING_STOP_REASONS` already exists (`anthropic-provider.ts:41`). Fixing only OpenAI leaves half the bug.
- **(b) OpenAI only, Anthropic as a follow-up.** Smaller diff, but the same class of silent loss stays on the other provider.

#### Q5 — should the truncation also be a `StopReason` on the wire?

- **(a) RECOMMENDED — no. `turn_end{end_turn}` plus the display notice.** The laptop's `stopReasonFromProtocol` already folds `max_tokens` to `end_turn` (`client/src/mapping.ts:71-82`), so carrying it separately would be invisible to every frontend.
- **(b) `turn_end{max_tokens}` for a cut reply.** More truthful on the wire, and `StopReasonSchema` has the value (`protocol/src/session.ts:253-259`); but `stopReasonToProtocol` (`daemon/src/mapping.ts:150-159`) would need a fourth arm, and no client renders it today.

#### Owner answers (2026-11-11)

Q1 (a) visible notice + ONE bounded "continue" re-ask · Q2 (a) a cut stream is an ERROR, the turn fails · Q3 (a) two kinds `truncated_reply` / `empty_turn` · Q4 (a) both providers · Q5 (a) no new wire `StopReason`. Plan approved for execution.

## Execution

*— (empty: this run is triage + plan; no production code changed)*

## Review

*— (empty: a fresh-context adversarial pass once Execution lands)*
