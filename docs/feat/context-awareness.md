# feat/context-awareness — The model knows how full its context is

> **Status:** done
> **Branch:** `feat/context-awareness`
> **Type:** feat · **Size:** M · **Blast:** load-bearing (agent-loop request assembly; persisted message shape; daemon record version) · **Suited:** Opus executes; mandatory fresh-context Review (`/code-review` or a sub-agent) that red-teams the persistence rule and the prompt-cache stability

## Context

*— claude-opus-5-5, 2026-10-26*

Decided in `docs/eval/context-awareness.md` (owner decisions 1–4, binding).
Today the model is never told how full its context is: `contextWindow`
(`packages/config/src/resolve.ts:215-219`) reaches only the TUI meter
(`packages/tui/src/components/StatusBar.tsx:95`), and
`DefaultContextManager.needsCompaction` (`packages/core/src/context.ts:43-46`)
has no caller outside tests. The feature: a short usage line, emitted once per
new step, appended to the message that crosses it (a tool result or a user
message, never the system prompt), counted from the provider's reported usage
with the heuristic counter as a fallback; config
`"contextAwareness": { "enabled": true, "stepPercent": 1 }` at top level. It
lands before `context-reset` (`docs/eval/context-reset.md`, decision 10).

**Repro** (2026-10-26, main `5e8b538`, `.tentacle/tmp/context-awareness/repro.ts`,
run with `bun run <path>`):

```ts
// A: what the OpenAI-compatible provider reports as usage (streaming).
// B: what the Anthropic provider reports when the server also reports cached input.
// C: what the agent loop sees: the `usage` event arrives before the next request,
//    and the request's `messages` IS the history array (same reference).
import { Agent } from "../../worktrees/main-ro/packages/agent/src/index.ts";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent }
  from "../../worktrees/main-ro/packages/core/src/index.ts";
import { AnthropicProvider, OpenAIProvider } from "../../worktrees/main-ro/packages/providers/src/index.ts";
import { ToolRegistry } from "../../worktrees/main-ro/packages/tools/src/index.ts";

const sse = (events: unknown[], tail = ""): typeof fetch =>
  (async () =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + tail, {
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

async function last(p: ModelProvider): Promise<StreamEvent | undefined> {
  let done: StreamEvent | undefined;
  for await (const e of p.stream({ messages: [{ role: "user", content: "hi" }] })) done = e;
  return done;
}

// A
const openai = new OpenAIProvider({ baseURL: "http://x/v1", model: "m", fetch: sse([
  { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 12000, completion_tokens: 30 } },
], "data: [DONE]\n\n") });
console.log("A openai done:", JSON.stringify(await last(openai)));

// B
const anthropic = new AnthropicProvider({ baseURL: "http://x/v1", model: "m", fetch: sse([
  { type: "message_start", message: { usage: {
      input_tokens: 40, cache_read_input_tokens: 11000, cache_creation_input_tokens: 960 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } },
  { type: "message_stop" },
]) });
console.log("B anthropic done (real prompt = 12000):", JSON.stringify(await last(anthropic)));

// C
const log: string[] = [];
const requests: ChatRequest[] = [];
let round = 0;
const fake: ModelProvider = { id: "fake", async *stream(req) {
  requests.push(req); round++;
  log.push(`request ${round}: ${req.messages.length} messages`);
  if (round === 1) {
    yield { type: "tool_call", toolCall: { id: "c1", name: "nope", arguments: "{}" } };
    yield { type: "done", usage: { promptTokens: 1000, completionTokens: 20 } };
  } else {
    yield { type: "text", delta: "done" };
    yield { type: "done", usage: { promptTokens: 1100, completionTokens: 5 } };
  }
} };
const agent = new Agent({ model: fake, tools: new ToolRegistry(),
  env: {} as ExecutionEnvironment, systemPrompt: "sys" });
const history = agent.startConversation();
history.push({ role: "user", content: "go" });
for await (const e of agent.runMessages(history, "s1")) {
  if (e.type === "usage" || e.type === "tool_result" || e.type === "turn_end")
    log.push(`event ${e.type}${e.type === "usage" ? ` ${JSON.stringify(e.usage)}` : ""}`);
}
console.log(log.join("\n"));
console.log("C request.messages === history:", requests.map((r) => r.messages === history));
console.log("C history roles:", history.map((m) => m.role).join(","));
```

Output:

```
A openai done: {"type":"done","usage":{"promptTokens":12000,"completionTokens":30}}
B anthropic done (real prompt = 12000): {"type":"done","usage":{"promptTokens":40,"completionTokens":30}}
request 1: 2 messages
event usage {"promptTokens":1000,"completionTokens":20}
event tool_result
request 2: 4 messages
event usage {"promptTokens":1100,"completionTokens":5}
event turn_end
C request.messages === history: [ true, true ]
C history roles: system,user,assistant,tool,assistant
```

Reading: (A) OpenAI-compatible reports the full prompt. (B) Anthropic drops
cached input: with prompt caching active the reported prompt is 40, not 12000
— the count would be wrong by ~99 %. (C) The loop gets round N's usage before
it builds request N+1, and the request sends the history array itself, so
whatever the history holds at request time is exactly what the model sees.

## Implementation

*— claude-opus-5-5, 2026-10-26*

### Load-bearing assumption

**The `promptTokens` reported in `done` for request N is the full size of
request N's prompt, and it reaches the agent loop on every path before request
N+1 is built.** So `promptTokens(N)` plus an estimate of the messages added
since is the size of request N+1.

- OpenAI-compatible: `stream_options: { include_usage: true }`
  (`packages/providers/src/openai-provider.ts:202`). `prompt_tokens` becomes
  `promptTokens` (`:152-157`), carried on `done` (`:189`). Repro A: holds.
  When the server leaves out a field it becomes `0` (`?? 0`, `:154`). The
  design treats `promptTokens === 0` as "not reported".
- Anthropic: `promptTokens = message_start.message.usage.input_tokens`
  (`packages/providers/src/anthropic-provider.ts:122-127`, `:229-235`), and the
  wire type knows no cache fields (`:255`). Repro B: **does not hold when
  caching is active**, because `input_tokens` leaves out
  `cache_read_input_tokens` and `cache_creation_input_tokens`. Today tentacle
  sends no `cache_control` (grep `cache` in `packages/providers/src`: no hit),
  so it holds by accident. It breaks as soon as caching is on (automatic, a
  proxy, or a later change). **The plan fixes it**: `promptTokens` becomes the
  sum of the three (a one-site change, which also corrects the TUI meter).
- Agent loop: the `done` usage is yielded inside the round's stream loop
  (`packages/agent/src/agent.ts:519-523` (re-verified 34d60ab; was `:502-506`)).
  The next `ChatRequest` is built at the top of the next iteration (`:496-501`
  (re-verified 34d60ab; was `:479-484`)). Repro C: usage, then tool_result,
  then request 2. **Holds at `34d60ab`.**
- Pod proxy: `done.usage` crosses `model/stream` / `model/streamChunked` as
  `WireUsageSchema` (`packages/protocol/src/model.ts:40-50`, `:89`). This is
  pinned by `packages/client/test/remote.test.ts:237-253` ("usage travelled
  inside the `done` event"). The laptop's local provider produces it, so the
  Anthropic fix covers pods too.
- Not checked against a live server: llama.cpp / vLLM `prompt_tokens` should
  count cached prefix tokens (n_past). One live call after the change confirms
  it: send the same prompt twice and compare `prompt_tokens`.

### Preconditions

- The request's `messages` is the history array (Repro C; `agent.ts:496-497`
  (re-verified 34d60ab)).
  The single render point is therefore the request build, and it must make a
  **copy** (`messages.map(renderForModel)`), so the stored history keeps its
  clean `content`. There are two request sites: the loop (`:496-501`) and the
  final no-tools report (`:657-673`) (both re-verified 34d60ab). Both must
  render, so the cached prefix is byte-identical across requests.
- Data on `ChatMessage` beside `content` has two precedents: `spill`
  (`packages/core/src/model.ts:35-40`) and `durationMs` (`:41-46`, added by
  `fix/tool-duration`) (re-verified 34d60ab). **Both are display-only** (the
  model never sees them); `contextUsage` is the opposite — rendered into the
  model's `content` at request time — so it shares their persistence path but
  NOT their "never reaches the model" rule. It is carried by the wire
  `ChatMessageSchema` (`packages/protocol/src/session.ts:32-41`, a strip
  schema), by the laptop store's strict `MESSAGE_KEYS` / `messageProblem`
  (`packages/agent/src/session-store.ts:215`, `:246-284`), and by a daemon
  record version bump (`packages/daemon/src/persisted-session.ts:29-35`, now
  at 6) (all re-verified 34d60ab). Neither needed a `PROTOCOL_VERSION` bump
  (`packages/protocol/src/version.ts:7` = 11). A store/wire parity tripwire pins
  the key sets: `packages/cli/test/session-resume.test.ts:286` (re-verified 34d60ab).
- Persistence: the laptop persists `snapshot.messages` and the `serve` daemon
  persists `session.messages` (AGENTS §7). A field on the message is therefore
  persisted on both sides with no new code path.
- The `model/stream` wire message has no extra fields
  (`packages/protocol/src/model.ts:19-24`, which strips). That is why the line
  must be in `content` by the time the request leaves the loop. With the
  render-at-request design the pod proxy needs no change.
- The user prompt is pushed by `Session.send` **before** `runMessages`
  (`packages/agent/src/session.ts:92-96`). `Agent.run` pushes `userMessages`
  the same way (`agent.ts:366-368` (re-verified 34d60ab; was `:349-351`)).
  `Session.resume` pushes nothing (`:121-125`). `Session.send("")` pushes
  nothing either (`:92-94`, a continuation).
- The compaction summary is tracked **by identity**
  (`packages/daemon/src/hosted-session.ts:295`, `:1043-1046`) (re-verified 34d60ab).
  Replacing that object would make `awaitsAnswer` true for a compacted idle
  session, and a send-now could then start an unasked turn. So **only messages
  this turn added may be annotated** (design point 3).
- The no-await invariant (`agent.ts:593-604` (re-verified 34d60ab)) is untouched. The annotation is
  synchronous and runs before a request, never in the late-steer window.
- A sub-agent is its own `Agent` over its own fresh history
  (`packages/agent/src/subagent.ts:166-191`). Its `usage` events are not
  forwarded to the parent (`:192-200`).
- The pod agent is built from the **pod's** config
  (`packages/cli/src/serve.ts:419-427`), with the laptop's `autoTitle` passed in
  as a flag (`packages/cli/src/pod-runtime.ts:61-62`, `serve.ts:362-386`). The
  laptop TUI meter uses the **laptop's** `contextWindow` (`packages/cli/src/main.ts:509`,
  `:669`, `:724` (re-verified 34d60ab; was `:637`)). The `--stdio` daemon is
  started at `main.ts:378-384`.
- The config file schema is `.strict()` (`packages/config/src/schema.ts:4-6`).
  Profiles merge `subagents`/`tools` per key (`packages/config/src/profile.ts:61-67`).
  The generated template lives in `packages/config/src/defaults.ts:63-163`. There
  is no separate JSON-schema file for the config.

### Design

1. **Data, not text, in the history.** `ChatMessage` gains
   `contextUsage?: { readonly used: number; readonly window: number }`
   (core). `content` stays what it was: the user's text, the tool's result. That
   keeps every consumer that reads `content` clean by construction: TUI live and
   resume rows (`packages/tui/src/resume.ts`), session titles, `turn_start`
   hooks' `lastUserText` (`agent.ts:121-129`), compaction, steer matching.
   Pure module `packages/agent/src/context-awareness.ts` (React-free, unit-tested):
   - `contextLine(u)` → `[context: 82k / 128k tokens (64%)]`. Tokens below 1000
     are shown as is. From 1000 they are rounded to `k`; from 10^6 to `M` with
     one decimal. The percentage is `floor(used*100/window)`, not capped: a
     value over 100 is reported as it is.
   - `renderForModel(m)` → `m` unchanged without the field, otherwise
     `{ ...m, content: `${m.content}\n\n${contextLine(m.contextUsage)}` }`.
     Fields are copied, `contextUsage` is not (like `spill`). The render runs
     **whatever `enabled` says**, so a line the model once saw stays in its
     prompt: a stable cache prefix, identical across a resume.
   - `lastEmitted(history)` → the `contextUsage` of the latest message that
     carries one, or none. **This state is derived from the history, never
     stored apart.** A compaction or a later `context-reset` rebuilds the
     history without lines, so counting restarts on its own (decision 1).
   - `shouldEmit(current, last, step)` → no `last`, or
     `floor(pct(current)/step) > floor(pct(last)/step)`. Only increases emit.
     A jump of 40 → 47 is one line (at most one annotation per request).
     Heuristic jitter downwards emits nothing.
   - `estimate(history, tools, anchor, counter)` → when the anchor is valid:
     `anchor.promptTokens + counter.countMessages(rendered(history[anchor.len..]))`.
     Otherwise (no usage yet, provider reports none, after a reload or a
     compaction): `counter.countMessages(rendered(history)) +
     counter.countText(JSON.stringify(tools))`. The second term counts the tool
     definitions, which the provider counts too. `counter` is `TokenCounter`
     (`core/context.ts:10-14`), default `HeuristicTokenCounter`.
2. **Anchor = what the provider measured.** On a `done` with
   `promptTokens > 0` the loop records
   `{ promptTokens, len: request length, ref: history[len-1] }`. `ref` comes from
   the **history**, not the rendered copy. The anchor is held in a per-Agent
   `WeakMap<ChatMessage[], Anchor>` keyed by the history array, so it outlives
   the turn: the next turn's first request uses real numbers. It is valid iff
   `history[len-1] === ref`. A compaction (`session.ts:163-165` empties and
   refills the same array) or a reload breaks it, and the heuristic takes over
   until the next `done`. The assistant reply after the anchor is counted with
   the heuristic, not `completionTokens`. Completion includes reasoning tokens
   that are not sent back, so the heuristic is closer, and the empty-round
   `pop` (`agent.ts:620` (re-verified 34d60ab)) cannot invalidate the anchor.
3. **Which message carries the line.** Right before each loop request
   (`agent.ts:496` (re-verified 34d60ab)): if enabled, compute `current = { used: estimate(..),
   window }`. If `shouldEmit`, replace the **last eligible** message with
   `{ ...m, contextUsage: current }`. Then build `request.messages =
   history.map(renderForModel)`.
   **Eligible** means a `user` or `tool` message at index ≥ `newFrom`, where
   `newFrom` is the first index this turn added, passed by the caller as
   `RunOptions.newFrom`:
   - `Session.send` passes the index before its push.
   - `Agent.run` passes the index before `userMessages`.
   - `resume` and an absent value pass `messages.length` at entry.

   This is "the message that crosses the step" (decision 3): the newest
   message the model has not yet seen. It covers the user prompt, a steer, a
   loop note (`[background]`, hook, continue nudge) and a tool result (the
   round's last one). Never covered: a message the model already saw (that
   would change a cached prefix), the compaction summary (identity, see
   Preconditions), an assistant message, the system prompt. With no eligible
   message there is no line this request, and the next eligible one carries it.
   The final no-tools report (`agent.ts:657` (re-verified 34d60ab)) renders but
   never annotates (its nudge is not kept, `:694`).
   The replaced message is persisted at the next `history_commit` or at turn
   end like any other change. No new event, no new await.
4. **Anthropic usage fix.** `promptTokens = input_tokens +
   (cache_creation_input_tokens ?? 0) + (cache_read_input_tokens ?? 0)`, and the
   wire type gains those two fields (`anthropic-provider.ts:122-127`, `:255`).
   OpenAI's `prompt_tokens` already includes cached tokens.
5. **Config (decision 2).** Top-level `contextAwareness: { enabled?: boolean,
   stepPercent?: int 1..100 }`, `.strict()`. Defaults:
   `DEFAULT_CONTEXT_AWARENESS = true`, `DEFAULT_CONTEXT_STEP_PERCENT = 1`.
   File-only, like `autoTitle` (no env form). Resolved as
   `contextAwareness: { enabled, stepPercent }` + sources. Profiles merge per
   key, like `subagents`. Template comment, placed after `subagents`:
   ```
   // Context awareness: tell the model how full its context is — a short line
   // ("[context: 82k / 128k tokens (64%)]") appended to the message that crosses
   // each new step of "stepPercent" (default 1%), never to the system prompt.
   // Counted from the provider's reported usage, an estimate when it reports none;
   // the window is model.contextWindow.
   // "contextAwareness": { "enabled": true, "stepPercent": 1 },
   ```
   `AgentConfig.contextAwareness?: { window: number; stepPercent: number;
   counter?: TokenCounter }`. Absent means off (the field is never written, but
   stored lines are still rendered). `buildAgent` sets it when `enabled`, with
   `window = config.contextWindow`.
6. **Sub-agents: own window, own lines.** `SubagentDeps.contextAwareness`
   (same shape) goes to each child `Agent`. The child's history is a fresh
   local array (`subagent.ts:187-191`), so it gets its own anchor, its own
   lines and its own restart. Nothing reaches the parent except the report
   (unchanged). The window is the parent's `contextWindow`. A type's model
   override may have a different window: listed as debt.
7. **Pod.** The proxy needs no change: rendered `content` travels as text, and
   usage travels in `done`. `enabled` / `stepPercent` come from the pod's
   config (the context-reset decision-12 rule). The **window** is the
   laptop's `contextWindow`, passed as `serve --context-window <n>` like
   `--auto-title` (owner answer 1).
8. **TUI.** FULLY hidden (owner answer 2): it renders `content`, and the field
   is ignored by every TUI module. No TUI code, no ctrl+o note, no live-event
   field. The status-bar meter stays the user's view (it may differ slightly:
   it uses the last `promptTokens`, the model's line includes the not-yet-sent
   delta).

### Files

Dependency order:

1. `packages/core/src/model.ts`: `ContextUsage` type plus the
   `ChatMessage.contextUsage?` field (doc comment: the model sees it rendered,
   the display ignores it).
2. `packages/protocol/src/session.ts`: `ChatMessageSchema.contextUsage:
   z.object({ used: int ≥ 0, window: int > 0 }).optional()` (strip). Regenerate
   `packages/protocol/schema/protocol.json` with the repo's generator, which is
   checked by `protocol/test/json-schema.test.ts`. No `PROTOCOL_VERSION` bump
   (the spill precedent; Failure modes covers an old peer).
3. `packages/providers/src/anthropic-provider.ts`: the cache-token sum (design 4).
4. `packages/agent/src/context-awareness.ts` (new, pure) and its export from the
   index.
5. `packages/agent/src/agent.ts`: `AgentConfig.contextAwareness`,
   `RunOptions.newFrom`, the anchor `WeakMap`, annotate plus render at `:496`,
   render at `:657`, the anchor at `:519-523` (re-verified 34d60ab).
6. `packages/agent/src/session.ts`: `send` passes `newFrom`. `agent.ts` `run`
   does the same.
7. `packages/agent/src/subagent.ts`: `SubagentDeps.contextAwareness` → the child.
8. `packages/agent/src/session-store.ts`: `MESSAGE_KEYS += "contextUsage"`,
   with `isContextUsage` exactly matching the wire bounds.
9. `packages/daemon/src/persisted-session.ts`: `DAEMON_RECORD_VERSION = 7`,
   `READABLE_VERSIONS` += 7, plus a doc line: "7: a message may carry
   `contextUsage`; a v6 daemon refuses every v7 record instead of dropping a
   line at its next write" (re-verified 34d60ab: `fix/tool-duration` took 6,
   owner answer 3).
10. `packages/config/src/{schema,defaults,resolve,load,profile}.ts`: the key,
    the defaults, the template comment, resolve plus sources,
    `TentacleConfig.contextAwareness`, the per-key profile merge.
11. `packages/cli/src/wiring.ts`: pass `contextAwareness` to `Agent` and
    `createSubagentRunner`.
12. (Q1 = laptop window) `packages/cli/src/pod-runtime.ts` (`podDaemonCommand`
    adds `--context-window <n>`), `flags.ts`, `main.ts:378-384` (re-verified
    34d60ab; was `:351`), `serve.ts` (`startStdioDaemon` / `tunnelledAgent`
    override `contextWindow`).
13. `TODO.md` index line, and this doc → `docs/feat/context-awareness.md`
    (`git mv` of the eval doc, or a new doc linking it).

### Failure modes

| Case | Convergence |
|---|---|
| Provider reports no usage, or `promptTokens` 0 | Heuristic over the whole rendered history plus tool definitions. Lines still emitted, approximate. |
| Abort mid-stream (no `done`) | Anchor unchanged (still a valid prefix); the next request estimates from it. |
| Empty round popped (`agent.ts:603`) | The anchor covers only the request prefix, so it stays valid. |
| Compaction / later context-reset | The array is refilled, so `ref` mismatches and the heuristic takes over. No line is left in the history, so the first request after it emits and counting restarts (decision 1). |
| Daemon reload / `--resume` | No anchor (in-memory). The stored lines survive (field persisted), so `lastEmitted` is intact and nothing is emitted twice. Heuristic until the first `done`. |
| Heuristic overestimates, then real usage is lower | Only increases emit: a pause until real usage passes the last value. No false "drop". |
| `contextWindow` smaller than the real window | The percentage can exceed 100, reported as it is (honest). |
| Disabled mid-session | No new lines. Old ones are still rendered (cache prefix stable). |
| Crash between annotation and the next commit | The record lacks that one field. After reload the line is simply missing and the next crossing emits. Never wrong text. |
| Older peer strips `contextUsage` (open seed / snapshot) | The model's next prompt lacks those lines: one cache miss, and the lines restart from the next step. Converges; nothing parsed wrongly (strip). |
| Older laptop store reads a record with the field | Refused loudly (`unknown key "contextUsage"`, strict). Never half-loaded (the spill precedent). |
| v6 daemon finds a v7 record | Refused and left untouched (`persisted-session.ts:204-209` (re-verified 34d60ab)). |
| Compaction summary / an already-seen message | Never eligible (`newFrom`): identity preserved (`hosted-session.ts:1045`), cached prefix unchanged. |
| Several tool results in one round | Only the last carries the line (one per request). |
| No eligible message (a continuation with nothing injected) | No line this request; the next eligible message carries the current value. |
| `stepPercent` 0 / > 100 / non-integer | Schema error at load (strict). |
| Sub-agent near full | Its own lines. The parent is told nothing new until the report lands (and that is counted). |
| Hooks `model_request` | Get the rendered messages: what the model actually saw (document in the hooks doc). |

### Tests

Red before green (§9). Each test names the property it pins.

- `agent/test/context-awareness.test.ts` (pure): format (`950`, `82k`, `1.0M`,
  103 %); `shouldEmit` (first, same bucket, +1, +7 → one, decrease → none, step
  5); `lastEmitted` (none / the latest); `renderForModel` (copies the other
  fields, drops `contextUsage`, leaves a message without it unchanged).
- `agent/test/agent.test.ts` with a scripted fake provider (the pattern of the
  existing loop tests):
  - (a) the line goes on the last tool result of the round that crosses, and
    request N+1 has it in `content` while the history `content` is unchanged;
  - (b) the user prompt carries it at turn start;
  - (c) a 40 → 47 jump gives one line;
  - (d) no usage gives the heuristic count (tools included);
  - (e) usage gives `promptTokens + delta`; mutation: use `completionTokens`
    instead and see the expected value fail;
  - (f) after `Session.compact` the first request emits again;
  - (g) the compaction summary and already-sent messages are never replaced
    (identity `toBe`);
  - (h) disabled: no field written, a stored field still rendered;
  - (i) request K+1's prefix is byte-identical to request K's rendered messages
    (cache stability, the exact property);
  - (j) the final no-tools report renders the stored lines.
- `agent/test/subagent.test.ts`: the child annotates its own history; the
  parent history gains only the report.
- `providers/test/anthropic-provider.test.ts`: the cache fields are summed (red
  on main: Repro B).
- `agent/test/session-store.test.ts` + `cli/test/session-resume.test.ts`
  parity: round-trip with `contextUsage`, malformed cases rejected, the
  tripwire key set.
- `daemon/test/persistence.test.ts`: v7 written, v1–v6 still read, field
  survives reload; mutation: drop the key from `MESSAGE_KEYS` and see the
  reread fail (the spill/duration pattern, V6-3) (re-verified 34d60ab).
- `protocol` test: `contextUsage` kept on `ChatMessageSchema`, malformed
  invalid, unknown inner field stripped.
- `config/test`: defaults, file values, strict errors, profile per-key merge,
  the template contains `// "contextAwareness": { "enabled": true, "stepPercent": 1 }`.
- `client/test/remote.test.ts`, over the real stack: snapshot keeps
  `contextUsage`. With Q1: `cli/test/pod-runtime.test.ts` checks
  `--context-window` is passed and that the pod agent uses it.
- Gate: `bun run check` green vs the §6 baseline.

**Notes / debt:**
- The per-type sub-agent model window is unknown, so the parent's is used.
- The heuristic stays 4 chars/token. An exact tokenizer is ADR-006 work,
  pluggable via `counter`.
- llama.cpp `prompt_tokens` with a cached prefix is unverified live (see above).

### Questions for the owner

1. **Pod window: whose `contextWindow`?** It is a property of the model, and
   the model lives on the laptop. Today the pod agent would use the pod config's
   (default 128k) while your meter shows the laptop's.
   **Recommendation: the laptop's**, passed as `--context-window <n>` like
   `--auto-title`. `enabled` / `stepPercent` stay from the pod config (your
   decision-12 rule). It is not a secret, so argv is fine. Without this, a
   200k model would be told "/128k" in the pod.
2. **Show the line in the TUI?** By construction it is hidden (the status-bar
   meter already shows the fill). *(The ctrl+o note this question proposed was
   declined — answer 2 below — and removed from the Design (re-verified 34d60ab).)*

### Owner answers

*— recorded by the orchestrator (claude-opus-5-5), 2026-10-26*

The plan is APPROVED with these answers:

1. **Pod window:** the laptop's, passed as `--context-window <n>` (owner:
   "certamente, è la cosa corretta da fare").
2. **TUI:** FULLY hidden — no line in the normal view AND no ctrl+o note
   ("nascondiamola dalla tui, solo il modello deve saperlo, io già vedo la
   barra ctx"). Drop `contextNote` and the live-event wiring for display;
   files and tests shrink accordingly.
3. **Record version (orchestrator, from the tool-duration Q-D):**
   `fix/tool-duration` (merged `9511c0e`) took `DAEMON_RECORD_VERSION` 6, so
   this task takes **7** (a v6 daemon refuses a v7 record). The plan was
   written against `5e8b538`; main is now `34d60ab` — `agent.ts`, `ChatMessage`
   (`durationMs`), the TUI tool rows and the stores changed. Re-verify every
   file:line before editing.

## Execution

*— claude-opus-5-5, 2026-10-26*

### 0. Step 0 refresh, baseline, repro (before any edit)

- **Refresh.** Every Implementation `file:line` re-checked on `34d60ab`; the
  moved ones are corrected in place and marked "(re-verified 34d60ab)". Only
  line numbers moved (agent.ts by +17 for the `durationMs` work; the stores by
  +2; `main.ts`). No shape changed. **The load-bearing assumption holds**: the
  `done` usage is yielded inside the round (`agent.ts:519-523`), the next
  request is built at the top of the next iteration (`:496-501`) with
  `messages` = the history array, and the final report is a second site
  (`:657-673`, no tools). Also re-confirmed: no message is tracked by identity
  except the compaction summary (`hosted-session.ts:295`, `:1043-1046`; no
  `WeakMap`/`Set` of messages in daemon/agent/client/cli); `Session.send("")`
  pushes nothing. The ctrl+o note (Design 8, Q2) is removed per owner answer 2;
  record version 6 → 7 per answer 3.
- **Gate baseline** (`bun run check` on `34d60ab`, before any edit):
  typecheck clean, `biome check .` 479 files 0/0, **2789 pass / 2 skip /
  0 fail** (2791 tests, 216 files). Matches the brief.
- **Repro** (`.tentacle/tmp/context-awareness/repro.ts`; the plan's version
  imported from `.tentacle/worktrees/main-ro`, which this run must not touch,
  so it was rewritten to import `packages/*` directly and to print what the
  model receives; it overwrote the planner's copy in the same folder):

  ```ts
  // A: OpenAI-compatible usage. B: Anthropic usage with cached input (real prompt = 12000).
  // C: what the model receives on request 2 of a tool round (is there any context line?).
  import { Agent } from "../../../packages/agent/src/index.ts";
  import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent }
    from "../../../packages/core/src/index.ts";
  import { AnthropicProvider, OpenAIProvider } from "../../../packages/providers/src/index.ts";
  import { ToolRegistry } from "../../../packages/tools/src/index.ts";
  // sse(), last(), A and B: as in the Context repro.
  const requests: ChatRequest[] = [];
  let round = 0;
  const fake: ModelProvider = { id: "fake", async *stream(req) {
    requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    round++;
    if (round === 1) {
      yield { type: "tool_call", toolCall: { id: "c1", name: "nope", arguments: "{}" } };
      yield { type: "done", usage: { promptTokens: 1000, completionTokens: 20 } };
    } else {
      yield { type: "text", delta: "done" };
      yield { type: "done", usage: { promptTokens: 1100, completionTokens: 5 } };
    }
  } };
  const agent = new Agent({ model: fake, tools: new ToolRegistry(), env: {} as ExecutionEnvironment,
    systemPrompt: "sys", ...({ contextAwareness: { window: 2000, stepPercent: 1 } } as object) });
  const history = agent.startConversation();
  history.push({ role: "user", content: "go" });
  for await (const _ of agent.runMessages(history, "s1", undefined, undefined, { newFrom: 1 } as never)) {}
  for (const [i, r] of requests.entries())
    console.log(`C request ${i + 1}:`, JSON.stringify(r.messages.map((m) => m.content)));
  console.log("C history contents:", JSON.stringify(history.map((m) => m.content)));
  console.log("C history contextUsage:", JSON.stringify(history.map((m) => m.contextUsage ?? null)));
  ```

  Before (`34d60ab`, `bun run .tentacle/tmp/context-awareness/repro.ts`):

  ```
  A openai done: {"type":"done","usage":{"promptTokens":12000,"completionTokens":30}}
  B anthropic done (real prompt = 12000): {"type":"done","usage":{"promptTokens":40,"completionTokens":30}}
  C request 1: ["sys","go"]
  C request 2: ["sys","go","","unknown tool: nope"]
  C history contents: ["sys","go","","unknown tool: nope","done"]
  C history contextUsage: [null,null,null,null,null]
  ```

  Reproduces: the model is told nothing; Anthropic reports 40 for a 12000
  prompt.

  After (this branch):

  ```
  A openai done: {"type":"done","usage":{"promptTokens":12000,"completionTokens":30}}
  B anthropic done (real prompt = 12000): {"type":"done","usage":{"promptTokens":12000,"completionTokens":30}}
  C request 1: ["sys","go\n\n[context: 11 / 2k tokens (0%)]"]
  C request 2: ["sys","go\n\n[context: 11 / 2k tokens (0%)]","","unknown tool: nope\n\n[context: 1k / 2k tokens (50%)]"]
  C history contents: ["sys","go","","unknown tool: nope","done"]
  C history contextUsage: [null,{"used":11,"window":2000},null,{"used":1015,"window":2000},null]
  ```

  Request 2 repeats request 1's bytes as its prefix; the stored `content`
  stays clean; the tool line is `1000` (measured) + 15 (the assistant + tool
  messages, heuristic).

### 1. As built, in plan order

1. `core/src/model.ts` — `ChatMessage.contextUsage?: ContextUsage` and the
   `ContextUsage { used; window }` type. Its doc comment says the opposite of
   `spill`/`durationMs`: it is NOT display-only, it is rendered into the
   model's `content`.
2. `protocol/src/session.ts:41-47` — `contextUsage: z.object({ used:
   int ≥ 0, window: int > 0 }).optional()` (strip, so an unknown inner field is
   dropped). `schema/protocol.json` regenerated (`bun run schema:export`,
   +15 lines). No `PROTOCOL_VERSION` bump (stays 11): an additive optional
   field on a strip schema, no update kind added.
3. `providers/src/anthropic-provider.ts:122-133` — `promptTokens = input_tokens
   + (cache_creation_input_tokens ?? 0) + (cache_read_input_tokens ?? 0)`; the
   wire type gains the two fields (`:259-266`). Only when `input_tokens` is
   present (unchanged gate).
4. `agent/src/context-awareness.ts` (new, pure, exported from the index):
   `contextLine`, `renderForModel`, `lastEmitted`, `shouldEmit`,
   `estimateUsed`, `ContextAnchor`. `estimateUsed` takes the tool definitions
   as an argument (the plan's `estimate(history, tools, anchor, counter)`).
5. `agent/src/agent.ts`:
   - `RunOptions.newFrom` (`:104-110`), `AgentConfig.contextAwareness`
     (`:265-275`), per-Agent `anchors: WeakMap<ChatMessage[], ContextAnchor>`
     (`:316`), `DEFAULT_COUNTER` (a shared `HeuristicTokenCounter`).
   - `run` passes `newFrom` = the index before `userMessages` (`:402-404`).
   - `runMessages`: `let unseen = min(opts.newFrom ?? length, length)` (`:458`);
     before each loop request `noteContextUsage(messages, unseen, tools)`, then
     `request.messages = messages.map(renderForModel)`, then
     `unseen = sent = messages.length` (`:535-548`); on `done` with usage,
     `anchorContext(messages, sent, usage)` before the `usage` yield (`:568`);
     the final report renders (`:706`).
   - `noteContextUsage` (`:775-808`): synchronous; the target is the LAST
     `user`/`tool` message at index ≥ `unseen`; it is replaced by
     `{ ...message, contextUsage }` only if `shouldEmit`. `anchorContext`
     (`:811-817`) records only when `promptTokens > 0`.
6. `agent/src/session.ts:92-98` — `send` passes `newFrom` = the length before
   its push.
7. `agent/src/subagent.ts` — `SubagentDeps.contextAwareness` (typed as
   `AgentConfig["contextAwareness"]`) → each child `Agent`.
8. `agent/src/session-store.ts` — `"contextUsage"` in `MESSAGE_KEYS`;
   `isContextUsage` (exactly `used`/`window`, `isCount`, `window > 0`) →
   `has a malformed contextUsage`.
9. `daemon/src/persisted-session.ts:29-38` — v7 comment,
   `DAEMON_RECORD_VERSION = 7`, `READABLE_VERSIONS = [1..6, 7]`. The v3/v4
   gates stay pinned constants (`CHOSEN_TITLE_VERSION = 3`,
   `STEER_IDS_VERSION = 4`); only `:90/:119/:267` use the current constant.
10. `config`: `schema.ts` top-level `contextAwareness { enabled?, stepPercent?
    int 1..100 }.strict()`; `defaults.ts` `DEFAULT_CONTEXT_AWARENESS = true`,
    `DEFAULT_CONTEXT_STEP_PERCENT = 1`, the template comment after
    `subagents` (exact text of the plan), the profile-rules line, and the
    `contextWindow` comment now names the context line too; `resolve.ts`
    `ContextAwarenessConfig` + `contextAwareness` (file-only); `load.ts`
    `TentacleConfig.contextAwareness`; `profile.ts` per-key merge (+ header).
11. `cli/src/wiring.ts` — `contextAwareness = enabled ? { window:
    config.contextWindow, stepPercent } : undefined`, to the `Agent` and to
    `createSubagentRunner`.
12. Pod window (owner answer 1): `flags.ts` `serve` accepts
    `--context-window`, `parseContextWindowFlag` (positive whole number, else
    throws); `main.ts:378-386` passes it to `startStdioDaemon`; `serve.ts`
    `startStdioDaemon` → `tunnelledAgent({ contextWindow })` overrides
    `config.contextWindow` before `buildAgent`; `pod-runtime.ts`
    `podDaemonCommand` always adds `--context-window <laptop's contextWindow>`
    (before `--auto-title`).
13. Docs: `docs/feat/hooks-turn.md` (`model_request` messages are the rendered
    ones, the Failure-modes table asked for it); `TODO.md` entry → this doc,
    status line.

### 2. Tests — red first (on the assertion), then green

| Test (file) | Red evidence |
|---|---|
| `agent/test/context-awareness.test.ts` (new, pure: format incl. `950`, `82k`, `1.0M`, `999_600 → 1.0M`, 103 %; `shouldEmit` first/same/+1/jump/decrease/step 5/other window; `lastEmitted`; `renderForModel` copy + same object; `estimateUsed` heuristic + tools / anchor / rendered tail / stale + cut anchor) | against a stub module with the signatures: 12 of 13 fail on assertions (the "other window" case is false on the stub too — a pin, see M14) |
| `agent/test/context-awareness-loop.test.ts` (new, scripted provider; Session / `Agent.run` / sub-agent) | on `34d60ab`: 12 of 13 fail on assertions (`toBeDefined`, `toMatch`, `toEqual`); the identity test is green on old code by nature — validated by M1 |
| `providers/test/anthropic-provider.test.ts` "prompt caching" | `promptTokens` `Expected 12000, Received 40` |
| `protocol/test/context-usage.test.ts` (new) | 3 of 4 fail (field stripped; malformed values accepted); "no bump" is a pin |
| `cli/test/session-resume.test.ts` parity + round-trip | 3 fail (`unknown key "contextUsage"`); the malformed parity cases agree on both sides by construction |
| `daemon/test/persistence.test.ts` V7-1..3 (new) | `Expected 7, Received 6` (×3) |
| `config/test/context-awareness.test.ts` (new) | 6 of 6 fail |
| `cli/test/wiring.test.ts` "buildAgent context awareness" | enabled case: `Received: "go"` (no line); disabled is green on old code by nature |
| `cli/test/model-proxy.test.ts` pod window (tunnel, real `Connection`) | `Received: "hello\n\n[context: 2k / 128k tokens (1%)]"` (pod window, not 200k) — after the regex fix below |
| `cli/test/pod-runtime.test.ts` `--context-window 200000` | `Received "… --model-proxy"` |
| `cli/test/serve-limits.test.ts` `parseContextWindowFlag` | red only at import level (the function did not exist); no assertion-level red, no mutation (see §5) |
| `client/test/remote.test.ts` real-stack snapshot | **written after the code** (green at once); non-vacuity shown by M9 |

All green after the implementation (narrow files, then the gate below).

### 3. Mutations (AGENTS §9) — each red, each reverted

| # | Mutation | Red |
|---|---|---|
| M1 | annotate from index 0 instead of `unseen` (rewrite an already-sent message) | CACHE prefix test; identity test — **only after strengthening both with two consecutive empty rounds** (see §5) |
| M2 | anchor on `completionTokens` | "measured prompt plus only what came after"; "jump = ONE line"; CACHE (non-vacuity count) |
| M3 | `Session.send` drops `newFrom` | user-prompt line, heuristic count, jump, compaction-restart, final report |
| M4 | `Agent.run` passes a wrong `newFrom` | `Agent.run` line, sub-agent line |
| M5 | render only when enabled | "disabled: a stored one is still rendered" |
| M6 | final report not rendered | "final no-tools report renders the stored lines" |
| M7 | `subagent.ts` drops `contextAwareness` | sub-agent loop test; wiring enabled test |
| M7b | `wiring.ts` drops it from `createSubagentRunner` | wiring enabled test (child request has no line) |
| M8 | Anthropic: cache counts × 0 | provider caching test |
| M9 | drop `contextUsage` from `ChatMessageSchema` | protocol ×3; **real-stack snapshot** (`remote.test.ts`) |
| M10 | drop `"contextUsage"` from `MESSAGE_KEYS` | parity ×2, round-trip, V7-3 |
| M11 | `DAEMON_RECORD_VERSION = 6` | V7-1..3 and every "current = 7" expectation |
| M12 | `tunnelledAgent` ignores `contextWindow` | model-proxy laptop-window test |
| M13 | `podDaemonCommand` without `--context-window` | every pod command expectation + the 200000 test |
| M14 | `shouldEmit` with `>=` | pure "same step" and "step 5" |
| M15 | `estimateUsed` ignores the `ref` check | pure "stale / cut anchor" |
| M16 | profile replaces `contextAwareness` | config "profile merges per key" |

Revert proof: `shasum -c` of the 12 mutated sources against the hashes taken
before M1 → all `OK` (`agent.ts 3e32753a…`, `session.ts 98a5ea78…`,
`subagent.ts b4b9fc10…`, `context-awareness.ts 8e85ff23…`,
`session-store.ts 40e5cce6…`, `anthropic-provider.ts a75ccd84…`,
`protocol/src/session.ts ec7bd627…`, `persisted-session.ts 3f5efb90…`,
`serve.ts 00caa62a…`, `pod-runtime.ts 54496c2d…`, `wiring.ts 9de0a313…`,
`profile.ts 1fbde12a…`); `git status --short | shasum` = `4e49657a…` before
and after.

### 4. Gate

`bun run check` on the final tree (after every revert): typecheck clean (incl.
`apps/mobile`), `biome check .` 484 files, 0 errors / 0 warnings (the clean
baseline; +5 new files), **2849 pass / 2 skip / 0 fail** (2851 tests, 220
files; +60 vs the 2789 baseline). The 2 skips are the same opt-in live-k8s and
slow-keepalive tests.

### 5. Drift from the Implementation, and decisions taken

- **"Eligible" is tighter than `index ≥ newFrom`.** The plan's rule ("never a
  message the model already saw") is implemented as a cursor `unseen` that
  starts at `newFrom` and moves to the request length after EVERY request.
  With `newFrom` alone, a second consecutive empty round (the nudge is
  already sent and stays last; nothing new is pushed) or any request that
  added no user/tool message would rewrite an already-sent message and break
  the cached prefix. M1 proved the first version of the tests did not catch
  this; both the CACHE and identity tests now script two consecutive empty
  rounds (red under M1).
- **Snapshot cut nuance (for Review).** `hosted-session.ts:31-38` says the
  history is append-only past a cut. The annotation REPLACES a message that
  can be behind the latest cut (a tool result committed by `history_commit`,
  then annotated before the next request). Only `contextUsage` differs —
  `content` and every displayed field are identical — so a replay is never
  doubled or lost, and the TUI ignores the field. A snapshot taken in that
  window lacks the field; the laptop's turn-end snapshot and the daemon's next
  commit/turn-end write carry it. A crash in that window loses one line (the
  plan's "Crash between annotation and the next commit" row).
- **Config `sources`**: `contextAwareness` is file-only like `autoTitle`, and
  like `autoTitle` it has no `sources` entry (the plan said "+ sources"; no
  reader of `sources` would show it).
- **`podDaemonCommand` always passes `--context-window`** (not only when it
  differs): the laptop's value is always the truth (answer 1), and the pod's
  config must never decide it. ~10 existing pod-command expectations gained
  `--context-window 128000`; `baseConfig` in `pod-runtime.test.ts` gained
  `contextWindow: 128000`.
- **`serve --context-window` is accepted without `--model-proxy`** too (it
  then overrides the local daemon's window; harmless, never sent by us). It
  is parsed only on the `--stdio` path; `serve` over WebSocket ignores it.
- **Existing tests whose assertion changed by design**: `wiring.test.ts`
  "skill body verbatim", `args.test.ts` "one-shot prompt verbatim",
  `profile-flag.test.ts` "prompt is exactly the prompt" — the model's last
  message now ends with the line, so each strips exactly a trailing
  `\n\n[context: …]` and keeps its strict equality on the rest.
- **Record-version expectations** (mechanical, the tool-duration pattern):
  "current" 6 → 7 and "newer refused" 7 → 8 in `persistence.test.ts` (U2,
  P-R1, V5-1..3, V6-1..3, fixtures `:1097/:1166/:1286`),
  `session-titles.test.ts` D6, `serve-persistence.test.ts` (`:134`, `:200`,
  A11), `session-list.test.ts:397`. The old V6-1 ("written as v6; v7 refused")
  became "a v6 record still reads as v7"; its write/refuse half moved to V7-1.
  `persistence.test.ts`'s `rig` gained an optional `agentConfig` argument.
- **Repro fixes in my own tests** (not code drift): the "jump" test first
  expected exact 40/47 % and forgot the estimated delta after the anchor — now
  it asserts the exact `promptTokens + delta` values; the pod regex first
  assumed `\d+` tokens (`2k` is a valid render).
- **Not done (as the owner decided):** no TUI change, no `contextNote`, no
  live-event field. No `PROTOCOL_VERSION` bump.
- `parseContextWindowFlag` has no mutation of its own (a 15-line copy of the
  `count()` rule in `parseServeLimits`); its accept/reject table is tested.

### 6. Open items for the owner / Review

- **Live check not run**: llama.cpp / vLLM `prompt_tokens` with a cached
  prefix (send the same prompt twice, compare); the real Anthropic API with
  prompt caching on. Covered only by the scripted SSE tests.
- **Unverified end to end**: a real `tentacle -i` turn → quit → `--resume`
  keeps the lines through `JsonSessionStore` (covered piecewise: store
  round-trip, snapshot carries it, V7-3 daemon restart).
- **Sub-agent window**: a type with its own `model` uses the parent's
  `contextWindow` (plan debt, unchanged).
- **Snapshot cut nuance** above: Review should red-team whether any consumer
  compares message objects or fields behind a cut (none found by grep).

### Fix 1 (Review F1, owner)

*— claude-opus-5-5, 2026-10-26*

The owner chose to fix Review finding 1 before the merge: a sub-agent type
with its own `model` counted against the PARENT's window.

- **Where a type's `model` is declared:** only in the agent-definition
  frontmatter (`agent/src/agent-defs.ts` `parseAgentDefinition`, used for
  `<configDir>/agents/*.md` and packages' `agents/`). The config file has no
  per-type setting (`subagents` holds only `enabled` / `maxIterations`), so
  the field lives in the frontmatter only.
- **Change:**
  - `agent/src/subagent.ts` — `AgentType.contextWindow?: number` next to
    `model`. The child's `contextAwareness` is
    `{ ...deps.contextAwareness, window: type.contextWindow }` when the type
    sets one, else `deps.contextAwareness` (the parent's window, as before).
    `enabled` / `stepPercent` stay the parent's.
  - `agent/src/agent-defs.ts` — `contextWindow:` is parsed next to `model`.
    The rule is the same permissive one as `model`: a positive whole number
    (`/^[0-9]{1,9}$/`, `> 0`) is kept, anything else (`0`, `-1`, `1.5`,
    `32k`, empty, a list) is ignored. No error, as a bad `model` gives none.
    The header comment documents it.
  - `docs/extensions.md` (agent-type format, where `model` is documented):
    the field, its unit, its default.
- **Red → green:**
  - `agent/test/context-awareness-loop.test.ts`, the new case "a sub-agent
    type with its own model + contextWindow counts against that window": a
    `small` type (`model` + `contextWindow: 32000`) under a 200000 parent. On
    the pre-fix code it was red on the assertion
    (`Received: "go\n\n[context: 11 / 200k tokens (0%)]"`, expected
    `/ 32k`). It is green now. The `big` type in the same test (a `model` but
    no window) pins the default `/ 200k`. That half passes on both versions:
    it is a pin, not a red.
  - `agent/test/agent-defs.test.ts` "contextWindow: a positive whole number is
    kept…": red before (`contextWindow` absent), green now.
- **Mutation:** in `subagent.ts`, ignore `type.contextWindow` (the condition
  becomes `=== -1`). The new loop test goes red with `/ 200k`. Reverted, and
  `shasum packages/agent/src/subagent.ts` gives `39852717…` before and after.
- **Gate:** `bun run check`. Typecheck is clean and `biome check .` gives 484
  files, 0/0. Tests: **2851 pass / 2 skip / 0 fail** (2853 tests, 220 files;
  +2 vs the Execution gate). The 2 skips are the same opt-in tests.
- The open item "Sub-agent window" above is closed by this fix.

## Review

*— claude-opus-5-5 (fresh context; **same model as the executor** — shared blind
spots survive both passes; a different model family would be the stronger
check for a load-bearing task), 2026-10-26*

### Verdict: **APPROVE-WITH-NITS** — merge-ready; no finding blocks.

### Gate (re-run by the reviewer, uncommitted tree)

`bun run check`: typecheck clean (incl. `apps/mobile`); `biome check .` 484
files, 0 errors / 0 warnings; **2849 pass / 2 skip / 0 fail** (2851 tests, 220
files). Matches Execution §4; the 2 skips are the opt-in live-k8s and
slow-keepalive tests.

### Findings

1. **Sub-agent with its own `model` counts against the parent's window**
   (`packages/cli/src/wiring.ts:265-267` → `packages/agent/src/subagent.ts:167`,
   `:176`). *Severity: low, acceptable as debt.* `modelFor(type.model)` reaches
   a different model on the same endpoint; the child's line uses
   `config.contextWindow`, so a 32k child under a 200k parent is told "/200k"
   and under-reports its fill (or the reverse). Not a cache or persistence
   issue — only the denominator. Fix (a follow-up, contained/S): an optional
   `contextWindow` per sub-agent type (agent def frontmatter / `subagents`
   config), default the parent's, passed in `createSubagentRunner` per child.
   **Owner decision:** accept as debt now + a `TODO.md` item (recommended), or
   fix before merge.
2. **Overestimate stickiness after a reload/compaction** (`context-awareness.ts`
   `shouldEmit`, by design "only increases emit"). *Severity: nit.* With no
   anchor the heuristic (4 chars/token over the whole history + tool JSON) can
   overshoot; real usage then emits nothing until it passes the overshoot, so
   the model's last-seen figure stays too high for a while. Documented in the
   Failure-modes table; bounded by the first `done`. No change asked.
3. **A late steer drained at turn end is never a carrier in a following
   `send("")` continuation** (`session.ts:93`: `newFrom` is taken after it).
   *Severity: nit.* No wrong data — the line just waits for the next
   tool/user message. No change asked.
4. **`used` excludes the line's own tokens** (~12–15 per line, `agent.ts:790-806`
   estimates before the line is appended). *Nit*, negligible against 1 %.
5. **Unverified live** (Execution §6, confirmed still open): real Anthropic
   prompt caching and llama.cpp/vLLM `prompt_tokens` with a cached prefix.
   Scripted SSE only. Verify: the same prompt twice, compare `promptTokens`.

### Premise table

| Premise | Result |
|---|---|
| Context symptom (model told nothing; Anthropic 40 vs 12000) | TRUE — Execution's before/after repro consistent with the diff; the provider test is red under M8 |
| `done` usage yielded inside the round, next request built at the loop top, `messages` = history (`agent.ts:535-568`) | TRUE |
| Only one in-place history write in `src/` (`agent.ts:806`) besides `Session.compact`'s `length = 0` (`session.ts:167`) | TRUE (rg over `packages/*/src` for index assignment / `splice` / `length =`) |
| Summary tracked by identity (`hosted-session.ts:295`, `awaitsAnswer` `:1043-1046`) | TRUE — and never eligible (index < `newFrom`) |
| Daemon reaches the loop only via `Session.send` / `Session.resume` (`hosted-session.ts:449`, `:957`, `:1137`) | TRUE — so `newFrom` is always passed on a fresh turn |
| v6 refuses a v7 record (`persisted-session.ts:207-210`) | TRUE; `READABLE_VERSIONS` now `[1..6, 7]` |
| `ProxyModelProvider` unchanged | TRUE (`daemon/src/proxy-model.ts` not in the diff) |
| No TUI file touched; `contextUsage` absent from `packages/tui` | TRUE (rg: 0 hits in `packages/tui`) |
| Mutated sources hash = Execution §3's hashes (`agent.ts 3e32753a…`, `context-awareness.ts 8e85ff23…`, `anthropic-provider.ts a75ccd84…`, `session-store.ts 40e5cce6…`, `pod-runtime.ts 54496c2d…`) | TRUE |

### Attacks tried

1. **Cache prefix, end to end** (`.tentacle/tmp/context-awareness-review/cache-trace.ts`,
   real `Session` + `Agent`, window 1000, step 1): two turns, a tool round, two
   consecutive empty rounds (nudge), a steer enqueued mid-stream, a turn with
   NO usage (heuristic), then `Session.compact`. Result: **every one of 9
   requests is a byte-identical (JSON) prefix of the next**; the second empty
   round adds no line (the `unseen` cursor); stored `content` clean
   (`stored dirty content: false`); lines at indices 1,3,4,7,9,11,13,15; after
   compaction the first request emits again (`[context: 37 / 1k tokens (3%)]`).
   Found nothing.
2. **Other re-render paths.** Resume of a suspended turn: `unseen` = length at
   entry, the assistant message was sent and committed — untouched. Hooks
   `model_request`: send only the delta past the last count
   (`hooks-turn.md` R2), and only unseen messages can change — no old message
   re-sent differently. `turn_start` / `turn_end` notes, background notes,
   `/name` skill round: all pushed at index ≥ `unseen`. Sub-agents: a fresh
   `Agent` + array per run (own `WeakMap`). Final report renders (M6 red).
   Found nothing.
3. **Snapshot cut nuance.** The replaced object can sit behind a cut; only
   `contextUsage` differs, the TUI never reads it, the laptop persists from a
   fresh paged snapshot at turn end, and nothing compares messages by identity
   except the summary (never a carrier). Harmless — agreed with Execution §5.
4. **Pod trust.** The pod can put any bounded int pair in `contextUsage` of a
   snapshot (strip schema, `int ≥ 0` / `int > 0`); the laptop only stores it.
   That is no new capability: the pod already writes `content`. `--context-window`
   flows laptop → pod only, not a secret, and cannot affect the laptop.
   Found nothing.
5. **TUI frame** (`.tentacle/tmp/context-awareness-review/tui-frame.ts`): a
   resumed row carrying `contextUsage {82000/128000}` + a live turn whose agent
   annotates. Normal view and after ctrl+o: `[context:` **absent** in both
   (`normal has [context: false | ctrl+o has [context: false`), while the
   model's request ends with `live prompt\n\n[context: 8 / 128k tokens (0%)]`.
   Only the existing `ctx` meter shows the fill.
6. **Unrelated files.** `TODO.md` (status line of this item) and
   `docs/feat/hooks-turn.md` (+3 lines: `model_request` messages are the
   rendered ones — asked for by this plan's Failure-modes row). Both justified.
   `main` is still `34d60ab` (no commits since the branch point) — no conflict
   risk today.

### Mutation non-vacuity (re-run by the reviewer, a sample of 6 of 17)

| Mutation | Red |
|---|---|
| M1 `noteContextUsage` scans from 0, not `unseen` | CACHE prefix + identity (2 fail) |
| M2 anchor on `completionTokens` | measured-prompt, jump, CACHE (3 fail) |
| M6 final report not rendered | "final no-tools report renders the stored lines" |
| M8 Anthropic cache-read term × 0 | "promptTokens = input + cache creation + cache read" |
| M10 `contextUsage` out of `MESSAGE_KEYS` | parity ×2, round-trip, V7-3 |
| M13 `podDaemonCommand` without `--context-window` | the 200000 test + 9 pod-command expectations |

Revert: `shasum -c` of the 5 mutated sources → all `OK`; `git status --short |
shasum` = `ff0dab87…`, `git diff | shasum` = `5c82f880…`, untracked-files hash
`9a850c52…` — identical before and after the review. Nothing committed.

### What holds

The design keeps the load-bearing property exactly: data on the message,
render on the request copy, carrier only past the `unseen` cursor. The
record bump (v7), the strict laptop parser and the wire schema agree (M10,
parity tripwire). The Anthropic fix also corrects the TUI meter. The pod keeps
the model on the laptop. No `PROTOCOL_VERSION` bump is needed (optional field,
strip schema, no new update kind).

### How the executor behaved

Disciplined. Re-verified every `file:line` against `34d60ab` before editing.
Found and fixed a real hole in its own first version (`newFrom` alone rewrote
an already-sent message on a second empty round). It proved this by M1 and
tightened the tests. Drift is reported honestly (the cursor, no `sources`
entry, `--context-window` always passed, the tests written after the code). It
named the open live checks and the sub-agent debt instead of hiding them. The
mutation table is accurate on the sample re-run.
