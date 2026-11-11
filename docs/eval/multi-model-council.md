# eval/multi-model-council — several models deliberate on a decision, with the user

> **Status:** eval (context + source-verified analysis; owner questions Q1–Q11 open)
> **Branch:** none — an `eval` is committed directly to `main` (AGENTS §10). Promotion → *Proposed split*
> **Type:** eval → feat · **Size:** L overall (split into 8 tasks, none XL) · **Blast:** load-bearing where marked in the split (persisted message shape, pod trust, the agent-job runtime); the core is contained · **Suited:** per task, AGENTS §10 gates only; the owner assigns executors

Vocabulary, extending `docs/eval/subagent-live.md`: **agent** = the main model the user chats
with; **subagent** = a child started by `agent_task`; **voice** = one participant of a council
(a named model + a role); **chair** = the model call that writes the final decision record;
**council** = one bounded deliberation.

## Context

*— claude-opus-5-5, 2026-11-08*

### The owner's idea (2026-11-08, verbatim)

> "volessimo lavorare a qualcosa che permetta a più modelli di conversare tra loro (magari per
> decidere qualcosa rispetto ad una architettura ecc), quindi non piu una conversazione uno a uno
> tra utente e modello ma uno a molti/molti a molti tra utente e modelli, e modelli a
> modelli/utente, feature spicy"

### The question being decided

**What is the smallest architecture that lets several configured models deliberate on one
decision with the user, inside the single session path and the AGENTS §7 invariants, without
committing the repo to a multi-party conversation model before there is evidence that one is
needed?** Concretely: is a council an *orchestration over the subagent runner*, a *new kind of
session*, or an *external tool*; who decides who speaks; and what, if anything, must change in
`ChatMessage`, the session log and the protocol?

Everything below is verified on `main` @ `4d995d0`, `PROTOCOL_VERSION` 17
(`protocol/src/version.ts:7`).

### Where the starting take holds, and where this eval disagrees

The orchestrator's first take was a `/council` with 2–3 role-playing voices, the agent as
moderator, fixed rounds, a token budget, a decision record, and a `speaker` on messages. The
council shape, the budget and the record hold. Four parts do not survive the code:

1. **An LLM moderator is the wrong default.** Choosing the next speaker in a fixed protocol is a
   branch, and AGENTS §7 puts branching in pure modules. A model moderator cannot enforce a
   budget, spends tokens on scheduling, and carries its own provider's bias. A deterministic
   scheduler does the job.
2. **A `speaker` on messages is not needed for the first release.** Each voice can be a fresh
   `run()` whose prompt carries the debate so far (`subagent.ts:278-282`). The debate is then
   ordinary data, and `ChatMessage` gains one optional display field at most.
3. **"Stop at consensus" is the sycophancy trap.** Agreement reached after a voice has read the
   others is the failure mode, not the success signal. Only agreement in the *blind* round may
   end a council early.
4. **The ping-pong guard does not fit.** The B3 budget allows 3 child wakes per user message
   (`subagent-live.md`, B3), so a debate over `agent_notify` hits it within one round. A fixed
   round protocol has no wakes, so it cannot loop.

### What exists and what is missing

| Area | Today (verified) | Consequence for a council |
|---|---|---|
| Message role | `Role` is `system \| user \| assistant \| tool` (`core/src/model.ts:11`); `ChatMessage` has no author (`:28-61`); the same enum is on the wire (`protocol/src/session.ts:33-51`) and on the tunnel (`protocol/src/model.ts:19-24`) | All assistant text is one speaker |
| Display-only fields | `spill`, `durationMs`, `denialReply` on `ChatMessage`; "provider mappers copy field by field, so the model never sees it" (`core/src/model.ts:35-52`); set in one place, `toolMessage` (`agent/src/agent.ts:198-207`) | The precedent for carrying a debate without touching roles |
| Log entries | 9 types; `base`, `message`, `replace`, `truncate` are critical (`protocol/src/session-log.ts:166-191`). A new critical type needs an owner decision and a version bump (`:12-18`) | Avoid a new critical type |
| Digest | `canonicalMessage` hashes a FIXED field list, and "a field a newer peer adds is outside it" (`session-log.ts:275-292`) | A display field must stay out of it, or old checkpoints and older peers mismatch |
| Agent loop | One `config.model` per `Agent` (`agent.ts:324`, `:888`); one `messages` array; requests never set `maxTokens` (`:875-880`) although `ChatRequest` has it (`core/src/model.ts:85`) | Several models means several `Agent`s. A voice's output has no length cap today |
| Session | One history and one steering queue (`agent/src/session.ts:65`, `:135`); one running turn (`daemon/src/hosted-session.ts:1009`) | A multi-party session would change this core object |
| Subagent runner | `createSubagentRunner` builds a fresh `Agent` per `run()` (`subagent.ts:207-313`), with the model picked by the TYPE (`:228`). `SubagentRunOptions` has no model (`:73-78`). It collects text, emits per-call usage (`:283-293`), and a model failure rejects (`:298-302`, from `agent.ts:924`) | It already is a per-voice single-round executor. Per-call `model` arrives with `feat/models-map` |
| Recursion guard | A child loses only `agent_task` and `context_reset` (`subagent.ts:217-226`) | A new `council` tool must be excluded too, or a voice could convene a council |
| `agent_task` | Awaited inside the round; receives the turn's signal, `emitProgress`, call id (`tools/src/task.ts:106-117`) | A foreground tool call already has cancel, progress and history validity |
| Live progress | `emitProgress` feeds a per-call queue closed when the call settles (`agent.ts:1322-1338`). `ToolProgressEvent` is a closed TS union (`core/src/tool.ts:78-87`), but on the wire `kind` is a free string (`protocol/src/updates.ts:134-145`) and the client's default branch drops an unknown kind (`client/src/mapping.ts:137-138`) | New progress kinds are free on the wire (display class, `updates.ts:298`), but their new fields must be declared on `ToolProgressSchema`, or they are stripped (probe line 4). This path is foreground-only (subagent-live H1) |
| Streamed text | `agent_message_chunk` has no author (`updates.ts:30-33`); the TUI appends any `text` to the last assistant row (`tui/src/state.ts:304-316`) | Parallel voices cannot use this update |
| Steering | Drained only at iteration boundaries (`agent.ts:864-868`); a drained steer becomes a `user` message | While a council runs as one tool call, a typed message waits. Pushing it into the history mid-call would break tool-call/result adjacency |
| Slash commands | Fixed built-ins (`tui/src/commands.ts:26-45`); `/name` activates a skill found on disk (`:104-114`, `session.ts:114`). No built-in skill catalog exists (`config/src/skills-scan.ts` only scans directories) | `/council` is a built-in that sends a short prompt. A user-level skill is enough for a spike |
| Terminal tool | No tool can end a turn: a search for `endsTurn`, `stopAfter` and similar flags finds none | "The agent stops and waits for the user" is an instruction, not a mechanism (Q8) |
| Model tunnel | `model/stream` carries a request and a closed `purpose` (`protocol/model.ts:60-67`); the laptop picks main or title and meters nothing (`client/src/remote-client.ts:2469-2483`) | Names over the tunnel arrive with task 4. There is no laptop-side spend limit today |
| Models config | `model` (`config/src/schema.ts:189`), `subagents` (`:221`), and **no `models` map yet**. `modelFor` takes an id on the same endpoint (`cli/src/wiring.ts:481`) | The foundation is subagent-live task 3; **a council of different providers needs it** |
| Read-only tools | `explore` has `fs_read` only (`subagent.ts:69`), permission `none` (`tools/src/builtins.ts:83`); `readOnlyType` answers whether a tool-set only reads (`subagent.ts:315-329`) | A read-only voice never raises a permission ask |
| Resume | `resume.ts:26-36` rebuilds rows by role | Any display of a debate after a resume must be added there |
| Mobile | `apps/mobile` has no `agent_message_chunk` handling (search: 0 matches) | No mobile work is needed for now |

Subagent-live status: tasks 1 (`general` rename) and 2 (tail view) are merged. Tasks 3–9 are not
built (`subagent_background`, `selectableModels` and `AgentJob` have no match in `packages/`).

### Repro (capability missing)

Run 2026-11-08 with ripgrep over `packages/`, case-insensitive:
`council|speaker|multi.?party|debate` → **0 occurrences in 0 files**.

**Probes**, run 2026-11-08 on `4d995d0` with Bun 1.4.3, fake providers only (scripts below,
since `.tentacle/tmp/` does not survive):

```
$ bun .tentacle/tmp/council/probe.ts
1 session/log ChatMessage keys after parse: role,content
2 model tunnel message keys after parse: role,content
3 digest same with/without extra field: true
4 tool_progress with a new kind parses: true | keys: type,toolCallId,kind,label
5 'council_turn' a known update type: false

$ bun .tentacle/tmp/council/rounds.ts
round 1 A: end_turn: m-a says (saw 36 chars)
round 1 B: end_turn: m-b says (saw 36 chars)
round 1 C: REJECTED: Error: 502 upstream down
round 2 A: end_turn: m-a says (saw 149 chars)
round 2 B: end_turn: m-b says (saw 149 chars)
round 2 C: REJECTED: Error: 502 upstream down
tokens via subagent_usage: 398
m-b round 2 prompt includes A's round 1: true
aborted before start: cancelled
```

What this shows:
- **Lines 1–3 confirm** that an undeclared field (`speaker`, `council`) is stripped by a reader and
  by the tunnel, and stays out of the digest: Option C's silent skew, and B's clean degradation.
- **Line 4 sharpens a claim.** A new `kind` parses, but its undeclared field `voice` is dropped:
  the new fields must be declared on `ToolProgressSchema`. Still no bump (§7: fields are free).
- **`rounds.ts` confirms the load-bearing assumption**: one voice-round is one `run()` on its own
  model, a failing voice rejects without affecting its siblings, a later round sees the earlier
  statements, and an abort resolves as `cancelled`.
- **398 corrects the budget design.** It is exactly A and B: (36+7)×2 + (149+7)×2. The rejected
  voice counted 0, because usage arrives only in a completed call's `done` event. The earlier text
  claimed a mid-call abort stops an overrun; see the corrected *Budget* paragraph, F1 and F3.

Not covered: real providers, tool-using voices, an abort in the middle of a stream (the probe
aborts before the start), and a per-CALL model: the probe selects the model by TYPE, as the
runner does today, and per-call `model` arrives with task 3.

<details><summary><code>probe.ts</code></summary>

```ts
import { createHash } from "node:crypto";
import {
  canonicalMessage,
  ChatMessageSchema,
  isKnownUpdateType,
  ToolProgressSchema,
  WireChatMessageSchema,
} from "@tentacle/protocol";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const m = { role: "assistant", content: "use option B", speaker: "red-team", council: { rounds: 3 } };

const parsed = ChatMessageSchema.parse(m) as Record<string, unknown>;
console.log("1 session/log ChatMessage keys after parse:", Object.keys(parsed).join(","));
const tunnel = WireChatMessageSchema.parse(m) as Record<string, unknown>;
console.log("2 model tunnel message keys after parse:", Object.keys(tunnel).join(","));

const plain = { role: "assistant" as const, content: "use option B" };
const voiced = { ...plain, speaker: "red-team" } as typeof plain;
console.log("3 digest same with/without extra field:", sha(canonicalMessage(plain)) === sha(canonicalMessage(voiced)));

const progress = ToolProgressSchema.safeParse({
  type: "tool_progress",
  toolCallId: "c1",
  kind: "council_turn",
  voice: "A",
  label: "x",
});
console.log(
  "4 tool_progress with a new kind parses:",
  progress.success,
  "| keys:",
  progress.success ? Object.keys(progress.data).join(",") : "-",
);
console.log("5 'council_turn' a known update type:", isKnownUpdateType("council_turn"));
```

</details>

<details><summary><code>rounds.ts</code></summary>

```ts
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { createSubagentRunner, type AgentType } from "@tentacle/agent";
import { ToolRegistry } from "@tentacle/tools";

const seen: Record<string, string[]> = {};
function fake(id: string, fail = false): ModelProvider {
  return {
    id,
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      if (req.signal?.aborted) {
        throw new Error("aborted");
      }
      const last = req.messages[req.messages.length - 1]?.content ?? "";
      (seen[id] ??= []).push(last);
      if (fail) {
        throw new Error("502 upstream down");
      }
      yield { type: "text", delta: `${id} says (saw ${last.length} chars)` };
      yield { type: "done", usage: { promptTokens: last.length, completionTokens: 7 } };
    },
  };
}

const models: Record<string, ModelProvider> = {
  "m-a": fake("m-a"),
  "m-b": fake("m-b"),
  "m-c": fake("m-c", true),
};
const voice = (name: string, model: string): AgentType => ({
  name,
  description: name,
  prompt: `You are ${name}.`,
  tools: ["fs_read"],
  model,
});
const { run } = createSubagentRunner({
  model: fake("main"),
  modelFor: (id) => models[id] ?? fake("unknown"),
  env: {} as never,
  tools: new ToolRegistry(),
  types: [voice("A", "m-a"), voice("B", "m-b"), voice("C", "m-c")],
});

const transcript: { round: number; voice: string; text: string }[] = [];
const prompt = (r: number, v: string) =>
  `Q: pick X or Y. Round ${r}. You are ${v}.\n${transcript
    .filter((t) => t.round < r)
    .map((t) => `<statement voice="${t.voice}">${t.text}</statement>`)
    .join("\n")}`;

let tokens = 0;
for (const round of [1, 2]) {
  const settled = await Promise.allSettled(
    ["A", "B", "C"].map((v) =>
      run(
        { description: `round ${round}`, prompt: prompt(round, v), type: v },
        {
          onEvent: (e) => {
            if (e.kind === "subagent_usage") {
              tokens += e.promptTokens + e.completionTokens;
            }
          },
        },
      ).then((r) => ({ v, r })),
    ),
  );
  for (const [i, s] of settled.entries()) {
    const v = ["A", "B", "C"][i] ?? "?";
    if (s.status === "fulfilled") {
      transcript.push({ round, voice: v, text: s.value.r.report });
      console.log(`round ${round} ${v}: ${s.value.r.stopReason}: ${s.value.r.report}`);
    } else {
      console.log(`round ${round} ${v}: REJECTED: ${String(s.reason)}`);
    }
  }
}
console.log("tokens via subagent_usage:", tokens);
console.log("m-b round 2 prompt includes A's round 1:", (seen["m-b"]?.[1] ?? "").includes('voice="A"'));

const controller = new AbortController();
controller.abort();
const cancelled = await run(
  { description: "cancel", prompt: "x", type: "A" },
  { signal: controller.signal },
).catch((e) => ({ report: String(e), toolUses: 0, stopReason: "threw" as const }));
console.log("aborted before start:", cancelled.stopReason);
```

</details>

### Prior art

**From memory only: no web access was used, nothing here was re-checked, and no numbers are
quoted on purpose. Verify before citing.**
Irving, Christiano and Amodei, "AI safety via debate" (2018), frames debate as oversight. Du et
al. (2023, multi-agent debate) report that models exchanging answers over rounds improved on
reasoning benchmarks. Liang et al. (2023, "MAD") add a judge and forced disagreement, because
models converge too early. Smit et al. (2024, "Should we be going MAD?") find debate does not
reliably beat simpler ensembling and is sensitive to its settings: the main reason T0 exists.
Karpathy's `llm-council` (2025) uses the shape closest to this eval: independent answers,
anonymised peer review, a chairman's synthesis. AutoGen's GroupChat offers round-robin or
LLM-selected speakers. Cognition's "Don't Build Multi-Agents" and Anthropic's post on its
multi-agent research system (both 2025) disagree usefully on shared context versus isolation.
Aider's architect/editor mode pairs two models with fixed jobs.

## Analysis

*— claude-opus-5-5, 2026-11-08*

### Option A — a skill over `agent_task` (the agent moderates)

A skill tells the agent to launch N `agent_task` calls with the `model` argument (owner's
`selectableModels`, task 3), paste the reports into a second round, then summarise.

- **For:** no harness code after task 3; a real test of whether the idea is worth building.
- **Against:** the budget is advice, since nothing can stop the loop. Every report lands in the
  agent's context (N voices × R rounds). The agent re-types the other voices' words, so it can
  soften them. It is a participant with its own provider's bias. The UI shows anonymous subagent
  blocks. Over `agent_notify` it would collide with the B3 wake budget.
- **Verdict:** right as a **spike (T0)**, wrong as the product.

### Option B — a council is one bounded tool call, scheduled by a pure engine (recommended)

A built-in `council` tool runs a deterministic protocol from a pure, React-free engine. Each
voice's turn is one `run()` of the existing runner, on its own model. The tool's result is the
decision record, and the debate rides a display-only field of that same tool message.

- **For:** no new loop, session kind or role. Cancel, history validity, persistence and resume
  come from the tool-call path. The budget is enforced by code. The agent's context grows by one
  bounded record. It needs nothing but task 3 to ship on laptop and `serve`.
- **Against:** it is a *meeting*, not a conversation: the voices do not persist across councils.
  In the foreground a typed message waits for the end. A voice is stateless between rounds, so
  anything it found must be in its statement.
- **Growth path:** the same engine moves onto the agent-job runtime of task 6a (T6), then gets
  user interjection (T7), reusing the focus view and inbox of tasks 7 and 8.

### Option C — a first-class multi-party session

`ChatMessage.speaker`, per-participant projections of one shared history, a turn scheduler in
`HostedSession`, per-speaker streaming, and a transcript of participants.

It is the only option that delivers the owner's full "many-to-many", and what it costs is
concrete:

- `agent_message_chunk` and the `text` event gain an author; the TUI's merge into the last
  assistant row (`state.ts:304-316`) is rewritten. The `steer`/queue reconciliation needs a target.
- Each model needs its own projection: its own text as `assistant`, the others' as labelled
  `user`. Consecutive same-role turns are tolerated on Anthropic (`anthropic-provider.ts:380-381`).
  Tool-call ids and reasoning do not transfer across providers, and each projection breaks the
  prefix that prompt caching depends on (`agent.ts:872-874`).
- Compaction assumes one assistant (`agent/src/compact.ts:11-12`) and would need a speaker-aware
  summary. So would `resume.ts:26-36`.
- **Version skew is silent.** `speaker` on a `message` entry is stripped by an older reader
  (`ChatMessageSchema` is a strip object), so a build that loads the log shows a single assistant
  contradicting itself. Honest handling needs a critical entry or a `PROTOCOL_VERSION` bump plus
  an owner decision under `session-log.ts:12-18`.
- A scheduler above `Session.send` is one step from "a parallel agent loop", which §7 forbids.

**Verdict: not now.** Reconsider through a new eval when usage shows a concrete need that B
cannot meet (see *When to reopen C*).

### Option D — an external tool (MCP server or a separate CLI)

- **For:** isolated from the core.
- **Against:** run in a pod, it would need provider keys there, which breaks "model stays on the
  laptop". Run on the laptop, it needs a second key configuration beside `models`. `packages/mcp/src`
  has no progress plumbing (search: 0 matches), so the UI is one long spinner. A separate CLI
  cannot see the session.
- **Verdict:** rejected.

### Options against the §7 invariants

| Invariant | A skill | **B tool + engine** | C multi-party | D external |
|---|---|---|---|---|
| One session path | holds | holds: runs in the daemon as a tool | at risk: a second turn kind | outside it |
| Logic in pure modules | logic is in a prompt | holds: engine + view-model | large new logic in `HostedSession`/TUI | n/a |
| Single broker | holds | holds: voices read only; one confirm through the broker | every speaker's asks need routing | a second approval surface |
| Persistence | holds | holds: one `message` entry | new critical data | none |
| Model stays on laptop | holds with task 4 | holds with task 4 + T5 | holds with task 4 | **breaks in a pod** |
| Pod not trusted | as `agent_task` | as `agent_task`, plus a laptop meter (T5) | speaker labels are pod-supplied in history | n/a |
| Protocol honesty | free | free (display kinds, optional field) | bump + critical entry | n/a |
| Peer not serialized | holds | holds: no new long handler | must be designed | n/a |
| Never write raw to the terminal | holds | holds | holds | n/a |

### Recommended design (Option B)

**Load-bearing assumption.** One voice-round is exactly one existing `run()`: a fresh child on
its own model, whose report is the statement, whose usage is observable, and whose failure
rejects without affecting its siblings. Source: `subagent.ts:207-313`, `:288-293`, `:298-302`.
Confirmed with fakes (see *Repro*), by type-selected models. T1's first test pins it for good
and adds what the probe did not cover: an abort mid-stream.

**Protocol (a pure state machine, `packages/agent/src/council/`).**

| Step | Who | Sees | Output |
|---|---|---|---|
| Brief | the agent, as the tool's arguments | the live conversation | `question`, `brief`: a voice starts cold, so this is the only context it gets |
| Round 1, blind | every voice, in parallel | question + brief | an independent proposal |
| Round 2, critique | every voice, in parallel | + all round-1 statements | an attack or defence, according to the voice's role |
| Round 3, final | every voice, in parallel | + all round-2 statements | a final position with a stance footer |
| Chair | one call, no tools | the whole debate | options, pros/cons, recommendation |

Rules:
- **Synchronous rounds.** Every voice in a round sees the same past, so no one anchors the rest.
- **Identity.** Voices see `Voice A/B/C` and their own role; the user sees names and models (Q5).
- **Evidence.** Voices get `fs_read` and at most 6 steps per round, and must cite `file:line`
  because a voice forgets between rounds (Q4). The engine refuses any tool-set for which
  `readOnlyType` is false, so a voice can never raise a permission ask.
- **Stance footer.** Each statement ends with `STANCE: <short option>`, and from round 2
  `CHANGED: yes|no` and `BECAUSE: <one line>`. A malformed footer is recorded as `unparsed`.
- **Early stop.** Only if all voices' round-1 stances match AND round 2 raises no change. A
  convergence reached after a disagreement always runs the last round, and the record names who
  moved and why.
- **Dissent cannot be summarised away.** The harness, not the chair, appends the verbatim stance
  table and a dissent line.
- **A statement is data.** It is capped before re-injection and wrapped in a delimiter that says
  it is another participant's text, not an instruction.

**Budget.** Pure and enforced: `council.maxTokens` covers all prompt and completion tokens from
`subagent_usage`. If a provider reports no usage (`done.usage` is optional, `core/src/model.ts:79`),
it falls back to chars/4. Before each round, a projection of its cost against the remainder
decides whether to skip to the chair, whose share is reserved up front. Usage arrives only when
a model call completes (`done`, confirmed by the probe), so a linked `AbortController` can stop a
voice only **between its steps**, never on the tokens of a call in flight. A failed or cancelled
call reports nothing, so the engine charges its chars/4 prompt estimate when the call starts and
settles it against the real usage if `done` arrives. The hard bound on one call is therefore a
per-voice output cap, which needs `maxTokens` plumbed into `Agent` (T2).

Rough cost, **arithmetic on assumptions, not a measurement** (4k-token brief, 800-token
statements, no tool use, 3 voices, 3 rounds): input 12k + 19k + 26k + chair 10k ≈ 68k, output
≈ 7k. Read-only tools can multiply this by several times, hence a default of 120k and a visible
meter (Q7).

**Config (opt-in; the tool is not registered without `voices`).**
```jsonc
"council": {
  "voices": [
    { "name": "proposer",   "model": "opus",  "role": "propose" },
    { "name": "red-team",   "model": "qwen",  "role": "attack" },
    { "name": "simplifier", "model": "other", "role": "cost" }
  ],
  "chair": "opus",        // a models name; default: the top-level model
  "rounds": 3,            // 2 or 3
  "maxTokens": 120000,
  "voiceTimeoutMs": 300000
}
```
Every `model` must name a `models` entry (the task 3 rule: an unknown name is a config error).
Two voices resolving to the same endpoint and model produce a warning, and the record says so.

**Tool.** `council({question, brief})`, `permission: "ask"` so that every council shows one
confirm with voices and budget (Q6). `concurrency` absent, so it is exclusive
(`core/src/tool.ts:131-133`). No `spawnKind`, so it stays out of the spawn lane and out of
task 6b's detach. Internally its parallelism is capped by `subagents.maxParallel`, the one limit
the owner decided. `/council <q>` is a built-in that sends the one-line prompt
`Convene a council on: <q>`; the tool's description tells the agent how to write the brief.

**Wire: no `PROTOCOL_VERSION` bump.** New `tool_progress` kinds, with their fields declared as
optional on `ToolProgressSchema` (an undeclared field is stripped, probe line 4):
`council_phase` (round, tokens, budget), `council_voice` (voice, state, label), `council_statement`
(voice, round, capped text, stance). Whole statements, never token deltas: parallel streams
are unreadable. An older client skips them (`mapping.ts:137-138`) and still shows a tool row and
the record. Text is sanitized client-side, as `progressText` does (`mapping.ts:117`).

**Persistence.** `ToolResult.council` → `ChatMessage.council`: `{voices, rounds[], tokens,
outcome}`, display-only, capped at 64 KB, written by `toolMessage` (`agent.ts:198-207`). It is
**not** added to `canonicalMessage`. It rides the existing `message` entry, so there is no new
log type, no critical decision and no store change. A log page holds it easily
(`LOG_PAGE_MAX_CHARS` is 256 KiB, `session-log.ts:44`). An older reader strips the field and
keeps the record in `content`: the right degradation. Not on the tunnel, by schema
(`protocol/model.ts:19-24`), so it never reaches a model.

**Trust in a pod.** The voices are `Agent`s in the pod daemon, and their model calls go through
the tunnel by name, so no voice ever holds a key. A hostile daemon can forge any label or
statement, the same class as a forged tool result (subagent-live F16). The record is advice, and
acting on it goes through the broker on the laptop. Per §7 a daemon-side budget is UX only, and
`servingModel` meters nothing (`remote-client.ts:2469-2483`). Money is an effect on the laptop, so
T5 adds a laptop-side ceiling for tunnelled non-main names (Q10). The laptop allowlist must also
include `council.voices[].model` and `chair`, extending subagent-live L3.

### When to reopen Option C

Open `eval/multi-party-session` only if T0 and real use show at least one of: users repeatedly
continue a discussion with one specific voice across turns; a decision needs voices that keep
their own evolving context beyond one council; or the agent and a voice need to work together
on the same edit. Until then, B's data (`ChatMessage.council`) can be migrated to any later model.

## UX

*— claude-opus-5-5, 2026-11-08*

Glyphs are illustrative; the real ones are `render-lines.ts`'s. The block is a `tool` item with
a pure `councilView(...)` view-model, following `subAgentView` (`subagent-view.ts:67`). Ctrl+O
expands it, as today (`render-lines.ts:284-290`).

**1. Live council, 80 columns (foreground, T4).** Only finished statements are shown:

```
> /council Should the session log move to SQLite?

● council  3 voices · round 2/3 critique · 41k/120k tok · 1m12s
  A proposer    opus   ✓ opening  ✓ critique
  B red-team    qwen   ✓ opening  ◐ fs_read session-log-file.ts
  C simplifier  other  ✓ opening  ◐ writing

  A▸ Keep JSONL. The fold is shared with the pod reader (session-log.ts:202).
  B▸ SQLite removes the aside files, but a pod image needs a native module.
  C▸ Neither: cap segment size and measure replay first.
  ctrl+o full debate · esc stop
```

**2. Live council, 46 columns.** Roles shorten, and only the newest statement is shown:

```
● council · 2/3 critique · 41k/120k
  A proposer  ✓ ✓
  B red-team  ✓ ◐ fs_read session-lo…
  C simplif…  ✓ ◐ writing
  C▸ Neither: cap segment size and
     measure replay first.
  ctrl+o debate · esc stop
```

**3. The user writes during a foreground council (T4, 80 columns).** The message waits, and the
UI says so:

```
● council  3 voices · round 3/3 final · 78k/120k tok · 2m03s
  ...
› also consider offline viewing on mobile          queued · after the council
```

**4. The user interjects (T7, after T6 + tasks 7/8), 80 columns.** The focus view reuses
subagent-live M6, and the note reaches every voice at the next round:

```
 council c-1 · round 2/3 critique · 41k/120k                          esc back
   B▸ The snapshot path assumes one writer (hosted-session.ts:1202).
   C▸ Options 2 and 3 collapse if we drop the aside.
   [you → council] offline viewing on mobile is a hard requirement
╭ → council · delivered at the start of round 3 ───────────────────────────╮
│ > _                                                                      │
╰──────────────────────────────────────────────────────────────────────────╯
```

The same at 46 columns:

```
 council c-1 · 2/3 · 41k/120k      esc back
   C▸ Options 2 and 3 collapse if we…
   [you] offline viewing is required
╭ → council · next round ───────────────────╮
│ > _                                       │
╰───────────────────────────────────────────╯
```

**5. Decision record, 80 columns.** The harness writes the stance table and dissent line:

```
◆ Council decision · 3 voices · 3 rounds · 94k tok · 2m41s

  Should the session log move to SQLite?

  1  Keep JSONL, cap segment size                              ← recommended
     + no new dependency; one fold shared with the pod reader
     − a long session still replays its last segment on open
  2  SQLite on the laptop only
     + indexed resume
     − a second store format beside the daemon's JSONL
  3  SQLite on both ends
     − a native module in every pod image

  Final positions (verbatim)
  A proposer    opus   option 1  unchanged
  B red-team    qwen   option 2  unchanged  "replay cost is unmeasured"
  C simplifier  other  option 1  changed    after B's replay point

  ⚠ Dissent: B prefers option 2.
  Open question: nobody measured replay on a large log.

  Your decision? · ctrl+o full debate
```

**6. Decision record, 46 columns.** Options stack; the table loses its columns:

```
◆ Council · 3 voices · 3 rounds · 94k

  1 Keep JSONL, cap segments  ← rec.
    + no new dependency
    − replay on open remains
  2 SQLite on the laptop only
    + indexed resume
    − a second store format
  3 SQLite on both ends
    − native module in pod images

  A proposer   option 1
  B red-team   option 2
    "replay cost is unmeasured"
  C simplif…   option 1 (changed)

  ⚠ Dissent: B prefers option 2.
  Your decision? · ctrl+o debate
```

## Failure modes

*— claude-opus-5-5, 2026-11-08*

| # | Case | How state converges |
|---|---|---|
| F1 | **Cost runaway** | The engine projects each round and jumps to the chair when it cannot afford it. A linked abort stops an overrunning voice between its steps, and the output cap bounds the call in flight, so a council can exceed the budget by at most the calls in flight. The chair's share is reserved up front, and the record states `budget reached after round N` |
| F2 | **Budget too small for round 1** | Refused before any call, in the tool's result, with the estimate |
| F3 | **Provider reports no usage, or a call fails or is cancelled** | chars/4 estimate charged at the call's start and kept when no `done` arrives (a rejected voice otherwise counts 0: probe), and the meter shows `~` |
| F4 | **Loops** | Impossible by construction: a fixed number of rounds, no wakes, no voice can call a voice |
| F5 | **Recursion** | `council` joins the excluded tools at `subagent.ts:220`, with a test. Voices cannot reach it, and `agent_task` is already excluded |
| F6 | **A voice's provider is down** | `run()` rejects (`subagent.ts:298-302`), `allSettled` keeps the rest, and that voice is marked absent for the round. It is retried in the next round |
| F7 | **Quorum lost** (fewer than 2 voices answered a round) | No more rounds. The record is written from what exists, labelled `quorum lost`. No recommendation is made from a single voice |
| F8 | **A voice hangs**, or a local server queues it (over-subscription only queues, owner slots decision) | `voiceTimeoutMs` on an injected clock; then as F6 |
| F9 | **Chair fails** | The record is the harness's own: statements, the stance table, `no synthesis`. The debate is never lost to a failed chair |
| F10 | **Malformed stance footer** | Recorded as `unparsed`; not counted toward early stop. Never a crash |
| F11 | **All voices are the same model** | A config warning and a line in the record. Not refused (a local-only user may want roles) |
| F12 | **Sycophantic convergence** | Blind round, anonymity, early stop only on blind agreement, verbatim dissent, and `changed` with a reason on the record. Reduced, not eliminated: the record shows it, the user judges |
| F13 | **Prompt injection through a file a voice reads** | Voices are read-only. Statements are delimited as data. The worst outcome is a bad recommendation, which still needs the user's decision and the broker |
| F14 | **Esc mid-round** | The signal aborts every child (`task.ts:112`), each ending `cancelled` (`agent.ts:908-924`). The tool returns the partial debate labelled `cancelled`, so the history stays valid. It costs no further calls |
| F15 | **The user types during a foreground council** | The steer waits for the next boundary (`agent.ts:864-868`) and the row says so. Nothing is dropped |
| F16 | **TUI detaches on `serve`** | The turn runs daemon-side, like any tool call. A reattached client gets the record, and the live tail restarts at the next progress frame |
| F17 | **Process dies mid-council (foreground)** | Same as any running tool: the reload labels the call "Interrupted" (`persisted-session.ts:185`, `:195`). Partial debate lost. The agent or user re-convenes; no resume in the first release |
| F18 | **Resume of a finished council** | The tool message holds `council`, and `resume.ts` renders it. After a compaction the display field goes with the superseded segment, and the record survives as far as the summary keeps it |
| F19 | **Background council + restart (T6)** | A new job kind on task 5's ledger. It reports "lost" honestly (A4), and the partial debate is not persisted |
| F20 | **Version skew, new daemon + older client** | Unknown progress kinds are skipped, the field is stripped, and the record still arrives in `content` |
| F21 | **Older build rewrites a log with a council** | The field is stripped on its re-serialization: the debate is lost, the record is intact. Same-version peers only; accepted for a display field |
| F22 | **Pod: tunnel drops** | Each voice's model call fails, as F6, then F7. The laptop's copy holds what it read before |
| F23 | **Pod: a name outside the allowlist** | `InvalidRequest` on the laptop (task 4 rule, extended by T5). That voice is absent |
| F24 | **Pod: spend abuse** | T5's laptop ceiling refuses further tunnelled non-main calls for that session (Q10) |
| F25 | **Settings sync rebuilds the agent mid-council** | The running tool keeps its captured config; the new config applies to the next council |
| F26 | **Empty question or brief** | Rejected by the tool's schema, before any confirm |
| F27 | **Agent acts without waiting for the user** | Permission gates still apply to every action. Soft instruction in the first release (Q8) |

## Proposed split into tasks

*— claude-opus-5-5, 2026-11-08*

In dependency order, one code task at a time (AGENTS §10). "Suited" states only what §10 gates
on; the owner assigns executors. T1–T4 together are the laptop/`serve` release.

| # | Task | Size | Blast | Suited (§10) | Depends on |
|---|---|---|---|---|---|
| T0 | Spike: `/council` as a user-level skill, over 3 past decisions, recorded in this eval (no repo code) | S | contained | standard Review | subagent-live 3 (`models`, `selectableModels`) |
| T1 | `feat/council-engine`: the pure protocol (rounds, blind rule, early stop, budget, quorum, prompt projection, stance footer, record assembly); first test = the load-bearing assumption | M | contained | standard Review | none |
| T2 | `feat/council-tool`: `council` tool, `council.*` config, per-call `model`/step/output caps on the runner, exclude from children, progress kinds both ends | M | cross-module | standard Review | T1, subagent-live 3 |
| T3 | `feat/council-record-persist`: `ToolResult.council` → `ChatMessage.council`, wire schema, `toolMessage`, excluded from the digest, resume rendering | S | load-bearing (persisted message shape) | strong executor + fresh-context Review | T2 |
| T4 | `feat/council-tui`: `/council`, pure `councilView`, live block and record at 80/46, queued hint; a frame test per mockup | M | cross-module | standard Review | T2, T3 |
| T5 | `feat/council-pod`: carry voices (names and roles, P key), allowlist union, laptop-side token ceiling | M | load-bearing (pod not trusted, model stays on laptop) | strong executor + fresh-context Review | T2, subagent-live 4 |
| T6 | `feat/council-background`: a council as an agent-job kind, listed, stoppable, reported "lost" honestly, no wake at the end (Q8) | M | load-bearing (agent-job runtime) | strong executor + fresh-context Review | T2–T4, subagent-live 5, 6a |
| T7 | `feat/council-interject`: focus `→ council`, inbox drained at round boundaries, the agent told at its next turn (`[user → council]`, never a wake) | M | load-bearing (steering-adjacent) | strong executor + fresh-context Review | T6, subagent-live 7, 8 |

No task needs a `PROTOCOL_VERSION` bump of its own: T5 and T6 ride tasks 4 and 6a. Option C is
not in the split: it would be a new eval.

**Proposed `TODO.md` lines (not applied):**

```markdown
- [ ] **eval/multi-model-council** (owner 2026-11-08, `docs/eval/multi-model-council.md`): several models deliberate on a decision with the user; recommended: one bounded `council` tool over a pure engine. Owner Q1–Q11 open. Type: eval → feat · Size: L overall (8 tasks) · Blast: load-bearing where marked.
  - [ ] **T0 council spike** (user-level skill over 3 past decisions, go/no-go recorded in the eval; needs `feat/models-map`). Type: eval · Size: S · Blast: contained.
  - [ ] **feat/council-engine** (T1): pure protocol, budget, quorum, record. Type: feat · Size: M · Blast: contained.
  - [ ] **feat/council-tool** (T2): tool, config, runner per-call caps, progress kinds; needs T1 + `feat/models-map`. Type: feat · Size: M · Blast: cross-module.
  - [ ] **feat/council-record-persist** (T3): display-only `ChatMessage.council`, resume. Type: feat · Size: S · Blast: load-bearing.
  - [ ] **feat/council-tui** (T4): `/council`, live block, record at 80/46. Type: feat · Size: M · Blast: cross-module.
  - [ ] **feat/council-pod** (T5): carry, allowlist union, laptop token ceiling; needs `feat/models-map-pod`. Type: feat · Size: M · Blast: load-bearing.
  - [ ] **feat/council-background** (T6): council as an agent job; needs `feat/subagent-ledger-log`, `feat/subagent-background`. Type: feat · Size: M · Blast: load-bearing.
  - [ ] **feat/council-interject** (T7): the user writes to a running council; needs T6, `feat/subagent-panel`, `feat/agent-message`. Type: feat · Size: M · Blast: load-bearing.
```

## Owner questions

*— claude-opus-5-5, 2026-11-08*

They can be answered in one batch. Q1 and Q2 gate everything else.

**Q1. What ships first?**
(a) the bounded council (Option B), with many-to-many left to a later eval; (b) a first-class
multi-party session now (Option C); (c) the skill only (Option A), and stop there.
**Recommend (a).** It delivers the decision use-case you named at a fraction of C's blast, and
C's costs are worth paying only with evidence.

**Q2. Run the spike (T0) before any code?**
(a) yes, with a go/no-go: on 3 past decisions, does the council raise at least one objection you
judge material that one strong model with a red-team prompt did not, at a cost you accept;
(b) no, build T1 directly.
**Recommend (a).** Prior work is divided on whether debate beats simpler ensembling, and the
spike costs only task 3 plus one skill file.

**Q3. Who decides who speaks?**
(a) a deterministic scheduler; (b) the agent as an LLM moderator; (c) configurable.
**Recommend (a).** It enforces the budget, cannot loop, and is testable. Free turn-taking can be
a later scheduler behind the same engine.

**Q4. What do voices work from?**
(a) the agent's brief plus read-only `fs_read`, at most 6 steps per round; (b) the brief only;
(c) full tools.
**Recommend (a).** Brief-only voices argue from the agent's framing of the code. Full tools would
bring permission asks and side effects into a deliberation.

**Q5. Do voices know who the others are?**
(a) anonymous to each other, named to you; (b) named to everyone.
**Recommend (a).** It reduces deference to a famous model and costs nothing.

**Q6. Who can convene a council?**
(a) you or the agent, always with one confirm showing voices and budget; (b) `/council` needs no
confirm, an agent-initiated one does (requires marking the call's origin); (c) only you, the
agent never can.
**Recommend (a).** One path, and the confirm is the cost gate. It costs you one key per council.

**Q7. Budget defaults and behaviour.**
(a) 3 rounds, 120k tokens per council, and on reaching it jump to the chair with its reserved
share; (b) the same defaults, but stop with no record; (c) ask you at the limit.
**Recommend (a).** You paid for the debate, so you should always get a record. The 120k default
should be revisited with T0's measured numbers.

**Q8. After the decision record?**
(a) the agent presents it and is instructed to wait for your choice, a soft rule (no tool can end
a turn today); (b) the agent may proceed on the recommendation; (c) add a real end-turn flag for
tools to the agent loop (a load-bearing change).
**Recommend (a)**, moving to (c) only if the spike shows the instruction is ignored. In
background (T6), the council's end does not wake the agent at all.

**Q9. Where does the full debate live?**
(a) a display-only `council` field on the tool message; (b) only the record, the debate is lost at
the end of the turn; (c) a new non-critical log entry type.
**Recommend (a).** It follows `spill`'s precedent, needs no new type, and degrades cleanly on an
older reader.

**Q10. In a pod, is there a laptop-side spending limit?**
(a) yes: T5 adds a per-session token ceiling for tunnelled non-main models; (b) no: the daemon-side
budget is enough, accepting that a hostile pod can spend up to any allowed model.
**Recommend (a).** §7 says a daemon-side check is UX, and spending is an effect on the laptop.
The main model has the same exposure today; (a) leaves that unchanged and tracks it separately.

**Q11. How does the user intervene during a council?**
(a) in the first release Esc stops it and a typed message waits for the end; interjection arrives
with T7; (b) add a pause between rounds to the first release (an extra ask per round);
(c) no interjection ever.
**Recommend (a).** Real interjection needs the background runtime and the inbox anyway, and the
first release's councils last minutes.

## Implementation

*— claude-opus-5-5, 2026-11-08*

Empty until the eval is promoted (AGENTS §10). *Recommended design* is the input to each task's
§8 plan, and each plan re-verifies its citations against the code at that time.

## Execution

*— claude-opus-5-5, 2026-11-08*

Empty: an eval carries no code.

## Review

*— claude-opus-5-5, 2026-11-08*

**Proposed verdict: promote Option B in the split above, starting with T0, subject to the owner's
answers.** This is the author's own assessment, not the fresh-context pass §10 asks for on
load-bearing work; each load-bearing task gets that pass when it runs.

What holds: each row of *What exists and what is missing* was read in the source at `4d995d0`.

What is not verified:
- The two probes ran with fake providers only (see *Repro*). They confirmed the load-bearing
  assumption and the strip and digest behaviour, and corrected one claim: a linked abort cannot
  stop a call in flight, and a failed call reports no usage (*Budget*, F1, F3). Real providers,
  tool-using voices and an abort mid-stream remain untested.
- Token costs are arithmetic on assumptions; T0 will measure them.
- Whether a council improves decisions at all. Prior art is recalled from memory and divided,
  which is why T0 has a go/no-go.
- Whether the soft "wait for the user" instruction holds in practice (Q8, tested in T0).
