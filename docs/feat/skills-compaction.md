# feat/skills-compaction — active skills survive `/compact`

> **Status:** done — merged to `main` 2026-10-21 (owner OK). Review: REQUEST-CHANGES → findings fixed, not re-reviewed (owner allowed one review)
> **Branch:** `feat/skills-compaction`
> **Type:** feat · **Size:** M · **Blast:** load-bearing (the compaction history rebuild, the daemon's compaction barrier sees its output, the model-facing history shape) · **Suited:** strong model executes; mandatory fresh-context Review (one adversarial pass, Opus 5.5 sub-agent — owner, 2026-10-20)

Sub-task 2 of 4 of `docs/eval/agent-skills.md`. The eval's owner decision Q3 is
the spec: *"after compaction, the bodies of the skills active before it go back
into the rebuilt history"*, and *"which skills are active is derived from the
history … not kept as separate state, so it survives resume and re-attach"*.

## Context

*— claude-opus-5-5, 2026-10-20*

`/compact` rebuilds the history as the system prompt plus one summary message
(`agent/src/compact.ts:115-131`, called from `Session.compact`,
`agent/src/session.ts:121-133`). A skill loaded by the `skill` tool lives in a
tool result, so compaction throws it away. The model still sees the catalog,
but it is not told that it lost the instructions it was following. The next
activation loads the whole body again. Compaction also sends every skill body
(up to 50 000 chars each, `tools/src/skill.ts:23`) to the summariser, which
then paraphrases instructions that are about to be thrown away.

The agentskills.io client guide asks clients to **protect activated skill
content from compaction**. The owner chose automatic re-injection for v1
(eval Q3).

**Repro (2026-10-20, `main` @ dfabb6b, from the repo root):** a real `Agent` +
`Session` + the real `skill` tool, with a scripted model: activate, `/compact`,
then activate again.

```
$ cat .tentacle/tmp/skills-compaction/repro.ts
import { Agent, Session } from "@tentacle/agent";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { ToolRegistry, activeSkillNames, createSkillTool } from "@tentacle/tools";

class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    for (const e of this.script[this.turn++] ?? [{ type: "done" }]) yield e;
  }
}
const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};
const BODY = "STEP 1: run ./deploy.sh --staging\nSTEP 2: verify /healthz";
const skill = createSkillTool(
  [{ name: "deploy-app", location: "/s/deploy-app/SKILL.md", dir: "/s/deploy-app", files: [], filesTruncated: false }],
  async () => ({ body: BODY, bodyLine: 5 }),
);
if (!skill) throw new Error("no tool");
const call = (id: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "skill", arguments: '{"name":"deploy-app"}' },
});
const model = new Scripted([
  [call("c1"), { type: "done" }], // turn 1: activate
  [{ type: "text", delta: "loaded" }, { type: "done" }],
  [{ type: "text", delta: "user wants to deploy to staging" }, { type: "done" }], // summary
  [call("c2"), { type: "done" }], // turn 2: activate again
  [{ type: "text", delta: "ok" }, { type: "done" }],
]);
const agent = new Agent({ model, tools: new ToolRegistry().register(skill), env, systemPrompt: "SYS" });
const session = new Session(agent);
for await (const _ of session.send("deploy to staging")) {}
console.log("before compact: active =", activeSkillNames(session.messages));
await session.compact();
const transcript = model.requests[2]?.messages[1]?.content ?? "";
console.log("summariser transcript carries the body:", transcript.includes("STEP 1"));
console.log("after compact: active =", activeSkillNames(session.messages));
console.log("after compact: body in history =", session.messages.some((m) => m.content.includes("STEP 1")));
for await (const _ of session.send("now deploy again")) {}
const second = session.messages.find((m) => m.role === "tool" && m.toolCallId === "c2");
console.log("turn after compact, skill result:", second?.content.split("\n")[0]);

$ bun .tentacle/tmp/skills-compaction/repro.ts
before compact: active = [ "deploy-app" ]
summariser transcript carries the body: true
after compact: active = []
after compact: body in history = false
turn after compact, skill result: <skill_content name="deploy-app">
```

Expected after this task: `after compact: active = [ "deploy-app" ]`, the body
is still in the history, the transcript does not carry it, and the second
activation returns the "already loaded" note instead of the body.

## Implementation

*— claude-opus-5-5, 2026-10-20*

### Load-bearing assumption

**A fully answered, synthetic `skill` tool round placed right after the summary
message is a valid history for every consumer, AND the existing derivation
already reads it as "active".** If both hold, re-injection needs no new state,
no protocol change and no persisted-format change. Proof:

- *Derivation*: `activeSkillNames` (`tools/src/skill.ts:67-89`) counts a skill
  as active when an assistant `toolCalls` entry named `skill` has a `tool`
  result that opens with `<skill_content name="…">`. A round that reuses the
  original call and the content of its activation matches this by construction.
- *Anthropic*: `buildPayload` (`providers/src/anthropic-provider.ts:301-343`)
  turns runs of `tool` messages into one `user` message of `tool_result`
  blocks. The next user prompt is then a second `user` turn, which the API
  merges. This is the same shape steering already produces mid-turn
  (`[assistant{tool_use}, tool…, user]`). The missing `thinking` block on the
  synthetic assistant turn is not new: no assistant turn carries one today
  (`docs/eval/anthropic-thinking-echo.md`, `ChatMessage` has no field for it,
  `core/src/model.ts:27-34`).
- *OpenAI-compatible*: `toWireMessage` (`providers/src/openai-provider.ts:217-228`)
  is a field rename; `assistant{tool_calls}` → `tool` → `user` is the standard
  shape.
- *Daemon reload*: `reconcileOnReload` returns early when the record has no
  in-flight turn (`daemon/src/persisted-session.ts:289-294`), and compaction
  holds the busy slot, exclusive with a turn (`daemon/src/hosted-session.ts:796-805`).
  A later turn that dies before its first assistant message leaves our round
  as the last one; `trailingCalls` finds it fully answered and adds nothing
  (`persisted-session.ts:299-303`). `suspendedCalls` (`agent/src/resume.ts:21-43`)
  only matches a round with unanswered calls.
- *Display*: replay (`tui/src/resume.ts:22-42`) shows the round as an ordinary
  `Skill <name>` call with its result; a re-attach snapshot is keyed on ids
  within one snapshot (`client/src/remote-session.ts:215-224`).

### Preconditions

- **One rebuild path.** `compactedHistory` is called only by `Session.compact`
  (`rg compactedHistory packages` → `session.ts:125`). Every runtime (worker,
  `serve`, pod) reaches it through `HostedSession.compact` → `Session.compact`
  (`daemon/src/hosted-session.ts:808`). No automatic compaction is wired
  (`ContextManager.needsCompaction`, `core/src/context.ts:29`, has no caller).
- **Compaction is exclusive with a turn.** `HostedSession.compact` takes the
  busy slot before its first `await` (`hosted-session.ts:796-805`), so the
  history does not change while the skills are re-read and summarised.
- **Atomic replacement.** `Session.compact` swaps the whole array, then runs
  `onReplaced` synchronously (`session.ts:125-129`). The daemon's barrier
  (`historyReplaced`, `hosted-session.ts:832-851`) and the persisted record see
  the full new history, rounds included, in one step.
- **The activation path can run outside a turn.** `Agent.runTool`
  (`agent/src/agent.ts:568-591`) needs only a `ToolContext`; the gate returns
  at once for `permission: "none"` (`agent/src/permission-gate.ts:63-65`), which
  is what `skill` declares (`tools/src/skill.ts`, `permission: "none"`).
  `transformResult` (`agent.ts:541-566`) applies the same transforms as in a
  turn: the `skill` result is exempt from the size-shaping ones and still
  redacted (`cli/src/wiring.ts`, `exemptTools([SKILL_TOOL_NAME], …)`). The
  registry turns every failure (unknown tool, bad arguments, a throw) into an
  `isError` result (`tools/src/registry.ts:56-81`). The tool reads the body
  through `ctx.env` (the pod's env in a pod), and dedups only from
  `ctx.history`, so `history: []` forces a fresh read.
- **`@tentacle/agent` already depends on `@tentacle/tools`**
  (`packages/agent/package.json`), so the agent reuses the derivation: one
  definition of "active" for dedup and for compaction.
- **Call ids.** The original activation round disappears with the rest of the
  history, so its id is unique in the rebuilt history. Ids come from the
  server, or `crypto.randomUUID()` when it sends none
  (`openai-provider.ts:94`, `anthropic-provider.ts:244`).

### Design

**Owner decision (2026-10-20): the body is read again from `SKILL.md` at
compaction**, so an edit made since activation is picked up. This overrides
the stored-copy option proposed first. The way to re-read it is to **run the
original activation call again** through the agent's own tool path. The
result then has exactly the format, cap and redaction of a normal activation,
and there is still one code path that produces skill content. When the re-run
cannot produce the skill (file deleted or unreadable, skill no longer offered,
skills disabled on a resume), compaction **falls back to the copy already in
the history** and says so. A skill that was active is never dropped silently.

Steps:

1. **`tools/src/skill.ts`: one derivation.** New export
   `skillActivations(history): SkillActivation[]`, where
   `SkillActivation = { name, call: ToolCall, content: string }`, in
   activation order, the first marker result per name (the same rules as
   today: error results, dedup notes and other tools' output never count).
   `activeSkillNames` becomes `skillActivations(h).map((a) => a.name)`: same
   behaviour, existing tests unchanged. `skillContentName(content)` (the
   marker parse) is exported too, so the agent checks a re-run result with the
   same rule. Update the module comment: after compaction a skill stays
   loaded.
2. **`agent/src/agent.ts`: re-read.** New method
   `reloadSkills(sessionId, messages, signal): Promise<ReloadedSkill[]>`. For
   each activation, in order: `runTool(call, { sessionId, signal, env, history: [] })`,
   then `transformResult`. If the result is not an error and opens with the
   marker of the same name, it is the fresh content (`fresh: true`).
   Otherwise the stored content is used (`fresh: false`). Sequential (a few
   file reads), no events: it is not a turn.
3. **`agent/src/compact.ts`: pure parts.**
   - `carryOverSkills(reloaded): SkillCarryOver` = `{ kept, dropped, stale }`.
     Keep the most recent skills whose contents total at most
     `MAX_KEPT_SKILL_CHARS` = 100 000 (two bodies at the 50 000 cap, or about
     20 typical skills). Going backwards from the newest, the first one that
     does not fit and every older one is **dropped**. `kept` stays in
     activation order. `stale` names the kept skills that use the stored copy.
     The budget is what stops compaction from keeping the context full when
     many skills are active.
   - `compactedHistory(messages, summary, carry = NONE)`: with nothing to
     carry, the output is **byte-identical** to today. Otherwise the summary
     message gets one trailing note (the skills re-loaded below still apply;
     `stale` ones came from the earlier copy because `SKILL.md` could not be
     read; `dropped` ones are named, with "load it again with the `skill` tool
     if still needed"). After it, for each kept skill in order, one round:
     `{ role: "assistant", content: "", toolCalls: [call] }` then
     `{ role: "tool", content, toolCallId: call.id }`. One round per skill, not
     one parallel round: it is the most conservative shape for strict chat
     templates, and it is how a skill is normally activated. A dropped skill is
     not active in the new history, so loading it again works.
   - `summarizeConversation(model, messages, signal, keep?)`: a result whose
     call id is in `keep` is rendered as
     `TOOL: [skill "<name>" — its instructions are re-loaded after compaction]`
     instead of its body. Dropped skills keep their full text, so the summary
     keeps their gist.
4. **`agent/src/session.ts`: `Session.compact` orchestrates**:
   `reloadSkills` → abort check → `carryOverSkills` → `summarize` (with the
   kept ids) → abort check → `compactedHistory` → swap. All reads happen before
   the swap. An abort or a failed summary leaves the history untouched, as
   today. `Agent.summarize` gains the optional `keep` parameter.

The rounds are built from what `skillActivations` reads, so a second
compaction finds them again: the operation is idempotent (re-read again, no
duplicates).

No protocol, persisted-format, daemon or client code changes. `CompactResult.after`
now counts the rounds (the TUI prints `before → after`, `tui/src/App.tsx:472`):
that is the truth.

### Files

`packages/tools/src/skill.ts` (+ `index.ts` exports) →
`packages/agent/src/compact.ts` → `packages/agent/src/agent.ts` →
`packages/agent/src/session.ts` → tests: `tools/test/skill.test.ts`,
`agent/test/compact.test.ts`, `providers/test/anthropic-provider.test.ts`
(payload shape), `daemon/test/persistence.test.ts` (reload) →
`docs/eval/agent-skills.md` (status), `docs/feat/skills-core.md` (its known
limit "read at activation" now also covers compaction), `TODO.md`.

### Failure modes

- **No skill active** → no re-read, output byte-identical to today (pinned).
- **Summary fails, is empty, or is aborted** → the history is untouched, as
  today (`CompactError`, the abort checks in `Session.compact`). Re-reads done
  before it only read.
- **Abort during the re-read** → the tool path answers "cancelled"; the abort
  check after `reloadSkills` rejects before anything is replaced.
- **`SKILL.md` deleted, unreadable, or the skill no longer offered / skills
  disabled** → an `isError` result → the stored copy is kept and the note
  names it as stale. Never a silent drop.
- **`SKILL.md` edited** → the fresh body is used (the owner's goal), still
  capped at `MAX_SKILL_BODY_CHARS` with the continuation pointer.
- **Activation that failed, dedup note, call with no result** (an interrupted
  turn) → not an activation, not carried over (the derivation rules; tested).
- **Too many / too large skills** → budget, measured on the content actually
  carried; the oldest are dropped *and named* in the note.
- **Repeated compaction** → idempotent: the same rounds, no duplicates.
- **Daemon restart after compaction** → no in-flight turn → reload untouched;
  a later interrupted turn → the round is fully answered, nothing is added.
- **Persisted / version skew** → no format change: the round uses existing
  `ChatMessage` fields, which `parseSessionRecord` already accepts.
- **A summary that quotes `<skill_content …>`** → harmless: the derivation
  only reads `tool` results of `skill` calls, never user messages.
- **Pod** → the re-read runs in the pod's env, on the pod's skills (Q4). No
  laptop path is involved.

### Tests

Red before green: the end-to-end test (the repro as a test) and the
`compactedHistory` shape tests fail on `main`.

- `tools/test/skill.test.ts`: `skillActivations` returns call + content in
  activation order, first marker wins, skips error results, dedup notes and
  unanswered calls; `activeSkillNames` tests unchanged.
- `agent/test/compact.test.ts`:
  - no skills → `compactedHistory` equals the old 2-message output exactly;
  - with skills → `[system, summary+note, assistant{original call}, tool{content}]`
    per skill, in activation order; `activeSkillNames(next)` equals the names
    before;
  - budget → oldest dropped, named in the note, not active in `next`;
  - transcript → a kept body is replaced by the placeholder, a dropped one is
    not;
  - `Session.compact` end-to-end (the repro): after compaction the skill is
    active, its body is the **edited** one (the reader returns a new body on
    the second read), and a second `skill` call returns the dedup note;
  - re-read fails (reader throws) → stored copy kept, named as stale;
  - idempotence → compact, one more turn, compact again → one round per skill;
  - abort during the re-read → history untouched, rejects.
- `providers/test/anthropic-provider.test.ts`: `buildPayload` on the compacted
  shape followed by a user prompt → roles alternate `user, assistant, user`,
  every `tool_use` id answered by a `tool_result` (the load-bearing
  assumption, provider side).
- `daemon/test/persistence.test.ts`: a compacted history with a skill round,
  persisted and reloaded → `reconcileOnReload` leaves it unchanged.
- Non-vacuity by mutation (§9): `compactedHistory` without the rounds → the
  end-to-end and shape tests fail; `reloadSkills` always using the stored copy
  → the "edited body" assertion fails; transcript without the placeholder →
  the transcript test fails.
- Optional weak-model check (if the local Qwen endpoint is up): after a
  compacted history with a re-loaded skill, a matching task does not call
  `skill` again.

## Execution

*— claude-opus-5-5, 2026-10-21*

Done in the plan's order; the repro above was run on `main` @ dfabb6b before
any edit.

1. `tools/src/skill.ts`: `skillContentName`, `SkillActivation`,
   `skillActivations`; `activeSkillNames` is now a projection of it. Module
   comment updated.
2. `agent/src/compact.ts`: `MAX_KEPT_SKILL_CHARS`, `CarriedSkill`,
   `SkillCarryOver`, `carryOverSkills`, the summary note, the rounds in
   `compactedHistory` (optional third argument), and the transcript placeholder
   (`summarizeConversation`'s optional `keep`).
3. `agent/src/agent.ts`: `reloadSkills` (`runTool` + `transformResult` with
   `history: []`); `summarize` passes `keep` through.
4. `agent/src/session.ts`: `Session.compact` = re-read → abort check → budget →
   summary → abort check → rebuild → swap.
5. Docs: `README.md` (skills line), `TODO.md`, the eval's status line,
   `skills-core.md` (its "read at activation" limit).
6. (Owner request, 2026-10-21) `docs/architecture/skills.md`: one reference
   page for how skills work end to end (discovery, parsing, catalog, tool,
   result pipeline, compaction, runtimes, limits), linked from `README.md` and
   `ARCHITECTURE.md`.

**Drift from Implementation (and why):**
- `SkillActivation` carries `content` (a string), not the result message: the
  round is rebuilt from `call.id` + content, so the message adds nothing.
- One more test, not in the plan: `cli/test/wiring.test.ts` runs the re-read
  through the **real** `buildAgent` transforms (32 KB body, summarise + dedup
  on). It proves the edited body comes back verbatim, still **redacted**, and
  with no extra model call. The unit tests use no transforms, so they could not
  show this.
- The daemon reload test pins a precondition (green on `main` too); it guards
  the shape against a future `reconcileOnReload` change, it is not a red test.
- The provider test builds the compacted shape literally: `providers` cannot
  import `agent`. The compact tests pin that same shape. Like the daemon test,
  it is green on `main` too: it pins the provider side of the load-bearing
  assumption, it is not a red test.
- **Found in self-review, fixed before the Review (not in the plan):**
  - *A hung re-read could trap a cancel.* `env.readFile` takes no signal
    (`core/src/execution.ts:44`); in a pod it is an exec that can hang. Before
    this task compaction awaited only the abort-aware model call; now it also
    awaits a read. If cancel could not end it, the busy slot would stay held
    (the `fix/cancel-hung-disk` class). `reloadSkills` now races each re-run
    with the signal (`unlessAborted` in `agent.ts`): a cancel rejects at once,
    the history is untouched, and the read is left to finish unobserved (it
    only reads). The `daemon`'s `untilAborted` could not be reused: `agent`
    does not depend on `daemon`.
  - *Cross-round pairing.* `skillActivations` first paired a result with any
    `skill` call of the same id anywhere in the history (as `activeSkillNames`
    did). With a server that reuses ids (`call_0` every response), a result
    could be paired with another round's call, and that call would then be
    re-run. A result is now paired only with a call of the assistant message
    before it, which is where the loop always writes it.
- Wording of the note settled as: "The skills active before compaction are
  loaded again below; their instructions still apply: …", "SKILL.md could not
  be read again for …: the earlier copy is loaded instead.", "Not loaded again
  (too much skill content to keep): …. Load one again with the skill tool if
  it is still needed."

**Repro after the change:**

```
$ bun .tentacle/tmp/skills-compaction/repro.ts
before compact: active = [ "deploy-app" ]
summariser transcript carries the body: false
after compact: active = [ "deploy-app" ]
after compact: body in history = true
turn after compact, skill result: Skill "deploy-app" is already loaded: its instructions are earlier in this conversation (<skill_content name="deploy-app">). Follow them; there is no need to load it again.
```

**Tests:** `tools/test/skill.test.ts` (+4), `agent/test/compact.test.ts` (+12
before the Review: shape, budget ×3, transcript, end-to-end, stale fallback ×2,
idempotence, hung read, abort, and the no-skill shape),
`providers/test/anthropic-provider.test.ts` (+1), `daemon/test/persistence.test.ts`
(+1), `cli/test/wiring.test.ts` (+1).

**Non-vacuity by mutation (§9)**, each red, then reverted to green:

| Mutation | Fails |
|---|---|
| `Session.compact` rebuilds without the rounds | 4 end-to-end tests (edited body, stale ×2, idempotence) |
| `reloadSkills` never uses the fresh read | "edited body" |
| `reloadSkills` treats any result as fresh | stale ×2 (dropping only the marker-name check was **not** caught — Review finding 2; re-pinned below) |
| transcript without the placeholder | transcript test + end-to-end |
| no abort check after the re-read | abort test — **vacuous once `unlessAborted` landed** (Review finding 2); re-pinned after the Review, see below |
| budget loop never keeps | 3 budget tests + 4 end-to-end |
| `reloadSkills` skips `transformResult` | real-wiring test (secret not redacted) |
| re-read not raced with the abort | hung-read test (`"still hung"` after 500 ms) |
| pairing across rounds (first-seen id) | reused-ids test |

On `main` the new tests do not compile (the symbols are new), so the repro
above is the red evidence for the behaviour.

**Weak-model check** (`.tentacle/tmp/skills-compaction/gate.ts`: the real
`buildAgent` + `loadConfig`, a compacted history with a `deploy-app` round from
`compactedHistory`, then "Now deploy it to production.", stop at the first
tool call), Qwen3.8-27B-UD-Q6_K_XL through llama.cpp, 3 runs:

```
 → shell {"command":"make build"}
 → shell {"command":"make build"}
 → shell {"command":"ls -la && pwd"}
```

0/3 load the skill again; 2/3 start from the skill's step 1, 1/3 looks around
first. The server's chat template accepted the synthetic round (no request
error).

**Gate (before the Review):** `bun run check` → typecheck clean, lint clean,
`1366 pass · 2 skip (the opt-in live-k8s + slow keepalive) · 0 fail`.

### Fixes after the Review

*— claude-opus-5-5, 2026-10-21*

The single Review (below) returned REQUEST-CHANGES. Each finding, fixed:

1. **Placeholder by call id (medium).** `summarizeConversation` now leaves out
   only the exact result message that was paired: `SkillActivation` and
   `CarriedSkill` carry `resultIndex` (its index in the history), and the
   transcript is matched by position (`compact.ts`, `skill.ts`). The
   reviewer's repro (`.tentacle/tmp/skills-compaction-review/reuse-ids.ts`)
   now prints `transcript keeps the shell failure: true`.
2. **Vacuous mutation rows (low).** Two new tests pin the guards: "no skills,
   signal already aborted → no summary request" (the check after the re-read),
   and "a re-read reshaped by a transform (no marker) is not fresh" (the
   marker-name check). The count is corrected above.
3. **One note for two causes (low).** `fresh: boolean` became
   `source: "fresh" | "unreadable" | "unavailable"`. `reloadSkills` checks first
   whether the skill is still offered (the `skill` tool exists and its schema
   accepts the original arguments); if not, it reads nothing and the note says
   `No longer in the Skills list: "x". The earlier copy is loaded instead.` A
   failed read keeps `SKILL.md could not be read again for "x": …`. The policy
   itself (an unavailable skill is still carried over, until `/clear`) is
   unchanged: it is the approved design, flagged to the owner.
4. **Provider test green on `main` (nit).** Said so above.

New tests: reused ids, removed-while-others-remain (`unavailable`, nothing
read), the reshaped re-read, pre-aborted with no skills. `compact.test.ts`: 24
tests in total.

| Mutation | Fails |
|---|---|
| placeholder keyed by call id again | reused-ids test |
| no abort check after the re-read | pre-aborted test (a summary request is made) |
| no marker-name guard (`!result.isError` only) | reshaped re-read test |
| no "unavailable" branch | no-skill-tool test (the note says "could not be read") |

All reverted; the tree was restored from the backup and re-run green.

**Gate:** `bun run check` → typecheck clean, lint clean (0/0),
`1370 pass · 2 skip (the opt-in live-k8s + slow keepalive) · 0 fail`.

## Review

*— claude-opus-5-5 (fresh-context sub-agent), 2026-10-21*

**Reviewer:** the same model as the executor (Opus 5.5), only a fresh context.
Shared blind spots can survive both passes.

**Verdict: REQUEST-CHANGES.** The design holds and the main path works end to
end through the daemon. One silent-loss bug (finding 1) in the transcript
placeholder must be fixed. It is the same id-reuse case the executor already
fixed in `skillActivations`, missed in a second place.

### Findings

1. **Medium — the transcript placeholder blanks unrelated tool results when
   call ids are reused.** `compact.ts:64` keys the placeholder by call id only,
   and `renderMessage` (`compact.ts:24-31`) replaces *every* `tool` message with
   that id. With a server that reuses ids (`call_0` each response, the case the
   Execution itself treats as real), every other tool result with the kept
   skill's id is sent to the summariser as `[skill "…" — its instructions are
   re-loaded …]`. Its real output is silently lost from the summary. Repro
   (`.tentacle/tmp/skills-compaction-review/reuse-ids.ts`: a `skill` round
   `call_0`, then a `shell` round `call_0` returning "DEPLOY FAILED: quota
   exceeded", then `Session.compact`):
   ```
   transcript keeps the shell failure: false
   ASSISTANT:  [called: skill]
   TOOL: [skill "deploy-app" — its instructions are re-loaded after compaction]
   ASSISTANT:  [called: shell]
   TOOL: [skill "deploy-app" — its instructions are re-loaded after compaction]
   ```
   Fix: mark the exact result message that `skillActivations` paired (pair
   with the assistant message before it, as `skill.ts` now does), not every
   message with the id. Add a test with a reused id and a non-skill result.
   The same reuse also makes the premise "its id is unique in the rebuilt
   history" false when two kept skills share an id (each round stays
   well-formed, so this part is harmless).
2. **Low — the Execution's mutation table overclaims two rows.**
   (a) "no abort check after the re-read → abort test fails": not true on the
   final code. Removing `session.ts:126` keeps all 20 compact tests green,
   because `unlessAborted` already rejects inside `reloadSkills`. The check now
   guards only an abort that lands after the last read settles; no test pins it.
   (b) "`reloadSkills` treats any result as fresh → stale ×2": true only for
   `fresh = true`. `fresh = !result.isError` (dropping the marker-name check,
   `agent.ts:247`) stays green. With the real tool and `history: []` the two
   are equivalent, so this is defence in depth, untested. Also: `compact.test.ts`
   gains 12 tests, not 13 (main 8 → 20).
3. **Low (owner awareness) — a stale skill is carried forever, with a wrong
   reason.** A skill deleted, no longer offered, or with skills disabled is
   re-carried at every later compaction (its stored copy is found again each
   time), so there is no way left to shed it except `/clear`. The note says
   "SKILL.md could not be read again" (`compact.ts:196`) even when no read was
   tried (no `skill` tool, or the name is no longer in the enum). This is the
   approved design ("never dropped silently"); the wording is the part to fix,
   e.g. tell "unreadable" apart from "no longer offered".
4. **Nit — red-before-green.** The provider test and the daemon reload test
   are green on `main` (characterization of unchanged code). The Execution
   says so for the daemon test, not for the provider test.

### Gate (re-run by the reviewer)

`bun run check` on the working tree: `tsc --noEmit` clean; Biome "Checked 325
files … No fixes applied" (0 errors, 0 warnings, baseline 0/0);
**1366 pass · 2 skip · 0 fail, 1368 tests across 129 files**. Matches the
Execution. The 2 skips are the opt-in ones (count = baseline).

### Premise table

| # | Premise (cited) | Result |
|---|---|---|
| 1 | Context Repro on `main` @ dfabb6b (worktree under `.tentacle/tmp/skills-compaction-review/main`) | TRUE: transcript carries the body, `active = []` after compact, body lost, second call reloads the body. On the branch: the exact "after" output in Execution. |
| 2 | `compactedHistory` = system + summary only (`compact.ts:115-131` on main) | TRUE |
| 3 | `Session.compact` summarise → swap → `onReplaced` → persist (`session.ts:121-133` main) | TRUE |
| 4 | `MAX_SKILL_BODY_CHARS = 50_000` (`skill.ts:23`) | TRUE |
| 5 | `activeSkillNames` derivation (`skill.ts:67-89` main) | TRUE |
| 6 | `buildPayload` collapses tool runs into one `user` (`anthropic-provider.ts:~287-343`) | TRUE; an assistant with `content: ""` + calls emits no empty text block |
| 7 | `ChatMessage` has no thinking field (`model.ts:27-34`) | TRUE |
| 8 | `toWireMessage` is a field rename (`openai-provider.ts:217-228`) | TRUE |
| 9 | `reconcileOnReload` returns early with no `turn` (`persisted-session.ts:292`), `trailingCalls` skips answered (`:299-303`) | TRUE |
| 10 | `HostedSession.compact` takes the slot before its first await (`hosted-session.ts:796-805`), calls `Session.compact` (`:808`) | TRUE |
| 11 | `historyReplaced` barrier (`hosted-session.ts:832-851`) | TRUE (function at `:835`) |
| 12 | `suspendedCalls` only matches an unanswered round (`resume.ts:21-43`) | TRUE: for the carried round `after.length` (1) ≠ index (0) → null |
| 13 | TUI replay / re-attach snapshot keyed by id (`tui/src/resume.ts`, `remote-session.ts:215-224`) | TRUE |
| 14 | `compactedHistory` has one caller; `needsCompaction` has none | TRUE (`rg`) |
| 15 | `runTool` / `transformResult` (`agent.ts:568-591` / `541-566` main) | TRUE |
| 16 | Gate returns at once for `permission: "none"` (`permission-gate.ts:63-65`) | TRUE (`:64`); no per-tool permission override exists in config |
| 17 | `skill` exempt from shaping, still redacted (`cli/src/wiring.ts:112-118`) | TRUE; the only `new Agent` outside tests is `wiring.ts` (+ `subagent.ts`) |
| 18 | Registry turns every failure into `isError` (`registry.ts:56-81`) | TRUE |
| 19 | `agent` depends on `tools` | TRUE |
| 20 | Call ids from the server or `randomUUID` (`openai-provider.ts:94`, `anthropic-provider.ts:244`) | TRUE; "unique in the rebuilt history" FALSE under id reuse (finding 1) |
| 21 | `readFile` takes no signal (`core/src/execution.ts:44`) | TRUE |
| 22 | TUI prints `before → after` (`App.tsx:472`) | TRUE |

### Mutation outcomes (reviewer's own, each reverted)

Run bounded (`perl alarm 60`), one file at a time; the tree was restored
after each.

| Mutation | Result |
|---|---|
| transcript placeholder off (`keepById` empty) | killed: transcript test + edited-body e2e |
| `reloadSkills` with `history: messages` (dedup on re-read) | killed: edited-body, hung-read, abort |
| `unlessAborted` returns the work unraced | killed: hung-read (506 ms) |
| rounds placed before the summary | killed: shape + 3 e2e |
| skip `transformResult` in `reloadSkills` | killed: real-wiring redaction test |
| budget `>` → `>=` | killed: 2 budget tests |
| stale note removed | killed: shape + stale ×2 |
| `MARKER` unanchored | killed: 2 `skillActivations` tests |
| no abort check after the re-read (`session.ts:126`) | **survived** (finding 2a) |
| `fresh = !result.isError` (no marker-name check) | **survived** (finding 2b) |
| pairing accumulates across rounds (last id wins) | **survived**: only matters for a non-skill result that starts with the marker under a reused id; nit, not a finding |

### Attacks tried

1. **E2E through the real daemon path** (`.tentacle/tmp/skills-compaction-review/e2e.ts`:
   `RemoteClient` ↔ `Connection` ↔ `SessionHost`/`HostedSession`, model over
   the reverse tunnel via `ProxyModelProvider`, real `skill` tool, body edited
   on "disk" between turns). Holds:
   ```
   compact#1 { before: 5, after: 4 } roles: system,user,assistant,tool
     active: [ "deploy-app" ] fresh v2 in history: true
     summariser saw body: false
   turn2 skill result: Skill "deploy-app" is already loaded: it
   compact#2 { before: 8, after: 4 } … rounds: 1
   prompt during compaction: refused: RpcError: a compaction is running
   hung compaction after cancel: rejected -32010 RpcError: compaction cancelled
   history untouched: true reads: 4
   turn after cancel: turn_end false
   ```
   Idempotent, exclusive with a turn, a hung pod read does not trap cancel,
   the slot is freed, the next turn runs.
2. **Reused call ids** → found finding 1.
3. **§7 invariants.** Single session path: the change is all inside
   `Session.compact`/`Agent`, reached by every runtime through
   `HostedSession.compact`; no new path. Peer not serialized: no lock; a
   prompt during compaction is refused at once (E2E). Pod not trusted: the
   re-read runs in the daemon's env (the pod's), `permission: "none"`, no
   broker call, no laptop-side effect, no lasting approval. Persistence: no
   format change; `historyReplaced` and the record see the rounds in one step.
   Found nothing.
4. **Provider history validity.** Anthropic: `[user, assistant{tool_use},
   user{tool_result}, user]` — the empty assistant text is dropped, the
   consecutive user turns are the same shape steering already sends. OpenAI:
   `assistant{tool_calls} → tool → user` is standard and removes the old
   "summary + next prompt = two user messages" shape (TODO.md:155) whenever a
   skill is kept. Found nothing new; the thinking-block question is pre-existing
   (`docs/eval/anthropic-thinking-echo.md`).
5. **Re-run outside a turn.** Missing `jobs`/`emitProgress`: the `skill` tool
   uses neither. Unknown tool / bad name / throw → `isError` → stale copy. No
   spill or summarise call (exempt). `unlessAborted`: listener removed on
   settle, `once` on abort, a late rejection of abandoned work is observed (no
   unhandled rejection). Found nothing.
6. **History shapes for the new pairing.** Steering, the continue nudge,
   background notes and reload notes are `user`/`tool` messages and never sit
   between an assistant's calls and their results; the map resets only on an
   assistant message. Resume (`suspendedCalls`) appends results with no new
   assistant message. Found nothing.
7. **Stale fallback over time** → finding 3.

### What holds

The load-bearing assumption holds: the synthetic round is valid for both
providers, the daemon reload, resume and the TUI replay, and the existing
derivation reads it as active. Abort and summary failure leave the history
untouched. The no-skill output is byte-identical to `main` (pinned). The
real-wiring test proves redaction still applies. Prior art: no open item on
these paths except TODO.md:155 (improved, not worsened).

**Not verified by the reviewer:** the weak-model run on Qwen (no endpoint
used); it stands on the Execution's word.

### How the executor behaved

Followed the plan's order and recorded its drift honestly (the extra wiring
test, the provider test built literally). Its self-review found two real
issues (the hung read, cross-round pairing) and fixed them before Review, with
tests. Weak spots: the mutation table was not re-run after those fixes (two
rows no longer hold, finding 2), and the id-reuse fix was applied to
`skillActivations` but not to the transcript placeholder that keys on the
same ids (finding 1).

### Addendum — after the Review

*— claude-opus-5-5 (executor), 2026-10-21*

Findings 1–4 are fixed as listed in Execution, "Fixes after the Review", each
with a test shown red by mutation. They have **not** been reviewed again: the
owner allowed one review for this task. The parts that changed after the Review
are the transcript matching (`resultIndex`), the `source` field and its note,
and the "still offered" check in `reloadSkills`.
