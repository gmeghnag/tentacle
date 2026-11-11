# fix/deepseek-dsml-leak — DeepSeek leaked tool calls as text; long-argument splits

> **Status:** review
> **Branch:** `fix/deepseek-dsml-leak`
> **Type:** fix · **Size:** S–M · **Blast:** cross-module · **Suited:** DeepSeek exec (fresh-context Review)

## Context

*— deepseek, 2026-11-11*

Two faults, one night, one log
(`.tentacle/tmp/orchestration/runs/exec-history-validity.log`, 2026-11-10, 779
lines). Both were **triage questions** first: is the model/server sending
malformed data, or is tentacle mis-assembling a valid stream?

### Verdict

| Symptom | Answer | Evidence |
| --- | --- | --- |
| Tool call as text (DSML) | **(a) endpoint side** | log 773–778 |
| `invalid JSON arguments` on LONG bodies | **(b) tentacle** | 108/108 pairs |

**Symptom 1 is (a).** Lines 773–778 are assistant *content* as the CLI renders
it (prose prefix, then the DSML tags, one per line) with **no `[tool]` line and
no `[result:]` line at all**, then the log ends. A `[tool]` line would mean
tentacle parsed a tool call and dispatched it; there is none, so the endpoint
handed the markup over as ordinary `content`. tentacle then treated that text as
the final answer and ended the turn — which is the *acceptance* half of the bug,
and is what the guard addresses. The DSML bytes are the DeepSeek template's own
(`U+FF5C` on each side of `DSML`, a space before `invoke`/`parameter`), so the
server rendered the call in its template but never parsed it back into
`tool_calls`.

**Symptom 2 is (b) — tentacle.** The log's `invalid JSON arguments for X` lines
alternate with `[tool]  <tail>` lines: a `[tool]` line whose **name is empty**
(the CLI prints `${name} ${arguments}`) that `ToolRegistry.execute` answers with
`unknown tool: ` (`packages/tools/src/registry.ts:75-77`). A pair is one logical
call split in two: a head that fails `JSON.parse` and a nameless tail carrying
the rest. That is 108 `invalid JSON` + 108 `unknown tool: ` lines, and the tail
behind every one of them is *the continuation of the head's arguments*. Nothing
in the model's output was malformed; the assembly was.

The cause is in `ToolCallAssembler` (was `packages/providers/src/openai-provider.ts:96-125`):
it keyed streamed deltas purely on the wire `index`
(`this.calls.get(d.index)`). A delta that omits `index` (or repeats it after the
server's bookkeeping moves) therefore opened a **second** slot: the continuation
went to a new, nameless call. The old code then drained it as a real call
(`name: ""`), so the tool loop saw two calls where the server streamed one.

### Repro

Two harnesses, both on the INTERIM code before the fix (pasted output):

1. Log pairing — does a head+tail pair really reconstruct one call?
   Script: `.tentacle/tmp/dsml-leak/join.mjs` (gitignored). It concatenates the
   named `[tool]` head with the following empty-name `[tool]` tail and parses it.
   Output (2026-11-11):

   ```json
   { "pairs": 108, "joined": 108 }
   ```

   Every pair is one call. (A same-length control also parses, because the seam
   falls inside the `content` string; the *shape* — `keys: ["content","path"]`,
   `contentLen: 4082` — is what identifies a real `fs_write` body.)

2. Live reproduction, in this task's own tool path. While writing this doc and
   the tests, the SAME split hit the executor: a single tool call arrived as
   `invalid JSON arguments for shell` (1250 bytes) plus `unknown tool: `
   (4496 bytes) — one command, split. Repeating the identical command sometimes
   succeeded, sometimes split, and batching two tool calls in one message split
   almost always (10+ occurrences, all on the pre-fix code). That is the
   incident's mechanism reproduced on demand, on current code, without any API
   key or network model call.

3. After the fix: the same batching no longer splits (this doc and the test
   files were finished that way).

## Implementation

*— deepseek, 2026-11-11*

### Load-bearing assumption

**A streamed argument delta that names no id and no function name CONTINUES the
running call, and must not open a new one.** Proven by the incident: every one
of the 108 split tails starts mid-JSON, so the bytes can only be a continuation
of a call already open — the server sent one call and tentacle counted two.
`tool-call-stream.ts` implements the rule; `tool-call-stream.test.ts` pins it.

### Preconditions (verified)

- `ToolCallAssembler` keyed only on `d.index` (was
  `packages/providers/src/openai-provider.ts:96-125` on `main`); a delta without
  `index` landed under the key `undefined`.
- The registry never validates a name: `ToolRegistry.execute` answers
  `unknown tool: ${name}` for `""` (`packages/tools/src/registry.ts:75-77`), so a
  nameless drain is dispatched, not rejected earlier.
- The agent loop runs whatever `tool_call` events the provider yields
  (`packages/agent/src/agent.ts:1146-1155`), so a phantom call is a real round-trip.
- `context_note` is a **display** update (`packages/protocol/src/updates.ts:393`),
  so a new reason needs no `PROTOCOL_VERSION` bump; the enum is extended on both ends.
- The DSML bytes come from the incident's log: `U+FF5C` each side of `DSML`, a
  space before `invoke`/`parameter`.

### Design

**Symptom 2 (b) — fix the assembly.** `ToolCallAssembler` moves out of
`openai-provider.ts` into `packages/providers/src/tool-call-stream.ts` (AGENTS §7:
computation in a pure module, one owner) and gains the own-call rule:

- a continuation (no id, no function name, has arguments) appends to the
  **running** call, whatever index it claims;
- anything naming an id or a name starts its own call, keyed by its index when it
  has one;
- a name is joined across deltas but never doubled;
- `drain()` **drops** a call that was never named — a fragment is not a call.

**Symptom 1 (a) — a narrow guard, both ends.**

- `packages/core/src/dsml.ts`: `hasDsmlToolCallMarkup` — true only for a WHOLE
  block (opening invoke tag, at least one parameter tag, closing invoke tag). No
  other markup family is guessed at. `DsmlToolCallLeakError` carries the byte
  count, never the text.
- `openai-provider.ts`: accumulates the visible text and, at the end of a reply
  that streamed **no real tool call**, throws if that text holds a DSML block. A
  reply with text PLUS a real call is left alone.
- `agent.ts`: catches it, emits a `context_note` (`leaked_tool_call`), pushes
  `DSML_REASK_NOTE` as a user message and runs the round again — **bounded to
  one** re-ask per turn. A second leak fails the turn, so the user sees a real
  failure instead of an endless retry. The leaked text is never stored as the
  assistant's answer.

### Files

1. `packages/core/src/dsml.ts` (new) + `packages/core/src/index.ts`
2. `packages/providers/src/tool-call-stream.ts` (new; the assembler)
3. `packages/providers/src/openai-provider.ts` (import it; DSML guard at stream end)
4. `packages/providers/src/index.ts`
5. `packages/agent/src/agent.ts` (bounded re-ask; `context_note` reason)
6. `packages/protocol/src/updates.ts` (reason enum)
7. Tests: `core/test/dsml.test.ts`, `providers/test/tool-call-stream.test.ts`,
   `providers/test/tool-call-split-e2e.test.ts`, `providers/test/dsml-leak.test.ts`,
   `agent/test/dsml-leak.test.ts`
8. `CHANGELOG.md` (Fixed), this doc.

### Failure modes

- **A continuation with no call open** (a stray tail): opens a nameless slot, and
  `drain()` drops it — no phantom call.
- **A genuinely nameless call**: dropped; it could only have produced
  `unknown tool: `.
- **Two real calls**: kept distinct and ordered (the second names its id/name).
- **Name in pieces vs restated**: joined, not doubled.
- **Leak, then a clean reply**: the turn continues and ends normally.
- **Leak twice**: the turn fails with `DsmlToolCallLeakError` — bounded.
- **Prose mentioning DSML, or a truncated block**: not refused (whole-block shape
  required), so the guard cannot eat a real answer.
- **A cancel during the leak**: the abort check runs first, as for any mid-stream error.

### Tests

Red-before-green per symptom, each shown failing on the pre-fix code:

- `tool-call-stream.test.ts` — the own-call rule (7 cases). **RED on the old
  assembler: 4/7 failed.**
- `tool-call-split-e2e.test.ts` — the incident's shape over a fake SSE server: one
  long body, many deltas → ONE complete call. **RED: the omitted-index case
  failed.** (The repeated-index case passes on both — kept as a guard, not as proof.)
- `dsml.test.ts` — whole block yes; prose, bare mention, truncated block no.
- `dsml-leak.test.ts` (providers) — a fake SSE server whose content IS the
  incident's block: refused. **RED with the guard disabled.**
- `dsml-leak.test.ts` (agent) — one leak → one re-ask → turn proceeds; two leaks →
  the turn fails after exactly two attempts; the leaked text never enters the
  history. **RED with the re-ask disabled.**
- `cli/test/render.test.ts` — the `leaked_tool_call` notice is visible, while the
  loop's other notes stay hidden. **RED with the render change reverted.**

## Execution

*— deepseek, 2026-11-11*

Done in the Implementation's order: `core/dsml.ts` → `providers/tool-call-stream.ts`
→ `openai-provider.ts` → `agent.ts` → protocol enum + `schema:export` → tests →
CHANGELOG. Two drifts, both from the fresh-context Review:

1. **The first assembler rule was wrong and was replaced.** It sent EVERY
   index-less delta to the running call, which cross-wires two parallel calls
   interleaved by index (call 1's tail could land on call 0) — a regression the
   old code did not have. The shipped rule keeps an explicit `index`
   authoritative always, and only an index-less delta continues the running call
   (unless it carries a different id). `tool-call-stream.test.ts` now pins
   interleaving-by-index explicitly.
2. **The re-ask was not wired to the user.** `context_note` renders only for
   `reason === "hook"` in both frontends, so the notice existed only for the
   model. `cli/render.ts` and `tui/state.ts` now show `leaked_tool_call` too, with
   a red-before-green test in `cli/test/render.test.ts`.

Also from Review: the leaked text is never pushed to the history even on the
FAILING (second-leak) path (it was, before); `answer` accumulation is gated on
`!sawToolCall`; the re-ask does not consume the round budget (`budgetFrom--`, as
an accepted context reset); the ambiguous `WireToolCallDelta` re-export in
`openai-provider.ts` is gone; the dead test class is gone.

Not done, and why: the pod path. Over `model/stream` the laptop rethrows a
provider error as a bare `Error` on purpose (AGENTS §7: a pod must not receive a
provider's message), so a client-daemon-side `DsmlToolCallLeakError` arrives as an
opaque `internal error` and the re-ask does not fire there. `serve`/`connect` and
every in-process runtime (TUI, `run`, `attach`'s local model) are unaffected. This
is a pre-existing property of the tunnel, not something this fix introduces, and
changing it is a protocol decision — recorded as follow-up rather than smuggled
in here.

Gate: `bunx tsc --noEmit` clean · `bun run lint` clean (0 errors, 0 warnings) ·
`bun test` 6813 pass / 3 skip (the opt-in k8s + docker + slow-keepalive) /
**0 fail**. (`apps/mobile` needed `bun install --filter @tentacle/mobile` in this
fresh worktree; its `@tentacle/client` link was missing, which is an install
artifact, not a test failure.)

## Review

*— deepseek, 2026-11-11 (adversarial pass in a fresh context)*

Run as a separate read-only agent against the diff, told to attack it. It found
three real blockers in my first implementation, all now fixed (see Execution):

- The index-less-continuation rule cross-wired interleaved parallel calls —
  **would have shipped a worse bug than the one being fixed**. Replaced with the
  index-authoritative rule above; interleaving is now a pinned test.
- The leaked text was stored as the assistant's answer on the SECOND leak,
  contradicting this doc. Fixed (`DsmlToolCallLeakError` never pushes text), and
  pinned by the history assertion.
- The schema drift gate was red (`protocol.json` stale after the enum change).
  Fixed with `bun run schema:export`.

Confirmed sound by that pass: the guard is reachable when the stream ends with
no `finish_reason`; it is skipped whenever a real tool call streamed (including
text-plus-call replies); `RetryingModelProvider` rethrows a non-transient error
unchanged, so the agent's catch does see it; the re-ask cannot loop past two
attempts; `text` is reset per round; the abort check precedes the re-ask.

Known, deliberately not fixed: the pod path (see Execution) — a pod session fails
its turn with `internal error` instead of re-asking. Follow-up, not a regression.


