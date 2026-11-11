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
- A new update KIND of class `display` needs no `PROTOCOL_VERSION` bump (AGENTS §7).
- **CORRECTED after Review MEDIUM‑1.** The first version of this doc claimed a
  new `context_note.reason` ALSO needed no bump "because `context_note` is
  display". That is wrong: an older client does not see a new enum value as an
  unknown kind — it sees a KNOWN kind whose member fails its schema, and
  `classifyUpdate` (`packages/client/src/mapping.ts:57-58`) returns
  `malformed context_note update from the daemon`, which the reducer emits as an
  error mid-turn. So the notice is a new display KIND (`dsml_leak`), and the
  `context_note` reason enum stays exactly as it was.
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
  block, anchored on an opening PARAMETER tag (attributes allowed, optional
  space after the bar) plus, after it, one of the block's closing tags
  (`parameter`/`invoke`/`calls`). Anchoring on an opening invoke tag was the
  bug Review HIGH-1 found: the incident's reply has no opening invoke at all.
  No other markup family is guessed at. `DsmlToolCallLeakError` carries the
  byte count, never the text.
- `openai-provider.ts`: accumulates the visible text and, at the end of a reply
  that streamed **no real tool call**, throws if that text holds a DSML block. A
  reply with text PLUS a real call is left alone.
- `agent.ts`: catches it, emits a `dsml_leak` event (its own display KIND on the
  wire, `packages/protocol/src/updates.ts`), pushes `DSML_REASK_NOTE` as a user
  message and runs the round again — **bounded to one** re-ask per turn. A
  second leak fails the turn, so the user sees a real failure instead of an
  endless retry. The leaked text is never stored as the assistant's answer.

### Files

1. `packages/core/src/dsml.ts` (new) + `packages/core/src/index.ts`
2. `packages/providers/src/tool-call-stream.ts` (new; the assembler)
3. `packages/providers/src/openai-provider.ts` (import it; DSML guard at stream end)
4. `packages/providers/src/index.ts`
5. `packages/agent/src/agent.ts` (bounded re-ask; the `dsml_leak` event)
6. `packages/protocol/src/updates.ts` (the `dsml_leak` display kind — a new
   KIND, never a `context_note` reason: see the corrected precondition)
7. Tests: `core/test/dsml.test.ts`, `providers/test/tool-call-stream.test.ts`,
   `providers/test/tool-call-split-e2e.test.ts`, `providers/test/dsml-leak.test.ts`,
   `agent/test/dsml-leak.test.ts`, `protocol/test/dsml-leak-kind.test.ts`
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
- `dsml.test.ts` — the incident's LITERAL bytes (no opening invoke tag): yes;
  the template's full block with attributes: yes; prose, a bare mention, an
  orphan closer, a truncated block: no.
- `dsml-leak.test.ts` (providers) — a fake SSE server whose content IS the
  incident's block: refused; prose that MENTIONS DSML: accepted.
  **RED on the old matcher (3 failures).**
- `dsml-leak-kind.test.ts` (protocol) — the notice is its own `display` KIND,
  `context_note`'s enum did NOT grow, an older client's catch-all parses the
  frame and skips it, and `PROTOCOL_VERSION` stays 22. **RED when the enum value
  is put back.**
- `mapping.test.ts` (client + daemon) — the kind maps both ways; a
  `context_note{reason: "leaked_tool_call"}` is NOT accepted.
- `dsml-leak.test.ts` (agent) — one leak → one re-ask → turn proceeds; two leaks →
  the turn fails after exactly two attempts; the leaked text never enters the
  history. **RED with the re-ask disabled.**
- `cli/test/render.test.ts`, `tui/test/state.test.ts` — the `dsml_leak` notice is
  visible, while the loop's other notes stay hidden. **RED with the render change
  reverted.**

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


## Review (Opus)

*— claude-opus-5-5, 2026-11-11*

**Verdict: REQUEST-CHANGES** (1 HIGH, 1 MEDIUM). Gate: `bun run check` green
(lint clean, 6813 pass / 3 opt-in skip / 0 fail). Tree clean after mutations.

### What holds

- `ToolCallAssembler` (`packages/providers/src/tool-call-stream.ts:565-577`): an
  explicit `index` is authoritative, so interleaved parallel calls assemble
  correctly (pinned). An index-less continuation joins the running call; an
  index-less delta with a different id opens a new slot. Nameless slots are
  dropped at `drain()`. For an index-always server the only change is the
  restated-name skip and the nameless drop.
- Re-ask (`packages/agent/src/agent.ts:1186-1203`): the abort check runs first.
  It is bounded by `dsmlReasks`. Nothing is pushed for the leaked round on
  either path. The note follows the same `user`-message pattern as
  `CONTINUE_NUDGE`/hook notes. Steering is drained at the top of the next
  iteration as usual. `budgetFrom--` is bounded by the same counter. The
  in-process worker builds the agent with the local provider
  (`packages/cli/src/worker.ts:123`), so `instanceof` holds there.
  `RetryingModelProvider` rethrows it unchanged (`retry.ts:199`).
- Non-vacuity (my own mutations, restored):
  - M1 (`keyFor` always returns `nextKey` for an index-less delta) → 3 fail:
    the unit tests for an omitted index and a repeated id, plus the e2e
    omitted-index test.
  - M2 (`MAX_DSML_REASKS = 5`) → 2 fail: "bounded" and "never leaves the
    leaked text".

### HIGH-1 — the guard does not fire on the incident it was built for

`packages/core/src/dsml.ts:230,241-251`: `hasDsmlToolCallMarkup` requires an
opening `<｜DSML｜ invoke>` tag. **The incident log has none.** The distinct DSML
tags in `exec-history-validity.log` 772–779 are:

- `<｜DSML｜ parameter name="fs_write">`
- `<｜DSML｜ parameter name="content" string="true">`
- `<｜DSML｜ parameter name="path" string="true">`
- `</｜DSML｜ parameter>` ×3
- `</｜DSML｜ invoke>`
- `</｜DSML｜ calls>`

There is no opening invoke tag at all. Repro
(`.tentacle/tmp/dsml-leak/review/incident.ts`, the log's text from "Base64
works" on, fed to the shipped function):

```
{ bytes: 817, hasInvokeOpen: false, guardFires: false }
```

So the exact reply in the incident still ends the turn as a "final answer",
which is symptom 1 unfixed. The tests pass only because the fixture
`packages/providers/test/dsml-leak.test.ts:610-617` (and `core/test/dsml.test.ts`)
add a `<｜DSML｜ invoke>` line that the log does not contain. The doc's "spelled as
the incident's log has it" is false. The template's real invoke tag also
carries attributes (`invoke name="…"`), which the exact `invoke>` match would
miss too.

**Fix:**

- Recognise the observed shape. Require at least one opening
  `<｜DSML｜␠?parameter name="…"…>` and, after it, a closing `</｜DSML｜␠?` tag
  (`parameter`/`invoke`/`calls`). Allow an optional space after the bar and
  attributes on any opening tag.
- Keep the "bare mention / prose is not refused" negatives.
- Replace both fixtures with the log's literal bytes (lines 773–778, the base64
  body may be shortened) and show it red on the current matcher.

### MEDIUM-1 — new enum value on a known display kind breaks an older client; needs `PROTOCOL_VERSION` 22→23

`packages/protocol/src/updates.ts:334` adds `leaked_tool_call` to
`ContextNoteSchema.reason`. An older client does not see this as an unknown
kind. It sees a known kind whose member fails its schema, and
`classifyUpdate` (`packages/client/src/mapping.ts:57-58`) returns
`malformed context_note update from the daemon`. The session reducer then
emits it as an error (`session-reducer.ts:284`). Repro
(`.tentacle/tmp/dsml-leak/review/skew.ts`, a reason the client's enum lacks):

```
error malformed context_note update from the daemon
```

**Scenario:** a v22 laptop on a pre-fix build `connect`s to a post-fix `serve`
(or runs a newer pod binary). The model leaks DSML, and the user gets a
"malformed update" error instead of the notice and re-ask. Both versions say 22,
so `initialize` does not catch the mismatch. By §7 this is a changed field
domain, i.e. "truly breaking". The doc's precondition "display → no bump" is
wrong.

**Fix:**

- Bump `PROTOCOL_VERSION` to 23 in `packages/protocol/src/version.ts`, with a
  history line.
- Regenerate `protocol.json`.
- Fix the doc's precondition.
- Alternative: emit the notice under an existing reason. That loses the
  render distinction, so the bump is preferred.

Executor behaviour: a careful extraction with good red/green discipline on the
assembler. The DSML half, though, was tested against an invented fixture
instead of the cited evidence, which is exactly the "weaker correlate" trap of
§2/§9.

## Execution — fix round 1

*— deepseek (tentacle --profile deepseek), 2026-11-11*

Both findings fixed. The review was right on both counts.

### HIGH-1 — the matcher now fires on the incident's own bytes

`packages/core/src/dsml.ts`: the matcher no longer anchors on an opening
`invoke` tag. It requires

- one opening `<｜DSML｜␠?parameter …>` — the space after the bar optional, attributes
  allowed (`(?:\\s[^<>]*)?`), so `parameter name="fs_write"` and
  `parameter name="content" string="true"` both match; and
- after it, one of the block's closers (`</ parameter>`, `</ invoke>`,
  `</ calls>`, any of them, bar spacing free).

That is exactly the shape in the log: no opening invoke at all, an opening
parameter tag, then `</ invoke>` / `</ calls>`.

**Fixtures replaced with the log's LITERAL bytes**, copied from
`.tentacle/tmp/orchestration/runs/exec-history-validity.log` 773-778 (prose
prefix + the block; only the long base64 body is shortened, as the review
allowed). Both `packages/core/test/dsml.test.ts` and
`packages/providers/test/dsml-leak.test.ts` now carry them, and a checker
script re-read the log and compared every line character by character
(`U+FF5C` included, spaces included): byte-exact, 5 block lines each. The test
itself asserts the premise — `INCIDENT.includes(OPEN)` is `false` — so an
"invented fixture" cannot creep back silently.

The negatives are kept: plain prose, a bare `DSML` mention, an orphan closing
tag, and a truncated block (cut before its first closer) are all NOT refused.
The provider test's "clean" reply now mentions DSML in prose on purpose, so
"prose about DSML is accepted" is pinned end-to-end.

Red → green, on the shipped code, by swapping only `dsml.ts` back to `HEAD`'s
version:

```
(fail) recognises the INCIDENT's own bytes: no opening invoke tag, attributes on every tag
(fail) recognises the template's full block, an opening invoke WITH attributes
(fail) a DSML tool call leaked as text > is refused, not accepted as the answer
 6 pass · 3 fail        → 9 pass · 0 fail  (new matcher)
```

Mutation (non-vacuity): making the parameter tag's attributes optional-off
(`parameter>`) → 4 fail (both positive cases in core + the provider test +
"matches the incident text regardless of surrounding prose"); making the matcher
return `true` after the opening tag (dropping the closer requirement) → 2 fail
(the bare mention and the truncated block). Both reverted.

### MEDIUM-1 — the notice is a new display KIND, no version bump

Done as the orchestrator directed: **no value added to `context_note.reason`
(it stays `continue | background_exit | hook`), no `PROTOCOL_VERSION` bump
(stays 22).** The notice rides a new update kind `dsml_leak` of class `display`:

- `packages/protocol/src/updates.ts` — `DsmlLeakUpdateSchema` (`{type: "dsml_leak",
  text}`), added to the union and to `UPDATE_CLASS` as `display`; the
  `ContextNoteSchema` doc comment now says why the re-ask is NOT a reason there.
- `packages/agent/src/agent.ts` — the loop yields its own `AgentEvent`
  `{type: "dsml_leak", text}` instead of `context_note{leaked_tool_call}`.
- `packages/daemon/src/mapping.ts` — `dsml_leak` event → `dsml_leak` update.
- `packages/client/src/mapping.ts` — update → the same event (both ends wired).
- `packages/cli/src/render.ts`, `packages/tui/src/state.ts` — the notice is
  shown; `context_note` is back to `reason === "hook"` only.
- `packages/protocol/schema/protocol.json` regenerated with
  `bun run schema:export` (`ContextNote.reason` enum shrunk back to the three
  older values, `DsmlLeakUpdate` added with `x-event-class: display`).

**Test (the review's exact ask):** `packages/protocol/test/dsml-leak-kind.test.ts`
— a client that does NOT know the tag (`KNOWN_UPDATE_TYPES` minus `dsml_leak`,
i.e. a v22 client) parses the frame through its catch-all
(`UnknownSessionUpdateSchema` / `SessionUpdateOrUnknownSchema`) and
`clientSupportsUpdate` says no: a SKIP, not an error. It also pins that
`context_note{reason: "leaked_tool_call"}` is rejected by the schema (so the
old shape cannot return) and that `PROTOCOL_VERSION` is 22.

Red: putting the enum value back (`z.enum([... "leaked_tool_call"])`) → 1 fail
("`context_note` keeps an OLDER client's reason enum: no member was added");
reverted. The client and daemon mapping tests add the two-way mapping and the
same negative.

Both ends are also folded consistently in the test-support transcript helpers
(`client/test/support/transcript.ts`, `daemon/test/history-cut.test.ts`,
`client/test/foreign-turns.test.ts`): the re-ask note IS a user message in the
history, so a live transcript and a resynced one still agree.

### Doc corrections

- The precondition that claimed "a new `context_note` reason needs no bump
  because `context_note` is display" was **wrong** and is corrected in place
  (Preconditions), with the malformed-update mechanism stated.
- Implementation's Design/Files/Tests bullets now describe the shipped shape
  (parameter-anchored matcher, `dsml_leak` kind, the new test files).

### Gate

`bun run typecheck` clean · `bun run lint` clean (0 errors, 0 warnings) ·
`bun test` **6822 pass / 3 skip (the opt-in k8s + docker + slow-keepalive) /
0 fail**. `bun run schema:export` re-run, no drift.

### Findings

- **HIGH-1** — FIXED. The matcher recognises the incident's literal bytes
  (shown red on the old matcher); fixtures are the log's own characters,
  verified byte-exact; the prose/bare-mention/truncated negatives are kept.
- **MEDIUM-1** — FIXED (orchestrator's decision implemented). New `display`
  kind `dsml_leak` wired on both ends; `context_note`'s enum unchanged;
  `PROTOCOL_VERSION` stays 22; an older client's parse skips it rather than
  erroring (pinned). Doc precondition corrected.

## Review (Opus) — round 2

*— claude-opus-5-5, 2026-11-11*

**Verdict: PASS.** No HIGH or MEDIUM findings remain. Scope: `git diff HEAD~1`
(5502ce6).

- **HIGH-1: fixed.**
  - **Incident bytes:** my round-1 probe (`.tentacle/tmp/dsml-leak/review/incident.ts`)
    on the log's literal text from "Base64 works" on, with no opening invoke tag,
    now prints `{ bytes: 817, hasInvokeOpen: false, guardFires: true }`.
  - **No false refusals:** prose that mentions DSML, a lone parameter tag, a lone
    closer and a block cut before its first closer all return false. The
    provider test's "clean" reply now mentions DSML and is accepted.
  - **Bounded scan:** both regexes (`packages/core/src/dsml.ts:22-24`) have no
    nested quantifiers. A match attempt can only start at the literal
    `<｜DSML｜` prefix, and `[^<>]*` stops at the first `>` or `<`. Adversarial
    inputs (`.tentacle/tmp/dsml-leak/review/round2.ts`): 2.8 MB of unclosed
    open-prefixes took 1.8 ms; 1.9 MB of incomplete closers took 1.7 ms.
  - **Fixtures:** they are now the log's bytes (base64 body shortened), and the
    test asserts the premise that the text has no opening invoke tag.
- **MEDIUM-1: fixed by design, and no bump is needed.**
  - **The new kind:** `dsml_leak` is its own kind in the `SessionUpdateSchema`
    union, with `UPDATE_CLASS.dsml_leak = "display"` (`packages/protocol/src/updates.ts`).
    `context_note.reason` is back to the main enum.
  - **Both ends wired:** `AgentEvent` → `eventToUpdate` (`daemon/src/mapping.ts:250`)
    → `updateToEvent` (`client/src/mapping.ts:290`) → CLI `render.ts` and TUI
    `state.ts` notices. `tsc --noEmit` is clean, so every exhaustive switch
    covers it.
  - **Older client:** `classifyUpdate` has no diff against main, and main's
    union lacks the tag. A tag unknown to the client classifies as
    `{ kind: "unsupported" }`, not an error. That is the §7 display rule, so
    `PROTOCOL_VERSION` stays 22, which is correct.
- **No new HIGH/MEDIUM.**
  - Not a finding: an older client that skips the notice does not add the
    re-ask note as a user item in its live transcript. A resync shows it from
    the history. This is display-only and has the same cost as any skipped
    display kind.
- **Gate (narrow):** `tsc --noEmit` clean · `biome check .` clean · 376 pass /
  0 fail across the touched test files plus `packages/protocol` (includes the
  schema drift gate).
